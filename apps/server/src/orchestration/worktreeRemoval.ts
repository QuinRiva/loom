import * as Effect from "effect/Effect";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";

/**
 * The single worktree-removal routine, shared by the conservative auto-reaper
 * and the human-confirmed visibility surface (phase 3). Runs both git steps
 * under `WorktreeMutationLock` on the parent repo cwd — the same serialisation
 * the provisioner and fan-in use, so a removal can never race a concurrent
 * merge. The only difference between the two callers is `forceWorktree`
 * (the reaper never forces; the panel forces only acknowledged-dirty trees)
 * and whether the branch is deleted (only when it is fully merged, so an
 * acknowledged-unmerged removal loses no commits — only checkout disk).
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
    return yield* lock.withLock(
      input.cwd,
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
    );
  });
