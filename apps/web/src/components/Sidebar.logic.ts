import * as React from "react";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import {
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from "../lib/threadSort";
import type { SidebarThreadSummary, Thread } from "../types";
import { cn } from "../lib/utils";
import { isLatestTurnSettled } from "../session-logic";

export const THREAD_SELECTION_SAFE_SELECTOR = "[data-thread-item], [data-thread-selection-safe]";
export const THREAD_JUMP_HINT_SHOW_DELAY_MS = 100;
// Visible sidebar rows are prewarmed into the thread-detail cache so opening a
// nearby thread usually reuses an already-hot subscription.
export const SIDEBAR_THREAD_PREWARM_LIMIT = 10;
export type SidebarNewThreadEnvMode = "local" | "worktree";
type SidebarProject = {
  id: string;
  name: string;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
};

export type ThreadTraversalDirection = "previous" | "next";

export interface ThreadStatusPill {
  label:
    | "Working"
    | "Connecting"
    | "Completed"
    | "Pending Approval"
    | "Awaiting Input"
    | "Plan Ready";
  colorClass: string;
  dotClass: string;
  pulse: boolean;
}

const THREAD_STATUS_PRIORITY: Record<ThreadStatusPill["label"], number> = {
  "Pending Approval": 5,
  "Awaiting Input": 4,
  Working: 3,
  Connecting: 3,
  "Plan Ready": 2,
  Completed: 1,
};

type ThreadStatusInput = Pick<
  SidebarThreadSummary,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
> & {
  lastVisitedAt?: string | undefined;
};

export interface ThreadJumpHintVisibilityController {
  sync: (shouldShow: boolean) => void;
  dispose: () => void;
}

export function createThreadJumpHintVisibilityController(input: {
  delayMs: number;
  onVisibilityChange: (visible: boolean) => void;
  setTimeoutFn?: typeof globalThis.setTimeout;
  clearTimeoutFn?: typeof globalThis.clearTimeout;
}): ThreadJumpHintVisibilityController {
  const setTimeoutFn = input.setTimeoutFn ?? globalThis.setTimeout;
  const clearTimeoutFn = input.clearTimeoutFn ?? globalThis.clearTimeout;
  let isVisible = false;
  let timeoutId: NodeJS.Timeout | null = null;

  const clearPendingShow = () => {
    if (timeoutId === null) {
      return;
    }
    clearTimeoutFn(timeoutId);
    timeoutId = null;
  };

  return {
    sync: (shouldShow) => {
      if (!shouldShow) {
        clearPendingShow();
        if (isVisible) {
          isVisible = false;
          input.onVisibilityChange(false);
        }
        return;
      }

      if (isVisible || timeoutId !== null) {
        return;
      }

      timeoutId = setTimeoutFn(() => {
        timeoutId = null;
        isVisible = true;
        input.onVisibilityChange(true);
      }, input.delayMs);
    },
    dispose: () => {
      clearPendingShow();
    },
  };
}

export function useThreadJumpHintVisibility(): {
  showThreadJumpHints: boolean;
  updateThreadJumpHintsVisibility: (shouldShow: boolean) => void;
} {
  const [showThreadJumpHints, setShowThreadJumpHints] = React.useState(false);
  const controllerRef = React.useRef<ThreadJumpHintVisibilityController | null>(null);

  React.useEffect(() => {
    const controller = createThreadJumpHintVisibilityController({
      delayMs: THREAD_JUMP_HINT_SHOW_DELAY_MS,
      onVisibilityChange: (visible) => {
        setShowThreadJumpHints(visible);
      },
      setTimeoutFn: window.setTimeout.bind(window),
      clearTimeoutFn: window.clearTimeout.bind(window),
    });
    controllerRef.current = controller;

    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  const updateThreadJumpHintsVisibility = React.useCallback((shouldShow: boolean) => {
    controllerRef.current?.sync(shouldShow);
  }, []);

  return {
    showThreadJumpHints,
    updateThreadJumpHintsVisibility,
  };
}

export function hasUnseenCompletion(thread: ThreadStatusInput): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return true;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

export function shouldClearThreadSelectionOnMouseDown(target: HTMLElement | null): boolean {
  if (target === null) return true;
  return !target.closest(THREAD_SELECTION_SAFE_SELECTOR);
}

export function resolveSidebarNewThreadEnvMode(input: {
  requestedEnvMode?: SidebarNewThreadEnvMode;
  defaultEnvMode: SidebarNewThreadEnvMode;
}): SidebarNewThreadEnvMode {
  return input.requestedEnvMode ?? input.defaultEnvMode;
}

export function resolveSidebarNewThreadSeedContext(input: {
  projectId: string;
  defaultEnvMode: SidebarNewThreadEnvMode;
  activeThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
  } | null;
  activeDraftThread?: {
    projectId: string;
    branch: string | null;
    worktreePath: string | null;
    envMode: SidebarNewThreadEnvMode;
  } | null;
}): {
  branch?: string | null;
  worktreePath?: string | null;
  envMode: SidebarNewThreadEnvMode;
} {
  if (input.defaultEnvMode === "worktree") {
    return {
      envMode: "worktree",
    };
  }

  if (input.activeDraftThread?.projectId === input.projectId) {
    return {
      branch: input.activeDraftThread.branch,
      worktreePath: input.activeDraftThread.worktreePath,
      envMode: input.activeDraftThread.envMode,
    };
  }

  if (input.activeThread?.projectId === input.projectId) {
    return {
      branch: input.activeThread.branch,
      worktreePath: input.activeThread.worktreePath,
      envMode: input.activeThread.worktreePath ? "worktree" : "local",
    };
  }

  return {
    envMode: input.defaultEnvMode,
  };
}

export function orderItemsByPreferredIds<TItem, TId>(input: {
  items: readonly TItem[];
  preferredIds: readonly TId[];
  getId: (item: TItem) => TId;
}): TItem[] {
  const { getId, items, preferredIds } = input;
  if (preferredIds.length === 0) {
    return [...items];
  }

  const itemsById = new Map(items.map((item) => [getId(item), item] as const));
  const preferredIdSet = new Set(preferredIds);
  const emittedPreferredIds = new Set<TId>();
  const ordered = preferredIds.flatMap((id) => {
    if (emittedPreferredIds.has(id)) {
      return [];
    }
    const item = itemsById.get(id);
    if (!item) {
      return [];
    }
    emittedPreferredIds.add(id);
    return [item];
  });
  const remaining = items.filter((item) => !preferredIdSet.has(getId(item)));
  return [...ordered, ...remaining];
}

export function getVisibleSidebarThreadIds<TThreadId>(
  renderedProjects: readonly {
    shouldShowThreadPanel?: boolean;
    renderedThreadIds: readonly TThreadId[];
  }[],
): TThreadId[] {
  return renderedProjects.flatMap((renderedProject) =>
    renderedProject.shouldShowThreadPanel === false ? [] : renderedProject.renderedThreadIds,
  );
}

export function getSidebarThreadIdsToPrewarm<TThreadId>(
  visibleThreadIds: readonly TThreadId[],
  limit = SIDEBAR_THREAD_PREWARM_LIMIT,
): TThreadId[] {
  return visibleThreadIds.slice(0, Math.max(0, limit));
}

export function resolveAdjacentThreadId<T>(input: {
  threadIds: readonly T[];
  currentThreadId: T | null;
  direction: ThreadTraversalDirection;
}): T | null {
  const { currentThreadId, direction, threadIds } = input;

  if (threadIds.length === 0) {
    return null;
  }

  if (currentThreadId === null) {
    return direction === "previous" ? (threadIds.at(-1) ?? null) : (threadIds[0] ?? null);
  }

  const currentIndex = threadIds.indexOf(currentThreadId);
  if (currentIndex === -1) {
    return null;
  }

  if (direction === "previous") {
    return currentIndex > 0 ? (threadIds[currentIndex - 1] ?? null) : null;
  }

  return currentIndex < threadIds.length - 1 ? (threadIds[currentIndex + 1] ?? null) : null;
}

export function isContextMenuPointerDown(input: {
  button: number;
  ctrlKey: boolean;
  isMac: boolean;
}): boolean {
  if (input.button === 2) return true;
  return input.isMac && input.button === 0 && input.ctrlKey;
}

export function resolveThreadRowClassName(input: {
  isActive: boolean;
  isSelected: boolean;
}): string {
  const baseClassName =
    "h-6 w-full translate-x-0 cursor-pointer justify-start px-2 text-left select-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring sm:h-7";

  if (input.isSelected && input.isActive) {
    return cn(
      baseClassName,
      "bg-primary/22 text-foreground font-medium hover:bg-primary/26 hover:text-foreground dark:bg-primary/30 dark:hover:bg-primary/36",
    );
  }

  if (input.isSelected) {
    return cn(
      baseClassName,
      "bg-primary/15 text-foreground hover:bg-primary/19 hover:text-foreground dark:bg-primary/22 dark:hover:bg-primary/28",
    );
  }

  if (input.isActive) {
    return cn(
      baseClassName,
      "bg-accent/85 text-foreground font-medium hover:bg-accent hover:text-foreground dark:bg-accent/55 dark:hover:bg-accent/70",
    );
  }

  return cn(baseClassName, "text-muted-foreground hover:bg-accent hover:text-foreground");
}

export function resolveThreadStatusPill(input: {
  thread: ThreadStatusInput;
}): ThreadStatusPill | null {
  const { thread } = input;

  if (thread.hasPendingApprovals) {
    return {
      label: "Pending Approval",
      colorClass: "text-amber-600 dark:text-amber-300/90",
      dotClass: "bg-amber-500 dark:bg-amber-300/90",
      pulse: false,
    };
  }

  if (thread.hasPendingUserInput) {
    return {
      label: "Awaiting Input",
      colorClass: "text-indigo-600 dark:text-indigo-300/90",
      dotClass: "bg-indigo-500 dark:bg-indigo-300/90",
      pulse: false,
    };
  }

  if (thread.session?.status === "running") {
    return {
      label: "Working",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  if (thread.session?.status === "connecting") {
    return {
      label: "Connecting",
      colorClass: "text-sky-600 dark:text-sky-300/80",
      dotClass: "bg-sky-500 dark:bg-sky-300/80",
      pulse: true,
    };
  }

  const hasPlanReadyPrompt =
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestTurnSettled(thread.latestTurn, thread.session) &&
    thread.hasActionableProposedPlan;
  if (hasPlanReadyPrompt) {
    return {
      label: "Plan Ready",
      colorClass: "text-violet-600 dark:text-violet-300/90",
      dotClass: "bg-violet-500 dark:bg-violet-300/90",
      pulse: false,
    };
  }

  if (hasUnseenCompletion(thread)) {
    return {
      label: "Completed",
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      dotClass: "bg-emerald-500 dark:bg-emerald-300/90",
      pulse: false,
    };
  }

  return null;
}

export function resolveProjectStatusIndicator(
  statuses: ReadonlyArray<ThreadStatusPill | null>,
): ThreadStatusPill | null {
  let highestPriorityStatus: ThreadStatusPill | null = null;

  for (const status of statuses) {
    if (status === null) continue;
    if (
      highestPriorityStatus === null ||
      THREAD_STATUS_PRIORITY[status.label] > THREAD_STATUS_PRIORITY[highestPriorityStatus.label]
    ) {
      highestPriorityStatus = status;
    }
  }

  return highestPriorityStatus;
}

export function getVisibleThreadsForProject<T extends Pick<Thread, "id">>(input: {
  threads: readonly T[];
  activeThreadId: T["id"] | undefined;
  isThreadListExpanded: boolean;
  previewLimit: number;
}): {
  hasHiddenThreads: boolean;
  visibleThreads: T[];
  hiddenThreads: T[];
} {
  const { activeThreadId, isThreadListExpanded, previewLimit, threads } = input;
  const hasHiddenThreads = threads.length > previewLimit;

  if (!hasHiddenThreads || isThreadListExpanded) {
    return {
      hasHiddenThreads,
      hiddenThreads: [],
      visibleThreads: [...threads],
    };
  }

  const previewThreads = threads.slice(0, previewLimit);
  if (!activeThreadId || previewThreads.some((thread) => thread.id === activeThreadId)) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const activeThread = threads.find((thread) => thread.id === activeThreadId);
  if (!activeThread) {
    return {
      hasHiddenThreads: true,
      hiddenThreads: threads.slice(previewLimit),
      visibleThreads: previewThreads,
    };
  }

  const visibleThreadIds = new Set([...previewThreads, activeThread].map((thread) => thread.id));

  return {
    hasHiddenThreads: true,
    hiddenThreads: threads.filter((thread) => !visibleThreadIds.has(thread.id)),
    visibleThreads: threads.filter((thread) => visibleThreadIds.has(thread.id)),
  };
}

export function getFallbackThreadIdAfterDelete<
  T extends Pick<Thread, "id" | "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(input: {
  threads: readonly T[];
  deletedThreadId: T["id"];
  sortOrder: SidebarThreadSortOrder;
  deletedThreadIds?: ReadonlySet<T["id"]>;
}): T["id"] | null {
  const { deletedThreadId, deletedThreadIds, sortOrder, threads } = input;
  const deletedThread = threads.find((thread) => thread.id === deletedThreadId);
  if (!deletedThread) {
    return null;
  }

  return (
    sortThreads(
      threads.filter(
        (thread) =>
          thread.projectId === deletedThread.projectId &&
          thread.id !== deletedThreadId &&
          !deletedThreadIds?.has(thread.id),
      ),
      sortOrder,
    )[0]?.id ?? null
  );
}
export function getProjectSortTimestamp(
  project: SidebarProject,
  projectThreads: readonly ThreadSortInput[],
  sortOrder: Exclude<SidebarProjectSortOrder, "manual">,
): number {
  if (projectThreads.length > 0) {
    return projectThreads.reduce(
      (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
      Number.NEGATIVE_INFINITY,
    );
  }

  if (sortOrder === "created_at") {
    return toSortableTimestamp(project.createdAt) ?? Number.NEGATIVE_INFINITY;
  }
  return toSortableTimestamp(project.updatedAt ?? project.createdAt) ?? Number.NEGATIVE_INFINITY;
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

export function sortProjectsForSidebar<
  TProject extends SidebarProject,
  TThread extends Pick<Thread, "projectId" | "createdAt" | "updatedAt"> & ThreadSortInput,
>(
  projects: readonly TProject[],
  threads: readonly TThread[],
  sortOrder: SidebarProjectSortOrder,
): TProject[] {
  if (sortOrder === "manual") {
    return [...projects];
  }

  const threadsByProjectId = new Map<string, TThread[]>();
  for (const thread of threads) {
    const existing = threadsByProjectId.get(thread.projectId) ?? [];
    existing.push(thread);
    threadsByProjectId.set(thread.projectId, existing);
  }

  return [...projects].toSorted((left, right) => {
    const rightTimestamp = getProjectSortTimestamp(
      right,
      threadsByProjectId.get(right.id) ?? [],
      sortOrder,
    );
    const leftTimestamp = getProjectSortTimestamp(
      left,
      threadsByProjectId.get(left.id) ?? [],
      sortOrder,
    );
    const byTimestamp =
      rightTimestamp === leftTimestamp ? 0 : rightTimestamp > leftTimestamp ? 1 : -1;
    if (byTimestamp !== 0) return byTimestamp;
    return left.name.localeCompare(right.name) || left.id.localeCompare(right.id);
  });
}
