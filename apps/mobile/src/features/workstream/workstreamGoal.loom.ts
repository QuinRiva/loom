/**
 * loom: a workstream's Loom goal on the phone (§4-§6 of plans/mobile-goal-tasks/plan.mdx): Home
 * count, Tasks tab view and state, header crumb. From the shell snapshot; a goal it lacks is asked
 * for once by `goalAtom`. The Loom goal is `workstream.goalId`, never the provider-native `goal`.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  anchoredThreadsByTask,
  countGoalTasks,
} from "@t3tools/client-runtime/state/loom/goalTasks";
import { createLoomGoalAtoms } from "@t3tools/client-runtime/state/loom/goals";
import {
  buildWorkstreamNodes,
  type WorkstreamNode,
} from "@t3tools/client-runtime/state/loom/workstreamNodes";
import type {
  EnvironmentId,
  GoalId,
  LoomGoalShell,
  LoomGoalTask,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadEnvironment } from "../../state/threads";
import { finishedTaskIds, type TaskFilter, type TaskThread, unfoldTo } from "./goalTaskRows.loom";
import { openWorkstream } from "./workstreamNavigation.loom";
import {
  sameNode,
  sameValue,
  workstreamBadgesAtom,
  parseWorkstreamKey,
  workstreamEnvironmentIndexAtom,
  workstreamKey,
} from "./workstreamView.loom";

const loomGoalAtoms = createLoomGoalAtoms({
  runtime: connectionAtomRuntime,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

export interface GoalTaskCount {
  readonly done: number;
  readonly total: number;
}

/** The task `taskId` anywhere in the tree, or null. */
export function findGoalTask(
  tasks: ReadonlyArray<LoomGoalTask>,
  taskId: string,
): LoomGoalTask | null {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const found = findGoalTask(task.children, taskId);
    if (found) return found;
  }
  return null;
}

// The Home row's count

const EMPTY_COUNTS: ReadonlyMap<GoalId, GoalTaskCount> = new Map();

/**
 * Done/total for every goal the snapshot holds that has a task. Rebuilt only when the `goals`
 * array changes, which thread events leave alone.
 */
export const goalCountsAtom = Atom.family((environmentId: EnvironmentId) => {
  let previous: {
    goals: ReadonlyArray<LoomGoalShell>;
    counts: ReadonlyMap<GoalId, GoalTaskCount>;
  } | null = null;
  return Atom.make((get) => {
    const goals = get(threadEnvironment.snapshotAtom(environmentId))?.goals;
    if (!goals) return EMPTY_COUNTS;
    if (previous?.goals !== goals)
      previous = {
        goals,
        counts: new Map(
          goals.flatMap((goal) => {
            const count = countGoalTasks(goal.tasks);
            return count.total > 0 ? [[goal.id, count] as const] : [];
          }),
        ),
      };
    return previous.counts;
  }).pipe(Atom.withLabel(`loom-goal-counts:${environmentId}`));
});

const goalCountAtom = Atom.family((key: string) => {
  const [environmentId, goalId] = JSON.parse(key) as [EnvironmentId, GoalId];
  let previous: GoalTaskCount | null = null;
  return Atom.make((get) => {
    const next = get(goalCountsAtom(environmentId)).get(goalId) ?? null;
    if (next?.done !== previous?.done || next?.total !== previous?.total) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`loom-goal-count:${key}`));
});

const noCountAtom = Atom.make<GoalTaskCount | null>(null);

/**
 * A Home row's tasks count: null without a goal, a task, or a goal the snapshot holds (an older
 * settled row arrives without its goal, and counting it would cost a request per row).
 */
export const useGoalTaskCount = (environmentId: EnvironmentId, goalId: GoalId | null | undefined) =>
  useAtomValue(
    goalId == null ? noCountAtom : goalCountAtom(JSON.stringify([environmentId, goalId])),
  );

// The Tasks tab

export type GoalTasksView =
  /** No goal on the root, or a goal with no task: the screen has no Tasks tab. */
  | { readonly status: "absent" }
  /** The shell, the root (a finished workstream's arrives with its family) or the goal is on its way. */
  | { readonly status: "loading" }
  /** The root names a goal the server could not return. */
  | { readonly status: "missing" }
  | {
      readonly status: "ready";
      readonly goal: LoomGoalShell;
      readonly count: GoalTaskCount;
      /** Every owning thread the phone holds; a node keeps its identity while its fields are equal. */
      readonly nodes: ReadonlyMap<ThreadId, WorkstreamNode>;
      /** `goalTaskRows`' input, oldest first; keeps its identity while owners and liveness hold. */
      readonly threadsByTask: ReadonlyMap<string, ReadonlyArray<TaskThread>>;
    };

const ABSENT: GoalTasksView = { status: "absent" };
const LOADING: GoalTasksView = { status: "loading" };
const MISSING: GoalTasksView = { status: "missing" };

/** Live is no outcome yet, or a flag (a settled thread can still wait on the human). */
const isLive = (node: WorkstreamNode) => node.outcome === null || node.reasons.length > 0;

/** One workstream's goal and owning threads, keyed by `workstreamKey(environmentId, rootId)`. */
export const goalTasksViewAtom = Atom.family((key: string) => {
  const [environmentId, rootId] = parseWorkstreamKey(key);
  let previous: Extract<GoalTasksView, { status: "ready" }> | null = null;
  let previousShape = "";
  return Atom.make((get): GoalTasksView => {
    const index = get(workstreamEnvironmentIndexAtom(environmentId));
    const root = index?.threadsById.get(rootId);
    if (!index || !root) return LOADING;
    const goalId = root.workstream?.goalId;
    if (!goalId) return ABSENT;
    const goal = get(loomGoalAtoms.goalAtom(environmentId, goalId));
    if (goal === undefined) return LOADING;
    if (goal === null) return MISSING;
    if (goal.tasks.length === 0) return ABSENT;
    const built = buildWorkstreamNodes(
      index.threads.filter(
        (shell) =>
          shell.workstream?.goalId === goalId &&
          shell.workstream.anchorTaskId != null &&
          shell.archivedAt === null,
      ),
      index.byId,
    );
    const nodes = new Map(
      [...built].map(([id, node]) => {
        const before = previous?.nodes.get(id);
        return [id, before && sameNode(before, node) ? before : node] as const;
      }),
    );
    const owners = anchoredThreadsByTask([...nodes.values()], goalId, (node) => ({
      workstream: node,
      archived: node.archived,
      createdAt: node.createdAt,
    }));
    const threadsByTask = new Map(
      [...owners].map(
        ([taskId, list]) =>
          [taskId, list.map((node) => ({ id: node.id, live: isLive(node) }))] as const,
      ),
    );
    const shape = JSON.stringify([...threadsByTask]);
    const unchanged =
      previous !== null &&
      previous.goal === goal &&
      shape === previousShape &&
      previous.nodes.size === nodes.size &&
      [...nodes].every(([id, node]) => previous!.nodes.get(id) === node);
    if (!unchanged)
      previous = {
        status: "ready",
        goal,
        count: countGoalTasks(goal.tasks),
        nodes,
        threadsByTask:
          previous !== null && shape === previousShape ? previous.threadsByTask : threadsByTask,
      };
    previousShape = shape;
    return previous!;
  }).pipe(Atom.withLabel(`loom-goal-tasks-view:${key}`));
});

// The tab's state, per workstream. In memory only, beside the Graph's folds and scroll offset.

export type WorkstreamTab = "graph" | "tasks";

export interface WorkstreamTasksState {
  /** Null until chosen: the screen then opens on Graph with sub-threads, else on Tasks. */
  readonly tab: WorkstreamTab | null;
  readonly filter: TaskFilter;
  /** `goalTaskRows`' `toggled` keys. */
  readonly toggled: ReadonlySet<string>;
  /** The task arrived at from a thread's header line: marked, and scrolled to once while `scroll`. */
  readonly focus: { readonly taskId: string; readonly scroll: boolean } | null;
}

const INITIAL_TASKS_STATE: WorkstreamTasksState = {
  tab: null,
  filter: "todo",
  toggled: new Set<string>(),
  focus: null,
};

/** Keyed by `workstreamKey(environmentId, rootId)`. */
export const workstreamTasksStateAtom = Atom.family((_key: string) =>
  Atom.make<WorkstreamTasksState>(INITIAL_TASKS_STATE).pipe(Atom.keepAlive),
);

/**
 * Opens the workstream on Tasks, from the Home count or the line under a sub-thread's header.
 * With `taskId`: unfolds to it, switches to All when it is finished, and focuses it.
 */
export function openWorkstreamTasks(
  environmentId: EnvironmentId,
  rootThreadId: ThreadId,
  options: { readonly split: boolean; readonly taskId?: string | null },
) {
  const key = workstreamKey(environmentId, rootThreadId);
  const state = appAtomRegistry.get(workstreamTasksStateAtom(key));
  const view = appAtomRegistry.get(goalTasksViewAtom(key));
  const taskId = options.taskId ?? null;
  const tasks = view.status === "ready" ? view.goal.tasks : [];
  appAtomRegistry.set(
    workstreamTasksStateAtom(key),
    taskId === null
      ? { ...state, tab: "tasks", focus: null }
      : {
          tab: "tasks",
          filter:
            view.status === "ready" && finishedTaskIds(tasks, view.threadsByTask).has(taskId)
              ? "all"
              : state.filter,
          toggled: unfoldTo(tasks, taskId, state.toggled),
          focus: { taskId, scroll: true },
        },
  );
  openWorkstream(environmentId, rootThreadId, { split: options.split });
}

// The breadcrumb and header button on a thread screen

export interface WorkstreamCrumb {
  readonly rootId: ThreadId;
  readonly rootTitle: string;
  /** Sub-threads waiting on a human (the badge's `N!`). */
  readonly flagged: number;
  /** The thread is the root itself (header button, no breadcrumb). */
  readonly isRoot: boolean;
  /** The root's goal has a task, so the screen has a Tasks tab. */
  readonly hasTasks: boolean;
  /** The task this thread is on, or null. */
  readonly task: { readonly id: string; readonly text: string } | null;
}

/**
 * The workstream a thread belongs to, keyed by `workstreamKey(environmentId, threadId)`: a
 * sub-thread's root, or the thread itself when it has sub-threads or its goal has a task. Null
 * otherwise.
 */
export const workstreamCrumbAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = parseWorkstreamKey(key);
  let previous: WorkstreamCrumb | null = null;
  return Atom.make((get): WorkstreamCrumb | null => {
    const index = get(workstreamEnvironmentIndexAtom(environmentId));
    const thread = index?.threadsById.get(threadId);
    const rootId = thread?.lineage.rootThreadId ?? threadId;
    const root = index?.threadsById.get(rootId);
    let next: WorkstreamCrumb | null = null;
    if (thread && root) {
      const goalOf = (goalId: GoalId | null | undefined) =>
        goalId ? (get(loomGoalAtoms.goalAtom(environmentId, goalId)) ?? null) : null;
      const badge = get(workstreamBadgesAtom(environmentId)).get(rootId);
      const hasTasks = (goalOf(root.workstream?.goalId)?.tasks.length ?? 0) > 0;
      const anchorTaskId = thread.workstream?.anchorTaskId;
      const task = anchorTaskId
        ? findGoalTask(goalOf(thread.workstream?.goalId)?.tasks ?? [], anchorTaskId)
        : null;
      if ((badge?.total ?? 0) > 0 || hasTasks)
        next = {
          rootId,
          rootTitle: root.title,
          flagged: badge?.flagged ?? 0,
          isRoot: rootId === threadId,
          hasTasks,
          task: task && { id: task.id, text: task.text },
        };
    }
    if (!sameValue(previous, next)) previous = next;
    return previous;
  }).pipe(Atom.withLabel(`loom-workstream-crumb:${key}`));
});
