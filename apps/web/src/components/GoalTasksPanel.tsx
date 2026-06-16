/**
 * Read-only right-panel surface rendering a goal's `## Tasks` tree from the
 * live file-centric goal index. The file (maintained by pi/the user) is the
 * source of truth; this panel only renders, polling `/api/goals` for updates.
 */
import { TaskTree, useGoalIndex } from "../goals/goalIndex";

export function GoalTasksPanel({ goalSlug }: { goalSlug: string | null }) {
  const goal = useGoalIndex().data?.find((entry) => entry.slug === goalSlug);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {!goalSlug ? (
        <p className="text-sm text-muted-foreground/70">This session is not bound to a goal.</p>
      ) : !goal ? (
        <p className="text-sm text-muted-foreground/70">Missing goal package: {goalSlug}</p>
      ) : (
        <>
          <div className="mb-3 flex items-start justify-between gap-3">
            <h2 className="min-w-0 truncate text-sm font-semibold text-foreground">
              {goal.title || goal.slug}
            </h2>
            <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
              {goal.progress.done}/{goal.progress.total}
            </span>
          </div>
          {goal.tasks.length > 0 ? (
            <TaskTree tasks={goal.tasks} />
          ) : (
            <p className="text-sm text-muted-foreground/70">No ## Tasks items yet.</p>
          )}
        </>
      )}
    </div>
  );
}
