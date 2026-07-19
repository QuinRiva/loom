import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
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

/**
 * Grace before a drafter whose settlement is stuck AWAITING the provider stop
 * (lane `done`, ≥1 handoff, but the session stubbornly never reaches `stopped`
 * — a failing/lost `stopSession` side effect) is surfaced with `needs_guidance`.
 * The stop keeps being re-attempted every pass regardless; this only makes a
 * permanently stuck stop visible rather than silently retried forever.
 */
export const HANDOFF_STOP_STUCK_GRACE_MS = 300_000;

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

/** Epoch-ms the kickoff began: the running turn's start, else the drafter's creation. */
const kickoffStartedMs = (drafter: OrchestrationThreadShell): number => {
  const iso =
    drafter.latestTurn !== null
      ? (drafter.latestTurn.startedAt ?? drafter.latestTurn.requestedAt)
      : drafter.createdAt;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.parse(drafter.createdAt) : ms;
};

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

  // Non-terminal kickoff (no turn yet, or a still-running/starting turn). Never
  // re-raise once already surfaced.
  if (hasNeedsGuidance(drafter)) return { kind: "none" };

  // turn-start-failed (D6 leg 2): the launch failed before any turn landed, so
  // the session is reset to ready with a `lastError` and no turn will follow ⇒
  // surface immediately rather than waiting out the grace window.
  if (latestTurn === null && !isSessionRunning(drafter) && drafter.session?.lastError != null) {
    return { kind: "guidance", reasonKey: "turn-start-failed" };
  }

  // Hung backstop (D6 leg 3): ANY non-terminal kickoff still unsettled past the
  // grace window — crucially INCLUDING a `starting`/`running` turn that never
  // completes (the common provider/model/tool hang), not just the never-started
  // shape. Timer-driven (the caller passes a clock `nowMs`), not a render-time
  // comparison. Legs 1–2 catch the fast failures; this only fires for a truly
  // stuck kickoff, so a generous grace keeps false positives off healthy long
  // drafting turns.
  if (nowMs - kickoffStartedMs(drafter) > graceMs) {
    return { kind: "guidance", reasonKey: "kickoff-hung" };
  }

  // Kickoff in flight within grace, or a terminal turn whose session has not yet
  // left running (transient) ⇒ wait for the next re-arm.
  return { kind: "none" };
};

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  // Dispatch WITHOUT swallowing: a failure propagates so the current settlement
  // sequence ABORTS before its next prerequisite (never archive after a failed
  // stop). The per-thread catch in `runPass` logs it and the next tick retries.
  // Re-dispatching an already-accepted deterministic id is a benign engine
  // receipt no-op (not a failure), so retries and re-arms are idempotent.
  const dispatch = (command: OrchestrationCommand) => orchestrationEngine.dispatch(command);

  // Failure / stuck (zero handoffs / turn-start failed / hung kickoff / stop
  // stuck): raise needs_guidance so the broken drafter is surfaced (roots have
  // no other rail). Deterministic id keyed by the reason so it is raised at most
  // once per episode.
  const raiseGuidance = (drafterId: OrchestrationThreadShell["id"], reasonKey: string) =>
    Effect.gen(function* () {
      const id = `server:handoff-settle:guidance:${drafterId}:${reasonKey}`;
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(id),
        threadId: drafterId,
        reason: "needs_guidance",
        createdAt: yield* nowIso,
      });
    });

  // Success (≥1 handoff): converge lane `done` → session stop → archive, driven
  // by PROJECTED session state so archive can never race ahead of the actual
  // provider stop (round-1 MF-1): the stop runs asynchronously in the
  // ProviderCommandReactor, whose thread lookup excludes archived rows, so
  // archiving first would strand a live pi process. We therefore request the
  // stop and RETURN while the session is still live; only once the session is
  // projected `stopped` do we archive.
  //
  // Crucially the stop command carries a FRESH id each attempt (round-2 MF-1).
  // A DETERMINISTIC id would, after the engine accepts it once, make every retry
  // a receipt no-op that never re-publishes the `thread.session-stop-requested`
  // event — and that provider stop is a LIVE-STREAM-ONLY side effect with no
  // replay: if `stopSession` fails (swallowed as a warning) or the process
  // crashes before the reactor consumes the event, the session stays `ready`
  // forever and the drafter is never archived. A fresh id re-publishes the event
  // on every reconciliation pass, so the ProviderCommandReactor re-attempts the
  // real stop (idempotent — it skips `stopSession` once `status === "stopped"`)
  // until it takes, which then re-arms the archive. `done`/`archive` stay
  // deterministic (projection-only, no lost side effect). A persistently stuck
  // stop is surfaced via `needs_guidance` after a grace window so it is never
  // silently retried out of sight.
  const settleSuccess = (drafter: OrchestrationThreadShell, turnId: string, nowMs: number) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      const doneId = `server:handoff-settle:done:${drafter.id}:${turnId}`;
      yield* dispatch({
        type: "thread.plan-lane.set",
        commandId: CommandId.make(doneId),
        threadId: drafter.id,
        planLane: "done",
        createdAt: now,
      });
      if (drafter.session !== null && drafter.session.status !== "stopped") {
        const nonce = yield* crypto.randomUUIDv4;
        yield* dispatch({
          type: "thread.session.stop",
          commandId: CommandId.make(`server:handoff-settle:stop:${drafter.id}:${turnId}:${nonce}`),
          threadId: drafter.id,
          createdAt: now,
        });
        // Surface a stop that has been stuck past the grace window (a failing/
        // lost side effect) so it is not silently re-attempted forever. The
        // awaiting-stop clock is `planLaneSince`, but it is ONLY a settlement
        // clock once the input snapshot already reads `done` — a re-arm AFTER a
        // prior pass set the lane. On the FIRST (`in_progress`) success pass
        // `planLaneSince` is still the kickoff's `in_progress` stamp, so aging
        // against it would falsely flag a healthy but long drafting turn as
        // broken. We therefore only age the wait on a `done` snapshot; the
        // initial pass just dispatches `done` + the stop and defers any
        // stuck-surfacing to the next re-arm (when the lane reads `done`).
        if (drafter.planLane === "done" && drafter.planLaneSince !== null) {
          const awaitingMs = nowMs - Date.parse(drafter.planLaneSince);
          if (Number.isFinite(awaitingMs) && awaitingMs > HANDOFF_STOP_STUCK_GRACE_MS) {
            yield* raiseGuidance(drafter.id, "stop-stuck");
          }
        }
        return;
      }
      const archiveId = `server:handoff-settle:archive:${drafter.id}:${turnId}`;
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make(archiveId),
        threadId: drafter.id,
      });
    });

  const settleDrafter = (drafter: OrchestrationThreadShell, nowMs: number) => {
    const action = classifyHandoffSettlement(drafter, nowMs);
    switch (action.kind) {
      case "success":
        return settleSuccess(drafter, action.turnId, nowMs);
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
