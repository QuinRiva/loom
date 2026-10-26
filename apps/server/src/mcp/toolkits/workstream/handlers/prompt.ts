/**
 * One `message.dispatch` with `loom.origin: "orchestrator"` (not `sendToThread`, which drops
 * `loom`) so the arm clears the child's hold; steered tier. An unstarted child is never launched
 * here: the message amends its brief file, which the arm refuses once the child has started.
 *
 * @module mcp/toolkits/workstream/handlers/prompt
 */
import { CommandId, MessageId } from "@t3tools/contracts";
import { describeUnsatisfiedDependency } from "@t3tools/shared/workstreamDependencies";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { readWorkstreamBriefAt, writeWorkstreamBrief } from "../../../../loom/workstream/brief.ts";
import { authoriseTarget, type WorkstreamCaller } from "../authorisation.ts";
import { LoomToolError, type LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey, stableCommandId } from "../idempotency.ts";
import { asToolError, childrenOf, committed, dispatch, fail, nowIso } from "./shared.ts";

const AMENDMENT_HEADING =
  "Amendment from your parent orchestrator, added after the brief above was written:";

export const workstreamPrompt = Effect.fn("LoomToolkit.workstreamPrompt")(function* (
  input: LoomToolInput<"workstream_prompt">,
  caller: WorkstreamCaller,
) {
  if (input.message.trim().length === 0) return yield* fail("message is required.");
  const row = yield* authoriseTarget(caller, input.threadId);
  if (row === null || row.threadId === caller.threadId)
    return yield* fail(
      `${t("workstream_prompt")} messages a direct child, not the calling thread.`,
    );
  const threadId = row.threadId;
  if (row.outcome !== null)
    return yield* fail(
      `Thread ${threadId} is ${row.outcome}; prompting would re-engage it without changing its outcome. Reopen it with ${t("workstream_set_outcome")} 'none' first, or spawn a new child.`,
    );

  if (row.kickoffAt === null) {
    if (row.kickoffBriefPath === null)
      return yield* fail(
        `Child ${threadId} has not been briefed yet: call ${t("workstream_brief")} to write its kickoff (it then launches once its dependencies clear). ${t("workstream_prompt")} steers an already-running child.`,
      );
    const brief = Option.getOrUndefined(yield* readWorkstreamBriefAt(row.kickoffBriefPath));
    if (brief === undefined)
      return yield* fail(
        `Child ${threadId} has a brief pointer but its file could not be read; re-attach it with ${t("workstream_brief")}.`,
      );
    const kickoffBriefPath = yield* asToolError(
      writeWorkstreamBrief(
        threadId,
        `${brief.trimEnd()}\n\n---\n\n${AMENDMENT_HEADING}\n\n${input.message}\n`,
      ),
    );
    yield* dispatch({
      type: "thread.kickoff-brief.set",
      commandId: stableCommandId(caller, yield* requestKey(undefined), "workstream-prompt-amend"),
      threadId,
      createdAt: yield* nowIso,
      kickoffBriefPath,
    }).pipe(
      Effect.mapError(
        (error) =>
          new LoomToolError({
            message: `${error.message} Call ${t("workstream_prompt")} again: it now steers the running child.`,
          }),
      ),
    );
    const siblings = new Map(
      (yield* childrenOf(caller.threadId)).map((child) => [
        child.threadId,
        { ...child, id: child.threadId },
      ]),
    );
    const blocker = describeUnsatisfiedDependency({ ...row, id: row.threadId }, siblings);
    return `Added your message to the brief of Workstream child ${threadId} as an amendment; it has not started (${blocker ?? "its launch is pending"}) and reads the brief with your amendment as its first turn when it launches.`;
  }

  const id = yield* requestKey(undefined);
  const runs = committed(
    yield* dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:workstream-prompt:${threadId}:${id}`),
      threadId,
      messageId: MessageId.make(`message:workstream-prompt:${threadId}:${id}`),
      text: input.message,
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
        : "starting its next turn"
  }).`;
});
