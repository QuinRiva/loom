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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

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

export const reconcileStartupStaleSessionState = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const activeProviderSessions = yield* providerService.listSessions();
  const providerSessionsByThreadId = new Map(activeProviderSessions.map((s) => [s.threadId, s]));
  const [readModel, pendingTurnStartThreadIds, now] = yield* Effect.all([
    projectionSnapshotQuery.getCommandReadModel(),
    projectionSnapshotQuery.getPendingTurnStartThreadIds(),
    Effect.map(DateTime.now, DateTime.formatIso),
  ]);
  let reconciledSessions = 0;
  let clearedPendingStarts = 0;

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
  }

  if (reconciledSessions > 0 || clearedPendingStarts > 0) {
    yield* Effect.logInfo("startup reconciled stale session lifecycle state", {
      reconciledSessions,
      clearedPendingStarts,
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
