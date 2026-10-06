/**
 * Who may act through Loom's tools, and on what. The acting thread is always
 * the credential's own thread (never a parameter); a target is that thread or
 * one it directly parents (V1's D3 rule); a goal tool on an anchored thread is
 * scoped to its branch of the task tree (ported from V1's
 * `goalTaskAnchor.loom.ts`). Registration requires the caller for every tool,
 * so a handler cannot forget it.
 *
 * @module mcp/toolkits/workstream/authorisation
 */
import type { GoalTaskId, LoomGoalTask, LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../loom/projection/LoomStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LoomToolError } from "./defs.ts";
import { agentToolName } from "./families.ts";

export interface WorkstreamCaller {
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly threadId: ThreadId;
}

const fail = (message: string) => Effect.fail(new LoomToolError({ message }));

/** The `workstream` capability and a thread caller, or the error the agent reads. */
export const requireWorkstreamCaller = Effect.fn("LoomToolkit.requireWorkstreamCaller")(
  function* () {
    const scope = yield* McpInvocationContext.requireMcpCapability("workstream").pipe(
      Effect.mapError((error) => new LoomToolError({ message: error.message })),
    );
    if (scope.thread === undefined)
      return yield* fail(
        "Loom's workstream tools act as the calling T3 thread, so they need an agent running inside T3 Code.",
      );
    return {
      scope: scope as McpInvocationContext.McpThreadInvocationScope,
      threadId: scope.thread.threadId,
    };
  },
);

const mapStoreError = Effect.mapError(
  (error: LoomStore.LoomStoreError) => new LoomToolError({ message: error.message }),
);

/**
 * The caller's own thread (the default) or a live thread it directly parents.
 * Returns the target's sidecar row; null only for the caller's own thread when
 * it has none yet (a root before its first Loom write).
 */
export const authoriseTarget = Effect.fn("LoomToolkit.authoriseTarget")(function* (
  caller: WorkstreamCaller,
  targetThreadId: ThreadId = caller.threadId,
) {
  const store = yield* LoomStore.LoomStoreV2;
  const target = yield* store.getWorkstream(targetThreadId).pipe(mapStoreError);
  if (targetThreadId === caller.threadId) return target;
  if (target === null || target.deletedAt !== null)
    return yield* fail(`Thread ${targetThreadId} was not found.`);
  return target.parentThreadId === caller.threadId
    ? target
    : yield* fail(
        `Thread ${targetThreadId} is neither this thread nor a thread it directly parents; a workstream tool may only act on those.`,
      );
});

/**
 * The parent's children keyed by id, archived rows included (DL-211), for
 * blockedBy / gate / forkFrom validation. Pass `includeDeleted` when checking a
 * graphKey, which stays reserved after deletion (DL-223).
 */
export const siblingMap = (
  parentThreadId: ThreadId,
  options: { readonly includeDeleted?: boolean } = {},
) =>
  LoomStore.LoomStoreV2.pipe(
    Effect.flatMap((store) =>
      store.listChildren(parentThreadId, { includeArchived: true, ...options }),
    ),
    mapStoreError,
    Effect.map(
      (rows): ReadonlyMap<ThreadId, LoomThreadWorkstream> =>
        new Map(rows.map((row) => [row.threadId, row])),
    ),
  );

// ---------------------------------------------------------------------------
// Task-tree branch scoping (pure)
// ---------------------------------------------------------------------------

/** The live task with this id anywhere in the goal's tree, or null. */
export const findGoalTask = (
  tasks: ReadonlyArray<LoomGoalTask>,
  taskId: GoalTaskId,
): LoomGoalTask | null => {
  for (const task of tasks) {
    if (task.id === taskId) return task;
    const found = findGoalTask(task.children, taskId);
    if (found !== null) return found;
  }
  return null;
};

/** A thread's live anchor; null = unbound (never bound, or its task was deleted). */
export const resolveThreadAnchor = (
  tasks: ReadonlyArray<LoomGoalTask>,
  anchorTaskId: GoalTaskId | null,
): LoomGoalTask | null => (anchorTaskId === null ? null : findGoalTask(tasks, anchorTaskId));

/** Is `taskId` the anchor or one of its descendants? */
export const isWithinGoalTaskBranch = (anchor: LoomGoalTask, taskId: GoalTaskId): boolean =>
  findGoalTask([anchor], taskId) !== null;

/** The task's ancestors, outermost first — the read-only context around a branch. */
export const goalTaskSpine = (
  tasks: ReadonlyArray<LoomGoalTask>,
  taskId: GoalTaskId,
): ReadonlyArray<LoomGoalTask> => {
  const walk = (
    nodes: ReadonlyArray<LoomGoalTask>,
    ancestors: ReadonlyArray<LoomGoalTask>,
  ): ReadonlyArray<LoomGoalTask> | null => {
    for (const task of nodes) {
      if (task.id === taskId) return ancestors;
      const found = walk(task.children, [...ancestors, task]);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(tasks, []) ?? [];
};

/** One checklist line as the goal-task markdown parser yields it. */
export interface GoalTaskLine {
  readonly taskId: GoalTaskId | null;
  readonly parentIndex: number | null;
  readonly text: string;
  readonly done: boolean;
}

/**
 * A BRANCH rewrite expressed as the whole-tree rewrite the store takes: the
 * submission is exactly one top-level line carrying the anchor's id plus its
 * subtree, spliced in where the anchor sits. The anchor may be renamed or
 * ticked, never deleted or moved, and nothing outside the branch changes.
 */
export const composeBranchRewrite = (input: {
  readonly submitted: ReadonlyArray<GoalTaskLine>;
  readonly tasks: ReadonlyArray<LoomGoalTask>;
  readonly anchor: LoomGoalTask;
}):
  | { readonly lines: ReadonlyArray<GoalTaskLine & { readonly position: number }> }
  | { readonly error: string } => {
  const { submitted, tasks, anchor } = input;
  const anchorLabel = `"${anchor.text}" (${anchor.id})`;
  const roots = submitted.filter((line) => line.parentIndex === null);
  if (roots.length > 1) {
    return {
      error: `A branch rewrite submits YOUR BRANCH, not the whole tree: exactly one top-level line — your anchor ${anchorLabel} — with everything else nested beneath it (two spaces per level of nesting). You submitted ${roots.length} top-level lines. Nothing was applied.`,
    };
  }
  if (roots[0]?.taskId !== anchor.id) {
    return {
      error: `The first line of a branch rewrite must be your anchor ${anchorLabel}, keeping its "(id)": it is the root of the branch you own, so it cannot be deleted, replaced or moved — rename it or tick it in place instead. Nothing was applied.`,
    };
  }
  const outside = submitted.find(
    (line) => line.taskId !== null && !isWithinGoalTaskBranch(anchor, line.taskId),
  );
  if (outside) {
    return {
      error: `Task ${outside.taskId} ("${outside.text}") is outside the branch you own, rooted at ${anchorLabel}, so a branch rewrite cannot touch it. Record work elsewhere in the goal with ${agentToolName("goal_task_add")} (passing its parentTaskId), and ask the tree's owner to restructure anything else. Nothing was applied.`,
    };
  }

  // Re-emit the goal in document order with the submitted subtree spliced in
  // at the anchor; every line outside the branch keeps its identity and rank.
  const composed: Array<GoalTaskLine> = [];
  const spliceSubmitted = (parentIndex: number | null) => {
    const composedIndex = new Map<number, number>();
    submitted.forEach((line, index) => {
      composedIndex.set(index, composed.length);
      composed.push({
        ...line,
        parentIndex: line.parentIndex === null ? parentIndex : composedIndex.get(line.parentIndex)!,
      });
    });
  };
  const walk = (nodes: ReadonlyArray<LoomGoalTask>, parentIndex: number | null) => {
    for (const task of nodes) {
      if (task.id === anchor.id) {
        spliceSubmitted(parentIndex);
        continue;
      }
      const index = composed.length;
      composed.push({ taskId: task.id, parentIndex, text: task.text, done: task.done });
      walk(task.children, index);
    }
  };
  walk(tasks, null);

  // Positions are ranks among siblings in document order, as the parser derives them.
  const nextPosition = new Map<number, number>();
  return {
    lines: composed.map((line) => {
      const key = line.parentIndex ?? -1;
      const position = nextPosition.get(key) ?? 0;
      nextPosition.set(key, position + 1);
      return { ...line, position };
    }),
  };
};
