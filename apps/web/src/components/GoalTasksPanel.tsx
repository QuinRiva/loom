/**
 * Read-only right-panel surface rendering a goal's task tree from the
 * DB-authoritative orchestration store (kept current by the agent via the
 * `t3 goal task ...` CLI or by the user).
 */
import { TaskTree, countGoalTasks, useGoalById } from "../goals/goalState";

export function GoalTasksPanel({ goalId }: { goalId: string | null }) {
  const goal = useGoalById(goalId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {!goalId ? (
        <p className="text-sm text-muted-foreground/70">This session is not bound to a goal.</p>
      ) : !goal ? (
        <p className="text-sm text-muted-foreground/70">Missing goal: {goalId}</p>
      ) : (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {goal.title || goal.slug}
            </h2>
            <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
              {countGoalTasks(goal.tasks).done}/{countGoalTasks(goal.tasks).total}
            </span>
          </div>
          {goal.tasks.length > 0 ? (
            <TaskTree tasks={goal.tasks} />
          ) : (
            <p className="text-sm text-muted-foreground/70">No tasks yet.</p>
          )}
        </>
      )}
    </div>
  );
}
