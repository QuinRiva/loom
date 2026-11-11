/**
 * Who started the latest turn and who spoke in it, read from runs and user messages only. A leaf
 * module (contract types alone) so the decider can import it without pulling the dispatcher in.
 */
import type { OrchestrationV2ConversationMessage, OrchestrationV2Run } from "@t3tools/contracts";

/**
 * A message that continues the turn before it rather than starting one (DL-482): upstream's
 * restart continuation and limit-resume, and Loom's steer redelivery, reroute / reroute-back
 * resumes, no-reset limit resume and error resume (`message:<commandId>` of `controlMessage.ts`'s builders).
 */
const CONTINUATION_MESSAGE_ID =
  /^(message:restart-continuation:|limit-resume:|message:server:loom:(steer-redeliver|reroute|reroute-back|limit-resume|error-resume):)/;

export type TurnRun = Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId">;
export type TurnMessage = Pick<OrchestrationV2ConversationMessage, "id" | "loom" | "runId">;

/** The started runs of the latest turn, newest first: back through continuation runs to the one that started it. */
const latestTurnRuns = (
  runs: ReadonlyArray<TurnRun>,
  byId: ReadonlyMap<string, Pick<TurnMessage, "id">>,
): ReadonlyArray<TurnRun> => {
  const started = runs
    .filter((run) => run.status !== "queued")
    .toSorted((a, b) => b.ordinal - a.ordinal);
  const first = started.findIndex((run) => {
    const message = byId.get(run.userMessageId);
    return message === undefined || !CONTINUATION_MESSAGE_ID.test(message.id);
  });
  return first === -1 ? started : started.slice(0, first + 1);
};

/** The message that started the latest turn (DL-194: read its server-stamped `loom`, never `createdBy`). */
const turnStarter = (runs: ReadonlyArray<TurnRun>, userMessages: ReadonlyArray<TurnMessage>) => {
  const byId = new Map(userMessages.map((message) => [message.id, message]));
  const start = latestTurnRuns(runs, byId).at(-1);
  return start === undefined ? undefined : byId.get(start.userMessageId);
};

/** Whether the latest started turn was started by a human (a schedule fire or limit-resume is `user` too). */
export const turnStartedByHuman = (
  runs: ReadonlyArray<TurnRun>,
  userMessages: ReadonlyArray<TurnMessage>,
): boolean => turnStarter(runs, userMessages)?.loom?.humanAuthored === true;

/** Whether the latest started turn was started by the parent's `mcp__t3-code__workstream_prompt`. */
export const turnStartedByParent = (
  runs: ReadonlyArray<TurnRun>,
  userMessages: ReadonlyArray<TurnMessage>,
): boolean => turnStarter(runs, userMessages)?.loom?.origin === "orchestrator";

/**
 * Whether a human-authored message started or was steered into the latest turn, continuations
 * included: a steered message carries the id of the run it joined.
 */
export const humanSpokeInTurn = (
  runs: ReadonlyArray<TurnRun>,
  userMessages: ReadonlyArray<TurnMessage>,
): boolean => {
  const turn = new Set(
    latestTurnRuns(runs, new Map(userMessages.map((message) => [message.id, message]))).map(
      (run) => run.id,
    ),
  );
  return userMessages.some(
    (message) =>
      message.runId !== null && turn.has(message.runId) && message.loom?.humanAuthored === true,
  );
};
