/**
 * `mcp__t3-code__thread_fork`: a staged copy of THIS thread's context that diverges on its
 * own — upstream's `thread.fork` (sourcePoint `latest_stable`, same project,
 * worktree, model and modes; the native session fork resolves at the fork's
 * first run), then `thread.goal.set` and `thread.held.set true` (one of
 * `held`'s two writers, P3-19b). The fork is a ROOT in Loom's graph, not a
 * child of the caller (DL-344). Nothing runs until a human sends.
 *
 * The caller is always mid-turn when it calls this, so a mid-turn refusal
 * would refuse every call (V1 never gated creation either). The transfer is
 * pinned to the caller's last COMPLETED run, the latest one upstream can fork;
 * pi's fork then ends the session at this call rather than at that run
 * (`piThreadForkCut.loom.ts`), so the fork carries the calling turn up to and
 * including the call (O3). A thread still on its first turn has no run to pin.
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
  return `Forked this thread into staged session ${threadId} (${title}). It launches — and forks the session — on the first send; no tokens are spent until then.`;
});
