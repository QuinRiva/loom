/**
 * Quiescence as completion — the substrate half (plans/upstream-pull9-phase2-substrate/plan.mdx
 * §6; DL-194): a started child that went quiet without `mcp__t3-code__workstream_submit` is a
 * candidate for the dispatcher's synthesised `quiescent` submit (Phase 3b, on
 * terminal `run.updated` and its tick). Pure.
 *
 * @module loom/orchestration/quiescence
 */
import type {
  LoomThreadWorkstream,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The latest run that is not queued (a queued run never started; a held queue is still queued). */
export const latestUnheldRun = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs
    .filter((run) => run.status !== "queued")
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
      undefined,
    );

/**
 * A message that continues the turn before it rather than starting one (DL-482): upstream's
 * restart continuation and limit-resume, and Loom's steer redelivery, reroute / reroute-back
 * resumes and no-reset limit resume (`message:<commandId>` of `controlMessage.ts`'s builders).
 */
const CONTINUATION_MESSAGE_ID =
  /^(message:restart-continuation:|limit-resume:|message:server:loom:(steer-redeliver|reroute|reroute-back|limit-resume):)/;

/**
 * Whether the latest started turn was started by a human: the message that started its run,
 * looking back through continuation runs to the turn they continue. DL-194: the server-stamped
 * `humanAuthored`, never `createdBy` (a schedule fire or limit-resume is `user` too).
 */
export const turnStartedByHuman = (
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "ordinal" | "status" | "userMessageId">>,
  userMessages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "loom">>,
): boolean => {
  const byId = new Map(userMessages.map((message) => [message.id, message]));
  return (
    runs
      .filter((run) => run.status !== "queued")
      .toSorted((a, b) => b.ordinal - a.ordinal)
      .map((run) => byId.get(run.userMessageId))
      .find((message) => message === undefined || !CONTINUATION_MESSAGE_ID.test(message.id))?.loom
      ?.humanAuthored === true
  );
};

export const quiescenceCandidate = (input: {
  readonly shell: OrchestrationV2ThreadShell; // joined: shell.workstream present
  readonly runs: ReadonlyArray<OrchestrationV2Run>; // getThreadRecords(threadId, ["runs"]) for the few pre-filtered candidates
  readonly userMessages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "loom">>;
  readonly children: ReadonlyArray<LoomThreadWorkstream>;
  readonly now: DateTime.Utc;
  readonly grace: { readonly controlStartedMs: number; readonly humanStartedMs: number | null }; // null = never for human-started turns
}): boolean => {
  const ws = input.shell.workstream;
  if (
    ws === undefined ||
    ws.parentThreadId === null ||
    ws.kickoffAt === null ||
    ws.outcome !== null
  )
    return false;
  if (ws.attention.length > 0 || input.shell.pendingRuntimeRequest !== null) return false;
  if (
    input.shell.activityRunStatus != null ||
    (input.shell.pendingBackgroundTasks ?? []).length > 0
  )
    return false; // optional fields
  if (input.runs.some((run) => run.status === "queued")) return false; // includes a held queue
  if (
    input.children.some(
      (child) => child.outcome === null && child.deletedAt === null && child.archivedAt === null,
    )
  )
    return false;
  const lastRun = latestUnheldRun(input.runs);
  if (lastRun?.completedAt == null) return false;
  const humanStarted = turnStartedByHuman(input.runs, input.userMessages);
  const graceMs = humanStarted ? input.grace.humanStartedMs : input.grace.controlStartedMs;
  return (
    graceMs !== null &&
    DateTime.toEpochMillis(input.now) - DateTime.toEpochMillis(lastRun.completedAt) >= graceMs
  );
};
