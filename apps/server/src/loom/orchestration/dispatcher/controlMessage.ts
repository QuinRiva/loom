/**
 * The one builder of a Loom control dispatch (Phase 3 plan "Wake tiers, ids and
 * modes"; strategy risk 7) and the deterministic `server:` command ids every
 * wake keys on. A tier decides the mode and no caller passes one:
 * decision-bearing wakes are `steered` (`queue_after_active`, which upstream's
 * delegated-completion block converts to a steer when the target is running and
 * steerable); FYI wakes are `fyi` (`start_if_idle`, which fails with
 * `LoomDispatchDeferredError` and no receipt while the target is busy).
 *
 * The message id is derived from the command id, so a retried episode lands as
 * the same message; 3b-2 reads "already delivered" from the target's stored
 * messages by that id.
 *
 * @module loom/orchestration/dispatcher/controlMessage
 */
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
 * Delivery of one `notify_thread` peer-message record. 3a's handler sends its
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
/** The `needs_guidance` raise on a thread that reads busy but silent while FYI wakes wait on it (V1 #304). */
export const wakeDeferredCommandId = (threadId: ThreadId, silentSince: string) =>
  `server:workstream-wake-deferred:${threadId}:${silentSince}`;
/** `thread.fork.prepare` on a forkFrom child, issued at promotion (P3-28). */
export const forkPrepareCommandId = (childId: ThreadId) => `server:loom:fork-prepare:${childId}`;
/** The `needs_guidance` park on a child whose brief file cannot be read at promotion. */
export const briefReadParkCommandId = (childId: ThreadId) => `server:loom:brief-read:${childId}`;
/** The quiescence rail's `thread.work.submit` (outcome `quiescent`), one per quiet run. */
export const quiescentSubmitCommandId = (threadId: ThreadId, runId: string) =>
  `server:loom:quiescent:${threadId}:${runId}`;
/** Startup redelivery of a stashed steer (seam 20). */
export const steerRedeliverCommandId = (threadId: ThreadId, hash: string) =>
  `server:loom:steer-redeliver:${threadId}:${hash}`;
