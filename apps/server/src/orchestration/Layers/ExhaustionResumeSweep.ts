import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";

import { ProviderHealthRegistry } from "../../provider/Services/ProviderHealthRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import {
  subscriptionScopeForSelection,
  usageSourceInstances,
} from "../../provider/exhaustionMapping.ts";
import { resolveFailoverTarget } from "../../provider/failoverChains.ts";
import { exhaustionPredicate, piCatalogueFromProviders } from "../../provider/failoverRouting.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  ExhaustionResumeSweep,
  type ExhaustionResumeSweepShape,
} from "../Services/ExhaustionResumeSweep.ts";

/**
 * ExhaustionResumeSweep — reset-aware resume of quota-stalled threads (§6, D5).
 *
 * When no healthy fallback exists (failover disabled, or every chain target
 * exhausted), a quota-limited turn dies with `session.status = "error"` and
 * `lastErrorClass = "quota_exhausted"`. This 60s sweep watches that persisted
 * state and, once the thread's INTENDED provider is healthy again (window reset
 * or mark cleared), dispatches a control-plane resume turn — the never-delivered
 * work is the contract, so both workstream children and standalone threads
 * resume identically (global `resumeOnReset` opts out).
 *
 * Eligibility (§6): a thread resumes once EITHER its intended account/model is
 * healthy again OR (failover on, pi selection) the shared
 * {@link resolveFailoverTarget} finds a healthy fallback that has since become
 * available — so a thread that stalled with every target down does not wait for
 * its own window when a fallback recovers first. Once the turn restarts, chunk
 * C's dispatch-time routing lands it on the concrete effective model. Direct
 * `codex`/`claudeAgent` selections never reroute (§9): they resume only when
 * their own account is healthy again.
 *
 * Restart-safe: the trigger is the persisted projection, not timers. The
 * per-thread cooldown is an in-memory tight-loop guard (a lying `resetsAt`
 * cannot spin); a resume that fails exhausted again simply re-enters the pool.
 *
 * @module ExhaustionResumeSweep
 */

const SWEEP_INTERVAL = Duration.seconds(60);
/** Minimum gap between resume attempts for one thread (tight-loop guard). */
export const RESUME_COOLDOWN_MS = 5 * 60_000;

/**
 * In-band control-plane framing for the resume re-prompt: same contract as
 * {@link buildPiRetryPrompt} — the limit has reset, nothing from the failed turn
 * was delivered, continue where you left off.
 */
export const buildExhaustionResumePrompt = (): string =>
  [
    "[T3 Code control plane — automated resume after a provider limit reset; not a message from the user]",
    "",
    "The provider usage limit that stalled your previous turn has reset; none of that response was delivered.",
    "Continue the task from where you left off.",
  ].join("\n");

/**
 * Pure resume decision for one quota-stalled thread. Resume iff the global
 * toggle is on, the intended provider is no longer exhausted, and the per-thread
 * cooldown has elapsed. Caller filters the projection down to genuinely stalled
 * threads before invoking this.
 */
export const decideResume = (input: {
  readonly resumeOnReset: boolean;
  /** Intended model healthy again, OR a healthy fallback is now reachable. */
  readonly providerReady: boolean;
  readonly lastAttemptMs: number | null;
  readonly now: number;
  readonly cooldownMs: number;
}): boolean =>
  input.resumeOnReset &&
  input.providerReady &&
  (input.lastAttemptMs === null || input.now - input.lastAttemptMs >= input.cooldownMs);

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const health = yield* ProviderHealthRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const settings = yield* ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  // Per-thread last-attempt clock (serial-safe: the sweep runs on one fiber).
  // In-memory only — a restart clears it (the projection is the real trigger).
  const lastAttempt = new Map<string, number>();

  const resumeThread = Effect.fn("exhaustionResume.resume")(function* (
    thread: OrchestrationThreadShell,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:exhaustion-resume:turn:${thread.id}:${Date.parse(now)}`),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        origin: "control_notice",
        text: buildExhaustionResumePrompt(),
        attachments: [],
      },
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: now,
    } satisfies OrchestrationCommand);
    // A lean info row so the work log explains the gap (standalone threads have
    // no orchestrator watching; the kick-off narration alone is easy to miss).
    yield* engine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:exhaustion-resume:note:${thread.id}:${Date.parse(now)}`),
      threadId: thread.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "exhaustion.resume",
        summary:
          "Provider subscription limit has reset — automatically resuming the turn that stalled on it.",
        payload: { kind: "resume" },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const sweep = Effect.gen(function* () {
    const currentSettings = yield* settings.getSettings;
    const failover = currentSettings.providerFailover;
    const usageInstances = usageSourceInstances(currentSettings.providerInstances);
    const snapshot = yield* projection.getShellSnapshot();
    const now = yield* Clock.currentTimeMillis;
    // One health snapshot + catalogue per tick (paused folded into the marks),
    // shared across every thread's intended-health check and fallback lookup.
    const isExhausted = exhaustionPredicate(yield* health.snapshot);
    const catalogue = piCatalogueFromProviders(yield* providerRegistry.getProviders);

    let resumedCount = 0;
    const stalledIds = new Set<string>();

    for (const thread of snapshot.threads) {
      const session = thread.session;
      // Only quota-stalled, non-active sessions on non-terminal threads. Both
      // workstream children and standalone roots qualify (D5) — no parent
      // filter. `activeTurnId !== null` guards against starting a fresh turn
      // over one already running (e.g. a resume from a prior tick landing).
      if (
        session === null ||
        session.status !== "error" ||
        session.lastErrorClass !== "quota_exhausted" ||
        session.activeTurnId !== null ||
        thread.planLane === "done" ||
        thread.planLane === "cancelled"
      ) {
        continue;
      }
      stalledIds.add(thread.id);

      const scope = subscriptionScopeForSelection(thread.modelSelection, usageInstances);
      // No subscription account (API-billed / unknown) ⇒ nothing to wait on.
      // Intended healthy ⇒ ready. Else, only a pi selection with failover on can
      // become ready via a now-healthy fallback (direct drivers never reroute,
      // §9).
      const providerReady =
        scope.accountKey === null || !isExhausted(scope.accountKey, scope.modelId)
          ? true
          : failover.enabled &&
            scope.isPiSubscriptionSlug &&
            resolveFailoverTarget({
              slug: thread.modelSelection.model,
              catalogue,
              isExhausted,
              ...(failover.chains !== undefined ? { chains: failover.chains } : {}),
            }) !== undefined;

      if (
        !decideResume({
          resumeOnReset: failover.resumeOnReset,
          providerReady,
          lastAttemptMs: lastAttempt.get(thread.id) ?? null,
          now,
          cooldownMs: RESUME_COOLDOWN_MS,
        })
      ) {
        continue;
      }

      lastAttempt.set(thread.id, now);
      yield* resumeThread(thread).pipe(
        Effect.tap(() => Effect.logInfo("exhaustion.resume.dispatched", { threadId: thread.id })),
        Effect.catchCause((cause) =>
          Effect.logWarning("exhaustion.resume.failed", { threadId: thread.id, cause }),
        ),
      );
      resumedCount += 1;
    }

    // Drop cooldown entries for threads that have left the stalled pool so a
    // genuinely fresh future stall attempts immediately (a still-stalled thread
    // stays in the pool and keeps its cooldown).
    for (const id of lastAttempt.keys()) if (!stalledIds.has(id)) lastAttempt.delete(id);

    if (resumedCount > 0) {
      yield* Effect.logInfo("exhaustion.resume.sweep-complete", {
        resumedCount,
        stalledCount: stalledIds.size,
      });
    }
  });

  const start: ExhaustionResumeSweepShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(
        sweep.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("exhaustion.resume.sweep-failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced(SWEEP_INTERVAL)),
        ),
      );
      yield* Effect.logInfo("exhaustion.resume.started", {
        sweepIntervalMs: Duration.toMillis(SWEEP_INTERVAL),
        cooldownMs: RESUME_COOLDOWN_MS,
      });
    });

  return { start } satisfies ExhaustionResumeSweepShape;
});

export const ExhaustionResumeSweepLive = Layer.effect(ExhaustionResumeSweep, make);
