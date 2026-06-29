import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationSession,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";
import { readThreadStallContext, renderStallContext, type StallContext } from "../stallContext.ts";
import {
  WorkstreamLivenessSweep,
  type WorkstreamLivenessSweepShape,
} from "../Services/WorkstreamLivenessSweep.ts";

/**
 * Stage-1 liveness thresholds. Research numbers are general-purpose; these
 * start GENEROUS and are documented as assumptions to tune from real runs:
 * - `sweepIntervalMs` 60s — responsive without hammering the read model.
 * - `startupGraceMs` 2m — gates ALL active-turn detectors so a slow first tool
 *   call (clone / large read) can never be mistaken for a stall/loop.
 * - `staleActivityWindowMs` 10m — an open turn whose runtime heartbeat has been
 *   frozen this long is a mid-turn stall (also catches a dead-mid-turn process,
 *   which stops emitting any runtime event). The heartbeat advances on ANY
 *   runtime event — including assistant/reasoning token deltas that create no
 *   activity row — so long silent reasoning no longer reads as a stall. Falls
 *   back to activity-row freshness / turn start when no heartbeat exists yet
 *   (e.g. right after a restart).
 * - `failureCap` 3 — consecutive sweeps observed in a failed session state
 *   before declaring `error` (a transient single-turn error is tolerated; a
 *   sustained one is not). No active turn re-dispatch retry in Stage 1 (there
 *   is no sub-thread turn-retry mechanism to bound — sub-threads run a single
 *   kickoff turn; re-dispatch belongs to the Stage-2 investigator's ladder).
 */
export interface LivenessSweepThresholds {
  readonly sweepIntervalMs: number;
  readonly startupGraceMs: number;
  readonly staleActivityWindowMs: number;
  readonly failureCap: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessSweepThresholds = {
  sweepIntervalMs: 60_000,
  startupGraceMs: 120_000,
  staleActivityWindowMs: 600_000,
  failureCap: 3,
};

export type LivenessVerdictKind = "dead" | "stalled";

export interface LivenessVerdict {
  readonly kind: LivenessVerdictKind;
  readonly reason: string;
  /**
   * Stalled-only: the effective "last runtime activity" ms the stall was
   * measured against. Serves as the stall-episode key — the nudge/escalation
   * ladder dedups on it (same value across sweeps = still frozen since the
   * nudge -> escalate) and re-arms when it advances (the child made progress).
   */
  readonly effectiveActivityMs?: number;
}

const turnStartMs = (latestTurn: OrchestrationLatestTurn | null): number | null => {
  if (latestTurn === null) return null;
  const iso = latestTurn.startedAt ?? latestTurn.requestedAt;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

export interface LivenessClassifyInput {
  readonly thread: OrchestrationThreadShell;
  readonly session: OrchestrationSession;
  readonly maxActivityCreatedAtMs: number | null;
  /** Persisted runtime heartbeat (ms), advanced on ANY runtime event. */
  readonly heartbeatMs: number | null;
  readonly failureCount: number;
  readonly now: number;
  readonly thresholds: LivenessSweepThresholds;
}

/**
 * Pure Stage-1 liveness classification for one active sub-thread. Returns the
 * verdict that should set it `error`, or `null` (healthy / waiting / within
 * grace). Caller guarantees the thread is a non-terminal sub-thread with a
 * session.
 */
export const classifyLiveness = (input: LivenessClassifyInput): LivenessVerdict | null => {
  const { session, thread, maxActivityCreatedAtMs, heartbeatMs, failureCount, now, thresholds } =
    input;

  // State B — waiting for input: a child with pending user input / approvals is
  // intentionally paused, not dead and not stalled. Never flag it a fault.
  if (thread.hasPendingUserInput || thread.hasPendingApprovals) return null;

  // State A — dead (circuit breaker): a session sustained in a failed state
  // past the cap (objective fault).
  if (failureCount >= thresholds.failureCap) {
    return {
      kind: "dead",
      reason: `Session repeatedly failed (${failureCount} consecutive sweeps in a failed/absent state); circuit breaker tripped.`,
    };
  }

  // State C — stall: an open turn whose runtime heartbeat has frozen past the
  // window. Gated by the startup grace so a slow first tool call is not a stall.
  if (session.activeTurnId !== null) {
    const startedAtMs = turnStartMs(thread.latestTurn);
    const turnAgeMs = startedAtMs === null ? 0 : now - startedAtMs;
    if (turnAgeMs < thresholds.startupGraceMs) return null;

    // Measure against the real heartbeat (token/reasoning deltas included),
    // falling back to activity-row freshness / turn start when it is absent
    // (e.g. right after a restart). Take the newest of the three.
    const lastActivityMs =
      Math.max(heartbeatMs ?? 0, maxActivityCreatedAtMs ?? 0, startedAtMs ?? 0) || now;
    const sinceActivityMs = now - lastActivityMs;
    if (sinceActivityMs > thresholds.staleActivityWindowMs) {
      return {
        kind: "stalled",
        reason: `Mid-turn stall: no runtime activity for ${Math.round(sinceActivityMs / 1000)}s during an open turn.`,
        effectiveActivityMs: lastActivityMs,
      };
    }
  }

  return null;
};

export type StallAction = "nudge" | "escalate";

/**
 * Pure stall escalation-ladder decision. `nudge` on the FIRST sweep of a stall
 * episode (drive one informed recovery steer); `escalate` when the same episode
 * is still frozen on a later sweep (the nudge did not unstick it) OR when there
 * is no open turn to steer into (a closed turn must never be turned into a fresh
 * §8 `start`). A changed `episodeMs` (heartbeat advanced) re-arms to `nudge`.
 */
export const decideStallAction = (input: {
  readonly priorEpisodeMs: number | null;
  readonly episodeMs: number;
  readonly hasOpenTurn: boolean;
}): StallAction =>
  input.priorEpisodeMs === input.episodeMs ? "escalate" : input.hasOpenTurn ? "nudge" : "escalate";

/** In-band control-plane framing so the child treats the nudge as a system
 * signal, not a directive from the user. */
const CONTROL_PLANE_MARKER = "[T3 Workstream control plane — automated notice, not from the user]";

/**
 * The informed recovery-nudge message sent into a stalled child's open turn:
 * the control-plane marker, what we observed, the extracted account of what
 * happened, and an instruction to recover or explain a genuine block.
 */
export const buildStallNudgeMessage = (
  verdict: LivenessVerdict,
  context: StallContext | null,
): string =>
  [
    CONTROL_PLANE_MARKER,
    "",
    `Your current turn appears to have stalled (${verdict.reason}). This is an automated recovery nudge, not a message from the user.`,
    "",
    "What we found in your session transcript:",
    "",
    renderStallContext(context),
    "",
    "Continue from where you left off: address the issue above and proceed, or — if you are genuinely blocked — stop and explain what you need (raise `needs_guidance`).",
  ].join("\n");

const makeWorkstreamLivenessSweep = (
  thresholds: LivenessSweepThresholds = DEFAULT_LIVENESS_THRESHOLDS,
) =>
  Effect.gen(function* () {
    const orchestrationEngine = yield* OrchestrationEngineService;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const directory = yield* ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;

    // Consecutive failed-state observations per thread (the circuit-breaker
    // counter). Reset to 0 the moment the thread is observed healthy. Plain
    // mutable state is safe: the sweep runs serially on a single fiber.
    const failureCounts = new Map<string, number>();

    // Per-thread stall-nudge bookkeeping (serial-safe, mirroring failureCounts).
    // Keyed by the stall-episode signature (`effectiveActivityMs`): once we have
    // nudged an episode, a later sweep that reports the SAME signature means the
    // child is still frozen since the nudge -> escalate; a different signature
    // (heartbeat advanced) means progress -> re-arm and nudge the new episode.
    // The extracted context is stashed so escalation can reuse it without a
    // second transcript read.
    const stallNudges = new Map<
      string,
      { readonly episodeMs: number; readonly context: StallContext | null }
    >();

    const appendLivenessActivity = (
      thread: OrchestrationThreadShell,
      verdict: LivenessVerdict,
      summary: string,
      idSuffix: string,
      now: string,
    ) =>
      crypto.randomUUIDv4.pipe(
        Effect.flatMap((uuid) =>
          orchestrationEngine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`server:workstream-liveness:${idSuffix}:${thread.id}`),
            threadId: thread.id,
            activity: {
              id: EventId.make(uuid),
              tone: "error",
              kind: `workstream.liveness.${verdict.kind}`,
              summary,
              payload: { kind: verdict.kind },
              turnId: null,
              createdAt: now,
            },
            createdAt: now,
          } satisfies OrchestrationCommand),
        ),
      );

    // State A (dead): raise attention `error` (server-only) + a lean activity
    // row. Deterministic thread-keyed ids make the write idempotent across
    // restarts (an already-`error` thread is skipped next sweep anyway).
    const markDead = Effect.fn("workstreamLiveness.markDead")(function* (
      thread: OrchestrationThreadShell,
      verdict: LivenessVerdict,
    ) {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(`server:workstream-liveness:error:${thread.id}`),
        threadId: thread.id,
        reason: "error",
        createdAt: now,
      } satisfies OrchestrationCommand);
      yield* appendLivenessActivity(thread, verdict, verdict.reason, "error-reason", now);
    });

    // State C step 1 (informed nudge): drive ONE recovery turn into the child's
    // still-open turn, carrying what we extracted from its transcript. Reuses
    // the existing send-turn path: a `thread.turn.start` (no `requireIdle`, no
    // `setInProgress`) becomes a `streamingBehavior:"steer"` in PiDriver because
    // the turn is open — so it folds into the live agent loop rather than
    // starting a fresh turn, and writes neither plan lane nor stored attention.
    // The `server:`-prefixed, episode-keyed id keeps it idempotent within an
    // episode and distinct across re-armed episodes. AUTHORISATION: sanctioned
    // as a pure runtime steer by the status-model author (see progress.md) and
    // guarded on an open turn by the caller — a steer is not a §8 "start".
    const nudgeStall = Effect.fn("workstreamLiveness.nudgeStall")(function* (
      thread: OrchestrationThreadShell,
      verdict: LivenessVerdict,
      context: StallContext | null,
      episodeMs: number,
    ) {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* orchestrationEngine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:workstream-liveness:nudge:${thread.id}:${episodeMs}`),
        threadId: thread.id,
        message: {
          messageId: MessageId.make(yield* crypto.randomUUIDv4),
          role: "user",
          text: buildStallNudgeMessage(verdict, context),
          attachments: [],
        },
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: now,
      } satisfies OrchestrationCommand);
      yield* appendLivenessActivity(
        thread,
        verdict,
        `Recovery nudge sent: ${verdict.reason}`,
        `nudge:${episodeMs}`,
        now,
      );
    });

    // State C step 2 (escalate): the child is still frozen since the nudge.
    // Raise attention `needs_guidance` (recoverable — a human/poke is needed,
    // NOT `error`) carrying the extracted context so the human sees *why*.
    // Episode-keyed ids allow a fresh escalation after a re-armed episode.
    const escalateStall = Effect.fn("workstreamLiveness.escalateStall")(function* (
      thread: OrchestrationThreadShell,
      verdict: LivenessVerdict,
      context: StallContext | null,
      episodeMs: number,
    ) {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(
          `server:workstream-liveness:stall-escalate:${thread.id}:${episodeMs}`,
        ),
        threadId: thread.id,
        reason: "needs_guidance",
        createdAt: now,
      } satisfies OrchestrationCommand);
      yield* appendLivenessActivity(
        thread,
        verdict,
        `${verdict.reason} A recovery nudge did not unstick it. ${renderStallContext(context)}`,
        `stall-escalate-reason:${episodeMs}`,
        now,
      );
    });

    const sweep = Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const now = yield* Clock.currentTimeMillis;
      const boundThreadIds = new Set(
        (yield* directory.listBindings()).map((binding) => binding.threadId),
      );
      let actionedCount = 0;

      for (const thread of snapshot.threads) {
        // Only sub-threads; never re-judge a plan-terminal thread, nor one that
        // already carries an attention flag (already error-marked / paused on a
        // human — left alone, mirroring the old terminal-status skip).
        if (
          thread.parentThreadId === null ||
          thread.planLane === "done" ||
          thread.planLane === "cancelled" ||
          thread.attention.length > 0
        ) {
          failureCounts.delete(thread.id);
          stallNudges.delete(thread.id);
          continue;
        }
        const session = thread.session;
        // No session → never started; the dispatcher promotes it, not the sweep.
        if (session === null) {
          failureCounts.delete(thread.id);
          stallNudges.delete(thread.id);
          continue;
        }

        // A failed observation: the runtime reported a session error, or the
        // read model thinks a turn is active but the provider binding is gone
        // (a crash that never emitted `session.exited`).
        const failureObserved =
          session.status === "error" ||
          (session.activeTurnId !== null && !boundThreadIds.has(thread.id));
        const failureCount = failureObserved ? (failureCounts.get(thread.id) ?? 0) + 1 : 0;
        if (failureObserved) failureCounts.set(thread.id, failureCount);
        else failureCounts.delete(thread.id);

        const freshness = yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(thread.id);

        const verdict = classifyLiveness({
          thread,
          session,
          maxActivityCreatedAtMs: freshness.maxCreatedAt
            ? Date.parse(freshness.maxCreatedAt)
            : null,
          heartbeatMs: freshness.heartbeatAt ? Date.parse(freshness.heartbeatAt) : null,
          failureCount,
          now,
          thresholds,
        });
        // Healthy / waiting / within grace: re-arm any stall episode so the
        // child can be nudged afresh if it stalls again later.
        if (verdict === null) {
          stallNudges.delete(thread.id);
          continue;
        }

        const runAction = <E>(label: string, action: Effect.Effect<void, E>) =>
          action.pipe(
            Effect.tap(() =>
              Effect.logInfo(label, {
                threadId: thread.id,
                kind: verdict.kind,
                reason: verdict.reason,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning(`${label}-failed`, { threadId: thread.id, cause }),
            ),
          );

        // State A (dead): unrecoverable fault -> attention `error`.
        if (verdict.kind === "dead") {
          yield* runAction("workstream.liveness.dead", markDead(thread, verdict));
          failureCounts.delete(thread.id);
          stallNudges.delete(thread.id);
          actionedCount += 1;
          continue;
        }

        // State C (stall): the escalation ladder. The classifier only returns
        // `stalled` for an open turn; the `hasOpenTurn` guard is belt-and-
        // suspenders against ever turning a closed turn into a fresh `start`.
        const episodeMs = verdict.effectiveActivityMs ?? 0;
        const prior = stallNudges.get(thread.id);
        const action = decideStallAction({
          priorEpisodeMs: prior?.episodeMs ?? null,
          episodeMs,
          hasOpenTurn: session.activeTurnId !== null,
        });
        if (action === "escalate") {
          // Still frozen since the nudge (recoverable, needs a human).
          yield* runAction(
            "workstream.liveness.stall-escalate",
            escalateStall(thread, verdict, prior?.context ?? null, episodeMs),
          );
          stallNudges.delete(thread.id);
          actionedCount += 1;
          continue;
        }
        // First sweep of this episode -> ONE informed nudge into the open turn.
        const context = yield* readThreadStallContext(thread.id);
        yield* runAction(
          "workstream.liveness.stall-nudge",
          nudgeStall(thread, verdict, context, episodeMs),
        );
        stallNudges.set(thread.id, { episodeMs, context });
        actionedCount += 1;
      }

      if (actionedCount > 0) {
        yield* Effect.logInfo("workstream.liveness.sweep-complete", {
          actionedCount,
          totalThreads: snapshot.threads.length,
        });
      }
    });

    const start: WorkstreamLivenessSweepShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("workstream.liveness.sweep-failed", { error }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("workstream.liveness.sweep-defect", { defect }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(thresholds.sweepIntervalMs))),
          ),
        );
        yield* Effect.logInfo("workstream.liveness.started", {
          sweepIntervalMs: thresholds.sweepIntervalMs,
          staleActivityWindowMs: thresholds.staleActivityWindowMs,
          startupGraceMs: thresholds.startupGraceMs,
        });
      });

    return { start } satisfies WorkstreamLivenessSweepShape;
  });

export const makeWorkstreamLivenessSweepLive = (thresholds?: LivenessSweepThresholds) =>
  Layer.effect(WorkstreamLivenessSweep, makeWorkstreamLivenessSweep(thresholds));

export const WorkstreamLivenessSweepLive = makeWorkstreamLivenessSweepLive();
