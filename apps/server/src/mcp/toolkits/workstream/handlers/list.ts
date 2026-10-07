/**
 * `mcp__t3-code__workstream_list`: the caller's whole tree (archived included) from
 * `LoomStoreV2.listWorkstreamTree`, each node joined with its V2 shell, its pi
 * session file (the provider thread's native ref) and its anchor's live task
 * text, then the spawn catalogue. Shells are read per tree member, not as a
 * whole-database snapshot.
 *
 * @module mcp/toolkits/workstream/handlers/list
 */
import type { GoalTaskId, LoomGoalTask, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import { spawnCatalogue } from "../modelSelection.ts";
import { renderWorkstreamList, type WorkstreamListThread } from "../render.ts";
import { asToolError, requireShell } from "./shared.ts";

const flatten = (tasks: ReadonlyArray<LoomGoalTask>): ReadonlyArray<LoomGoalTask> =>
  tasks.flatMap((task) => [task, ...flatten(task.children)]);

export const workstreamList = Effect.fn("LoomToolkit.workstreamList")(function* (
  _input: unknown,
  caller: WorkstreamCaller,
) {
  const store = yield* LoomStore.LoomStoreV2;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const self = yield* requireShell(caller.threadId);
  const rootThreadId = self.workstream?.rootThreadId ?? self.lineage.rootThreadId;
  const rows = yield* asToolError(
    store.listWorkstreamTree(rootThreadId, { includeArchived: true }),
  );
  const shells = yield* asToolError(
    Effect.forEach(rows, (row) => orchestrator.getThreadShell(row.threadId), {
      concurrency: 8,
    }),
  );
  const threads: ReadonlyArray<WorkstreamListThread> =
    rows.length > 0
      ? shells.flatMap((shell) =>
          shell?.workstream === undefined ? [] : [{ ...shell, workstream: shell.workstream }],
        )
      : // A root before its first Loom write: just the caller.
        [
          {
            ...self,
            workstream: {
              ...LoomStore.emptyWorkstream({
                threadId: caller.threadId,
                projectId: self.projectId,
                parentThreadId: null,
                rootThreadId: caller.threadId,
                at: DateTime.formatIso(self.createdAt),
              }),
              consults: [],
              peerMessages: [],
              toolCalls: 0,
              contextUsage: null,
            },
          },
        ];
  const sessionPaths = new Map<ThreadId, string>(
    yield* asToolError(
      Effect.forEach(
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
      ),
    ).pipe(Effect.map((entries) => entries.flat())),
  );
  const goals = yield* asToolError(
    Effect.forEach(
      new Set(
        threads.flatMap(({ workstream }) =>
          workstream.goalId === null ? [] : [workstream.goalId],
        ),
      ),
      (goalId) => store.goals.get(goalId),
    ),
  );
  const anchorTexts = new Map<GoalTaskId, string>(
    goals.flatMap((goal) =>
      flatten(goal?.tasks ?? []).map((task) => [task.id, task.text] as const),
    ),
  );
  return renderWorkstreamList({
    callerId: caller.threadId,
    threads,
    sessionPaths,
    anchorTexts,
    ...(yield* spawnCatalogue),
  });
});
