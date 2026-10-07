/**
 * Loom's decider arm on V2's orchestrator (plans/upstream-pull9-phase2-substrate/plan.mdx
 * §2–§3, amended by docs/upstream-sync/30-cadence-pull-9-phase2.md DL-194–197, DL-202,
 * DL-211, DL-224+).
 *
 * THE RULE. The arm writes only to the commanded thread and the threads it
 * creates in the same command (sibling-graph edits under the parent's lock,
 * DL-202, write their children's sidecar rows). Every effect on another thread
 * is a decision event on the commanded thread that the re-drive planner turns
 * into its own per-thread command. `nested` exposes exactly three same-thread
 * upstream dispatchers; the arm never takes a lock.
 *
 * MODULE CYCLE. `Orchestrator.ts` value-imports this file (its error union
 * holds `LoomDispatchDeferredError` at module init), so this file never
 * value-imports `Orchestrator.ts`: upstream's error constructor and dispatchers
 * arrive through `LoomArmContext`.
 *
 * @module orchestration-v2/Orchestrator.loom
 */
import {
  CommandId,
  type LoomAttentionReason,
  type LoomCommand,
  type LoomDomainEvent,
  type LoomEventType,
  type LoomMessageFields,
  type LoomOutcomeSetCause,
  type LoomThreadWorkstream,
  latestProviderTurnForAttempt,
  LOOM_ASK_REQUEST_PREFIX,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  RESERVED_OUTCOMES,
  ThreadId,
  type WorkstreamRoute,
} from "@t3tools/contracts";
import {
  describeUnsatisfiedDependency,
  findDependencyCycle,
} from "@t3tools/shared/workstreamDependencies";
import {
  descendantsOf,
  gateSourceFor,
  holdErasedByCompletion,
  routeWorkSubmit,
} from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { LoomStoreV2 } from "../loom/projection/LoomStore.ts";
import { LoomAskWaiters } from "../loom/userInput/askWaiters.ts";
import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";
import type { IdAllocatorV2 } from "./IdAllocator.ts";
import type { OrchestratorDispatchError, OrchestratorV2Error } from "./Orchestrator.ts";
import type { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { isForkableSourceRunStatus, type ThreadForkServiceV2 } from "./ThreadForkService.ts";

/**
 * A Loom dispatch that cannot apply YET and will apply later without anyone
 * changing the target. Never receipted (`dispatchWithReceiptEffect` passes it
 * through), so the same deterministic `server:` id is redeliverable. Raised at
 * exactly three sites: a busy `start_if_idle` (Orchestrator.ts dispatchMessage),
 * a gate leg behind a blocking run with a pending merge-back (`gateLeg` below),
 * and `thread.fork.prepare` while its source runs (`forkPrepare` below).
 */
export class LoomDispatchDeferredError extends Schema.TaggedError<LoomDispatchDeferredError>()(
  "LoomDispatchDeferredError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    threadId: ThreadId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandType} (${this.commandId}) deferred on thread ${this.threadId}: ${this.reason}.`;
  }
}

type MessageDispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type RunInterrupt = Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>;
type QueuedRunCancel = Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>;
type CommandOf<T extends LoomCommand["type"]> = Extract<LoomCommand, { readonly type: T }>;
type LoomEventOf<T extends LoomEventType> = Extract<LoomDomainEvent, { readonly type: T }>;
type CancelUnsettledEffects = {
  readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
  readonly reason: string;
};
/** Upstream's `mapDispatchError(command)`: any failure becomes this command's receipted `OrchestratorDispatchError`. */
type ToDispatchError = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, OrchestratorDispatchError, R>;
type Emit = <Event extends OrchestrationV2DomainEvent>(
  event: Omit<Event, "id">,
) => Effect.Effect<Event, OrchestratorDispatchError>;

/** What `dispatchOnce`'s guard arm hands the arm; see the module note on the cycle. */
export interface LoomArmContext {
  readonly command: LoomCommand;
  readonly emit: Emit;
  readonly toDispatchError: ToDispatchError;
  readonly loomStore: LoomStoreV2["Service"];
  readonly projectionStore: ProjectionStoreV2["Service"];
  readonly idAllocator: IdAllocatorV2["Service"];
  readonly threadForkService: ThreadForkServiceV2["Service"];
  /** Same-thread upstream dispatchers only (the commanded thread). */
  readonly nested: {
    readonly dispatchMessage: (
      command: MessageDispatch,
    ) => Effect.Effect<void, OrchestratorV2Error>;
    readonly dispatchRunInterrupt: (
      command: RunInterrupt,
    ) => Effect.Effect<CancelUnsettledEffects | undefined, OrchestratorV2Error>;
    readonly dispatchQueuedRunCancel: (
      command: QueuedRunCancel,
    ) => Effect.Effect<void, OrchestratorV2Error>;
  };
}

const loomEvent = <T extends LoomEventType>(
  type: T,
  threadId: ThreadId,
  occurredAt: DateTime.Utc,
  payload: LoomEventOf<T>["payload"],
) => ({ type, threadId, occurredAt, payload }) as unknown as Omit<LoomEventOf<T>, "id">;

// A copy of upstream's non-exported `isBlockingRun` (one rule; no upstream hunk to export it).
const isBlockingRun = (run: Pick<OrchestrationV2Run, "status">) =>
  run.status === "preparing" ||
  run.status === "starting" ||
  run.status === "running" ||
  run.status === "waiting";

const isServerCommand = (command: { readonly commandId: string }) =>
  command.commandId.startsWith("server:");

/** The re-drive planner's cancel-cascade id prefix; its outcome writes carry cause `cascade`. */
export const LOOM_CASCADE_CANCEL_PREFIX = "server:loom:cascade-cancel:";

const asNode = (row: LoomThreadWorkstream) => ({ ...row, id: row.threadId });
const sameSet = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  new Set(left).size === new Set(right).size && left.every((entry) => right.includes(entry));
const loopTargetsOf = (routes: ReadonlyArray<WorkstreamRoute>) =>
  routes.flatMap((route) => (route.kind === "loop" && route.to !== undefined ? [route.to] : []));
const UUID_SHAPED = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// mcp__t3-code__notify_thread's ordered-pair cap (V1 `@t3tools/shared/notify`, quarantined until 3a).
export const NOTIFY_PAIR_HOURLY_CAP = 10;
export const NOTIFY_PAIR_WINDOW_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The dispatchMessage helpers (DL-194, DL-195, §2 rules 1–5)
// ---------------------------------------------------------------------------

/**
 * DL-194, DL-245: the one human predicate. Upstream's `limit-resume` (createdBy
 * user + continuation) and a scheduled-task fire (the task's `createdBy`) are
 * automation, not a person.
 */
export const isHumanAuthored = (
  command: Pick<MessageDispatch, "createdBy" | "usageLimitContinuationOfRunId" | "scheduledTaskId">,
) =>
  command.createdBy === "user" &&
  command.usageLimitContinuationOfRunId === undefined &&
  command.scheduledTaskId === undefined;

/**
 * The `loom` field carried onto the message record: the client's fields with
 * `humanAuthored` OVERWRITTEN by the server's predicate, so a client cannot
 * forge a human turn. Computed once per `dispatchMessage`.
 */
export const loomMessageFields = (
  command: Pick<
    MessageDispatch,
    "createdBy" | "usageLimitContinuationOfRunId" | "scheduledTaskId" | "loom"
  >,
): LoomMessageFields => ({ ...command.loom, humanAuthored: isHumanAuthored(command) });

/** Rule 4's clearing origins: a human, or the parent's `mcp__t3-code__workstream_prompt`. */
export const loomClearsAttention = (loom: LoomMessageFields | undefined) =>
  loom?.humanAuthored === true || loom?.origin === "orchestrator";

/**
 * Rule 0 (DL-195): a restart or usage-limit continuation of a Loom thread that
 * is not continued — terminal, archived, deleted, owed a human, or holding an
 * open runtime request. The caller turns it into upstream's accepted no-op.
 */
export const loomContinuationVetoed = (
  workstream: LoomThreadWorkstream | null,
  pendingRuntimeRequest: boolean,
) =>
  workstream !== null &&
  (workstream.outcome !== null ||
    workstream.archivedAt !== null ||
    workstream.deletedAt !== null ||
    workstream.attention.includes("needs_guidance") ||
    workstream.attention.includes("awaiting_acceptance") ||
    pendingRuntimeRequest);

/** The attention clear for a queued message whose turn starts now (startNextQueuedRun, promote-to-steer). */
export const loomQueuedTurnAttentionClear = (
  loomStore: LoomStoreV2["Service"],
  threadId: ThreadId,
  loom: LoomMessageFields | undefined,
  occurredAt: DateTime.Utc,
) =>
  Effect.gen(function* () {
    if (!loomClearsAttention(loom)) return [];
    const workstream = yield* loomStore.getWorkstream(threadId);
    return workstream === null || workstream.attention.length === 0
      ? []
      : [loomEvent("thread.attention-cleared", threadId, occurredAt, {})];
  });

/**
 * The target thread's own rules for an accepted message (§2 rules 1–5; rule 0 is
 * `loomContinuationVetoed`, placed before upstream's unsettle per DL-195; rule 6
 * supersede is post-commit, in `loom/userInput/askUserQuestion.ts`). Called once
 * the delivery mode is final, so `startsNow` covers upstream's and the Loom
 * steer conversions. Emits only on `command.threadId`.
 */
export const loomTurnStartRules = Effect.fn("loom.turnStartRules")(function* (input: {
  readonly command: MessageDispatch;
  readonly loom: LoomMessageFields;
  readonly workstream: LoomThreadWorkstream;
  readonly startsNow: boolean;
  readonly loomStore: LoomStoreV2["Service"];
  readonly emit: Emit;
  readonly toDispatchError: ToDispatchError;
}) {
  const { command, loom, workstream, emit } = input;
  const fail = (cause: string) => input.toDispatchError(Effect.fail(cause));
  // 1. A dead target fails once.
  if (workstream.deletedAt !== null || workstream.archivedAt !== null) {
    return yield* fail(
      `Thread ${command.threadId} is ${workstream.deletedAt !== null ? "deleted" : "archived"}.`,
    );
  }
  const now = yield* DateTime.now;
  if (workstream.kickoffAt === null) {
    // 2. First-turn dependency gate (DL-211: archived siblings count, deleted ones do not).
    if (workstream.parentThreadId !== null && workstream.blockedBy.length > 0) {
      const siblings = yield* input.loomStore
        .listChildren(workstream.parentThreadId, { includeArchived: true })
        .pipe(input.toDispatchError);
      const unsatisfied = describeUnsatisfiedDependency(
        asNode(workstream),
        new Map(siblings.map((row) => [row.threadId, asNode(row)])),
      );
      if (unsatisfied !== null) {
        return yield* fail(`Thread ${command.threadId} cannot start: ${unsatisfied}.`);
      }
    }
    // 3. Acting on a held node is the release; a control-plane message never starts one.
    if (workstream.held) {
      if (loom.origin !== undefined) {
        return yield* fail(
          `Thread ${command.threadId} is held; a control-plane message cannot start it.`,
        );
      }
      if (loom.humanAuthored === true) {
        yield* emit(loomEvent("thread.held-set", command.threadId, now, { held: false }));
      }
    }
  }
  // 4. Attention clears when a human's or the parent's turn starts or steers now.
  if (input.startsNow && loomClearsAttention(loom) && workstream.attention.length > 0) {
    yield* emit(loomEvent("thread.attention-cleared", command.threadId, now, {}));
  }
  // 5. The first turn by anyone is the start.
  if (workstream.kickoffAt === null) {
    yield* emit(
      loomEvent("thread.kickoff-recorded", command.threadId, now, {
        kickoffAt: DateTime.formatIso(now),
        messageId: command.messageId,
        origin: loom.origin ?? (loom.humanAuthored === true ? "user" : "other"),
      }),
    );
  }
  // 6. Supersede runs post-commit: the ask reactor (loom/userInput/askUserQuestion.ts) dismisses a
  //    pending loom-ask: request when a human message lands, for row-less roots too (DL-348).
});

/**
 * The `runtime-request.respond` hunk's test (P3-21, DL-347): a `loom-ask:`
 * request whose `mcp__t3-code__ask_user_question` call is still polling takes the answer as
 * its tool result, so upstream's answer message is withheld. With no live
 * waiter (pi died, the server restarted) upstream's message delivery stands.
 */
export const loomAskTakesAnswer = (requestId: string) =>
  Effect.gen(function* () {
    if (!requestId.startsWith(LOOM_ASK_REQUEST_PREFIX)) return false;
    return yield* (yield* LoomAskWaiters).isLive(requestId);
  });

// ---------------------------------------------------------------------------
// run.interrupt and thread.auto-settle hunks
// ---------------------------------------------------------------------------

/** A human stop (non-`server:` run.interrupt or thread.stop) on a live Loom thread raises needs_guidance. */
export const loomHumanStopRaise = Effect.fn("loom.humanStopRaise")(function* (input: {
  readonly command: RunInterrupt;
  readonly loomStore: LoomStoreV2["Service"];
  readonly emit: Emit;
  readonly toDispatchError: ToDispatchError;
}) {
  if (isServerCommand(input.command)) return;
  const workstream = yield* input.loomStore
    .getWorkstream(input.command.threadId)
    .pipe(input.toDispatchError);
  if (workstream === null || workstream.outcome !== null) return;
  if (workstream.attention.includes("needs_guidance")) return;
  yield* input.emit(
    loomEvent("thread.attention-raised", input.command.threadId, yield* DateTime.now, {
      reason: "needs_guidance",
    }),
  );
});

/**
 * Settlement view of a Loom thread: `blocker` (why it must not settle — the
 * parent owes it a turn, or a live descendant is unfinished) and
 * `finishedRootAt` (a root with an outcome settles at its outcome time).
 */
export const loomSettleBlockers = Effect.fn("loom.settleBlockers")(function* (
  loomStore: LoomStoreV2["Service"],
  threadId: ThreadId,
) {
  const workstream = yield* loomStore.getWorkstream(threadId);
  if (workstream === null) return { blocker: null, finishedRootAt: null };
  if (workstream.attention.includes("awaiting_orchestrator")) {
    return { blocker: `Thread ${threadId} is awaiting its orchestrator.`, finishedRootAt: null };
  }
  const unfinished = descendantsOf(
    threadId,
    (yield* loomStore.listWorkstreamTree(workstream.rootThreadId)).map(asNode),
  ).find((row) => row.outcome === null && row.archivedAt === null);
  if (unfinished !== undefined) {
    return {
      blocker: `Thread ${threadId} has an unfinished sub-thread ${unfinished.threadId}.`,
      finishedRootAt: null,
    };
  }
  return {
    blocker: null,
    finishedRootAt:
      workstream.parentThreadId === null &&
      workstream.outcome !== null &&
      workstream.outcomeAt !== null
        ? DateTime.makeUnsafe(workstream.outcomeAt)
        : null,
  };
});

// ---------------------------------------------------------------------------
// Child threads (D6, D7)
// ---------------------------------------------------------------------------

/**
 * A Loom child's (or staged root's) V2 thread row from an explicit field list —
 * never a spread of the parent (which would carry pins, order keys, limit
 * recovery, rollback state and PR links). `forkedFrom: null` keeps upstream's
 * delegated-task finalisation away from Loom children (D7).
 */
export const makeLoomChildThread = (input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly modelSelection: OrchestrationV2AppThread["modelSelection"];
  readonly createdBy: OrchestrationV2AppThread["createdBy"];
  readonly creationSource: OrchestrationV2AppThread["creationSource"];
  /** The parent's row; null for a staged root, which takes `root` instead. */
  readonly parent: OrchestrationV2AppThread | null;
  readonly root: Pick<
    OrchestrationV2AppThread,
    "projectId" | "runtimeMode" | "interactionMode" | "branch" | "worktreePath"
  >;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread => {
  const shared = input.parent ?? input.root;
  return {
    createdBy: input.createdBy,
    creationSource: input.creationSource,
    id: input.id,
    projectId: shared.projectId,
    title: input.title,
    providerInstanceId: input.modelSelection.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: shared.runtimeMode,
    interactionMode: shared.interactionMode,
    branch: shared.branch,
    worktreePath: shared.worktreePath,
    activeProviderThreadId: null,
    lineage:
      input.parent === null
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.id }
        : {
            parentThreadId: input.parent.id,
            relationshipToParent: "subagent",
            rootThreadId: input.parent.lineage.rootThreadId,
          },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
};

// ---------------------------------------------------------------------------
// The arm
// ---------------------------------------------------------------------------

/** One graph node a spawn or scaffold creates, normalised for validation. */
interface NewNode {
  readonly threadId: ThreadId;
  readonly graphKey: string | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly routes: ReadonlyArray<WorkstreamRoute>;
}

export const decideLoomCommand = Effect.fn("loom.decideLoomCommand")(function* (
  ctx: LoomArmContext,
): Effect.fn.Return<
  { readonly cancelUnsettledEffects?: CancelUnsettledEffects },
  OrchestratorV2Error
> {
  const { command, emit, loomStore, projectionStore } = ctx;
  const fail = (cause: string) => ctx.toDispatchError(Effect.fail(cause));
  const read = ctx.toDispatchError;
  const now = yield* DateTime.now;
  const on = <T extends LoomEventType>(
    type: T,
    threadId: ThreadId,
    payload: LoomEventOf<T>["payload"],
  ) => emit(loomEvent(type, threadId, now, payload));
  const workstreamOf = (threadId: ThreadId) => read(loomStore.getWorkstream(threadId));
  const requireWorkstream = (threadId: ThreadId) =>
    Effect.flatMap(workstreamOf(threadId), (row) =>
      row === null ? fail(`Thread ${threadId} has no workstream record.`) : Effect.succeed(row),
    );
  const requireThread = (threadId: ThreadId) =>
    Effect.flatMap(read(projectionStore.getThreadShell(threadId)), (shell) =>
      shell === null
        ? fail(`Thread ${threadId} does not exist.`)
        : read(projectionStore.getThread(threadId)),
    );
  const clearAttention = (row: LoomThreadWorkstream) =>
    row.attention.length > 0 ? on("thread.attention-cleared", row.threadId, {}) : Effect.void;
  const setOutcome = (
    threadId: ThreadId,
    outcome: LoomThreadWorkstream["outcome"],
    cause: LoomOutcomeSetCause,
  ) => on("thread.outcome-set", threadId, { outcome, cause });
  const warnStartedDependents = (row: LoomThreadWorkstream) =>
    Effect.gen(function* () {
      if (row.parentThreadId === null) return;
      const started = (yield* read(loomStore.listChildren(row.parentThreadId)))
        .filter((sibling) => sibling.blockedBy.includes(row.threadId) && sibling.kickoffAt !== null)
        .map((sibling) => sibling.threadId);
      if (started.length > 0) {
        yield* on("thread.gate-warning", row.threadId, {
          kind: "reopened-with-started-dependents",
          detail: `Thread ${row.threadId} reopened after dependents started (${started.join(", ")}).`,
          threadIds: started,
        });
      }
    });

  /**
   * Validates nodes a spawn or scaffold creates under `parentThreadId`, against
   * the live siblings and each other (all-or-nothing). Graph keys are checked
   * against EVERY child — the unique index spans archived and deleted rows
   * (DL-223) — so a reused key is a clean refusal, not a failed commit.
   */
  const validateNewNodes = (parentThreadId: ThreadId | null, nodes: ReadonlyArray<NewNode>) =>
    Effect.gen(function* () {
      const reserved = nodes.flatMap((node) =>
        node.routes.flatMap((route) =>
          route.on.filter((entry) => (RESERVED_OUTCOMES as ReadonlyArray<string>).includes(entry)),
        ),
      );
      if (reserved.length > 0) {
        return yield* fail(`A route may not trigger on the reserved outcome '${reserved[0]}'.`);
      }
      const batchIds = new Set<ThreadId>();
      const batchKeys = new Set<string>();
      for (const node of nodes) {
        if (batchIds.has(node.threadId))
          return yield* fail(`Thread id ${node.threadId} appears twice.`);
        if ((yield* read(projectionStore.getThreadShell(node.threadId))) !== null) {
          return yield* fail(`Thread ${node.threadId} already exists.`);
        }
        batchIds.add(node.threadId);
        if (node.graphKey === null) continue;
        if (UUID_SHAPED.test(node.graphKey)) {
          return yield* fail(`Graph key '${node.graphKey}' is UUID-shaped; keys are symbolic.`);
        }
        if (batchKeys.has(node.graphKey))
          return yield* fail(`Graph key '${node.graphKey}' appears twice.`);
        batchKeys.add(node.graphKey);
      }
      if (parentThreadId === null) {
        if (
          nodes.some(
            (node) =>
              node.blockedBy.length > 0 || node.routes.some((route) => route.to !== undefined),
          )
        ) {
          return yield* fail("A root thread has no siblings to depend on or route to.");
        }
        return;
      }
      const children = yield* read(
        loomStore.listChildren(parentThreadId, { includeArchived: true, includeDeleted: true }),
      );
      const usedKey = children.find(
        (child) => child.graphKey !== null && batchKeys.has(child.graphKey),
      );
      if (usedKey !== undefined) {
        return yield* fail(
          `Graph key '${usedKey.graphKey}' is already used by ${usedKey.threadId}; keys are unique per parent.`,
        );
      }
      const live = children.filter(
        (child) => child.archivedAt === null && child.deletedAt === null,
      );
      const liveIds = new Set(live.map((child) => child.threadId));
      for (const node of nodes) {
        for (const ref of [...node.blockedBy, ...loopTargetsOf(node.routes)]) {
          if (ref === node.threadId)
            return yield* fail(`Thread ${node.threadId} cannot depend on or route to itself.`);
          if (!batchIds.has(ref) && !liveIds.has(ref)) {
            return yield* fail(
              `Thread ${node.threadId} references ${ref}, which is not a live sibling.`,
            );
          }
        }
      }
      const cycle = findDependencyCycle([
        ...live.map((child) => ({
          id: child.threadId,
          parentThreadId,
          blockedBy: child.blockedBy,
        })),
        ...nodes.map((node) => ({ id: node.threadId, parentThreadId, blockedBy: node.blockedBy })),
      ]);
      if (cycle !== null)
        return yield* fail(`Dependencies would form a cycle (${cycle.join(" → ")}).`);
    });

  /**
   * The parent of a spawn/scaffold: its V2 row, and its sidecar — created in
   * this command when absent, so cancel cascades and tree reads start from it
   * (consult_manager, plan author, medium).
   */
  const parentFor = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      const parent = yield* requireThread(parentThreadId);
      if (parent.archivedAt !== null || parent.deletedAt !== null) {
        return yield* fail(
          `Parent thread ${parentThreadId} is ${parent.deletedAt !== null ? "deleted" : "archived"}.`,
        );
      }
      return { parent, parentWorkstream: yield* workstreamOf(parentThreadId) };
    });
  const ensureParentRow = (parent: OrchestrationV2AppThread, row: LoomThreadWorkstream | null) =>
    row !== null
      ? Effect.void
      : on("thread.workstream-created", parent.id, {
          parentThreadId: parent.lineage.parentThreadId,
          rootThreadId: parent.lineage.rootThreadId,
          projectId: parent.projectId,
          goalId: null,
          anchorTaskId: null,
          role: null,
          purpose: null,
          graphKey: null,
          kickoffBriefPath: null,
          held: false,
          blockedBy: [],
          routes: [],
          spawnGeneration: null,
          forkFromThreadId: null,
          continuesThreadId: null,
        });

  // -------------------------------------------------------------------------
  // Multi-step cases
  // -------------------------------------------------------------------------

  const workSubmit = (submit: CommandOf<"thread.work.submit">) =>
    Effect.gen(function* () {
      const row = yield* requireWorkstream(submit.threadId);
      const outcome = submit.outcome ?? "done";
      const synthesised = (RESERVED_OUTCOMES as ReadonlyArray<string>).includes(outcome);
      if (synthesised && !isServerCommand(submit)) {
        return yield* fail(`Outcome '${outcome}' is reserved for the server.`);
      }
      const tree = (yield* read(loomStore.listWorkstreamTree(row.rootThreadId))).map(asNode);
      const routing = routeWorkSubmit(asNode(row), tree, outcome);
      if (
        row.outcome !== null &&
        !(row.outcome === "done" && row.pendingRework && routing.decision === "loop")
      ) {
        return yield* fail(
          `Thread ${submit.threadId} is ${row.outcome}; mcp__t3-code__workstream_submit cannot act on a terminal thread.`,
        );
      }
      const erased = holdErasedByCompletion({
        attention: row.attention,
        decision: routing.decision,
      });
      if (erased !== null) {
        return yield* fail(
          `Thread ${submit.threadId} holds '${erased}'; completing would erase the hold. Yield with a non-done outcome instead.`,
        );
      }
      yield* on("thread.report-set", submit.threadId, { reportPath: submit.reportPath });
      yield* on("thread.outcome-recorded", submit.threadId, {
        outcome,
        decision: routing.decision,
        round: routing.round,
        ...(submit.contested === undefined ? {} : { contested: submit.contested }),
        ...(submit.counts === undefined ? {} : { counts: submit.counts }),
        ...(synthesised ? { synthesised: true } : {}),
      });
      switch (routing.decision) {
        case "terminal":
        case "resolve":
          yield* setOutcome(submit.threadId, "done", "submit");
          yield* clearAttention(row);
          if (routing.resolveWith !== null) {
            yield* on("thread.route-taken", submit.threadId, {
              to: routing.resolveWith,
              round: routing.round,
              kind: "resolve",
            });
          }
          return;
        case "loop": {
          // A source's own loop route, or an intercepted target routing back to its source.
          const ownLoop = row.routes.some(
            (route) => route.kind === "loop" && route.on.includes(outcome),
          );
          yield* on("thread.route-taken", submit.threadId, {
            to: routing.routeTo!,
            round: routing.round,
            kind: ownLoop ? "loop" : "loop-back",
          });
          return;
        }
        case "attention":
          if (!row.attention.includes("needs_guidance")) {
            yield* on("thread.attention-raised", submit.threadId, { reason: "needs_guidance" });
          }
          return;
        case "yield":
        case "cap-breach":
          if (!row.attention.includes("awaiting_orchestrator")) {
            yield* on("thread.attention-raised", submit.threadId, {
              reason: "awaiting_orchestrator",
            });
          }
          return;
      }
    });

  /** A gate leg's target: live, not cancelled, and named by the source's current route episode. */
  const gateTarget = (
    leg: CommandOf<"thread.gate.rework" | "thread.gate.reverify" | "thread.gate.resolve">,
  ) =>
    Effect.gen(function* () {
      const row = yield* requireWorkstream(leg.threadId);
      if (row.outcome === "cancelled") return yield* fail(`Thread ${leg.threadId} is cancelled.`);
      if (row.archivedAt !== null || row.deletedAt !== null) {
        return yield* fail(
          `Thread ${leg.threadId} is ${row.deletedAt !== null ? "deleted" : "archived"}.`,
        );
      }
      const route = (yield* workstreamOf(leg.sourceThreadId))?.lastRoute ?? null;
      if (route?.eventId !== leg.routeEventId || route.to !== leg.threadId) {
        return yield* fail(
          `Gate leg ${leg.commandId} is stale: ${leg.sourceThreadId}'s current route is not ${leg.routeEventId}.`,
        );
      }
      return row;
    });

  const gateLeg = (leg: CommandOf<"thread.gate.rework" | "thread.gate.reverify">) =>
    Effect.gen(function* () {
      const row = yield* gateTarget(leg);
      const projection = yield* read(
        projectionStore.getThreadRecords(leg.threadId, ["runs", "contextTransfers"]),
      );
      // Deferral site 2: upstream refuses queued dispatch while a merge-back is pending
      // ("queued merge-back consumption is not implemented yet"); the run will end.
      if (
        projection.runs.some(isBlockingRun) &&
        projection.contextTransfers.some(
          (transfer) =>
            transfer.type === "merge_back" &&
            transfer.targetThreadId === leg.threadId &&
            transfer.status === "pending",
        )
      ) {
        return yield* new LoomDispatchDeferredError({
          commandId: leg.commandId,
          commandType: leg.type,
          threadId: leg.threadId,
          reason: "a blocking run with a pending merge-back transfer",
        });
      }
      if (leg.type === "thread.gate.rework") {
        if (row.outcome === "done") yield* setOutcome(leg.threadId, null, "gate-reopen");
        yield* on("thread.gate-rework-accepted", leg.threadId, {
          sourceThreadId: leg.sourceThreadId,
          round: leg.round,
        });
        if (row.outcome === "done") yield* warnStartedDependents(row);
      }
      yield* ctx.nested.dispatchMessage({
        type: "message.dispatch",
        commandId: leg.commandId,
        threadId: leg.threadId,
        messageId: leg.message.messageId,
        text: leg.message.text,
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        loom: { origin: "control_notice", controlPayload: leg.message.controlPayload },
        notification: {
          source: { kind: "background_task" },
          outcome: "updated",
          summary:
            leg.message.controlPayload.heading ??
            (leg.type === "thread.gate.rework"
              ? "Review gate: rework requested"
              : "Review gate: re-verify"),
        },
      });
    });

  const forkPrepare = (prepare: CommandOf<"thread.fork.prepare">) =>
    Effect.gen(function* () {
      yield* requireThread(prepare.threadId);
      const child = yield* read(
        projectionStore.getThreadRecords(prepare.threadId, ["contextTransfers"]),
      );
      if (
        child.contextTransfers.some(
          (transfer) =>
            transfer.type === "fork" &&
            transfer.targetThreadId === prepare.threadId &&
            transfer.status !== "failed",
        )
      ) {
        return yield* fail(`Thread ${prepare.threadId} already has a fork transfer.`);
      }
      yield* requireThread(prepare.sourceThreadId);
      const source = yield* read(
        projectionStore.getThreadRecords(prepare.sourceThreadId, [
          "runs",
          "providerThreads",
          "providerTurns",
          "attempts",
        ]),
      );
      // Deferral site 3: the source's final session is not fixed until its run ends.
      if (source.runs.some(isBlockingRun)) {
        return yield* new LoomDispatchDeferredError({
          commandId: prepare.commandId,
          commandType: prepare.type,
          threadId: prepare.threadId,
          reason: `fork source ${prepare.sourceThreadId} is still running`,
        });
      }
      const sourceRun = source.runs
        .filter((run) => isForkableSourceRunStatus(run.status))
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (sourceRun === undefined)
        return yield* fail(`Fork source ${prepare.sourceThreadId} has no finished run.`);
      const providerThread = source.providerThreads.find(
        (entry) => entry.id === sourceRun.providerThreadId,
      );
      if (providerThread?.nativeThreadRef?.strength !== "strong") {
        return yield* fail(
          `Fork source ${prepare.sourceThreadId} has no strong native thread ref to fork.`,
        );
      }
      const providerTurn =
        source.providerTurns.find((turn) => turn.runAttemptId === sourceRun.activeAttemptId) ??
        source.providerTurns.find(
          (turn) =>
            turn.id ===
            source.attempts.find((attempt) => attempt.id === sourceRun.activeAttemptId)
              ?.providerTurnId,
        );
      const sourcePoint: OrchestrationV2ContextSourcePoint = {
        threadId: prepare.sourceThreadId,
        runId: sourceRun.id,
        ...(sourceRun.checkpointId === null ? {} : { checkpointId: sourceRun.checkpointId }),
        providerThreadRef: providerThread.nativeThreadRef,
        ...(providerTurn?.nativeTurnRef == null
          ? {}
          : { providerTurnRef: providerTurn.nativeTurnRef }),
      };
      const transferId = yield* read(
        ctx.idAllocator.allocate.contextTransfer({
          sourceThreadId: prepare.sourceThreadId,
          targetThreadId: prepare.threadId,
          type: "fork",
        }),
      );
      const { transfer } = yield* read(
        ctx.threadForkService.plan({
          sourceProjection: source,
          sourceRun,
          sourceProviderThread: providerThread,
          canonicalSourcePoint: sourcePoint,
          transferId,
          targetThreadId: prepare.threadId,
          createdBy: "agent",
          creationSource: "server",
          createdAt: now,
        }),
      );
      yield* emit({
        type: "context-transfer.created",
        threadId: prepare.threadId,
        providerInstanceId: sourceRun.providerInstanceId,
        occurredAt: now,
        payload: transfer,
      });
    });

  /**
   * `mcp__t3-code__ask_user_question`'s request (P3-26, DL-330–332): a pending `user_input`
   * runtime request on its own request node under the active run's root, with
   * the `user_input_request` turn item carrying the questions — the shapes
   * upstream's adapters emit, so V2's panel, mobile card and the shell's
   * `pendingRuntimeRequest` render it unchanged. `message` capability: upstream's
   * terminal dismissal leaves it standing; 3a-4's respond hunk answers it.
   */
  const runtimeRequestCreate = (create: CommandOf<"runtime-request.create">) =>
    Effect.gen(function* () {
      const { requestId, threadId } = create;
      if (!requestId.startsWith(LOOM_ASK_REQUEST_PREFIX)) {
        return yield* fail(`Runtime request ${requestId} is not a ${LOOM_ASK_REQUEST_PREFIX} id.`);
      }
      if (create.questions.length === 0) return yield* fail("A question request needs a question.");
      yield* requireThread(threadId);
      const projection = yield* read(
        projectionStore.getThreadRecords(threadId, [
          "runs",
          "attempts",
          "providerTurns",
          "runtimeRequests",
        ]),
      );
      const run = projection.runs
        .filter(isBlockingRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (run === undefined || run.rootNodeId === null) {
        return yield* fail(`Thread ${threadId} has no active run to ask from.`);
      }
      const pending = projection.runtimeRequests.find((request) => request.status === "pending");
      if (pending !== undefined) {
        return yield* fail(`Thread ${threadId} already has pending runtime request ${pending.id}.`);
      }
      // Upstream's `providerTurnForRun` (not exported): the active attempt's latest turn.
      const providerTurnId =
        (
          latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId) ??
          projection.providerTurns.find(
            (turn) =>
              turn.id ===
              projection.attempts.find((attempt) => attempt.id === run.activeAttemptId)
                ?.providerTurnId,
          )
        )?.id ?? null;
      const nodeId = ctx.idAllocator.derive.approvalNode({ requestId });
      const ordinal = yield* read(projectionStore.getNextTurnItemOrdinal(threadId));
      const base = {
        threadId,
        runId: run.id,
        nodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
      };
      yield* emit({
        ...base,
        type: "runtime-request.updated",
        payload: {
          id: requestId,
          nodeId,
          providerTurnId,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      yield* emit({
        ...base,
        type: "node.updated",
        payload: {
          id: nodeId,
          threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId,
          rootNodeId: run.rootNodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId: run.providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: requestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* emit({
        ...base,
        type: "turn-item.updated",
        payload: {
          id: ctx.idAllocator.derive.approvalTurnItem({ requestId }),
          threadId,
          runId: run.id,
          nodeId,
          providerThreadId: run.providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "waiting",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "user_input_request",
          requestId,
          questions: create.questions,
          responseMode: "message",
        },
      });
    });

  switch (command.type) {
    case "thread.spawn": {
      if (command.creationSource !== "mcp" && command.creationSource !== "server") {
        return yield* fail("Loom threads are created by the MCP layer or the server.");
      }
      const { parentThreadId } = command;
      const context = parentThreadId === null ? null : yield* parentFor(parentThreadId);
      const parentGoalId = context?.parentWorkstream?.goalId ?? null;
      // A child carries its parent's goal or none (the planner attaches it); a
      // staged root names a live goal of its project.
      if (context !== null && command.goalId !== null && command.goalId !== parentGoalId) {
        return yield* fail(`A child's goal must be its parent's (${parentGoalId ?? "none"}).`);
      }
      if (context === null && command.goalId !== null) {
        const goal = yield* read(loomStore.goals.get(command.goalId));
        if (goal === null || goal.deletedAt !== null || goal.projectId !== command.projectId) {
          return yield* fail(
            `Goal ${command.goalId} is not a live goal of project ${command.projectId}.`,
          );
        }
      }
      const node: NewNode = {
        threadId: command.threadId,
        graphKey: command.graphKey ?? null,
        blockedBy: command.blockedBy ?? [],
        routes: command.routes ?? [],
      };
      yield* validateNewNodes(parentThreadId, [node]);
      if (context !== null) yield* ensureParentRow(context.parent, context.parentWorkstream);
      const thread = makeLoomChildThread({
        id: command.threadId,
        title: command.title,
        modelSelection: command.modelSelection,
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        parent: context?.parent ?? null,
        root: command,
        now,
      });
      yield* emit({
        type: "thread.created",
        threadId: thread.id,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: thread,
      });
      yield* on("thread.workstream-created", thread.id, {
        parentThreadId,
        rootThreadId: thread.lineage.rootThreadId,
        projectId: thread.projectId,
        goalId: command.goalId,
        anchorTaskId: command.anchorTaskId ?? null,
        role: command.role,
        purpose: command.purpose,
        graphKey: node.graphKey,
        kickoffBriefPath: command.kickoffBriefPath ?? null,
        held: command.held ?? false,
        blockedBy: node.blockedBy,
        routes: node.routes,
        spawnGeneration: command.spawnGeneration ?? null,
        forkFromThreadId: command.forkFromThreadId ?? null,
        continuesThreadId: command.continuesThreadId ?? null,
      });
      return {};
    }

    case "thread.scaffold": {
      if (command.nodes.length === 0) return yield* fail("thread.scaffold carried no nodes.");
      const { parent, parentWorkstream } = yield* parentFor(command.threadId);
      yield* validateNewNodes(
        command.threadId,
        command.nodes.map((node) => ({
          threadId: node.threadId,
          graphKey: node.graphKey,
          blockedBy: node.blockedBy ?? [],
          routes: node.routes ?? [],
        })),
      );
      yield* ensureParentRow(parent, parentWorkstream);
      for (const node of command.nodes) {
        const thread = makeLoomChildThread({
          id: node.threadId,
          title: node.title,
          modelSelection: node.modelSelection,
          // Scaffold carries no creation fields: graphs are authored by an agent through MCP.
          createdBy: "agent",
          creationSource: "mcp",
          parent,
          root: parent,
          now,
        });
        yield* emit({
          type: "thread.created",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        });
        yield* on("thread.workstream-created", thread.id, {
          parentThreadId: parent.id,
          rootThreadId: thread.lineage.rootThreadId,
          projectId: thread.projectId,
          goalId: parentWorkstream?.goalId ?? null,
          anchorTaskId: node.anchorTaskId ?? null,
          role: node.role,
          purpose: node.purpose,
          graphKey: node.graphKey,
          kickoffBriefPath: null,
          held: node.held ?? command.held ?? false,
          blockedBy: node.blockedBy ?? [],
          routes: node.routes ?? [],
          spawnGeneration: node.spawnGeneration ?? null,
          forkFromThreadId: node.forkFromThreadId ?? null,
          continuesThreadId: null,
        });
      }
      return {};
    }

    case "thread.goal.set": {
      const thread = yield* requireThread(command.threadId);
      const row = yield* workstreamOf(command.threadId);
      if (command.goalId !== null) {
        const goal = yield* read(loomStore.goals.get(command.goalId));
        if (goal === null || goal.deletedAt !== null)
          return yield* fail(`Goal ${command.goalId} does not exist.`);
        if (goal.projectId !== thread.projectId) {
          return yield* fail(`Goal ${command.goalId} belongs to another project.`);
        }
      }
      const unchanged =
        (row?.goalId ?? null) === command.goalId &&
        (command.anchorTaskId === undefined ||
          command.anchorTaskId === (row?.anchorTaskId ?? null));
      if (unchanged) return {};
      yield* on("thread.goal-set", command.threadId, {
        goalId: command.goalId,
        ...(command.anchorTaskId === undefined ? {} : { anchorTaskId: command.anchorTaskId }),
      });
      return {};
    }

    case "thread.held.set": {
      const row = yield* requireWorkstream(command.threadId);
      if (row.outcome !== null) return yield* fail(`Thread ${command.threadId} is ${row.outcome}.`);
      if (row.held !== command.held)
        yield* on("thread.held-set", command.threadId, { held: command.held });
      return {};
    }

    case "thread.outcome.set": {
      const row = yield* requireWorkstream(command.threadId);
      if (row.outcome === command.outcome) return {};
      yield* setOutcome(
        command.threadId,
        command.outcome,
        command.commandId.startsWith(LOOM_CASCADE_CANCEL_PREFIX) ? "cascade" : "set",
      );
      yield* clearAttention(row);
      if (command.outcome === "done" && row.pendingRework) {
        const tree = (yield* read(loomStore.listWorkstreamTree(row.rootThreadId))).map(asNode);
        const source = gateSourceFor(command.threadId, tree);
        yield* on("thread.gate-warning", command.threadId, {
          kind: "target-done-mid-round",
          detail: `Thread ${command.threadId} was set done while its review round is open; the gate is not resolved.`,
          threadIds: source === null ? [command.threadId] : [command.threadId, source.threadId],
        });
      }
      if (command.outcome === null) {
        yield* warnStartedDependents(row);
        // A reopened thread is live work again: undo the settle its outcome caused, as
        // upstream's activity wake does (override back to automatic, so a later done re-settles).
        const thread = yield* requireThread(command.threadId);
        if (thread.settledOverride === "settled")
          yield* emit({
            type: "thread.unsettled",
            threadId: thread.id,
            providerInstanceId: thread.providerInstanceId,
            occurredAt: now,
            payload: {
              ...thread,
              settledOverride: null,
              settledAt: null,
              unsettledAt: now,
              updatedAt: now,
            },
          });
      }
      if (command.outcome !== "cancelled") return {};
      // The thread's own blocking run stops and its queued runs never start (DL-246);
      // descendants are re-driven (§4).
      const { runs } = yield* read(projectionStore.getThreadRecords(command.threadId, ["runs"]));
      const run = runs.find(isBlockingRun);
      const cancelUnsettledEffects =
        run === undefined
          ? undefined
          : yield* ctx.nested
              .dispatchRunInterrupt({
                type: "run.interrupt",
                commandId: command.commandId,
                threadId: command.threadId,
                runId: run.id,
                reason: "Workstream thread cancelled.",
                holdQueue: false,
              })
              .pipe(
                // Upstream rejects a run it cannot interrupt before emitting anything: skip, not fail.
                Effect.catchIf(
                  (error) =>
                    error._tag === "OrchestratorDispatchError" ||
                    error._tag === "OrchestratorProviderAdapterError",
                  () => Effect.succeed(undefined),
                ),
              );
      for (const queued of runs.filter((candidate) => candidate.status === "queued")) {
        yield* ctx.nested.dispatchQueuedRunCancel({
          type: "queued-run.cancel",
          commandId: command.commandId,
          threadId: command.threadId,
          runId: queued.id,
        });
      }
      return cancelUnsettledEffects === undefined ? {} : { cancelUnsettledEffects };
    }

    case "thread.attention.raise": {
      if (
        (command.reason === "error" || command.reason === "awaiting_orchestrator") &&
        !isServerCommand(command)
      ) {
        return yield* fail(`Attention '${command.reason}' is raised by the server only.`);
      }
      const row = yield* requireWorkstream(command.threadId);
      if (row.outcome !== null)
        return yield* fail(`Thread ${command.threadId} is ${row.outcome}; it cannot be flagged.`);
      if (!row.attention.includes(command.reason)) {
        yield* on("thread.attention-raised", command.threadId, { reason: command.reason });
      }
      return {};
    }

    case "thread.attention.clear": {
      const row = yield* requireWorkstream(command.threadId);
      const reason: LoomAttentionReason | undefined = command.reason;
      if (reason === undefined ? row.attention.length > 0 : row.attention.includes(reason)) {
        yield* on(
          "thread.attention-cleared",
          command.threadId,
          reason === undefined ? {} : { reason },
        );
      }
      return {};
    }

    case "thread.dependencies.set": {
      const row = yield* requireWorkstream(command.threadId);
      if (row.parentThreadId !== command.parentThreadId) {
        return yield* fail(
          `Thread ${command.threadId}'s parent is ${row.parentThreadId ?? "none"}, not ${command.parentThreadId}.`,
        );
      }
      if (command.blockedBy.length > 0) {
        if (command.blockedBy.includes(command.threadId))
          return yield* fail("A thread cannot depend on itself.");
        const live = (yield* read(loomStore.listChildren(command.parentThreadId))).filter(
          (child) => child.threadId !== command.threadId,
        );
        const liveIds = new Set(live.map((child) => child.threadId));
        const dangling = command.blockedBy.filter((id) => !liveIds.has(id));
        if (dangling.length > 0)
          return yield* fail(`Dependencies name non-sibling ids (${dangling.join(", ")}).`);
        const cycle = findDependencyCycle([
          {
            id: command.threadId,
            parentThreadId: command.parentThreadId,
            blockedBy: command.blockedBy,
          },
          ...live.map((child) => ({
            id: child.threadId,
            parentThreadId: command.parentThreadId,
            blockedBy: child.blockedBy,
          })),
        ]);
        if (cycle !== null)
          return yield* fail(`Dependencies would form a cycle (${cycle.join(" → ")}).`);
      }
      if (!sameSet(row.blockedBy, command.blockedBy)) {
        yield* on("thread.dependencies-set", command.threadId, { blockedBy: command.blockedBy });
      }
      return {};
    }

    case "thread.kickoff-brief.set": {
      const row = yield* requireWorkstream(command.threadId);
      if (row.kickoffAt !== null)
        return yield* fail(`Thread ${command.threadId} has started; its brief is fixed.`);
      if (row.kickoffBriefPath !== command.kickoffBriefPath) {
        yield* on("thread.kickoff-brief-set", command.threadId, {
          kickoffBriefPath: command.kickoffBriefPath,
        });
      }
      return {};
    }

    case "thread.work.submit":
      yield* workSubmit(command);
      return {};

    case "thread.gate.rework":
    case "thread.gate.reverify":
      yield* gateLeg(command);
      return {};

    case "thread.gate.resolve": {
      const row = yield* gateTarget(command);
      if (row.outcome !== "done") yield* setOutcome(command.threadId, "done", "gate-resolve");
      yield* clearAttention(row);
      return {};
    }

    case "thread.consult.record":
      yield* requireThread(command.threadId);
      yield* on("thread.consult-recorded", command.threadId, {
        askerThreadId: command.threadId,
        targetThreadId: command.targetThreadId,
        targetTitle: command.targetTitle,
        question: command.question,
        answer: command.answer,
        resolved: command.resolved,
        durationMs: command.durationMs,
        ...(command.forkSessionPath === undefined
          ? {}
          : { forkSessionPath: command.forkSessionPath }),
        createdAt: command.createdAt,
      });
      return {};

    case "thread.peer-message.record": {
      yield* requireThread(command.threadId);
      const sender = yield* workstreamOf(command.threadId);
      const cutoff = Date.parse(command.createdAt) - NOTIFY_PAIR_WINDOW_MS;
      const sent = (sender?.notifySendLog ?? []).filter(
        (entry) =>
          entry.targetThreadId === command.targetThreadId && Date.parse(entry.at) >= cutoff,
      ).length;
      if (sent >= NOTIFY_PAIR_HOURLY_CAP) {
        return yield* fail(
          `mcp__t3-code__notify_thread rate cap reached: at most ${NOTIFY_PAIR_HOURLY_CAP} notifications per hour from ${command.threadId} to ${command.targetThreadId}. The recipient owes no reply; use mcp__t3-code__consult_thread if you need an answer.`,
        );
      }
      const target = yield* requireThread(command.targetThreadId);
      const targetRow = yield* workstreamOf(command.targetThreadId);
      if (
        target.archivedAt !== null ||
        target.deletedAt !== null ||
        (targetRow?.outcome ?? null) !== null
      ) {
        return yield* fail(
          `Thread ${command.targetThreadId} is finished or archived; it cannot be notified.`,
        );
      }
      yield* on("thread.peer-message-recorded", command.threadId, {
        senderThreadId: command.threadId,
        recordId: command.recordId,
        targetThreadId: command.targetThreadId,
        targetTitle: command.targetTitle,
        message: command.message,
        framedMessage: command.framedMessage,
        createdAt: command.createdAt,
      });
      return {};
    }

    case "thread.peer-message.mark-delivered":
    case "thread.peer-message.expire":
      if (!isServerCommand(command)) return yield* fail(`${command.type} is control-plane-only.`);
      yield* requireThread(command.threadId);
      yield* on(
        command.type === "thread.peer-message.mark-delivered"
          ? "thread.peer-message-delivered"
          : "thread.peer-message-expired",
        command.threadId,
        {
          senderThreadId: command.threadId,
          recordId: command.recordId,
          updatedAt: command.createdAt,
        },
      );
      return {};

    case "thread.handoff.record":
      yield* requireThread(command.threadId);
      yield* on("thread.handoff-recorded", command.threadId, {
        threadId: command.threadId,
        drafterThreadId: command.drafterThreadId,
        destinationGoalId: command.destinationGoalId,
        destinationThreadId: command.destinationThreadId,
        createdAt: command.createdAt,
      });
      return {};

    case "thread.fork.prepare":
      yield* forkPrepare(command);
      return {};

    case "runtime-request.create":
      yield* runtimeRequestCreate(command);
      return {};
  }
});
