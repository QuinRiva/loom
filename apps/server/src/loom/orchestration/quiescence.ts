/**
 * Pure: a started child that went quiet without `workstream_submit` is a candidate for the
 * dispatcher's synthesised `quiescent` submit.
 */
import type {
  LoomThreadWorkstream,
  OrchestrationV2Run,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { isParked } from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";

import { awaitsErrorResume } from "./liveness/errorResume.ts";
import {
  humanSpokeInTurn,
  type TurnMessage,
  turnStartedByHuman,
  turnStartedByParent,
} from "./turns.ts";

/** The latest run that is not queued (a queued run never started; a held queue is still queued). */
export const latestUnheldRun = (runs: ReadonlyArray<OrchestrationV2Run>) =>
  runs
    .filter((run) => run.status !== "queued")
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || run.ordinal > latest.ordinal ? run : latest),
      undefined,
    );

export const quiescenceCandidate = (input: {
  readonly shell: OrchestrationV2ThreadShell; // joined: shell.workstream present
  readonly runs: ReadonlyArray<OrchestrationV2Run>; // getThreadRecords(threadId, ["runs"]) for the few pre-filtered candidates
  readonly userMessages: ReadonlyArray<TurnMessage>;
  readonly children: ReadonlyArray<LoomThreadWorkstream>;
  readonly now: DateTime.Utc;
  readonly grace: { readonly controlStartedMs: number; readonly humanStartedMs: number | null }; // null = never for human-started turns
}): boolean => {
  const ws = input.shell.workstream;
  if (
    ws === undefined ||
    ws.parentThreadId === null ||
    ws.kickoffAt === null ||
    ws.outcome !== null ||
    ws.humanLed // the human talks to it at their own pace, whatever the graces
  )
    return false;
  if (isParked(ws.attention) || input.shell.pendingRuntimeRequest !== null) return false;
  // A held child is watched only after its parent sent it back: a turn the parent started and no
  // human joined must end in a hand-back. The human's rounds and notices are never reported.
  if (
    ws.attention.includes("awaiting_acceptance") &&
    (!turnStartedByParent(input.runs, input.userMessages) ||
      humanSpokeInTurn(input.runs, input.userMessages))
  )
    return false;
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
  // An interrupted run was stopped on purpose (a stop button, `workstream_stop`, `t3_thread_interrupt`):
  // its stopper knows. A restart leaves `cancelled` and a provider death `failed`, still watched.
  if (lastRun?.completedAt == null || lastRun.status === "interrupted") return false;
  // A failure the liveness sweep still owes its one resume is not quiet, whatever the grace: the
  // parent hears of it only if the resumed turn fails too (the sweep's `error` raise).
  if (awaitsErrorResume(input.shell, ws, input.runs)) return false;
  // A run the agent submitted from (after the run before it ended) did not go quiet: its report
  // stands, so a reopened or flag-cleared child is never synthesised over (DL-681).
  const previousEnd = latestUnheldRun(
    input.runs.filter((run) => run.ordinal < lastRun.ordinal),
  )?.completedAt;
  if (
    ws.lastOutcome !== null &&
    ws.lastOutcome.synthesised !== true &&
    (previousEnd == null || Date.parse(ws.lastOutcome.at) > DateTime.toEpochMillis(previousEnd))
  )
    return false;
  const humanStarted = turnStartedByHuman(input.runs, input.userMessages);
  const graceMs = humanStarted ? input.grace.humanStartedMs : input.grace.controlStartedMs;
  // The grace runs from the latest of: the run's end; the record's last change (DL-680/682: past a
  // run's end only a human or the parent touches it); and a child's settle, whose wake is still on
  // its way when the live-child exemption above lapses.
  const quietSince = Math.max(
    DateTime.toEpochMillis(lastRun.completedAt),
    Date.parse(ws.updatedAt),
    ...input.children.map((child) => (child.outcomeAt === null ? 0 : Date.parse(child.outcomeAt))),
  );
  return graceMs !== null && DateTime.toEpochMillis(input.now) - quietSince >= graceMs;
};
