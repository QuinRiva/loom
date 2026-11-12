/**
 * `mcp__t3-code__workstream_request_attention`: raises a hold on the caller or a direct child; the
 * arm refuses a finished thread (DL-228) and the server-only reasons. A thread's own approval hold
 * is its held hand-back, so it may not raise `awaiting_acceptance` on itself.
 *
 * @module mcp/toolkits/workstream/handlers/attention
 */
import * as Effect from "effect/Effect";

import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { dispatch, fail, nowIso } from "./shared.ts";

export const workstreamRequestAttention = Effect.fn("LoomToolkit.workstreamRequestAttention")(
  function* (input: LoomToolInput<"workstream_request_attention">, caller: WorkstreamCaller) {
    const threadId = (yield* authoriseTarget(caller, input.threadId))?.threadId ?? caller.threadId;
    if (input.reason === "awaiting_acceptance" && threadId === caller.threadId)
      return yield* fail(
        "A thread does not raise `awaiting_acceptance` on itself: no report would be recorded and your parent would not be told. Hand finished work back with `mcp__t3-code__workstream_submit` and outcome `awaiting_acceptance`; if you cannot proceed at all, the reason is `needs_guidance`.",
      );
    yield* dispatch({
      type: "thread.attention.raise",
      commandId: stableCommandId(caller, yield* requestKey(undefined), "workstream-attention"),
      threadId,
      createdAt: yield* nowIso,
      reason: input.reason,
    });
    return `Flagged Workstream thread ${threadId} for attention: ${input.reason}.`;
  },
);
