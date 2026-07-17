// @effect-diagnostics nodeBuiltinImport:off
// LOOM-ONLY. Generates the pi search-guard extension: a `tool_call`/`tool_result`
// hook that fail-fasts the number-one sub-thread failure mode — a long,
// unbounded filesystem search launched because a file is not where the agent
// assumed (wrong cwd, wrong repo, or a brief path it did not verify). The bash
// tool has no default timeout, so such a search blocks the turn for many
// minutes with zero agent-visible feedback and no lever can penetrate it
// (steers queue between model rounds; the control-plane notice is FYI-only).
//
// Two layers, both heuristic and deliberately permissive on doubt:
//  1. BLOCK unbounded recursive searches rooted outside the session worktree
//     (and any search over a known-vast root: `/`, `$HOME`, a strict ancestor
//     of the worktree — the workspace/cockpit roots — or a depth-1 dir), with
//     a teaching message carrying the escalation ladder: verify brief paths →
//     focused bounded search → `consult_thread` as the expensive last resort.
//  2. AUTO-BOUND pure read-only search pipelines to
//     SEARCH_GUARD_TIMEOUT_SECONDS when the model passed no timeout, so a
//     stuck search returns partial output + a timeout error the model can
//     react to quickly instead of hanging the turn. On such a timeout, a
//     `tool_result` hook appends the same ladder as a hint.
//
// Escape hatches (BOTH layers honour them — an explicitly bounded command is
// never blocked and never re-bounded):
//  - an explicit `timeout` parameter on the bash tool call;
//  - a `timeout N` command prefix on the walker;
//  - a depth bound on the walker (`-maxdepth`, `--max-depth`, fd's `-d`).
//
// Every handler body is wrapped in try/catch → allow: a thrown `tool_call`
// extension handler blocks ALL tool execution in pi, so an analyser bug must
// degrade to "no guard", never to a bricked session. The command analysis is
// quote-blind by design: a mis-parse only ever degrades to a teaching block
// or a no-op, never corrupts execution.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const EXTENSION_FILE = "t3-search-guard-extension.mjs";

/**
 * Auto-injected bound (seconds) for unbounded pure-search bash pipelines.
 * Measured on the heaviest legitimate case — this repo's worktree, 238k files
 * incl. a 3.2 GB node_modules: `find .` (filename) ≈ 0.3s, `rg` (content)
 * ≈ 0.01s, so 30s is ~100× above every legitimate search shape while sitting
 * 10× under the control plane's first slow-tool notice (5 min). The one thing
 * it clips — a raw `grep -rn` from the worktree root grinding through
 * node_modules content (>60s) — is itself an anti-pattern the timeout hint
 * redirects to `rg`/a named subtree; a genuinely long search can rerun with an
 * explicit larger timeout.
 */
export const SEARCH_GUARD_TIMEOUT_SECONDS = 30;

/**
 * The teaching escalation ladder, shared by the block reason and the timeout
 * hint. 99% of "file not found" cases mean a wrong location assumption, not a
 * file that a wider search will find.
 */
const LADDER_BASE =
  "When a file is not where you expected, searching wider almost never finds it — " +
  "you are usually in the wrong directory, repo, or worktree. Escalate in order: " +
  "(1) verify the exact paths your brief gave you (`pwd`, `git rev-parse --show-toplevel`, `ls <path>`) — brief paths are authoritative; " +
  "(2) run a focused, bounded search: a named subtree, `find <dir> -maxdepth 3 -name <name>`, or `rg --files -g <name>` inside your worktree";

/**
 * The workstream-only rung: `consult_thread` is injected by the provider-tool
 * extension and exists only in sessions with a workstream MCP session. The
 * emitted guard selects at runtime on `T3_WORKSTREAM_ENDPOINT` (set by the
 * driver alongside that extension) so a plain loom pi session is never told
 * to call a tool it does not have.
 */
const LADDER_CONSULT =
  "; (3) only as a last resort, ask the thread that holds the context via `consult_thread` — it is expensive, so exhaust the cheap checks first";

const LADDER_TAIL =
  ". If you genuinely need a long search, bound it explicitly (`-maxdepth`, `--max-depth`, or a `timeout` prefix / explicit timeout parameter).";

/**
 * Emit the extension source. The guard's constants (timeout, ladder copy) are
 * interpolated; the analysis logic is the substance of the emitted module and
 * is exercised by loading the built `.mjs` and driving its handlers (see
 * searchGuardExtension.test.ts), same pattern as the provider-tool extension.
 */
export const buildSearchGuardExtensionSource = (): string => `import path from "node:path";
import os from "node:os";

const TIMEOUT_SECONDS = ${SEARCH_GUARD_TIMEOUT_SECONDS};
const LADDER =
  ${JSON.stringify(LADDER_BASE)} +
  (process.env.T3_WORKSTREAM_ENDPOINT ? ${JSON.stringify(LADDER_CONSULT)} : "") +
  ${JSON.stringify(LADDER_TAIL)};

// Recursive searchers the guard reasons about. rg/fd are gitignore-aware (a
// foreign worktree walk is usually fine); find/grep walk everything.
const WALKERS = new Set(["find", "grep", "rg", "fd"]);
// Heads considered harmless to kill mid-run — a pipeline is only auto-bounded
// when EVERY segment head is in this set (never a build, install, or write).
const SAFE_HEADS = new Set([
  "cd", "find", "grep", "rg", "fd", "ls", "head", "tail", "wc",
  "sort", "uniq", "cat", "echo", "tr", "cut", "pwd", "test", "[",
]);
// Wrapper commands whose flags/values precede the real command.
const WRAPPERS = new Set(["sudo", "nice", "command", "env", "nohup", "stdbuf", "ionice"]);
// find actions with side effects (execution or file writes): a pipeline
// containing one is never auto-bounded — a mid-run kill could leave partial
// artefacts or interrupt the exec'd command.
const FIND_SIDE_EFFECTS = new Set([
  "-exec", "-execdir", "-ok", "-okdir", "-delete",
  "-fprint", "-fprint0", "-fprintf", "-fls",
]);

const isWithin = (root, p) => {
  const rel = path.relative(root, p);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

// Known-vast roots: filesystem root, the home dir, any depth-1 directory
// (/home, /usr, /tmp, ...), and any STRICT ANCESTOR of the worktree — which
// generically covers the workspace and cockpit roots that contain every
// sibling worktree's node_modules.
const isVastRoot = (worktree, p) => {
  if (p === "/" || p === os.homedir()) return true;
  if (p !== worktree && isWithin(p, worktree)) return true;
  return p.split(path.sep).filter(Boolean).length <= 1;
};

// Split a command line into pipeline/sequence segments. Also splits at command
// substitution (\`$(\`, \`<(\`, backtick) so \`files=$(find / ...)\` exposes the
// inner walker. Quote-blind by design: a quoted separator mis-splits, but the
// guard only ever degrades to a teaching block or a no-op, never corrupts
// execution.
const splitSegments = (command) =>
  command.split(/&&|\\|\\||\\$\\(|<\\(|[;|\\n\`]/).map((s) => s.trim()).filter((s) => s.length > 0);

// Tokenise a segment: strip quotes and subshell parens, extract redirections
// (dropping operator+target from the analysis tokens, and flagging output
// redirection to a real file — a mid-run kill of such a command could leave a
// plausible-looking partial artefact), and drop leading env assignments.
const tokenise = (segment) => {
  const raw = segment
    .split(/\\s+/)
    .filter((t) => t.length > 0)
    .map((t) => t.replace(/^['"]+|['"]+$/g, "").replace(/^\\(+/, "").replace(/\\)+$/g, ""))
    .filter((t) => t.length > 0);
  const tokens = [];
  let redirectsToFile = false;
  for (let i = 0; i < raw.length; i += 1) {
    const t = raw[i];
    const m = t.match(/^(\\d*|&)(>>?|<)(.*)$/);
    if (m) {
      const rest = m[3];
      if (rest.startsWith("&")) continue; // fd dup (2>&1): drop, harmless
      const target = rest !== "" ? rest : raw[i + 1];
      if (rest === "") i += 1; // consume the separate target token
      if (m[2] !== "<" && target !== undefined && target !== "/dev/null") {
        redirectsToFile = true;
      }
      continue;
    }
    tokens.push(t);
  }
  let start = 0;
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) start += 1;
  return { tokens: tokens.slice(start), redirectsToFile };
};

const headOf = (tokens) => {
  const head = tokens[0];
  return head === undefined ? undefined : path.basename(head);
};

// Strip prefix wrappers, reporting whether an explicit \`timeout N\` bound the
// command. Wrapper flags, their string/numeric values, and env assignments are
// skipped so \`env LC_ALL=C find ...\`, \`nice -n 10 find ...\`,
// \`sudo -u nobody find ...\`, and \`stdbuf -o L find ...\` all expose the
// walker. After a flag token, the next token is treated as that flag's value
// (and skipped) unless it is itself a walker or \`cd\` — so a no-value flag
// directly preceding the command (\`sudo -n find ...\`) still resolves.
const unwrapPrefixes = (tokens) => {
  let rest = tokens;
  let bounded = false;
  for (;;) {
    const head = headOf(rest);
    if (head === "timeout") {
      bounded = true;
      // timeout [opts] DURATION CMD... — skip to the token after the duration.
      let i = 1;
      while (i < rest.length && rest[i].startsWith("-")) i += 1;
      rest = rest.slice(i + 1);
    } else if (head !== undefined && WRAPPERS.has(head)) {
      rest = rest.slice(1);
      while (rest.length > 0) {
        const t = rest[0];
        if (/^\\d+$/.test(t) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
          rest = rest.slice(1);
        } else if (t.startsWith("-")) {
          rest = rest.slice(1);
          const value = rest[0];
          if (
            value !== undefined &&
            !value.startsWith("-") &&
            !WALKERS.has(path.basename(value)) &&
            path.basename(value) !== "cd" &&
            !WRAPPERS.has(path.basename(value))
          ) {
            rest = rest.slice(1); // the flag's value (e.g. -u nobody, -o L)
          }
        } else {
          break;
        }
      }
    } else {
      return { tokens: rest, bounded };
    }
  }
};

const isExpressionToken = (t) =>
  t.startsWith("-") || t === "(" || t === ")" || t === "!" || t === "\\\\(" || t === "\\\\)";

// find's actual syntax is \`find [paths...] [expression]\`: only the leading
// positionals are search roots. Anything after the first expression token
// (e.g. the file argument of \`-newer\`) is never a root.
const findRoots = (tokens) => {
  const roots = [];
  for (const t of tokens.slice(1)) {
    if (isExpressionToken(t)) break;
    roots.push(t);
  }
  return roots;
};

// Positional (non-flag) arguments of a grep/rg/fd-style search command.
const positionalArgs = (tokens) => tokens.slice(1).filter((t) => !isExpressionToken(t));

const isDepthBounded = (head, tokens) =>
  tokens.some(
    (t) =>
      t === "-maxdepth" ||
      t.startsWith("--maxdepth") ||
      t.startsWith("--max-depth") ||
      t.startsWith("--exact-depth") ||
      (head === "fd" && (t === "-d" || /^-d\\d/.test(t))),
  );

/**
 * Analyse one bash command against the worktree. Returns:
 *   { verdict: "allow" } |
 *   { verdict: "block", root } |
 *   { verdict: "allow", searchy: true }   (pure unbounded search → auto-bound)
 */
export const analyseBashCommand = (command, worktree) => {
  const segments = splitSegments(command);
  let cwd = worktree;
  let sawUnboundedWalker = false;
  let allSafe = segments.length > 0;
  for (const segment of segments) {
    const parsed = tokenise(segment);
    if (parsed.redirectsToFile) allSafe = false;
    const { tokens, bounded: timeoutBounded } = unwrapPrefixes(parsed.tokens);
    const head = headOf(tokens);
    if (head === undefined) continue;
    if (!SAFE_HEADS.has(head)) allSafe = false;
    if (head === "cd") {
      const target = tokens[1];
      cwd = target === undefined ? worktree : path.resolve(cwd, target);
      continue;
    }
    if (head === "sort" && tokens.some((t) => /^-o./.test(t) || t === "-o" || t.startsWith("--output"))) {
      allSafe = false; // sort -o FILE / -oFILE / --output writes a file
    }
    if (!WALKERS.has(head)) continue;
    if (tokens.some((t) => FIND_SIDE_EFFECTS.has(t))) allSafe = false;
    // Explicitly bounded walker (timeout prefix or depth bound): the escape
    // hatch. Passes the block layer AND is never re-bound by the auto-timeout.
    if (timeoutBounded || isDepthBounded(head, tokens)) continue;
    sawUnboundedWalker = true;
    const recursive =
      head === "find" ||
      head === "rg" ||
      head === "fd" ||
      tokens.some((t) => t === "-r" || t === "-R" || t === "--recursive" || /^-[a-zA-Z]*[rR]/.test(t));
    if (!recursive) continue;
    // Search roots resolved against the tracked cwd. find: leading positionals
    // only. grep/rg: first positional is the pattern unless --files. Default ".".
    let paths;
    if (head === "find") {
      paths = findRoots(tokens);
    } else {
      paths = positionalArgs(tokens);
      if ((head === "grep" || head === "rg") && !tokens.includes("--files") && paths.length > 0) {
        paths = paths.slice(1);
      }
    }
    if (paths.length === 0) paths = ["."];
    for (const p of paths) {
      const resolved = path.resolve(cwd, p);
      const vast = isVastRoot(worktree, resolved);
      const foreign = !isWithin(worktree, resolved);
      // rg/fd skip gitignored trees: only vast roots are dangerous for them.
      const dangerous = head === "rg" || head === "fd" ? vast : vast || foreign;
      if (dangerous) return { verdict: "block", root: resolved };
    }
  }
  return { verdict: "allow", searchy: sawUnboundedWalker && allSafe };
};

export const blockReason = (root) =>
  "Blocked by the t3 search guard: unbounded recursive search over " + root +
  " (outside your worktree). " + LADDER;

export const timeoutHint = () =>
  "\\n\\n[t3 search guard] This search was auto-bounded to " + TIMEOUT_SECONDS +
  "s because unbounded filesystem searches are the top cause of stuck threads; partial output above. " + LADDER;

export default function (pi) {
  // toolCallIds whose timeout the guard injected, so the timeout hint is only
  // appended to timeouts the guard itself caused.
  const injected = new Set();
  pi.on("tool_call", (event, ctx) => {
    try {
      if (event.toolName === "bash") {
        const command = event.input?.command;
        if (typeof command !== "string") return undefined;
        // An explicit tool-level timeout is the documented escape hatch: the
        // model has bounded the command itself, so neither block nor re-bound.
        if (event.input.timeout !== undefined) return undefined;
        const analysis = analyseBashCommand(command, ctx.cwd);
        if (analysis.verdict === "block") {
          return { block: true, reason: blockReason(analysis.root) };
        }
        if (analysis.searchy) {
          event.input.timeout = TIMEOUT_SECONDS;
          injected.add(event.toolCallId);
        }
        return undefined;
      }
      if (event.toolName === "grep" || event.toolName === "find") {
        const p = event.input?.path;
        if (typeof p !== "string") return undefined;
        const resolved = path.resolve(ctx.cwd, p);
        if (isVastRoot(ctx.cwd, resolved)) {
          return { block: true, reason: blockReason(resolved) };
        }
      }
    } catch {
      // Analyser bug → no guard, never a bricked session (a thrown tool_call
      // handler blocks ALL tool execution in pi).
    }
    return undefined;
  });
  pi.on("tool_result", (event) => {
    try {
      if (event.toolName !== "bash" || !injected.delete(event.toolCallId)) return undefined;
      if (!event.isError) return undefined;
      const text = event.content?.map((c) => c.text ?? "").join("\\n") ?? "";
      if (!text.includes("Command timed out after")) return undefined;
      return {
        content: [...event.content, { type: "text", text: timeoutHint() }],
        isError: true,
      };
    } catch {
      return undefined;
    }
  });
}
`;

/**
 * Write the search-guard extension into the state dir and return its path.
 * Written unconditionally (like the provider-tool extension) so guard changes
 * propagate to existing state dirs.
 */
export function ensurePiSearchGuardExtension(stateDir: string): string {
  const extensionDir = NodePath.join(stateDir, "pi-extensions");
  const extensionPath = NodePath.join(extensionDir, EXTENSION_FILE);
  NodeFS.mkdirSync(extensionDir, { recursive: true });
  NodeFS.writeFileSync(extensionPath, buildSearchGuardExtensionSource(), "utf8");
  return extensionPath;
}
