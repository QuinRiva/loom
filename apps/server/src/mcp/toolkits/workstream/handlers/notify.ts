/**
 * `mcp__t3-code__notify_thread`: a one-way push to any live thread, steer-or-start and never
 * an abort. The peer-message record lands FIRST (`thread.peer-message.record`
 * on the sender): it is the cap's ledger, the board's edge and the control
 * plane's durable queue, and the arm refuses it for a finished, archived or
 * deleted target — so a refused record sends nothing. Then the message itself
 * goes out as ONE direct `message.dispatch` (never `sendToThread`, which drops
 * `loom`) with origin `notify`, under the deterministic id 3b's
 * deferred-delivery rail uses for the same record, so whichever lands second
 * replays the receipt instead of delivering twice; a landed message is marked
 * delivered. A delivery that fails leaves the record pending for that rail.
 *
 * @module mcp/toolkits/workstream/handlers/notify
 */
import { CommandId, MessageId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import { resolveThread } from "../../../../loom/workstream/threadResolve.ts";
import {
  NOTIFY_PAIR_HOURLY_CAP,
  NOTIFY_PAIR_WINDOW_MS,
} from "../../../../orchestration-v2/Orchestrator.loom.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { agentToolName as t } from "../families.ts";
import { requestKey } from "../idempotency.ts";
import {
  composeNotifyFramedText,
  renderNotifyCandidates,
  renderNotifyDisposition,
} from "../render.ts";
import {
  asToolError,
  candidateOf,
  committed,
  dispatch,
  fail,
  requireShell,
  senderDescriptor,
} from "./shared.ts";

/** ~4k tokens: a notice with a results summary and paths, never a pasted report. */
const MESSAGE_MAX_CHARS = 16_000;

/** The ids one record's lifecycle shares with 3b's notify-delivery rail (seam 6). */
export const notifyIds = (recordId: string) => ({
  record: CommandId.make(`server:workstream-notify-record:${recordId}`),
  deliver: CommandId.make(`server:workstream-notify:${recordId}`),
  message: MessageId.make(`message:server:workstream-notify:${recordId}`),
  mark: CommandId.make(`server:workstream-notify-mark:${recordId}`),
});

export const notifyThread = Effect.fn("LoomToolkit.notifyThread")(function* (
  input: LoomToolInput<"notify_thread">,
  caller: WorkstreamCaller,
) {
  const message = input.message.trim();
  if (message.length === 0) return yield* fail("message is required.");
  if (message.length > MESSAGE_MAX_CHARS)
    return yield* fail(
      `message must be at most ${MESSAGE_MAX_CHARS} characters; reference bulk content by absolute path instead of pasting it inline.`,
    );
  const resolved = yield* asToolError(resolveThread(input));
  if (resolved.kind === "missing") return yield* fail(resolved.message);
  // An ambiguous name sends nothing: a misdelivered push engages the wrong session.
  if (resolved.kind === "candidates")
    return renderNotifyCandidates(resolved.shells.map(candidateOf));
  const target = resolved.shell;
  if (target.id === caller.threadId) return yield* fail("You cannot notify your own thread.");
  if (target.workstream?.parentThreadId != null && target.workstream.kickoffAt === null)
    return yield* fail(
      `Thread ${target.id} has not started yet; its kickoff belongs to its parent. Notify the parent, or wait for the target to launch.`,
    );

  const now = yield* DateTime.now;
  const createdAt = DateTime.formatIso(now);
  // The arm caps senders that have a sidecar row; the ledger caps every sender.
  const sent = yield* asToolError(
    Effect.flatMap(LoomStore.LoomStoreV2, (store) =>
      store.peerMessages.countSent(
        caller.threadId,
        target.id,
        DateTime.formatIso(DateTime.subtract(now, { milliseconds: NOTIFY_PAIR_WINDOW_MS })),
      ),
    ),
  );
  if (sent >= NOTIFY_PAIR_HOURLY_CAP)
    return yield* fail(
      `${t("notify_thread")} rate cap reached: at most ${NOTIFY_PAIR_HOURLY_CAP} notifications per hour from ${caller.threadId} to ${target.id}. The recipient owes no reply; use ${t("consult_thread")} if you need an answer.`,
    );

  const self = yield* requireShell(caller.threadId);
  const framedMessage = composeNotifyFramedText(
    yield* senderDescriptor(caller, target),
    caller.threadId,
    message,
  );
  const targetTitle = target.title || target.id;
  const recordId = yield* requestKey(undefined);
  const ids = notifyIds(recordId);
  yield* dispatch({
    type: "thread.peer-message.record",
    commandId: ids.record,
    threadId: caller.threadId,
    createdAt,
    recordId,
    targetThreadId: target.id,
    targetTitle,
    message,
    framedMessage,
  });

  const delivered = yield* dispatch({
    type: "message.dispatch",
    commandId: ids.deliver,
    threadId: target.id,
    messageId: ids.message,
    text: framedMessage,
    attachments: [],
    createdBy: "agent",
    creationSource: "mcp",
    senderThreadId: caller.threadId,
    deliveryIntent: "auto",
    dispatchMode: { type: "queue_after_active" },
    loom: {
      origin: "notify",
      controlPayload: {
        kind: "notice",
        notice: "notify",
        heading: "A message from another thread.",
        items: [{ threadId: caller.threadId, title: `From ${self.title || caller.threadId}` }],
      },
    },
  }).pipe(
    Effect.map((result) => committed(result, "run.created")),
    Effect.tapError((cause) =>
      Effect.logWarning("loom.notify.immediate-delivery-failed", { recordId, cause }),
    ),
    Effect.option,
  );
  if (delivered._tag === "Some")
    yield* dispatch({
      type: "thread.peer-message.mark-delivered",
      commandId: ids.mark,
      threadId: caller.threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      recordId,
    });
  return renderNotifyDisposition({
    targetThreadId: target.id,
    targetTitle,
    disposition:
      delivered._tag === "None"
        ? "queued"
        : delivered.value.length === 0
          ? "steered"
          : delivered.value.every((event) => event.payload.status === "queued")
            ? "queued"
            : "started",
  });
});
