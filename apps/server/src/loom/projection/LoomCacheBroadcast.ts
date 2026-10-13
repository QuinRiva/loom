/**
 * Cache-fact broadcast (plans/prompt-cache-keeping, Workstream D; cache gauge effective expiry):
 * the facts a client needs to say when a thread's prompt cache really goes cold. The pi
 * adapter's hook reports a real request's dispatch and end and each idle `cache_warm` ping, and
 * the warmer's death with its process; Loom's pi extension reports the idle keep-alive plan
 * (`POST /loom/agent/cache-warming`). Patches are coalesced per thread to one write per
 * {@link COALESCE_WINDOW} (the leading patch at once; the patches arriving inside the window
 * merged, later keys winning, and written when it closes), so no fact is dropped.
 * {@link touchWriterLive} writes each to `loom_thread_cache`, which the snapshot carries to seed a
 * client, then publishes the row as it now stands as an unsequenced `cache.updated` shell-stream
 * item that `loomShellGoals` merges for `loom: true` subscribers — after the write, so a client
 * never holds a row a fresh snapshot lacks. The items never reach the persisted client snapshot.
 *
 * The service has no dependencies, so it is built once below the
 * provider-instance registry (`LoomProviderHealthLive`) where both the pi
 * drivers and the runtime see it; the writer sits with the Loom store, which
 * the drivers cannot reach.
 *
 * @module loom/projection/LoomCacheBroadcast
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
