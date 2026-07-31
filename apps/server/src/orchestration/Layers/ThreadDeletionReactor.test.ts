import { CommandId, EventId, type OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
  toThreadCleanupRequest,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

const THREAD = ThreadId.make("thread-cleanup-trigger");
const AT = "2026-01-01T00:00:00.000Z";

const eventBase = {
  eventId: EventId.make("11111111-1111-1111-1111-111111111111"),
  sequence: 1,
  aggregateKind: "thread",
  aggregateId: THREAD,
  occurredAt: AT,
  commandId: CommandId.make("cmd-cleanup"),
  causationEventId: null,
  correlationId: CommandId.make("cmd-cleanup"),
  metadata: {},
} as const;

const deleted = {
  ...eventBase,
  type: "thread.deleted",
  payload: { threadId: THREAD, deletedAt: AT },
} as OrchestrationEvent;

const archived = {
  ...eventBase,
  type: "thread.archived",
  payload: { threadId: THREAD, archivedAt: AT, updatedAt: AT },
} as OrchestrationEvent;

const laneSet = (planLane: string) =>
  ({
    ...eventBase,
    type: "thread.plan-lane-set",
    payload: { threadId: THREAD, planLane, updatedAt: AT },
  }) as OrchestrationEvent;

const unarchived = {
  ...eventBase,
  type: "thread.unarchived",
  payload: { threadId: THREAD, updatedAt: AT },
} as OrchestrationEvent;

describe("toThreadCleanupRequest", () => {
  it("reclaims on deletion, archive, done and cancelled", () => {
    expect(toThreadCleanupRequest(deleted)).toEqual({ threadId: THREAD, reason: "deleted" });
    expect(toThreadCleanupRequest(archived)).toEqual({ threadId: THREAD, reason: "archived" });
    expect(toThreadCleanupRequest(laneSet("done"))).toEqual({ threadId: THREAD, reason: "done" });
    expect(toThreadCleanupRequest(laneSet("cancelled"))).toEqual({
      threadId: THREAD,
      reason: "cancelled",
    });
  });

  // The safety boundary: a thread that is still working (or is being handed back
  // to a human, or has just been reopened) must keep its terminals. Reaping
  // these would kill a dev server an agent is actively using.
  it("leaves non-terminal lanes and other lifecycle events alone", () => {
    for (const lane of ["planned", "ready", "in_progress", "yielded"]) {
      expect(toThreadCleanupRequest(laneSet(lane))).toBeNull();
    }
    expect(toThreadCleanupRequest(unarchived)).toBeNull();
  });
});

class StubCloseError extends Schema.TaggedErrorClass<StubCloseError>()("StubCloseError", {}) {}

interface Recorded {
  readonly closes: ReadonlyArray<{
    readonly threadId: string;
    readonly deleteHistory: boolean | undefined;
  }>;
  readonly providerStops: ReadonlyArray<string>;
}

/**
 * Drive the reactor over a finite domain-event stream and report what it did.
 *
 * `closeResult` lets a test make `terminalManager.close` fail, proving cleanup
 * stays best-effort. Events sit in the stream before `start`, so no publish can
 * race the subscription; the poll below covers the async stream-to-worker hop
 * (a bare `drain` can observe an idle queue before the first enqueue).
 */
const runReactorOn = (
  events: ReadonlyArray<OrchestrationEvent>,
  closeResult: Effect.Effect<void, StubCloseError> = Effect.void,
): Promise<Recorded> =>
  Effect.gen(function* () {
    const closes = yield* Ref.make<Recorded["closes"]>([]);
    const providerStops = yield* Ref.make<Recorded["providerStops"]>([]);

    const layer = ThreadDeletionReactorLive.pipe(
      Layer.provide(
        Layer.succeed(OrchestrationEngineService, {
          streamDomainEvents: Stream.fromIterable(events),
        } as never),
      ),
      Layer.provide(
        Layer.succeed(ProviderService, {
          stopSession: ({ threadId }: { readonly threadId: string }) =>
            Ref.update(providerStops, (xs) => [...xs, threadId]),
        } as never),
      ),
      Layer.provide(
        Layer.succeed(TerminalManager.TerminalManager, {
          close: (input: { readonly threadId: string; readonly deleteHistory?: boolean }) =>
            Ref.update(closes, (xs) => [
              ...xs,
              { threadId: input.threadId, deleteHistory: input.deleteHistory },
            ]).pipe(Effect.andThen(closeResult)),
        } as never),
      ),
    );

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      const expected = events.filter((event) => toThreadCleanupRequest(event)).length;
      yield* Effect.gen(function* () {
        yield* reactor.drain;
        if ((yield* Ref.get(closes)).length < expected) {
          return yield* Effect.fail("pending" as const);
        }
      }).pipe(Effect.retry({ schedule: Schedule.spaced("5 millis"), times: 200 }), Effect.orDie);
    }).pipe(Effect.scoped, Effect.provide(layer));

    return {
      closes: yield* Ref.get(closes),
      providerStops: yield* Ref.get(providerStops),
    } satisfies Recorded;
  }).pipe(Effect.runPromise);

describe("ThreadDeletionReactor terminal-state cleanup", () => {
  it("closes terminals and destroys history only for deletion", async () => {
    const recorded = await runReactorOn([deleted]);
    expect(recorded.closes).toEqual([{ threadId: THREAD, deleteHistory: true }]);
    expect(recorded.providerStops).toEqual([THREAD]);
  });

  it("closes terminals but PRESERVES history and the provider session on done", async () => {
    const recorded = await runReactorOn([laneSet("done")]);
    expect(recorded.closes).toEqual([{ threadId: THREAD, deleteHistory: false }]);
    // A reopened thread must still have its scrollback, and a `done` lane write
    // can land while the producing turn is still finishing.
    expect(recorded.providerStops).toEqual([]);
  });

  it("closes terminals but preserves history on cancelled and archived", async () => {
    const recorded = await runReactorOn([laneSet("cancelled"), archived]);
    expect(recorded.closes).toEqual([
      { threadId: THREAD, deleteHistory: false },
      { threadId: THREAD, deleteHistory: false },
    ]);
    expect(recorded.providerStops).toEqual([]);
  });

  it("ignores events that are not terminal states", async () => {
    const recorded = await runReactorOn([laneSet("in_progress"), laneSet("ready"), unarchived]);
    expect(recorded.closes).toEqual([]);
    expect(recorded.providerStops).toEqual([]);
  });

  it("is idempotent across done -> reopened -> done -> archived", async () => {
    const recorded = await runReactorOn([
      laneSet("done"),
      laneSet("ready"),
      laneSet("done"),
      archived,
    ]);
    expect(recorded.closes).toHaveLength(3);
    expect(
      recorded.closes.every((close: Recorded["closes"][number]) => close.deleteHistory === false),
    ).toBe(true);
  });

  it("keeps cleanup best-effort when close fails", async () => {
    // A failing close must not break the event stream: the second event is still
    // processed after the first one blew up.
    const recorded = await runReactorOn([laneSet("done"), archived], new StubCloseError());
    expect(recorded.closes).toHaveLength(2);
  });
});
