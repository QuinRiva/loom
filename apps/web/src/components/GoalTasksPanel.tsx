/**
 * Right-panel surface rendering a goal's task tree from the DB-authoritative
 * orchestration store (kept current by the agent via the `t3 goal task ...` CLI
 * or by the user). The goal's title and description live here — edit-in-place
 * and readable alongside the tasks.
 */
import { type EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { TaskTree, countGoalTasks, useGoalById } from "../goals/goalState";
import type { GoalShell } from "../types";
import { goalEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

// Editable goal surface: title/description are edit-in-place controlled inputs
// that commit via `goal.meta.update` (no Approve button — an untouched goal
// simply keeps its auto-created interpretation). Title commits on blur; Enter
// blurs/commits; Escape reverts; an empty title reverts. Description commits on
// blur when changed.
function GoalHeader({ goal, environmentId }: { goal: GoalShell; environmentId: EnvironmentId }) {
  const updateMeta = useAtomCommand(goalEnvironment.updateMeta);
  const [titleDraft, setTitleDraft] = useState(goal.title);
  const [descriptionDraft, setDescriptionDraft] = useState(goal.description);
  useEffect(() => setTitleDraft(goal.title), [goal.title]);
  useEffect(() => setDescriptionDraft(goal.description), [goal.description]);
  const progress = countGoalTasks(goal.tasks);

  const dispatchGoalMeta = (fields: { title?: string; description?: string }) =>
    void updateMeta({ environmentId, input: { goalId: goal.id, ...fields } });

  const commitTitle = () => {
    const next = titleDraft.trim();
    if (next.length === 0) {
      setTitleDraft(goal.title);
      return;
    }
    if (next !== goal.title) dispatchGoalMeta({ title: next });
  };
  const commitDescription = () => {
    if (descriptionDraft !== goal.description) dispatchGoalMeta({ description: descriptionDraft });
  };

  return (
    <div className="mb-3 border-b border-border/60 pb-3">
      <div className="flex items-start justify-between gap-3">
        <input
          value={titleDraft}
          onChange={(event) => setTitleDraft(event.target.value)}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              setTitleDraft(goal.title);
              event.currentTarget.blur();
            }
          }}
          aria-label="Goal title"
          title={goal.title || goal.slug}
          placeholder={goal.slug}
          className="min-w-0 flex-1 truncate bg-transparent text-sm font-semibold text-foreground outline-none focus:rounded-sm focus:bg-accent focus:px-1"
        />
        <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {progress.done}/{progress.total}
        </span>
      </div>
      <textarea
        value={descriptionDraft}
        onChange={(event) => setDescriptionDraft(event.target.value)}
        onBlur={commitDescription}
        aria-label="Goal description"
        placeholder={"Describe this goal\u2026"}
        rows={1}
        className="mt-2 min-h-0 w-full resize-none bg-transparent text-xs leading-relaxed text-muted-foreground outline-none field-sizing-content focus:rounded-sm focus:bg-accent focus:px-1"
      />
    </div>
  );
}

export function GoalTasksPanel({
  goalId,
  environmentId,
}: {
  goalId: string | null;
  environmentId: EnvironmentId | null;
}) {
  const goal = useGoalById(goalId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {!goalId ? (
        <p className="text-sm text-muted-foreground/70">This session is not bound to a goal.</p>
      ) : !goal || !environmentId ? (
        <p className="text-sm text-muted-foreground/70">Missing goal: {goalId}</p>
      ) : (
        <>
          <GoalHeader goal={goal} environmentId={environmentId} />
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
