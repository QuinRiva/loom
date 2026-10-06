/**
 * The node rules `workstream_spawn` and `workstream_scaffold` share, ported
 * from V1's `WorkstreamSpawnHttp.ts`: the fork identity rule, the gate's routes
 * and its round cap, and the anchor a child is born with. The graph itself
 * (live siblings, cycles, graph keys) is validated by the arm under the
 * parent's lock.
 *
 * @module mcp/toolkits/workstream/handlers/childNode
 */
import {
  DEFAULT_GATE_MAX_ROUNDS,
  GoalTaskId,
  type LoomThreadWorkstream,
  MAX_GATE_MAX_ROUNDS,
  type ThreadId,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import {
  findGoalTask,
  isWithinGoalTaskBranch,
  resolveThreadAnchor,
} from "../../../../loom/goals/goalTaskTree.ts";
import { agentToolName as t } from "../families.ts";
import type { LoomToolInput } from "../defs.ts";
import { asToolError } from "./shared.ts";

type NodeInput = Omit<LoomToolInput<"workstream_spawn">, "brief" | "clientRequestId">;

/** A required text field, trimmed; undefined when blank. */
export const trimmed = (value: string | undefined) => {
  const text = value?.trim() ?? "";
  return text.length === 0 ? undefined : text;
};

/**
 * The shape errors of one node before anything is read: role/title/purpose
 * present, the fork identity rule (D2: a fork inherits its source's role and
 * model, so those fields are refused, never ignored; a fork is never gated),
 * and the gate's round cap.
 */
export const nodeShapeError = (node: NodeInput, nothing: string): string | undefined => {
  if (node.forkFrom === undefined && trimmed(node.role) === undefined)
    return `role is required. ${nothing}`;
  if (trimmed(node.title) === undefined) return `title is required. ${nothing}`;
  if (trimmed(node.purpose) === undefined) return `purpose is required. ${nothing}`;
  if (node.forkFrom !== undefined) {
    const offenders = (
      ["role", "modelSelection", "modelPreset", "taskShape", "sensitive"] as const
    ).filter((field) => node[field] !== undefined);
    if (offenders.length > 0) {
      const one = offenders.length === 1;
      return `${offenders.join(", ")} cannot be combined with forkFrom: a fork inherits its source's launch identity (role, applied model + thinking level), so ${one ? "that field is" : "those fields are"} rejected rather than silently ignored. Remove ${one ? "it" : "them"} — the fork adopts the source's role and model. ${nothing}`;
    }
    if (node.gate !== undefined)
      return `gate and forkFrom cannot be combined: a forked child is a normal worker that inherits the source's session, not a gated reviewer. Drop one. ${nothing}`;
  }
  const maxRounds = node.gate?.maxRounds;
  if (maxRounds !== undefined && (maxRounds < 1 || maxRounds > MAX_GATE_MAX_ROUNDS))
    return `gate.maxRounds must be an integer between 1 and ${MAX_GATE_MAX_ROUNDS}. Each round is a full rework + re-review cycle; if you expect to need more than a few, the work should be re-scoped instead of looped. ${nothing}`;
  return undefined;
};

/** A gate on the reviewer: `needs_rework` loops the target, `clean`/`fixed_inline` resolve. */
export const gateRoutes = (
  rework: ThreadId,
  maxRounds: number | undefined,
): ReadonlyArray<WorkstreamRoute> => [
  {
    on: ["needs_rework"],
    kind: "loop",
    to: rework,
    maxRounds: maxRounds ?? DEFAULT_GATE_MAX_ROUNDS,
  },
  { on: ["clean", "fixed_inline"], kind: "resolve" },
];

/**
 * `blockedBy` with the implied edges appended — a gated reviewer waits for the
 * work it reviews, a fork for its source — and a warning per edge added.
 */
export const withImpliedEdges = (input: {
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly gateRework: ThreadId | undefined;
  readonly forkFrom: ThreadId | undefined;
}) => {
  const blockedBy = [...new Set(input.blockedBy)];
  const warnings: Array<string> = [];
  if (input.gateRework !== undefined && !blockedBy.includes(input.gateRework)) {
    blockedBy.push(input.gateRework);
    warnings.push(
      `gate.rework ${input.gateRework} was added to blockedBy automatically — a gated reviewer always waits for the thread it reviews.`,
    );
  }
  if (input.forkFrom !== undefined && !blockedBy.includes(input.forkFrom)) {
    blockedBy.push(input.forkFrom);
    warnings.push(
      `forkFrom ${input.forkFrom} was added to blockedBy automatically — a fork waits for its source thread to finish before it launches.`,
    );
  }
  return { blockedBy, warnings };
};

/**
 * Validates explicit anchors against the spawner's goal tree: each must be a
 * live task and, when the spawner is itself anchored, inside its branch.
 * Returns the error text or undefined.
 */
export const anchorError = Effect.fn("LoomToolkit.anchorError")(function* (
  spawner: LoomThreadWorkstream | null,
  requested: ReadonlyArray<string>,
  nothing: string,
) {
  if (requested.length === 0) return undefined;
  if (spawner?.goalId == null)
    return `anchorTaskId was passed, but this thread has no active goal — there is no task tree to anchor a child into. Omit anchorTaskId; the child is then unbound and works from its brief. ${nothing}`;
  const store = yield* LoomStore.LoomStoreV2;
  const tasks = yield* asToolError(store.tasks.listByGoal(spawner.goalId));
  const ownAnchor = resolveThreadAnchor(tasks, spawner.anchorTaskId);
  for (const raw of requested) {
    const id = GoalTaskId.make(raw);
    const task = findGoalTask(tasks, id);
    if (task === null)
      return `anchorTaskId ${id} is not a live task of this thread's goal. Pass the id shown in the trailing "(id)" of a task line from ${t("goal_task_list")} — add the task first with ${t("goal_task_add")} if it does not exist yet, or omit anchorTaskId to leave the child unbound. ${nothing}`;
    if (ownAnchor !== null && !isWithinGoalTaskBranch(ownAnchor, id))
      return `anchorTaskId ${id} ("${task.text}") is outside the branch you own. You are anchored to ${ownAnchor.id} ("${ownAnchor.text}"), and a thread may only delegate within its own branch: pass that task or one of its descendants, or omit anchorTaskId to leave the child unbound. Work you discovered elsewhere in the tree is RECORDED with ${t("goal_task_add")} and re-homed by the orchestrator that owns the shape, not delegated from here. ${nothing}`;
  }
  return undefined;
});
