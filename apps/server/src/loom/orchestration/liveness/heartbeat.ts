/**
 * The liveness heartbeat (Phase 3 plan "Liveness"; P3-8, P3-9): when each Loom
 * thread last showed agent activity, held in memory and fed by
 * `OrchestratorV2.streamDomainEvents`. Nothing is persisted — after a restart
 * every thread reads as last seen at process start, which is also the sweep's
 * floor, so persistence would buy nothing.
 *
 * A beat is a `turn-item.updated` (every tool output chunk, so a tool that
 * prints periodically stays alive), a `provider-turn.updated` or a
 * `run-attempt.updated` on a thread with a sidecar row. A `user_message` item is
 * not agent activity — the stall nudge itself writes one — so it is no beat.
 *
 * @module loom/orchestration/liveness/heartbeat
 */
import type { OrchestrationV2DomainEvent, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../../serverActivation.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";

/** The event types that advance a thread's heartbeat. */
const isBeat = (event: OrchestrationV2DomainEvent) =>
  (event.type === "turn-item.updated" && event.payload.type !== "user_message") ||
  event.type === "provider-turn.updated" ||
  event.type === "run-attempt.updated";

export interface LoomHeartbeatShape {
  /** The thread's last beat (ms), floored at process start: an unseen thread reads as seen then. */
  readonly lastHeartbeatMs: (threadId: ThreadId) => number;
  /** Resolves once the thread has beaten at or after `atLeastMs` (tests: the deterministic wait, never a sleep). */
  readonly awaitBeat: (threadId: ThreadId, atLeastMs: number) => Effect.Effect<void>;
}

export class LoomHeartbeat extends Context.Service<LoomHeartbeat, LoomHeartbeatShape>()(
  "t3/loom/orchestration/liveness/heartbeat/LoomHeartbeat",
) {}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const floorMs = DateTime.toEpochMillis(yield* DateTime.now);
  const beats = new Map<ThreadId, number>();
  // Sidecar membership per thread, read once; a later `workstream-created` re-reads it.
  const isLoom = new Map<ThreadId, boolean>();
  const waiters = new Set<{
    readonly threadId: ThreadId;
    readonly atLeastMs: number;
    readonly done: Deferred.Deferred<void>;
  }>();
  const lastHeartbeatMs = (threadId: ThreadId) => beats.get(threadId) ?? floorMs;

  const observe = Effect.fn("loom.heartbeat.observe")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    if (event.type === "thread.workstream-created") isLoom.delete(event.threadId);
    if (!isBeat(event)) return;
    let loom = isLoom.get(event.threadId);
    if (loom === undefined) {
      loom = (yield* loomStore.getWorkstream(event.threadId)) !== null;
      isLoom.set(event.threadId, loom);
    }
    if (!loom) return;
    const atMs = Math.max(
      lastHeartbeatMs(event.threadId),
      DateTime.toEpochMillis(event.occurredAt),
    );
    beats.set(event.threadId, atMs);
    for (const waiter of waiters) {
      if (waiter.threadId !== event.threadId || atMs < waiter.atLeastMs) continue;
      waiters.delete(waiter);
      yield* Deferred.succeed(waiter.done, undefined);
    }
  });

  yield* forkParked(
    orchestrator.streamDomainEvents.pipe(
      Stream.runForEach((event) =>
        observe(event).pipe(
          Effect.catch((error) => Effect.logWarning("loom.heartbeat.observe-failed", { error })),
        ),
      ),
      Effect.catchCause((cause) => Effect.logWarning("loom.heartbeat.stream-stopped", { cause })),
    ),
  );

  return {
    lastHeartbeatMs,
    awaitBeat: (threadId, atLeastMs) =>
      Effect.suspend(() => {
        if (lastHeartbeatMs(threadId) >= atLeastMs && beats.has(threadId)) return Effect.void;
        const done = Deferred.makeUnsafe<void>();
        waiters.add({ threadId, atLeastMs, done });
        return Deferred.await(done);
      }),
  } satisfies LoomHeartbeatShape;
});

/** The heartbeat, its stream consumer forked post-activation. */
export const LoomHeartbeatLive = Layer.effect(LoomHeartbeat, make);
