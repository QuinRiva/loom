// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export function isGitRepository(cwd: string): boolean {
  return NodeFS.existsSync(NodePath.join(cwd, ".git"));
}

/**
 * True when `path` is an existing directory on disk. Used by the resume-launch
 * path to fall back from a dangling worktree path to the project workspace root
 * (post-completion engagement, plan §4.2), so a relocated/reaped worktree never
 * makes pi launch (`--cwd`) or the OS process spawn against a dead directory.
 */
export function directoryExists(path: string): boolean {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
}
