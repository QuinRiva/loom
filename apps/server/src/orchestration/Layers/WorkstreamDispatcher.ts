import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
  type ThreadStatus,
} from "@t3tools/contracts";
import { selectJoinedGenerations, type JoinedGeneration } from "@t3tools/shared/workstreamGraph";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
 * - Un-started: no provider session **and** no started turn (no user message).
 * - Deps satisfied: per the shared `areDependenciesSatisfied` predicate — every
 *   `blockedBy` entry that names a known sibling must be `done` (`review` does
 *   not release); self-refs, dangling ids, and non-siblings never gate. Sharing
 *   the predicate keeps execution gating and the client board in agreement.
 *
 * Returns only threads that carry both `role` and `purpose`, which are required
 * to build the deferred kick-off prompt (spawn always sets them).
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
 * which children completed (role + id + terminal status), for each a reference
 * to its on-disk report plus a BOUNDED excerpt (never the full report), and the
 * instruction to review, decide what needs human escalation vs. what it can act
 * on / accept on the human's behalf, and continue orchestrating (including
 * accepting `review` children).
 */
export const buildParentWakeMessage = (
  children: ReadonlyArray<{
    readonly id: ThreadId;
    readonly role: string | null;
    readonly status: ThreadStatus;
    readonly reportPath: string | null;
    readonly report: string | null;
  }>,
): string => {
  const sections = children.map((child) => {
    const header = `### ${child.role ?? "sub-thread"} \`${child.id}\` — ${child.status}`;
    const reference =
      child.reportPath !== null
        ? `Report reference: \`${child.reportPath}\` (read the full report on demand)`
        : "_No report was filed; status is the trigger, the report is best-effort context._";
    return `${header}\n\n${reference}${formatReportExcerpt(child.report)}`;
  });
  return [
    "A spawn generation of your Workstream sub-thread(s) has finished. Results:",
    "",
    sections.join("\n\n"),
    "",
    "Review these results. Decide what (if anything) genuinely warrants human escalation versus what you can act on or accept on the human's behalf. For any child in `review`, you are the first-pass reviewer: either accept it (set it to `done` with `workstream_set_status`, which releases its dependents) or escalate to the human when human review is genuinely warranted. Then continue orchestrating.",
  ].join("\n");
};

// Deterministic per-(parent, generation) command ids. Both the wake and the
// park dispatch commands under these ids, so their receipts are the durable,
// recomputable markers of "this generation was already handled" (decision 4):
// wake delivery is idempotent across restarts, and — critically — a parked
// generation leaves durable markers too, so startup reconciliation does not
// re-deliver a previously-suppressed generation as a normal wake.
//
// Park writes TWO durable receipts: the status.set (`parkBlockCommandId`,
// written FIRST) and the activity marker (`parkCommandId`, written second). The
// handled-check keys off the FIRST write (`parkBlockCommandId`), so a crash
// between the two writes can never resurface a parked generation as a normal
// wake (Fix B); the missing activity marker is reconciled on the next pass.
export const wakeCommandId = (parentId: ThreadId, generation: string): string =>
  `server:workstream-notify:wake:${parentId}:${generation}`;

/**
 * Per-child wake (D-liveness §1e). Both forgot-to-finish (idle + non-terminal)
 * and `error` children wake their parent through THIS rail, not the generation
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

export type ChildWakeKind = "error" | "idle";

/**
 * Pure per-child wake classification (§1e). Returns the wake kind for a child
 * that should wake its parent, or `null`:
 * - `error` — the liveness sweep set the child `error` (crash/stall/loop/cap).
 * - `idle`  — "forgot to finish": the child ran (has a session now `ready`/
 *   `stopped`) and went idle, but its status is still `planned`/`running`
 *   (terminal `done`/`blocked`/`review` are awaiting-human / done, not stuck).
 *
 * Idleness reuses the shared `isThreadIdle` predicate (no pending turn-start,
 * session not `running`, no active turn) so a freshly-promoted child mid-kickoff
 * is never mistaken for forgot-to-finish. A never-started `planned` child has no
 * session and is excluded (it is waiting on deps, not stuck).
 */
export const classifyChildWake = (
  child: OrchestrationThreadShell,
  pendingTurnStartThreadIds: ReadonlySet<ThreadId>,
): ChildWakeKind | null => {
  if (child.parentThreadId === null) return null;
  if (child.status === "error") return "error";
  if (
    (child.status === "planned" || child.status === "running") &&
    child.session !== null &&
    (child.session.status === "ready" || child.session.status === "stopped") &&
    isThreadIdle(child, pendingTurnStartThreadIds)
  ) {
    return "idle";
  }
  return null;
};

/**
 * Pure per-child wake-message builder. Tells the parent which child went
 * `error` / quiet, points at its on-disk report (with a bounded excerpt), and
 * instructs it to investigate via `workstream_read_thread`/`workstream_ask_thread`
 * then set the child's status (`done`/`error`) or re-dispatch.
 */
export const buildChildWakeMessage = (
  child: {
    readonly id: ThreadId;
    readonly role: string | null;
    readonly reportPath: string | null;
  },
  kind: ChildWakeKind,
  report: string | null,
): string => {
  const who = `${child.role ?? "sub-thread"} \`${child.id}\``;
  const lead =
    kind === "error"
      ? `Your Workstream sub-thread ${who} hit an \`error\` state (the liveness sweep detected it dead, stalled, looping, or repeatedly failing) and did not report success.`
      : `Your Workstream sub-thread ${who} went quiet without reporting: it finished its turn and is idle, but its status is still running (it never called \`workstream_set_status\`).`;
  const reference =
    child.reportPath !== null
      ? `Report reference: \`${child.reportPath}\` (read the full report on demand).`
      : "_No report was filed._";
  return [
    lead,
    "",
    reference + formatReportExcerpt(report),
    "",
    "Investigate with `workstream_read_thread` / `workstream_ask_thread`, then either set its status (`workstream_set_status` done/error) or re-dispatch it. Its dependents stay gated until you resolve this; nothing was auto-cascaded.",
  ].join("\n");
};
const parkCommandId = (parentId: ThreadId, generation: string): string =>
  `server:workstream-notify:park:${parentId}:${generation}`;
// The FIRST durable park write (the `blocked` status.set). The handled-check
// keys off this receipt, not the activity marker, to close the crash window.
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
 * marker — is the fix: a crash between the status.set and the marker leaves the
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
    // Atomic kickoff: `setRunning` makes the decider emit the `running`
    // status-set in the SAME command as the turn-start, so both events are
    // appended in one engine transaction. A crash can never leave the child with
    // a started turn but status stuck at `planned`, and the next promote pass
    // sees a started thread and never double-starts it.
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
      setRunning: true,
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
          status: child.status,
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
  // crash that landed the `blocked` status.set but not this marker (Fix B).
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
  // not deliver — set the parent `blocked` with a reason and surface it to the
  // human (the stub for the future investigator agent). The `blocked` status.set
  // (`parkBlockCommandId`) is dispatched FIRST and is the durable marker the
  // handled-check keys off; the activity marker follows. A crash between the two
  // leaves the generation parked (block receipt present) and is reconciled into
  // the marker on the next pass — never redelivered as a normal wake (Fix B).
  const parkAndEscalate = Effect.fn("parkAndEscalate")(function* (
    parent: OrchestrationThreadShell,
    generation: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.status.set",
      commandId: CommandId.make(parkBlockCommandId(parent.id, generation)),
      threadId: parent.id,
      status: "blocked",
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
      // off the FIRST park write (the `blocked` status.set), so a crash between
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
        // Reconcile a crash between the two park writes: the `blocked` status.set
        // landed but the activity marker did not. Append it rather than waking.
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
  // defers atomically at the command boundary, and the child's status is left
  // untouched (the parent decides done/error/re-dispatch).
  const deliverChildWake = Effect.fn("deliverChildWake")(function* (
    parent: OrchestrationThreadShell,
    child: OrchestrationThreadShell,
    kind: ChildWakeKind,
    commandId: string,
  ) {
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

  // Per-child wake pass (§1e): wake the parent of every `error` or
  // forgot-to-finish child through the shared rail, so a single failed/quiet
  // child is surfaced promptly (B1) even while its siblings still run — the
  // generation barrier (`wakeEligibleParents`) only fires once a WHOLE
  // generation is terminal. Shares `wakeTimestamps` + `parkAndEscalate` so
  // error/idle/generation-join wakes draw on ONE rate budget per parent (C1).
  const wakeIdleAndErroredChildren = Effect.fn("wakeIdleAndErroredChildren")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const child of snapshot.threads) {
      const kind = classifyChildWake(child, pendingTurnStartThreadIds);
      if (kind === null || child.parentThreadId === null) continue;
      // Top-level threads have no agent parent to wake; the board surfaces them
      // (error lane / activity) as escalate-to-human.
      const parent = threadsById.get(child.parentThreadId);
      if (parent === undefined) continue;

      // Episode key (C3): `error` fires once; idle keys on the child's max
      // activity sequence at idle onset (stable while idle → no re-nag; a
      // resumed-then-quiet child advances the sequence → re-arms).
      const episode =
        kind === "error"
          ? "error"
          : `idle:${(yield* projectionSnapshotQuery.getActivityFreshnessByThreadId(child.id)).maxSequence ?? "none"}`;
      const commandId = childWakeCommandId(child.id, episode);
      if (handledChildWakes.has(commandId)) continue;
      if (yield* hasAcceptedReceipt(commandId)) {
        handledChildWakes.add(commandId);
        continue;
      }

      // Busy parent → defer; a later thread.session-set re-triggers this pass.
      if (!isThreadIdle(parent, pendingTurnStartThreadIds)) continue;

      const now = yield* Clock.currentTimeMillis;
      const history = wakeTimestamps.get(parent.id) ?? [];
      if (wakeRateGuardTrips(history, now)) {
        yield* parkAndEscalate(parent, `child-wake:${child.id}`);
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
        event.type === "thread.status-set" ||
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
  });

  return {
    start,
    drain: worker.drain,
  } satisfies WorkstreamDispatcherShape;
});

export const WorkstreamDispatcherLive = Layer.effect(WorkstreamDispatcher, make);
