/**
 * The goal-task rules web's Tasks panel and the phone's Tasks tab must agree on: how many tasks
 * are done, and which threads own a task. Types only, so a script can load it with plain `node`.
 */
import type { GoalId, LoomGoalTask } from "@t3tools/contracts";

/** Done/total over a nested task tree. */
export function countGoalTasks(tasks: ReadonlyArray<LoomGoalTask>): {
  readonly done: number;
  readonly total: number;
} {
  return tasks.reduce(
    (acc, task) => {
      const child = countGoalTasks(task.children);
      return {
        done: acc.done + (task.done ? 1 : 0) + child.done,
        total: acc.total + 1 + child.total,
      };
    },
    { done: 0, total: 0 },
  );
}

/** What the owner rule reads of a thread; each client's thread type differs. */
export interface GoalTaskOwnerFields {
  readonly workstream:
    | { readonly goalId: GoalId | null; readonly anchorTaskId?: string | null | undefined }
    | undefined;
  readonly archived: boolean;
  /** ISO time; owners sort oldest first, so a fork sits after its source. */
  readonly createdAt: string;
}

/** Goal tasks → the non-archived threads anchored to them, oldest first. */
export function anchoredThreadsByTask<Thread>(
  threads: ReadonlyArray<Thread>,
  goalId: GoalId,
  read: (thread: Thread) => GoalTaskOwnerFields,
): ReadonlyMap<string, ReadonlyArray<Thread>> {
  const owners = threads.flatMap((thread) => {
    const { workstream, archived, createdAt } = read(thread);
    return !archived && workstream?.goalId === goalId && workstream.anchorTaskId != null
      ? [{ thread, taskId: workstream.anchorTaskId, createdAt }]
      : [];
  });
  const byTask = new Map<string, Thread[]>();
  // `sort` on the copy, not `toSorted`: the phone's JavaScript engine lacks it.
  for (const { thread, taskId } of owners.sort((a, b) => a.createdAt.localeCompare(b.createdAt)))
    byTask.set(taskId, [...(byTask.get(taskId) ?? []), thread]);
  return byTask;
}
