import {
  type AttentionReason,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  type ThreadId,
  type ThreadPlanLane,
} from "@t3tools/contracts";
import { selectJoinedGenerations, type JoinedGeneration } from "@t3tools/shared/workstreamGraph";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationCommandReceiptRepository } from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  WorkstreamDispatcher,
  type WorkstreamDispatcherShape,
} from "../Services/WorkstreamDispatcher.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";
import { readWorkstreamReport } from "../workstreamReport.ts";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";
import { isThreadIdle } from "../threadIdle.ts";

/**
 * Pure "promote ready" selection: every un-started sub-thread whose `blockedBy`
 * dependencies are all satisfied.
 *
 * - Sub-thread: has a `parentThreadId` (root threads start via the normal flow).
 * - Released: plan lane is `ready` (the intentional release gate). A `planned`
 *   child is a deliberate hold — it sits even with deps clear until released.
 * - Un-started: no provider session **and** no started turn (no user message).
 * - Deps satisfied: per the shared `areDependenciesSatisfied` predicate — every
 *   `blockedBy` entry that names a known sibling must be `done` (`cancelled`
 *   does not release); self-refs, dangling ids, and non-siblings never gate.
 *   Sharing the predicate keeps execution gating and the client board in
 *   agreement.
 *
 * Both gates (release + dependency) must clear, mirroring the two-gate start
 * model (design §3). Returns only threads that carry both `role` and `purpose`,
 * which are required to build the deferred kick-off prompt (spawn always sets
 * them).
 */
export const selectThreadsToDispatch = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlyArray<OrchestrationThreadShell> => {
  const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
  return threads.filter(
    (thread) =>
      thread.parentThreadId !== null &&
      thread.role !== null &&
      thread.purpose !== null &&
      thread.planLane === "ready" &&
      thread.session === null &&
      thread.latestUserMessageAt === null &&
      areDependenciesSatisfied(thread, threadsById),
  );
};

export interface WakeRateGuardConfig {
  readonly windowMs: number;
  readonly maxInWindow: number;
  readonly absoluteBackstop: number;
}

/**
 * Runaway guard (decision 5): generously-defaulted, rate-based park-and-escalate.
 *
 * Two independent catches:
 * - **Rate window** — the primary, cadence-based signal. Real work has slow
 *   generations (minutes of child work each); a spin-loop fires many wakes in a
 *   short window. The window is tuned so a slow-cadence overnight job never
 *   trips it.
 * - **Absolute backstop** — a deliberately high interim ceiling that trips after
 *   `absoluteBackstop` total wakes for a parent **regardless of cadence**. This
 *   is an accepted interim limit, not a cadence signal: even a legitimate
 *   long-running job is parked once it has generated this many wake-generations.
 *   500 is set high enough that hitting it is a non-issue in practice; the
 *   stronger heartbeat/investigator solution (D-liveness) will replace it.
 */
export const DEFAULT_WAKE_RATE_GUARD: WakeRateGuardConfig = {
  windowMs: 60_000,
  maxInWindow: 30,
  absoluteBackstop: 500,
};

/**
 * Pure guard predicate: would delivering one more wake for this parent (whose
 * prior wake timestamps are `timestamps`) breach the rolling-window rate or the
 * absolute backstop? The backstop trips on total count alone, independent of
 * cadence.
 */
export const wakeRateGuardTrips = (
  timestamps: ReadonlyArray<number>,
  now: number,
  config: WakeRateGuardConfig = DEFAULT_WAKE_RATE_GUARD,
): boolean => {
  const inWindow = timestamps.reduce(
    (count, at) => (at >= now - config.windowMs ? count + 1 : count),
    0,
  );
  return inWindow + 1 > config.maxInWindow || timestamps.length + 1 > config.absoluteBackstop;
};

/**
 * Maximum number of report characters embedded inline in a wake message. The
 * wake carries a *bounded* excerpt plus the on-disk reference, never the full
 * report text (the signed contract: "compact bounded summary + reference"); the
 * parent pulls the full report on demand via its `reportPath`.
 */
export const WAKE_REPORT_EXCERPT_LIMIT = 600;

/**
 * Control-plane attribution marker. The dispatcher injects wake/notice texts as
 * `role:"user"` turns (pi has no separate channel), so without this leading line
 * a parent cannot tell an automated workstream notice from a real human message.
 * Shared by both wake builders so they can't drift; the work-model system prompt
 * teaches the agent to treat a marked turn as a control-plane signal, not the
 * user's directive.
 */
export const WORKSTREAM_CONTROL_PLANE_MARKER =
  "[T3 Workstream control plane — automated notice, not from the user]";

/**
 * Bounded inline report excerpt shared by both wake-message builders: empty when
 * there is no report, the trimmed report when it fits, else a truncated prefix
 * plus a pointer to the on-disk reference. Leads with a blank line so callers
 * append it directly after the reference.
 */
const formatReportExcerpt = (report: string | null): string => {
  const trimmed = report?.trim() ?? "";
  if (trimmed.length === 0) return "";
  return trimmed.length > WAKE_REPORT_EXCERPT_LIMIT
    ? `\n\n${trimmed.slice(0, WAKE_REPORT_EXCERPT_LIMIT)}…\n\n_[excerpt truncated — read the full report via the reference above]_`
    : `\n\n${trimmed}`;
};

/**
 * Pure parent wake-message builder (the wake-message contract): tells the parent
 * which children reached a terminal plan lane (role + id + lane + any attention
 * flags — the copy never claims a child "finished" beyond its actual lane), for
 * each a reference to its on-disk report plus a BOUNDED excerpt (never the full
 * report), and the instruction to review, decide what needs human escalation
 * vs. what it can act on / accept on the human's behalf, and continue
 * orchestrating (including accepting children that are awaiting acceptance).
 */
export const buildParentWakeMessage = (
  children: ReadonlyArray<{
    readonly id: ThreadId;
    readonly role: string | null;
    readonly planLane: ThreadPlanLane;
    readonly attention: ReadonlyArray<AttentionReason>;
    readonly reportPath: string | null;
    readonly report: string | null;
  }>,
): string => {
  const sections = children.map((child) => {
    const flags = child.attention.length > 0 ? ` (attention: ${child.attention.join(", ")})` : "";
    const header = `### ${child.role ?? "sub-thread"} \`${child.id}\` — ${child.planLane}${flags}`;
    const reference =
      child.reportPath !== null
        ? `Report reference: \`${child.reportPath}\` (read the full report on demand)`
        : "_No report was filed; status is the trigger, the report is best-effort context._";
    return `${header}\n\n${reference}${formatReportExcerpt(child.report)}`;
  });
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    "A spawn generation of your Workstream sub-thread(s) has reached terminal plan lanes (done/cancelled). Results:",
    "",
    sections.join("\n\n"),
    "",
    "Review these results. Decide what (if anything) genuinely warrants human escalation versus what you can act on or accept on the human's behalf. For any child awaiting acceptance, you are the first-pass reviewer: either accept it (advance its plan to `done` with `workstream_set_lane`, which releases its dependents) or escalate to the human when human review is genuinely warranted. Then reconcile the task tree and continue orchestrating.",
  ].join("\n");
};

// Deterministic per-(parent, generation) command ids. Both the wake and the
// park dispatch commands under these ids, so their receipts are the durable,
// recomputable markers of "this generation was already handled" (decision 4):
// wake delivery is idempotent across restarts, and — critically — a parked
// generation leaves durable markers too, so startup reconciliation does not
// re-deliver a previously-suppressed generation as a normal wake.
//
// Park writes TWO durable receipts: the `needs_guidance` attention.raise
// (`parkBlockCommandId`, written FIRST) and the activity marker (`parkCommandId`,
// written second). The
// handled-check keys off the FIRST write (`parkBlockCommandId`), so a crash
// between the two writes can never resurface a parked generation as a normal
// wake (Fix B); the missing activity marker is reconciled on the next pass.
export const wakeCommandId = (parentId: ThreadId, generation: string): string =>
  `server:workstream-notify:wake:${parentId}:${generation}`;

/**
 * Per-child wake (D-liveness §1e). All per-child kinds (`error`, paused
 * `attention`, forgot-to-finish `idle`, `recovered`) wake the parent through
 * THIS rail, not the generation
 * barrier (`selectJoinedGenerations` only fires when an *entire* generation is
 * terminal, so a single quiet/errored child among running siblings would never
 * wake the parent). The command id is keyed by `(childId, episode)` so each
 * distinct quiet episode notifies exactly once; for idle the episode is the
 * child's max activity *sequence* at idle onset (NOT `turnId`, which is null
 * while idle), so a child that resumes then goes quiet again re-arms while an
 * unacted-on idle child is not re-nagged every pass.
 */
export const childWakeCommandId = (childId: ThreadId, episode: string): string =>
  `server:workstream-liveness:child-wake:${childId}:${episode}`;

/**
 * The per-child wake kinds. `error`/`attention`/`idle` are classified purely
 * from thread state by `classifyChildWake`; `recovered` (a child the parent was
 * told had `error`ed that later reached `done`) is decided in the dispatcher
 * loop because it needs a durable receipt lookup, not just current state.
 */
export type ChildWakeKind = "error" | "attention" | "idle" | "recovered";

/**
 * Pure per-child wake classification (§1e). Returns the wake kind for a child
 * that should wake its parent, or `null`:
 * - `error` — the liveness sweep raised the child's `error` attention flag
 *   (crash/stall/loop/cap).
 * - `attention` — "paused, needs attention": the child carries a raised
 *   attention flag (`needs_guidance`/`awaiting_acceptance` — a human stop, a
 *   self-raise, a stall escalation), is not executing, and its plan lane is
 *   still pre-terminal. Since the generation join is plan-lane-only, this rail
 *   is the ONLY way the parent agent hears about a paused child; the copy is
 *   honest ("paused", never "finished").
 * - `idle`  — "forgot to finish": the child ran (has a session now `ready`/
 *   `stopped`) and went idle, but its plan lane is still pre-terminal
 *   (`ready`/`in_progress`) AND it carries no attention flag (a `done`/
 *   `cancelled` child is finished and joins its generation instead).
 *
 * Idleness reuses the shared `isThreadIdle` predicate (no pending turn-start,
 * session not `running`, no active turn) so a freshly-promoted child mid-kickoff
 * — or a just-resumed paused child whose turn-start is pending — is never
 * misclassified. A never-started `planned` child has no session and is excluded
 * from the idle kind (it is waiting on deps/release, not stuck).
 */
export const classifyChildWake = (
  child: OrchestrationThreadShell,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): ChildWakeKind | null => {
  if (child.parentThreadId === null) return null;
  if (child.attention.includes("error")) return "error";
  if (
    child.attention.length > 0 &&
    child.planLane !== "done" &&
    child.planLane !== "cancelled" &&
    isThreadIdle(child, pendingTurnStartThreadIds)
  ) {
    return "attention";
  }
  if (
    child.attention.length === 0 &&
    (child.planLane === "ready" || child.planLane === "in_progress") &&
    child.session !== null &&
    (child.session.status === "ready" || child.session.status === "stopped") &&
    isThreadIdle(child, pendingTurnStartThreadIds)
  ) {
    return "idle";
  }
  return null;
};

/**
 * Idle-wake grace window (ms): the activity-freshness corroboration the idle
 * ("forgot to finish") rail previously lacked. The mid-turn stall detector is
 * graced (it only judges while a turn is open and waits out a no-progress
 * window); the instant `activeTurnId` flips to null, ownership passes to the idle
 * rail, which used to fire on the very next pass with ZERO corroboration. That
 * mislabels a multi-turn child that briefly has no open turn between turns (it
 * just completed turn N and is continuing / about to start turn N+1) as
 * "forgot to finish".
 *
 * Set equal to the liveness sweep's no-progress window (`staleActivityWindowMs`,
 * 10m) so the active-turn (stall) and idle rails share ONE inactivity threshold
 * — "no new activity for 10m → wake the parent", whether or not a turn is open.
 * No dead zone, and a normal between-turns gap (seconds) never trips it.
 */
export const DEFAULT_IDLE_WAKE_GRACE_MS = 600_000;

/**
 * How often to re-run the dispatcher pass independent of domain events. The
 * passes are otherwise event-driven; a child that goes quiet and emits no
 * further event would never have its idle wake re-evaluated once the grace above
 * elapses (the pass that observed it ran while its activity was still fresh and
 * correctly suppressed the wake). This periodic tick re-evaluates suppressed idle
 * children so a genuinely-idle one is still woken once its grace passes. Matches
 * the liveness sweep cadence (`sweepIntervalMs`).
 */
export const IDLE_WAKE_REPASS_INTERVAL_MS = 60_000;

const parseIsoMs = (iso: string | null): number | null => {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * Last-progress timestamp (ms) for an idle child: the newest activity row, else
 * the latest turn's completion (the moment it went idle), else its start. `null`
 * only when nothing is known (a session-bearing child with no activity and no
 * turn — pathological), in which case the caller withholds the wake.
 */
export const idleLastProgressMs = (
  maxActivityCreatedAt: string | null,
  latestTurn: OrchestrationLatestTurn | null,
): number | null =>
  parseIsoMs(maxActivityCreatedAt) ??
  parseIsoMs(latestTurn?.completedAt ?? latestTurn?.startedAt ?? null);

/**
 * Activity-freshness grace gate for the idle wake: `true` ⇒ withhold (the child
 * has shown activity within `graceWindowMs`, or its last-progress time is
 * unknown). The idle wake fires only once this returns `false`. A grace only
 * delays *onset*; it does not change the one-wake-per-episode dedup (the episode
 * key still re-arms on `maxSequence`).
 */
export const idleWakeWithinGrace = (
  lastProgressMs: number | null,
  now: number,
  graceWindowMs: number,
): boolean => lastProgressMs === null || now - lastProgressMs < graceWindowMs;

/**
 * Pure per-child wake-message builder. Tells the parent which child went
 * `error` / paused / quiet, points at its on-disk report (with a bounded
 * excerpt), and instructs it how to proceed. The `attention` copy is a PAUSE
 * notice — it names the child's plan lane + attention flags and explicitly says
 * the child has not finished.
 */
export const buildChildWakeMessage = (
  child: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly planLane: ThreadPlanLane;
    readonly attention: ReadonlyArray<AttentionReason>;
    readonly reportPath: string | null;
  },
  kind: ChildWakeKind,
  report: string | null,
): string => {
  const who = `${child.role ?? "sub-thread"} \`${child.id}\``;
  const lead =
    kind === "error"
      ? `Your Workstream sub-thread ${who} raised an \`error\` attention flag (the liveness sweep detected it dead, stalled, looping, or repeatedly failing) and did not report success.`
      : kind === "attention"
        ? `Your Workstream sub-thread ${who} is paused and needs attention: it carries the attention flag(s) \`${child.attention.join("`, `")}\` and is not executing, while its plan lane is still \`${child.planLane}\`. It has NOT finished — this is a pause notice, not a result.`
        : kind === "idle"
          ? `Your Workstream sub-thread ${who} went quiet without reporting: it finished its turn and is idle, but its plan lane is still in progress (it never advanced its plan or raised attention). It has been flagged \`needs_guidance\` so it surfaces for you.`
          : `Your Workstream sub-thread ${who} recovered: you were told it raised an \`error\` flag (often a false-positive liveness verdict), but its plan has since reached \`done\`. The earlier error verdict is superseded — treat it as having completed successfully.`;
  const reference =
    child.reportPath !== null
      ? `Report reference: \`${child.reportPath}\` (read the full report on demand).`
      : "_No report was filed._";
  const tail =
    kind === "recovered"
      ? "Its dependents have already been released by the `done` transition (nothing is gated on it now). Read its report (referenced above), fold its result into your orchestration, and continue."
      : kind === "attention"
        ? "Do not treat its work as complete. If it is `awaiting_acceptance`, review its report and either accept it (`workstream_set_lane` done, which releases its dependents) or escalate to the human. If it is `needs_guidance` (e.g. a human stopped it, or it cannot proceed), a human is in the loop — plan around the pause rather than resuming it yourself. Its dependents stay gated until it reaches `done`."
        : "Investigate via its report above (or `consult_thread` for a read-only Q&A), then either advance its plan lane (`workstream_set_lane` done/cancelled) or re-dispatch it. Its dependents stay gated until it reaches `done`; nothing was auto-cascaded.";
  return [
    WORKSTREAM_CONTROL_PLANE_MARKER,
    "",
    lead,
    "",
    reference + formatReportExcerpt(report),
    "",
    tail,
  ].join("\n");
};
const parkCommandId = (parentId: ThreadId, generation: string): string =>
  `server:workstream-notify:park:${parentId}:${generation}`;
// The FIRST durable park write (the `needs_guidance` attention.raise). The
// handled-check keys off this receipt, not the activity marker, to close the
// crash window.
const parkBlockCommandId = (parentId: ThreadId, generation: string): string =>
  `${parkCommandId(parentId, generation)}:block`;

export type GenerationDeliveryDecision =
  | { readonly kind: "already-woken" }
  | { readonly kind: "parked"; readonly reconcileMarker: boolean }
  | { readonly kind: "deliverable" };

/**
 * Pure receipt-driven decision for one (parent, generation) (Fix B): given which
 * of its durable receipts exist, decide whether the wake was already delivered,
 * the generation was parked (and whether its activity marker still needs
 * reconciling after a crash between the two park writes), or it is still
 * deliverable.
 *
 * Keying "parked" off the FIRST park write (`parkBlocked`) — not the activity
 * marker — is the fix: a crash between the attention.raise and the marker leaves the
 * generation parked, never redelivered as a normal wake.
 */
export const classifyGenerationByReceipts = (receipts: {
  readonly wakeDelivered: boolean;
  readonly parkBlocked: boolean;
  readonly parkMarkerPresent: boolean;
}): GenerationDeliveryDecision =>
  receipts.wakeDelivered
    ? { kind: "already-woken" }
    : receipts.parkBlocked
      ? { kind: "parked", reconcileMarker: !receipts.parkMarkerPresent }
      : { kind: "deliverable" };

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const commandReceiptRepository = yield* OrchestrationCommandReceiptRepository;

  // In-memory caches of the recomputable durable state (decision 4): the
  // handled-generation set caches the receipt-backed wake/park markers, and the
  // wake-timestamp history backs the interim rate guard. Both are safe as plain
  // mutable state because the drainable worker processes serially. The cache is
  // only ever a cache: a miss falls through to the durable receipt store, so a
  // fresh process (empty cache) still recomputes the true handled set.
  const handledGenerations = new Set<string>();
  const wakeTimestamps = new Map<string, number[]>();
  // Per-child wake dedup (§1e), keyed by the deterministic child-wake command
  // id `(childId, episode)`. A cache only: a miss falls through to the durable
  // receipt store, so a fresh process recomputes the true delivered set.
  const handledChildWakes = new Set<string>();

  // Does a command id have an accepted receipt? Backs the durable handled-check,
  // so a fresh process (empty cache) still recomputes the true handled set from
  // the receipt store rather than re-firing a wake/park.
  const hasAcceptedReceipt = (commandId: string) =>
    commandReceiptRepository
      .getByCommandId({ commandId: CommandId.make(commandId) })
      .pipe(Effect.map(Option.isSome));

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:workstream-dispatcher:${tag}:${uuid}`)),
    );

  const promoteThread = Effect.fn("promoteThread")(function* (thread: OrchestrationThreadShell) {
    const { role, purpose, brief } = thread;
    // Guaranteed non-null by selectThreadsToDispatch; this also narrows types.
    if (role === null || purpose === null) return;
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    // Atomic kickoff: `setInProgress` makes the decider emit the `in_progress`
    // plan-lane-set in the SAME command as the turn-start, so both events are
    // appended in one engine transaction. A crash can never leave the child with
    // a started turn but a lane stuck at `ready`, and the next promote pass sees
    // a started thread and never double-starts it.
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("start-turn"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: workstreamChildPrompt({ role, brief: brief ?? purpose }),
        attachments: [],
      },
      titleSeed: thread.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      setInProgress: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const promoteReadyThreads = Effect.fn("promoteReadyThreads")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    for (const thread of selectThreadsToDispatch(snapshot.threads)) {
      yield* promoteThread(thread);
    }
  });

  // Deliver a single (parent, generation) wake. The command id is deterministic
  // (parent + generation), so the receipt store dedups delivery across restarts
  // and re-evaluations (decision 4): re-dispatch after a wake was already
  // injected is a no-op that never injects a second turn. `requireIdle` makes
  // the engine re-check parent idleness atomically at the serialized command
  // boundary; a busy parent defers (fails without a receipt) and is retried on
  // the next idle drain.
  const deliverWake = Effect.fn("deliverWake")(function* (
    parent: OrchestrationThreadShell,
    generation: JoinedGeneration<OrchestrationThreadShell>,
  ) {
    const children = yield* Effect.forEach(generation.children, (child) =>
      readWorkstreamReport(child.id).pipe(
        Effect.map((report) => ({
          id: child.id,
          role: child.role,
          planLane: child.planLane,
          attention: child.attention,
          reportPath: child.reportPath,
          report: Option.getOrNull(report),
        })),
      ),
    );
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(wakeCommandId(parent.id, generation.generation)),
      threadId: parent.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: buildParentWakeMessage(children),
        attachments: [],
      },
      titleSeed: parent.title,
      runtimeMode: parent.runtimeMode,
      interactionMode: parent.interactionMode,
      requireIdle: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const PARK_SUMMARY =
    "Workstream wake rate guard tripped: this parent is being woken too frequently (likely a spawn spin-loop). Parked and escalated for human review.";

  // The activity marker — the SECOND durable park write (under `parkCommandId`).
  // Dispatched both as the tail of a fresh park and, on its own, to reconcile a
  // crash that landed the `needs_guidance` attention.raise but not this marker (Fix B).
  const dispatchParkMarker = Effect.fn("dispatchParkMarker")(function* (
    parent: OrchestrationThreadShell,
    generation: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(parkCommandId(parent.id, generation)),
      threadId: parent.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "workstream.runaway-guard.tripped",
        summary: PARK_SUMMARY,
        payload: { reason: "wake-rate-guard", generation },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Park-and-escalate (decision 5): on a tripped rate guard, do not kill and do
  // not deliver — raise the parent's `needs_guidance` attention flag (the single
  // notification surface) and surface it to the human (the stub for the future
  // investigator agent). The `needs_guidance` attention.raise (`parkBlockCommandId`)
  // is dispatched FIRST and is the durable marker the handled-check keys off; the
  // activity marker follows. A crash between the two leaves the generation parked
  // (block receipt present) and is reconciled into the marker on the next pass —
  // never redelivered as a normal wake (Fix B).
  const parkAndEscalate = Effect.fn("parkAndEscalate")(function* (
    parent: OrchestrationThreadShell,
    generation: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.attention.raise",
      commandId: CommandId.make(parkBlockCommandId(parent.id, generation)),
      threadId: parent.id,
      reason: "needs_guidance",
      createdAt: now,
    } satisfies OrchestrationCommand);
    yield* dispatchParkMarker(parent, generation);
  });

  const wakeEligibleParents = Effect.fn("wakeEligibleParents")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const joined = selectJoinedGenerations(snapshot.threads);
    if (joined.length === 0) return;
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const generation of joined) {
      const key = `${generation.parentId}::${generation.generation}`;
      if (handledGenerations.has(key)) continue;
      const parent = threadsById.get(generation.parentId);
      // Parent absent (archived/deleted) → nothing to wake.
      if (parent === undefined) continue;

      // Durable idempotency (decision 4 + Fix B): classify from the receipt
      // store, not just the in-memory cache, so a fresh process never
      // re-delivers a generation that was already woken or parked. "Parked" keys
      // off the FIRST park write (the `needs_guidance` attention.raise), so a crash between
      // the two park writes can never resurface a parked generation as a wake.
      const wakeDelivered = yield* hasAcceptedReceipt(
        wakeCommandId(generation.parentId, generation.generation),
      );
      const parkBlocked =
        !wakeDelivered &&
        (yield* hasAcceptedReceipt(parkBlockCommandId(generation.parentId, generation.generation)));
      const parkMarkerPresent =
        !parkBlocked ||
        (yield* hasAcceptedReceipt(parkCommandId(generation.parentId, generation.generation)));
      const decision = classifyGenerationByReceipts({
        wakeDelivered,
        parkBlocked,
        parkMarkerPresent,
      });
      if (decision.kind === "already-woken") {
        handledGenerations.add(key);
        continue;
      }
      if (decision.kind === "parked") {
        // Reconcile a crash between the two park writes: the `needs_guidance`
        // attention.raise landed but the activity marker did not. Append it rather than waking.
        if (decision.reconcileMarker) {
          yield* dispatchParkMarker(parent, generation.generation);
        }
        handledGenerations.add(key);
        continue;
      }

      // Busy parent → defer; a later thread.session-set (parent going idle)
      // re-triggers this pass. (The engine re-checks idleness atomically too.)
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      const now = yield* Clock.currentTimeMillis;
      const history = wakeTimestamps.get(generation.parentId) ?? [];
      if (wakeRateGuardTrips(history, now)) {
        yield* parkAndEscalate(parent, generation.generation);
        handledGenerations.add(key);
        continue;
      }
      // requireIdle makes the engine defer (no receipt) if the parent became
      // busy in the race window; treat that as not-yet-delivered so the next
      // idle drain retries. Only mark handled + count the wake on real delivery.
      const delivered = yield* deliverWake(parent, generation).pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandDeferredError", () => Effect.succeed(false)),
      );
      if (delivered) {
        wakeTimestamps.set(generation.parentId, [...history, now]);
        handledGenerations.add(key);
      }
    }
  });

  // Deliver one per-child wake (§1e). Mirrors `deliverWake`: a deterministic
  // command id (receipt-dedup across restarts), `requireIdle` so a busy parent
  // defers atomically at the command boundary. The child's PLAN is left untouched
  // (the parent decides done/cancelled/re-dispatch); the only state it writes is
  // the idle backstop's `needs_guidance` flag (design §4.7) so a forgot-to-finish
  // child cannot sit silently halted.
  const deliverChildWake = Effect.fn("deliverChildWake")(function* (
    parent: OrchestrationThreadShell,
    child: OrchestrationThreadShell,
    kind: ChildWakeKind,
    commandId: string,
  ) {
    // No-silent-halt backstop (design §4.7/§6): a forgot-to-finish child is
    // halted non-terminal with no resumer, so raise its `needs_guidance` flag —
    // the board must SHOW it carries the flag, not merely generate a wake.
    // Idempotent (deterministic `server:` id, receipt-deduped) and raised BEFORE
    // the wake so the flag lands even if the parent wake later defers — in that
    // race the now-flagged child is picked up by the `attention` rail on the
    // next pass, so the parent is still woken. The `error`/`attention` kinds
    // already carry their flags and `recovered` reached `done` (terminal) —
    // none of those raise here.
    if (kind === "idle") {
      yield* orchestrationEngine.dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make(`${commandId}:flag`),
        threadId: child.id,
        reason: "needs_guidance",
        createdAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      } satisfies OrchestrationCommand);
    }
    const report = yield* readWorkstreamReport(child.id).pipe(Effect.map(Option.getOrNull));
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(commandId),
      threadId: parent.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: buildChildWakeMessage(child, kind, report),
        attachments: [],
      },
      titleSeed: parent.title,
      runtimeMode: parent.runtimeMode,
      interactionMode: parent.interactionMode,
      requireIdle: true,
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  // Per-child wake pass (§1e): wake the parent of every `error`, paused
  // (attention-flagged, non-executing), forgot-to-finish, or recovered
  // (`error`→`done`) child through the shared rail, so a single
  // failed/paused/quiet/recovered child is surfaced promptly (B1) even while its
  // siblings still run — the generation barrier (`wakeEligibleParents`) only
  // fires once a WHOLE generation is plan-terminal, and is one-shot per
  // generation so it never re-notifies on an `error`→`done` flip. Shares `wakeTimestamps` +
  // `parkAndEscalate` so error/idle/recovery/generation-join wakes draw on ONE
  // rate budget per parent (C1).
  const wakeIdleAndErroredChildren = Effect.fn("wakeIdleAndErroredChildren")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const child of snapshot.threads) {
      // Top-level threads have no agent parent to wake; the board surfaces them
      // (error lane / activity) as escalate-to-human.
      if (child.parentThreadId === null) continue;
      const parent = threadsById.get(child.parentThreadId);
      if (parent === undefined) continue;

      const now = yield* Clock.currentTimeMillis;
      // Episode key (C3): `error` fires once; `attention` keys on the latest
      // turn at pause time (stable while paused → no re-nag every pass; a resume
      // starts a new turn AND clears attention, so a later re-pause re-arms);
      // idle keys on the child's max activity sequence at idle onset (stable
      // while idle → no re-nag; a resumed-then-quiet child advances the sequence
      // → re-arms). The idle rail
      // also applies an activity-freshness grace (reusing this SAME freshness
      // fetch) so a child that only briefly has no open turn between turns is not
      // mislabeled "forgot to finish"; the periodic re-pass re-evaluates it once
      // the grace elapses. `recovered` re-notifies the parent that a child it was
      // told had `error`ed has since reached `done` (its frozen error verdict is
      // superseded); it fires once per child, keyed off the DURABLE error-wake
      // receipt — NOT `handledChildWakes`, which the park path poisons by adding
      // the command id without writing a receipt.
      let kind = classifyChildWake(child, pendingTurnStartThreadIds);
      let episode: string;
      if (kind === "error") {
        episode = "error";
      } else if (kind === "idle") {
        const freshness = yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(child.id);
        if (
          idleWakeWithinGrace(
            idleLastProgressMs(freshness.maxCreatedAt, child.latestTurn),
            now,
            DEFAULT_IDLE_WAKE_GRACE_MS,
          )
        )
          continue;
        episode = `idle:${freshness.maxSequence ?? "none"}`;
      } else if (kind === "attention") {
        episode = `attention:${child.latestTurn?.turnId ?? "none"}`;
        // The idle backstop raises `needs_guidance` itself right before its
        // "went quiet" wake, which would re-classify the same child as
        // `attention` on the very next pass. If THIS quiet episode (same max
        // activity sequence) was already surfaced by a delivered idle wake, the
        // parent has been told once — don't notify again.
        const freshness = yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(child.id);
        const idleWakeId = childWakeCommandId(child.id, `idle:${freshness.maxSequence ?? "none"}`);
        if (handledChildWakes.has(idleWakeId) || (yield* hasAcceptedReceipt(idleWakeId))) {
          handledChildWakes.add(childWakeCommandId(child.id, episode));
          continue;
        }
      } else if (child.planLane === "done") {
        const recoveryId = childWakeCommandId(child.id, "recovered");
        if (handledChildWakes.has(recoveryId)) continue;
        // Only a child the parent was DURABLY told had errored can "recover". A
        // done child with no error-wake receipt never errored (error precedes
        // done) → record it handled so the receipt is not re-read every pass.
        if (!(yield* hasAcceptedReceipt(childWakeCommandId(child.id, "error")))) {
          handledChildWakes.add(recoveryId);
          continue;
        }
        kind = "recovered";
        episode = "recovered";
      } else {
        continue;
      }
      const commandId = childWakeCommandId(child.id, episode);
      if (handledChildWakes.has(commandId)) continue;
      if (yield* hasAcceptedReceipt(commandId)) {
        handledChildWakes.add(commandId);
        continue;
      }

      // Busy parent → defer; a later thread.session-set re-triggers this pass.
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      const history = wakeTimestamps.get(parent.id) ?? [];
      if (wakeRateGuardTrips(history, now)) {
        yield* parkAndEscalate(
          parent,
          kind === "recovered" ? `child-recovery:${child.id}` : `child-wake:${child.id}`,
        );
        handledChildWakes.add(commandId);
        continue;
      }
      // Catch the busy-parent race (C2) exactly like `deliverWake`: a deferred
      // command writes no receipt, so it is retried on the next idle drain.
      const delivered = yield* deliverChildWake(parent, child, kind, commandId).pipe(
        Effect.as(true),
        Effect.catchTag("OrchestrationCommandDeferredError", () => Effect.succeed(false)),
      );
      if (delivered) {
        wakeTimestamps.set(parent.id, [...history, now]);
        handledChildWakes.add(commandId);
      }
    }
  });

  const runPassSafely = Effect.andThen(
    Effect.andThen(promoteReadyThreads(), wakeEligibleParents()),
    wakeIdleAndErroredChildren(),
  ).pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.failCause(cause);
      }
      return Effect.logWarning("workstream dispatcher pass failed", {
        cause: Cause.pretty(cause),
      });
    }),
  );

  const worker = yield* makeDrainableWorker((_trigger: void) => runPassSafely);

  const start: WorkstreamDispatcherShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.created" ||
        // A child reaching `done` (plan-lane-set) releases dependents and can
        // complete a generation; an `error`/`needs_guidance` raise (attention-
        // raised) surfaces a child needing a human. Both must re-run the pass.
        event.type === "thread.plan-lane-set" ||
        event.type === "thread.attention-raised" ||
        event.type === "thread.dependencies-set" ||
        // The parent going idle surfaces as a durable thread.session-set (no
        // turn-completion domain event exists); this drains deferred wakes.
        event.type === "thread.session-set"
          ? worker.enqueue()
          : Effect.void,
      ),
    );
    // Startup reconciliation pass (decision 4): streamDomainEvents has no replay,
    // so a child that went terminal before this reactor subscribed (e.g. a
    // restart mid-flight) would otherwise strand both downstream promotion and
    // the parent wake. Recompute eligibility from the read model and deliver.
    yield* worker.enqueue();
    // Scheduled re-pass (idle-wake grace): the subscriptions above are
    // event-driven, but a child that goes quiet and emits no further event would
    // never have its idle wake re-evaluated once the activity-freshness grace
    // (DEFAULT_IDLE_WAKE_GRACE_MS) elapses — the pass that observed it ran while
    // its activity was still fresh and correctly suppressed the wake. This
    // periodic tick re-runs the pass so a genuinely-idle child is still woken
    // once its grace passes. Passes are idempotent (receipt + handled-set dedup),
    // so the extra runs are harmless. Mirrors the liveness sweep's spaced
    // schedule.
    yield* Effect.forkScoped(
      worker
        .enqueue()
        .pipe(Effect.repeat(Schedule.spaced(Duration.millis(IDLE_WAKE_REPASS_INTERVAL_MS)))),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies WorkstreamDispatcherShape;
});

export const WorkstreamDispatcherLive = Layer.effect(WorkstreamDispatcher, make);
