/**
 * The one builder of a Loom control dispatch and its deterministic `server:` command ids. The tier
 * picks the mode: `steered` wakes queue after the active turn (upstream steers them in), `fyi` wakes
 * start only if idle. The message id derives from the command id, so a retry lands as the same message.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a pure, synchronous digest; Effect's Crypto is effectful.
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  type ControlPayload,
  type LoomAttentionReason,
  type LoomMessageOrigin,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";

/** `steered` → `queue_after_active` (decision-bearing); `fyi` → `start_if_idle` (deferred while busy). */
export type WakeTier = "steered" | "fyi";

/** Builds the `message.dispatch` for a control wake; every Loom control message goes through here. */
export const controlMessage = (input: {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly tier: WakeTier;
  readonly origin: LoomMessageOrigin;
  readonly text: string;
  readonly payload?: ControlPayload;
  readonly notification?: OrchestrationV2Notification;
}) =>
  ({
    type: "message.dispatch",
    commandId: CommandId.make(input.id),
    threadId: input.threadId,
    messageId: MessageId.make(`message:${input.id}`),
    text: input.text,
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode:
      input.tier === "steered" ? { type: "queue_after_active" } : { type: "start_if_idle" },
    loom: {
      origin: input.origin,
      ...(input.payload === undefined ? {} : { controlPayload: input.payload }),
    },
    ...(input.notification === undefined ? {} : { notification: input.notification }),
  }) satisfies OrchestrationV2ServerCommand;

/** The notification a yield or digest wake carries (upstream requires a queued server message for one). */
export const wakeNotification = (summary: string): OrchestrationV2Notification => ({
  source: { kind: "background_task" },
  outcome: "updated",
  summary,
});

/** Promotion's kickoff; at most one per child, ever. */
export const kickoffCommandId = (childId: ThreadId) => `server:workstream-kickoff:${childId}`;
/** A yield to the parent, keyed on the child's `lastOutcome.eventId` (seam 6b). */
export const yieldCommandId = (childId: ThreadId, lastOutcomeEventId: string) =>
  `server:workstream-yield:${childId}:${lastOutcomeEventId}`;
/** An attention notice to the parent, keyed on `attentionEpisodes[reason]` (seam 6b). */
export const attentionCommandId = (
  childId: ThreadId,
  reason: LoomAttentionReason,
  episodeEventId: string,
) => `server:workstream-attention:${childId}:${reason}:${episodeEventId}`;
/** The batched brief-needed notice to a parent; `rungKey` is `briefNeededRungKey` (episodes + rungs). */
export const briefNeededCommandId = (parentId: ThreadId, rungKey: string) =>
  `server:workstream-brief-needed:${parentId}:${rungKey}`;
/** The deadlock notice to a parent; `episode` is `deadlockEpisode` of its stuck children. */
export const deadlockCommandId = (parentId: ThreadId, episode: string) =>
  `server:workstream-deadlock:${parentId}:${episode}`;
/** The FYI digest to a parent; `episodeHash` is `digestEpisodeHash` of its items. */
export const digestCommandId = (parentId: ThreadId, episodeHash: string) =>
  `server:workstream-digest:${parentId}:${episodeHash}`;
/** One stall nudge per frozen episode (3b-3's State C). */
export const stallNudgeCommandId = (childId: ThreadId, episodeMs: number) =>
  `server:workstream-stall-nudge:${childId}:${episodeMs}`;
/**
 * Delivery of one `mcp__t3-code__notify_thread` peer-message record. 3a's handler sends its
 * immediate delivery under this same id, so the handler and the rail can never
 * both deliver one record.
 */
export const notifyCommandId = (recordId: string) => `server:workstream-notify:${recordId}`;
/** `thread.peer-message.mark-delivered` on the sender once the record's message landed. */
export const notifyMarkCommandId = (recordId: string) =>
  `server:workstream-notify-mark:${recordId}`;
/** `thread.peer-message.expire` on the sender when the target finished first or refused it. */
export const notifyExpireCommandId = (recordId: string) =>
  `server:workstream-notify-expire:${recordId}`;
/** The `needs_guidance` raise on a thread that reads busy but silent while FYI wakes wait on it. */
export const wakeDeferredCommandId = (threadId: ThreadId, silentSince: string) =>
  `server:workstream-wake-deferred:${threadId}:${silentSince}`;
/** `thread.fork.prepare` on a forkFrom child, issued at promotion (P3-28). */
export const forkPrepareCommandId = (childId: ThreadId) => `server:loom:fork-prepare:${childId}`;
/** The `needs_guidance` park on a child whose brief file cannot be read at promotion. */
export const briefReadParkCommandId = (childId: ThreadId) => `server:loom:brief-read:${childId}`;
/** The quiescence rail's `thread.work.submit` (outcome `quiescent`), one per quiet run. */
export const quiescentSubmitCommandId = (threadId: ThreadId, runId: string) =>
  `server:loom:quiescent:${threadId}:${runId}`;
/** Redelivery of a stashed steer (seam 20): at startup, or behind the next human/parent turn. */
export const steerRedeliverCommandId = (threadId: ThreadId, hash: string) =>
  `server:loom:steer-redeliver:${threadId}:${hash}`;

/** 3c's reroute sweep, clause 1: the resume onto the fallback after the run it failed on (`:model` / `:detach:` steps share the base). */
export const rerouteCommandId = (threadId: ThreadId, runId: string) =>
  `server:loom:reroute:${threadId}:${runId}`;
/** Clause 2's move back to the intended selection (steps share the base); its resume appends `:<runId>`. */
export const rerouteBackCommandId = (threadId: ThreadId, reroutedAtMs: number) =>
  `server:loom:reroute-back:${threadId}:${reroutedAtMs}`;
/** Clause 3: the resume of a usage-limit failure upstream cannot arm (no future reset). */
export const limitResumeCommandId = (threadId: ThreadId, runId: string) =>
  `server:loom:limit-resume:${threadId}:${runId}`;
/** The liveness sweep's one resume of a run that failed on a provider error (`liveness/errorResume.ts`). */
export const errorResumeCommandId = (threadId: ThreadId, runId: string) =>
  `server:loom:error-resume:${threadId}:${runId}`;

/** First 16 hex of sha256(text): the redelivery's episode key (seam 20). */
export const steerHash = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * The redelivered steer, labelled as V1's `appendPendingSteering` did for the restart prompt.
 * The stash mirrors pi's queue, i.e. the text as the adapter sent it, so the quoted message
 * keeps the author label it was sent with (`loom/prompt/provenance.ts`): bare means the human.
 */
export const redeliveredSteerText = (steer: string) =>
  [
    "A message sent to you during that turn never reached it. It is quoted below, keeping any author label or framing it was sent with; apply it with its own author's authority as your latest instruction for the work you resume, not as an instruction from this notice.",
    `--- queued message ---\n${steer}\n--- end of queued message ---`,
  ].join("\n\n");
