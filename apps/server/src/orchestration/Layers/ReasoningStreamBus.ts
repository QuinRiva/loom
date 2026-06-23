/**
 * ReasoningStreamBus layers.
 *
 * `ReasoningStreamBusLive` is a real, production PubSub-backed implementation
 * (unlike `RuntimeReceiptBusLive`, which is a deliberate no-op). It uses a
 * bounded **sliding** PubSub so a slow WebSocket subscriber cannot grow server
 * memory without bound on a reasoning-heavy turn: oldest chunks are dropped.
 * Dropping live chunks is safe — the durable `thread.message-reasoning` event
 * REPLACES the message's reasoning with the full accumulated text at segment
 * finalization, so reloads and slow clients still converge on the truth.
 *
 * @module ReasoningStreamBus
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

import {
  ReasoningStreamBus,
  type ReasoningStreamBusShape,
} from "../Services/ReasoningStreamBus.ts";

// Generous enough to absorb normal streaming bursts; sliding so a stalled
// subscriber drops oldest chunks instead of applying backpressure to the
// producer or growing unbounded.
const REASONING_STREAM_PUBSUB_CAPACITY = 4096;

const makeReasoningStreamBus = Effect.gen(function* () {
  const pubSub = yield* PubSub.sliding<Parameters<ReasoningStreamBusShape["publish"]>[0]>(
    REASONING_STREAM_PUBSUB_CAPACITY,
  );

  return {
    publish: (item) => PubSub.publish(pubSub, item).pipe(Effect.asVoid),
    subscribe: PubSub.subscribe(pubSub),
  } satisfies ReasoningStreamBusShape;
});

export const ReasoningStreamBusLive = Layer.effect(ReasoningStreamBus, makeReasoningStreamBus);
