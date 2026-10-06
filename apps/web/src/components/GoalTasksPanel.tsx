/**
 * loom: the Goal surface (3d-3) — the single place a Loom goal is managed,
 * always anchored to the open thread's goal (`workstream.goalId`; never the
 * provider-native `/goal`, which upstream shows as its own status chip).
 *
 * It renders the goal's edit-in-place title/description, the task tree with
 * each anchored thread's chip on its task row, and the goal's root threads in
 * handoff order. Every write goes through a `loom.goal.*` ws method that
 * writes `LoomStoreV2` and publishes on the goal stream, so the panel never
 * patches local state: the edit round-trips and arrives like an agent's.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, LoomGoalShell, LoomGoalTask } from "@t3tools/contracts";
import { MoreHorizontalIcon, PlusIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { LinkifiedText } from "../loom/referenceLinks";
import { GoalThreadsSection } from "../loom/GoalThreadsSection";
import { goalTaskRewriteFor, type GoalTaskEdit } from "../loom/goalTaskEdits";
import { countGoalTasks, loomCommands, useLoomGoal } from "../loom/loomGoalState";
import { useLoomGoalActions } from "../loom/sidebarGoalActions";
import { type AnchoredThreadsByTask, anchoredThreadsByTask, TaskThreadChip } from "../loom/TaskThreadChips";
import { readLocalApi } from "../localApi";
import { useThreadShells } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Input } from "./ui/input";

/**
 * What a blur (commit) does for an edit-in-place field: commit a genuine,
 * changed edit; otherwise resync to the server value (an external update that
 * arrived while the field was focused is picked up instead of the stale draft
 * being committed back over it). `emptyReverts`: an empty draft is a revert.
 */
export function resolveEditBlur(params: {
  draft: string;
  serverValue: string;
  dirty: boolean;
  emptyReverts: boolean;
}): { dispatch: string | null } {
  const candidate = params.emptyReverts ? params.draft.trim() : params.draft;
  if (params.emptyReverts && candidate.length === 0) return { dispatch: null };
  if (!params.dirty) return { dispatch: null };
  return { dispatch: candidate !== params.serverValue ? candidate : null };
}

/** A focus-guarded edit-in-place draft: server updates apply only while blurred. */
function useEditDraft(serverValue: string, emptyReverts: boolean, commit: (value: string) => void) {
  const [draft, setDraft] = useState(serverValue);
  const focused = useRef(false);
  const dirty = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(serverValue);
  }, [serverValue]);
  return {
    value: draft,
    onFocus: () => {
      focused.current = true;
      dirty.current = false;
    },
    onChange: (event: { target: { value: string } }) => {
      dirty.current = true;
      setDraft(event.target.value);
    },
    onBlur: () => {
      focused.current = false;
      const { dispatch } = resolveEditBlur({
        draft,
        serverValue,
        dirty: dirty.current,
        emptyReverts,
      });
      if (dispatch !== null) commit(dispatch);
      else setDraft(serverValue);
    },
    revert: () => {
      dirty.current = false;
      setDraft(serverValue);
    },
  };
}

function GoalHeader({ goal, environmentId }: { goal: LoomGoalShell; environmentId: EnvironmentId }) {
  const update = useAtomCommand(loomCommands.goalUpdate);
  const { renameGoal, setArchived } = useLoomGoalActions();
  const commit = (fields: { title?: string; description?: string }) =>
    void update({ environmentId, input: { goalId: goal.id, ...fields } });
  const title = useEditDraft(goal.title, true, (value) => commit({ title: value }));
  const description = useEditDraft(goal.description, false, (value) =>
    commit({ description: value }),
  );
  const progress = countGoalTasks(goal.tasks);
  const archived = goal.archivedAt !== null;

  const openOverflow = async (position: { x: number; y: number }) => {
    const clicked = await readLocalApi()?.contextMenu.show(
      [
        { id: "rename", label: "Rename goal\u2026" },
        archived
          ? { id: "unarchive", label: "Unarchive goal" }
          : { id: "archive", label: "Archive goal" },
      ],
      position,
    );
    if (clicked === "rename") void renameGoal(environmentId, goal);
    if (clicked === "archive" || clicked === "unarchive") {
      void setArchived(environmentId, goal, clicked === "archive");
    }
  };

  return (
    <div className="mb-3 border-b border-border/60 pb-3">
      <div className="flex items-start justify-between gap-3">
        <input
          {...title}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              title.revert();
              event.currentTarget.blur();
            }
          }}
          aria-label="Goal title"
          placeholder={goal.slug}
          className="min-w-0 flex-1 truncate bg-transparent text-sm font-semibold text-foreground outline-none focus:rounded-sm focus:bg-accent focus:px-1"
        />
        {archived ? (
          <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-xs text-muted-foreground">
            Archived
          </span>
        ) : null}
        <span className="shrink-0 rounded-full border border-border/70 px-2 py-0.5 text-xs tabular-nums text-muted-foreground">
          {progress.done}/{progress.total}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Goal actions"
          onClick={(event) => {
            const box = event.currentTarget.getBoundingClientRect();
            void openOverflow({ x: box.left, y: box.bottom });
          }}
        >
          <MoreHorizontalIcon />
        </Button>
      </div>
      <textarea
        {...description}
        aria-label="Goal description"
        placeholder={"Describe this goal\u2026"}
        rows={1}
        className="mt-2 min-h-0 w-full resize-none bg-transparent text-xs leading-relaxed text-muted-foreground outline-none field-sizing-content focus:rounded-sm focus:bg-accent focus:px-1"
      />
    </div>
  );
}

/** One line of new-task text; Enter submits, Escape or an empty blur cancels. */
function TaskTextInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const submit = () => (text.trim().length > 0 && text.trim() !== initial ? onSubmit(text.trim()) : onCancel());
  return (
    <Input
      size="sm"
      autoFocus
      value={text}
      placeholder={placeholder}
      onChange={(event) => setText(event.target.value)}
      onBlur={submit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submit();
        } else if (event.key === "Escape") {
          onCancel();
        }
      }}
    />
  );
}

type Editing = { readonly kind: "rename" | "add-child"; readonly taskId: string } | { readonly kind: "add-root" } | null;

function TaskTree({
  tasks,
  anchors,
  activeThreadId,
  editing,
  setEditing,
  onEdit,
}: {
  tasks: ReadonlyArray<LoomGoalTask>;
  anchors: AnchoredThreadsByTask;
  activeThreadId: string | null;
  editing: Editing;
  setEditing: (editing: Editing) => void;
  onEdit: (edit: GoalTaskEdit) => void;
}) {
  const subtree = { anchors, activeThreadId, editing, setEditing, onEdit };
  return (
    <ul className="space-y-1 pl-1 text-sm text-foreground/85">
      {tasks.map((task) => {
        const renaming = editing?.kind === "rename" && editing.taskId === task.id;
        const addingChild = editing?.kind === "add-child" && editing.taskId === task.id;
        return (
          <li key={task.id}>
            <div className="group flex items-start gap-2">
              <span className="pt-0.5">
                <Checkbox
                  checked={task.done}
                  aria-label={task.done ? "Mark not done" : "Mark done"}
                  onCheckedChange={() => onEdit({ kind: "toggle", taskId: task.id })}
                />
              </span>
              {renaming ? (
                <TaskTextInput
                  initial={task.text}
                  placeholder="Task"
                  onSubmit={(text) => {
                    setEditing(null);
                    onEdit({ kind: "rename", taskId: task.id, text });
                  }}
                  onCancel={() => setEditing(null)}
                />
              ) : (
                // Chips flow with the text so a long task wraps as one paragraph.
                <span
                  className={task.done ? "min-w-0 flex-1 text-muted-foreground line-through" : "min-w-0 flex-1"}
                  onDoubleClick={() => setEditing({ kind: "rename", taskId: task.id })}
                >
                  <LinkifiedText text={task.text} />
                  {anchors.get(task.id)?.map((thread) => (
                    <TaskThreadChip key={thread.id} thread={thread} current={thread.id === activeThreadId} />
                  ))}
                </span>
              )}
              <span className="flex shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label="Add a subtask"
                  onClick={() => setEditing({ kind: "add-child", taskId: task.id })}
                >
                  <PlusIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-tiny"
                  aria-label="Remove task"
                  onClick={() => onEdit({ kind: "remove", taskId: task.id })}
                >
                  <XIcon />
                </Button>
              </span>
            </div>
            {task.children.length > 0 || addingChild ? (
              <div className="ml-6 mt-1 border-l border-border/50 pl-3">
                <TaskTree tasks={task.children} {...subtree} />
                {addingChild ? (
                  <TaskTextInput
                    initial=""
                    placeholder="New subtask"
                    onSubmit={(text) => {
                      setEditing(null);
                      onEdit({ kind: "add", parentTaskId: task.id, text });
                    }}
                    onCancel={() => setEditing(null)}
                  />
                ) : null}
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** The panel for one goal, given every thread shell held (the preview mounts it directly). */
export function GoalPanelView({
  goal,
  thread,
  shells,
}: {
  goal: LoomGoalShell;
  thread: Pick<EnvironmentThreadShell, "id" | "environmentId">;
  shells: ReadonlyArray<EnvironmentThreadShell>;
}) {
  const rewrite = useAtomCommand(loomCommands.goalTaskRewrite);
  const anchors = useMemo(
    () => anchoredThreadsByTask(shells, goal.id, thread.environmentId),
    [shells, goal.id, thread.environmentId],
  );
  const [editing, setEditing] = useState<Editing>(null);
  const onEdit = (edit: GoalTaskEdit) => {
    const input = goalTaskRewriteFor(goal.tasks, edit);
    if (input) void rewrite({ environmentId: thread.environmentId, input: { goalId: goal.id, ...input } });
  };
  return (
    <>
      <GoalHeader goal={goal} environmentId={thread.environmentId} />
      {goal.tasks.length > 0 ? (
        <TaskTree
          tasks={goal.tasks}
          anchors={anchors}
          activeThreadId={thread.id}
          editing={editing}
          setEditing={setEditing}
          onEdit={onEdit}
        />
      ) : (
        <p className="text-sm text-muted-foreground/70">No tasks yet.</p>
      )}
      <div className="mt-2">
        {editing?.kind === "add-root" ? (
          <TaskTextInput
            initial=""
            placeholder="New task"
            onSubmit={(text) => {
              setEditing(null);
              onEdit({ kind: "add", parentTaskId: null, text });
            }}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <Button variant="ghost" size="xs" onClick={() => setEditing({ kind: "add-root" })}>
            <PlusIcon />
            Add task
          </Button>
        )}
      </div>
      <GoalThreadsSection
        goalId={goal.id}
        environmentId={thread.environmentId}
        activeThreadId={thread.id}
        shells={shells}
      />
    </>
  );
}

export default function GoalTasksPanel({ thread }: { thread: EnvironmentThreadShell | null }) {
  const goalId = thread?.source.workstream?.goalId ?? null;
  const goal = useLoomGoal(thread?.environmentId ?? null, goalId);
  const shells = useThreadShells();
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      {thread === null || goalId === null ? (
        // The panel is always the open thread's Loom goal: no goal picker, by design.
        <p className="text-sm text-muted-foreground/70">This thread has no Loom goal.</p>
      ) : goal === null ? (
        <p className="text-sm text-muted-foreground/70">Missing goal: {goalId}</p>
      ) : (
        <GoalPanelView goal={goal} thread={thread} shells={shells} />
      )}
    </div>
  );
}
