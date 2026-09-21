/**
 * OrchestrationEngineService - Service interface for orchestration command handling.
 *
 * Owns command validation/dispatch and in-memory read-model updates backed by
 * `OrchestrationEventStore` persistence. It does not own provider process
 * management or transport concerns (e.g. websocket request parsing).
 *
 * Uses Effect `Context.Service` for dependency injection. Command dispatch,
 * replay, and unknown-input decoding all return typed domain errors.
 *
 * @module OrchestrationEngineService
 */
import type {
  OrchestrationClientOrigin,
  OrchestrationCommand,
  OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../Errors.ts";
import type { OrchestrationEventStoreError } from "../../persistence/Errors.ts";
import type { OrchestrationAggregateReplayStats } from "../../persistence/Services/OrchestrationEventStore.ts";

export interface OrchestrationThreadReplayRange {
  readonly threadId: ThreadId;
  readonly fromSequenceExclusive: number;
  readonly toSequenceInclusive: number;
}

/**
 * OrchestrationEngineShape - Service API for orchestration command and event flow.
 */
export interface OrchestrationEngineShape {
  /**
   * Replay persisted orchestration events from an exclusive sequence cursor.
   *
   * @param fromSequenceExclusive - Sequence cursor (exclusive).
   * @param limit - Maximum number of events to read. Defaults to the event
   *   store's page-bounded default; pass a higher value when the caller must
   *   read a wider global range. Thread subscriptions use readThreadEvents.
   * @returns Stream containing ordered events.
   */
  readonly readEvents: (
    fromSequenceExclusive: number,
    limit?: number,
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /** Read only this thread's events through a captured authoritative head. */
  readonly readThreadEvents: (
    input: OrchestrationThreadReplayRange & { readonly limit?: number },
  ) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;

  /** Measure a bounded thread replay without decoding its event bodies. */
  readonly getThreadReplayStats: (
    input: OrchestrationThreadReplayRange & { readonly maxEvents: number },
  ) => Effect.Effect<OrchestrationAggregateReplayStats, OrchestrationEventStoreError>;

  // loom: single-aggregate replay (bounded by events returned, not scanned).
  /**
   * Replay ONE aggregate's events from an exclusive sequence cursor.
   *
   * Prefer this over {@link readEvents} when resuming a single aggregate (e.g. a
   * thread subscription): filtering the global stream makes the limit bound
   * events *scanned* rather than *returned*, silently omitting the aggregate's
   * own events on a busy server. `limit` is required by design.
   *
   * @returns Stream containing that aggregate's ordered events.
   */
  readonly readStreamEvents: (input: {
    readonly aggregateKind: string;
    readonly streamId: string;
    readonly sequenceExclusive: number;
    readonly limit: number;
  }) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError, never>;

  /**
   * Dispatch a validated orchestration command.
   *
   * @param command - Valid orchestration command.
   * @param options - Optional client origin (surface/app version) stamped into
   *   the metadata of every event the command produces.
   * @returns Effect containing the sequence of the persisted event.
   *
   * Dispatch is serialized through an internal queue and deduplicated via
   * command receipts.
   */
  readonly dispatch: (
    command: OrchestrationCommand,
    options?: { readonly origin?: OrchestrationClientOrigin },
  ) => Effect.Effect<{ sequence: number }, OrchestrationDispatchError, never>;

  /**
   * Stream persisted domain events in dispatch order.
   *
   * This is a hot runtime stream (new events only), not a historical replay.
   */
  readonly streamDomainEvents: Stream.Stream<OrchestrationEvent>;

  /**
   * Acquire a scoped hot domain-event stream whose PubSub subscription is
   * established eagerly when this effect runs — before the caller does any
   * further async work. Unlike `streamDomainEvents` (a plain `Stream` value
   * that only subscribes when it is first pulled, e.g. after a preceding
   * `Stream.concat` element), running this effect attaches the subscription
   * up front so events emitted during a subsequent snapshot fetch are buffered
   * in the subscription queue rather than dropped. Callers dedup against their
   * snapshot via `event.sequence`. This closes the connect-gap on first view of
   * an actively-streaming thread (mirrors the reasoning bus pre-subscribe).
   * Acquire a domain-event subscription before starting a consumer.
   * The subscription is ready when this effect returns and closes with the scope.
   */
  readonly subscribeDomainEvents: Effect.Effect<
    Stream.Stream<OrchestrationEvent>,
    never,
    Scope.Scope
  >;

  /**
   * The latest sequence reflected in the engine's authoritative command read
   * model (0 if none). Used to gauge how far behind a resuming client is before
   * choosing between an incremental replay and a fresh projected snapshot.
   */
  readonly latestSequence: Effect.Effect<number, never, never>;
}

/**
 * OrchestrationEngineService - Service tag for orchestration engine access.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const engine = yield* OrchestrationEngineService
 *   return yield* engine.dispatch(command)
 * })
 * ```
 */
export class OrchestrationEngineService extends Context.Service<
  OrchestrationEngineService,
  OrchestrationEngineShape
>()("t3/orchestration/Services/OrchestrationEngine/OrchestrationEngineService") {}
