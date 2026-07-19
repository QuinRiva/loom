import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { HANDOFF_DRAFTER_ROLE } from "../../loom/handoffDraft.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  HandoffDrafterReactor,
  type HandoffDrafterReactorShape,
} from "../Services/HandoffDrafterReactor.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Periodic reconciliation cadence. The pass is idempotent (reads state from
 * scratch, deterministic command ids), so re-runs are harmless; the tick
 * bulletproofs against a settlement trigger sampled before its projection
 * write landed, and recovers drafters stranded by a crash.
 */
export const HANDOFF_RECONCILIATION_INTERVAL_MS = 60_000;

/**
 * Generous grace before a drafter whose kickoff never reached a terminal turn
 * is declared hung and surfaced (plan D6 leg 3). Legs 1–2 (zero-handoff turn
 * end, turn-start-failed) catch the common failures; this only catches a truly
 * stuck kickoff, so it can afford to be slow.
 */
export const HANDOFF_HUNG_GRACE_MS = 300_000;

const isTerminalTurnState = (state: string): boolean =>
  state === "completed" || state === "interrupted" || state === "error";

const isSessionRunning = (thread: OrchestrationThreadShell): boolean =>
  thread.session !== null &&
  (thread.session.status === "running" || thread.session.status === "starting");

const hasNeedsGuidance = (thread: OrchestrationThreadShell): boolean =>
  thread.attention.includes("needs_guidance");

/**
 * The settlement decision for one drafter (pure, unit-testable). Encodes the
 * whole D5/D6 turn-end logic so lifecycle airtightness can be asserted without
 * a live engine:
 * - `none`: not yet settleable (already archived, initial ready before
 *   turn.started, an in-flight/hung-within-grace kickoff, or already surfaced).
 * - `success`: a terminal kickoff turn with ≥1 recorded handoff ⇒ converge
 *   done→stop→archive (carries the settled turn id for deterministic ids).
 * - `guidance`: zero-handoff turn end / turn-start-failed / hung kickoff ⇒ raise
 *   needs_guidance (carries a reason key for the deterministic id).
 */
export type HandoffSettlementAction =
  | { readonly kind: "none" }
  | { readonly kind: "success"; readonly turnId: string }
  | { readonly kind: "guidance"; readonly reasonKey: string };

export const classifyHandoffSettlement = (
  drafter: OrchestrationThreadShell,
  nowMs: number,
  graceMs: number = HANDOFF_HUNG_GRACE_MS,
): HandoffSettlementAction => {
  // Already settled successfully.
  if (drafter.archivedAt !== null) return { kind: "none" };

  const latestTurn = drafter.latestTurn;

  // Turn end: a real kickoff turn exists, it is terminal, and the session is no
  // longer running it. Deliberately ignores the initial ready session-set
  // before `turn.started` (the kickoff turn is still `running` then).
  if (latestTurn !== null && isTerminalTurnState(latestTurn.state) && !isSessionRunning(drafter)) {
    if (drafter.handoffCount >= 1) return { kind: "success", turnId: latestTurn.turnId };
    if (hasNeedsGuidance(drafter)) return { kind: "none" };
    return { kind: "guidance", reasonKey: `zero:${latestTurn.turnId}` };
  }

  // No kickoff turn ever landed. turn-start-failed resets the session to ready
  // with a lastError but produces no turn (D6 leg 2) ⇒ surface immediately.
  // Otherwise the kickoff is in flight (wait) or hung past grace (leg 3).
  if (latestTurn === null && !isSessionRunning(drafter)) {
    if (hasNeedsGuidance(drafter)) return { kind: "none" };
    if (drafter.session?.lastError != null) {
      return { kind: "guidance", reasonKey: "turn-start-failed" };
    }
    const ageMs = nowMs - Date.parse(drafter.createdAt);
    if (Number.isFinite(ageMs) && ageMs > graceMs) {
      return { kind: "guidance", reasonKey: "kickoff-hung" };
    }
  }
  // latestTurn running, session running, or kickoff in flight within grace.
  return { kind: "none" };
};

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const dispatchDeterministic = (id: string, command: OrchestrationCommand) =>
    orchestrationEngine.dispatch(command).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("handoff drafter settlement dispatch failed", {
              commandId: id,
              cause: Cause.pretty(cause),
            }),
      ),
    );

  // Success (≥1 handoff): converge lane `done` → session stop → archive. All
  // three carry deterministic ids keyed by drafter + settled turn, so the
  // engine receipt store makes each at-most-once and a crash between steps
  // re-runs safely (archive makes later passes skip the now-archived drafter).
  // The explicit session stop is mandatory: decider archive is metadata-only,
  // so without it every settled drafter would leak a live pi process. It is a
  // command (routed to the ProviderCommandReactor), NOT the client WS archive
  // handler's cleanup.
  const settleSuccess = (drafter: OrchestrationThreadShell, turnId: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const doneId = `server:handoff-settle:done:${drafter.id}:${turnId}`;
      yield* dispatchDeterministic(doneId, {
        type: "thread.plan-lane.set",
        commandId: CommandId.make(doneId),
        threadId: drafter.id,
        planLane: "done",
        createdAt: now,
      });
      const stopId = `server:handoff-settle:stop:${drafter.id}:${turnId}`;
      yield* dispatchDeterministic(stopId, {
        type: "thread.session.stop",
        commandId: CommandId.make(stopId),
        threadId: drafter.id,
        createdAt: now,
      });
      const archiveId = `server:handoff-settle:archive:${drafter.id}:${turnId}`;
      yield* dispatchDeterministic(archiveId, {
        type: "thread.archive",
        commandId: CommandId.make(archiveId),
        threadId: drafter.id,
      });
    });

  // Failure (zero handoffs / turn-start failed / hung): raise needs_guidance so
  // the broken drafter is surfaced (roots have no other rail). Deterministic id
  // keyed by the settlement reason so it is raised at most once per episode.
  const raiseGuidance = (drafterId: OrchestrationThreadShell["id"], reasonKey: string) =>
    Effect.gen(function* () {
      const id = `server:handoff-settle:guidance:${drafterId}:${reasonKey}`;
      yield* dispatchDeterministic(id, {
        type: "thread.attention.raise",
        commandId: CommandId.make(id),
        threadId: drafterId,
        reason: "needs_guidance",
        createdAt: yield* nowIso,
      });
    });

  const settleDrafter = (drafter: OrchestrationThreadShell, nowMs: number) => {
    const action = classifyHandoffSettlement(drafter, nowMs);
    switch (action.kind) {
      case "success":
        return settleSuccess(drafter, action.turnId);
      case "guidance":
        return raiseGuidance(drafter.id, action.reasonKey);
      case "none":
        return Effect.void;
    }
  };

  const runPass = Effect.fn("runPass")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const nowMs = yield* Clock.currentTimeMillis;
    for (const thread of snapshot.threads) {
      if (thread.role !== HANDOFF_DRAFTER_ROLE) continue;
      yield* settleDrafter(thread, nowMs).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("handoff drafter settlement pass failed for thread", {
                threadId: thread.id,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  });

  const runPassSafely = runPass().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("handoff drafter reactor pass failed", {
            cause: Cause.pretty(cause),
          }),
    ),
  );

  const worker = yield* makeDrainableWorker((_trigger: void) => runPassSafely);

  const start: HandoffDrafterReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event: OrchestrationEvent) => {
        // `thread.session-set` leaving `running` is the authoritative turn-end
        // (there is no `turn.completed` domain event); `thread.turn-start-failed`
        // is the immediate failure signal for a root kickoff. Both re-arm the
        // idempotent pass; the pass filters to drafter roots.
        if (event.type === "thread.session-set" || event.type === "thread.turn-start-failed") {
          return worker.enqueue();
        }
        return Effect.void;
      }),
    );
    // Startup reconciliation: recover drafters stranded by a crash between
    // turn end and archive (no event replay on the live domain stream).
    yield* worker.enqueue();
    // Periodic reconciliation: catches the sample-vs-apply race and the hung
    // kickoff (timer-driven, not a render-time comparison — plan D6).
    yield* Effect.forkScoped(
      worker
        .enqueue()
        .pipe(Effect.repeat(Schedule.spaced(Duration.millis(HANDOFF_RECONCILIATION_INTERVAL_MS)))),
    );
  });

  return { start, drain: worker.drain } satisfies HandoffDrafterReactorShape;
});

export const HandoffDrafterReactorLive = Layer.effect(HandoffDrafterReactor, make);
