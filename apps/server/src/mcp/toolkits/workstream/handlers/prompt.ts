/**
 * `mcp__t3-code__workstream_prompt`: the parent's message to a direct child as ONE
 * `message.dispatch` with `loom.origin: "orchestrator"` — dispatched directly,
 * never through `ThreadManagementService.sendToThread` (which drops `loom`),
 * because the origin is what lets the arm's rule 4 clear the child's standing
 * hold when the turn starts. Delivery is Loom's steered tier, as for every
 * control message: an idle child starts a turn; a busy one is steered only once
 * its run has a running provider turn on a live session, and otherwise queued
 * — the dispatcher promotes it into that turn once the turn is up (DL-662), or
 * it starts the next one (never upstream's `deliveryIntent: "auto"`, which picks a
 * steer for a run whose turn has not started and is then rejected — DL-660).
 * The result says which of the three happened.
 *
 * An UNSTARTED child (no `kickoffAt`) gets its kickoff in this message, as V1's
 * `kickoffTextForPrompt` did: the kickoff wrapper around its brief, then the
 * parent's message. The brief file is not edited. The arm records the kickoff
 * (rule 5) and refuses while its dependencies are unsatisfied (rule 2). An
 * unblocked `forkFrom` child first gets its session fork the way promotion
 * writes it — `thread.fork.prepare` under promotion's deterministic id, so
 * whichever runs first wins and the other replays its receipt.
 *
 * @module mcp/toolkits/workstream/handlers/prompt
 */
import { CommandId, type LoomThreadWorkstream, MessageId, ThreadId } from "@t3tools/contracts";
import { gateLoopTargetOf } from "@t3tools/shared/workstreamGraph";
import { dependenciesSatisfied } from "@t3tools/shared/workstreamStart.loom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { kickoffTextForPrompt } from "../../../../loom/prompt/childPrompt.ts";
import { readWorkstreamBriefAt } from "../../../../loom/workstream/brief.ts";
import * as Orchestrator from "../../../../orchestration-v2/Orchestrator.ts";
import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import { LoomToolError, type LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey } from "../idempotency.ts";
import { childrenOf, committed, dispatch, dispatchRefusal, fail, nowIso } from "./shared.ts";

/** The fork transfer for an unblocked fork child; a blocked one is left to rule 2's refusal. */
const prepareFork = Effect.fn("LoomToolkit.prepareFork")(function* (
  row: LoomThreadWorkstream,
  caller: WorkstreamCaller,
) {
  const siblings = new Map(
    (yield* childrenOf(caller.threadId)).map((child) => [
      child.threadId,
      { ...child, id: child.threadId },
    ]),
  );
  if (!dependenciesSatisfied({ ...row, id: row.threadId }, siblings)) return;
  const createdAt = yield* nowIso;
  yield* Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.fork.prepare",
        commandId: CommandId.make(`server:loom:fork-prepare:${row.threadId}`),
        threadId: row.threadId,
        createdAt,
        sourceThreadId: row.forkFromThreadId!,
      }),
    ),
    Effect.mapError(
      (error) =>
        new LoomToolError({
          message:
            error._tag === "LoomDispatchDeferredError"
              ? `Fork source ${row.forkFromThreadId} is mid-turn; forking now would copy an unfinished session. Wait for it to go idle, then prompt this child again to deliver its kickoff and launch the fork.`
              : dispatchRefusal(error),
        }),
    ),
  );
});

export const workstreamPrompt = Effect.fn("LoomToolkit.workstreamPrompt")(function* (
  input: LoomToolInput<"workstream_prompt">,
  caller: WorkstreamCaller,
) {
  const threadId = ThreadId.make(input.threadId.trim());
  if (input.message.trim().length === 0) return yield* fail("message is required.");
  if (threadId === caller.threadId)
    return yield* fail(
      `${t("workstream_prompt")} messages a direct child, not the calling thread.`,
    );
  const row = (yield* authoriseTarget(caller, threadId))!;
  if (row.outcome !== null)
    return yield* fail(
      `Thread ${threadId} is ${row.outcome}; prompting would re-engage it without changing its outcome. Reopen it with ${t("workstream_set_outcome")} 'none' first, or spawn a new child.`,
    );

  let text = input.message;
  if (row.kickoffAt === null) {
    if (row.kickoffBriefPath === null)
      return yield* fail(
        `Child ${threadId} has not been briefed yet — call ${t("workstream_brief")} to write its kickoff (it then launches once its dependencies clear). ${t("workstream_prompt")} steers an already-running child.`,
      );
    const brief = Option.getOrUndefined(yield* readWorkstreamBriefAt(row.kickoffBriefPath));
    if (brief === undefined)
      return yield* fail(
        `Child ${threadId} has a brief pointer but its file could not be read; re-attach it with ${t("workstream_brief")}.`,
      );
    if (row.forkFromThreadId !== null) yield* prepareFork(row, caller);
    text = kickoffTextForPrompt({
      delivered: false,
      role: row.role,
      brief,
      message: input.message,
      gateTargetId: gateLoopTargetOf(row),
    });
  }

  const id = yield* requestKey(undefined);
  const runs = committed(
    yield* dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:workstream-prompt:${threadId}:${id}`),
      threadId,
      messageId: MessageId.make(`message:workstream-prompt:${threadId}:${id}`),
      text,
      attachments: [],
      createdBy: "agent",
      creationSource: "mcp",
      senderThreadId: caller.threadId,
      dispatchMode: { type: "queue_after_active" },
      loom: { origin: "orchestrator" },
    }),
    "run.created",
  );
  return `Sent prompt to Workstream child ${threadId} (${
    runs.length === 0
      ? "steered into its running turn"
      : runs.every((event) => event.payload.status === "queued")
        ? "queued: its run cannot take a steer yet; it is steered in once its turn is up, else it starts the next turn"
        : row.kickoffAt === null
          ? "delivered with its kickoff brief as its first turn"
          : "starting its next turn"
  }).`;
});
