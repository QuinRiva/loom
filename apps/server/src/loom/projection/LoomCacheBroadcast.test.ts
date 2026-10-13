import { assert, it } from "@effect/vitest";
import { type LoomThreadCache, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { passthroughLoomPiAdapterHooks, touchLoomPiCache } from "@t3tools/provider-pi/server/loom";
import * as LoomCacheBroadcast from "./LoomCacheBroadcast.ts";
import * as LoomStore from "./LoomStore.ts";

const StoreLayer = LoomCacheBroadcast.layer.pipe(
  Layer.provideMerge(LoomStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const thread = ThreadId.make("thread:cache-touch");
const T = (second: number) => `2026-10-12T13:00:${String(second).padStart(2, "0")}.000Z`;
const ping = (second: number) => ({
  type: "entry_appended",
  entry: { type: "usage", kind: "cache_warm", timestamp: T(second) },
});
// A request dispatched at T(0) that took 4 s.
const requestEnd = {
  type: "message_end",
  message: { role: "assistant", stopReason: "stop", timestamp: Date.parse(T(0)), durationMs: 4000 },
};
const row = (patch: Partial<LoomThreadCache>): LoomThreadCache => ({
  retention: "long",
  requestStartedAt: null,
  requestEndedAt: null,
  pingedAt: null,
  warming: null,
  ...patch,
});

it.layer(LoomCacheBroadcast.touchWriterLive.pipe(Layer.provideMerge(StoreLayer)))(
  "LoomCacheBroadcast",
  (it) => {
    it.effect("pi's facts reach the row and the shell stream, merged per window", () =>
      Effect.gen(function* () {
        const store = yield* LoomStore.LoomStoreV2;
        const broadcast = yield* LoomCacheBroadcast.LoomCacheBroadcast;
        const hooks = { ...passthroughLoomPiAdapterHooks, cache: broadcast.update };
        const items = yield* Queue.unbounded<LoomThreadCache>();
        yield* Stream.fromSubscription(yield* broadcast.subscribe).pipe(
          Stream.runForEach((item) => Queue.offer(items, item.cache)),
          Effect.forkScoped,
        );
        // An empty patch writes nothing and reads the row back.
        const stored = store.cache.update(thread, {});
        yield* store.cache.record(thread, "long");

        // The leading patch goes out at once, persisted before the row is published.
        yield* touchLoomPiCache(hooks, thread, requestEnd);
        const afterRequest = row({ requestStartedAt: T(0), requestEndedAt: T(4) });
        assert.deepEqual(yield* Queue.take(items), afterRequest);

        // Patches inside the window merge — a later one never drops an earlier key — and the
        // published item is the whole row after the write.
        yield* broadcast.update(thread, { warming: "scheduled" });
        yield* touchLoomPiCache(hooks, thread, ping(2));
        yield* touchLoomPiCache(hooks, thread, ping(3));
        yield* touchLoomPiCache(hooks, thread, {
          type: "entry_appended",
          entry: { type: "custom" },
        });
        assert.equal(yield* Queue.size(items), 0);
        yield* TestClock.adjust(LoomCacheBroadcast.COALESCE_WINDOW);
        const merged = { ...afterRequest, pingedAt: T(3), warming: "scheduled" } as const;
        assert.deepEqual(yield* Queue.take(items), merged);
        assert.deepEqual(yield* stored, merged);

        // A quiet window closes with nothing to send; the next patch leads again. An explicit
        // null (undecided) is written, not skipped.
        yield* TestClock.adjust(LoomCacheBroadcast.COALESCE_WINDOW);
        yield* broadcast.update(thread, { warming: null });
        assert.deepEqual(yield* Queue.take(items), { ...merged, warming: null });
        assert.equal(yield* Queue.size(items), 0);
      }).pipe(Effect.scoped),
    );
  },
);

it.layer(StoreLayer)("LoomCacheBroadcast boot sweep", (it) => {
  it.effect("stops every plan when the writer starts: no warmer survives a restart", () =>
    Effect.gen(function* () {
      const store = yield* LoomStore.LoomStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const scheduled = ThreadId.make("thread:scheduled");
      const undecided = ThreadId.make("thread:undecided");
      yield* store.cache.record(scheduled, "long");
      yield* store.cache.record(undecided, "short");
      yield* store.cache.update(scheduled, { warming: "scheduled", requestEndedAt: T(1) });
      yield* Layer.build(LoomCacheBroadcast.touchWriterLive);
      assert.deepEqual(
        yield* sql`SELECT thread_id, warming, request_ended_at FROM loom_thread_cache
          ORDER BY thread_id`,
        [
          { thread_id: scheduled, warming: "stopped", request_ended_at: T(1) },
          { thread_id: undecided, warming: "stopped", request_ended_at: null },
        ],
      );
    }).pipe(Effect.scoped),
  );
});
