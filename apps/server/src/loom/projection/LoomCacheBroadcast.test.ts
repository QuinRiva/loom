import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
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

const TestLayer = LoomCacheBroadcast.touchWriterLive.pipe(
  Layer.provideMerge(LoomCacheBroadcast.layer),
  Layer.provideMerge(LoomStore.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);
const thread = ThreadId.make("thread:cache-touch");
const T = (second: number) => `2026-10-12T13:00:${String(second).padStart(2, "0")}.000Z`;
const ping = (second: number) => ({
  type: "entry_appended",
  entry: { type: "usage", kind: "cache_warm", timestamp: T(second) },
});

it.layer(TestLayer)("LoomCacheBroadcast", (it) => {
  it.effect("a pi ping reaches touched_at and the shell stream, coalesced per thread", () =>
    Effect.gen(function* () {
      const store = yield* LoomStore.LoomStoreV2;
      const broadcast = yield* LoomCacheBroadcast.LoomCacheBroadcast;
      const hooks = { ...passthroughLoomPiAdapterHooks, cacheTouched: broadcast.touch };
      const items = yield* Queue.unbounded<string>();
      yield* Stream.fromSubscription(yield* broadcast.subscribe).pipe(
        Stream.runForEach((item) => Queue.offer(items, `${item.threadId} ${item.touchedAt}`)),
        Effect.forkScoped,
      );
      const sql = yield* SqlClient.SqlClient;
      const touchedAt = sql<{
        readonly touched_at: string;
      }>`SELECT touched_at FROM loom_thread_cache WHERE thread_id = ${thread}`.pipe(
        Effect.map((rows) => rows[0]?.touched_at),
      );
      yield* store.cache.record(thread, "long");

      // The leading touch goes out at once, persisted before it is published.
      yield* touchLoomPiCache(hooks, thread, ping(1));
      assert.equal(yield* Queue.take(items), `${thread} ${T(1)}`);
      assert.equal(yield* touchedAt, T(1));

      // Touches inside the window collapse into its last, sent when the window closes.
      yield* touchLoomPiCache(hooks, thread, ping(2));
      yield* touchLoomPiCache(hooks, thread, ping(3));
      yield* touchLoomPiCache(hooks, thread, { type: "entry_appended", entry: { type: "custom" } });
      assert.equal(yield* Queue.size(items), 0);
      yield* TestClock.adjust(LoomCacheBroadcast.COALESCE_WINDOW);
      assert.equal(yield* Queue.take(items), `${thread} ${T(3)}`);
      assert.equal(yield* touchedAt, T(3));

      // A quiet window closes with nothing to send; the next touch leads again.
      yield* TestClock.adjust(LoomCacheBroadcast.COALESCE_WINDOW);
      yield* touchLoomPiCache(hooks, thread, ping(20));
      assert.equal(yield* Queue.take(items), `${thread} ${T(20)}`);
      assert.equal(yield* Queue.size(items), 0);
    }).pipe(Effect.scoped),
  );
});
