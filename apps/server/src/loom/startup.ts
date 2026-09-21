/**
 * Loom fork-owned server startup logic.
 *
 * Loom adds three provider/runtime sweeps to the reactor scope and a
 * stale-session-lifecycle reconciliation phase to `serverRuntimeStartup.ts`.
 * Those additions live here so the upstream startup file keeps only one-line
 * `// loom:`-marked call sites, staying mergeable against upstream.
 *
 * @module loom/startup
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { openUserInputRequestIds } from "@t3tools/shared/openRequests";
import { dispatchUserInputResolutions } from "../orchestration/userInputSettlement.ts";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  isRecoveryResumable,
  isStuckLaunch,
  latestUserMessageAtOf,
  recoverStuckLaunch,
} from "../orchestration/stuckLaunchRecovery.ts";
import { ProviderLaunchClaims } from "../provider/Services/ProviderLaunchClaims.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { WorkstreamLivenessSweep } from "../orchestration/Services/WorkstreamLivenessSweep.ts";
import { ExhaustionResumeSweep } from "../orchestration/Services/ExhaustionResumeSweep.ts";
import { SubscriptionUsagePoller } from "../provider/Services/SubscriptionUsagePoller.ts";

/**
 * Acquire and start the fork sweeps. The call site provides the reactor scope
 * (`startLoomSweeps.pipe(Scope.provide(reactorScope))`), so every `start()`
 * below forks into that scope exactly as the individual upstream reactor starts
 * do.
 */
export const startLoomSweeps = Effect.gen(function* () {
  const workstreamLivenessSweep = yield* WorkstreamLivenessSweep;
  const exhaustionResumeSweep = yield* ExhaustionResumeSweep;
  const subscriptionUsagePoller = yield* SubscriptionUsagePoller;
  yield* workstreamLivenessSweep.start();
  yield* exhaustionResumeSweep.start();
  yield* subscriptionUsagePoller.start();
});

// Provider liveness for boot, from BOTH available sources.
//
// 1. Any adapter-reported session — with or without a confirmed turn. This
//    deliberately replaces the previous active-turn-only check, which was too
//    weak: a session that exists but has not yet reported `turn.started` is a
//    launch in flight, so clearing its pending turn-start row (the only durable
//    "this thread is busy" guard) or resetting its session would sabotage live
//    work rather than repair a stale record.
//
// 2. A durable `provider_session_runtime` binding that is not `stopped`. This is
//    the RESTART-SURVIVOR evidence, and it is the only evidence that exists for
//    that case: the adapter's session map is process-local (a pi child is a
//    normal subprocess registered in an in-memory map), so a provider process
//    that outlived the previous server is INVISIBLE to this process's adapters.
//    Such an orphan changes no orchestration state, so the compare-and-swap
//    cannot see it either — the binding row is what makes the decision
//    authoritative. The runtime sweep already treats it this way; boot now
//    matches, at the cost of deferring recovery until the reaper marks the row
//    `stopped`. Recovering late is cheap; launching a second agent beside a
//    surviving one is not.
const hasLiveProviderSession = (
  sessionsByThreadId: ReadonlyMap<ThreadId, unknown>,
  liveBoundThreadIds: ReadonlySet<ThreadId>,
  threadId: ThreadId,
): boolean => sessionsByThreadId.has(threadId) || liveBoundThreadIds.has(threadId);

const startupReconcileCommandId = (threadId: ThreadId, marker: string) =>
  CommandId.make(`server:startup-session-reconcile:${threadId}:${marker}`);

const CONTROL_PLANE_MARKER = "[T3 Workstream control plane — automated notice, not from the user]";

export const reconcileStartupStaleSessionState = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const launchIdentityDir = (yield* ServerConfig).workstreamLaunchIdentityDir;
  const providerSessionDirectory = yield* ProviderSessionDirectory;
  // In-flight launch claims. The reconcile runs after the reactors have started,
  // so a turn-start accepted in that window can already be blocked inside
  // `startSession` — writing no session event and no binding while it waits, which
  // is indistinguishable from a wedge by any other signal (see ProviderLaunchClaims).
  const launchClaims = yield* ProviderLaunchClaims;
  const activeProviderSessions = yield* providerService.listSessions();
  const providerSessionsByThreadId = new Map(activeProviderSessions.map((s) => [s.threadId, s]));
  const [readModel, shellSnapshot, pendingTurnStartThreadIds, now] = yield* Effect.all([
    projectionSnapshotQuery.getCommandReadModel(),
    projectionSnapshotQuery.getLeanShellSnapshot(),
    projectionSnapshotQuery.getPendingTurnStartThreadIds(),
    Effect.map(DateTime.now, DateTime.formatIso),
  ]);
  // Settlement layer 3 (see `orchestration/userInputSettlement.ts`): the startup
  // scan. A question whose asking process is gone — which after a restart is
  // EVERY open question, since no provider callback state survives — is resolved
  // cancelled here, so the resumed model may simply re-ask. This replaces the old
  // `parkedThreadIds` exclusion, which left such threads flagged and excluded
  // from continuation forever, waiting on an answer nothing could ever deliver.
  //
  // Pending APPROVALS keep the old treatment: they have their own persisted table
  // and their own resolution path, and reconciling them is out of scope here.
  // Restart-survivor evidence (see `hasLiveProviderSession`). FAIL CLOSED on a
  // read error: an unreadable binding table means we cannot rule out a surviving
  // provider process for ANY thread, so every thread is treated as live and this
  // boot reconciles nothing rather than risk launching beside a survivor.
  const liveBoundThreadIds = yield* providerSessionDirectory.listBindings().pipe(
    Effect.map(
      (bindings) => new Set(bindings.filter((b) => b.status !== "stopped").map((b) => b.threadId)),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        "startup provider-binding read failed; skipping session reconciliation this boot",
        { cause: Cause.pretty(cause) },
      ).pipe(Effect.as(new Set(readModel.threads.map((t) => t.id)))),
    ),
  );
  // Threads parked on a human (pending approval / user input) must not be
  // auto-resumed: their provider callback state does not survive recovery, and a
  // resume would clear the human-facing wait. They still get the reset below.
  const parkedThreadIds = new Set(
    shellSnapshot.threads.filter((t) => t.hasPendingApprovals).map((t) => t.id),
  );
  // EVERY boot-inherited open question is settled, with no session-liveness
  // exemption. An adapter appearing in `listSessions()` does NOT prove the
  // specific request's consumer exists: the in-memory broker entry / SDK Deferred
  // that the blocked callback waits on is process-local and never survives a
  // restart (pi additionally has no resumeCursor at all — audit D4). Skipping a
  // thread because its session looks active is therefore exactly the hole that
  // leaves a persisted request with no consumer, defeating this layer's purpose.
  //
  // A live in-process request cannot be reached by this scan anyway: it is created
  // after startup, so its `requested` row is not in this snapshot.
  let settledUserInputRequests = 0;
  let unsettledUserInputRequests = 0;
  for (const shell of shellSnapshot.threads) {
    if (!shell.hasPendingUserInput) continue;
    const detail = yield* projectionSnapshotQuery
      .getThreadDetailById(shell.id)
      .pipe(Effect.map(Option.getOrUndefined));
    const stillOpen = openUserInputRequestIds(detail?.activities ?? []);
    if (stillOpen.size === 0) continue;
    // Count CONFIRMED writes only. Reporting the attempted count would let a
    // transient command-path failure look like success while the thread stays
    // wedged — which is incident 1's signature, not a fix for it.
    const report = yield* dispatchUserInputResolutions({
      dispatch: orchestrationEngine.dispatch,
      newId: crypto.randomUUIDv4,
      threadId: shell.id,
      resolutions: [...stillOpen].map((requestId) => ({
        requestId,
        outcome: "cancelled" as const,
      })),
      createdAt: now,
      tag: "startup-scan",
    });
    settledUserInputRequests += report.persisted;
    unsettledUserInputRequests += report.failed;
  }
  if (unsettledUserInputRequests > 0) {
    yield* Effect.logError("startup could not settle every open user-input request", {
      unsettledUserInputRequests,
    });
  }
  // Random per-boot id: makes each boot's continuation attempt a fresh command
  // (retryable next boot) rather than a cross-restart receipt-deduped one.
  const bootId = yield* crypto.randomUUIDv4;
  const nowMs = Date.parse(now);
  let reconciledSessions = 0;
  let clearedPendingStarts = 0;
  let continuationAttempts = 0;
  let recoveredStuckLaunches = 0;

  for (const thread of readModel.threads) {
    // FAIL CLOSED on any live provider session, not just one with a confirmed
    // turn. A session that exists but has not yet reported `turn.started` is a
    // launch in flight: its pending turn-start row is the only durable record
    // that the thread is busy, and every write below (the stuck-launch repair,
    // the pending-row clear, the session reset) would destroy live state rather
    // than reconcile a stale one. An active-turn-only check is too weak here.
    //
    // This ALSO covers the restart-survivor case, via the DURABLE binding rather
    // than the adapter: a provider process that outlived the previous server is
    // invisible to this process's in-memory adapter map, and — crucially — it
    // mutates no orchestration state, so the compare-and-swap cannot detect it
    // either. The non-`stopped` binding row is the only authoritative evidence
    // of such a survivor, so it gates this skip.
    if (hasLiveProviderSession(providerSessionsByThreadId, liveBoundThreadIds, thread.id)) continue;
    // A launch in flight right now, mid-`startSession`, writes nothing to see.
    if (yield* launchClaims.isClaimed(thread.id)) continue;

    // Wedged mid-launch (`starting` + no active turn): the state the reset below
    // used to SKIP, leaving it frozen forever (see `stuckLaunchRecovery`). It
    // needs the kickoff-aware resume, so it is recovered as one unit and this
    // thread is done for this pass.
    //
    // Grace 0: unlike the runtime sweep, boot has no age question to ask — no
    // launch has been requested in this process yet, so a `starting` row is
    // necessarily left over from a previous one. Survivor safety comes from the
    // binding check above (not from the CAS, which an out-of-process survivor
    // would never trip); the CAS additionally guards against a turn accepted
    // concurrently with this pass.
    if (
      thread.session !== null &&
      isStuckLaunch({
        session: thread.session,
        // Already proven above by the fail-closed skip.
        hasLiveProviderLaunch: false,
        now: nowMs,
        graceMs: 0,
      })
    ) {
      const { resumed } = yield* recoverStuckLaunch({
        thread,
        session: thread.session,
        latestUserMessageAt: latestUserMessageAtOf(thread),
        clearPendingTurnStart: pendingTurnStartThreadIds.has(thread.id),
        resume: isRecoveryResumable({
          attentionCount: thread.attention.length,
          parkedOnHuman: parkedThreadIds.has(thread.id),
          archived: Boolean(thread.archivedAt),
          deleted: Boolean(thread.deletedAt),
          cancelled: thread.planLane === "cancelled",
        }),
        launchIdentityDir,
        // Per-boot scope: an attempt lost to a crash is retried next boot rather
        // than being permanently receipt-deduped, and it can never cross-dedup
        // with the runtime sweep's ids.
        scope: `boot:${bootId}`,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("startup stuck-launch recovery failed", {
            threadId: thread.id,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as({ repaired: false, resumed: false })),
        ),
      );
      recoveredStuckLaunches += 1;
      if (resumed) continuationAttempts += 1;
      continue;
    }

    if (pendingTurnStartThreadIds.has(thread.id)) {
      yield* orchestrationEngine.dispatch({
        type: "thread.turn-start.fail",
        commandId: startupReconcileCommandId(
          thread.id,
          `pending-start:${thread.latestTurn?.requestedAt ?? thread.updatedAt}`,
        ),
        threadId: thread.id,
        detail: "Startup reconciled stale pending turn-start with no live provider turn.",
        createdAt: now,
      });
      clearedPendingStarts += 1;
    }

    const session = thread.session;
    // Everything left needing a reset: a `running` session, or any status with a
    // still-open turn. `starting` + no turn was handled above by the stuck-launch
    // branch (before this skip, which is what used to swallow it); every other
    // idle status (`ready`/`stopped`/`error`) is already consistent.
    if (!session || (session.status !== "running" && session.activeTurnId === null)) continue;

    yield* orchestrationEngine.dispatch({
      type: "thread.session.set",
      commandId: startupReconcileCommandId(
        thread.id,
        `${session.activeTurnId ?? session.status}:${session.updatedAt}`,
      ),
      threadId: thread.id,
      session: {
        ...session,
        status: "ready",
        activeTurnId: null,
        lastError: null,
        queuedMessages: { steering: [], followUp: [] },
        updatedAt: now,
      },
      createdAt: now,
    });
    reconciledSessions += 1;

    // Resuming the interrupted turn is upstream's concern now: its
    // `provider-sessions.reconcile` phase (#9167) runs first and continues any
    // thread whose provider session can be resumed. What is left here is the
    // reset of sessions upstream declined to continue.
  }

  if (
    reconciledSessions > 0 ||
    clearedPendingStarts > 0 ||
    continuationAttempts > 0 ||
    settledUserInputRequests > 0 ||
    unsettledUserInputRequests > 0 ||
    recoveredStuckLaunches > 0
  ) {
    yield* Effect.logInfo("startup reconciled stale session lifecycle state", {
      reconciledSessions,
      clearedPendingStarts,
      continuationAttempts,
      settledUserInputRequests,
      unsettledUserInputRequests,
      recoveredStuckLaunches,
    });
  }
});

/**
 * `reconcileStartupStaleSessionState` wrapped with the fork's failure logging,
 * so the upstream call site is `runStartupPhase("sessions.reconcile", reconcileStaleSessionsGuarded)`.
 */
export const reconcileStaleSessionsGuarded = reconcileStartupStaleSessionState.pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("startup session lifecycle reconciliation failed", {
      cause: Cause.pretty(cause),
    }),
  ),
);
