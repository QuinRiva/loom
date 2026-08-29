import {
  ApprovalRequestId,
  CommandId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type ProviderUserInputAnswers,
  type ThreadId,
  type UserInputResolvedOutcome,
  DEFAULT_THREAD_TITLE, // loom: §4 title provenance guard
  type TitleProvenance,
  canReplaceTitle, // loom: §4 title provenance guard
  titleProvenanceRank, // loom: §4 title provenance guard
  isLoomOrchestrationCommand, // loom:
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  listThreadsByProjectId,
  requireActiveProjectWorkspaceRootAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
} from "./commandInvariants.ts";
// loom: fork-owned invariant helpers still referenced by RETAINED upstream cases.
import {
  findGoalById,
  listGoalsByProjectId,
  requireActiveGoalInProject,
} from "./commandInvariants.loom.ts";
import { projectEvent } from "./projector.ts";
import { describeUnsatisfiedDependency } from "@t3tools/shared/workstreamDependencies";
import { openRequestIds, openUserInputRequestIds } from "@t3tools/shared/openRequests";
import {
  ALREADY_SETTLED_REJECTION_MARKER,
  userInputResolvedActivity,
} from "./userInputSettlement.ts";
// loom: subtreeOf powers collectLiveSubtreeIds (exported below) — the shared
// archive/delete subtree sweep reused by the fork sibling's cancel cascade.
import { subtreeOf } from "@t3tools/shared/workstreamGraph";
// loom: fork decider cases + the shared dependency coherence backstop live in
// the fork sibling. This is a deliberate module cycle (decider.loom.ts imports
// withEventBase/decideCommandSequence/PlannedOrchestrationEvent back from here);
// both directions are referenced only inside function bodies, never at init.
import { decideLoomCommand, dependencyCoherenceError } from "./decider.loom.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

// loom: §4 provenance a create/meta title write is stamped with when the caller
// left it unspecified. A bare "New thread" is `default` (freely replaceable by
// automation); any other explicit title write with no stated provenance is
// treated as `curated` — the conservative choice that automation may not clobber.
function resolveTitleProvenance(
  title: string | undefined,
  explicit: TitleProvenance | undefined,
): TitleProvenance | undefined {
  if (explicit !== undefined) return explicit;
  if (title === undefined) return undefined;
  return title.trim() === DEFAULT_THREAD_TITLE ? "default" : "curated";
}

// Session adoption takes seconds; a user message still unadopted after this
// window is a failed/stale start, not pending work. Mirrors the client's
// QUEUED_TURN_START_GRACE_MS in @t3tools/shared/threadSettled.
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

/**
 * APPROVALS only. Their clearing rules must keep mirroring the projection's
 * `projection_pending_approvals` accounting — resolved clears, and a
 * respond.failed clears when its detail marks the request stale/unknown — or
 * settle would be rejected on threads whose shell flags read as clear.
 *
 * The user-input half of this predicate no longer lives here: questions are
 * folded terminal-wins by `openUserInputRequestIds`, with resolution as the only
 * clearing signal, because the server now guarantees a resolution always
 * eventually lands. That asymmetry is deliberate and the two must not be
 * re-merged until approvals gain the same guarantee.
 */
function isStaleApprovalFailureDetail(payload: Record<string, unknown> | null): boolean {
  const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : null;
  if (detail === null) return false;
  return (
    detail.includes("stale pending approval request") ||
    detail.includes("unknown pending approval request") ||
    detail.includes("unknown pending permission request")
  );
}

/**
 * Blocked-on-you work derived from the thread's retained activities: an open
 * approval or an open question. The server-side twin of the shell's
 * hasPendingApprovals / hasPendingUserInput flags, which the decider read model
 * does not carry.
 *
 * Scans the read model's activities, which the projector caps at the most
 * recent 500. That bound is safe here: an OPEN approval/user-input request
 * blocks its turn, so the thread cannot accumulate hundreds of later
 * activities while one is outstanding.
 */
function hasOpenBlockingRequest(thread: {
  readonly activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>;
}): boolean {
  if (openUserInputRequestIds(thread.activities).size > 0) return true;
  const openApprovalIds = new Set(openRequestIds(thread.activities, ["approval"]));
  for (const activity of thread.activities) {
    if (activity.kind !== "provider.approval.respond.failed") continue;
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : null;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
    if (requestId !== null && isStaleApprovalFailureDetail(payload))
      openApprovalIds.delete(requestId);
  }
  return openApprovalIds.size > 0;
}

/**
 * A queued turn start — a user message no turn has picked up yet — is work
 * in flight even though session is still null (turn.start emits
 * message-sent + turn-start-requested; the session arrives later). Detection
 * mirrors the client's hasQueuedTurnStart: the newest user message is
 * strictly newer than every latestTurn timestamp (adoption stamps the new
 * turn's requestedAt with the message time, clearing this), and only within
 * the adoption grace window — historical threads whose last user message
 * postdates their turn timestamps (older-server data, mid-turn messages)
 * must not be blocked forever. A failed session start (status "error")
 * clears the block immediately.
 *
 * The age check is bounded on BOTH sides: message timestamps are
 * client-supplied, so a client clock ahead of the server yields a negative
 * age. Without the lower bound that negative age satisfies `<= grace` for
 * as long as the skew lasts, extending the block far past the intended two
 * minutes.
 */
function threadHasQueuedTurnStart(
  thread: {
    readonly messages: ReadonlyArray<{ readonly role: string; readonly createdAt: string }>;
    readonly latestTurn: {
      readonly requestedAt: string;
      readonly startedAt: string | null;
      readonly completedAt: string | null;
    } | null;
    readonly session: { readonly status: string } | null;
  },
  occurredAt: string,
): boolean {
  const latestUserMessageAtMs = thread.messages.reduce(
    (latest, message) =>
      message.role === "user" ? Math.max(latest, Date.parse(message.createdAt)) : latest,
    Number.NEGATIVE_INFINITY,
  );
  const latestTurnAtMs =
    thread.latestTurn === null
      ? Number.NEGATIVE_INFINITY
      : Math.max(
          ...[
            thread.latestTurn.requestedAt,
            thread.latestTurn.startedAt,
            thread.latestTurn.completedAt,
          ].map((candidate) =>
            candidate == null ? Number.NEGATIVE_INFINITY : Date.parse(candidate),
          ),
        );
  const queuedAgeMs = Date.parse(occurredAt) - latestUserMessageAtMs;
  return (
    thread.session?.status !== "error" &&
    Number.isFinite(latestUserMessageAtMs) &&
    latestUserMessageAtMs > latestTurnAtMs &&
    Math.abs(queuedAgeMs) <= QUEUED_TURN_START_GRACE_MS
  );
}

// loom: exported so the fork sibling `decider.loom.ts` builds identical event
// bases without re-deriving them.
export function withEventBase(
  input: Pick<OrchestrationCommand, "commandId"> & {
    readonly aggregateKind: OrchestrationEvent["aggregateKind"];
    readonly aggregateId: OrchestrationEvent["aggregateId"];
    readonly occurredAt: string;
    readonly metadata?: OrchestrationEvent["metadata"];
  },
): Effect.Effect<
  Omit<OrchestrationEvent, "sequence" | "type" | "payload">,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) =>
      crypto.randomUUIDv4.pipe(
        Effect.map((eventId) => ({
          eventId: EventId.make(eventId),
          aggregateKind: input.aggregateKind,
          aggregateId: input.aggregateId,
          occurredAt: input.occurredAt,
          commandId: input.commandId,
          causationEventId: null,
          correlationId: input.commandId,
          metadata: input.metadata ?? {},
        })),
      ),
    ),
  );
}

// loom: exported so the fork sibling can type its planned events identically.
export type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

/**
 * Settle-first settlement of an agent question (design commitment 3), shared by
 * respond, dismiss, and supersede. Emits the durable `user-input.resolved`
 * activity and — only when there is something to deliver — the delivery intent,
 * in ONE transaction. The settlement is therefore never contingent on the
 * provider being reachable, which inverts the order that made a wedged question
 * unanswerable.
 *
 * `requestId` absent means "settle whichever question is open" (supersede, which
 * does not name one); a caller that names a request that is not open gets an
 * empty array, so a duplicate or late settlement produces no spurious
 * resolution. Callers decide what an empty result means for them — supersede
 * treats it as "no question was open", a named settle rejects.
 */
export const userInputSettlementEvents = Effect.fn("userInputSettlementEvents")(function* (input: {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly createdAt: string;
  readonly openRequestIds: ReadonlySet<string>;
  readonly requestId?: string;
  readonly outcome: UserInputResolvedOutcome;
  readonly answers?: ProviderUserInputAnswers;
  readonly message?: string;
  /** Skip the provider-delivery intent (nothing to hand to a tool call). */
  readonly settleOnly?: boolean;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  PlatformError.PlatformError,
  Crypto.Crypto
> {
  const requestId =
    input.requestId !== undefined
      ? input.openRequestIds.has(input.requestId)
        ? input.requestId
        : null
      : ([...input.openRequestIds][0] ?? null);
  if (requestId === null) return [];

  const crypto = yield* Crypto.Crypto;
  const activityId = EventId.make(yield* crypto.randomUUIDv4);
  const settlementEvent: PlannedOrchestrationEvent = {
    ...(yield* withEventBase({
      aggregateKind: "thread",
      aggregateId: input.threadId,
      occurredAt: input.createdAt,
      commandId: input.commandId,
      metadata: { requestId: ApprovalRequestId.make(requestId) },
    })),
    type: "thread.activity-appended",
    payload: {
      threadId: input.threadId,
      activity: userInputResolvedActivity({
        activityId,
        resolution: {
          requestId,
          outcome: input.outcome,
          ...(input.answers !== undefined ? { answers: input.answers } : {}),
          ...(input.message !== undefined ? { message: input.message } : {}),
        },
        turnId: null,
        createdAt: input.createdAt,
      }),
    },
  };
  if (input.settleOnly === true) return [settlementEvent];
  return [
    settlementEvent,
    {
      ...(yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: input.threadId,
        occurredAt: input.createdAt,
        commandId: input.commandId,
        metadata: { requestId: ApprovalRequestId.make(requestId) },
      })),
      causationEventId: settlementEvent.eventId,
      type: "thread.user-input-response-requested",
      payload: {
        threadId: input.threadId,
        requestId: ApprovalRequestId.make(requestId),
        answers: input.answers ?? {},
        outcome: input.outcome,
        ...(input.message !== undefined ? { message: input.message } : {}),
        createdAt: input.createdAt,
      },
    },
  ];
});

// loom: exported so the fork sibling reuses this shared sweep for its cancel
// cascade. Transitive closure of the live (non-deleted) subtree under a thread,
// including the thread itself, walking parentThreadId edges. Shared by the
// archive/unarchive/delete cascades (here) and the cancel cascade (fork
// sibling): a workstream child is invisible in the sidebar, so any terminal
// operation on a root must sweep its whole subtree or the children linger
// half-alive.
export const collectLiveSubtreeIds = (
  readModel: OrchestrationReadModel,
  rootThreadId: ThreadId,
): Set<ThreadId> =>
  new Set([
    rootThreadId,
    ...subtreeOf(
      rootThreadId,
      readModel.threads.filter((thread) => thread.deletedAt === null),
    ).map((thread) => thread.id),
  ]);

// loom: exported for the fork sibling to mirror the return type of
// `decideLoomCommand`. (`dependencyCoherenceError` and `listGoalSubtreeRoots`
// are fork code and live in `decider.loom.ts`; `dependencyCoherenceError` is
// re-imported above for the retained `thread.create`.)
export type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

// loom: exported so the fork sibling's goal-cascade cases can recurse through
// the same command-sequencing engine.
export const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
  commands,
  readModel,
}: {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  ReadonlyArray<PlannedOrchestrationEvent>,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  let nextReadModel = readModel;
  let nextSequence = readModel.snapshotSequence;
  const plannedEvents: PlannedOrchestrationEvent[] = [];

  for (const nextCommand of commands) {
    const decided = yield* decideOrchestrationCommand({
      command: nextCommand,
      readModel: nextReadModel,
    });
    const nextEvents = Array.isArray(decided) ? decided : [decided];
    for (const nextEvent of nextEvents) {
      plannedEvents.push(nextEvent);
      nextSequence += 1;
      nextReadModel = yield* projectEvent(nextReadModel, {
        ...nextEvent,
        sequence: nextSequence,
      }).pipe(Effect.orDie);
    }
  }

  return plannedEvents;
});

export const decideOrchestrationCommand = Effect.fn("decideOrchestrationCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: OrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideOrchestrationCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  // loom: fork commands (goal.*, plan-lane/attention, dependencies, work.submit,
  // consult.record, fanin.set, turn-start.fail, message.reasoning.complete) are
  // decided by the fork sibling. After this guard `command` narrows to the
  // upstream-only subset, so the switch's `default: command satisfies never`
  // still holds.
  if (isLoomOrchestrationCommand(command)) {
    return yield* decideLoomCommand({ command, readModel });
  }
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
      });
      // Invariant: at most one ACTIVE project per workspace_root. Commands are
      // decided serially against a synchronously-updated read model, so a second
      // same-path create in THIS engine sees the first's project.created here and
      // is rejected. Cross-process races (a CLI running its own OrchestrationEngine,
      // a restart storm) each have a private read model and can both pass this
      // check — they are caught structurally by the partial unique index on
      // projection_projects(workspace_root) WHERE deleted_at IS NULL (migration
      // 050), which rolls back the losing create's transaction. A soft-deleted
      // project for the path does not block re-creation.
      yield* requireActiveProjectWorkspaceRootAbsent({
        readModel,
        command,
        workspaceRoot: command.workspaceRoot,
        exceptProjectId: command.projectId,
      });

      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "project.created",
        payload: {
          projectId: command.projectId,
          title: command.title,
          workspaceRoot: command.workspaceRoot,
          defaultModelSelection: command.defaultModelSelection ?? null,
          defaultStartFromOrigin: command.defaultStartFromOrigin ?? null,
          faviconPath: null,
          scripts: [],
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "project.meta.update": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      if (command.workspaceRoot !== undefined) {
        yield* requireActiveProjectWorkspaceRootAbsent({
          readModel,
          command,
          workspaceRoot: command.workspaceRoot,
          exceptProjectId: command.projectId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.meta-updated",
        payload: {
          projectId: command.projectId,
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.workspaceRoot !== undefined ? { workspaceRoot: command.workspaceRoot } : {}),
          ...(command.defaultModelSelection !== undefined
            ? { defaultModelSelection: command.defaultModelSelection }
            : {}),
          ...(command.defaultStartFromOrigin !== undefined
            ? { defaultStartFromOrigin: command.defaultStartFromOrigin }
            : {}),
          ...(command.defaultThreadEnvMode !== undefined
            ? { defaultThreadEnvMode: command.defaultThreadEnvMode }
            : {}),
          ...(command.faviconPath !== undefined ? { faviconPath: command.faviconPath } : {}),
          ...(command.scripts !== undefined ? { scripts: command.scripts } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "project.delete": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      const activeThreads = listThreadsByProjectId(readModel, command.projectId).filter(
        (thread) => thread.deletedAt === null,
      );
      // loom: active-goals gate + goal.delete cascade (fork additions to this
      // upstream case).
      const activeGoals = listGoalsByProjectId(readModel, command.projectId).filter(
        (goal) => goal.deletedAt === null,
      );
      if ((activeThreads.length > 0 || activeGoals.length > 0) && command.force !== true) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Project '${command.projectId}' is not empty and cannot be deleted without force=true.`,
        });
      }
      if (activeThreads.length > 0 || activeGoals.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...activeThreads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            ...activeGoals.map(
              // loom:
              (goal): Extract<OrchestrationCommand, { type: "goal.delete" }> => ({
                type: "goal.delete",
                commandId: command.commandId,
                goalId: goal.id,
              }),
            ),
            {
              type: "project.delete",
              commandId: command.commandId,
              projectId: command.projectId,
            },
          ],
        });
      }

      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "project",
          aggregateId: command.projectId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "project.deleted" as const,
        payload: {
          projectId: command.projectId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.create": {
      yield* requireProject({
        readModel,
        command,
        projectId: command.projectId,
      });
      yield* requireThreadAbsent({
        readModel,
        command,
        threadId: command.threadId,
      });
      // loom: goal-in-project validation (fork addition to this upstream case).
      if (command.goalId != null) {
        yield* requireActiveGoalInProject({
          readModel,
          command,
          goalId: command.goalId,
          projectId: command.projectId,
        });
      }
      // loom: dependency-coherence backstop (fork addition; helper lives in
      // decider.loom.ts). A dependency-bearing create (blockedBy and/or loop
      // routes) must name active siblings and form no cycle. The common
      // root/manual/goal-handoff create carries neither, so it skips validation.
      {
        const loopTargets = (command.routes ?? []).flatMap((route) =>
          route.kind === "loop" && route.to !== undefined ? [route.to] : [],
        );
        if ((command.blockedBy?.length ?? 0) > 0 || loopTargets.length > 0) {
          const detail = dependencyCoherenceError({
            readModel,
            threadId: command.threadId,
            parentThreadId: command.parentThreadId ?? null,
            blockedBy: command.blockedBy ?? [],
            loopTargets,
          });
          if (detail !== null)
            return yield* new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail,
            });
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.created",
        payload: {
          threadId: command.threadId,
          projectId: command.projectId,
          ...(command.goalId !== undefined ? { goalId: command.goalId } : {}),
          ...(command.parentThreadId !== undefined
            ? { parentThreadId: command.parentThreadId }
            : {}),
          // loom: fork payload fields (goalId/parentThreadId/role/purpose/brief/
          // blockedBy/routes/isolation/planLane/spawnGeneration).
          ...(command.role !== undefined ? { role: command.role } : {}),
          ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
          ...(command.brief !== undefined ? { brief: command.brief } : {}),
          // Seed the node's run-condition. A dependency-bearing create is
          // validated above (self/root/dangling/cycle rejected), so the set is
          // emitted verbatim rather than silently stripped.
          ...(command.blockedBy !== undefined ? { blockedBy: command.blockedBy } : {}),
          // Review gates (design §4): outcome route edges declared at spawn.
          ...(command.routes !== undefined ? { routes: command.routes } : {}),
          // Worktree isolation (design §1): propagate the spawn-resolved policy.
          ...(command.isolation !== undefined ? { isolation: command.isolation } : {}),
          ...(command.planLane !== undefined ? { planLane: command.planLane } : {}),
          ...(command.spawnGeneration !== undefined
            ? { spawnGeneration: command.spawnGeneration }
            : {}),
          // Thread fork (MVP): propagate the fork source onto the created event.
          ...(command.forkFromThreadId !== undefined
            ? { forkFromThreadId: command.forkFromThreadId }
            : {}),
          // loom: handoff chain — propagate the goal_continue predecessor.
          ...(command.continuesThreadId !== undefined
            ? { continuesThreadId: command.continuesThreadId }
            : {}),
          title: command.title,
          // loom: §4 seed the created thread's title provenance.
          titleProvenance: resolveTitleProvenance(command.title, command.titleProvenance),
          modelSelection: command.modelSelection,
          runtimeMode: command.runtimeMode,
          interactionMode: command.interactionMode,
          branch: command.branch,
          worktreePath: command.worktreePath,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.delete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Cascade DOWN over the live subtree (workstream children are invisible
      // in the sidebar and must not survive their root), then cascade UP:
      // deleting a goal's last live thread deletes the goal so no empty goal
      // header dangles. goal.delete routes through this single path.
      const subtree = collectLiveSubtreeIds(readModel, command.threadId);
      const threadById = new Map(readModel.threads.map((entry) => [entry.id, entry] as const));
      const events: PlannedOrchestrationEvent[] = [];
      for (const threadId of subtree) {
        const node = threadById.get(threadId);
        if (!node || (node.deletedAt !== null && threadId !== command.threadId)) continue;
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.deleted",
          payload: {
            threadId,
            deletedAt: occurredAt,
          },
        });
      }
      const goalId = thread.goalId ?? null;
      if (goalId !== null) {
        const goal = findGoalById(readModel, goalId);
        const goalHasOtherLiveThread = readModel.threads.some(
          (other) => other.goalId === goalId && !subtree.has(other.id) && other.deletedAt === null,
        );
        if (goal && goal.deletedAt === null && !goalHasOtherLiveThread) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "goal",
              aggregateId: goalId,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "goal.deleted",
            payload: { goalId, deletedAt: occurredAt },
          });
        }
      }
      return events;
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Cascade DOWN over the live subtree: workstream children never surface
      // in the sidebar, so archiving a root must archive its descendants too —
      // otherwise they stay "active" invisibly and pin the goal open forever
      // (the recurring dangling-empty-goal bug).
      const subtree = collectLiveSubtreeIds(readModel, command.threadId);
      const threadById = new Map(readModel.threads.map((entry) => [entry.id, entry] as const));
      const events: PlannedOrchestrationEvent[] = [];
      for (const threadId of subtree) {
        const node = threadById.get(threadId);
        if (!node || node.archivedAt !== null) continue;
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.archived",
          payload: {
            threadId,
            archivedAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
      }
      // Cascade UP: archiving the last active thread of a goal archives the
      // goal too, so the sidebar never strands an empty goal header. (Inverse
      // of goal.archive, which cascades down to its threads.) "Other active"
      // excludes the whole subtree being archived in this pass.
      const goalId = thread.goalId ?? null;
      if (goalId !== null) {
        const goal = findGoalById(readModel, goalId);
        const goalHasOtherActiveThread = readModel.threads.some(
          (other) =>
            other.goalId === goalId &&
            !subtree.has(other.id) &&
            other.deletedAt === null &&
            other.archivedAt === null,
        );
        if (
          goal &&
          goal.deletedAt === null &&
          goal.archivedAt === null &&
          !goalHasOtherActiveThread
        ) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "goal",
              aggregateId: goalId,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "goal.archived",
            payload: { goalId, archivedAt: occurredAt, updatedAt: occurredAt },
          });
        }
      }
      return events;
    }

    case "thread.unarchive": {
      const thread = yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Cascade DOWN: restore the archived subtree symmetrically with
      // thread.archive, so resurfacing a root brings its workstream children
      // back with it.
      const subtree = collectLiveSubtreeIds(readModel, command.threadId);
      const threadById = new Map(readModel.threads.map((entry) => [entry.id, entry] as const));
      const events: PlannedOrchestrationEvent[] = [];
      for (const threadId of subtree) {
        const node = threadById.get(threadId);
        if (!node || node.archivedAt === null) continue;
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unarchived",
          payload: {
            threadId,
            updatedAt: occurredAt,
          },
        });
      }
      // Cascade UP: resurfacing a thread whose goal was archived (e.g. by the
      // last-thread cascade above) must unarchive the goal too, otherwise the
      // thread would point at an archived goal and vanish from the sidebar.
      const goalId = thread.goalId ?? null;
      if (goalId !== null) {
        const goal = findGoalById(readModel, goalId);
        if (goal && goal.deletedAt === null && goal.archivedAt !== null) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "goal",
              aggregateId: goalId,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "goal.unarchived",
            payload: { goalId, updatedAt: occurredAt },
          });
        }
      }
      return events;
    }

    case "thread.settle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Server-side twin of the client's canSettle session check: a stale
      // or raced client must not settle a thread whose session is coming
      // alive or working.
      if (thread.session?.status === "starting" || thread.session?.status === "running") {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has an active session and cannot be settled`,
          }),
        );
      }
      // Pending approval / user-input requests are blocked-on-you work: a
      // raced or stale client must not park them behind a settled override
      // that would surface only after the request resolves.
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be settled`,
          }),
        );
      }
      const occurredAt = yield* nowIso;
      // Settling inside the adoption window would hide just-requested work.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be settled`,
          }),
        );
      }
      // Settling an already-settled thread re-emits with the original
      // settledAt: the engine rejects zero-event commands, and bulk-settle /
      // double-click must stay silent no-ops rather than surface errors.
      const alreadySettled = thread.settledOverride === "settled" && thread.settledAt !== null;
      const settledEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.settled" as const,
        payload: {
          threadId: command.threadId,
          settledAt: alreadySettled ? thread.settledAt : occurredAt,
          // A re-emission is a projected no-op: keep the existing updatedAt
          // so duplicate settles neither rewind nor churn ordering. A fresh
          // settle stamps the command time.
          updatedAt: alreadySettled ? thread.updatedAt : occurredAt,
        },
      };
      // Settling is "I'm done with this": clear states that would keep the
      // row pinned or snoozed instead of showing the new settled state.
      const companionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.pinnedAt != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unpinned" as const,
          payload: {
            threadId: command.threadId,
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        companionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return companionEvents.length > 0 ? [settledEvent, ...companionEvents] : settledEvent;
    }

    case "thread.unsettle": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): reducing the event a
      // second time lands on the same override state. A re-emission keeps
      // the existing updatedAt so duplicates do not churn ordering.
      const alreadyPinnedActive = thread.settledOverride === "active";
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyPinnedActive ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.snooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // A wake time in the past would create a thread that is snoozed and
      // woken at once — the row would never leave the inbox but still carry
      // snooze state. Reject instead of silently normalizing. The negated
      // comparison also catches unparseable wake times (IsoDateTime is
      // structurally just a string): NaN fails every comparison, and an
      // unparseable snoozedUntil must never persist.
      if (!(Date.parse(command.snoozedUntil) > Date.parse(occurredAt))) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future`,
          }),
        );
      }
      // Blocked-on-you work must not be snoozed away: a pending approval or
      // user-input request is the agent waiting on the user, and hiding it
      // defeats the request. (A running session IS snoozable — snooze only
      // affects visibility, never the agent.)
      if (hasOpenBlockingRequest(thread)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed`,
          }),
        );
      }
      // A queued turn start — a user message no turn has adopted yet — is
      // invisible pending work: no session, no pending flags. Snoozing in
      // that window would hide a just-requested turn exactly the way settle
      // would.
      if (threadHasQueuedTurnStart(thread, occurredAt)) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} has a queued turn start and cannot be snoozed`,
          }),
        );
      }
      // Re-snoozing an already-snoozed thread to the SAME wake time is a
      // duplicate (double-click, raced clients): re-emit with the original
      // timestamps so the projection is a no-op. A different wake time is a
      // real change and stamps fresh.
      const existingSnoozedAt =
        thread.snoozedUntil === command.snoozedUntil && thread.snoozedAt != null
          ? thread.snoozedAt
          : null;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.snoozed",
        payload: {
          threadId: command.threadId,
          snoozedUntil: command.snoozedUntil,
          snoozedAt: existingSnoozedAt ?? occurredAt,
          updatedAt: existingSnoozedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.unsnooze": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): waking a thread that
      // is not snoozed lands on the same null state without churning
      // updatedAt.
      const alreadyAwake = thread.snoozedUntil == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unsnoozed",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: alreadyAwake ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      // Re-pinning an already-pinned thread is a duplicate (double-click,
      // raced clients): re-emit with the original timestamps so the
      // projection is a no-op. Pinning has no lifecycle invariants — a pin
      // only ever promotes visibility, so it can never hide pending work.
      const existingPinnedAt = thread.pinnedAt ?? null;
      const pinnedEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pinned" as const,
        payload: {
          threadId: command.threadId,
          pinnedAt: existingPinnedAt ?? occurredAt,
          // A fresh pin takes the client's slot in the arranged order; on a
          // re-pin the existing key wins so raced duplicates cannot move a
          // thread the user already placed.
          ...(existingPinnedAt === null && command.orderKey !== undefined
            ? { pinOrderKey: command.orderKey }
            : {}),
          updatedAt: existingPinnedAt !== null ? thread.updatedAt : occurredAt,
        },
      };
      // Pinning is a promotion: it clears the parked states rather than
      // silently outranking them. An explicit settle un-settles (reason
      // "user", same override the un-settle button stamps), and a snooze's
      // return ticket is spent — the thread is on top NOW, not on Tuesday.
      const promotionEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (thread.settledOverride === "settled") {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      if (thread.snoozedUntil != null) {
        promotionEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "user",
            updatedAt: occurredAt,
          },
        });
      }
      return promotionEvents.length > 0 ? [pinnedEvent, ...promotionEvents] : pinnedEvent;
    }

    case "thread.unpin": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Idempotent by re-emission (see thread.settle): unpinning a thread
      // that is not pinned lands on the same null state without churning
      // updatedAt.
      const alreadyUnpinned = thread.pinnedAt == null;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unpinned",
        payload: {
          threadId: command.threadId,
          updatedAt: alreadyUnpinned ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.pin.reorder": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Only pinned threads have a slot in the arranged order. Rejecting
      // (rather than silently pinning) keeps a raced reorder-after-unpin
      // from resurrecting a pin the user just cleared.
      if (thread.pinnedAt == null) {
        return yield* Effect.fail(
          new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `thread ${command.threadId} is not pinned and cannot be reordered`,
          }),
        );
      }
      // Idempotent by re-emission (see thread.settle): a duplicate drop on
      // the same slot keeps the existing updatedAt so it projects as a no-op.
      const keyUnchanged = thread.pinOrderKey === command.orderKey;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.pin-reordered",
        payload: {
          threadId: command.threadId,
          orderKey: command.orderKey,
          updatedAt: keyUnchanged ? thread.updatedAt : occurredAt,
        },
      };
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // loom: goal-in-project validation (fork addition to this upstream case).
      if (command.goalId != null) {
        yield* requireActiveGoalInProject({
          readModel,
          command,
          goalId: command.goalId,
          projectId: thread.projectId,
        });
      }
      // loom: worktree-binding-clear warning (fork addition). Retained atop
      // upstream's #3822 rework: that change guards the stale-branch case and the
      // client-side patch helper no longer echoes worktreePath, but this log-only
      // guard still surfaces any OTHER client clearing a live binding.
      // Clearing an existing worktree binding downgrades the thread's cwd to the
      // project-root fallback on the next turn. Legitimate flows exist (the
      // branch selector rebinding a thread to the project root), but a client
      // echoing a stale null has silently erased a just-provisioned binding
      // before — so binding loss must at least be loud.
      if (command.worktreePath === null && thread.worktreePath !== null) {
        yield* Effect.logWarning("thread.meta.update clears an existing worktree binding", {
          threadId: command.threadId,
          commandId: command.commandId,
          previousWorktreePath: thread.worktreePath,
          ...(command.branch !== undefined ? { requestedBranch: command.branch } : {}),
        });
      }
      // upstream (#3822): ignore a stale branch update when the client's
      // expectedBranch no longer matches the thread's current branch.
      const branch =
        command.branch !== undefined &&
        command.expectedBranch !== undefined &&
        thread.branch !== command.expectedBranch
          ? thread.branch
          : command.branch;
      const occurredAt = yield* nowIso;
      // loom: §4 title provenance guard. A title write lands only when the
      // writer's stamped provenance may replace the thread's current title
      // provenance (a `curated` title is immutable to automation). When it may
      // not, the title (and its provenance) are dropped from the emitted event;
      // every other meta field still applies.
      const incomingTitleProvenance =
        command.title !== undefined
          ? (resolveTitleProvenance(command.title, command.titleProvenance) ?? "curated")
          : undefined;
      const applyTitle =
        command.title !== undefined &&
        incomingTitleProvenance !== undefined &&
        canReplaceTitle(thread.titleProvenance, incomingTitleProvenance);
      const metaUpdatedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          // loom: title writes carry their provenance, and `applyTitle` is the
          // fork's precedence gate (a weaker source never overwrites a stronger
          // one) — it stands in for upstream's bare `command.title !== undefined`.
          ...(applyTitle ? { title: command.title, titleProvenance: incomingTitleProvenance } : {}),
          ...(command.regenerateTitle === true
            ? {
                regenerateTitle: true as const,
                previousTitle: thread.title,
                titleRegeneration: {
                  requestId: command.commandId,
                  startedAt: occurredAt,
                },
              }
            : {}),
          ...(applyTitle && thread.titleRegeneration != null ? { titleRegeneration: null } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(branch !== undefined ? { branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          // Post-completion engagement (plan §8 item 3): the fan-in tip marker.
          ...(command.finalCommitSha !== undefined
            ? { finalCommitSha: command.finalCommitSha }
            : {}),
          // loom: fork payload fields (goalId/role/purpose).
          ...(command.goalId !== undefined ? { goalId: command.goalId } : {}),
          ...(command.role !== undefined ? { role: command.role } : {}),
          ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
          updatedAt: occurredAt,
        },
      };
      const events: PlannedOrchestrationEvent[] = [metaUpdatedEvent];

      // loom: §2 goal-attach cascade DOWN. Attaching a concrete goal to a thread
      // also attaches it to every live DESCENDANT still lacking a goal — healing
      // workstream children spawned during the parent's goal-less window (each
      // auto-created its own orphan goal, or inherited null). Never overrides a
      // descendant that already has a goal.
      if (command.goalId != null) {
        const subtree = collectLiveSubtreeIds(readModel, command.threadId);
        for (const descendant of readModel.threads) {
          if (
            descendant.id !== command.threadId &&
            subtree.has(descendant.id) &&
            descendant.goalId == null
          ) {
            events.push({
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: descendant.id,
                occurredAt,
                commandId: command.commandId,
              })),
              type: "thread.meta-updated",
              payload: { threadId: descendant.id, goalId: command.goalId, updatedAt: occurredAt },
            });
          }
        }
      }

      // loom: cascade UP to goal.meta-updated (fork addition to this upstream
      // case). Renaming the sole active thread of a goal renames the goal too,
      // so the sidebar never strands a stale goal header. (Mirror of the
      // last-active-thread archive cascade above.) §4: the rename must actually
      // have landed on the thread AND the goal's OWN title provenance must permit
      // replacement — a derived/seed thread rename never clobbers a curated goal.
      const goalId = thread.goalId ?? null;
      if (applyTitle && goalId !== null && incomingTitleProvenance !== undefined) {
        const goal = findGoalById(readModel, goalId);
        const goalHasOtherActiveThread = readModel.threads.some(
          (other) =>
            other.goalId === goalId &&
            other.id !== thread.id &&
            other.deletedAt === null &&
            other.archivedAt === null,
        );
        if (
          goal &&
          goal.deletedAt === null &&
          goal.archivedAt === null &&
          !goalHasOtherActiveThread &&
          goal.title !== command.title &&
          // §4 protect a CURATED goal title from automation, but otherwise keep
          // the container in sync with its sole thread — including a derived
          // thread rename updating a derived goal title (equal rank), while
          // never DOWNGRADING (a seed rename must not overwrite a derived goal).
          goal.titleProvenance !== "curated" &&
          titleProvenanceRank(incomingTitleProvenance) >= titleProvenanceRank(goal.titleProvenance)
        ) {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "goal",
              aggregateId: goalId,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "goal.meta-updated",
            payload: {
              goalId,
              title: command.title,
              titleProvenance: incomingTitleProvenance,
              updatedAt: occurredAt,
            },
          });
        }
      }
      return events.length === 1 ? metaUpdatedEvent : events;
    }

    case "thread.title.regeneration.complete": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestIsCurrent = thread.titleRegeneration?.requestId === command.requestId;
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.meta-updated",
        payload: {
          threadId: command.threadId,
          ...(requestIsCurrent && command.title !== undefined ? { title: command.title } : {}),
          ...(requestIsCurrent ? { titleRegeneration: null } : {}),
          updatedAt: requestIsCurrent ? occurredAt : thread.updatedAt,
        },
      };
    }

    case "thread.runtime-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.runtime-mode-set",
        payload: {
          threadId: command.threadId,
          runtimeMode: command.runtimeMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.interaction-mode.set": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.interaction-mode-set",
        payload: {
          threadId: command.threadId,
          interactionMode: command.interactionMode,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.turn.start": {
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // loom: dependency gate at the command boundary (fork addition to this
      // upstream case). The FIRST turn of a dep-blocked
      // sub-thread may only start once its dependencies are satisfied. This
      // closes the UI bypass (opening a `blocked`/`planned` child and sending a
      // message starts it before its deps are `done`). The dispatcher passes
      // naturally (it only fires when deps are satisfied); root threads and
      // every subsequent turn are unaffected. Keying purely off current
      // dep-satisfaction preserves the override path: clearing a child's deps
      // lets the dispatcher auto-promote it.
      const dependencyBlocker =
        targetThread.parentThreadId !== null &&
        !targetThread.messages.some((message) => message.role === "user")
          ? describeUnsatisfiedDependency(
              targetThread,
              new Map(readModel.threads.map((thread) => [thread.id, thread] as const)),
            )
          : null;
      if (dependencyBlocker !== null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Sub-thread '${command.threadId}' cannot start its first turn: ${dependencyBlocker}.`,
        });
      }
      const sourceProposedPlan = command.sourceProposedPlan;
      const sourceThread = sourceProposedPlan
        ? yield* requireThread({
            readModel,
            command,
            threadId: sourceProposedPlan.threadId,
          })
        : null;
      const sourcePlan =
        sourceProposedPlan && sourceThread
          ? sourceThread.proposedPlans.find((entry) => entry.id === sourceProposedPlan.planId)
          : null;
      if (sourceProposedPlan && !sourcePlan) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan.planId}' does not exist on thread '${sourceProposedPlan.threadId}'.`,
        });
      }
      if (sourceThread && sourceThread.projectId !== targetThread.projectId) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Proposed plan '${sourceProposedPlan?.planId}' belongs to thread '${sourceThread.id}' in a different project.`,
        });
      }
      // loom: gate reopen guards (review-gates design §5.2): the SINGLE
      // transition out of `done`. Server-only (the dispatcher's gate pass sets it when looping
      // rework back to a round-0-completed coder) and only from `done` — a
      // cancelled thread stays dead, mirroring the cancel side of sticky
      // terminal. The lane flip lands atomically with the turn-start below.
      if (command.reopen === true && !command.commandId.startsWith("server:")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Turn-start flag 'reopen' is control-plane-only (gate rework re-dispatch).",
        });
      }
      if (command.reopen === true && targetThread.planLane === "cancelled") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is cancelled and cannot be reopened — reopen applies only to 'done'.`,
        });
      }
      const reopening = command.reopen === true && targetThread.planLane === "done";
      const userMessageEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          role: "user",
          // loom: carry control-plane provenance through to the message (absent
          // ⇒ human). Client sends never set it, so they stay human.
          ...(command.message.origin !== undefined ? { origin: command.message.origin } : {}),
          // loom: carry the structured control-plane payload alongside the text.
          ...(command.message.controlPayload !== undefined
            ? { controlPayload: command.message.controlPayload }
            : {}),
          text: command.message.text,
          attachments: command.message.attachments,
          turnId: null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
      const turnStartRequestedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        causationEventId: userMessageEvent.eventId,
        type: "thread.turn-start-requested",
        payload: {
          threadId: command.threadId,
          messageId: command.message.messageId,
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.titleSeed !== undefined ? { titleSeed: command.titleSeed } : {}),
          runtimeMode: targetThread.runtimeMode,
          interactionMode: targetThread.interactionMode,
          ...(sourceProposedPlan !== undefined ? { sourceProposedPlan } : {}),
          createdAt: command.createdAt,
        },
      };
      // loom: sticky-terminal + attention-clear-all + atomic kickoff below are
      // fork additions to this upstream case.
      // Sticky terminal (design §3.4/§6): a turn-start on a `done`/`cancelled`
      // thread is a re-engagement — it changes neither the plan lane nor stored
      // attention; runtime alone reflects the activity.
      const targetTerminal =
        targetThread.planLane === "done" || targetThread.planLane === "cancelled";
      const trailingEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];

      // Real activity resets ANY override: it wakes an explicitly settled
      // thread, and it clears a keep-active pin back to neutral so the
      // thread can auto-settle again after this burst of work goes stale.
      // A snooze clears the same way — sending a message to a snoozed
      // thread is the user re-engaging, so the return ticket is spent.
      const lifecycleResetEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
      if (targetThread.settledOverride !== null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsettled",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }
      if (targetThread.snoozedUntil != null) {
        lifecycleResetEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          type: "thread.unsnoozed",
          payload: {
            threadId: command.threadId,
            reason: "activity",
            updatedAt: command.createdAt,
          },
        });
      }

      // Supersede (design commitment 3): a plain human message sent while a
      // question is open IS the human's response. The question resolves
      // `superseded` and the text is delivered AS THE TOOL RESULT.
      //
      // Delivery is EXCLUSIVE: this returns WITHOUT the turn-start above. The
      // blocked tool call returns the text and the existing turn resumes with it,
      // so emitting a turn-start as well would send the same instruction twice —
      // once as the tool result, once as a steer folded into the very same live
      // turn (pi treats a send during an active turn as a steer) — and an
      // action-bearing message would be executed twice. When the consumer turns
      // out to be dead, the reactor converts the settlement into exactly one new
      // turn instead; that is the only path that produces a turn-start here.
      //
      // A control-plane notice is excluded: it is not a human answering, and
      // settling a question with an automated recovery notice would be a lie.
      const supersedableRequestIds =
        command.message.origin === undefined || command.message.origin === "human"
          ? openUserInputRequestIds(targetThread.activities)
          : new Set<string>();
      if (supersedableRequestIds.size > 0) {
        const supersedeEvents = yield* userInputSettlementEvents({
          threadId: command.threadId,
          commandId: command.commandId,
          createdAt: command.createdAt,
          openRequestIds: supersedableRequestIds,
          outcome: "superseded",
          message: command.message.text,
        });
        // The message is still recorded (the human said it, and it must appear in
        // the transcript) and the lifecycle resets still apply — only the
        // turn-start is withheld, because the turn is already running and the tool
        // result is what resumes it.
        return [...lifecycleResetEvents, userMessageEvent, ...supersedeEvents];
      }

      // §7 unifying rule: a turn-start clears ALL stored attention (a running
      // thread is, by definition, no longer halted-awaiting-a-human). Applies to
      // every turn-start — a human/parent resume, an agent message, and the
      // kickoff alike — so error/awaiting_acceptance/needs_guidance clear the
      // moment work resumes. The two derived `awaiting_*` reasons are projected
      // from open requests and unaffected.
      if (!targetTerminal && targetThread.attention.length > 0) {
        trailingEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          causationEventId: turnStartRequestedEvent.eventId,
          type: "thread.attention-cleared",
          payload: {
            threadId: command.threadId,
            updatedAt: command.createdAt,
          },
        });
      }
      // Atomic kickoff (D-core child promotion): `setInProgress` makes the
      // decider emit the `in_progress` plan-lane-set in the SAME command as the
      // turn-start so both land in one engine transaction. A crash can no longer
      // leave the child with a started turn but a lane stuck at `ready`. Only the
      // dispatcher sets `setInProgress` (control-plane-only, design §8); normal
      // user/agent turn-starts and the requireIdle wake path never do.
      //
      // `yielded` is NOT sticky-terminal (review-gates design §5.1): ANY
      // turn-start on a `yielded` thread — a parent workstream_prompt, a human
      // send, a gate-pass resume — reverts it to `in_progress` in the same
      // transaction, so a resumed thread never sits mislabelled as yielded.
      //
      // A gate `reopen` is the mirror image for `done`: the resume atomically
      // reverts the round-0-completed coder to `in_progress` in the same
      // transaction (review-gates design §5.2).
      //
      // A turn-start on a `ready` thread likewise flips it to `in_progress`: a
      // reopened child (lane-set back to `ready`, then prompted) would otherwise
      // run mislabelled and race the idle "forgot to finish" liveness rail. The
      // dispatcher kickoff already covers its own case via `setInProgress`; this
      // extends the same truth (a running turn IS in progress) to human/parent
      // turn-starts. `planned` stays untouched — it is a deliberate hold.
      if (
        (command.setInProgress === true && !targetTerminal) ||
        targetThread.planLane === "yielded" ||
        targetThread.planLane === "ready" ||
        reopening
      ) {
        trailingEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          causationEventId: turnStartRequestedEvent.eventId,
          type: "thread.plan-lane-set",
          payload: {
            threadId: command.threadId,
            planLane: "in_progress",
            updatedAt: command.createdAt,
          },
        });
      }
      // loom: reopen observability (design §5.2/R3): a STARTED dependent is never
      // un-run, so a reopen that supersedes work a released dependent already
      // consumed is surfaced as a warning activity on the parent — observable,
      // never blocking (a hard block would deadlock the loop on a mis-wiring).
      if (reopening && targetThread.parentThreadId !== null) {
        const startedDependents = readModel.threads.filter(
          (thread) =>
            thread.deletedAt === null &&
            thread.blockedBy.includes(command.threadId) &&
            thread.messages.some((message) => message.role === "user"),
        );
        if (startedDependents.length > 0) {
          const activityId = yield* Crypto.Crypto.pipe(
            Effect.flatMap((crypto) => crypto.randomUUIDv4),
          );
          trailingEvents.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: targetThread.parentThreadId,
              occurredAt: command.createdAt,
              commandId: command.commandId,
            })),
            causationEventId: turnStartRequestedEvent.eventId,
            type: "thread.activity-appended",
            payload: {
              threadId: targetThread.parentThreadId,
              activity: {
                id: EventId.make(activityId),
                tone: "error",
                kind: "workstream.gate.reopened-with-started-dependents",
                summary: `Warning: review gate reopened '${targetThread.title}' (${command.threadId}) for rework while ${startedDependents.length} already-started dependent(s) may be running against its superseded output.`,
                payload: {
                  reopenedThreadId: command.threadId,
                  startedDependentIds: startedDependents.map((thread) => thread.id),
                },
                turnId: null,
                createdAt: command.createdAt,
              },
            },
          });
        }
      }
      return [
        ...lifecycleResetEvents,
        userMessageEvent,
        turnStartRequestedEvent,
        ...trailingEvents,
      ];
    }

    case "thread.turn.interrupt": {
      const interruptThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const interruptEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-interrupt-requested",
        payload: {
          threadId: command.threadId,
          ...(command.turnId !== undefined ? { turnId: command.turnId } : {}),
          createdAt: command.createdAt,
        },
      };
      // loom: needs_guidance raise on human stop (fork addition to this upstream
      // case). No-silent-halt (design §6.1). A HUMAN stop (bare commandId) of a
      // non-terminal thread additionally raises `needs_guidance`, so a
      // human-stopped thread surfaces immediately rather than waiting out the
      // idle grace. An orchestrator stop (workstream_stop, `server:`-prefixed)
      // interrupts WITHOUT raising — it owns the resume; the async backstop
      // covers a forgotten resume.
      const interruptTerminal =
        interruptThread.planLane === "done" || interruptThread.planLane === "cancelled";
      if (command.commandId.startsWith("server:") || interruptTerminal) {
        return interruptEvent;
      }
      return [
        interruptEvent,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt: command.createdAt,
            commandId: command.commandId,
          })),
          causationEventId: interruptEvent.eventId,
          type: "thread.attention-raised",
          payload: {
            threadId: command.threadId,
            reason: "needs_guidance",
            updatedAt: command.createdAt,
          },
        },
      ];
    }

    case "thread.approval.respond": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {
            requestId: command.requestId,
          },
        })),
        type: "thread.approval-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          decision: command.decision,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.user-input.respond": {
      const respondThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-first (design commitment 3). The durable resolution is emitted in
      // the SAME transaction as the delivery intent, so the question is over the
      // moment the command is accepted — provider delivery is best-effort after
      // the fact. The inverted order is why sixteen answer attempts over 22 hours
      // changed nothing: delivery failed, so nothing was ever settled.
      const respondEvents = yield* userInputSettlementEvents({
        threadId: command.threadId,
        commandId: command.commandId,
        createdAt: command.createdAt,
        openRequestIds: openUserInputRequestIds(respondThread.activities),
        requestId: command.requestId,
        outcome: "answered",
        answers: command.answers,
      });
      if (respondEvents.length === 0) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `User-input request '${command.requestId}' on thread '${command.threadId}' is not open; it was already settled.`,
        });
      }
      return respondEvents;
    }

    case "thread.checkpoint.revert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.checkpoint-revert-requested",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.stop": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Settle-cleanup stops are conditional: between the settle landing and
      // this command, another client may have re-engaged the thread (a turn
      // start unsettles it and brings the session alive). Commands are
      // decided serially against this read model, so checking here — not in
      // the dispatcher's pre-settle snapshot — closes that race.
      if (command.onlyIfSettled === true) {
        const sessionComingAlive =
          thread.session?.status === "starting" || thread.session?.status === "running";
        if (
          thread.settledOverride !== "settled" ||
          sessionComingAlive ||
          threadHasQueuedTurnStart(thread, command.createdAt)
        ) {
          return yield* Effect.fail(
            new OrchestrationCommandInvariantError({
              commandType: command.type,
              detail: `thread ${command.threadId} was re-engaged after settle; skipping session stop`,
            }),
          );
        }
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const sessionSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
      // Only a session coming alive is activity worth waking a settled thread
      // for — status writes like ready/stopped/error arrive after the fact and
      // must not fight a user's explicit settle. Snooze is deliberately NOT
      // cleared here: snooze never pauses the agent, so its session starting
      // or erroring is not the user re-engaging. Blocked/failed work still
      // surfaces immediately — effectiveSnoozed refuses to classify a thread
      // with a raised hand (approval / input / failure / fresh completion)
      // as snoozed, without spending the return ticket.
      const isSessionActivity =
        command.session.status === "starting" || command.session.status === "running";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !isSessionActivity) {
        return sessionSetEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, sessionSetEvent];
    }

    case "thread.message.assistant.delta": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: command.delta,
          turnId: command.turnId ?? null,
          streaming: true,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.message.assistant.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.message-sent",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          role: "assistant",
          text: "",
          turnId: command.turnId ?? null,
          streaming: false,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.proposed-plan.upsert": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.proposed-plan-upserted",
        payload: {
          threadId: command.threadId,
          proposedPlan: command.proposedPlan,
        },
      };
    }

    case "thread.turn.diff.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.turn-diff-completed",
        payload: {
          threadId: command.threadId,
          turnId: command.turnId,
          checkpointTurnCount: command.checkpointTurnCount,
          checkpointRef: command.checkpointRef,
          status: command.status,
          files: command.files,
          assistantMessageId: command.assistantMessageId ?? null,
          completedAt: command.completedAt,
        },
      };
    }

    case "thread.revert.complete": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.reverted",
        payload: {
          threadId: command.threadId,
          turnCount: command.turnCount,
        },
      };
    }

    case "thread.activity.append": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      const requestId =
        typeof command.activity.payload === "object" &&
        command.activity.payload !== null &&
        "requestId" in command.activity.payload &&
        typeof (command.activity.payload as { requestId?: unknown }).requestId === "string"
          ? ((command.activity.payload as { requestId: string })
              .requestId as OrchestrationEvent["metadata"]["requestId"])
          : undefined;

      // FIRST-TERMINAL-WINS, enforced at the serialised write authority.
      //
      // Several producers can append a `user-input.resolved` for one request: the
      // human settlement (settle-first), each adapter's delivery echo when its
      // blocked callback returns, the session-exit rule, and the startup scan. A
      // projection-side pre-check cannot make that safe — it reads, then dispatches,
      // and a settlement can commit in between, so the echo still lands second and
      // the request ends up durably carrying two contradictory terminal outcomes
      // (`dismissed` then `answered`), which every downstream consumer reads as the
      // later one. The decider runs inside the engine's serialised command queue
      // against the just-committed read model, so the check and the write are
      // atomic with respect to each other. Rejecting is correct rather than
      // lossy: by definition the request is ALREADY settled durably.
      if (requestId !== undefined && command.activity.kind === "user-input.resolved") {
        const alreadySettled = thread.activities.some(
          (activity) =>
            activity.kind === "user-input.resolved" &&
            typeof activity.payload === "object" &&
            activity.payload !== null &&
            (activity.payload as { requestId?: unknown }).requestId === requestId,
        );
        if (alreadySettled) {
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail: `User-input request '${requestId}' on thread '${command.threadId}' ${ALREADY_SETTLED_REJECTION_MARKER}.`,
          });
        }
      }

      const activityAppendedEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
          ...(requestId !== undefined ? { metadata: { requestId } } : {}),
        })),
        type: "thread.activity-appended",
        payload: {
          threadId: command.threadId,
          activity: command.activity,
        },
      };
      // An approval or user-input request is blocked-on-you work — it must
      // never stay hidden inside a settled slim row.
      const wakesSettledThread =
        command.activity.kind === "approval.requested" ||
        command.activity.kind === "user-input.requested";
      // Real activity resets ANY override (settled wakes, active unpins).
      if (thread.settledOverride === null || !wakesSettledThread) {
        return activityAppendedEvent;
      }
      const unsettledEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.unsettled",
        payload: {
          threadId: command.threadId,
          reason: "activity",
          updatedAt: command.createdAt,
        },
      };
      return [unsettledEvent, activityAppendedEvent];
    }

    default: {
      command satisfies never;
      const fallback = command as never as { type: string };
      return yield* new OrchestrationCommandInvariantError({
        commandType: fallback.type,
        detail: `Unknown command type: ${fallback.type}`,
      });
    }
  }
});
