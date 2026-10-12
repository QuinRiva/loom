/**
 * Cache-touch broadcast (plans/prompt-cache-keeping, Workstream D): the moment
 * pi refreshes a thread's prompt cache — a real request ending, or an idle
 * `cache_warm` ping — the pi adapter's hook reports it here. Touches are
 * coalesced per thread to one per {@link COALESCE_WINDOW} (the leading touch at
 * once, the window's last touch when it closes, so the final value is exact).
 * {@link touchWriterLive} writes each to `loom_thread_cache.touched_at`, which
 * the snapshot carries to seed a client, then publishes it as an unsequenced
 * `cache.touched` shell-stream item that `loomShellGoals` merges for
 * `loom: true` subscribers — after the write, so a client never holds a touch
 * a fresh snapshot lacks. The items never reach the persisted client snapshot.
 *
 * The service has no dependencies, so it is built once below the
 * provider-instance registry (`LoomProviderHealthLive`) where both the pi
 * drivers and the runtime see it; the writer sits with the Loom store, which
 * the drivers cannot reach.
 *
 * @module loom/projection/LoomCacheBroadcast
 */
import type { IsoDateTime, LoomCacheShellStreamItem, ThreadId } from "@t3tools/contracts";
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

export class LoomCacheBroadcast extends Context.Service<
  LoomCacheBroadcast,
  {
    /** pi refreshed `threadId`'s prompt cache at `at`. Never fails. */
    readonly touch: (threadId: ThreadId, at: IsoDateTime) => Effect.Effect<void>;
    /** Coalesced touches awaiting {@link touchWriterLive} (one consumer). */
    readonly coalesced: Stream.Stream<LoomCacheShellStreamItem>;
    readonly publish: (item: LoomCacheShellStreamItem) => Effect.Effect<void>;
    /** Persisted touches, for the shell stream. */
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<LoomCacheShellStreamItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/loom/projection/LoomCacheBroadcast") {}

/** Clients tick once a minute, so one touch per thread per five seconds loses nothing. */
export const COALESCE_WINDOW = Duration.seconds(5);

export const layer = Layer.effect(
  LoomCacheBroadcast,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<LoomCacheShellStreamItem>();
    const coalesced = yield* Queue.unbounded<LoomCacheShellStreamItem>();
    const scope = yield* Effect.scope;
    // Threads with an open window, each holding the latest touch that arrived inside it.
    const windows = new Map<ThreadId, IsoDateTime | null>();
    const touch = (threadId: ThreadId, at: IsoDateTime): Effect.Effect<void> =>
      Effect.suspend(() => {
        if (windows.has(threadId)) {
          windows.set(threadId, at);
          return Effect.void;
        }
        windows.set(threadId, null);
        const closeWindow = Effect.suspend(() => {
          const trailing = windows.get(threadId) ?? null;
          windows.delete(threadId);
          return trailing === null ? Effect.void : touch(threadId, trailing);
        });
        return Queue.offer(coalesced, { kind: "cache.touched", threadId, touchedAt: at }).pipe(
          Effect.andThen(
            Effect.sleep(COALESCE_WINDOW).pipe(Effect.andThen(closeWindow), Effect.forkIn(scope)),
          ),
          Effect.asVoid,
        );
      });
    return {
      touch,
      coalesced: Stream.fromQueue(coalesced),
      publish: (item) => PubSub.publish(pubsub, item).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(pubsub),
    };
  }),
);

/**
 * Persists each coalesced touch to `loom_thread_cache.touched_at` (a thread with no row is a
 * no-op), then publishes it to the shell stream.
 */
export const touchWriterLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const loomStore = yield* LoomStoreV2;
    const broadcast = yield* LoomCacheBroadcast;
    yield* forkParked(
      Stream.runForEach(broadcast.coalesced, (item) =>
        loomStore.cache.touch(item.threadId, item.touchedAt).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("loom.cache-touch.write-failed", { threadId: item.threadId, cause }),
          ),
          Effect.andThen(broadcast.publish(item)),
        ),
      ),
    );
  }),
);
