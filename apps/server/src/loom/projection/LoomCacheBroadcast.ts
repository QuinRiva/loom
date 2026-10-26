/**
 * Facts a client needs to say when a thread's prompt cache goes cold (request start/end, idle
 * pings, the warmer's plan and death), coalesced per thread to one write per {@link COALESCE_WINDOW}
 * then published as an unsequenced `cache.updated` item after the write, so a client never holds a
 * row a fresh snapshot lacks. Dependency-free so it can sit below the provider-instance registry.
 */
import type { LoomCacheShellStreamItem, LoomThreadCachePatch, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../../serverActivation.ts";
import { LoomStoreV2 } from "./LoomStore.ts";

export interface LoomCachePatchItem {
  readonly threadId: ThreadId;
  readonly patch: LoomThreadCachePatch;
}

export class LoomCacheBroadcast extends Context.Service<
  LoomCacheBroadcast,
  {
    /** New facts about `threadId`'s prompt cache. Never fails. */
    readonly update: (threadId: ThreadId, patch: LoomThreadCachePatch) => Effect.Effect<void>;
    /** Coalesced patches awaiting {@link touchWriterLive} (one consumer). */
    readonly coalesced: Stream.Stream<LoomCachePatchItem>;
    readonly publish: (item: LoomCacheShellStreamItem) => Effect.Effect<void>;
    /** Persisted rows, for the shell stream. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<LoomCacheShellStreamItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/loom/projection/LoomCacheBroadcast") {}

/** Clients tick once a minute, so one write per thread per five seconds loses nothing. */
export const COALESCE_WINDOW = Duration.seconds(5);

export const layer = Layer.effect(
  LoomCacheBroadcast,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<LoomCacheShellStreamItem>();
    const coalesced = yield* Queue.unbounded<LoomCachePatchItem>();
    const scope = yield* Effect.scope;
    // Threads with an open window, each holding the patches merged inside it (null: none yet).
    const windows = new Map<ThreadId, LoomThreadCachePatch | null>();
    const update = (threadId: ThreadId, patch: LoomThreadCachePatch): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (windows.has(threadId)) {
          windows.set(threadId, { ...windows.get(threadId), ...patch });
          return Effect.void;
        }
        windows.set(threadId, null);
        const closeWindow = Effect.suspend(() => {
          const held = windows.get(threadId) ?? null;
          windows.delete(threadId);
          return held === null ? Effect.void : update(threadId, held);
        });
        return Queue.offer(coalesced, { threadId, patch }).pipe(
          Effect.andThen(
            Effect.sleep(COALESCE_WINDOW).pipe(Effect.andThen(closeWindow), Effect.forkIn(scope)),
          ),
          Effect.asVoid,
        );
      });
    return {
      update,
      coalesced: Stream.fromQueue(coalesced),
      publish: (item) => PubSub.publish(pubsub, item).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(pubsub),
    };
  }),
);

/**
 * Stops every thread's plan at boot (no pi process, so no warmer, survives a restart), then
 * persists each coalesced patch to `loom_thread_cache` and publishes the row it leaves (a thread
 * with no row is a no-op).
 */
export const touchWriterLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const loomStore = yield* LoomStoreV2;
    const broadcast = yield* LoomCacheBroadcast;
    yield* loomStore.cache.stopAll.pipe(
      Effect.catchCause((cause) => Effect.logWarning("loom.cache.stop-all-failed", { cause })),
    );
    yield* forkParked(
      Stream.runForEach(broadcast.coalesced, ({ threadId, patch }) =>
        loomStore.cache.update(threadId, patch).pipe(
          Effect.tap(() =>
            patch.warming === undefined
              ? Effect.void
              : Effect.logInfo("loom.cache.warming", { threadId, warming: patch.warming }),
          ),
          Effect.flatMap((cache) =>
            cache === null
              ? Effect.void
              : broadcast.publish({ kind: "cache.updated", threadId, cache }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.cache.write-failed", { threadId, cause }),
          ),
        ),
      ),
    );
  }),
);
