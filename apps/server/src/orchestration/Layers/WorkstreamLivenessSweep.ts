import {
  CommandId,
  EventId,
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
      };
    }
  }

  return null;
};

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

    const markError = Effect.fn("workstreamLiveness.markError")(function* (
      thread: OrchestrationThreadShell,
      verdict: LivenessVerdict,
    ) {
      const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
      // Deterministic server-built command ids: the `server:` prefix satisfies
      // the decider's server-only `error` guard, and keying by thread id makes
      // the write idempotent across restarts (a thread already `error` is
      // skipped next sweep anyway). The reason rides a `thread.activity.append`
      // (tone error) so the attention raise stays lean — mirrors the dispatcher
      // park marker.
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(`server:workstream-liveness:error:${thread.id}`),
        threadId: thread.id,
        reason: "error",
        createdAt: now,
      } satisfies OrchestrationCommand);
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:workstream-liveness:error-reason:${thread.id}`),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "error",
          kind: `workstream.liveness.${verdict.kind}`,
          summary: verdict.reason,
          payload: { kind: verdict.kind },
          turnId: null,
          createdAt: now,
        },
        createdAt: now,
      } satisfies OrchestrationCommand);
    });

    const sweep = Effect.gen(function* () {
      const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
      const now = yield* Clock.currentTimeMillis;
      const boundThreadIds = new Set(
        (yield* directory.listBindings()).map((binding) => binding.threadId),
      );
      let erroredCount = 0;

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
          continue;
        }
        const session = thread.session;
        // No session → never started; the dispatcher promotes it, not the sweep.
        if (session === null) {
          failureCounts.delete(thread.id);
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
        if (verdict === null) continue;

        yield* markError(thread, verdict).pipe(
          Effect.tap(() =>
            Effect.logInfo("workstream.liveness.error-set", {
              threadId: thread.id,
              kind: verdict.kind,
              reason: verdict.reason,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("workstream.liveness.error-set-failed", {
              threadId: thread.id,
              kind: verdict.kind,
              cause,
            }),
          ),
        );
        failureCounts.delete(thread.id);
        erroredCount += 1;
      }

      if (erroredCount > 0) {
        yield* Effect.logInfo("workstream.liveness.sweep-complete", {
          erroredCount,
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
