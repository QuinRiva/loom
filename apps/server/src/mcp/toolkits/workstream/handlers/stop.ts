/**
 * `workstream_stop`: the parent pauses a direct child by interrupting its
 * active run (`run.interrupt`, holding its queue as V1's stop did). The
 * `server:` command id is what tells Loom's arm this is not a human stop, so
 * no `needs_guidance` is raised (`loomHumanStopRaise`, DL-304): the parent owns
 * the resume.
 *
 * @module mcp/toolkits/workstream/handlers/stop
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey } from "../idempotency.ts";
import { dispatch, fail, requireShell } from "./shared.ts";

export const workstreamStop = Effect.fn("LoomToolkit.workstreamStop")(function* (
  input: LoomToolInput<"workstream_stop">,
  caller: WorkstreamCaller,
) {
  const threadId = ThreadId.make(input.threadId.trim());
  if (threadId === caller.threadId)
    return yield* fail(`${t("workstream_stop")} pauses a direct child, not the calling thread.`);
  yield* authoriseTarget(caller, threadId);
  const { activeRunId } = yield* requireShell(threadId);
  if (activeRunId === null)
    return `Workstream child ${threadId} has no active turn; nothing was stopped.`;
  yield* dispatch({
    type: "run.interrupt",
    commandId: CommandId.make(`server:workstream-stop:${threadId}:${yield* requestKey(undefined)}`),
    threadId,
    runId: activeRunId,
    reason: "Paused by its parent orchestrator.",
    holdQueue: true,
  });
  return `Stopped Workstream child ${threadId} (paused; it stays in progress — resume it with ${t("workstream_prompt")}).`;
});
