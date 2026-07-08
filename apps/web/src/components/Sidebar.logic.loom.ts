// loom: fork-added sidebar goal/ordering logic, split out of the upstream-owned
// Sidebar.logic.ts so upstream edits to that file never collide with the fork's
// goal-grouping additions. Pure and generic over the thread type; consumed by
// Sidebar.tsx and loom/SidebarGoalThreadList.tsx.
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";

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

export type SidebarGoalSortInput = {
  id: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type SidebarThreadOrderInput = Pick<Thread, "id"> &
  ThreadSortInput & { goalId?: string | null };

export type SidebarOrderedEntry<TThread> =
  | { kind: "goal"; goalId: string; threads: TThread[] }
  | { kind: "thread"; thread: TThread };

// Single source of truth for the sidebar's top-to-bottom ordering: goal groups
// and "loose" (no-goal) threads interleaved into ONE recency sequence. A goal
// ranks by its most-recently-active thread (falling back to its own
// updated/created time when it has no threads here), mirroring
// getProjectSortTimestamp. Both the render and the Ctrl+N jump-number map
// consume this so visual order and jump order can never drift apart.
export function buildSidebarGoalOrderedEntries<
  TThread extends SidebarThreadOrderInput,
  TGoal extends SidebarGoalSortInput,
>(input: {
  threads: readonly TThread[];
  goals: readonly TGoal[];
  sortOrder: SidebarThreadSortOrder;
}): SidebarOrderedEntry<TThread>[] {
  const { goals, sortOrder, threads } = input;

  const threadsByGoalId = new Map<string, TThread[]>();
  const looseThreads: TThread[] = [];
  for (const thread of threads) {
    if (thread.goalId) {
      const existing = threadsByGoalId.get(thread.goalId);
      if (existing) existing.push(thread);
      else threadsByGoalId.set(thread.goalId, [thread]);
    } else {
      looseThreads.push(thread);
    }
  }

  const goalById = new Map(goals.map((goal) => [goal.id, goal] as const));
  const goalRecency = (goalThreads: readonly TThread[], goal: TGoal | undefined): number => {
    if (goalThreads.length > 0) {
      return goalThreads.reduce(
        (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
        Number.NEGATIVE_INFINITY,
      );
    }
    if (sortOrder === "created_at") {
      return toSortableTimestamp(goal?.createdAt) ?? Number.NEGATIVE_INFINITY;
    }
    return toSortableTimestamp(goal?.updatedAt ?? goal?.createdAt) ?? Number.NEGATIVE_INFINITY;
  };

  // Every known goal appears (even with zero threads here), plus any orphan
  // goalId referenced by a thread but missing from `goals` (defensive).
  const goalIds = [
    ...goals.map((goal) => goal.id),
    ...[...threadsByGoalId.keys()].filter((goalId) => !goalById.has(goalId)),
  ];

  const ranked: { entry: SidebarOrderedEntry<TThread>; timestamp: number; sortKey: string }[] = [
    ...goalIds.map((goalId) => {
      const goalThreads = sortThreads(threadsByGoalId.get(goalId) ?? [], sortOrder);
      return {
        entry: { kind: "goal" as const, goalId, threads: goalThreads },
        timestamp: goalRecency(goalThreads, goalById.get(goalId)),
        sortKey: goalId,
      };
    }),
    ...looseThreads.map((thread) => ({
      entry: { kind: "thread" as const, thread },
      timestamp: getThreadSortTimestamp(thread, sortOrder),
      sortKey: thread.id,
    })),
  ];

  return ranked
    .toSorted((left, right) =>
      right.timestamp === left.timestamp
        ? right.sortKey.localeCompare(left.sortKey)
        : right.timestamp - left.timestamp,
    )
    .map((item) => item.entry);
}

// THE single per-project ordering pipeline. Both the rendered thread list and
// the Ctrl+N jump-number map run this exact transform — archived filter ->
// recency sort -> goal/loose interleave -> entry-level preview slice — so the
// visible rows and the jump sequence cannot drift: any change here moves both.
//
// The preview budget (`previewCount`) counts JUMP TARGETS, not raw threads:
// goals are containers (like projects) you cannot jump to, so the slice walks
// whole interleaved entries and tallies how many jumpable rows each exposes —
// 1 for a loose thread or a compact single-thread goal, N for an expanded goal,
// 0 for a collapsed one (its threads hide under the chevron, so collapsing a
// goal frees budget). Entries are atomic: a goal and all its threads cross the
// fold together, so a single-thread goal can never strand its header above the
// fold while its session drops into "Show more". The tally is the SAME flatten
// the jump map consumes, so "budget reached" means "this many jump targets
// shown". Zero-cost entries (collapsed/empty goals) ride along even once the
// budget is met, until the next jumpable entry closes the fold.
export function buildSidebarProjectThreadOrdering<
  TThread extends SidebarThreadOrderInput & { archivedAt: string | null },
  TGoal extends SidebarGoalSortInput,
>(input: {
  threads: readonly TThread[];
  goals: readonly TGoal[];
  sortOrder: SidebarThreadSortOrder;
  previewCount: number;
  isThreadListExpanded: boolean;
  collapsedGoalIds: ReadonlySet<string>;
  knownGoalIds: ReadonlySet<string>;
}): {
  sortedThreads: TThread[];
  previewThreads: TThread[];
  hasOverflowingThreads: boolean;
  orderedEntries: SidebarOrderedEntry<TThread>[];
} {
  const sortedThreads = sortThreads(
    input.threads.filter((thread) => thread.archivedAt === null),
    input.sortOrder,
  );
  const allEntries = buildSidebarGoalOrderedEntries({
    threads: sortedThreads,
    goals: input.goals,
    sortOrder: input.sortOrder,
  });
  const collapse = { collapsedGoalIds: input.collapsedGoalIds, knownGoalIds: input.knownGoalIds };

  const previewEntries: SidebarOrderedEntry<TThread>[] = [];
  let exposed = 0;
  for (const entry of allEntries) {
    const jumpTargets = flattenSidebarOrderedThreads([entry], collapse).length;
    if (exposed >= input.previewCount && jumpTargets > 0) break;
    previewEntries.push(entry);
    exposed += jumpTargets;
  }

  const orderedEntries = input.isThreadListExpanded ? allEntries : previewEntries;
  return {
    sortedThreads,
    previewThreads: orderedEntries.flatMap((entry) =>
      entry.kind === "thread" ? [entry.thread] : entry.threads,
    ),
    hasOverflowingThreads: previewEntries.length < allEntries.length,
    orderedEntries,
  };
}

// A goal group renders compact (a single plain thread row standing in for the
// goal, with no collapse chevron) iff it is a KNOWN goal with exactly one
// thread. That row is never collapsible, so its thread is always on screen.
// Every other goal group renders a chevron and can hide its threads. Both the
// render and the jump flatten use this so their compact-vs-collapsible split
// can never diverge.
export function isCompactSingleThreadGoal<TThread>(
  entry: Extract<SidebarOrderedEntry<TThread>, { kind: "goal" }>,
  knownGoalIds: ReadonlySet<string>,
): boolean {
  return knownGoalIds.has(entry.goalId) && entry.threads.length === 1;
}

// Flatten ordered entries into the thread sequence the Ctrl+N jump map numbers.
// When `collapse` is supplied, threads inside collapsed COLLAPSIBLE goal groups
// are excluded so jump numbers match strictly-visible rows; compact
// single-thread goals always count because they never collapse.
export function flattenSidebarOrderedThreads<TThread>(
  entries: readonly SidebarOrderedEntry<TThread>[],
  collapse?: { collapsedGoalIds: ReadonlySet<string>; knownGoalIds: ReadonlySet<string> },
): TThread[] {
  return entries.flatMap((entry) => {
    if (entry.kind === "thread") return [entry.thread];
    if (!collapse || isCompactSingleThreadGoal(entry, collapse.knownGoalIds)) return entry.threads;
    return collapse.collapsedGoalIds.has(entry.goalId) ? [] : entry.threads;
  });
}
