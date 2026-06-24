import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type ThreadId,
  type ThreadStatus,
} from "@t3tools/contracts";
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
import { areDependenciesSatisfied } from "../workstreamDependencies.ts";
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

/**
 * A child is "terminal" for the join barrier when it has reached `done`,
 * `blocked`, or `review` — the three wake triggers (decision 2). `planned` and
 * `running` are non-terminal.
 */
const TERMINAL_STATUSES: ReadonlySet<ThreadStatus> = new Set(["done", "blocked", "review"]);
export const isTerminalStatus = (status: ThreadStatus): boolean => TERMINAL_STATUSES.has(status);

export interface JoinedGeneration {
  readonly parentId: ThreadId;
  readonly generation: string;
  readonly children: ReadonlyArray<OrchestrationThreadShell>;
}

/**
 * Pure generation-join selection (decision 1): group every non-archived,
 * non-deleted sub-thread by (parentThreadId, spawnGeneration) and return the
 * groups in which **every** member is terminal. The shell snapshot already
 * excludes archived/deleted threads, so membership is the active set.
 *
 * Eligibility is a pure function of durable thread state, so it is fully
 * recomputable from the read model after a restart (decision 4).
 */
export const selectJoinedGenerations = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ReadonlyArray<JoinedGeneration> => {
  const groups = new Map<
    string,
    { parentId: ThreadId; generation: string; children: OrchestrationThreadShell[] }
  >();
  for (const thread of threads) {
    if (thread.parentThreadId === null || thread.spawnGeneration === null) continue;
    const key = `${thread.parentThreadId}::${thread.spawnGeneration}`;
    const group = groups.get(key);
    if (group) group.children.push(thread);
    else
      groups.set(key, {
        parentId: thread.parentThreadId,
        generation: thread.spawnGeneration,
        children: [thread],
      });
  }
  return [...groups.values()].filter((group) =>
    group.children.every((child) => isTerminalStatus(child.status)),
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
    const trimmed = child.report?.trim() ?? "";
    const excerpt =
      trimmed.length === 0
        ? ""
        : trimmed.length > WAKE_REPORT_EXCERPT_LIMIT
          ? `\n\n${trimmed.slice(0, WAKE_REPORT_EXCERPT_LIMIT)}…\n\n_[excerpt truncated — read the full report via the reference above]_`
          : `\n\n${trimmed}`;
    return `${header}\n\n${reference}${excerpt}`;
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
// park dispatch a command under these ids, so their receipts are the durable,
// recomputable markers of "this generation was already handled" (decision 4):
// wake delivery is idempotent across restarts, and — critically — a parked
// generation leaves a durable marker too, so startup reconciliation does not
// re-deliver a previously-suppressed generation as a normal wake.
const wakeCommandId = (parentId: ThreadId, generation: string): string =>
  `server:workstream-notify:wake:${parentId}:${generation}`;
const parkCommandId = (parentId: ThreadId, generation: string): string =>
  `server:workstream-notify:park:${parentId}:${generation}`;

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

  // A (parent, generation) is durably handled iff its wake OR its park command
  // has an accepted receipt. Consulted before delivering so a restart between
  // "terminal" and "injected/parked", or after either, never re-fires.
  const isGenerationHandled = Effect.fn("isGenerationHandled")(function* (
    parentId: ThreadId,
    generation: string,
  ) {
    const key = `${parentId}::${generation}`;
    if (handledGenerations.has(key)) return true;
    const hasAccepted = (commandId: string) =>
      commandReceiptRepository
        .getByCommandId({ commandId: CommandId.make(commandId) })
        .pipe(Effect.map((receipt) => Option.isSome(receipt)));
    const handled =
      (yield* hasAccepted(wakeCommandId(parentId, generation))) ||
      (yield* hasAccepted(parkCommandId(parentId, generation)));
    if (handled) handledGenerations.add(key);
    return handled;
  });

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:workstream-dispatcher:${tag}:${uuid}`)),
    );

  const promoteThread = Effect.fn("promoteThread")(function* (thread: OrchestrationThreadShell) {
    const { role, purpose } = thread;
    // Guaranteed non-null by selectThreadsToDispatch; this also narrows types.
    if (role === null || purpose === null) return;
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("start-turn"),
      threadId: thread.id,
      message: {
        messageId: MessageId.make(yield* crypto.randomUUIDv4),
        role: "user",
        text: workstreamChildPrompt({ role, purpose }),
        attachments: [],
      },
      titleSeed: thread.title,
      runtimeMode: thread.runtimeMode,
      interactionMode: thread.interactionMode,
      createdAt: now,
    } satisfies OrchestrationCommand);

    // Land `running` in the same serialized pass so the next promote pass sees a
    // started thread and never double-starts it.
    yield* orchestrationEngine.dispatch({
      type: "thread.status.set",
      commandId: yield* serverCommandId("set-running"),
      threadId: thread.id,
      status: "running",
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
    generation: JoinedGeneration,
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

  // Park-and-escalate (decision 5): on a tripped rate guard, do not kill and do
  // not deliver — append an activity, set the parent `blocked` with a reason, and
  // surface it to the human (this is the stub for the future investigator agent).
  // Both commands carry deterministic per-(parent, generation) ids: the park
  // decision is durable, so startup reconciliation sees the park marker and does
  // not re-deliver the suppressed generation as a normal wake (decision 4). The
  // status-set is dispatched first; the park-marker activity last, so the
  // marker's presence implies both landed.
  const parkAndEscalate = Effect.fn("parkAndEscalate")(function* (
    parent: OrchestrationThreadShell,
    generation: string,
  ) {
    const now = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
    const summary =
      "Workstream wake rate guard tripped: this parent is being woken too frequently (likely a spawn spin-loop). Parked and escalated for human review.";
    yield* orchestrationEngine.dispatch({
      type: "thread.status.set",
      commandId: CommandId.make(`${parkCommandId(parent.id, generation)}:block`),
      threadId: parent.id,
      status: "blocked",
      createdAt: now,
    } satisfies OrchestrationCommand);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(parkCommandId(parent.id, generation)),
      threadId: parent.id,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "error",
        kind: "workstream.runaway-guard.tripped",
        summary,
        payload: { reason: "wake-rate-guard", generation },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    } satisfies OrchestrationCommand);
  });

  const wakeEligibleParents = Effect.fn("wakeEligibleParents")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const threadsById = new Map(snapshot.threads.map((thread) => [thread.id, thread] as const));
    const joined = selectJoinedGenerations(snapshot.threads);
    if (joined.length === 0) return;
    const pendingTurnStartThreadIds = yield* projectionSnapshotQuery.getPendingTurnStartThreadIds();

    for (const generation of joined) {
      const key = `${generation.parentId}::${generation.generation}`;
      // Durable idempotency (decision 4): consult the receipt-backed wake/park
      // markers, not just the in-memory cache, so a fresh process never
      // re-delivers a generation that was already woken or parked.
      if (yield* isGenerationHandled(generation.parentId, generation.generation)) continue;
      const parent = threadsById.get(generation.parentId);
      // Parent absent (archived/deleted) → nothing to wake.
      if (parent === undefined) continue;
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

  const runPassSafely = Effect.andThen(promoteReadyThreads(), wakeEligibleParents()).pipe(
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
