// loom: fork-added sidebar helpers, split out of the upstream-owned
// Sidebar.logic.ts so upstream edits to that file never collide with the fork's
// additions. Pure and generic over the thread type; consumed by both sidebars
// and the goal panel.
import type { SidebarThreadSummary } from "../types";

/**
 * Picks the goal's canonical worktree to join when creating a new thread under
 * an existing goal: the most recently updated, non-archived goal thread that
 * still has a worktree. Returns null when the goal has no living worktree.
 */
export function resolveGoalWorktreeSeed(input: {
  goalId: string;
  threads: ReadonlyArray<{
    goalId: string | null;
    branch: string | null;
    worktreePath: string | null;
    archivedAt: string | null;
    updatedAt: string;
  }>;
}): { branch: string | null; worktreePath: string } | null {
  const canonical = input.threads
    .filter(
      (thread) =>
        thread.goalId === input.goalId &&
        thread.worktreePath !== null &&
        thread.archivedAt === null,
    )
    .reduce<(typeof input.threads)[number] | null>(
      (best, thread) =>
        best === null || Date.parse(thread.updatedAt) > Date.parse(best.updatedAt) ? thread : best,
      null,
    );
  return canonical?.worktreePath
    ? { branch: canonical.branch, worktreePath: canonical.worktreePath }
    : null;
}

/**
 * A parent-less handoff root that carries a kickoff brief and has not been
 * launched yet (still held at `planned`, no turn started). Distinguishes a
 * staged handoff from a normal idle root so the sidebar can flag it.
 */
export function isStagedHandoffThread(
  thread: Pick<SidebarThreadSummary, "parentThreadId" | "planLane" | "brief" | "latestTurn">,
): boolean {
  return (
    thread.parentThreadId === null &&
    thread.planLane === "planned" &&
    (thread.brief?.trim().length ?? 0) > 0 &&
    thread.latestTurn === null
  );
}
