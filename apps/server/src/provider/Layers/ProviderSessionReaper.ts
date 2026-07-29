import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
      let reapedCount = 0;
      let prunedCount = 0;

      for (const binding of bindings) {
        // loom: retention. Stopped bindings are deliberately kept so a session can be
        // resumed from its persisted provider pointer after a restart, but they
        // were never removed either, so the table grew forever and every read of
        // it got slower. Prune only the provably-dead class: a stopped session
        // whose thread no longer exists as a live thread. `getThreadShellById`
        // selects `deleted_at IS NULL AND archived_at IS NULL`, so a None here
        // means the thread is deleted or archived and there is no UI path left
        // that could ask this session to resume.
        //
        // Deliberately NOT age-based: `runStopAll` rewrites every binding at
        // shutdown, which resets `lastSeenAt` on all stopped rows (observed:
        // 1311 of 1326 rows sharing a single minute). Age measured from
        // `lastSeenAt` is therefore not a liveness signal at all — it would sit
        // at ~0 across restarts and then expire the whole table at once.
        if (binding.status === "stopped") {
          // Only a definitive None ("no live thread row") authorises deletion. A
          // read FAILURE must never be read as absence, so it is mapped back to
          // a keep rather than allowed to fall through to the delete.
          const liveness = yield* projectionSnapshotQuery.getThreadShellById(binding.threadId).pipe(
            Effect.map((thread) => (Option.isSome(thread) ? "live" : "absent")),
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.liveness-read-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as("unknown" as const)),
            ),
          );
          if (liveness !== "absent") {
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
              reason: "thread_deleted_or_archived",
            });
          }
          continue;
        }

        // Reaping a LIVE session is age-based, and only this branch needs the
        // timestamp (retention above is judged from thread liveness instead, so
        // a corrupt timestamp must not keep a dead thread's row forever).
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

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
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
