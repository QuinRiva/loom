import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      // loom: one query for the whole deleted-thread set. Classifying each
      // stopped binding with `getThreadShellById` instead would cost six
      // statements per row on the single serial SQL connection, every sweep —
      // a periodic global stall of exactly the kind this work exists to remove.
      // A failed read yields an empty set, which prunes nothing.
      const deletedThreadIds = yield* projectionSnapshotQuery.getDeletedThreadIds().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("provider.session.reaper.deleted-threads-read-failed", {
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(new Set<ThreadId>())),
        ),
      );
      let reapedCount = 0;
      let prunedCount = 0;

      for (const binding of bindings) {
        // loom: retention. Stopped bindings are deliberately kept so a session can be
        // resumed from its persisted provider pointer after a restart, but they
        // were never removed either, so the table grew forever and every read of
        // it got slower. Prune only the IRREVERSIBLE class: a stopped session
        // whose thread has been deleted. Archived threads are excluded on
        // purpose — `thread.archive` has a matching `thread.unarchive` command
        // and UI affordance, so an archived thread can be restored and must keep
        // its provider pointer; there is no undelete counterpart.
        //
        // Deliberately NOT age-based: `runStopAll` rewrites every binding at
        // shutdown, which resets `lastSeenAt` on all stopped rows (observed:
        // 1311 of 1326 rows sharing a single minute). Age measured from
        // `lastSeenAt` is therefore not a liveness signal at all — it would sit
        // at ~0 across restarts and then expire the whole table at once.
        if (binding.status === "stopped") {
          if (!deletedThreadIds.has(binding.threadId)) {
            continue;
          }
          // Conditional delete: the decision above is made from a `listBindings`
          // snapshot, so a concurrent start/recovery may have re-upserted this
          // row to `running` since. Deleting by thread id alone would drop a
          // live session's routing binding and strand the next command with
          // "no persisted provider binding exists".
          const pruned = yield* directory.removeIfStopped(binding.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.prune-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as(false)),
            ),
          );
          if (pruned) {
            prunedCount += 1;
            yield* Effect.logInfo("provider.session.binding-pruned", {
              threadId: binding.threadId,
              provider: binding.provider,
              reason: "thread_deleted",
            });
          }
          continue;
        }

        // Reaping a LIVE session is age-based, and only this branch needs the
        // timestamp (retention above is judged from thread deletion instead, so
        // a corrupt timestamp must not keep a deleted thread's row forever).
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

        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        // One narrow read carries the whole liveness verdict: the thread's active
        // turn plus its outstanding obligations.
        const obligations = yield* projectionSnapshotQuery.getThreadObligations(binding.threadId);
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

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
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
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          prunedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* Effect.forkScoped(
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
