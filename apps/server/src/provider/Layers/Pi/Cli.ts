// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export const DEFAULT_PI_BINARY_PATH = "pi";

/**
 * Deterministic per-thread pi session id: the thread id with non-id characters
 * sanitized. pi create-or-resumes the SAME session file for it across restarts,
 * and `consult_thread` resolves the target's frozen session by this same id.
 */
export const piSessionIdForThread = (threadId: string): string =>
  threadId.replace(/[^a-zA-Z0-9_-]/g, "-");

/** Default pi sessions root: `~/.pi/agent/sessions`. */
export const defaultSessionsRoot = (): string =>
  NodePath.join(NodeOS.homedir(), ".pi", "agent", "sessions");

/**
 * Resolve a deterministic pi session id to its absolute `.jsonl` path by
 * scanning every project-slug dir under the sessions root for a file ending in
 * `_<sessionId>.jsonl` (pi names files `<timestamp>_<sessionId>.jsonl`). The
 * `_` boundary plus the UUID-shaped id make false positives effectively
 * impossible. Returns the newest match, or undefined when none exists (the
 * caller then falls back to the bare id). Scoped to the sessions root only —
 * never an unbounded filesystem walk.
 */
export const resolveSessionFilePath = (
  sessionId: string,
  root: string = defaultSessionsRoot(),
): string | undefined => {
  if (!NodeFS.existsSync(root)) return undefined;
  const suffix = `_${sessionId}.jsonl`;
  let best: { path: string; mtimeMs: number } | undefined;
  for (const slug of NodeFS.readdirSync(root)) {
    const dir = NodePath.join(root, slug);
    let entries: ReadonlyArray<string>;
    try {
      entries = NodeFS.readdirSync(dir);
    } catch {
      continue; // Not a readable directory; skip.
    }
    for (const name of entries) {
      if (!name.endsWith(suffix)) continue;
      const path = NodePath.join(dir, name);
      const mtimeMs = NodeFS.statSync(path).mtimeMs;
      if (best === undefined || mtimeMs > best.mtimeMs) best = { path, mtimeMs };
    }
  }
  return best?.path;
};

export interface PiInvocation {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const WINDOWS_COMMAND_SCRIPT_PATTERN = /\.(?:bat|cmd)$/i;

export function resolveBundledPiCliPath(): string | undefined {
  const req = NodeModule.createRequire(import.meta.url);
  for (const packageName of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
    try {
      const cliPath = NodePath.join(
        NodePath.dirname(req.resolve(`${packageName}/package.json`)),
        "dist",
        "cli.js",
      );
      if (NodeFS.existsSync(cliPath)) return cliPath;
    } catch {
      // Try the next known package name.
    }
  }
  return undefined;
}

export function resolvePiInvocation(binaryPath: string): PiInvocation {
  if (binaryPath !== DEFAULT_PI_BINARY_PATH) return { command: binaryPath, args: [] };
  const bundledCliPath = resolveBundledPiCliPath();
  return bundledCliPath
    ? { command: process.execPath, args: [bundledCliPath] }
    : { command: binaryPath, args: [] };
}

export function buildPiRpcInvocation(binaryPath: string): PiInvocation {
  const invocation = resolvePiInvocation(binaryPath);
  return { ...invocation, args: [...invocation.args, "--mode", "rpc"] };
}

function stripWindowsShellQuotes(command: string): string {
  return command.startsWith('"') && command.endsWith('"') ? command.slice(1, -1) : command;
}

export function shouldUseWindowsPiShell(command: string, platform: NodeJS.Platform): boolean {
  if (platform !== "win32") return false;
  const unquoted = stripWindowsShellQuotes(command);
  return unquoted === DEFAULT_PI_BINARY_PATH || WINDOWS_COMMAND_SCRIPT_PATTERN.test(unquoted);
}

export function quoteWindowsPiShellCommand(command: string, platform: NodeJS.Platform): string {
  if (
    platform !== "win32" ||
    !/\s/.test(command) ||
    (command.startsWith('"') && command.endsWith('"'))
  ) {
    return command;
  }
  return `"${command}"`;
}
