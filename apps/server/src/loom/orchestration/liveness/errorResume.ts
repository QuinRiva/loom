/**
 * The liveness sweep's one resume after a provider failure, and failure predicates shared with
 * State A and the quiescence rail. A leaf module so `quiescence.ts` can import it without a cycle.
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
 * A submit at or after the latest run ended supersedes a stale failure: a reviewer that recovered
 * from a provider error and submitted must not be marked dead. Also exempts a party parked
 * waiting-in-gate after submitting.
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
 * The latest run failed on a provider error and still owes its one resume: it was not itself a
 * resume (persisted `userMessageId`, so a restart cannot grant a second), and nothing else owns the
 * thread: no flag, outcome, later submit, open request, archive, settle or later run.
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
