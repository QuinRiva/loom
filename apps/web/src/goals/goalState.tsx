/**
 * Store-backed access to DB-authoritative goals.
 *
 * Goals arrive via the orchestration shell stream and live in the Zustand
 * store; these selectors/components replace the old file-index polling client.
 */
import { useShallow } from "zustand/react/shallow";

import type { GoalShell, GoalTask } from "../types";
import { selectGoalsAcrossEnvironments, useStore } from "../store";

export function useGoals(): GoalShell[] {
  return useStore(useShallow(selectGoalsAcrossEnvironments));
}

export function useGoalById(goalId: string | null | undefined): GoalShell | undefined {
  return useStore((state) =>
    goalId == null ? undefined : selectGoalsAcrossEnvironments(state).find((g) => g.id === goalId),
  );
}

export function countGoalTasks(tasks: ReadonlyArray<GoalTask>): { done: number; total: number } {
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

export function TaskTree({ tasks }: { tasks: ReadonlyArray<GoalTask> }) {
  return (
    <ul className="space-y-1 pl-1 text-sm text-foreground/85">
      {tasks.map((task) => (
        <li key={task.id}>
          <div className="flex gap-2">
            <span className="shrink-0 whitespace-nowrap font-mono text-muted-foreground">
              {task.done ? "[x]" : "[ ]"}
            </span>
            <span className={task.done ? "text-muted-foreground line-through" : undefined}>
              {task.text}
            </span>
          </div>
          {task.children.length > 0 ? (
            <div className="ml-5 mt-1 border-l border-border/50 pl-3">
              <TaskTree tasks={task.children} />
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
