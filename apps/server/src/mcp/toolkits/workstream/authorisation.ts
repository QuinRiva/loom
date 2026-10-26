/**
 * The acting thread is always the credential's own, never a parameter; a target is that thread or
 * one it directly parents. Registration requires the caller for every tool, so a handler cannot
 * forget it. Goal-tool branch scoping lives in `loom/goals/goalTaskTree.ts`.
 */
import type { LoomThreadWorkstream, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../loom/projection/LoomStore.ts";
import { resolveThreadRef } from "../../../loom/workstream/threadResolve.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { LoomToolError } from "./defs.ts";

export interface WorkstreamCaller {
  readonly scope: McpInvocationContext.McpThreadInvocationScope;
  readonly threadId: ThreadId;
}

const fail = (message: string) => Effect.fail(new LoomToolError({ message }));

/** A consult fork's credential: the target's thread with a read-only client beside it. */
export const isReadOnlyCaller = (scope: McpInvocationContext.McpInvocationScope) =>
  scope.client?.access === "read-only";

/** The only Loom tools a read-only caller may run; everything else changes state. */
export const CONSULT_READ_TOOLS: ReadonlySet<string> = new Set([
  "workstream_list",
  "goal_task_list",
]);

/**
 * A query thread's Loom tools: the reads, a consult of the live author, its own title, and the
 * one write it exists for, `document_query_promote` (slice 2; listing it before it is registered
 * is harmless). Everything else is the author's to do.
 */
export const DOCUMENT_QUERY_TOOLS: ReadonlySet<string> = new Set([
  ...CONSULT_READ_TOOLS,
  "consult_thread",
  "set_thread_title",
  "document_query_promote",
]);

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
 * The caller's own thread (default) or a live thread it directly parents, resolved by
 * `resolveThreadRef`. Returns the sidecar row, null only for the caller with none yet, so read the
 * target id as `row?.threadId ?? caller.threadId`.
 */
export const authoriseTarget = Effect.fn("LoomToolkit.authoriseTarget")(function* (
  caller: WorkstreamCaller,
  targetRef?: string,
) {
  const store = yield* LoomStore.LoomStoreV2;
  const targetThreadId =
    targetRef === undefined
      ? caller.threadId
      : resolveThreadRef(
          targetRef,
          new Set([
            caller.threadId,
            ...(yield* store
              .listChildren(caller.threadId, { includeArchived: true })
              .pipe(mapStoreError)).map((child) => child.threadId),
          ]),
        );
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
