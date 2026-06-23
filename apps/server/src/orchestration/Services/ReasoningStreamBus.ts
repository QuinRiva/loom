/**
 * ReasoningStreamBus - the transient channel for streaming reasoning chunks.
 *
 * Unlike the orchestration event store, reasoning chunks are NOT durable facts.
 * They are a transient view concern: they drive the live "Thinking… ⟷ Thought
 * for Xs" display only. The durable truth is the final accumulated reasoning
 * text, persisted exactly once per assistant segment as a single
 * `thread.message-reasoning` domain event (REPLACE semantics).
 *
 * This bus carries `ReasoningStreamItem`s from the provider ingestion producer
 * to WebSocket `subscribeThread` subscribers, bypassing the command queue,
 * event store, and projection pipeline entirely — which is what eliminates the
 * per-chunk `refreshThreadShellSummary` amplification.
 *
 * Production uses a real bounded **sliding** PubSub (see the Live layer): under
 * a slow client, oldest chunks are dropped rather than growing memory without
 * bound. Dropped live chunks are non-fatal — the durable completion event
 * REPLACES the message's reasoning with the full text at finalization.
 *
 * @module ReasoningStreamBus
 */
import type { ReasoningStreamItem } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

export interface ReasoningStreamBusShape {
  /** Publish a transient reasoning item (delta or live-complete). */
  readonly publish: (item: ReasoningStreamItem) => Effect.Effect<void>;
  /**
   * Acquire a fresh per-subscriber subscription of all reasoning items (filter
   * by threadId at the call site). Scoped so callers can establish the
   * subscription BEFORE doing async work (e.g. a snapshot fetch) and still have
   * items published during that window buffered in the subscription queue —
   * closing the connect-gap where mid-fetch deltas would otherwise be lost.
   */
  readonly subscribe: Effect.Effect<PubSub.Subscription<ReasoningStreamItem>, never, Scope.Scope>;
}

export class ReasoningStreamBus extends Context.Service<
  ReasoningStreamBus,
  ReasoningStreamBusShape
>()("t3/orchestration/Services/ReasoningStreamBus") {}
