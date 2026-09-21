import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerConfig } from "../config.ts";
import { isInsideDirectory } from "../workspace/foreignHomeGuard.loom.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { WorkspaceLease } from "../workspace/WorkspaceOccupancyLease.ts";

/**
 * The single worktree-removal routine, shared by the conservative auto-reaper
 * and the human-confirmed visibility surface (phase 3). The only difference
 * between the two callers is `forceWorktree` (the reaper never forces; the
 * panel forces only acknowledged-dirty trees) and whether the branch is deleted
 * (only when it is fully merged, so an acknowledged-unmerged removal loses no
 * commits — only checkout disk).
 *
 * Two guards, and their nesting order is load-bearing:
 *
 * 1. `WorktreeMutationLock` on the parent repo cwd — the same serialisation the
 *    provisioner and fan-in use, so a removal can never race a concurrent merge.
 * 2. `WorkspaceLease.withExclusive` on the worktree being removed — no process
 *    may be live in it, atomically with the removal (post-completion engagement
 *    plan §7).
 *
 * Lock OUTSIDE, lease INSIDE, matching the fan-in reactor. The inverse order
 * deadlocks: provisioning holds the parent lock while taking a hold on the
 * child tree it just cut, so a remover holding the child's lease and waiting on
 * the parent lock would close the cycle. In this order the only waiter is the
 * lock, and nothing that holds the lock ever waits on the lease — `withExclusive`
 * returns immediately rather than queueing.
 *
 * Returns `Option.none` when the workspace is occupied, or when the recorded
 * path is not one this home owns (see the containment check below); the caller
 * skips and retries on its next pass.
 */
export const performWorktreeRemoval = (input: {
  readonly cwd: string;
  readonly path: string;
  readonly branch: string | null;
  readonly forceWorktree: boolean;
  readonly deleteBranchWhenMerged: boolean;
}) =>
  Effect.gen(function* () {
    const gitWorkflow = yield* GitWorkflowService;
    const lock = yield* WorktreeMutationLock;
    const lease = yield* WorkspaceLease;
    // loom: the path comes from a thread row, and a database copied from another
    // home records that home's live checkouts (foreignHomeGuard.loom.ts). Every
    // checkout this server provisions lands under its own `worktreesDir`, so a
    // recorded path outside it is never ours to delete. The reaper already wore
    // this belt alone; here it covers the maintenance panel too. A skip, not a
    // failure — same shape as "the workspace is occupied".
    const { worktreesDir } = yield* ServerConfig;
    if (!isInsideDirectory(worktreesDir, input.path)) {
      yield* Effect.logWarning(
        "worktree removal refused: the recorded path is outside this server's worktrees directory",
        { path: input.path, worktreesDir },
      );
      return Option.none();
    }
    return yield* lock.withLock(
      input.cwd,
      lease.withExclusive(
        input.path,
        Effect.gen(function* () {
          yield* gitWorkflow.removeWorktree({
            cwd: input.cwd,
            path: input.path,
            force: input.forceWorktree,
          });
          if (input.branch !== null && input.deleteBranchWhenMerged) {
            // Non-forced: git refuses to delete an unmerged branch, a final belt
            // against destroying commits even if the merged check ever drifts.
            yield* gitWorkflow.deleteBranch({ cwd: input.cwd, branch: input.branch, force: false });
            return { deletedBranch: input.branch as string | null };
          }
          return { deletedBranch: null as string | null };
        }),
      ),
    );
  });
