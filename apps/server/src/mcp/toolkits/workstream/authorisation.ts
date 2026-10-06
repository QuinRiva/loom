/**
 * Who may act through Loom's tools, and on what. The acting thread is always
 * the credential's own thread (never a parameter); a target is that thread or
 * one it directly parents (V1's D3 rule). Branch scoping for the goal tools
 * lives with the tree helpers (`loom/goals/goalTaskTree.ts`). Registration requires the caller for every tool,
 * so a handler cannot forget it.
 *
 * @module mcp/toolkits/workstream/authorisation
 */
import type { LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../loom/projection/LoomStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LoomToolError } from "./defs.ts";

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
