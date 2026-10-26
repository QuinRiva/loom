/**
 * `mcp__t3-code__workstream_list`: the caller's whole tree (`workstreamTreeView`)
 * rendered, lean unless the caller asks for `detail: "full"`.
 *
 * @module mcp/toolkits/workstream/handlers/list
 */
import type {
  GoalTaskId,
  LoomGoalTask,
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import { piSessionPathOf } from "../../../../loom/prompt/childPrompt.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { renderWorkstreamList } from "../render.ts";
import { asToolError, requireShell } from "./shared.ts";

const flatten = (tasks: ReadonlyArray<LoomGoalTask>): ReadonlyArray<LoomGoalTask> =>
  tasks.flatMap((task) => [task, ...flatten(task.children)]);

export type WorkstreamTreeThread = OrchestrationV2ThreadShell & {
  readonly workstream: LoomThreadShellFields;
};

/**
 * The whole tree `member` belongs to (archived included), each node joined with its shell, pi
 * session file and anchor task text; shells are read per member, never a whole-database snapshot.
 * Shared by `workstream_list` and the `/retro` manifest; `lean` skips session and anchor reads.
 */
export const workstreamTreeView = Effect.fn("LoomToolkit.workstreamTreeView")(function* (
  member: OrchestrationV2ThreadShell,
  options: { readonly lean?: boolean } = {},
) {
  const store = yield* LoomStore.LoomStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const rootThreadId = member.workstream?.rootThreadId ?? member.lineage.rootThreadId;
  const rows = yield* store.listWorkstreamTree(rootThreadId, { includeArchived: true });
  const shells = yield* Effect.forEach(rows, (row) => orchestrator.getThreadShell(row.threadId), {
    concurrency: 8,
  });
  const threads: ReadonlyArray<WorkstreamTreeThread> =
    rows.length > 0
      ? shells.flatMap((shell) =>
          shell?.workstream === undefined ? [] : [{ ...shell, workstream: shell.workstream }],
        )
      : [
          {
            ...member,
            workstream: {
              ...LoomStore.emptyWorkstream({
                threadId: member.id,
                projectId: member.projectId,
                parentThreadId: null,
                rootThreadId: member.id,
                at: DateTime.formatIso(member.createdAt),
              }),
              consults: [],
              peerMessages: [],
              toolCalls: 0,
              contextUsage: null,
              activeStep: null,
            },
          },
        ];
  const detailed = options.lean === true ? [] : threads;
  const sessionPaths = new Map<ThreadId, string>(
    (yield* Effect.forEach(
      detailed,
      (thread) =>
        Effect.map(piSessionPathOf(thread.id), (native) =>
          native === null ? [] : [[thread.id, native] as const],
        ),
      { concurrency: 8 },
    )).flat(),
  );
  const goals = yield* Effect.forEach(
    new Set(
      detailed.flatMap(({ workstream }) => (workstream.goalId === null ? [] : [workstream.goalId])),
    ),
    (goalId) => store.goals.get(goalId),
  );
  const anchorTexts = new Map<GoalTaskId, string>(
    goals.flatMap((goal) =>
      flatten(goal?.tasks ?? []).map((task) => [task.id, task.text] as const),
    ),
  );
  return { rootThreadId, threads, sessionPaths, anchorTexts };
});

export const workstreamList = Effect.fn("LoomToolkit.workstreamList")(function* (
  input: LoomToolInput<"workstream_list">,
  caller: WorkstreamCaller,
) {
  const { threads, sessionPaths, anchorTexts } = yield* asToolError(
    workstreamTreeView(yield* requireShell(caller.threadId), { lean: input.detail !== "full" }),
  );
  return renderWorkstreamList({
    callerId: caller.threadId,
    threads,
    sessionPaths,
    anchorTexts,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
  });
});
