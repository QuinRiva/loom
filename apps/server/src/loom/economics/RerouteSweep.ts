/**
 * RerouteSweep — what Loom adds to upstream's usage-limit recovery for pi
 * threads (plans/upstream-pull9-phase3-tracks/plan.mdx, track 3c; P3-11/P3-12).
 *
 * Upstream's `UsageLimitRecoveryWorker` parks a thread whose run failed
 * `usage_limit` with a reset time and resumes it when the window passes. It
 * cannot do three things, which this sweep does for a pi thread whose latest
 * run failed `usage_limit` (not archived, settled, waiting on a runtime request,
 * holding Loom attention or a Loom outcome):
 *
 *  1. **Reroute.** The intended model is out of usage and the single
 *     `providerFailover.fallbackTarget` is a healthy model of ANOTHER vendor:
 *     move the thread onto it now (model selection, then detach the live pi
 *     session so a fresh process — and the adapter's sanitiser — loads the
 *     session file), record `loom_thread_reroute`, and resume it with a Loom
 *     control message.
 *  2. **Move back.** A rerouted thread that is idle and whose intended account
 *     is healthy again goes back to its intended selection (and, if it is
 *     itself stopped on a usage limit, is resumed there).
 *  3. **No-reset resume.** A failure upstream cannot arm (no reset time, or one
 *     already due when the run ended) and no fallback: resume once the
 *     registry no longer marks the intended model exhausted (the adapter's
 *     classifier marks it when the failure names no reset; DL-397).
 *
 * The two resume mechanisms are disjoint by condition: a reset time known and
 * no fallback ⇒ upstream's (this sweep leaves it alone); otherwise Loom's.
 * Every command id is deterministic per thread and failed run, so a receipted
 * step replays as a no-op and a `LoomDispatchDeferredError` is retried on the
 * next pass. Resumes are steered `controlMessage()` wakes (`createdBy: "agent"`), never a human's.
 *
 * Runs every 60 s and after every run ends.
 *
 * @module loom/economics/RerouteSweep
 */
import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { loomContinuationVetoed } from "../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { subscriptionScopeForSelection } from "../../provider/exhaustionMapping.ts";
import { resolveFailoverTarget } from "../../provider/failoverTarget.loom.ts";
import { ProviderHealthRegistry, matches } from "../../provider/Services/ProviderHealthRegistry.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../../serverActivation.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  controlMessage,
  limitResumeCommandId,
  rerouteBackCommandId,
  rerouteCommandId,
} from "../orchestration/dispatcher/controlMessage.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { deleteReroute, insertReroute, listReroutes } from "./rerouteRecord.ts";

export const rerouteResumeText = (fallbackModel?: string): string =>
  [
    "[T3 Code control plane — automated resume after a provider usage limit; not a message from the user]",
    "",
    fallbackModel === undefined
      ? "The provider usage limit that stopped your previous turn has cleared; none of that response was delivered."
      : `Your model's provider is out of usage, so this thread now runs on ${fallbackModel} until it recovers; none of the previous response was delivered.`,
    "Continue the task from where you left off.",
  ].join("\n");

/**
 * Threads whose latest executed run failed on a usage limit: upstream's
 * `getLimitRecoveryCandidates` without its reset-time and arm conditions.
 */
const usageLimitedThreadIds = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly threadId: string }>`
    SELECT t.thread_id AS "threadId"
    FROM orchestration_v2_projection_threads t
    INNER JOIN orchestration_v2_projection_runs r ON r.run_id = (
      SELECT latest.run_id FROM orchestration_v2_projection_runs latest
      WHERE latest.thread_id = t.thread_id
        AND latest.status <> 'queued'
        AND NOT (
          latest.status = 'cancelled'
          AND json_extract(latest.payload_json, '$.startedAt') IS NULL
        )
      ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
        latest.ordinal DESC, latest.run_id DESC
      LIMIT 1
    ) AND r.status = 'failed'
    WHERE t.deleted_at IS NULL
      AND json_extract(t.payload_json, '$.archivedAt') IS NULL
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items item
        WHERE item.thread_id = t.thread_id AND item.run_id = r.run_id
          AND item.type = 'error' AND item.status = 'failed'
          AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
      )`;
  return rows.map((row) => ThreadId.make(row.threadId));
});

/** Dispatch one step; false when it did not land (deferred: next pass; rejected: logged). */
const send = (command: OrchestrationV2ServerCommand) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    return yield* orchestrator.dispatch(command).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        error._tag === "LoomDispatchDeferredError"
          ? Effect.succeed(false)
          : Effect.logWarning("loom.reroute.dispatch-failed", {
              commandId: command.commandId,
              commandType: command.type,
              error: error.message,
            }).pipe(Effect.as(false)),
      ),
    );
  });

/** A steered control message (the target is idle, so it starts the turn). */
const resume = (threadId: ThreadId, id: string, text: string) =>
  send(controlMessage({ threadId, id, tier: "steered", origin: "control_notice", text }));

/** Selection set, then every live pi session detached, so the next turn opens a fresh process. */
const moveTo = (threadId: ThreadId, idBase: string, modelSelection: ModelSelection) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    if (
      !(yield* send({
        type: "thread.model-selection.set",
        commandId: CommandId.make(`${idBase}:model`),
        threadId,
        modelSelection,
      }))
    )
      return false;
    const { providerSessions } = yield* orchestrator.getThreadRecords(threadId, [
      "providerSessions",
    ]);
    for (const session of providerSessions.filter((s) => s.status !== "stopped"))
      if (
        !(yield* send({
          type: "provider-session.detach",
          commandId: CommandId.make(`${idBase}:detach:${session.id}`),
          threadId,
          providerSessionId: session.id,
          reason: "Loom moved the thread to another model.",
        }))
      )
        return false;
    return true;
  });

const sameSelection = (a: ModelSelection, b: ModelSelection) =>
  a.instanceId === b.instanceId && a.model === b.model;

export const runRerouteSweepPass = Effect.fn("loom.reroute.pass")(function* () {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const marks = yield* (yield* ProviderHealthRegistry).snapshot;
  const nowMs = yield* Clock.currentTimeMillis;
  const now = DateTime.formatIso(DateTime.makeUnsafe(nowMs));
  // Keyed as the quota classifier keys a failure: a pooled pi instance meters under its own id.
  const marksFor = (selection: ModelSelection) => {
    const { accountKey, modelId } = subscriptionScopeForSelection(
      selection,
      new Set([selection.instanceId]),
    );
    return marks.filter((mark) => accountKey !== null && matches(mark, accountKey, modelId));
  };
  const exhausted = (selection: ModelSelection) => marksFor(selection).length > 0;

  const reroutes = new Map((yield* listReroutes).map((row) => [row.threadId, row] as const));
  const sweepThread = Effect.fn("loom.reroute.thread")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const threadId = shell.id;
    const provider = providers.find(
      (entry) => entry.instanceId === shell.modelSelection.instanceId && entry.driver === "pi",
    );
    if (provider === undefined) return;
    const row = reroutes.get(threadId);
    // A thread a human has since moved elsewhere is no longer Loom's to move back.
    const reroute =
      row !== undefined && sameSelection(row.reroutedSelection, shell.modelSelection)
        ? row
        : undefined;
    if (row !== undefined && reroute === undefined) yield* deleteReroute(threadId);
    const intended = reroute?.intendedSelection ?? shell.modelSelection;
    const runId = shell.latestRunId;
    const limited =
      shell.status === "failed" &&
      shell.lastErrorClass === "usage_limit" &&
      runId !== null &&
      shell.pendingRuntimeRequest === null &&
      shell.settledOverride !== "settled" &&
      // A snoozed thread is not resumed, as upstream's limitRecoveryCommand.
      (shell.snoozedUntil == null || DateTime.toEpochMillis(shell.snoozedUntil) <= nowMs);
    const workstream = yield* loomStore.getWorkstream(threadId);
    const resumable =
      limited &&
      (workstream === null ||
        (!loomContinuationVetoed(workstream, false) && workstream.attention.length === 0));

    const ranUntil = DateTime.toEpochMillis(shell.latestRunCompletedAt ?? shell.updatedAt);
    if (reroute !== undefined) {
      // The failure's own reset counts too: the registry is empty after a restart.
      const resetPending = reroute.resetAt !== null && Date.parse(reroute.resetAt) > nowMs;
      const intendedOut = exhausted(intended) || resetPending;
      // Clause 1 left half-done: the thread is still failed on the run it was rerouted from
      // (it ended before the reroute). Re-send its steps; receipted ids make each a no-op once landed.
      if (resumable && intendedOut && ranUntil <= Date.parse(reroute.reroutedAt)) {
        const idBase = rerouteCommandId(threadId, runId);
        if (yield* moveTo(threadId, idBase, reroute.reroutedSelection))
          yield* resume(threadId, idBase, rerouteResumeText(reroute.reroutedSelection.model));
        return;
      }
      // Clause 2: back to the intended selection once it is healthy and the thread is idle.
      if (shell.activeRunId !== null || intendedOut) return;
      const idBase = rerouteBackCommandId(threadId, Date.parse(reroute.reroutedAt));
      if (!(yield* moveTo(threadId, idBase, intended))) return;
      yield* deleteReroute(threadId);
      // Stopped on the fallback's own limit: carry on where the intended model is healthy.
      if (resumable && settings.autoResumeLimitedThreads)
        yield* resume(threadId, `${idBase}:${runId}`, rerouteResumeText());
      return;
    }
    if (!resumable) return;

    const resetMs = Date.parse(shell.usageLimitResetAt ?? "");
    // Upstream arms (and resumes) only a reset later than the failed run's end.
    // A reset already due when the run ended (pi-ai rounds "~0 min") is not armed: clause 3's.
    const upstreamResumes = resetMs > ranUntil;
    const intendedOut = exhausted(intended) || (upstreamResumes && resetMs > nowMs);
    const fallback =
      !settings.providerFailover.enabled || !intendedOut
        ? undefined
        : resolveFailoverTarget({
            intendedSlug: intended.model,
            fallbackTarget: settings.providerFailover.fallbackTarget,
            catalogue: new Set(provider.models.map((model) => model.slug)),
            isExhausted: (slug) => exhausted({ instanceId: intended.instanceId, model: slug }),
          });

    // Clause 1: the cross-vendor reroute.
    if (fallback !== undefined) {
      const idBase = rerouteCommandId(threadId, runId);
      const reroutedSelection = { instanceId: intended.instanceId, model: fallback };
      // The row first: a model-set that never lands leaves a row that no longer matches the
      // thread's selection, which the next pass deletes; any later step is re-sent above.
      yield* insertReroute({
        threadId,
        intendedSelection: intended,
        reroutedSelection,
        reroutedAt: now,
        windowLabel: marksFor(intended).find((mark) => mark.windowLabel)?.windowLabel ?? null,
        resetAt: shell.usageLimitResetAt ?? null,
      });
      if (!(yield* moveTo(threadId, idBase, reroutedSelection))) return;
      yield* resume(threadId, idBase, rerouteResumeText(fallback));
      return;
    }
    // Clause 3: a failure upstream cannot arm, resumed when the registry clears it.
    if (!upstreamResumes && !intendedOut && settings.autoResumeLimitedThreads)
      yield* resume(threadId, limitResumeCommandId(threadId, runId), rerouteResumeText());
  });

  for (const threadId of new Set([...(yield* usageLimitedThreadIds), ...reroutes.keys()])) {
    const shell = yield* orchestrator.getThreadShell(threadId);
    yield* (
      shell === null || shell.archivedAt !== null
        ? reroutes.has(threadId)
          ? deleteReroute(threadId)
          : Effect.void
        : sweepThread(shell)
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("loom.reroute.thread-failed", { threadId, cause }),
      ),
    );
  }
});

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);
const isRunEnd = (event: OrchestrationV2DomainEvent) =>
  event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status);

/** The sweep: once after activation, every 60 s, and after every run ends. */
export const RerouteSweepLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const pass = runRerouteSweepPass().pipe(
      Effect.catchCause((cause) => Effect.logWarning("loom.reroute.pass-failed", { cause })),
    );
    yield* forkParked(
      Stream.merge(
        Stream.tick("60 seconds"),
        orchestrator.streamDomainEvents.pipe(Stream.filter(isRunEnd)),
      ).pipe(
        Stream.debounce("200 millis"),
        Stream.runForEach(() => pass),
        Effect.catchCause((cause) => Effect.logWarning("loom.reroute.sweep-stopped", { cause })),
      ),
    );
  }),
);
