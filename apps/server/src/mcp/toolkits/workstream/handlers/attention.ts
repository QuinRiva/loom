/**
 * `mcp__t3-code__workstream_request_attention`: raises a hold on the caller or a direct
 * child through `thread.attention.raise`; the arm refuses a finished thread
 * (DL-228) and the server-only reasons.
 *
 * @module mcp/toolkits/workstream/handlers/attention
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { dispatch, nowIso } from "./shared.ts";

export const workstreamRequestAttention = Effect.fn("LoomToolkit.workstreamRequestAttention")(
  function* (input: LoomToolInput<"workstream_request_attention">, caller: WorkstreamCaller) {
    const threadId =
      input.threadId === undefined ? caller.threadId : ThreadId.make(input.threadId.trim());
    yield* authoriseTarget(caller, threadId);
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
