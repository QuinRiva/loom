/**
 * The four task-tree tools on the caller's active goal, written through
 * `LoomStoreV2.tasks` (every write returns the live tree) and published on
 * `LoomGoalBroadcast` once per write. Ownership: the thread that owns the goal
 * (a root) owns the whole tree; an anchored thread owns its branch — it reads
 * the branch by default, adds there by default, ticks and renames only there,
 * and rewrites exactly the branch; an unanchored child may read and add but
 * never rewrite. Ported from V1's `GoalTaskHttp.ts`.
 *
 * @module mcp/toolkits/workstream/handlers/goalTasks
 */
import { GoalTaskId, type LoomGoalTask, type LoomThreadWorkstream } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  parseGoalTaskMarkdown,
  resolveGoalTaskRewrite,
  validateGoalTaskRewriteText,
  validateGoalTaskText,
} from "../../../../loom/goals/goalTaskMarkdown.ts";
import {
  renderGoalTaskBranch,
  renderGoalTaskEcho,
  renderTasks,
} from "../../../../loom/goals/goalTaskRender.ts";
import {
  composeBranchRewrite,
  findGoalTask,
  flattenGoalTasks,
  goalTaskSpine,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
} from "../../../../loom/goals/goalTaskTree.ts";
import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { createdUuid } from "../idempotency.ts";
import { asToolError, fail, publishGoal, requireActiveGoal } from "./shared.ts";

const tasksStore = Effect.map(LoomStore.LoomStoreV2, (store) => store.tasks);

/** The write's echo, scoped to what the caller owns; the write itself is already published. */
const echo = (
  row: LoomThreadWorkstream,
  tasks: ReadonlyArray<LoomGoalTask>,
  summary: string,
  placedTaskId?: GoalTaskId,
) =>
  renderGoalTaskEcho({
    summary,
    tasks,
    anchorTaskId: row.anchorTaskId,
    isChild: row.parentThreadId !== null,
    ...(placedTaskId === undefined ? {} : { placedTaskId }),
  });

export const goalTaskList = Effect.fn("LoomToolkit.goalTaskList")(function* (
  input: LoomToolInput<"goal_task_list">,
  caller: WorkstreamCaller,
) {
  const { goal, row } = yield* requireActiveGoal(caller.threadId);
  const anchor = input.scope === "tree" ? null : resolveThreadAnchor(goal.tasks, row.anchorTaskId);
  return anchor === null
    ? renderTasks(goal.tasks)
    : renderGoalTaskBranch(anchor, goalTaskSpine(goal.tasks, anchor.id));
});

export const goalTaskAdd = Effect.fn("LoomToolkit.goalTaskAdd")(function* (
  input: LoomToolInput<"goal_task_add">,
  caller: WorkstreamCaller,
) {
  const text = input.text.trim();
  if (text.length === 0) return yield* fail("text is required.");
  const textError = validateGoalTaskText(text);
  if (textError !== undefined) return yield* fail(textError);
  const { goal, row } = yield* requireActiveGoal(caller.threadId);
  // Lands in the caller's branch unless it says otherwise; any task of the goal
  // is a legal explicit parent, so discovered work is recorded where it belongs.
  const parentRef = input.parentTaskId?.trim();
  const parentTaskId =
    parentRef === undefined || parentRef.length === 0
      ? (resolveThreadAnchor(goal.tasks, row.anchorTaskId)?.id ?? null)
      : GoalTaskId.make(parentRef);
  const siblings =
    parentTaskId === null ? goal.tasks : (findGoalTask(goal.tasks, parentTaskId)?.children ?? null);
  if (siblings === null)
    return yield* fail(`parentTaskId "${parentRef}" is not a task in this goal.`);

  const taskId = GoalTaskId.make(
    yield* createdUuid(caller, input.clientRequestId, "goal_task_add"),
  );
  // A retried add whose task already exists writes nothing (it may have been edited since).
  const tasks =
    findGoalTask(goal.tasks, taskId) !== null
      ? goal.tasks
      : yield* asToolError(
          Effect.flatMap(tasksStore, (store) =>
            store.upsert({
              goalId: goal.id,
              id: taskId,
              parentTaskId,
              text,
              done: false,
              position: Math.max(-1, ...siblings.map((task) => task.position)) + 1,
            }),
          ),
        ).pipe(Effect.tap(() => publishGoal(goal.id)));
  return echo(row, tasks, `Added task ${taskId}: ${text}`, taskId);
});

export const goalTaskUpdate = Effect.fn("LoomToolkit.goalTaskUpdate")(function* (
  input: LoomToolInput<"goal_task_update">,
  caller: WorkstreamCaller,
) {
  const { goal, row } = yield* requireActiveGoal(caller.threadId);
  const taskId = GoalTaskId.make(input.taskId.trim());
  const task = findGoalTask(goal.tasks, taskId);
  if (task === null) return yield* fail(`taskId "${taskId}" is not a task in this goal.`);
  // Ticking a sibling thread's task is the misfire branch scoping prevents.
  const anchor = resolveThreadAnchor(goal.tasks, row.anchorTaskId);
  if (anchor !== null && !isWithinGoalTaskBranch(anchor, taskId))
    return yield* fail(
      `Task ${taskId} is outside the branch you own, rooted at your anchor "${anchor.text}" (${anchor.id}) — only the thread that owns a task ticks or renames it. Record discovered work with ${t("goal_task_add")} instead (it lands in your branch by default; pass a parentTaskId to place it elsewhere), and say what needs doing to that task in your report, or ask its thread with ${t("consult_thread")}.`,
    );
  const text = input.text?.trim();
  if (text !== undefined && text.length === 0)
    return yield* fail("text must be a non-empty string.");
  if (text === undefined && input.done === undefined)
    return yield* fail("Provide at least one of text or done.");
  const textError = text === undefined ? undefined : validateGoalTaskText(text);
  if (textError !== undefined) return yield* fail(textError);

  const tasks = yield* asToolError(
    Effect.flatMap(tasksStore, (store) =>
      store.upsert({
        goalId: goal.id,
        id: task.id,
        parentTaskId: task.parentTaskId,
        text: text ?? task.text,
        done: input.done ?? task.done,
        position: task.position,
      }),
    ),
  );
  yield* publishGoal(goal.id);
  return echo(row, tasks, `Updated task ${taskId}.`);
});

/**
 * Declarative replace: the submitted markdown IS the resulting tree — the
 * whole tree for the goal's owner, the branch (spliced in place) for an
 * anchored thread. All-or-nothing: parsed, scoped and resolved before the one
 * write; a verbatim resubmission writes nothing.
 */
export const goalTasksRewrite = Effect.fn("LoomToolkit.goalTasksRewrite")(function* (
  input: LoomToolInput<"goal_tasks_rewrite">,
  caller: WorkstreamCaller,
) {
  const { goal, row } = yield* requireActiveGoal(caller.threadId);
  const anchor = resolveThreadAnchor(goal.tasks, row.anchorTaskId);
  if (row.parentThreadId !== null && anchor === null)
    return yield* fail(
      `Rewrites are scoped to what a thread owns: the whole tree belongs to the thread that owns the goal, and a child may rewrite only the branch it is anchored to — this thread has a parent and no anchor. Use ${t("goal_task_add")} to record discovered work (nested under the relevant parent task) and ${t("goal_task_update")} to mark your own task done; ask your orchestrator if the tree's shape needs restructuring.`,
    );
  const current = flattenGoalTasks(goal.tasks);
  const deleted = yield* asToolError(
    Effect.flatMap(tasksStore, (store) => store.listDeleted(goal.id)),
  );
  const parsed = parseGoalTaskMarkdown(
    input.markdown,
    new Set([...current, ...deleted].map((task) => task.id)),
  );
  if ("error" in parsed) return yield* fail(parsed.error);
  // Line numbers name the SUBMITTED lines, so validate before a branch is spliced in.
  const textError = validateGoalTaskRewriteText(parsed.lines, [...current, ...deleted]);
  if (textError !== undefined) return yield* fail(textError);
  const scoped =
    anchor === null
      ? parsed
      : composeBranchRewrite({ submitted: parsed.lines, tasks: goal.tasks, anchor, deleted });
  if ("error" in scoped) return yield* fail(scoped.error);

  const minted = yield* Effect.forEach(
    scoped.lines.filter((line) => line.taskId === null),
    () => createdUuid(caller, undefined, "goal_tasks_rewrite"),
  );
  const { tasks, summary, changed } = resolveGoalTaskRewrite({
    lines: scoped.lines,
    current,
    mintTaskId: () => GoalTaskId.make(minted.shift()!),
  });
  const tree = changed
    ? yield* asToolError(
        Effect.flatMap(tasksStore, (store) => store.replaceTree(goal.id, tasks)),
      ).pipe(Effect.tap(() => publishGoal(goal.id)))
    : goal.tasks;
  return echo(row, tree, summary);
});
