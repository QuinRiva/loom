import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadBackgroundLivenessService } from "../../orchestration/ThreadBackgroundLiveness.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Idle threshold for a TERMINAL (`done`/`cancelled`), obligation-free thread.
 *
 * Such a thread's work is finished: its own turn has ended, it owes no children,
 * dependencies, user input or rework round (the guards below), and a human who
 * resumes it simply re-spawns the process from its persisted provider binding.
 * Keeping it warm for the full 30 minutes buys back only the launch latency of a
 * resume that usually never comes, and costs two things that measurably hurt:
 *
 *  - ~30 minutes of idle agent RSS per completed child (measured: `pi` at
 *    ~3.2 GB across 9 processes inside a ~9.6 GB unit footprint), and
 *  - ~30 minutes of WORKSPACE OCCUPANCY on the child's worktree. A gated coder's
 *    worktree is ATTACHED by its reviewer, so the last occupant is the reviewer,
 *    whose idle clock starts after the coder's — which is why every fanned-in
 *    child's worktree stayed undeletable for 25–30 minutes after fan-in, with the
 *    fan-in reactor retrying (correctly, and cheaply) throughout.
 *
 * Five minutes is chosen to match the sweep interval: it is the shortest
 * threshold that still expresses a real idle period rather than "reap at the next
 * sweep whatever happens", and it puts the effective reap window at 5–10 minutes
 * after last activity. The lease's guarantee — never delete a worktree with a
 * live process in it — is untouched; only the point at which the process stops
 * being live moves earlier.
 */
const DEFAULT_TERMINAL_INACTIVITY_THRESHOLD_MS = 5 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const isTerminalLane = (planLane: string): boolean =>
  planLane === "done" || planLane === "cancelled";

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly terminalInactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const terminalInactivityThresholdMs = Math.min(
      inactivityThresholdMs,
      Math.max(
        1,
        options?.terminalInactivityThresholdMs ?? DEFAULT_TERMINAL_INACTIVITY_THRESHOLD_MS,
      ),
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      // Stopped rows stay for their resume cursors and far outnumber live
      // ones, so the query skips them.
      const bindings = yield* directory.listBindings({ excludeStopped: true });
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      // loom: retention. Upstream never removes a stopped binding, so the table
      // grows forever. Prune only the IRREVERSIBLE class — stopped bindings of
      // deleted threads — as one SQL statement per sweep. Archived threads are
      // excluded on purpose: `thread.archive` has `thread.unarchive`, so an
      // archived thread must keep its provider pointer; deletion has no undo.
      // Deliberately NOT age-based: `runStopAll` rewrites every unsettled
      // binding's `lastSeenAt` at shutdown, so age is not a liveness signal.
      // A failed statement deletes nothing, so it prunes nothing.
      const pruned = yield* directory.pruneStoppedForDeletedThreads().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.reaper.prune-failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as([] as ReadonlyArray<ThreadId>)),
        ),
      );
      const prunedCount = pruned.length;
      for (const threadId of pruned) {
        yield* Effect.logInfo("provider.session.binding-pruned", {
          threadId,
          reason: "thread_deleted",
        });
      }

      for (const binding of bindings) {
        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;

        // Gate on the SHORTER of the two thresholds, then let the obligations row
        // (which carries the plan lane for free) decide whether the longer one
        // applies. The extra cost is one narrow read per sweep for the handful of
        // live sessions idle between the two thresholds; the alternative — a bulk
        // terminal-lane set read — would pull ~1,000 ids every sweep to answer a
        // question about ~10 bindings.
        if (idleDurationMs < terminalInactivityThresholdMs) {
          continue;
        }

        // One narrow read carries the whole liveness verdict: the thread's active
        // turn plus its outstanding obligations.
        const obligations = yield* projectionSnapshotQuery.getThreadObligations(binding.threadId);
        if (!isTerminalLane(obligations.planLane) && idleDurationMs < inactivityThresholdMs) {
          continue;
        }
        if (obligations.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: obligations.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        // An active turn is not the only form of liveness. The dominant shape in
        // this product is an ORCHESTRATOR waiting on children it spawned: its own
        // turn ended when it finished spawning, and its binding's `lastSeenAt` is
        // bumped only by its OWN activity (each child has its own runtime row),
        // so a parent whose child runs for two hours looks exactly as idle as an
        // abandoned session — and was reaped at the 30-minute mark every time.
        // Same for a thread parked on an open question: stopping it force-cancels
        // every open request, destroying a slow human's pending answer.
        //
        // So: reap ≝ idle AND no outstanding obligations. Genuinely abandoned
        // sessions (all children terminal, nothing open) still reap on idleness —
        // this guard must never turn into "never reap". Note a thread's own
        // pending fan-in is deliberately NOT an obligation: fan-in is pure git
        // work that never touches the provider, so counting it would leak the
        // process of every ordinary isolated coder forever.
        const pendingReasons = [
          obligations.liveChildCount > 0 ? "live_children" : null,
          obligations.hasUnmetDependencies ? "unmet_dependencies" : null,
          obligations.openUserInputCount > 0 ? "open_user_input" : null,
          obligations.pendingRework ? "pending_rework" : null,
        ].filter((reason): reason is string => reason !== null);
        if (pendingReasons.length > 0) {
          // Info, not debug: "why is this session still alive after hours idle"
          // is a routine debugging question, and the answer must be in the log
          // someone actually has at default level.
          yield* Effect.logInfo("provider.session.reaper.skipped-pending-work", {
            threadId: binding.threadId,
            provider: binding.provider,
            idleDurationMs,
            reasons: pendingReasons,
            liveChildCount: obligations.liveChildCount,
            openUserInputCount: obligations.openUserInputCount,
          });
          continue;
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        //
        // Read from the in-memory liveness registry rather than upstream's
        // `getThreadShellById` (six SQL statements per binding — the cost this
        // sweep deliberately avoids, see the retention note above).
        const backgroundLiveness = threadBackgroundLiveness.getThreadBackgroundLiveness(
          binding.threadId,
        );
        if (backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              planLane: obligations.planLane,
              reason: isTerminalLane(obligations.planLane)
                ? "terminal_inactivity_threshold"
                : "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0 || prunedCount > 0) {
        // loom: retention
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          prunedCount, // loom: retention
          liveBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          terminalInactivityThresholdMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
