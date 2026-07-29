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
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { openUserInputRequestIds } from "@t3tools/shared/openRequests";
import { dispatchUserInputResolutions } from "../orchestration/userInputSettlement.ts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
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

const hasActiveProviderTurn = (
  sessionsByThreadId: ReadonlyMap<ThreadId, { readonly activeTurnId?: unknown }>,
  threadId: ThreadId,
): boolean => sessionsByThreadId.get(threadId)?.activeTurnId != null;

const startupReconcileCommandId = (threadId: ThreadId, marker: string) =>
  CommandId.make(`server:startup-session-reconcile:${threadId}:${marker}`);

// Restart turn-continuation (Option 1, best-effort). The id is keyed on a random
// per-boot uuid — NOT a deterministic cross-restart receipt id — so a resume
// attempt lost to a crash is retried on the next boot rather than being
// permanently receipt-deduped, and it is disjoint from every dispatcher-rail id
// namespace so a rail can never cross-dedup it.
const startupContinueCommandId = (threadId: ThreadId, bootId: string) =>
  CommandId.make(`server:startup-turn-continue:${threadId}:${bootId}`);

const CONTROL_PLANE_MARKER = "[T3 Workstream control plane — automated notice, not from the user]";

// The control-notice injected into a thread whose turn was interrupted by a
// redeploy. A fresh turn-start resumes the persisted provider session with full
// prior context, so the agent picks up where it left off.
//
// `queuedSteering` is the other half of a real data-loss bug: the reset below
// wipes the session's queued messages, which for an interrupted thread are
// HUMAN messages that were queued against a turn that will never resume. They
// are already in the row being reset, so they are folded into the resume message
// rather than discarded — "we no longer lose your replies" should not carry an
// asterisk about restarts.
const buildRestartContinueMessage = (queuedSteering: ReadonlyArray<string> = []): string =>
  [
    CONTROL_PLANE_MARKER,
    "",
    "The server was redeployed while your turn was in progress, so the turn was interrupted. This is an automated recovery notice, not a message from the user.",
    ...(queuedSteering.length > 0
      ? [
          "",
          queuedSteering.length === 1
            ? "The user sent this message while the turn was in flight; it was never delivered, so it is included here. Treat it as their message to you:"
            : "The user sent these messages while the turn was in flight; they were never delivered, so they are included here. Treat them as their messages to you:",
          "",
          ...queuedSteering.map((message) => `- ${message}`),
        ]
      : []),
    "",
    "Resume from where you left off and finish the work. If you had already completed it, proceed to your normal completion step (e.g. workstream_submit).",
  ].join("\n");

export const reconcileStartupStaleSessionState = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const activeProviderSessions = yield* providerService.listSessions();
  const providerSessionsByThreadId = new Map(activeProviderSessions.map((s) => [s.threadId, s]));
  const [readModel, shellSnapshot, pendingTurnStartThreadIds, now] = yield* Effect.all([
    projectionSnapshotQuery.getCommandReadModel(),
    projectionSnapshotQuery.getShellSnapshot(),
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
  let reconciledSessions = 0;
  let clearedPendingStarts = 0;
  let continuationAttempts = 0;

  for (const thread of readModel.threads) {
    if (hasActiveProviderTurn(providerSessionsByThreadId, thread.id)) continue;

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
    if (!session || (session.status !== "running" && session.activeTurnId === null)) continue;

    // A genuinely interrupted turn (a provider turn had actually started) vs. a
    // merely stuck-running session (activeTurnId null — the 914c1e1d4 "deaf
    // orchestrator" case). Only the former is resumed; both are reset.
    const wasInterrupted = session.activeTurnId !== null;
    // Captured before the reset wipes them; folded into the resume message below
    // rather than discarded.
    const wipedSteering = session.queuedMessages.steering.filter(
      (message) => message.trim().length > 0,
    );

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

    // Resume the interrupted turn (Option 1). Excluded (reset only, never
    // resumed):
    //  - threads parked on a pending approval, or already flagged for attention
    //    — a turn-start clears that flag (the decider clears stored attention on
    //    any non-terminal turn-start). A thread parked on a QUESTION is no longer
    //    excluded: the scan above settled it, so continuation is correct;
    //  - archived / soft-deleted / cancelled threads — reviving hidden or
    //    explicitly abandoned work is wrong. `done` IS resumed (interrupted
    //    follow-up turns are legitimate).
    // `requireIdle` is the double-start guard: the reset above made the thread
    // idle, so this lands; if any other startup producer (a child-delta wake,
    // gate traversal, or liveness nudge) resumed the thread first, this defers
    // harmlessly. Per-thread error isolation: a deferral/failure is logged and
    // never aborts reconciliation of the remaining threads. Provider-session
    // recovery (and its failure fallback) is owned by ProviderCommandReactor.
    const resumable =
      wasInterrupted &&
      thread.attention.length === 0 &&
      !parkedThreadIds.has(thread.id) &&
      !thread.archivedAt &&
      !thread.deletedAt &&
      thread.planLane !== "cancelled";
    if (resumable) {
      const messageId = MessageId.make(yield* crypto.randomUUIDv4);
      const accepted = yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: startupContinueCommandId(thread.id, bootId),
          threadId: thread.id,
          message: {
            messageId,
            role: "user",
            origin: "control_notice",
            text: buildRestartContinueMessage(wipedSteering),
            attachments: [],
          },
          titleSeed: thread.title,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          requireIdle: true,
          createdAt: now,
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logDebug("startup turn-continue deferred or failed", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }).pipe(Effect.as(false)),
          ),
        );
      if (accepted) continuationAttempts += 1;
    }
  }

  if (
    reconciledSessions > 0 ||
    clearedPendingStarts > 0 ||
    continuationAttempts > 0 ||
    settledUserInputRequests > 0 ||
    unsettledUserInputRequests > 0
  ) {
    yield* Effect.logInfo("startup reconciled stale session lifecycle state", {
      reconciledSessions,
      clearedPendingStarts,
      continuationAttempts,
      settledUserInputRequests,
      unsettledUserInputRequests,
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
