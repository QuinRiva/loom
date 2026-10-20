/**
 * The liveness sweep's one resume after a provider failure, and the failure
 * predicates it shares with State A and the quiescence rail. A leaf module:
 * `quiescence.ts` imports it, and the sweep cannot be imported from there
 * (sweep → dispatcher → quiescence rail).
 *
 * @module loom/orchestration/liveness/errorResume
 */
import type {
  LoomThreadWorkstream,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { WORKSTREAM_CONTROL_PLANE_MARKER } from "../dispatcher/wakes.ts";

/**
 * A failed observation: the latest run failed with a provider failure class
 * other than `usage_limit` (3c's park-and-resume owns that class). A stop or
 * interrupt never reads as one: pi ends that turn `interrupted` with no failure.
 */
export const isFailedSession = (
  shell: Pick<OrchestrationV2ThreadShell, "status" | "lastErrorClass">,
): boolean =>
  shell.status === "failed" &&
  shell.lastErrorClass != null &&
  shell.lastErrorClass !== "usage_limit";

/**
 * A successful submit is the strongest liveness proof: when the thread's last
 * recorded outcome is at or after its latest run ended, a stale failure is
 * superseded and must not out-vote it. Pure and timestamp-keyed (V1 2026-07-08
 * incident: a reviewer recovered from a provider error and submitted, yet was
 * marked dead). It also exempts a party parked waiting-in-gate post-submit.
 */
export const submitSupersedesFailure = (
  row: Pick<LoomThreadWorkstream, "lastOutcome">,
  shell: Pick<OrchestrationV2ThreadShell, "latestRunCompletedAt" | "updatedAt">,
): boolean =>
  row.lastOutcome !== null &&
  Date.parse(row.lastOutcome.at) >=
    DateTime.toEpochMillis(shell.latestRunCompletedAt ?? shell.updatedAt);

/** `message:` + `errorResumeCommandId` (`controlMessage.ts`): the run such a resume started. */
export const ERROR_RESUME_MESSAGE_ID = /^message:server:loom:error-resume:/;

/**
 * The latest run failed on a provider error and the sweep still owes it its one
 * resume: that run was not itself a resume (one per failure episode; the run's
 * persisted `userMessageId` says so, so a restart cannot grant a second), and
 * no other actor owns the thread — no flag, outcome, submit since, open runtime
 * request, archive or settle, and no run after it (queued, or one a human or the
 * parent started since the sweep read the shell).
 */
export const awaitsErrorResume = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "status"
    | "lastErrorClass"
    | "latestRunId"
    | "latestRunCompletedAt"
    | "updatedAt"
    | "pendingRuntimeRequest"
    | "archivedAt"
    | "settledOverride"
  >,
  ws: Pick<LoomThreadWorkstream, "attention" | "outcome" | "lastOutcome">,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId">>,
): boolean => {
  const failed = runs.find((run) => run.id === shell.latestRunId);
  return (
    isFailedSession(shell) &&
    !submitSupersedesFailure(ws, shell) &&
    ws.attention.length === 0 &&
    ws.outcome === null &&
    shell.pendingRuntimeRequest === null &&
    shell.archivedAt === null &&
    shell.settledOverride !== "settled" &&
    failed?.status === "failed" &&
    !runs.some((run) => run.ordinal > failed.ordinal) &&
    !ERROR_RESUME_MESSAGE_ID.test(failed.userMessageId)
  );
};

/**
 * Pi drops an errored assistant message from the model's context (pi-ai
 * `transformMessages` skips `stopReason: "error"`), so the resumed agent never
 * saw the error: the message names it.
 */
export const errorResumeText = (error: string | null | undefined): string =>
  [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    "Your previous turn was cut off by a provider error, not by anything you did:",
    `\`${oneLine(error ?? "unknown provider error")}\``,
    "Continue where you left off. Check what already landed before repeating a step.",
  ].join("\n");

const oneLine = (text: string) => {
  const flat = text.replace(/\s+/g, " ").replaceAll("`", "'").trim();
  return flat.length > 300 ? `${flat.slice(0, 299)}…` : flat;
};
