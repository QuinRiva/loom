/**
 * `mcp__t3-code__workstream_list`: the caller's whole tree (`workstreamTreeView`)
 * rendered, then the spawn catalogue.
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
import type { WorkstreamCaller } from "../authorisation.ts";
import { spawnCatalogue } from "../modelSelection.ts";
import { renderWorkstreamList } from "../render.ts";
import { asToolError, requireShell } from "./shared.ts";

const flatten = (tasks: ReadonlyArray<LoomGoalTask>): ReadonlyArray<LoomGoalTask> =>
  tasks.flatMap((task) => [task, ...flatten(task.children)]);

export type WorkstreamTreeThread = OrchestrationV2ThreadShell & {
  readonly workstream: LoomThreadShellFields;
};

/**
 * The whole tree `member` belongs to (archived included) from
 * `LoomStoreV2.listWorkstreamTree`, each node joined with its V2 shell, its pi
 * session file (the provider thread's native ref) and its anchor's live task
 * text. Shells are read per tree member, not as a whole-database snapshot. A
 * root before its first Loom write is a tree of itself. Shared by
 * `workstream_list` and the `/retro` launcher's manifest.
 */
export const workstreamTreeView = Effect.fn("LoomToolkit.workstreamTreeView")(function* (
  member: OrchestrationV2ThreadShell,
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
  const sessionPaths = new Map<ThreadId, string>(
    (yield* Effect.forEach(
      threads,
      (thread) =>
        Effect.map(
          orchestrator.getThreadRecords(thread.id, ["providerThreads"]),
          ({ providerThreads }) => {
            const native = providerThreads.findLast(
              (providerThread) => providerThread.driver === "pi",
            )?.nativeThreadRef?.nativeId;
            return native == null ? [] : [[thread.id, native] as const];
          },
        ),
      { concurrency: 8 },
    )).flat(),
  );
  const goals = yield* Effect.forEach(
    new Set(
      threads.flatMap(({ workstream }) => (workstream.goalId === null ? [] : [workstream.goalId])),
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
  _input: unknown,
  caller: WorkstreamCaller,
) {
  const { threads, sessionPaths, anchorTexts } = yield* asToolError(
    workstreamTreeView(yield* requireShell(caller.threadId)),
  );
  return renderWorkstreamList({
    callerId: caller.threadId,
    threads,
    sessionPaths,
    anchorTexts,
    ...(yield* spawnCatalogue),
  });
});
