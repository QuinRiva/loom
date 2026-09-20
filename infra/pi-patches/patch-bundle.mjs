#!/usr/bin/env node
/**
 * Apply the local pi patches to pi's PRE-BUNDLED entry point.
 *
 * Since pi 0.84 the published `bin.pi` is `dist/bundle/cli.js` — an esbuild
 * bundle of the whole CLI into `dist/bundle/chunks/chunk-<hash>.js`. The
 * readable `dist/` tree still ships (it is the package's `exports` entry) and
 * the `0001`/`0002` diffs still apply to it, but patching it alone leaves the
 * binary Loom actually runs unpatched. Hence this script: the same two changes,
 * expressed as anchored replacements against the minified chunk.
 *
 * It is deliberately strict — every anchor must match the expected number of
 * times or nothing is written — so a pi bump whose bundle drifted fails loudly
 * instead of silently shipping an unpatched auth/session path.
 *
 * Usage: node infra/pi-patches/patch-bundle.mjs <pi-package-root> [--check]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const MARKER = "__loomWriteAuthAtomic";

/**
 * Prepended to the chunk: the fs helpers the minified call sites below need.
 * Names are `__loom`-prefixed so they cannot collide with esbuild's mangled
 * bindings. The one upstream binding this relies on is `resolvePath` — pi's own
 * path resolver (tilde, file URLs, Windows shell paths), which the readable
 * 0001 patch also calls, so the two forms accept exactly the same `--cwd`
 * values; its presence is asserted below. The usage errors are plain text
 * rather than pi's chalk-red, because chalk's binding here IS mangled; the RPC
 * contract test matches them by substring.
 */
const HEADER = `
// LOOM PATCH — see infra/pi-patches/README.md (0001 --cwd resume, 0002 atomic auth write).
import { chmodSync as __loomChmodSync, existsSync as __loomExistsSync, renameSync as __loomRenameSync, statSync as __loomStatSync, unlinkSync as __loomUnlinkSync, writeFileSync as __loomWriteFileSync } from "node:fs";
function __loomWriteAuthAtomic(authPath, next, options) {
  const tmp = \`\${authPath}.tmp-\${process.pid}-\${Date.now()}\`;
  try {
    __loomWriteFileSync(tmp, next, options);
    __loomChmodSync(tmp, __loomExistsSync(authPath) ? __loomStatSync(authPath).mode & 0o777 : 0o600);
    __loomRenameSync(tmp, authPath);
  } catch (error) {
    try {
      if (__loomExistsSync(tmp)) __loomUnlinkSync(tmp);
    } catch {
      // Best-effort cleanup; the original file is still intact.
    }
    throw error;
  }
}
function __loomResolveCwdOverrideOrExit(parsed, cwd) {
  if (parsed.cwdOverride === undefined) return undefined;
  const conflicting = [
    parsed.sessionId !== undefined ? "--session-id" : undefined,
    parsed.fork ? "--fork" : undefined,
    parsed.continue ? "--continue" : undefined,
    parsed.resume ? "--resume" : undefined,
    parsed.noSession ? "--no-session" : undefined,
  ].filter((flag) => flag !== undefined);
  if (conflicting.length > 0) {
    console.error(\`Error: --cwd cannot be combined with \${conflicting.join(", ")}\`);
    process.exit(1);
  }
  if (!parsed.session) {
    console.error("Error: --cwd requires --session <path> (it overrides the working directory of an existing session)");
    process.exit(1);
  }
  const resolved = resolvePath(parsed.cwdOverride, cwd);
  if (!__loomExistsSync(resolved) || !__loomStatSync(resolved).isDirectory()) {
    console.error(\`Error: --cwd directory does not exist: \${resolved}\`);
    process.exit(1);
  }
  return resolved;
}
`;

/**
 * [description, matcher, replacement, expected match count].
 *
 * The first entry replaces pi's `resolvePath` declaration with itself: it
 * changes nothing, and exists so the strict count check below fails the bump if
 * upstream ever renames the resolver the header calls.
 */
const EDITS = [
  [
    "0001 pi's own resolvePath (called by the header) is still named that",
    /function resolvePath\(/g,
    "function resolvePath(",
    1,
  ],
  [
    "0002 atomic auth.json write (withLock + withLockAsync)",
    /[A-Za-z_$][\w$]*\(this\.authPath,next,AUTH_FILE_WRITE_OPTIONS\)/g,
    "__loomWriteAuthAtomic(this.authPath,next,AUTH_FILE_WRITE_OPTIONS)",
    2,
  ],
  [
    "0001 --cwd argument parsing",
    /result\.sessionDir=args\[\+\+i\];else if\(/g,
    'result.sessionDir=args[++i];else if(arg==="--cwd"&&i+1<args.length)result.cwdOverride=args[++i];else if(',
    1,
  ],
  [
    "0001 --cwd help text",
    /( {2}--session-dir <dir> +Directory for session storage and lookup\n)/g,
    "$1  --cwd <dir>                    Working directory for a --session resume, instead of the\n                                 session's recorded cwd (use when that directory is gone)\n",
    1,
  ],
  [
    "0001 openSessionOrExit cwd override",
    /function openSessionOrExit\((\w+),sessionDir\)\{try\{return SessionManager\.open\(\1,sessionDir\)\}/g,
    "function openSessionOrExit($1,sessionDir,cwdOverride){try{return SessionManager.open($1,sessionDir,cwdOverride)}",
    1,
  ],
  [
    "0001 createSessionManager cwd override parameter",
    /async function createSessionManager\(parsed,cwd,sessionDir,settingsManager\)\{/g,
    "async function createSessionManager(parsed,cwd,sessionDir,settingsManager,cwdOverride){",
    1,
  ],
  [
    "0001 --session resume opens in the override cwd",
    /(if\(parsed\.session\)\{let resolved=await resolveSessionPath\(parsed\.session,cwd,sessionDir\);)switch\(/g,
    '$1if(cwdOverride!==void 0&&resolved.type!=="not_found")return openSessionOrExit(resolved.path,sessionDir,cwdOverride);switch(',
    1,
  ],
  [
    "0001 --cwd validation in main()",
    /validateForkFlags\(parsed\),validateSessionIdFlags\(parsed\);/g,
    "validateForkFlags(parsed),validateSessionIdFlags(parsed);let __loomCwdOverride=__loomResolveCwdOverrideOrExit(parsed,cwd);",
    1,
  ],
  [
    "0001 --cwd threaded into createSessionManager",
    /createSessionManager\(parsed,cwd,sessionDir,startupSettingsManager\)/g,
    "createSessionManager(parsed,cwd,sessionDir,startupSettingsManager,__loomCwdOverride)",
    1,
  ],
];

const root = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (!root) {
  console.error("usage: patch-bundle.mjs <pi-package-root> [--check]");
  process.exit(2);
}

const chunkDir = NodePath.join(root, "dist", "bundle", "chunks");
const chunks = NodeFS.readdirSync(chunkDir)
  .filter((name) => name.endsWith(".js"))
  .map((name) => NodePath.join(chunkDir, name))
  .filter((path) => NodeFS.readFileSync(path, "utf8").includes("AUTH_FILE_WRITE_OPTIONS"));
if (chunks.length !== 1) {
  console.error(`expected exactly one bundle chunk containing the CLI, found ${chunks.length}`);
  process.exit(1);
}

const [chunkPath] = chunks;
const original = NodeFS.readFileSync(chunkPath, "utf8");
if (original.includes(MARKER)) {
  console.log(`${chunkPath}: already patched`);
  process.exit(0);
}
if (checkOnly) {
  console.error(`${chunkPath}: NOT patched`);
  process.exit(1);
}

let patched = original;
for (const [description, matcher, replacement, expected] of EDITS) {
  const count = patched.match(matcher)?.length ?? 0;
  if (count !== expected) {
    console.error(
      `${description}: expected ${expected} match(es), found ${count} — pi's bundle drifted, re-derive.`,
    );
    process.exit(1);
  }
  patched = patched.replace(matcher, replacement);
}

const lines = patched.split("\n");
NodeFS.writeFileSync(chunkPath, [lines[0], HEADER, ...lines.slice(1)].join("\n"));
NodeChildProcess.execFileSync(process.execPath, ["--check", chunkPath]);
console.log(`${chunkPath}: patched (${EDITS.length} edits)`);
