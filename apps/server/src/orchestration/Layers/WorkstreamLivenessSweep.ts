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
 * State D ("possibly spinning") kill switch — the prototype-grade on/off.
 * State D is the highest false-positive risk, so it is gated by this single
 * top-of-file boolean: flip it to `false` and the ENTIRE State-D branch
 * short-circuits with zero other edits. The branch, its per-thread map, its
 * pure helpers, and its thresholds are all tagged "State D" so it can equally
 * be commented out / deleted in one pass. No config plumbing — the one-liner is
 * the point.
 */
const ENABLE_STATE_D = true;

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
  /**
   * State C: how long after a recovery nudge the same frozen episode must still
   * be frozen before escalating. Gives the nudge a real chance to unstick the
   * child (a steer is folded in between model rounds) instead of escalating on
   * the very next 60s sweep.
   */
  readonly stallNudgeGraceMs: number;
  /**
   * State D: how long a busy thread's work-product fingerprint must stay flat
   * (while the heartbeat keeps advancing) before raising a possible-spin
   * advisory. Tunable assumption — starts generous at 10m to avoid firing on
   * slow-but-real work; tune down from real runs.
   */
  readonly noProgressWindowMs: number;
  /**
   * State D: how many of the most recent tool calls feed the work-product
   * content fingerprint. Larger = stricter (more content must stay identical to
   * read as flat) and strictly safer against false positives.
   */
  readonly progressInputSampleSize: number;
}

export const DEFAULT_LIVENESS_THRESHOLDS: LivenessSweepThresholds = {
  sweepIntervalMs: 60_000,
  startupGraceMs: 120_000,
  staleActivityWindowMs: 600_000,
  failureCap: 3,
  stallNudgeGraceMs: 120_000,
  noProgressWindowMs: 600_000,
  progressInputSampleSize: 16,
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
  /**
   * A tool call is currently in flight (class 2): a quiet-but-running tool is
   * NOT a stall — a steer cannot penetrate a blocked call and long calls are
   * often legitimate. The dispatcher's informational slow-tool rail owns it,
   * so State C never fires while this is true.
   */
  readonly hasInFlightTool: boolean;
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
  const {
    session,
    thread,
    maxActivityCreatedAtMs,
    heartbeatMs,
    hasInFlightTool,
    failureCount,
    now,
    thresholds,
  } = input;

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
  // window. Gated by the startup grace so a slow first tool call is not a stall,
  // and suppressed entirely while a tool call is in flight (class 2 — the
  // slow-but-alive case is informational, never a fault).
  if (session.activeTurnId !== null && !hasInFlightTool) {
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

export type StallAction = "nudge" | "escalate" | "wait";

/**
 * Pure stall escalation-ladder decision. `nudge` on the FIRST sweep of a stall
 * episode (drive one informed recovery steer); `escalate` when the same episode
 * is still frozen after the nudge grace elapsed (the nudge did not unstick it)
 * OR when there is no open turn to steer into (a closed turn must never be
 * turned into a fresh §8 `start`); `wait` while the same episode is frozen but
 * the nudge is still within its grace (give the steer a chance to be folded
 * in). A changed `episodeMs` (heartbeat advanced) re-arms to `nudge`.
 */
export const decideStallAction = (input: {
  readonly priorEpisodeMs: number | null;
  readonly episodeMs: number;
  readonly hasOpenTurn: boolean;
  /** ms since this episode was nudged; null when it never was. */
  readonly msSinceNudge: number | null;
  readonly nudgeGraceMs: number;
}): StallAction =>
  input.priorEpisodeMs === input.episodeMs
    ? input.msSinceNudge !== null && input.msSinceNudge < input.nudgeGraceMs
      ? "wait"
      : "escalate"
    : input.hasOpenTurn
      ? "nudge"
      : "escalate";

// ─── State D — possibly spinning (progress, not repetition) ──────────────────
// Pure helpers + per-thread state shape for the busy-but-not-progressing
// advisory. All of this is only reached behind `ENABLE_STATE_D` and is
// deletable as one labelled unit.

/** cyrb53 — a cheap, deterministic, non-cryptographic string hash. Collapses a
 * (potentially large) work-product source into a compact comparable fingerprint
 * stored per-thread across sweeps; collision risk is irrelevant for
 * change-detection. */
const hashSource = (source: string): string => {
  let h1 = 0xdeadbeef ^ source.length;
  let h2 = 0x41c6ce57 ^ source.length;
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
};

/**
 * The work-product fingerprint for State D. INVERTS §3d's literal ordering
 * (which named the checkpoint diff as primary): evidence shows checkpoints only
 * materialise at TURN END, so for a single-turn sub-thread the checkpoint diff
 * is flat for the whole working turn and cannot distinguish slow real work from
 * spinning. The within-turn tool-call CONTENT (`rawInput`/diff) is the only
 * signal that grows with distinct edits, so it is primary; the checkpoint
 * source is OR-folded in as a cross-turn corroborator. Sanctioned high-
 * confidence by the architecture author (progress.md). Hashing the actual
 * content, not the display projection, is load-bearing — the display string
 * re-collapses distinct calls and is the exact retired-loop-detector bug.
 */
export const computeProgressFingerprint = (signal: {
  readonly recentInputsSource: string | null;
  readonly checkpointSource: string | null;
}): string =>
  hashSource(`${signal.checkpointSource ?? ""}\u0000${signal.recentInputsSource ?? ""}`);

/** Per-thread State-D bookkeeping: the last work-product fingerprint, when it
 * was first seen at that value (the flat-since clock), and whether this episode
 * has already been advised (dedup → at most once per episode). */
export interface ProgressLoopState {
  readonly fingerprint: string;
  readonly flatSinceMs: number;
  readonly advised: boolean;
}

/**
 * Pure State-D decision. Re-arm (reset the flat clock, clear `advised`) the
 * moment the fingerprint changes or on first observation — a growing/oscillating
 * diff therefore NEVER advises. Advise exactly once, when the fingerprint has
 * stayed flat for `noProgressWindowMs` and this episode has not been advised
 * yet. The caller only invokes this for a genuinely busy thread (open turn,
 * heartbeat advancing), so frozen-heartbeat stalls are State C, never here.
 */
export const decideProgressLoop = (input: {
  readonly prior: ProgressLoopState | null;
  readonly fingerprint: string;
  readonly now: number;
  readonly noProgressWindowMs: number;
}): { readonly next: ProgressLoopState; readonly advise: boolean } => {
  const { prior, fingerprint, now, noProgressWindowMs } = input;
  if (prior === null || prior.fingerprint !== fingerprint) {
    return { next: { fingerprint, flatSinceMs: now, advised: false }, advise: false };
  }
  if (!prior.advised && now - prior.flatSinceMs >= noProgressWindowMs) {
    return { next: { ...prior, advised: true }, advise: true };
  }
  return { next: prior, advise: false };
};

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
      {
        readonly episodeMs: number;
        readonly nudgedAtMs: number;
        readonly context: StallContext | null;
      }
    >();

    // State D: per-thread work-product fingerprint bookkeeping (serial-safe,
    // mirroring stallNudges). Cleared whenever the thread is not a busy,
    // progressing sub-thread so a fresh episode re-arms cleanly.
    const progressLoop = new Map<string, ProgressLoopState>();

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
    // The parent AGENT hears about it too: the dispatcher's frozen-attention
    // rail notices a flagged child whose open turn stays quiet and delivers a
    // per-child pause notice (the idle-gated rail alone would never fire while
    // the wedged turn stays open).
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

    // State D (possibly spinning): a NON-TERMINAL advisory. Wakes the parent via
    // attention `needs_guidance` (system-raised — sanctioned high-confidence by
    // the status-model author, see progress.md; `error` would over-escalate a
    // heuristic to a failure verdict) plus an `info` activity carrying the
    // evidence. Sets NO plan lane and never kills the thread — it keeps running.
    // Episode-keyed (`flatSinceMs`) server-prefixed ids keep it idempotent within
    // an episode and re-armable across episodes.
    const adviseProgressLoop = Effect.fn("workstreamLiveness.adviseProgressLoop")(function* (
      thread: OrchestrationThreadShell,
      busyMinutes: number,
      episodeMs: number,
    ) {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      const summary =
        `Possibly spinning: busy for ~${busyMinutes} min (heartbeat advancing) but the ` +
        `work product has not changed — no new edits/tool inputs and no checkpoint ` +
        `progress over the window. Automated advisory for the parent to judge; not a ` +
        `fault, and the thread is still running.`;
      const uuid = yield* crypto.randomUUIDv4;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(
          `server:workstream-liveness:progress-loop:${thread.id}:${episodeMs}`,
        ),
        threadId: thread.id,
        activity: {
          id: EventId.make(uuid),
          tone: "info",
          kind: "workstream.liveness.progress-loop",
          summary,
          payload: { kind: "progress-loop", busyMinutes },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      } satisfies OrchestrationCommand);
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(
          `server:workstream-liveness:progress-loop-attn:${thread.id}:${episodeMs}`,
        ),
        threadId: thread.id,
        reason: "needs_guidance",
        createdAt: now,
      } satisfies OrchestrationCommand);
    });

    const sweep = Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const now = yield* Clock.currentTimeMillis;
      const boundThreadIds = new Set(
        (yield* directory.listBindings()).map((binding) => binding.threadId),
      );
      let actionedCount = 0;

      for (const thread of snapshot.threads) {
        // Only sub-threads; never re-judge a plan-terminal thread.
        if (
          thread.parentThreadId === null ||
          thread.planLane === "done" ||
          thread.planLane === "cancelled"
        ) {
          failureCounts.delete(thread.id);
          stallNudges.delete(thread.id);
          progressLoop.delete(thread.id);
          continue;
        }
        const session = thread.session;
        // No session → never started; the dispatcher promotes it, not the sweep.
        if (session === null) {
          failureCounts.delete(thread.id);
          stallNudges.delete(thread.id);
          progressLoop.delete(thread.id);
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

        // An attention-flagged thread (error-marked, paused on a human, a stall
        // escalation) is never nudged or advised again — but it can still DIE,
        // so the State-A circuit breaker keeps judging it. (Previously the sweep
        // skipped flagged threads wholesale, ending ALL liveness judgement the
        // moment any flag was raised.)
        if (thread.attention.length > 0) {
          stallNudges.delete(thread.id);
          progressLoop.delete(thread.id);
          if (failureCount >= thresholds.failureCap && !thread.attention.includes("error")) {
            const verdict: LivenessVerdict = {
              kind: "dead",
              reason: `Session repeatedly failed (${failureCount} consecutive sweeps in a failed/absent state); circuit breaker tripped.`,
            };
            yield* markDead(thread, verdict).pipe(
              Effect.tap(() =>
                Effect.logInfo("workstream.liveness.dead", {
                  threadId: thread.id,
                  kind: verdict.kind,
                  reason: verdict.reason,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("workstream.liveness.dead-failed", {
                  threadId: thread.id,
                  cause,
                }),
              ),
            );
            failureCounts.delete(thread.id);
            actionedCount += 1;
          }
          continue;
        }

        const freshness = yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(thread.id);
        const inFlightTool =
          session.activeTurnId !== null
            ? yield* projectionSnapshotQuery.getInFlightToolByThreadId(
                thread.id,
                session.activeTurnId,
              )
            : null;

        const verdict = classifyLiveness({
          thread,
          session,
          maxActivityCreatedAtMs: freshness.maxCreatedAt
            ? Date.parse(freshness.maxCreatedAt)
            : null,
          heartbeatMs: freshness.heartbeatAt ? Date.parse(freshness.heartbeatAt) : null,
          hasInFlightTool: inFlightTool !== null,
          failureCount,
          now,
          thresholds,
        });
        // Healthy / waiting / within grace: re-arm any stall episode so the
        // child can be nudged afresh if it stalls again later.
        if (verdict === null) {
          stallNudges.delete(thread.id);

          // ── State D — possibly spinning (self-contained; ENABLE_STATE_D) ──
          // Only a genuinely BUSY thread qualifies: an open turn past the
          // startup grace whose heartbeat is fresh (guaranteed here — a frozen
          // heartbeat is State C, which returns a non-null verdict above). When
          // the cheap work-product fingerprint stays flat across the window
          // while the agent keeps emitting runtime events, wake the parent ONCE
          // with evidence. Flip ENABLE_STATE_D=false (top of file) to remove.
          // An in-flight tool call is exempt: the fingerprint only sees
          // `tool.completed` rows, so ONE long call reads as flat by
          // construction — that case belongs to the dispatcher's informational
          // slow-tool rail, never to a "possibly spinning" advisory.
          const startedAtMs = turnStartMs(thread.latestTurn);
          const busy =
            ENABLE_STATE_D &&
            session.activeTurnId !== null &&
            inFlightTool === null &&
            startedAtMs !== null &&
            now - startedAtMs >= thresholds.startupGraceMs;
          if (!busy) {
            progressLoop.delete(thread.id);
            continue;
          }
          const signal = yield* projectionSnapshotQuery.getThreadProgressSignal(
            thread.id,
            thresholds.progressInputSampleSize,
          );
          const decision = decideProgressLoop({
            prior: progressLoop.get(thread.id) ?? null,
            fingerprint: computeProgressFingerprint(signal),
            now,
            noProgressWindowMs: thresholds.noProgressWindowMs,
          });
          progressLoop.set(thread.id, decision.next);
          if (decision.advise) {
            const busyMinutes = Math.round((now - decision.next.flatSinceMs) / 60_000);
            yield* adviseProgressLoop(thread, busyMinutes, decision.next.flatSinceMs).pipe(
              Effect.tap(() =>
                Effect.logInfo("workstream.liveness.progress-loop", {
                  threadId: thread.id,
                  busyMinutes,
                }),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning("workstream.liveness.progress-loop-failed", {
                  threadId: thread.id,
                  cause,
                }),
              ),
            );
            actionedCount += 1;
          }
          continue;
        }
        // Stalled / dead below: not a busy-progressing thread → drop any State-D
        // episode so it re-arms cleanly if the thread resumes work later.
        progressLoop.delete(thread.id);

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
          msSinceNudge: prior ? now - prior.nudgedAtMs : null,
          nudgeGraceMs: thresholds.stallNudgeGraceMs,
        });
        if (action === "wait") continue;
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
        stallNudges.set(thread.id, { episodeMs, nudgedAtMs: now, context });
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
