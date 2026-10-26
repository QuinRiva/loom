// Loom's sidecar contract beside upstream's Orchestration V2 unions. Workstream state is a sidecar
// row per thread, not `OrchestrationV2AppThread` fields: V2 upserts full rows and spreads parents
// into children. HARD CONSTRAINT: never VALUE-import `orchestrationV2.ts`, which splices this in at
// init (a TDZ crash); the upstream schemas Loom members need are passed into the two factories.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import {
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { PlanCommentAnchor } from "./plan.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

// Type-only (erased) — safe against the value cycle.
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ServerCommand,
} from "./orchestrationV2.ts";

// Enums and small types

/**
 * Stored attention: the reasons a thread needs a human or its parent. The
 * request-derived reasons (`awaiting_approval` / `awaiting_input`) are NOT
 * stored — consumers read `shell.pendingRuntimeRequest.kind`.
 * `awaiting_orchestrator` replaces V1's `yielded` lane.
 */
export const LoomAttentionReason = Schema.Literals([
  "error",
  "awaiting_acceptance",
  "needs_guidance",
  "awaiting_orchestrator",
]);
export type LoomAttentionReason = typeof LoomAttentionReason.Type;

/** The plan-terminal fact. Stored as `NullOr`; only `done` releases dependents. */
export const LoomOutcome = Schema.Literals(["done", "cancelled"]);
export type LoomOutcome = typeof LoomOutcome.Type;

/** Who composed a Loom-originated message. Absent = not Loom-originated. */
export const LoomMessageOrigin = Schema.Literals([
  "kickoff",
  "orchestrator",
  "control_notice",
  "notify",
]);
export type LoomMessageOrigin = typeof LoomMessageOrigin.Type;

/** `thread.kickoff-recorded`'s origin: a Loom origin, a human (`user`), or anything else. */
export const LoomKickoffOrigin = Schema.Literals([...LoomMessageOrigin.literals, "user", "other"]);
export type LoomKickoffOrigin = typeof LoomKickoffOrigin.Type;

/** What a `notice` control message is about (seam 6, P3-25); present when `kind` is `notice`. */
export const LoomControlNoticeKind = Schema.Literals([
  "gate-rework",
  "gate-reverify",
  "brief-needed",
  "deadlock",
  "stall-nudge",
  "attention",
  "notify",
]);
export type LoomControlNoticeKind = typeof LoomControlNoticeKind.Type;

/** What one digest item reports (seam 6); gate resolution reaches the parent only as `gate-resolved`. */
export const LoomControlItemKind = Schema.Literals([
  "terminal",
  "gate-resolved",
  "recovered",
  "slow-tool",
  "spinning",
  "dead-episode",
  // Never emitted since 23 Oct 2026, but stored digests carry it and must still decode.
  "human-message",
]);
export type LoomControlItemKind = typeof LoomControlItemKind.Type;

// One item in a structured control-plane payload — a single sub-thread the
// notice concerns (or a pure informational line). Every field beyond `title` is
// optional so the renderer degrades gracefully (and an unknown kind falls back
// to the raw text).
export const ControlPayloadItem = Schema.Struct({
  kind: Schema.optional(LoomControlItemKind),
  threadId: Schema.optional(ThreadId),
  role: Schema.optional(Schema.String),
  title: Schema.String,
  status: Schema.optional(Schema.String),
  icon: Schema.optional(Schema.String),
  reportPath: Schema.optional(Schema.String),
  excerpt: Schema.optional(Schema.String),
  /** The `.md`/`.mdx`/`.html` files the report names, as written (absolute, or workspace-relative): the card's document chips. */
  documents: Schema.optional(Schema.Array(Schema.String)),
  timestamp: Schema.optional(Schema.String),
});
export type ControlPayloadItem = typeof ControlPayloadItem.Type;

// Structured source of truth for a control-plane digest/notice message. `text`
// stays the exact bytes the model received; this drives the collapsed card.
export const ControlPayload = Schema.Struct({
  kind: Schema.Literals(["digest", "yield", "notice"]),
  notice: Schema.optional(LoomControlNoticeKind),
  /** On a `yield`: the outcome was the dispatcher's quiescence submit, not the agent's. */
  synthesised: Schema.optional(Schema.Boolean),
  heading: Schema.optional(Schema.String),
  items: Schema.Array(ControlPayloadItem),
});
export type ControlPayload = typeof ControlPayload.Type;

/**
 * Rides `message.dispatch` and `OrchestrationV2ConversationMessage` as one
 * optional `loom` key. `humanAuthored` is stamped once by the dispatchMessage
 * hunk (`isHumanAuthored`, DL-194) and is the one human predicate every Loom
 * reader uses.
 */
export const LoomMessageFields = Schema.Struct({
  origin: Schema.optional(LoomMessageOrigin),
  humanAuthored: Schema.optional(Schema.Boolean),
  controlPayload: Schema.optional(ControlPayload),
});
export type LoomMessageFields = typeof LoomMessageFields.Type;

/** Default loop-round cap for a review gate when the spawner sets none. */
export const DEFAULT_GATE_MAX_ROUNDS = 2;
/** Maximum accepted loop-round cap for a review gate. */
export const MAX_GATE_MAX_ROUNDS = 10;
/** Outcomes refused in any route's `on`; accepted on submit only from `server:` ids. */
export const RESERVED_OUTCOMES = ["quiescent"] as const;

/**
 * An outcome-predicated route edge on the thread that EMITS the outcomes (the
 * gate source, e.g. the reviewer). `loop` re-dispatches the counterpart named
 * by `to` (round-capped); `resolve` completes the gate.
 */
export const WorkstreamRoute = Schema.Struct({
  on: Schema.Array(TrimmedNonEmptyString),
  kind: Schema.Literals(["loop", "resolve"]),
  to: Schema.optional(ThreadId),
  maxRounds: Schema.optional(PositiveInt),
});
export type WorkstreamRoute = typeof WorkstreamRoute.Type;

/** The routing verdict the arm reached for a submitted outcome. */
export const WorkOutcomeDecision = Schema.Literals([
  "terminal",
  "attention",
  "loop",
  "resolve",
  "cap-breach",
  "yield",
]);
export type WorkOutcomeDecision = typeof WorkOutcomeDecision.Type;

/** Reviewer finding counts, opaque to routing — audit trail + UI verdict chip. */
export const WorkOutcomeCounts = Schema.Struct({
  mustFix: NonNegativeInt,
  niceToHave: NonNegativeInt,
});
export type WorkOutcomeCounts = typeof WorkOutcomeCounts.Type;

/**
 * The sidecar's most recent submitted outcome. `eventId` is the
 * `thread.outcome-recorded` event id — the yield/digest episode key; null on
 * rows Phase 4's importer writes (DL-198), which no episode rule fires for.
 */
export const WorkOutcomeRecord = Schema.Struct({
  outcome: TrimmedNonEmptyString,
  decision: WorkOutcomeDecision,
  round: NonNegativeInt,
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  /** True for the dispatcher's quiescence submit (plan §6; seam 8 renders it). */
  synthesised: Schema.optional(Schema.Boolean),
  eventId: Schema.NullOr(EventId),
  at: IsoDateTime,
});
export type WorkOutcomeRecord = typeof WorkOutcomeRecord.Type;

/** `thread.route-taken`'s kind: a source loop, a target routing back, or a resolve. */
export const LoomRouteKind = Schema.Literals(["loop", "loop-back", "resolve"]);
export type LoomRouteKind = typeof LoomRouteKind.Type;

/** The sidecar's latest route traversal — the episode key for gate re-drives. */
export const LoomRouteRecord = Schema.Struct({
  to: ThreadId,
  round: NonNegativeInt,
  kind: LoomRouteKind,
  eventId: EventId,
});
export type LoomRouteRecord = typeof LoomRouteRecord.Type;

// mcp__t3-code__notify_thread loop safety: a bounded, pruned per-sender send log backing the
// arm's ordered-pair hourly cap.
export const NotifySendLogEntry = Schema.Struct({
  targetThreadId: ThreadId,
  at: IsoDateTime,
});
export type NotifySendLogEntry = typeof NotifySendLogEntry.Type;

// One placed `mcp__t3-code__goal_handoff` destination: the goal + staged root thread the
// handoff created, the drafter that placed it, and when.
export const HandoffDestination = Schema.Struct({
  goalId: GoalId,
  threadId: ThreadId,
  drafterThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  createdAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type HandoffDestination = typeof HandoffDestination.Type;

// The other end of a HandoffDestination, on the root the handoff created: who started it.
// `human` = Carl's `/handoff` (credits the thread he typed it in, not the hidden drafter).
export const HandoffOrigin = Schema.Struct({
  threadId: ThreadId,
  initiatedBy: Schema.Literals(["agent", "human"]),
});
export type HandoffOrigin = typeof HandoffOrigin.Type;

/**
 * A query thread's role: a read-only, visible fork of a document's author (the
 * thread whose composer a Comment would reach) that the human questions about
 * one revision of that document (plans/plan-query-threads/plan.mdx §2.1).
 */
export const DOCUMENT_QUERY_ROLE = "document-query";

/** One question asked in a query thread, pinned to the passage it was asked about. */
export const LoomDocumentQueryQuestion = Schema.Struct({
  /** The human message carrying the question. */
  messageId: MessageId,
  /** The conversation-jump anchor a pin opens. */
  askedAt: IsoDateTime,
  anchor: PlanCommentAnchor,
  quotedText: Schema.String.check(Schema.isMaxLength(16_000)),
  sectionTitle: Schema.String,
});
export type LoomDocumentQueryQuestion = typeof LoomDocumentQueryQuestion.Type;

/**
 * A promoted exchange as the `mdx-anchor` review comment it seeds into the
 * author's composer, minus what the promotion already names: the chip id is
 * `promotionId` and the file is the query's `filePath`.
 */
export const LoomDocumentQueryComment = Schema.Struct({
  text: TrimmedNonEmptyString,
  anchor: PlanCommentAnchor,
  quotedText: Schema.String.check(Schema.isMaxLength(16_000)),
  sectionId: Schema.String,
  sectionTitle: Schema.String,
  rangeLabel: Schema.String,
});
export type LoomDocumentQueryComment = typeof LoomDocumentQueryComment.Type;

/** One exchange the query thread distilled into a comment for the author. */
export const LoomDocumentQueryPromotion = Schema.Struct({
  /** The chip id in the author's composer; the seed-once key. */
  promotionId: TrimmedNonEmptyString,
  promotedAt: IsoDateTime,
  /** The `askedAt` of the question turn it distils. */
  exchangeAt: IsoDateTime,
  comment: LoomDocumentQueryComment,
});
export type LoomDocumentQueryPromotion = typeof LoomDocumentQueryPromotion.Type;

/**
 * Which thread a query forks: the thread that signed the document (its
 * `manager_sessions` manifest), or the viewing thread when none resolves.
 */
export const DocumentQueryAuthorSource = Schema.Literals(["signature", "viewing-thread"]);
export type DocumentQueryAuthorSource = typeof DocumentQueryAuthorSource.Type;

/**
 * A query thread's document: one revision of one file. A rewrite forks a new
 * query thread rather than changing these, so `filePath` and `revision` are set
 * once, by the first question. Promoting does not close the thread.
 */
export const LoomDocumentQuery = Schema.Struct({
  /** Workspace-relative, as the annotation layer names it. */
  filePath: TrimmedNonEmptyString,
  /** SHA-256 of the file bytes when first asked, 12 hex characters. */
  revision: TrimmedNonEmptyString,
  /** How the author (`forkFromThreadId`) was chosen, set by the first question. */
  authorSource: DocumentQueryAuthorSource,
  questions: Schema.Array(LoomDocumentQueryQuestion),
  promotions: Schema.Array(LoomDocumentQueryPromotion),
});
export type LoomDocumentQuery = typeof LoomDocumentQuery.Type;

// mcp__t3-code__consult_thread observability: one entry per distinct target this thread has
// consulted (the full question + answer live on `thread.consult-recorded`).
export const LoomThreadConsultSummary = Schema.Struct({
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  count: NonNegativeInt,
  lastConsultAt: IsoDateTime,
  lastQuestionPreview: Schema.String,
});
export type LoomThreadConsultSummary = typeof LoomThreadConsultSummary.Type;

// mcp__t3-code__notify_thread observability: one entry per distinct target this thread has
// notified, with the still-undelivered count.
export const LoomThreadPeerMessageSummary = Schema.Struct({
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  count: NonNegativeInt,
  pendingCount: NonNegativeInt,
  lastMessageAt: IsoDateTime,
  lastMessagePreview: Schema.String,
});
export type LoomThreadPeerMessageSummary = typeof LoomThreadPeerMessageSummary.Type;

// Goals (plain tables loom_goals / loom_goal_tasks, written by handlers)

export interface LoomGoalTask {
  readonly id: GoalTaskId;
  readonly goalId: GoalId;
  readonly parentTaskId: GoalTaskId | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt: IsoDateTime | null;
  readonly children: ReadonlyArray<LoomGoalTask>;
}

export interface LoomGoalTaskEncoded {
  readonly id: string;
  readonly goalId: string;
  readonly parentTaskId: string | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly children: ReadonlyArray<LoomGoalTaskEncoded>;
}

export const LoomGoalTask: Schema.Codec<LoomGoalTask, LoomGoalTaskEncoded> = Schema.Struct({
  id: GoalTaskId,
  goalId: GoalId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  text: TrimmedNonEmptyString,
  done: Schema.Boolean,
  position: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
  children: Schema.Array(
    Schema.suspend((): Schema.Codec<LoomGoalTask, LoomGoalTaskEncoded> => LoomGoalTask),
  ),
});

export const LoomGoal = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  description: Schema.String,
  tasks: Schema.Array(LoomGoalTask),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type LoomGoal = typeof LoomGoal.Type;

/** A goal as the shell stream carries it (deleted goals are `goal.removed`). */
export const LoomGoalShell = LoomGoal.mapFields(Struct.omit(["deletedAt"]));
export type LoomGoalShell = typeof LoomGoalShell.Type;

/**
 * Shell-stream goal items, spliced into `OrchestrationV2ShellStreamItem`. They carry NO `sequence`
 * (a goal write advances no thread event), so clients apply them ungated, last write wins by
 * `goal.updatedAt`, and resync from the snapshot on reconnect. Sent only to `loom: true` subscribers.
 */
export const LoomGoalShellStreamItemMembers = [
  Schema.Struct({ kind: Schema.Literal("goal.updated"), goal: LoomGoalShell }),
  Schema.Struct({ kind: Schema.Literal("goal.removed"), goalId: GoalId }),
] as const;
export type LoomGoalShellStreamItem = (typeof LoomGoalShellStreamItemMembers)[number]["Type"];

export const isLoomGoalShellStreamItem = <Item extends { readonly kind: string }>(
  item: Item,
): item is Extract<Item, { readonly kind: LoomGoalShellStreamItem["kind"] }> =>
  item.kind === "goal.updated" || item.kind === "goal.removed";

// The sidecar record and the shell fields

/**
 * One row per Loom thread, keyed by V2's ThreadId; stored fields only, the rest derived at read.
 * Board columns are derived: held = `held`; blocked = not held, a `blockedBy` outcome not `done`;
 * ready = not held, deps done, `kickoffAt` null; in progress = `kickoffAt` set, `outcome` null.
 */
export const LoomThreadWorkstream = Schema.Struct({
  threadId: ThreadId,
  /** Mirrors the thread row; lets goal queries skip the V2 join. */
  projectId: ProjectId,
  goalId: Schema.NullOr(GoalId),
  /** Task-tree branch this thread owns; null = unbound. */
  anchorTaskId: Schema.NullOr(GoalTaskId),
  /** Mirrors lineage.parentThreadId, indexed for graph SQL. */
  parentThreadId: Schema.NullOr(ThreadId),
  /** Mirrors lineage.rootThreadId, indexed. */
  rootThreadId: ThreadId,
  role: Schema.NullOr(TrimmedNonEmptyString),
  purpose: Schema.NullOr(TrimmedNonEmptyString),
  /** Scaffold key, unique among a parent's children. */
  graphKey: Schema.NullOr(TrimmedNonEmptyString),
  /** The one brief mechanism; null = unbriefed, does not start. */
  kickoffBriefPath: Schema.NullOr(TrimmedNonEmptyString),
  held: Schema.Boolean,
  heldSince: Schema.NullOr(IsoDateTime),
  outcome: Schema.NullOr(LoomOutcome),
  outcomeAt: Schema.NullOr(IsoDateTime),
  /** Episode key for cascade re-drives (null on imported rows). */
  outcomeEventId: Schema.NullOr(EventId),
  /** When the first turn was delivered, by anyone. */
  kickoffAt: Schema.NullOr(IsoDateTime),
  /**
   * Who wrote that first turn (`thread.kickoff-recorded`'s origin); null before it, or unknown
   * (a V1 import). A `goal_continue` launch is `kickoff` when the human sent the predecessor's
   * brief unedited, `user` when they edited it.
   */
  kickoffOrigin: Schema.NullOr(LoomKickoffOrigin).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  attention: Schema.Array(LoomAttentionReason),
  /**
   * The `thread.attention-raised` event id per standing reason — the attention
   * wake's episode key (seam 6b, DL-196). Written on raise, deleted on clear.
   */
  attentionEpisodes: Schema.Record(LoomAttentionReason, Schema.optionalKey(EventId)),
  blockedBy: Schema.Array(ThreadId),
  dependenciesSince: Schema.NullOr(IsoDateTime),
  /** Parent's run id at spawn; the join barrier key. */
  spawnGeneration: Schema.NullOr(TrimmedNonEmptyString),
  forkFromThreadId: Schema.NullOr(ThreadId),
  continuesThreadId: Schema.NullOr(ThreadId),
  routes: Schema.Array(WorkstreamRoute),
  gateRounds: NonNegativeInt,
  pendingRework: Schema.Boolean,
  lastOutcome: Schema.NullOr(WorkOutcomeRecord),
  /** Episode key for gate re-drives (null on imported rows). */
  lastRoute: Schema.NullOr(LoomRouteRecord),
  reportPath: Schema.NullOr(TrimmedNonEmptyString),
  handoffDestinations: Schema.Array(HandoffDestination),
  /** On a `goal_handoff` destination: the thread that started it. */
  handoffOrigin: Schema.NullOr(HandoffOrigin).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  notifySendLog: Schema.Array(NotifySendLogEntry),
  /** Set on a `DOCUMENT_QUERY_ROLE` thread by its first question; null on every other thread. */
  documentQuery: Schema.NullOr(LoomDocumentQuery).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Mirrored from thread.archived / unarchived. */
  archivedAt: Schema.NullOr(IsoDateTime),
  /** Mirrored from thread.unarchived; bounds the unarchive cascade (DL-199). */
  unarchivedAt: Schema.NullOr(IsoDateTime),
  /** Episode key for the unarchive cascade. */
  unarchivedEventId: Schema.NullOr(EventId),
  /** Mirrored from thread.deleted. */
  deletedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LoomThreadWorkstream = typeof LoomThreadWorkstream.Type;

/** The active provider thread's context window: tokens used of `maxTokens`. */
export const LoomContextUsage = Schema.Struct({
  usedTokens: NonNegativeInt,
  maxTokens: Schema.optional(PositiveInt),
});
export type LoomContextUsage = typeof LoomContextUsage.Type;

/**
 * What a running thread is doing now: a tool call in flight (`tool`, the
 * oldest one), or the model working between tool calls (`model`). `since` only
 * moves at tool boundaries, never per streamed token, so the shell stays quiet
 * while the model streams.
 */
export const LoomActiveStep = Schema.Struct({
  kind: Schema.Literals(["tool", "model"]),
  /** tool: the item's start. model: the run's last tool end, else its work start. */
  since: IsoDateTime,
  /** The tool's name (pi's tool name); null for `model`. */
  title: Schema.NullOr(Schema.String),
  /** The bash command's first line, or a read's path; null otherwise. */
  detail: Schema.NullOr(Schema.String),
});
export type LoomActiveStep = typeof LoomActiveStep.Type;

// Live consults (unsequenced shell-stream items, never persisted)

/** One tool call of a running consult's fork, for the consult card's step log. */
export const LoomConsultStep = Schema.Struct({
  /** pi's tool name. */
  title: Schema.String,
  /** The bash command's first line, a read's path, an rg pattern, a URL; at most 80 chars. */
  detail: Schema.NullOr(Schema.String),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  /** Null while running; false when the tool errored or the consult ended under it. */
  ok: Schema.NullOr(Schema.Boolean),
});
export type LoomConsultStep = typeof LoomConsultStep.Type;

/**
 * What a `consult_thread` fork is doing, published at its tool boundaries and
 * message ends (never per streamed token). The asker's consult card finds it by
 * `askerThreadId` + `questionKey` ({@link consultQuestionKey}): the MCP request
 * carries no tool-call id to name the card's turn item directly.
 */
export const LoomLiveConsult = Schema.Struct({
  consultId: Schema.String,
  askerThreadId: ThreadId,
  questionKey: Schema.String,
  targetThreadId: ThreadId,
  startedAt: IsoDateTime,
  /** Set on the consult's last item; the server forgets it after. */
  endedAt: Schema.NullOr(IsoDateTime),
  /** The fork's `provider/id`. */
  model: Schema.NullOr(Schema.String),
  step: Schema.NullOr(LoomActiveStep),
  /** Tool calls started so far; `recent` holds the last six. */
  toolCalls: NonNegativeInt,
  /** Summed from the fork's `message_end` usage (`cachedTokens` = cache read + write). */
  spend: Schema.NullOr(
    Schema.Struct({
      costUsd: Schema.Number,
      inputTokens: Schema.Number,
      outputTokens: Schema.Number,
      cachedTokens: Schema.Number,
    }),
  ),
  recent: Schema.Array(LoomConsultStep),
  /** The start of the fork's latest assistant text, at most 120 chars. */
  narration: Schema.NullOr(Schema.String),
  /** The live transcript while running; the retained one once ended. */
  forkSessionPath: Schema.NullOr(Schema.String),
});
export type LoomLiveConsult = typeof LoomLiveConsult.Type;

/**
 * Spliced into `OrchestrationV2ShellStreamItem` for `loom: true` subscribers.
 * No `sequence` and no snapshot field: a subscription opens with one item per
 * running consult, and the client keeps them out of the persisted shell.
 */
export const LoomConsultShellStreamItemMembers = [
  Schema.Struct({ kind: Schema.Literal("consult.updated"), consult: LoomLiveConsult }),
] as const;
export type LoomConsultShellStreamItem = (typeof LoomConsultShellStreamItemMembers)[number]["Type"];

export const isLoomConsultShellStreamItem = <Item extends { readonly kind: string }>(
  item: Item,
): item is Extract<Item, { readonly kind: LoomConsultShellStreamItem["kind"] }> =>
  item.kind === "consult.updated";

/** A pi thread's prompt-cache arm for life: `long` = 1-hour, `short` = 5-minute. */
export const LoomCacheRetention = Schema.Literals(["long", "short"]);
export type LoomCacheRetention = typeof LoomCacheRetention.Type;

/** A thread's idle keep-alive plan: pi will ping (`scheduled`) or will not (`stopped`). */
export const LoomCacheWarming = Schema.Literals(["scheduled", "stopped"]);
export type LoomCacheWarming = typeof LoomCacheWarming.Type;

/**
 * A thread's prompt-cache facts, from which a client computes when the cache goes cold: the arm,
 * the last real request's dispatch (pi's keep-alive anchor) and end, the last landed ping, and the
 * idle plan (null = undecided, reported by Loom's pi extension; `stopped` once the process exits).
 */
export const LoomThreadCache = Schema.Struct({
  retention: LoomCacheRetention,
  requestStartedAt: Schema.NullOr(IsoDateTime),
  requestEndedAt: Schema.NullOr(IsoDateTime),
  pingedAt: Schema.NullOr(IsoDateTime),
  warming: Schema.NullOr(LoomCacheWarming),
});
export type LoomThreadCache = typeof LoomThreadCache.Type;
/** The facts one write changes; absent keys keep their stored value. */
export type LoomThreadCachePatch = Partial<Omit<LoomThreadCache, "retention">>;

/**
 * pi's idle keep-alive horizon per arm, from the last request's dispatch: pi's 30-minute default for
 * 5-minute threads, and the 90 minutes Loom's composer sets (`PI_CACHE_WARMING_IDLE_MAX_MS`) for
 * 1-hour roots (one ping at about 54 min). The composer and the client's expiry estimate share it.
 */
export const LOOM_CACHE_HORIZON_MS = { long: 90 * 60_000, short: 30 * 60_000 } as const;

/**
 * A thread's cache row after a write, the moment it lands. Spliced into
 * `OrchestrationV2ShellStreamItem` for `loom: true` subscribers: no `sequence`,
 * never persisted; the client keeps it out of the persisted shell and falls
 * back to the snapshot's `workstream.cache` on (re)connect.
 */
export const LoomCacheShellStreamItemMembers = [
  Schema.Struct({
    kind: Schema.Literal("cache.updated"),
    threadId: ThreadId,
    cache: LoomThreadCache,
  }),
] as const;
export type LoomCacheShellStreamItem = (typeof LoomCacheShellStreamItemMembers)[number]["Type"];

export const isLoomCacheShellStreamItem = <Item extends { readonly kind: string }>(
  item: Item,
): item is Extract<Item, { readonly kind: LoomCacheShellStreamItem["kind"] }> =>
  item.kind === "cache.updated";

/** The card ↔ live-consult correlation key: FNV-1a of the trimmed question, base 36. */
export const consultQuestionKey = (question: string): string => {
  let hash = 0x811c9dc5;
  for (const char of question.trim()) {
    hash ^= char.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

/**
 * What clients see on `OrchestrationV2ThreadShell.workstream`: the record minus dispatcher-only
 * fields, plus consult and peer-message edge summaries and the tool-call count and context window,
 * read with the shell so a workstream surface never subscribes to a thread's projection.
 */
export const LoomThreadShellFields = LoomThreadWorkstream.mapFields((fields) => ({
  ...Struct.omit(fields, [
    "notifySendLog",
    "lastRoute",
    "outcomeEventId",
    "unarchivedEventId",
    "unarchivedAt",
    "attentionEpisodes",
  ]),
  consults: Schema.Array(LoomThreadConsultSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  peerMessages: Schema.Array(LoomThreadPeerMessageSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  toolCalls: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  contextUsage: Schema.NullOr(LoomContextUsage).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /** Null unless a run is active. */
  activeStep: Schema.NullOr(LoomActiveStep).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** Absent until the thread's first pi launch (and for every non-pi thread). */
  cache: Schema.optionalKey(LoomThreadCache),
}));
export type LoomThreadShellFields = typeof LoomThreadShellFields.Type;

// Commands — spliced at the HEAD of upstream's command unions

const LoomCommandFields = {
  commandId: CommandId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
} as const;

/** A gate leg's control message (the arm wraps it in a queue_after_active dispatch). */
export const LoomGateLegMessage = Schema.Struct({
  messageId: MessageId,
  text: Schema.String,
  controlPayload: ControlPayload,
});
export type LoomGateLegMessage = typeof LoomGateLegMessage.Type;

/** One node of `thread.scaffold`; shared fields come from the parent. */
export const LoomScaffoldNode = Schema.Struct({
  threadId: ThreadId,
  graphKey: TrimmedNonEmptyString,
  role: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString,
  purpose: Schema.NullOr(TrimmedNonEmptyString),
  blockedBy: Schema.optional(Schema.Array(ThreadId)),
  routes: Schema.optional(Schema.Array(WorkstreamRoute)),
  held: Schema.optional(Schema.Boolean),
  spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  forkFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  anchorTaskId: Schema.optional(Schema.NullOr(GoalTaskId)),
  kickoffBriefPath: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
});
export type LoomScaffoldNode = typeof LoomScaffoldNode.Type;

/**
 * Client-dispatchable Loom commands, spliced into `OrchestrationV2Command` so
 * `orchestration.dispatchCommand` and the MCP layer carry them unchanged.
 */
export const LoomClientCommandMembers = [
  Schema.Struct({
    type: Schema.Literal("thread.goal.set"),
    ...LoomCommandFields,
    goalId: Schema.NullOr(GoalId),
    anchorTaskId: Schema.optional(Schema.NullOr(GoalTaskId)),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.held.set"),
    ...LoomCommandFields,
    held: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("thread.outcome.set"),
    ...LoomCommandFields,
    outcome: Schema.NullOr(LoomOutcome),
  }),
  Schema.Struct({
    type: Schema.Literal("thread.attention.raise"),
    ...LoomCommandFields,
    reason: LoomAttentionReason,
  }),
  /** An absent `reason` clears every stored reason. */
  Schema.Struct({
    type: Schema.Literal("thread.attention.clear"),
    ...LoomCommandFields,
    reason: Schema.optional(LoomAttentionReason),
  }),
  /**
   * Locks `parentThreadId` (D22): sibling-graph edits serialise with spawn and
   * scaffold so concurrent edits cannot create a cycle. The handler fills it
   * from the sidecar; the arm refuses a mismatch (DL-202).
   */
  Schema.Struct({
    type: Schema.Literal("thread.dependencies.set"),
    ...LoomCommandFields,
    parentThreadId: ThreadId,
    blockedBy: Schema.Array(ThreadId),
  }),
] as const;

/** The id prefix that marks a Loom `mcp__t3-code__ask_user_question` runtime request (P3-26). */
export const LOOM_ASK_REQUEST_PREFIX = "loom-ask:";

/**
 * Server-only Loom commands, spliced into `OrchestrationV2InternalCommand`.
 * A factory because `thread.spawn` carries upstream's creation fields
 * (`createdBy` / `creationSource`) and `runtime-request.create` upstream's
 * question schema, which this file must not value-import.
 */
export const makeLoomInternalCommandMembers = <
  const CreationFields extends Schema.Struct.Fields,
  UserInputQuestion extends Schema.Top,
>(
  creationFields: CreationFields,
  userInputQuestion: UserInputQuestion,
) =>
  [
    /** Creates one child (or a staged root when `parentThreadId` is null). Locks the parent. */
    Schema.Struct({
      type: Schema.Literal("thread.spawn"),
      ...LoomCommandFields,
      ...creationFields,
      parentThreadId: Schema.NullOr(ThreadId),
      projectId: ProjectId,
      title: TrimmedNonEmptyString,
      modelSelection: ModelSelection,
      runtimeMode: RuntimeMode,
      interactionMode: ProviderInteractionMode,
      branch: Schema.NullOr(TrimmedNonEmptyString),
      worktreePath: Schema.NullOr(TrimmedNonEmptyString),
      role: Schema.NullOr(TrimmedNonEmptyString),
      purpose: Schema.NullOr(TrimmedNonEmptyString),
      goalId: Schema.NullOr(GoalId),
      anchorTaskId: Schema.optional(Schema.NullOr(GoalTaskId)),
      kickoffBriefPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      blockedBy: Schema.optional(Schema.Array(ThreadId)),
      routes: Schema.optional(Schema.Array(WorkstreamRoute)),
      held: Schema.optional(Schema.Boolean),
      spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
      forkFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
      continuesThreadId: Schema.optional(Schema.NullOr(ThreadId)),
      graphKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    }),
    /** Creates a whole child graph atomically; `threadId` is the parent (the lock). */
    Schema.Struct({
      type: Schema.Literal("thread.scaffold"),
      ...LoomCommandFields,
      held: Schema.optional(Schema.Boolean),
      nodes: Schema.Array(LoomScaffoldNode),
    }),
    Schema.Struct({
      type: Schema.Literal("thread.kickoff-brief.set"),
      ...LoomCommandFields,
      kickoffBriefPath: TrimmedNonEmptyString,
    }),
    /** The single terminal call; `outcome` absent = "done". */
    Schema.Struct({
      type: Schema.Literal("thread.work.submit"),
      ...LoomCommandFields,
      reportPath: TrimmedNonEmptyString,
      outcome: Schema.optional(TrimmedNonEmptyString),
      contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
      counts: Schema.optional(WorkOutcomeCounts),
    }),
    /** Gate leg on the coder (`threadId`); `routeEventId` must match the source's lastRoute. */
    Schema.Struct({
      type: Schema.Literal("thread.gate.rework"),
      ...LoomCommandFields,
      sourceThreadId: ThreadId,
      round: NonNegativeInt,
      routeEventId: EventId,
      message: LoomGateLegMessage,
    }),
    /** Gate leg on the reviewer (`threadId`). */
    Schema.Struct({
      type: Schema.Literal("thread.gate.reverify"),
      ...LoomCommandFields,
      sourceThreadId: ThreadId,
      round: NonNegativeInt,
      routeEventId: EventId,
      message: LoomGateLegMessage,
    }),
    /** Gate resolution on the counterpart (`threadId`). */
    Schema.Struct({
      type: Schema.Literal("thread.gate.resolve"),
      ...LoomCommandFields,
      sourceThreadId: ThreadId,
      routeEventId: EventId,
    }),
    /** Records one resolved consult on the asker (`threadId`). */
    Schema.Struct({
      type: Schema.Literal("thread.consult.record"),
      ...LoomCommandFields,
      targetThreadId: ThreadId,
      targetTitle: TrimmedNonEmptyString,
      question: TrimmedNonEmptyString,
      answer: Schema.String,
      resolved: Schema.Boolean,
      durationMs: NonNegativeInt,
      forkSessionPath: Schema.optional(TrimmedNonEmptyString),
    }),
    /** Records one mcp__t3-code__notify_thread message on the sender (`threadId`). */
    Schema.Struct({
      type: Schema.Literal("thread.peer-message.record"),
      ...LoomCommandFields,
      recordId: TrimmedNonEmptyString,
      targetThreadId: ThreadId,
      targetTitle: TrimmedNonEmptyString,
      message: TrimmedNonEmptyString,
      framedMessage: TrimmedNonEmptyString,
    }),
    Schema.Struct({
      type: Schema.Literal("thread.peer-message.mark-delivered"),
      ...LoomCommandFields,
      recordId: TrimmedNonEmptyString,
    }),
    Schema.Struct({
      type: Schema.Literal("thread.peer-message.expire"),
      ...LoomCommandFields,
      recordId: TrimmedNonEmptyString,
    }),
    Schema.Struct({
      type: Schema.Literal("thread.handoff.record"),
      ...LoomCommandFields,
      drafterThreadId: ThreadId,
      destinationGoalId: GoalId,
      destinationThreadId: ThreadId,
    }),
    /** Records one question on a query thread (`threadId`); the first one names the document. */
    Schema.Struct({
      type: Schema.Literal("thread.document-query.ask"),
      ...LoomCommandFields,
      filePath: TrimmedNonEmptyString,
      revision: TrimmedNonEmptyString,
      authorSource: DocumentQueryAuthorSource,
      question: LoomDocumentQueryQuestion,
    }),
    /** Records one promoted exchange on a query thread (`threadId`). */
    Schema.Struct({
      type: Schema.Literal("thread.document-query.promote"),
      ...LoomCommandFields,
      promotion: LoomDocumentQueryPromotion,
    }),
    /**
     * Writes the pending `fork` context transfer on a forkFrom child
     * (`threadId`) from `sourceThreadId`'s latest finished run, at promotion
     * (DL-197, Phase 3 plan P3-28).
     */
    Schema.Struct({
      type: Schema.Literal("thread.fork.prepare"),
      ...LoomCommandFields,
      sourceThreadId: ThreadId,
    }),
    /**
     * `mcp__t3-code__ask_user_question` (3a-4): opens a pending `user_input` runtime request
     * with its questions on `threadId`'s active run. `requestId` must carry
     * `LOOM_ASK_REQUEST_PREFIX` (the arm refuses otherwise).
     */
    Schema.Struct({
      type: Schema.Literal("runtime-request.create"),
      ...LoomCommandFields,
      requestId: RuntimeRequestId,
      questions: Schema.Array(userInputQuestion),
    }),
  ] as const;

// Events — spliced at the HEAD of OrchestrationV2DomainEvent and
// OrchestrationV2DomainEventJson. Every Loom event's base `threadId` is the
// sidecar row it changes; payload timestamps are IsoDateTime strings, so one
// payload schema serves both the Type and the Json union.

export const LoomWorkstreamCreatedPayload = Schema.Struct({
  parentThreadId: Schema.NullOr(ThreadId),
  rootThreadId: ThreadId,
  projectId: ProjectId,
  goalId: Schema.NullOr(GoalId),
  anchorTaskId: Schema.NullOr(GoalTaskId),
  role: Schema.NullOr(TrimmedNonEmptyString),
  purpose: Schema.NullOr(TrimmedNonEmptyString),
  graphKey: Schema.NullOr(TrimmedNonEmptyString),
  kickoffBriefPath: Schema.NullOr(TrimmedNonEmptyString),
  held: Schema.Boolean,
  blockedBy: Schema.Array(ThreadId),
  routes: Schema.Array(WorkstreamRoute),
  spawnGeneration: Schema.NullOr(TrimmedNonEmptyString),
  forkFromThreadId: Schema.NullOr(ThreadId),
  continuesThreadId: Schema.NullOr(ThreadId),
});

export const LoomOutcomeSetCause = Schema.Literals([
  "submit",
  "set",
  "cascade",
  "gate-reopen",
  "gate-resolve",
]);
export type LoomOutcomeSetCause = typeof LoomOutcomeSetCause.Type;

export const LoomGateWarningKind = Schema.Literals([
  "reopened-with-started-dependents",
  "target-done-mid-round",
]);
export type LoomGateWarningKind = typeof LoomGateWarningKind.Type;

/** Builds the Loom event members over upstream's (non-exported) event base fields. */
export const makeLoomDomainEventMembers = <const Base extends Schema.Struct.Fields>(base: Base) =>
  [
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.workstream-created"),
      payload: LoomWorkstreamCreatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.goal-set"),
      payload: Schema.Struct({
        goalId: Schema.NullOr(GoalId),
        anchorTaskId: Schema.optional(Schema.NullOr(GoalTaskId)),
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.held-set"),
      payload: Schema.Struct({ held: Schema.Boolean }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.outcome-set"),
      payload: Schema.Struct({ outcome: Schema.NullOr(LoomOutcome), cause: LoomOutcomeSetCause }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.kickoff-recorded"),
      payload: Schema.Struct({
        kickoffAt: IsoDateTime,
        messageId: MessageId,
        origin: LoomKickoffOrigin,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.attention-raised"),
      payload: Schema.Struct({ reason: LoomAttentionReason }),
    }),
    /** An absent `reason` cleared every stored reason. */
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.attention-cleared"),
      payload: Schema.Struct({ reason: Schema.optional(LoomAttentionReason) }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.dependencies-set"),
      payload: Schema.Struct({ blockedBy: Schema.Array(ThreadId) }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.kickoff-brief-set"),
      payload: Schema.Struct({ kickoffBriefPath: TrimmedNonEmptyString }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.report-set"),
      payload: Schema.Struct({ reportPath: TrimmedNonEmptyString }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.outcome-recorded"),
      payload: Schema.Struct({
        outcome: TrimmedNonEmptyString,
        decision: WorkOutcomeDecision,
        round: NonNegativeInt,
        contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
        counts: Schema.optional(WorkOutcomeCounts),
        /** True for the dispatcher's quiescence submit (plan §6). */
        synthesised: Schema.optional(Schema.Boolean),
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.route-taken"),
      payload: Schema.Struct({ to: ThreadId, round: NonNegativeInt, kind: LoomRouteKind }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.gate-rework-accepted"),
      payload: Schema.Struct({ sourceThreadId: ThreadId, round: NonNegativeInt }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.gate-warning"),
      payload: Schema.Struct({
        kind: LoomGateWarningKind,
        detail: Schema.String,
        threadIds: Schema.Array(ThreadId),
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.consult-recorded"),
      payload: Schema.Struct({
        askerThreadId: ThreadId,
        targetThreadId: ThreadId,
        targetTitle: Schema.String,
        question: Schema.String,
        answer: Schema.String,
        resolved: Schema.Boolean,
        durationMs: NonNegativeInt,
        forkSessionPath: Schema.optional(Schema.String),
        createdAt: IsoDateTime,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.peer-message-recorded"),
      payload: Schema.Struct({
        senderThreadId: ThreadId,
        recordId: Schema.String,
        targetThreadId: ThreadId,
        targetTitle: Schema.String,
        message: Schema.String,
        framedMessage: Schema.String,
        createdAt: IsoDateTime,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.peer-message-delivered"),
      payload: Schema.Struct({
        senderThreadId: ThreadId,
        recordId: Schema.String,
        updatedAt: IsoDateTime,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.peer-message-expired"),
      payload: Schema.Struct({
        senderThreadId: ThreadId,
        recordId: Schema.String,
        updatedAt: IsoDateTime,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.handoff-recorded"),
      payload: Schema.Struct({
        threadId: ThreadId,
        drafterThreadId: Schema.NullOr(ThreadId).pipe(
          Schema.withDecodingDefault(Effect.succeed(null)),
        ),
        destinationGoalId: GoalId,
        destinationThreadId: ThreadId,
        createdAt: IsoDateTime,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.document-query-asked"),
      payload: Schema.Struct({
        filePath: TrimmedNonEmptyString,
        revision: TrimmedNonEmptyString,
        authorSource: DocumentQueryAuthorSource,
        question: LoomDocumentQueryQuestion,
      }),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.document-query-promoted"),
      payload: Schema.Struct({ promotion: LoomDocumentQueryPromotion }),
    }),
  ] as const;

// Narrowing guards. The listed string tuples are checked against the spliced
// member tuples in BOTH directions, so an omission and a typo/extra entry are
// each a compile error naming the offending literal.

type AssertNever<T extends never> = T;

export const LOOM_COMMAND_TYPES = [
  "thread.goal.set",
  "thread.held.set",
  "thread.outcome.set",
  "thread.attention.raise",
  "thread.attention.clear",
  "thread.dependencies.set",
  "thread.spawn",
  "thread.scaffold",
  "thread.kickoff-brief.set",
  "thread.work.submit",
  "thread.gate.rework",
  "thread.gate.reverify",
  "thread.gate.resolve",
  "thread.consult.record",
  "thread.peer-message.record",
  "thread.peer-message.mark-delivered",
  "thread.peer-message.expire",
  "thread.handoff.record",
  "thread.document-query.ask",
  "thread.document-query.promote",
  "thread.fork.prepare",
  "runtime-request.create",
] as const;
export type LoomCommandType = (typeof LOOM_COMMAND_TYPES)[number];

type LoomCommandMemberType =
  | (typeof LoomClientCommandMembers)[number]["Type"]["type"]
  | ReturnType<
      typeof makeLoomInternalCommandMembers<Record<never, never>, Schema.Top>
    >[number]["Type"]["type"];
type _MissingLoomCommandTypes = AssertNever<Exclude<LoomCommandMemberType, LoomCommandType>>;
type _ExtraLoomCommandTypes = AssertNever<Exclude<LoomCommandType, LoomCommandMemberType>>;

export const LOOM_EVENT_TYPES = [
  "thread.workstream-created",
  "thread.goal-set",
  "thread.held-set",
  "thread.outcome-set",
  "thread.kickoff-recorded",
  "thread.attention-raised",
  "thread.attention-cleared",
  "thread.dependencies-set",
  "thread.kickoff-brief-set",
  "thread.report-set",
  "thread.outcome-recorded",
  "thread.route-taken",
  "thread.gate-rework-accepted",
  "thread.gate-warning",
  "thread.consult-recorded",
  "thread.peer-message-recorded",
  "thread.peer-message-delivered",
  "thread.peer-message-expired",
  "thread.handoff-recorded",
  "thread.document-query-asked",
  "thread.document-query-promoted",
] as const;
export type LoomEventType = (typeof LOOM_EVENT_TYPES)[number];

type LoomEventMemberType = ReturnType<
  typeof makeLoomDomainEventMembers<Record<never, never>>
>[number]["Type"]["type"];
type _MissingLoomEventTypes = AssertNever<Exclude<LoomEventMemberType, LoomEventType>>;
type _ExtraLoomEventTypes = AssertNever<Exclude<LoomEventType, LoomEventMemberType>>;

export type LoomCommand = Extract<OrchestrationV2ServerCommand, { readonly type: LoomCommandType }>;
export type LoomDomainEvent = Extract<OrchestrationV2DomainEvent, { readonly type: LoomEventType }>;

const LOOM_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(LOOM_COMMAND_TYPES);
const LOOM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(LOOM_EVENT_TYPES);

/** The one predicate every guard hunk uses; the false branch narrows to upstream's commands. */
export const isLoomCommand = <Command extends { readonly type: string }>(
  command: Command,
): command is Extract<Command, { readonly type: LoomCommandType }> =>
  LOOM_COMMAND_TYPE_SET.has(command.type);

export const isLoomDomainEvent = <Event extends { readonly type: string }>(
  event: Event,
): event is Extract<Event, { readonly type: LoomEventType }> => LOOM_EVENT_TYPE_SET.has(event.type);

/** For callers holding only an event's `type` (e.g. a `Pick<…, "type">`). */
export const isLoomEventType = (type: string): type is LoomEventType =>
  LOOM_EVENT_TYPE_SET.has(type);

/**
 * The per-thread lock key (upstream's `commandThreadId`) for a Loom command. Sibling-graph edits
 * lock the parent: spawn locks its parent (a staged root itself), scaffold `threadId` (the
 * parent), dependencies.set `parentThreadId`; every other command locks `threadId`.
 */
export const loomCommandThreadId = (command: LoomCommand): ThreadId => {
  switch (command.type) {
    case "thread.spawn":
      return command.parentThreadId ?? command.threadId;
    case "thread.dependencies.set":
      return command.parentThreadId;
    default:
      return command.threadId;
  }
};

/**
 * What Loom's session composer adds to a provider open (pull 9 Area G): the thread's prompt,
 * skills, extensions and env. Here so provider-core's `ProviderAdapter` and provider-pi's
 * `mcpInjection` can name it; composed in apps/server `loom/prompt/sessionComposer.ts`.
 */
export interface LoomOpenSessionFields {
  /** Appended to pi's system prompt; `""` appends nothing. */
  readonly appendSystemPrompt: string;
  /** One `--skill <path>` each. */
  readonly skills: ReadonlyArray<string>;
  /** One `--extension <path>` each, beside upstream's bridge extension. */
  readonly extensions: ReadonlyArray<string>;
  /**
   * Merged into the pi process env: `PI_CACHE_RETENTION` (DL-300), the agent git identity,
   * `T3_LOOM_HIDDEN_TOOLS` and, for a 1-hour root, `PI_CACHE_WARMING_IDLE_MAX_MS`
   * (pi's idle-warming horizon).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Prepended to the pi process PATH: the agent git shim's directory (`agentGitIdentity.ts`). */
  readonly pathPrepend?: string;
  /** The idle release for this process when it differs from the default (1-hour roots). */
  readonly idleTimeoutMs?: number;
}
