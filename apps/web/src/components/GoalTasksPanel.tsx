/**
 * The Goal surface: the single place a goal is managed, always anchored to the
 * open thread's goal (there is no goal switcher, no goals list, and no way to
 * open a goal other than through a thread that carries it — see
 * plans/sidebar-v2-rehome/plan.mdx).
 *
 * It renders the goal's task tree from the DB-authoritative orchestration store
 * (kept current by the agent via the `t3 goal task ...` CLI or by the user), the
 * goal's edit-in-place title/description, the goal's threads in handoff order,
 * and goal CRUD behind the overflow menu.
 */
import { type EnvironmentId } from "@t3tools/contracts";
import { MoreHorizontalIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { TaskTree, countGoalTasks, useGoalById } from "../goals/goalState";
import { GoalThreadsSection } from "../loom/GoalThreadsSection";
import { useGoalPanelActions } from "../loom/useGoalPanelActions";
import type { GoalShell, SidebarThreadSummary } from "../types";

/** Everything the goal surface needs from the thread it is anchored to. */
type GoalPanelThread = Pick<SidebarThreadSummary, "id" | "projectId" | "branch" | "worktreePath">;
import { goalEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Decides what a blur (commit) should do for an edit-in-place field, given the
 * current draft, the authoritative server value, and whether the user actually
 * edited this field during the focus session.
 *
 * - `emptyReverts` (title): an empty draft is a revert, never a commit.
 * - No local edits ⇒ resync to the server value. This is the fix: an external
 *   goal update that arrived while the field was focused (and therefore was not
 *   applied to the draft) is picked up on blur instead of the stale draft being
 *   committed back over it.
 * - A genuine, changed edit ⇒ commit it (last write wins for an active editor).
 * - An edit that ends up equal to the server value ⇒ resync (no-op dispatch).
 *
 * `dispatch` non-null ⇒ send that value and keep the draft; null ⇒ set the
 * draft back to `serverValue`.
 */
export function resolveEditBlur(params: {
  draft: string;
  serverValue: string;
  dirty: boolean;
  emptyReverts: boolean;
}): { dispatch: string | null } {
  const { draft, serverValue, dirty, emptyReverts } = params;
  const candidate = emptyReverts ? draft.trim() : draft;
  if (emptyReverts && candidate.length === 0) return { dispatch: null };
  if (!dirty) return { dispatch: null };
  return candidate !== serverValue ? { dispatch: candidate } : { dispatch: null };
}

// Editable goal surface: title/description are edit-in-place controlled inputs
// that commit via `goal.meta.update` (no Approve button — an untouched goal
// simply keeps its auto-created interpretation). Title commits on blur; Enter
// blurs/commits; Escape reverts; an empty title reverts. Description commits on
// blur when changed.
//
// Edit-session write policy (tier-4 state, corrected writer): while a field is
// focused, an external goal update must not overwrite the in-flight draft —
// otherwise a server-side `goal update` clobbers what the user is typing. The
// resync effects are therefore focus-guarded (they only apply server changes
// while the field is blurred), and blur reconciles via `resolveEditBlur`.
// Drafts stay component-local by design: persisting them would resurrect stale
// edits across reloads.
function GoalHeader({
  goal,
  environmentId,
  onOpenOverflow,
}: {
  goal: GoalShell;
  environmentId: EnvironmentId;
  onOpenOverflow: (position: { x: number; y: number }) => void;
}) {
  const updateMeta = useAtomCommand(goalEnvironment.updateMeta);
  const [titleDraft, setTitleDraft] = useState(goal.title);
  const [descriptionDraft, setDescriptionDraft] = useState(goal.description);
  const titleFocusedRef = useRef(false);
  const descriptionFocusedRef = useRef(false);
  const titleDirtyRef = useRef(false);
  const descriptionDirtyRef = useRef(false);
  // Apply external goal updates to the draft only while the field is blurred; a
  // focused field keeps the user's in-flight draft (blur reconciles).
  useEffect(() => {
    if (!titleFocusedRef.current) setTitleDraft(goal.title);
  }, [goal.title]);
  useEffect(() => {
    if (!descriptionFocusedRef.current) setDescriptionDraft(goal.description);
  }, [goal.description]);
  const progress = countGoalTasks(goal.tasks);

  const dispatchGoalMeta = (fields: { title?: string; description?: string }) =>
    void updateMeta({ environmentId, input: { goalId: goal.id, ...fields } });

  const commitTitle = () => {
    titleFocusedRef.current = false;
    const { dispatch } = resolveEditBlur({
      draft: titleDraft,
      serverValue: goal.title,
      dirty: titleDirtyRef.current,
      emptyReverts: true,
    });
    if (dispatch !== null) dispatchGoalMeta({ title: dispatch });
    else setTitleDraft(goal.title);
  };
  const commitDescription = () => {
    descriptionFocusedRef.current = false;
    const { dispatch } = resolveEditBlur({
      draft: descriptionDraft,
      serverValue: goal.description,
      dirty: descriptionDirtyRef.current,
      emptyReverts: false,
    });
    if (dispatch !== null) dispatchGoalMeta({ description: dispatch });
    else setDescriptionDraft(goal.description);
  };

  return (
    <div className="mb-3 border-b border-border/60 pb-3">
      <div className="flex items-start justify-between gap-3">
        <input
          value={titleDraft}
          onFocus={() => {
            titleFocusedRef.current = true;
            titleDirtyRef.current = false;
          }}
          onChange={(event) => {
            titleDirtyRef.current = true;
            setTitleDraft(event.target.value);
          }}
          onBlur={commitTitle}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              titleDirtyRef.current = false;
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
        <button
          type="button"
          aria-label="Goal actions"
          title="Goal actions"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            onOpenOverflow({ x: box.left, y: box.bottom });
          }}
          className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <MoreHorizontalIcon className="size-4" />
        </button>
      </div>
      <textarea
        value={descriptionDraft}
        onFocus={() => {
          descriptionFocusedRef.current = true;
          descriptionDirtyRef.current = false;
        }}
        onChange={(event) => {
          descriptionDirtyRef.current = true;
          setDescriptionDraft(event.target.value);
        }}
        onBlur={commitDescription}
        aria-label="Goal description"
        placeholder={"Describe this goal\u2026"}
        rows={1}
        className="mt-2 min-h-0 w-full resize-none bg-transparent text-xs leading-relaxed text-muted-foreground outline-none field-sizing-content focus:rounded-sm focus:bg-accent focus:px-1"
      />
    </div>
  );
}

function GoalPanelBody({
  goal,
  environmentId,
  activeThread,
}: {
  goal: GoalShell;
  environmentId: EnvironmentId;
  activeThread: GoalPanelThread | null;
}) {
  const { createGoalSession, openOverflowMenu } = useGoalPanelActions({
    goal,
    environmentId,
    activeThread,
  });
  return (
    <>
      <GoalHeader
        goal={goal}
        environmentId={environmentId}
        onOpenOverflow={(position) => void openOverflowMenu(position)}
      />
      {goal.tasks.length > 0 ? (
        <TaskTree tasks={goal.tasks} />
      ) : (
        <p className="text-sm text-muted-foreground/70">No tasks yet.</p>
      )}
      <GoalThreadsSection
        goalId={goal.id}
        environmentId={environmentId}
        activeThreadId={activeThread?.id ?? null}
        onCreateSession={() => void createGoalSession()}
      />
    </>
  );
}

export function GoalTasksPanel({
  goalId,
  environmentId,
  activeThread,
}: {
  goalId: string | null;
  environmentId: EnvironmentId | null;
  activeThread?: GoalPanelThread | null;
}) {
  const goal = useGoalById(goalId);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {!goalId ? (
        // The panel is always the open thread's goal, so a goal-less thread gets
        // the one hint that can change that — no goal picker, by design.
        <p className="text-sm text-muted-foreground/70">
          This thread has no goal. Right-click it in the sidebar to create a goal from it, or assign
          it to an existing one.
        </p>
      ) : !goal || !environmentId ? (
        <p className="text-sm text-muted-foreground/70">Missing goal: {goalId}</p>
      ) : (
        <GoalPanelBody
          goal={goal}
          environmentId={environmentId}
          activeThread={activeThread ?? null}
        />
      )}
    </div>
  );
}
