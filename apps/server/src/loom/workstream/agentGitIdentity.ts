/**
 * Who made an agent's commit. Every pi process Loom composes commits as `Loom agent` (the
 * email stays git's `user.email`, so GitHub credit is unchanged) and puts a `git` shim first
 * on its PATH that adds `Loom-Thread:` and `Pi-Session:` trailers to each `git commit`, naming
 * the thread and pi session that made it. The work-model doctrine tells agents that a commit in
 * the human's name is an agent's unless it says otherwise, and to read the trailer for which.
 * Other commit-making commands (merge, rebase, cherry-pick) carry the name but no trailers.
 *
 * @module loom/workstream/agentGitIdentity
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** The author and committer name of every agent commit. */
export const AGENT_GIT_NAME = "Loom agent";

/**
 * The shim. It drops its own directory from PATH (so the real git, and anything git runs, never
 * re-enters it), finds the subcommand past git's global options, and on `commit` inserts the
 * trailers right after it (before any `--` pathspec). A no-op without `LOOM_THREAD_ID`.
 */
export const GIT_SHIM_SOURCE = `#!/bin/sh
# Loom's git shim (apps/server/src/loom/workstream/agentGitIdentity.ts): on \`git commit\` in a
# Loom agent's session, adds Loom-Thread and Pi-Session trailers; every other call passes through.
self=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH=$(printf '%s\\n' "$PATH" | tr ':' '\\n' | grep -vxF "$self" | paste -sd: -)
export PATH
[ -n "$LOOM_THREAD_ID" ] || exec git "$@"
expect=subcommand
n=$#
while [ "$n" -gt 0 ]; do
  arg=$1
  shift
  n=$((n - 1))
  set -- "$@" "$arg"
  case $expect in
    value) expect=subcommand ;;
    subcommand)
      case $arg in
        -C | -c | --git-dir | --work-tree | --namespace) expect=value ;;
        -*) ;;
        commit)
          set -- "$@" --trailer "Loom-Thread: $LOOM_THREAD_ID"
          [ -z "$PI_SESSION_ID" ] || set -- "$@" --trailer "Pi-Session: $PI_SESSION_ID"
          expect=commit
          ;;
        *) expect=done ;;
      esac
      ;;
  esac
done
# An --amend adds no second copy of a trailer the commit already carries.
[ "$expect" = commit ] && set -- -c trailer.ifExists=addIfDifferent "$@"
exec git "$@"
`;

/** Writes the shim as `<dir>/git` (only when its bytes changed) and returns `dir`, the PATH entry. */
export const materializeGitShim = Effect.fn("loom.materializeGitShim")(function* (dir: string) {
  const fs = yield* FileSystem.FileSystem;
  const shim = (yield* Path.Path).join(dir, "git");
  yield* fs.makeDirectory(dir, { recursive: true });
  const existing = yield* fs.readFileString(shim).pipe(Effect.orElseSucceed(() => ""));
  if (existing !== GIT_SHIM_SOURCE) yield* fs.writeFileString(shim, GIT_SHIM_SOURCE);
  yield* fs.chmod(shim, 0o755);
  return dir;
});

/** The env a thread's pi process commits under; `PI_SESSION_ID` is pi's own. */
export const agentGitEnv = (threadId: ThreadId) => ({
  GIT_AUTHOR_NAME: AGENT_GIT_NAME,
  GIT_COMMITTER_NAME: AGENT_GIT_NAME,
  LOOM_THREAD_ID: threadId,
});
