// Loom (fork) additions to the orchestration contracts. Everything here is a
// fork-only declaration relocated out of the upstream-owned `orchestration.ts`
// so that upstream merges touch a small set of one-line splice points rather
// than ~1000 lines of interleaved fork schema. See
// `plans/2026-07-07-fork-seam-campaign.md` (Slice A).
//
// HARD CONSTRAINT: this file must never VALUE-import `orchestration.ts`. The
// dependency is strictly one-way (`orchestration.ts` → this file); both modules
// evaluate their schema unions at init, so a value cycle is a TDZ crash. The
// only edge back to `orchestration.ts` is a TYPE-only import (erased at
// runtime) used by the narrowing guards, plus the `EventBaseFields` value which
// the upstream file passes INTO `makeLoomOrchestrationEventMembers`.

import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CommandId,
  EventId,
  GoalId,
  GoalTaskId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  NonNegativeNumber,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "./baseSchemas.ts";
import { RuntimeErrorClass } from "./providerRuntime.ts";
// Type-only (erased) — safe against the value cycle. Used by the narrowing
// guards to Extract the fork subsets from the full upstream unions.
import type { OrchestrationCommand, OrchestrationEvent } from "./orchestration.ts";

// ---------------------------------------------------------------------------
// Standalone schemas / consts (relocated verbatim from orchestration.ts).
// ---------------------------------------------------------------------------

// loom: title provenance ladder (stale/empty-goal fix §4). Tracks how the
// CURRENT title of a thread or goal was produced, lowest → highest authority:
//   `default`  — the placeholder "New thread" (never a real subject).
//   `seed`     — the truncated first user message (a rough client-side guess).
//   `derived`  — the side-channel LLM interpretation of the thread's intent.
//   `curated`  — a human/tool rename (set_thread_title, spawn/handoff titles,
//                goal_update). Never overwritten by anything automatic.
// Automatic writers may only replace a title whose provenance ranks strictly
// below theirs; a `curated` title is immutable to automation. The rank helper
// `titleProvenanceRank` and guard `canReplaceTitle` live below.
export const TitleProvenance = Schema.Literals(["default", "seed", "derived", "curated"]);
export type TitleProvenance = typeof TitleProvenance.Type;

// loom: the placeholder title a fresh thread carries until it gains a real
// subject. Single-sourced here so the decider, reactor, projector, pipeline and
// migration all agree on which titles are "never a real subject".
export const DEFAULT_THREAD_TITLE = "New thread";

/**
 * Conservative provenance for a title that arrives WITHOUT an explicit
 * provenance — the single inference shared by every replay/backfill path
 * (in-memory projector, durable pipeline, migration 057). The `"New thread"`
 * placeholder never carried a real subject, so it is `default` (freely
 * replaceable by automation); every other title is `curated` — the safe choice
 * that automation may not clobber. Keeping this identical across all three
 * paths is what stops a projection rebuild from disagreeing with the migration.
 */
export function inferLegacyTitleProvenance(title: string): TitleProvenance {
  return title.trim() === DEFAULT_THREAD_TITLE ? "default" : "curated";
}

const TITLE_PROVENANCE_RANK: Record<TitleProvenance, number> = {
  default: 0,
  seed: 1,
  derived: 2,
  curated: 3,
};

export function titleProvenanceRank(provenance: TitleProvenance | undefined): number {
  // A missing provenance is treated as `curated` — the conservative default so
  // legacy/unlabelled titles are never clobbered by automation.
  return provenance === undefined
    ? TITLE_PROVENANCE_RANK.curated
    : TITLE_PROVENANCE_RANK[provenance];
}

/**
 * Whether a writer stamping `next` provenance may replace a title whose current
 * provenance is `current`. `curated` always wins (a human/tool rename); every
 * other writer needs to rank strictly above the current title.
 */
export function canReplaceTitle(
  current: TitleProvenance | undefined,
  next: TitleProvenance,
): boolean {
  if (next === "curated") return true;
  return titleProvenanceRank(next) > titleProvenanceRank(current);
}

// Worktree isolation policy for a workstream sub-thread (worktree-isolation
// design §1). `isolated` = own worktree + `ws/…` branch, merged back on
// completion (fan-in); `shared` = runs in the parent's worktree (today's
// behaviour, no fan-in); `attached` = a gated reviewer that joins its gate
// target's worktree (never fans in itself). Decode-defaults to `shared` so
// root/pre-isolation threads keep today's behaviour.
export const ThreadIsolation = Schema.Literals(["isolated", "shared", "attached"]);
export type ThreadIsolation = typeof ThreadIsolation.Type;
export const DEFAULT_THREAD_ISOLATION: ThreadIsolation = "shared";

// Fan-in settlement of an isolated child's branch back into the parent branch
// (design §3). `none` = not applicable (shared/attached/root, or an isolated
// child that has not yet fanned in); `completed` = merged cleanly (releases
// dependents); `conflicted` = merge aborted, dependents stay blocked, the
// parent is woken with the notice. Projected from `thread.fanin-set` events.
export const ThreadFanInState = Schema.Literals(["none", "completed", "conflicted"]);
export type ThreadFanInState = typeof ThreadFanInState.Type;
export const DEFAULT_THREAD_FAN_IN_STATE: ThreadFanInState = "none";
// Axis 1 — plan lane (intent; the kanban board). The only "lifecycle" axis,
// deliberately small. `in_progress` is control-plane-only (set by the
// dispatcher at kickoff); agents/humans may set the others. `done` is the only
// lane that releases dependents; `cancelled` is terminal but does not.
// `yielded` (review-gates design §5) is control-plane-only too: a submit whose
// outcome matched no route parks the thread turn-over, parent-woken — neither
// terminal (the generation join does not count it) nor releasing. Any
// turn-start on a `yielded` thread reverts it to `in_progress`.
export const ThreadPlanLane = Schema.Literals([
  "planned",
  "ready",
  "in_progress",
  "yielded",
  "done",
  "cancelled",
]);
export type ThreadPlanLane = typeof ThreadPlanLane.Type;
// Schema decode-default for root/manual thread creation. Spawns choose `ready`
// explicitly (staging is the opt-in `planned`) — see the spawn endpoint.
export const DEFAULT_THREAD_PLAN_LANE: ThreadPlanLane = "planned";

// Axis 3 — attention (needs-a-human; the single notification surface). A set of
// reason-tagged flags that co-exist with any plan lane and bubble up. Only the
// non-derivable reasons are STORED on a thread (`error`, `awaiting_acceptance`,
// `needs_guidance`); `awaiting_approval`/`awaiting_input` are projected from
// open approval/input requests and never stored. `error` is server-only (the
// liveness sweep sets it); the decider rejects an agent-issued `error` raise
// and rejects the two projected reasons outright.
export const AttentionReason = Schema.Literals([
  "error",
  "awaiting_approval",
  "awaiting_input",
  "awaiting_acceptance",
  "needs_guidance",
]);
export type AttentionReason = typeof AttentionReason.Type;
export const ThreadAttention = Schema.Array(AttentionReason);
export type ThreadAttention = typeof ThreadAttention.Type;

// ---------------------------------------------------------------------------
// Review gates (docs/design/workstream-review-gates.md §4, §8).
// ---------------------------------------------------------------------------

/** Default loop-round cap for a review gate when the spawner sets none. */
export const DEFAULT_GATE_MAX_ROUNDS = 2;

/** Maximum accepted loop-round cap for a review gate. */
export const MAX_GATE_MAX_ROUNDS = 10;

/**
 * An outcome-predicated route edge on the thread that EMITS the outcomes (the
 * gate source, e.g. the reviewer). `loop` re-dispatches the counterpart named
 * by `to` (round-capped); `resolve` completes the gate (both parties `done`).
 * Outcomes matching no edge yield the thread to the live orchestrator.
 */
export const WorkstreamRoute = Schema.Struct({
  // Outcome tokens this edge matches (open strings — the generic primitive).
  on: Schema.Array(TrimmedNonEmptyString),
  kind: Schema.Literals(["loop", "resolve"]),
  // Loop target (required for kind=loop; unused for resolve).
  to: Schema.optional(ThreadId),
  // Loop only; defaults to DEFAULT_GATE_MAX_ROUNDS.
  maxRounds: Schema.optional(NonNegativeInt),
});
export type WorkstreamRoute = typeof WorkstreamRoute.Type;

/** The routing verdict the decider reached for a submitted outcome. */
export const WorkOutcomeDecision = Schema.Literals([
  "terminal",
  "loop",
  "resolve",
  "yield",
  "cap-breach",
  "attention",
]);
export type WorkOutcomeDecision = typeof WorkOutcomeDecision.Type;

/** Reviewer finding counts, opaque to routing — audit trail + UI verdict chip. */
export const WorkOutcomeCounts = Schema.Struct({
  mustFix: NonNegativeInt,
  niceToHave: NonNegativeInt,
});
export type WorkOutcomeCounts = typeof WorkOutcomeCounts.Type;

/**
 * Projected record of a thread's most recent submitted outcome (`lastOutcome`).
 * `recordedByEventId` is the id of the `thread.outcome-recorded` event that
 * produced it — the durable per-yield-episode key the dispatcher's wake rail
 * dedups on (design §6).
 */
export const WorkOutcomeRecord = Schema.Struct({
  outcome: TrimmedNonEmptyString,
  decision: WorkOutcomeDecision,
  round: NonNegativeInt,
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  recordedByEventId: EventId,
  at: IsoDateTime,
});
export type WorkOutcomeRecord = typeof WorkOutcomeRecord.Type;

// Migration-only (design §9): the pre-three-axis stored status. Retained solely
// so historical `thread.status-set` events still decode on replay and remap
// into planLane/attention in the projector. NEVER emitted by any live command
// path — the live surface is plan-lane.set + attention.raise/clear.
export const LegacyThreadStatus = Schema.Literals([
  "planned",
  "running",
  "blocked",
  "review",
  "done",
  "error",
]);
export type LegacyThreadStatus = typeof LegacyThreadStatus.Type;

export const QueuedMessages = Schema.Struct({
  steering: Schema.Array(Schema.String),
  followUp: Schema.Array(Schema.String),
});
export type QueuedMessages = typeof QueuedMessages.Type;

export interface OrchestrationGoalTask {
  readonly id: GoalTaskId;
  readonly goalId: GoalId;
  readonly parentTaskId: GoalTaskId | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: IsoDateTime;
  readonly updatedAt: IsoDateTime;
  readonly deletedAt: IsoDateTime | null;
  readonly children: ReadonlyArray<OrchestrationGoalTask>;
}

interface OrchestrationGoalTaskEncoded {
  readonly id: string;
  readonly goalId: string;
  readonly parentTaskId: string | null;
  readonly text: string;
  readonly done: boolean;
  readonly position: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly children: ReadonlyArray<OrchestrationGoalTaskEncoded>;
}

export const OrchestrationGoalTask: Schema.Codec<
  OrchestrationGoalTask,
  OrchestrationGoalTaskEncoded
> = Schema.Struct({
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
    Schema.suspend(
      (): Schema.Codec<OrchestrationGoalTask, OrchestrationGoalTaskEncoded> =>
        OrchestrationGoalTask,
    ),
  ),
});

export const OrchestrationGoal = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  description: Schema.String,
  tasks: Schema.Array(OrchestrationGoalTask),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
  deletedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationGoal = typeof OrchestrationGoal.Type;

export const OrchestrationGoalShell = Schema.Struct({
  id: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  description: Schema.String,
  tasks: Schema.Array(OrchestrationGoalTask),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestrationGoalShell = typeof OrchestrationGoalShell.Type;

// consult_thread observability: an aggregated consult EDGE on the asker's
// shell — one entry per distinct target this thread has consulted. Lets the
// workstream graph draw consult edges from thread shells alone; the full
// question + answer of each individual consult lives on the
// `thread.consult-recorded` event, not here. `lastQuestionPreview` is a
// bounded shell-level preview (the full text is on the event).
export const OrchestrationThreadConsultSummary = Schema.Struct({
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  count: NonNegativeInt,
  lastConsultAt: IsoDateTime,
  lastQuestionPreview: Schema.String,
});
export type OrchestrationThreadConsultSummary = typeof OrchestrationThreadConsultSummary.Type;

// Transient reasoning stream item (the ephemeral channel). These never hit the
// event store; they drive live "Thinking… ⟷ Thought for Xs" display only. The
// durable `thread.message-reasoning` event (REPLACE full text) is the source of
// truth on reload.
export const ReasoningStreamItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delta"),
    threadId: ThreadId,
    messageId: MessageId,
    turnId: Schema.NullOr(TurnId),
    text: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("complete"),
    threadId: ThreadId,
    messageId: MessageId,
    reasoningCompletedAt: IsoDateTime,
  }),
]);
export type ReasoningStreamItem = typeof ReasoningStreamItem.Type;

// ---------------------------------------------------------------------------
// Struct field records (shape c). Each is spread — HEAD position — into the
// upstream struct that owns it. Field position is decode-irrelevant (keys are
// disjoint), so collapsing the fork's multiple insertion blocks per struct into
// one leading spread is behaviour-preserving.
// ---------------------------------------------------------------------------

// Spread into `OrchestrationThread`. `LoomThreadShellFields` is the same set
// plus the two shell-only projection fields, so the common subset lives here
// once (the fork fields are byte-identical between thread and shell).
export const LoomThreadFields = {
  goalId: Schema.NullOr(GoalId),
  // loom: §4 title provenance. Optional so dev seeds/tests may omit it; every
  // live write path stamps it and the decider treats an absent value as
  // `curated` (the conservative default that automation may not overwrite).
  titleProvenance: Schema.optional(TitleProvenance),
  parentThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  role: Schema.NullOr(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  purpose: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  brief: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Scaffold-first graph authoring (workstream-scaffold plan §1a): a child-only
  // pointer to this thread's kickoff-brief markdown file (content lives on disk,
  // never in the event store). Null until `workstream_brief` attaches one; the
  // dispatcher gates a child's FIRST launch on this being non-null (deps AND
  // brief are the two orthogonal launch gates). Distinct from the `brief` string
  // above, which stays the root-handoff kickoff contract. Additive,
  // decode-defaulted so pre-scaffold snapshots load.
  kickoffBriefPath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Scaffold-first graph authoring (plan "Key scoping"): the symbolic graph key
  // assigned at scaffold time — unique-forever + immutable among a parent's
  // children, the shape-review handle exposed in workstream_list + the graph
  // projections. Null for legacy spawns and roots. Additive, decode-defaulted so
  // pre-scaffold snapshots load.
  graphKey: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  planLane: ThreadPlanLane.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_PLAN_LANE)),
  ),
  attention: ThreadAttention.pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  blockedBy: Schema.Array(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  // D-notify: the spawn batch this sub-thread belongs to (the parent's turn id
  // at spawn time). Children sharing a (parentThreadId, spawnGeneration) form a
  // join barrier; the parent is woken once every member is terminal. Durable so
  // the join is recomputable from the read model after a restart.
  spawnGeneration: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Thread fork (MVP): the source thread this thread was forked from. When set,
  // the child's FIRST provider launch forks the source's pi session (native
  // `pi --fork`) so it starts with a full copy of the source's conversation
  // context and then diverges independently. Null for non-forked threads.
  // Additive, decode-defaulted so pre-fork snapshots load.
  forkFromThreadId: Schema.NullOr(ThreadId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // D-notify: pointer to this thread's completion report markdown file (content
  // lives on disk, never in the event store). Null until the child reports.
  reportPath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Review gates (design §8): outcome route edges + projected loop counters.
  // All decode-defaulted so pre-gate snapshots load.
  routes: Schema.Array(WorkstreamRoute).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  gateRounds: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  pendingRework: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  lastOutcome: Schema.NullOr(WorkOutcomeRecord).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Worktree isolation policy (design §1) + fan-in settlement (design §3).
  // Additive, decode-defaulted so pre-isolation snapshots load as today's
  // shared/no-fan-in behaviour.
  isolation: ThreadIsolation.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_ISOLATION)),
  ),
  fanInState: ThreadFanInState.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THREAD_FAN_IN_STATE)),
  ),
  // Cumulative dollar spend for THIS thread alone (sum of every assistant
  // message's `usage.cost.total`, folded from the durable activity log so it is
  // replay-safe). Additive/optional on the wire — absent (treated as 0) when the
  // provider reports no cost (e.g. non-pi adapters).
  cumulativeCostUsd: Schema.optional(NonNegativeNumber),
  // Latest context-window snapshot for THIS thread (newest
  // `context-window.updated` activity's running session totals). Null when
  // unknown (non-pi providers / no activity yet) — distinct from cost's 0-default
  // so the UI suppresses the chip rather than showing a misleading 0. Additive +
  // decode-default so older snapshots still decode.
  toolUses: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  usedTokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  maxTokens: Schema.NullOr(NonNegativeInt).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Cumulative lines-of-diff for THIS thread: SUM of every checkpoint turn's
  // per-file additions/deletions (isolation makes the attribution honest). Null
  // when unknown (no checkpoint yet) so the UI suppresses the chip. Additive +
  // decode-default so older snapshots still decode.
  diffAdditions: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  diffDeletions: Schema.NullOr(NonNegativeInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // `/handoff` fork-drafter (plan §4 Phase 1): count of `goal_handoff` calls a
  // handoff-drafter root has durably recorded (a `thread.handoff-recorded`
  // event per placed destination). The settlement reactor reads it at the
  // drafter's turn end: ≥1 ⇒ converge done→stop→archive, 0 ⇒ raise
  // needs_guidance. Durable (survives restart) precisely because it is
  // event-projected rather than an in-memory tally. Additive, decode-defaulted
  // to 0 so every pre-handoff snapshot loads.
  handoffCount: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
} as const;

// Spread into `OrchestrationThreadShell`: the common fork fields plus the two
// shell-only projection fields.
export const LoomThreadShellFields = {
  ...LoomThreadFields,
  // Debugging-only surface: absolute path to this thread's effective-prompt
  // debug sidecar (the full LLM system+user prompt this pi thread sent,
  // broken down by section), written fire-and-forget by the pi capture
  // extension. Computed deterministically server-side for pi threads (absent
  // for other drivers) so the web UI can open it via the absolute-path file
  // viewer. Optional on the wire — absent for non-pi threads / older snapshots.
  promptDebugPath: Schema.optional(Schema.String),
  /**
   * Short human-readable description of the most recent activity for this
   * thread — the latest assistant-narration text, truncated to roughly one
   * line. Null when the thread has no assistant narration yet. Additive,
   * nullable projection field (decode-default null) so older snapshots load.
   */
  lastActivityPreview: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // consult_thread observability: consult edges from THIS (asker) thread,
  // deduped by target. Additive, decode-defaulted so older snapshots load.
  consults: Schema.Array(OrchestrationThreadConsultSummary).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  // Scaffold-first graph authoring (plan §3): the timestamp of this thread's
  // most recent plan-lane transition (its `thread.plan-lane-set` event, or its
  // creation lane when it never transitioned). This is the STABLE, transition-
  // derived clock the brief-needed episode (`briefNeededSinceMs`) needs: a node's
  // own `planned → ready` release and a dependency reaching `done` via a
  // lane-only `workstream_set_lane` (no submit outcome) both bump it, while an
  // unrelated receipt-marker/activity append does NOT — deliberately unlike
  // `updatedAt`, which any activity bumps and so would re-arm the wake in a loop.
  // Shell-only (dispatcher + liveness are the sole consumers). Null on legacy
  // snapshots predating the column; consumers fall back to `createdAt`.
  planLaneSince: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  // Scaffold-first graph authoring (plan §3): the timestamp of this thread's
  // most recent dependency-set transition (its `thread.dependencies-set` event).
  // Companion to `planLaneSince` for the third eligibility transition the episode
  // clock must follow: a `workstream_set_dependencies` that removes/replaces a
  // dependency can RE-ENTER the brief-needed state (e.g. an unfinished dep
  // swapped for an already-`done` one), and only this stable, transition-derived
  // stamp advances the episode — the dep's own outcome may predate the prior
  // episode. Stamped ONLY by `thread.dependencies-set`, never by an activity/
  // receipt append (unlike `updatedAt`, which would re-arm the wake in a loop).
  // Fed into `briefNeededSinceMs` ONLY while the current dependency set is
  // satisfied. Shell-only; null on legacy snapshots and until the first
  // dependency-set (consumers fall back to `createdAt`/`planLaneSince`).
  dependenciesSince: Schema.NullOr(IsoDateTime).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  // Scaffold-first graph authoring (plan §3): the timestamp of this thread's
  // most recent fan-in-settlement transition (its `thread.fanin-set` event).
  // Third companion to `planLaneSince`/`dependenciesSince` for the last
  // eligibility transition the clock must follow: `areDependenciesSatisfied`
  // requires an isolated dependency's fan-in to reach `completed` (not just
  // `done`), and for a node behind an attached reviewer, the gated isolated
  // coder's fan-in — a settlement that can land long after `done`. That
  // `fanin-set` is then the true eligibility transition; only this stable stamp
  // dates it (the dep's own `done`/outcome predates it). Stamped ONLY by
  // `thread.fanin-set`, never by an activity/receipt append (unlike `updatedAt`,
  // which would re-arm the wake in a loop). Fed into `briefNeededSinceMs` on the
  // same dep whose fan-in the predicate makes load-bearing. Shell-only; null on
  // legacy snapshots and until the first fan-in-set.
  faninSince: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
} as const;

// Spread into `OrchestrationSession`.
export const LoomSessionFields = {
  // Classification of `lastError`, carried by `thread.session.set`. Persisted so
  // the exhaustion resume sweep can find `quota_exhausted`-stalled sessions
  // across restarts without re-parsing the raw string.
  lastErrorClass: Schema.optional(RuntimeErrorClass),
  // Ephemeral live queue of pending messages (steer folds into the running
  // turn, followUp runs after). Optional with an empty default so DB-hydrated
  // sessions, which never persist it, decode cleanly and start with no queue.
  queuedMessages: QueuedMessages.pipe(
    Schema.withDecodingDefault(Effect.succeed({ steering: [], followUp: [] })),
  ),
} as const;

// Provenance of a user-role message — who/what composed it. Additive +
// optional so every historical message and every non-pi provider path decodes
// as absent, which consumers treat as `human`. Stamped ONLY where the control
// plane builds internal turn-start commands server-side; client (human) sends
// carry no `origin` field on the wire (`ClientThreadTurnStartCommand`) and so
// can never spoof it. The axis is *who composed the words*:
//   - `human`         — a real human send (the decode-absent default meaning).
//   - `kickoff`       — the spawn kickoff brief injected when a sub-thread is
//                       promoted. Contains the human's real task, so it stays
//                       fully readable, only lightly marked.
//   - `orchestrator`  — text a parent orchestrator authored at runtime to drive
//                       a specific thread: a `workstream_prompt` steer/resume.
//   - `control_notice`— text the control plane itself generated: parent wakes,
//                       FYI digests, review-gate rework/re-verify legs, fan-in
//                       conflict/resolution notices, and liveness/exhaustion
//                       recovery nudges. Pure machinery — the follow-up
//                       structured-digest + collapsed-card work keys off this.
export const MessageOrigin = Schema.Literals([
  "human",
  "kickoff",
  "orchestrator",
  "control_notice",
]);
export type MessageOrigin = typeof MessageOrigin.Type;

// One item in a structured control-plane payload — a single sub-thread the
// notice concerns (or a pure informational line). Every field beyond `title` is
// optional so the renderer degrades gracefully; the UI resolves the live
// sub-thread title/status from `threadId` when present, falling back to these
// stamped-at-send values for historical/absent shells.
export const ControlPayloadItem = Schema.Struct({
  // The sub-thread this item is about (absent for pure info lines, e.g. a
  // slow-tool notice with no terminal child). Lets the card link through and
  // resolve the live title.
  threadId: Schema.optional(ThreadId),
  // The sub-thread's role at send time, e.g. "researcher"/"coder".
  role: Schema.optional(Schema.String),
  // One-line human summary of the item (collapsed-row title), e.g. a verdict or
  // "still executing". Always present so a row can render with no other field.
  title: Schema.String,
  // Terminal lane / gate verdict / notice kind label, e.g. "done", "clean",
  // "recovered". Shown as the trailing status on the collapsed row.
  status: Schema.optional(Schema.String),
  // Leading glyph mirroring the flattened digest (☑️ / ✅ / ♻️ / ⏳ / ⚠️).
  icon: Schema.optional(Schema.String),
  // On-disk report reference (rendered as clickable inline-code path).
  reportPath: Schema.optional(Schema.String),
  // Bounded report excerpt / detail body shown in the expanded section.
  excerpt: Schema.optional(Schema.String),
  // Durable event time for the item (design §5.4 formatting), e.g. 2026-07-07 14:32Z.
  timestamp: Schema.optional(Schema.String),
});
export type ControlPayloadItem = typeof ControlPayloadItem.Type;

// Structured source-of-truth for a control-plane digest/notice message. The
// dispatcher composes these programmatically from the same wake members/extras
// it flattens into the message `text`, then persists BOTH: `text` stays the
// exact bytes the model received (surfaced verbatim behind the card's "show raw
// payload" toggle), while this structure drives the collapsed-by-default card so
// the two can never drift at render time. Additive + optional: a message with no
// `controlPayload` (every historical control_notice) renders as today's tinted
// bubble.
export const ControlPayload = Schema.Struct({
  // Which composition produced this: a multi-item FYI `digest`, a `yield`
  // hand-back (the yielding child + optional gate counterpart), or a generic
  // single-item `notice`.
  kind: Schema.Literals(["digest", "yield", "notice"]),
  // The intro/framing line (e.g. "FYI digest — the following items completed…").
  heading: Schema.optional(Schema.String),
  items: Schema.Array(ControlPayloadItem),
});
export type ControlPayload = typeof ControlPayload.Type;

// Spread into `OrchestrationMessage`.
export const LoomMessageFields = {
  // Model reasoning/thinking trace for this (assistant) message, captured as a
  // parallel channel to `text` and rendered as a collapsible block above the
  // answer. Absent for messages without reasoning.
  reasoningText: Schema.optional(Schema.String),
  reasoningStreaming: Schema.optional(Schema.Boolean),
  // Provenance of a user-role message (absent ⇒ human). See `MessageOrigin`.
  origin: Schema.optional(MessageOrigin),
  // Structured source-of-truth for a control-plane digest/notice (absent ⇒ this
  // is a plain message; historical control_notice bubbles have none). See
  // `ControlPayload`.
  controlPayload: Schema.optional(ControlPayload),
} as const;

// Spread into `OrchestrationReadModel`.
export const LoomReadModelFields = {
  goals: Schema.Array(OrchestrationGoal),
} as const;

// Spread into `OrchestrationShellSnapshot`.
export const LoomShellSnapshotFields = {
  goals: Schema.Array(OrchestrationGoalShell),
} as const;

// Spread into `ThreadCreateCommand`.
export const LoomThreadCreateCommandFields = {
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // loom: §4 provenance of the create-time title. Spawn/handoff titles are
  // `curated`; the client bootstrap create leaves it absent (the decider then
  // infers `default` for the "New thread" placeholder).
  titleProvenance: Schema.optional(TitleProvenance),
  // Intrinsic run-condition carried at node creation: the dispatcher defers the
  // kick-off turn until every blockedBy thread is `done`. A dependency-bearing
  // create is validated at the decider boundary (self/root/dangling/cycle
  // rejected); only the runtime predicate stays permissive as a backstop.
  blockedBy: Schema.optional(Schema.Array(ThreadId)),
  // Review gates (design §4): outcome route edges declared at spawn (compiled
  // from the spawn `gate` sugar). Omitted ⇒ no routes.
  routes: Schema.optional(Schema.Array(WorkstreamRoute)),
  // Worktree isolation policy (design §1). Set by the spawn path from the
  // optional `isolation` param or the role-default table; omitted on
  // root/manual creation — defaults to `shared` via the read-model decode.
  isolation: Schema.optional(ThreadIsolation),
  // Initial plan lane. Spawns pass `ready` (runs once deps clear) or `planned`
  // (staged/held for the review-the-graph flow). Omitted on root/manual
  // creation — defaults to `planned` via the read-model decode default.
  planLane: Schema.optional(ThreadPlanLane),
  // D-notify: spawn-batch stamp (the parent's turn id at spawn). Set by the
  // spawn path so siblings of the same parent turn join into one wake.
  spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Thread fork (MVP): source thread to fork the pi session from at first turn.
  // Set by the fork path; omitted on every other create.
  forkFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
} as const;

// Spread into `ThreadMetaUpdateCommand`.
export const LoomThreadMetaUpdateFields = {
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // loom: §4 provenance the writer is stamping onto a title change. The decider
  // applies the title only when this rank may replace the current provenance;
  // absent-with-title is treated as `curated` (a conservative human-ish write).
  titleProvenance: Schema.optional(TitleProvenance),
} as const;

// Spread into `ThreadTurnStartCommand`. All three flags are server-only; see
// the field comments retained here.
export const LoomTurnStartFields = {
  // D-notify: server-only flag set by the WorkstreamDispatcher on parent wakes.
  // When true the turn-start is an atomic idle-gated injection: the serialized
  // command boundary skips it (without recording a rejection) unless the target
  // thread is idle (no pending turn-start, session not running, no active turn).
  // Never set by clients — normal user/agent turn-starts must remain unguarded
  // so steering and human send-while-running keep working.
  requireIdle: Schema.optional(Schema.Boolean),
  // D-notify (D-core kickoff): server-only flag set by the WorkstreamDispatcher
  // when it promotes a sub-thread. When true the decider emits a
  // `thread.plan-lane-set in_progress` event (plus an attention-clear-all) in
  // the SAME command as the turn-start, so the kickoff is one atomic engine
  // transaction that can never be half-applied by a crash between two
  // dispatches. Sticky-terminal: a turn-start on an already-`done`/`cancelled`
  // thread leaves the lane and attention untouched (runtime alone reflects the
  // re-engagement activity). Never set by clients — normal user/agent
  // turn-starts must not flip the plan lane.
  setInProgress: Schema.optional(Schema.Boolean),
  // Review gates (design §5.2): server-only flag set by the dispatcher's gate
  // pass when it loops work back to a coder whose round-0 `done` must be
  // reopened. The decider accepts it only on `server:`-prefixed command ids and
  // only from `done` (never `cancelled`), atomically reverting the lane to
  // `in_progress` in the same transaction. Contract-only until Phase 3 wires
  // the gate pass; nothing sets it before then.
  reopen: Schema.optional(Schema.Boolean),
} as const;

// Spread into `ThreadTurnStartBootstrapCreateThread`.
export const LoomBootstrapCreateThreadFields = {
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Thread fork (MVP): the UI's fork affordance seeds a draft thread carrying
  // the source id; the first-send bootstrap create relays it into thread.create.
  forkFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  // `/handoff` fork-drafter (plan D4): a server-injected bootstrap (the drafter
  // launch) supplies a CURATED title, not the client's truncated first-message
  // seed. When present the dispatcher stamps it verbatim instead of inferring
  // seed/default from the title text, so the auto-title reactor never renames a
  // drafter. Absent on the ordinary local-draft first-send path (stays seed).
  titleProvenance: Schema.optional(TitleProvenance),
} as const;

// Spread into `ThreadCreatedPayload`.
export const LoomThreadCreatedPayloadFields = {
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  parentThreadId: Schema.optional(Schema.NullOr(ThreadId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  brief: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Scaffold-first graph authoring: the symbolic graph key seeded onto the
  // created thread (present on scaffold-created nodes; omitted for spawns/roots).
  graphKey: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // A scaffold node is born unbriefed, but the field is carried so a future
  // create path may seed a brief pointer at creation time.
  kickoffBriefPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  planLane: Schema.optional(ThreadPlanLane),
  attention: Schema.optional(ThreadAttention),
  blockedBy: Schema.optional(Schema.Array(ThreadId)),
  routes: Schema.optional(Schema.Array(WorkstreamRoute)),
  isolation: Schema.optional(ThreadIsolation),
  spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  // Thread fork (MVP): propagate the fork source so the projector seeds it on
  // the thread record (the driver reads it at first launch).
  forkFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
} as const;

// Spread into `ThreadMetaUpdatedPayload`.
export const LoomThreadMetaUpdatedPayloadFields = {
  goalId: Schema.optional(Schema.NullOr(GoalId)),
  role: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  purpose: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
} as const;

// ---------------------------------------------------------------------------
// Fork command members (shape a). The command structs stay module-local (they
// were non-exported in upstream too); only the member tuples are exported, to
// be spread — HEAD position — into the upstream command unions.
// ---------------------------------------------------------------------------

const GoalCreateCommand = Schema.Struct({
  type: Schema.Literal("goal.create"),
  commandId: CommandId,
  goalId: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  description: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

const GoalMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("goal.meta.update"),
  commandId: CommandId,
  goalId: GoalId,
  slug: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  description: Schema.optional(Schema.String),
});

const GoalArchiveCommand = Schema.Struct({
  type: Schema.Literal("goal.archive"),
  commandId: CommandId,
  goalId: GoalId,
});

const GoalUnarchiveCommand = Schema.Struct({
  type: Schema.Literal("goal.unarchive"),
  commandId: CommandId,
  goalId: GoalId,
});

const GoalDeleteCommand = Schema.Struct({
  type: Schema.Literal("goal.delete"),
  commandId: CommandId,
  goalId: GoalId,
});

const GoalTaskCreateCommand = Schema.Struct({
  type: Schema.Literal("goal.task.create"),
  commandId: CommandId,
  goalId: GoalId,
  taskId: GoalTaskId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  text: TrimmedNonEmptyString,
  position: Schema.optional(NonNegativeInt),
  createdAt: IsoDateTime,
});

// Task reparenting is intentionally unsupported for MVP: there is no
// `parentTaskId` here, which removes the only path to a task-tree cycle.
const GoalTaskUpdateCommand = Schema.Struct({
  type: Schema.Literal("goal.task.update"),
  commandId: CommandId,
  goalId: GoalId,
  taskId: GoalTaskId,
  text: Schema.optional(TrimmedNonEmptyString),
  done: Schema.optional(Schema.Boolean),
  position: Schema.optional(NonNegativeInt),
});

const GoalTaskDeleteCommand = Schema.Struct({
  type: Schema.Literal("goal.task.delete"),
  commandId: CommandId,
  goalId: GoalId,
  taskId: GoalTaskId,
});

// Axis 1 write (plan lane). Authorisation chokepoint lives in the decider:
// `in_progress` is control-plane-only (set atomically at kickoff), so an
// agent/client `in_progress` is rejected unless the commandId is `server:`-
// prefixed; `planned|ready|done|cancelled` are accepted from client/agent.
const ThreadPlanLaneSetCommand = Schema.Struct({
  type: Schema.Literal("thread.plan-lane.set"),
  commandId: CommandId,
  threadId: ThreadId,
  planLane: ThreadPlanLane,
  createdAt: IsoDateTime,
});

// Axis 3 write (raise attention). `error` is server-only; the two `awaiting_*`
// request reasons are projected from open requests and rejected outright. Only
// `awaiting_acceptance`/`needs_guidance` are agent-raisable (decider-enforced).
const ThreadAttentionRaiseCommand = Schema.Struct({
  type: Schema.Literal("thread.attention.raise"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: AttentionReason,
  createdAt: IsoDateTime,
});

// Axis 3 write (clear attention). An omitted `reason` clears ALL stored
// attention (the lifecycle clear-all used by turn-start / plan-terminal
// transitions); a present `reason` clears just that flag (human/parent dismiss).
const ThreadAttentionClearCommand = Schema.Struct({
  type: Schema.Literal("thread.attention.clear"),
  commandId: CommandId,
  threadId: ThreadId,
  reason: Schema.optional(AttentionReason),
  createdAt: IsoDateTime,
});

const ThreadDependenciesSetCommand = Schema.Struct({
  type: Schema.Literal("thread.dependencies.set"),
  commandId: CommandId,
  threadId: ThreadId,
  blockedBy: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
});

// v2 (ephemeral reasoning): streaming reasoning chunks are NOT persisted as
// domain events — they flow over the transient ReasoningStreamBus. The only
// durable reasoning command is the completion, which carries the full
// accumulated text and is dispatched once per assistant segment at
// finalization. The projector REPLACES `reasoningText` with this full text.
const ThreadMessageReasoningCompleteCommand = Schema.Struct({
  type: Schema.Literal("thread.message.reasoning.complete"),
  commandId: CommandId,
  threadId: ThreadId,
  messageId: MessageId,
  reasoningText: Schema.String,
  turnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
});

// consult_thread observability: the server chokepoint records one resolved
// consult (asker → target). Aggregate = the asker thread; the decider derives
// the `thread.consult-recorded` event. `answer` is the FULL answer (no
// truncation/pointer); `forkSessionPath` points at the retained fork jsonl when
// retention succeeded.
const ThreadConsultRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.consult.record"),
  commandId: CommandId,
  threadId: ThreadId,
  targetThreadId: ThreadId,
  targetTitle: TrimmedNonEmptyString,
  question: TrimmedNonEmptyString,
  answer: Schema.String,
  resolved: Schema.Boolean,
  durationMs: NonNegativeInt,
  forkSessionPath: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
});

// `/handoff` fork-drafter (plan D5): stamp one durable handoff marker on a
// drafter thread after `GoalHandoffHttp` has created the staged destination.
// Internal (server composes it from the goal_handoff chokepoint); a client
// cannot forge a handoff record. The decider derives `thread.handoff-recorded`;
// the projector increments `handoffCount`.
const ThreadHandoffRecordCommand = Schema.Struct({
  type: Schema.Literal("thread.handoff.record"),
  commandId: CommandId,
  threadId: ThreadId,
  destinationGoalId: GoalId,
  destinationThreadId: ThreadId,
  createdAt: IsoDateTime,
});

// Review gates (design §3): the single terminal call. Carries the on-disk
// report pointer (the HTTP handler wrote the markdown) plus a structured
// outcome; the decider derives the report-set + outcome-recorded + lane events
// in ONE transaction. REPLACES the old `thread.report.set` command (the
// `thread.report-set` EVENT stays in the enum so history replays).
const ThreadWorkSubmitCommand = Schema.Struct({
  type: Schema.Literal("thread.work.submit"),
  commandId: CommandId,
  threadId: ThreadId,
  reportPath: TrimmedNonEmptyString,
  // Omitted ⇒ "done" (plain completion, exactly the old two-call semantics).
  outcome: Schema.optional(TrimmedNonEmptyString),
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  createdAt: IsoDateTime,
});

// Scaffold-first graph authoring (plan §1a + `workstream_brief`): attach (or
// overwrite, pre-launch) the on-disk kickoff-brief pointer for a scaffolded
// child. The HTTP handler wrote the markdown via the brief-storage module; this
// command event-sources the absolute path onto the thread. Internal (server
// composes it): a client cannot forge a brief pointer.
const ThreadKickoffBriefSetCommand = Schema.Struct({
  type: Schema.Literal("thread.kickoff-brief.set"),
  commandId: CommandId,
  threadId: ThreadId,
  kickoffBriefPath: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

// D-notify Fix A: a provider turn-start failed before `turn.started` ever
// landed, so no `thread.session-set running` will arrive to clear the pending
// turn-start row. This command durably clears that row, so the idle gate stops
// treating the parent as permanently busy (which would otherwise strand a
// deferred dispatcher wake forever).
const ThreadTurnStartFailCommand = Schema.Struct({
  type: Schema.Literal("thread.turn-start.fail"),
  commandId: CommandId,
  threadId: ThreadId,
  detail: Schema.String,
  createdAt: IsoDateTime,
});

// Worktree isolation fan-in (design §3): the reactor records an isolated
// child's fan-in settlement after merging its branch back into the parent
// branch. `completed` releases dependents; `conflicted` keeps them blocked and
// wakes the parent. Conflict paths ride the child's activity log, not this
// command (the typed thread field stays minimal).
const ThreadFanInSetCommand = Schema.Struct({
  type: Schema.Literal("thread.fanin.set"),
  commandId: CommandId,
  threadId: ThreadId,
  fanInState: ThreadFanInState,
  createdAt: IsoDateTime,
});

// Spliced (HEAD) into both `DispatchableClientOrchestrationCommand` and
// `ClientOrchestrationCommand`.
export const LoomClientCommandMembers = [
  GoalCreateCommand,
  GoalMetaUpdateCommand,
  GoalArchiveCommand,
  GoalUnarchiveCommand,
  GoalDeleteCommand,
  GoalTaskCreateCommand,
  GoalTaskUpdateCommand,
  GoalTaskDeleteCommand,
  ThreadPlanLaneSetCommand,
  ThreadAttentionRaiseCommand,
  ThreadAttentionClearCommand,
  ThreadDependenciesSetCommand,
] as const;

// Spliced (HEAD) into `InternalOrchestrationCommand`.
export const LoomInternalCommandMembers = [
  ThreadFanInSetCommand,
  ThreadMessageReasoningCompleteCommand,
  ThreadConsultRecordCommand,
  ThreadHandoffRecordCommand,
  ThreadWorkSubmitCommand,
  ThreadTurnStartFailCommand,
  ThreadKickoffBriefSetCommand,
] as const;

// Scaffold-first graph authoring (plan §0): the single internal command that
// creates a whole child graph atomically. Thread ids are preallocated by the
// HTTP handler; blockedBy/gate references are already resolved to ThreadIds
// (batch preallocated ids and/or existing child ids). The decider validates the
// whole batch against the union of the live sibling graph and the batch (unique
// keys, no dangling refs, no cycles, gate targets are siblings) and emits every
// `thread.created` event in ONE engine transaction — all-or-nothing.
//
// Per-node fields are today's spawn fields MINUS `brief` (a scaffold node is
// born unbriefed), PLUS `graphKey`. Fields shared by every child of a parent
// (projectId, goalId, runtimeMode, interactionMode, branch, worktreePath) are
// NOT carried — the decider inherits them from the parent thread. Only
// `modelSelection` is per-node (taskShape/preset resolution), which forces the
// factory: `ModelSelection` lives in the upstream-owned `orchestration.ts`, and
// this file must never value-import it. `orchestration.ts` calls the factory
// with its own `ModelSelection` schema and splices the result into the internal
// command union — exactly the pattern `makeLoomOrchestrationEventMembers` uses
// for the fork event members.
export const makeLoomScaffoldCommandMembers = <const MS extends Schema.Top>(deps: {
  readonly ModelSelection: MS;
}) => {
  const WorkstreamScaffoldNode = Schema.Struct({
    // Preallocated by the HTTP handler; validated absent by the decider.
    threadId: ThreadId,
    // Symbolic key — unique-forever among the parent's children, immutable.
    graphKey: TrimmedNonEmptyString,
    role: Schema.NullOr(TrimmedNonEmptyString),
    title: TrimmedNonEmptyString,
    purpose: Schema.NullOr(TrimmedNonEmptyString),
    isolation: Schema.optional(ThreadIsolation),
    // `ready` (runs once deps clear + brief lands) or `planned` (staged). Omit
    // → the decider applies the scaffold's `staged` flag.
    planLane: Schema.optional(ThreadPlanLane),
    // Already resolved to ThreadIds (batch preallocated ids and/or existing
    // child ids); the decider validates them against the union graph.
    blockedBy: Schema.optional(Schema.Array(ThreadId)),
    routes: Schema.optional(Schema.Array(WorkstreamRoute)),
    spawnGeneration: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    forkFromThreadId: Schema.optional(Schema.NullOr(ThreadId)),
    modelSelection: deps.ModelSelection,
  });
  const ThreadScaffoldCommand = Schema.Struct({
    type: Schema.Literal("thread.scaffold"),
    commandId: CommandId,
    parentThreadId: ThreadId,
    // true ⇒ every created node is born `planned` (held) unless the node states
    // its own planLane; false/omitted ⇒ `ready`.
    staged: Schema.optional(Schema.Boolean),
    nodes: Schema.Array(WorkstreamScaffoldNode),
    createdAt: IsoDateTime,
  });
  return [ThreadScaffoldCommand] as const;
};

// ---------------------------------------------------------------------------
// Fork event payloads (exported) + the event-member factory (shape d). The
// factory takes the upstream `EventBaseFields` value as an argument so this
// file never value-imports `orchestration.ts`.
// ---------------------------------------------------------------------------

export const GoalCreatedPayload = Schema.Struct({
  goalId: GoalId,
  projectId: ProjectId,
  slug: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  description: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const GoalMetaUpdatedPayload = Schema.Struct({
  goalId: GoalId,
  slug: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  titleProvenance: Schema.optional(TitleProvenance), // loom: §4 title provenance
  description: Schema.optional(Schema.String),
  updatedAt: IsoDateTime,
});

export const GoalArchivedPayload = Schema.Struct({
  goalId: GoalId,
  archivedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const GoalUnarchivedPayload = Schema.Struct({
  goalId: GoalId,
  updatedAt: IsoDateTime,
});

export const GoalDeletedPayload = Schema.Struct({
  goalId: GoalId,
  deletedAt: IsoDateTime,
});

export const GoalTaskCreatedPayload = Schema.Struct({
  goalId: GoalId,
  taskId: GoalTaskId,
  parentTaskId: Schema.NullOr(GoalTaskId),
  text: TrimmedNonEmptyString,
  position: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const GoalTaskUpdatedPayload = Schema.Struct({
  goalId: GoalId,
  taskId: GoalTaskId,
  text: Schema.optional(TrimmedNonEmptyString),
  done: Schema.optional(Schema.Boolean),
  position: Schema.optional(NonNegativeInt),
  updatedAt: IsoDateTime,
});

export const GoalTaskDeletedPayload = Schema.Struct({
  goalId: GoalId,
  taskId: GoalTaskId,
  deletedAt: IsoDateTime,
});

export const ThreadPlanLaneSetPayload = Schema.Struct({
  threadId: ThreadId,
  planLane: ThreadPlanLane,
  // Re-engagement epoch (review-gates design §5.2 exception): present only
  // when a terminal thread (done/cancelled) is reopened to ready/planned via
  // the lane-set path. The parent's one-shot generation wake is keyed
  // (parentId, spawnGeneration) with durable receipts, so the reopened re-run
  // must join a FRESH generation for its completion to fire a fresh wake.
  spawnGeneration: Schema.optional(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});

export const ThreadAttentionRaisedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: AttentionReason,
  updatedAt: IsoDateTime,
});

// An omitted `reason` means clear ALL stored attention (lifecycle clear-all);
// a present `reason` clears just that flag.
export const ThreadAttentionClearedPayload = Schema.Struct({
  threadId: ThreadId,
  reason: Schema.optional(AttentionReason),
  updatedAt: IsoDateTime,
});

// Migration-only (design §9): decoded from the event store on replay and
// remapped into planLane/attention by the projector. Never emitted live.
export const ThreadStatusSetPayload = Schema.Struct({
  threadId: ThreadId,
  status: LegacyThreadStatus,
  updatedAt: IsoDateTime,
});

export const ThreadDependenciesSetPayload = Schema.Struct({
  threadId: ThreadId,
  blockedBy: Schema.Array(ThreadId),
  updatedAt: IsoDateTime,
});

export const ThreadMessageReasoningPayload = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  turnId: Schema.NullOr(TurnId),
  // Full accumulated reasoning text for the segment. The projector REPLACES the
  // message's `reasoningText` with this value (not append) — see the v2 plan's
  // ordering contract. Persisted reasoning is always complete, so
  // `reasoningStreaming` is always false here.
  reasoningText: Schema.String,
  reasoningStreaming: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export const ThreadTurnStartFailedPayload = Schema.Struct({
  threadId: ThreadId,
  detail: Schema.String,
  createdAt: IsoDateTime,
});

export const ThreadReportSetPayload = Schema.Struct({
  threadId: ThreadId,
  reportPath: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

// Scaffold-first graph authoring: the projected kickoff-brief pointer set on a
// scaffolded child. The projector maps it onto `kickoffBriefPath`; the
// dispatcher's brief gate reads it. Overwrites are ordinary re-emits pre-launch.
export const ThreadKickoffBriefSetPayload = Schema.Struct({
  threadId: ThreadId,
  kickoffBriefPath: TrimmedNonEmptyString,
  updatedAt: IsoDateTime,
});

// consult_thread observability: one resolved consult recorded on the asker
// thread. `answer` is the FULL answer (no truncation/pointer scheme).
// `forkSessionPath` is present when the read-only fork's jsonl was retained to
// userdata for deep inspection; absent when retention failed (best-effort).
export const ThreadConsultRecordedPayload = Schema.Struct({
  askerThreadId: ThreadId,
  targetThreadId: ThreadId,
  targetTitle: Schema.String,
  question: Schema.String,
  answer: Schema.String,
  resolved: Schema.Boolean,
  durationMs: NonNegativeInt,
  forkSessionPath: Schema.optional(Schema.String),
  createdAt: IsoDateTime,
});

// `/handoff` fork-drafter (plan D5): one durable marker per `goal_handoff` call
// a handoff-drafter placed. Aggregate = the drafter thread. Carries the
// destination goal/thread ids so the marker is auditable and the settlement
// reactor's read model can project a count. Stamped only AFTER the staged
// destination is created (never speculatively).
export const ThreadHandoffRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  destinationGoalId: GoalId,
  destinationThreadId: ThreadId,
  createdAt: IsoDateTime,
});

// Review gates (design §3.2): one record per submit — the outcome token, the
// routing verdict the decider reached, and the loop round it applies to.
export const ThreadOutcomeRecordedPayload = Schema.Struct({
  threadId: ThreadId,
  outcome: TrimmedNonEmptyString,
  decision: WorkOutcomeDecision,
  round: NonNegativeInt,
  contested: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  counts: Schema.optional(WorkOutcomeCounts),
  updatedAt: IsoDateTime,
});

// Review gates (design §4.3): a control-plane loop traversal from `threadId`
// (the routing source) to `to`. The dispatcher's gate pass reacts to it;
// `gateRounds`/`pendingRework` are projected from it (Phase 3).
export const ThreadRouteTakenPayload = Schema.Struct({
  threadId: ThreadId,
  to: ThreadId,
  round: NonNegativeInt,
  updatedAt: IsoDateTime,
});

// Worktree isolation (design §3): the projected fan-in settlement for an
// isolated child. The projector sets `fanInState` from this.
export const ThreadFanInSetPayload = Schema.Struct({
  threadId: ThreadId,
  fanInState: ThreadFanInState,
  updatedAt: IsoDateTime,
});

// Builds the 20 fork event members over the upstream base fields. `orchestration.ts`
// calls this with its own (non-exported) `EventBaseFields` and spreads the
// result — HEAD position — into the `OrchestrationEvent` union.
export const makeLoomOrchestrationEventMembers = <const Base extends Schema.Struct.Fields>(
  base: Base,
) =>
  [
    Schema.Struct({ ...base, type: Schema.Literal("goal.created"), payload: GoalCreatedPayload }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("goal.meta-updated"),
      payload: GoalMetaUpdatedPayload,
    }),
    Schema.Struct({ ...base, type: Schema.Literal("goal.archived"), payload: GoalArchivedPayload }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("goal.unarchived"),
      payload: GoalUnarchivedPayload,
    }),
    Schema.Struct({ ...base, type: Schema.Literal("goal.deleted"), payload: GoalDeletedPayload }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("goal.task-created"),
      payload: GoalTaskCreatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("goal.task-updated"),
      payload: GoalTaskUpdatedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("goal.task-deleted"),
      payload: GoalTaskDeletedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.plan-lane-set"),
      payload: ThreadPlanLaneSetPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.attention-raised"),
      payload: ThreadAttentionRaisedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.attention-cleared"),
      payload: ThreadAttentionClearedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.status-set"),
      payload: ThreadStatusSetPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.dependencies-set"),
      payload: ThreadDependenciesSetPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.message-reasoning"),
      payload: ThreadMessageReasoningPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.turn-start-failed"),
      payload: ThreadTurnStartFailedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.report-set"),
      payload: ThreadReportSetPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.kickoff-brief-set"),
      payload: ThreadKickoffBriefSetPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.consult-recorded"),
      payload: ThreadConsultRecordedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.handoff-recorded"),
      payload: ThreadHandoffRecordedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.outcome-recorded"),
      payload: ThreadOutcomeRecordedPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.route-taken"),
      payload: ThreadRouteTakenPayload,
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("thread.fanin-set"),
      payload: ThreadFanInSetPayload,
    }),
  ] as const;

// ---------------------------------------------------------------------------
// Literal / union-member tuples for the remaining splices.
// ---------------------------------------------------------------------------

// Spliced (HEAD) into `OrchestrationEventType` (shape b).
export const LOOM_EVENT_TYPES = [
  "goal.created",
  "goal.meta-updated",
  "goal.archived",
  "goal.unarchived",
  "goal.deleted",
  "goal.task-created",
  "goal.task-updated",
  "goal.task-deleted",
  "thread.plan-lane-set",
  "thread.attention-raised",
  "thread.attention-cleared",
  "thread.status-set",
  "thread.dependencies-set",
  "thread.message-reasoning",
  "thread.turn-start-failed",
  "thread.consult-recorded",
  "thread.handoff-recorded",
  "thread.report-set",
  "thread.kickoff-brief-set",
  "thread.outcome-recorded",
  "thread.route-taken",
  "thread.fanin-set",
] as const;

// Spliced (HEAD) into `OrchestrationAggregateKind` (shape b) — the fork's
// `goal` aggregate.
export const LOOM_AGGREGATE_KINDS = ["goal"] as const;

// Spliced (HEAD) into `OrchestrationShellStreamEvent` (shape a).
export const LoomShellStreamEventMembers = [
  Schema.Struct({
    kind: Schema.Literal("goal-upserted"),
    sequence: NonNegativeInt,
    goal: OrchestrationGoalShell,
  }),
  Schema.Struct({
    kind: Schema.Literal("goal-removed"),
    sequence: NonNegativeInt,
    goalId: GoalId,
  }),
] as const;

// Spliced (HEAD) into `OrchestrationThreadStreamItem` (shape a).
export const LoomThreadStreamItemMembers = [
  Schema.Struct({
    kind: Schema.Literal("reasoning-delta"),
    payload: ReasoningStreamItem,
  }),
] as const;

// ---------------------------------------------------------------------------
// Narrowing guards (shape e). The listed string arrays are checked against the
// spliced member tuples in BOTH directions, so an omission AND a typo/extra
// entry are each a compile error naming the offending literal. Consumed by
// Slice B (decider/projector delegation).
// ---------------------------------------------------------------------------

type AssertNever<T extends never> = T;

// The "listed" side for commands.
export const LOOM_COMMAND_TYPES = [
  "goal.create",
  "goal.meta.update",
  "goal.archive",
  "goal.unarchive",
  "goal.delete",
  "goal.task.create",
  "goal.task.update",
  "goal.task.delete",
  "thread.plan-lane.set",
  "thread.attention.raise",
  "thread.attention.clear",
  "thread.dependencies.set",
  "thread.message.reasoning.complete",
  "thread.work.submit",
  "thread.consult.record",
  "thread.handoff.record",
  "thread.fanin.set",
  "thread.turn-start.fail",
  "thread.kickoff-brief.set",
  "thread.scaffold",
] as const;
export type LoomCommandType = (typeof LOOM_COMMAND_TYPES)[number];

// The "expected" side, derived from the member tuples actually spliced. The
// scaffold command is produced by `makeLoomScaffoldCommandMembers` (spliced into
// the internal union by `orchestration.ts` with its own `ModelSelection`), so
// its `type` literal is derived from the factory return — mirroring how
// `LoomEventMemberType` derives from `makeLoomOrchestrationEventMembers`.
type LoomCommandMemberType =
  | (typeof LoomClientCommandMembers)[number]["Type"]["type"]
  | (typeof LoomInternalCommandMembers)[number]["Type"]["type"]
  | ReturnType<typeof makeLoomScaffoldCommandMembers>[number]["Type"]["type"];

// Exactness, both directions.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _MissingLoomCommandTypes = AssertNever<Exclude<LoomCommandMemberType, LoomCommandType>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ExtraLoomCommandTypes = AssertNever<Exclude<LoomCommandType, LoomCommandMemberType>>;

export type LoomOrchestrationCommand = Extract<OrchestrationCommand, { type: LoomCommandType }>;
const LOOM_COMMAND_TYPE_SET: ReadonlySet<string> = new Set(LOOM_COMMAND_TYPES);
export const isLoomOrchestrationCommand = (
  command: OrchestrationCommand,
): command is LoomOrchestrationCommand => LOOM_COMMAND_TYPE_SET.has(command.type);

export type LoomEventType = (typeof LOOM_EVENT_TYPES)[number];

// The "expected" side for events, derived from an instantiation of the factory
// return type over empty base fields.
type LoomEventMemberType = ReturnType<
  typeof makeLoomOrchestrationEventMembers<Record<never, never>>
>[number]["Type"]["type"];

// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _MissingLoomEventTypes = AssertNever<Exclude<LoomEventMemberType, LoomEventType>>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ExtraLoomEventTypes = AssertNever<Exclude<LoomEventType, LoomEventMemberType>>;

export type LoomOrchestrationEvent = Extract<OrchestrationEvent, { type: LoomEventType }>;
const LOOM_EVENT_TYPE_SET: ReadonlySet<string> = new Set(LOOM_EVENT_TYPES);
export const isLoomOrchestrationEvent = (
  event: OrchestrationEvent,
): event is LoomOrchestrationEvent => LOOM_EVENT_TYPE_SET.has(event.type);
