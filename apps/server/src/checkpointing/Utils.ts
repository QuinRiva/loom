import * as Base64Url from "effect/encoding/Base64Url";
import { CheckpointRef, ProjectId, type ThreadId } from "@t3tools/contracts";

const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(threadId)}/turn/${turnCount}`,
  );
}

// loom: start-of-turn baseline ref (orphaned in pull 9 — its V1 writer and reader are
// detached, DT-50; phase 2 re-expresses it on the V2 checkpoint consumer).
// Start-of-turn baseline: "tree state when this thread's turn n began".
// Lives in its own namespace so completed `turn/<n>` refs — the diff anchors
// the UI has already shown — are never overwritten. Refreshed each turn, so a
// turn's diff excludes whatever siblings changed in a shared worktree between
// this thread's turns.
export function checkpointBaselineRefForThreadTurn(
  threadId: ThreadId,
  turnCount: number,
): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/baseline/${turnCount}`,
  );
}

function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  return input.projects.find((project) => project.id === input.thread.projectId)?.workspaceRoot;
}
