/**
 * `mcp__t3-code__thread_fork`: upstream's `thread.fork`, then goal set and held: a root that runs
 * only when a human sends. Always called mid-turn, so it pins the last completed run and pi cuts
 * the session at this call (`piThreadForkCut.loom.ts`); a first-turn thread has no run to pin.
 *
 * @module mcp/toolkits/workstream/handlers/fork
 */
import * as Effect from "effect/Effect";

import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId, stableThreadId } from "../idempotency.ts";
import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import { asToolError, dispatch, fail, nowIso, requireShell } from "./shared.ts";

export const threadFork = Effect.fn("LoomToolkit.threadFork")(function* (
  input: LoomToolInput<"thread_fork">,
  caller: WorkstreamCaller,
) {
  const self = yield* requireShell(caller.threadId);
  const { runs } = yield* asToolError(
    Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
      orchestrator.getThreadRecords(caller.threadId, ["runs"]),
    ),
  );
  if (!runs.some((run) => run.status === "completed" && run.checkpointId !== null))
    return yield* fail(
      "This thread has no completed turn yet, so there is no settled context to fork. Fork after this turn ends.",
    );
  const goalId = (yield* asToolError(
    Effect.flatMap(LoomStore.LoomStoreV2, (store) => store.getWorkstream(caller.threadId)),
  ))?.goalId;
  const title = input.threadTitle?.trim() || `${self.title} (fork)`;
  const key = yield* requestKey(input.clientRequestId);
  const commandId = (step: string) => stableCommandId(caller, key, `thread_fork:${step}`);
  const threadId = stableThreadId(caller, key, "thread_fork");

  yield* dispatch({
    type: "thread.fork",
    commandId: commandId("fork"),
    createdBy: "agent",
    creationSource: "mcp",
    sourceThreadId: caller.threadId,
    targetThreadId: threadId,
    sourcePoint: { type: "latest_stable" },
    title,
  });
  // A goal-less source's fork has no Loom row to hold: it stays a plain idle fork.
  if (goalId != null) {
    yield* dispatch({
      type: "thread.goal.set",
      commandId: commandId("goal-set"),
      threadId,
      createdAt: yield* nowIso,
      goalId,
    });
    yield* dispatch({
      type: "thread.held.set",
      commandId: commandId("held"),
      threadId,
      createdAt: yield* nowIso,
      held: true,
    });
  }
  return `Forked this thread into staged session ${threadId} (${title}). It launches (and forks the session) on the first send; no tokens are spent until then.`;
});
