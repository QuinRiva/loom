import {
  EventId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import {
  findGoalById,
  listGoalsByProjectId,
  listThreadsByProjectId,
  requireActiveGoalInProject,
  requireGoal,
  requireGoalAbsent,
  requireGoalActive,
  requireGoalNotDeleted,
  requireGoalParentTask,
  requireGoalTask,
  requireGoalTaskAbsent,
  requireProject,
  requireProjectAbsent,
  requireThread,
  requireThreadArchived,
  requireThreadAbsent,
  requireThreadNotArchived,
  requireUniqueGoalSlug,
} from "./commandInvariants.ts";
import { flattenGoalTasks } from "./goalTaskTree.ts";
import { projectEvent } from "./projector.ts";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";
import { routeWorkSubmit } from "@t3tools/shared/workstreamGraph";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

function withEventBase(
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

type PlannedOrchestrationEvent = Omit<OrchestrationEvent, "sequence">;

type DecideOrchestrationCommandResult =
  | PlannedOrchestrationEvent
  | ReadonlyArray<PlannedOrchestrationEvent>;

const decideCommandSequence = Effect.fn("decideCommandSequence")(function* ({
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
  switch (command.type) {
    case "project.create": {
      yield* requireProjectAbsent({
        readModel,
        command,
        projectId: command.projectId,
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

    case "goal.create": {
      yield* requireProject({ readModel, command, projectId: command.projectId });
      yield* requireGoalAbsent({ readModel, command, goalId: command.goalId });
      yield* requireUniqueGoalSlug({
        readModel,
        command,
        projectId: command.projectId,
        slug: command.slug,
      });
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "goal.created",
        payload: {
          goalId: command.goalId,
          projectId: command.projectId,
          slug: command.slug,
          title: command.title,
          description: command.description ?? "",
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "goal.meta.update": {
      yield* requireGoalNotDeleted({ readModel, command, goalId: command.goalId });
      const goal = yield* requireGoal({ readModel, command, goalId: command.goalId });
      if (command.slug !== undefined) {
        yield* requireUniqueGoalSlug({
          readModel,
          command,
          projectId: goal.projectId,
          slug: command.slug,
          exceptGoalId: command.goalId,
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "goal.meta-updated",
        payload: {
          goalId: command.goalId,
          ...(command.slug !== undefined ? { slug: command.slug } : {}),
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.description !== undefined ? { description: command.description } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "goal.archive": {
      yield* requireGoalNotDeleted({ readModel, command, goalId: command.goalId });
      // Archiving a goal cascades DOWN to its active threads. We don't emit
      // goal.archived here: archiving the last active thread cascades the goal
      // archive itself (see thread.archive), so we route through that one path.
      const activeThreads = readModel.threads.filter(
        (thread) =>
          thread.goalId === command.goalId &&
          thread.deletedAt === null &&
          thread.archivedAt === null,
      );
      if (activeThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: activeThreads.map(
            (thread): Extract<OrchestrationCommand, { type: "thread.archive" }> => ({
              type: "thread.archive",
              commandId: command.commandId,
              threadId: thread.id,
            }),
          ),
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "goal.archived",
        payload: { goalId: command.goalId, archivedAt: occurredAt, updatedAt: occurredAt },
      };
    }

    case "goal.unarchive": {
      yield* requireGoalNotDeleted({ readModel, command, goalId: command.goalId });
      // Inverse of goal.archive: unarchive every archived thread, and the first
      // thread.unarchive cascades the goal unarchive (see thread.unarchive).
      const archivedThreads = readModel.threads.filter(
        (thread) =>
          thread.goalId === command.goalId &&
          thread.deletedAt === null &&
          thread.archivedAt !== null,
      );
      if (archivedThreads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: archivedThreads.map(
            (thread): Extract<OrchestrationCommand, { type: "thread.unarchive" }> => ({
              type: "thread.unarchive",
              commandId: command.commandId,
              threadId: thread.id,
            }),
          ),
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "goal.unarchived",
        payload: { goalId: command.goalId, updatedAt: occurredAt },
      };
    }

    case "goal.delete": {
      yield* requireGoal({ readModel, command, goalId: command.goalId });
      // Deleting a goal cascade-deletes its threads (the goal owns them), then
      // deletes the goal once empty. thread.delete has no goal cascade, so the
      // trailing goal.delete re-decides against an empty goal and emits the leaf.
      const threads = readModel.threads.filter(
        (thread) => thread.goalId === command.goalId && thread.deletedAt === null,
      );
      if (threads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: [
            ...threads.map(
              (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
                type: "thread.delete",
                commandId: command.commandId,
                threadId: thread.id,
              }),
            ),
            {
              type: "goal.delete",
              commandId: command.commandId,
              goalId: command.goalId,
            },
          ],
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "goal.deleted",
        payload: { goalId: command.goalId, deletedAt: occurredAt },
      };
    }

    case "goal.task.create": {
      const goal = yield* requireGoalActive({
        readModel,
        command,
        goalId: command.goalId,
      });
      yield* requireGoalTaskAbsent({ command, goal, taskId: command.taskId });
      if (command.parentTaskId !== null) {
        yield* requireGoalParentTask({ command, goal, parentTaskId: command.parentTaskId });
      }
      const siblings = flattenGoalTasks(goal.tasks).filter(
        (task) => (task.parentTaskId ?? null) === command.parentTaskId,
      );
      const position =
        command.position ??
        (siblings.length === 0 ? 0 : Math.max(...siblings.map((task) => task.position)) + 1);
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "goal.task-created",
        payload: {
          goalId: command.goalId,
          taskId: command.taskId,
          parentTaskId: command.parentTaskId,
          text: command.text,
          position,
          createdAt: command.createdAt,
          updatedAt: command.createdAt,
        },
      };
    }

    case "goal.task.update": {
      // Task reparenting is intentionally disallowed for MVP: there is no
      // parentTaskId on this command, so the task tree cannot form a cycle.
      const goal = yield* requireGoalActive({
        readModel,
        command,
        goalId: command.goalId,
      });
      yield* requireGoalTask({ command, goal, taskId: command.taskId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "goal.task-updated",
        payload: {
          goalId: command.goalId,
          taskId: command.taskId,
          ...(command.text !== undefined ? { text: command.text } : {}),
          ...(command.done !== undefined ? { done: command.done } : {}),
          ...(command.position !== undefined ? { position: command.position } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "goal.task.delete": {
      const goal = yield* requireGoalActive({
        readModel,
        command,
        goalId: command.goalId,
      });
      yield* requireGoalTask({ command, goal, taskId: command.taskId });
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "goal",
          aggregateId: command.goalId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "goal.task-deleted",
        payload: { goalId: command.goalId, taskId: command.taskId, deletedAt: occurredAt },
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
      if (command.goalId != null) {
        yield* requireActiveGoalInProject({
          readModel,
          command,
          goalId: command.goalId,
          projectId: command.projectId,
        });
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
          ...(command.role !== undefined ? { role: command.role } : {}),
          ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
          ...(command.brief !== undefined ? { brief: command.brief } : {}),
          // Seed the node's run-condition; drop self-references so a thread can
          // never block on itself (cycles/dangling ids tolerated permissively,
          // matching thread.dependencies.set).
          ...(command.blockedBy !== undefined
            ? { blockedBy: command.blockedBy.filter((id) => id !== command.threadId) }
            : {}),
          // Review gates (design §4): outcome route edges declared at spawn.
          ...(command.routes !== undefined ? { routes: command.routes } : {}),
          // Worktree isolation (design §1): propagate the spawn-resolved policy.
          ...(command.isolation !== undefined ? { isolation: command.isolation } : {}),
          ...(command.planLane !== undefined ? { planLane: command.planLane } : {}),
          ...(command.spawnGeneration !== undefined
            ? { spawnGeneration: command.spawnGeneration }
            : {}),
          title: command.title,
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
        type: "thread.deleted",
        payload: {
          threadId: command.threadId,
          deletedAt: occurredAt,
        },
      };
    }

    case "thread.archive": {
      const thread = yield* requireThreadNotArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const archivedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.archived",
        payload: {
          threadId: command.threadId,
          archivedAt: occurredAt,
          updatedAt: occurredAt,
        },
      };
      // Cascade UP: archiving the last active thread of a goal archives the
      // goal too, so the sidebar never strands an empty goal header. (Inverse
      // of goal.archive, which cascades down to its threads.)
      const goalId = thread.goalId ?? null;
      if (goalId !== null) {
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
          !goalHasOtherActiveThread
        ) {
          return [
            archivedEvent,
            {
              ...(yield* withEventBase({
                aggregateKind: "goal",
                aggregateId: goalId,
                occurredAt,
                commandId: command.commandId,
              })),
              type: "goal.archived",
              payload: { goalId, archivedAt: occurredAt, updatedAt: occurredAt },
            },
          ];
        }
      }
      return archivedEvent;
    }

    case "thread.unarchive": {
      const thread = yield* requireThreadArchived({
        readModel,
        command,
        threadId: command.threadId,
      });
      const occurredAt = yield* nowIso;
      const unarchivedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.unarchived",
        payload: {
          threadId: command.threadId,
          updatedAt: occurredAt,
        },
      };
      // Cascade UP: resurfacing a thread whose goal was archived (e.g. by the
      // last-thread cascade above) must unarchive the goal too, otherwise the
      // thread would point at an archived goal and vanish from the sidebar.
      const goalId = thread.goalId ?? null;
      if (goalId !== null) {
        const goal = findGoalById(readModel, goalId);
        if (goal && goal.deletedAt === null && goal.archivedAt !== null) {
          return [
            unarchivedEvent,
            {
              ...(yield* withEventBase({
                aggregateKind: "goal",
                aggregateId: goalId,
                occurredAt,
                commandId: command.commandId,
              })),
              type: "goal.unarchived",
              payload: { goalId, updatedAt: occurredAt },
            },
          ];
        }
      }
      return unarchivedEvent;
    }

    case "thread.meta.update": {
      const thread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (command.goalId != null) {
        yield* requireActiveGoalInProject({
          readModel,
          command,
          goalId: command.goalId,
          projectId: thread.projectId,
        });
      }
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
      const occurredAt = yield* nowIso;
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
          ...(command.title !== undefined ? { title: command.title } : {}),
          ...(command.modelSelection !== undefined
            ? { modelSelection: command.modelSelection }
            : {}),
          ...(command.branch !== undefined ? { branch: command.branch } : {}),
          ...(command.worktreePath !== undefined ? { worktreePath: command.worktreePath } : {}),
          ...(command.goalId !== undefined ? { goalId: command.goalId } : {}),
          ...(command.role !== undefined ? { role: command.role } : {}),
          ...(command.purpose !== undefined ? { purpose: command.purpose } : {}),
          updatedAt: occurredAt,
        },
      };
      // Cascade UP: renaming the sole active thread of a goal renames the goal
      // too, so the sidebar never strands a stale goal header. (Mirror of the
      // last-active-thread archive cascade above.)
      const goalId = thread.goalId ?? null;
      if (command.title !== undefined && goalId !== null) {
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
          goal.title !== command.title
        ) {
          return [
            metaUpdatedEvent,
            {
              ...(yield* withEventBase({
                aggregateKind: "goal",
                aggregateId: goalId,
                occurredAt,
                commandId: command.commandId,
              })),
              type: "goal.meta-updated",
              payload: { goalId, title: command.title, updatedAt: occurredAt },
            },
          ];
        }
      }
      return metaUpdatedEvent;
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

    case "thread.plan-lane.set": {
      const laneThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Authorisation chokepoint (design §8). The decider is the only path every
      // plan-lane write passes through. `in_progress` is control-plane-only: it
      // is set by *starting a turn* (the atomic kickoff below), never assigned
      // directly. Server writers build a `server:`-prefixed commandId (the
      // web/WS board dispatches a bare UUID and cannot forge that prefix), so
      // reject `in_progress` unless the command carries it. `planned`, `ready`,
      // `done`, and `cancelled` are accepted from client/agent.
      if (command.planLane === "in_progress" && !command.commandId.startsWith("server:")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Plan lane 'in_progress' is control-plane-only — it is set by starting a turn, not assigned directly.",
        });
      }
      // `yielded` is likewise control-plane-only (review-gates design §5.1): it
      // is derived from a submit's routing decision (`thread.work.submit`),
      // never assigned directly — the same `server:` guard as `in_progress`.
      if (command.planLane === "yielded" && !command.commandId.startsWith("server:")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Plan lane 'yielded' is control-plane-only — it is derived from a workstream_submit outcome, not assigned directly.",
        });
      }
      const occurredAt = yield* nowIso;
      // Cancellation cascades over the whole subtree (design: orchestrator-wide
      // descendant termination). Cancelling a thread cancels every non-terminal
      // descendant and interrupts any in-flight turn among them, so killing one
      // branch kills the runaway self-spawning chain beneath it. A non-cancel
      // lane write stays single-node.
      //
      // No `needs_guidance` is sprayed across the subtree because each interrupt
      // is emitted as a `thread.turn-interrupt-requested` event DIRECTLY: the
      // raise-attention-on-interrupt decision lives ONLY in the
      // `thread.turn.interrupt` COMMAND handler, which this path never invokes.
      // (Routing the cascade through that command would be unsafe — within one
      // decide pass the cancels we emit are not applied back to `readModel`, so
      // each node would still read as `in_progress` and a bare-commandId cancel
      // WOULD raise `needs_guidance`.) Reaching `cancelled` also clears any
      // stored attention on each node, so a dead thread never lingers flagged
      // for a human.
      if (command.planLane === "cancelled") {
        const live = readModel.threads.filter((thread) => thread.deletedAt === null);
        // Transitive closure of live descendants under the target (walk parentThreadId).
        const subtree = new Set([command.threadId]);
        const queue = [command.threadId];
        while (queue.length > 0) {
          const parentId = queue.shift()!;
          for (const thread of live) {
            if (thread.parentThreadId === parentId && !subtree.has(thread.id)) {
              subtree.add(thread.id);
              queue.push(thread.id);
            }
          }
        }
        const threadById = new Map(live.map((thread) => [thread.id, thread] as const));
        const events: PlannedOrchestrationEvent[] = [];
        // Cancel the target always; cancel non-terminal descendants but never
        // clobber a descendant that legitimately reached `done`/`cancelled`. A
        // cancelled node with stored attention also gets it cleared.
        for (const threadId of subtree) {
          const node = threadById.get(threadId);
          const lane = node?.planLane;
          if (threadId !== command.threadId && (lane === "done" || lane === "cancelled")) continue;
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: threadId,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.plan-lane-set",
            payload: { threadId, planLane: "cancelled", updatedAt: occurredAt },
          });
          if (node && node.attention.length > 0) {
            events.push({
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt,
                commandId: command.commandId,
              })),
              type: "thread.attention-cleared",
              payload: { threadId, updatedAt: occurredAt },
            });
          }
        }
        // Interrupt any node in the subtree whose turn is live so token burn
        // actually stops; the matching cancel above precedes it.
        for (const threadId of subtree) {
          if (threadById.get(threadId)?.planLane !== "in_progress") continue;
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: threadId,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.turn-interrupt-requested",
            payload: { threadId, createdAt: occurredAt },
          });
        }
        return events;
      }
      // Re-engagement epoch (review-gates design §5.2 exception): a parent or
      // human reopening a terminal thread via the lane-set path (done/cancelled
      // → ready/planned) stamps a FRESH spawnGeneration in the same event. The
      // parent's one-shot generation wake is keyed (parentId, spawnGeneration)
      // with durable receipts, so without a new epoch the re-run's completion
      // would be deduped forever by the first completion's receipt. The fresh
      // generation makes the re-run a new episode: it detaches from its original
      // sibling join group and its completion fires a fresh, receipt-deduped
      // wake. A gate `reopen` deliberately does NOT pass here — it flows through
      // `thread.turn.start` + `reopen` and relies on the reviewer's generation
      // carrying the resolution wake.
      const laneSetBase = yield* withEventBase({
        aggregateKind: "thread",
        aggregateId: command.threadId,
        occurredAt,
        commandId: command.commandId,
      });
      const reengaging =
        laneThread.parentThreadId !== null &&
        (laneThread.planLane === "done" || laneThread.planLane === "cancelled") &&
        (command.planLane === "ready" || command.planLane === "planned");
      const planLaneSetEvent: Omit<OrchestrationEvent, "sequence"> = {
        ...laneSetBase,
        type: "thread.plan-lane-set",
        payload: {
          threadId: command.threadId,
          planLane: command.planLane,
          ...(reengaging ? { spawnGeneration: laneSetBase.eventId } : {}),
          updatedAt: occurredAt,
        },
      };
      // Design §3 invariant: when the plan advances to a terminal lane, every
      // stored attention flag clears — a finished thread never sits with a stale
      // ⚠. Symmetric with the turn-start clear (a resume clears attention too).
      // `cancelled` is handled by the cascade above (which clears each cancelled
      // node's attention), so only `done` reaches here. Emit the omitted-reason
      // clear ("clear ALL") only when there is something to clear, so no-op
      // events aren't produced. Derived `awaiting_*` reasons are projected from
      // open requests and unaffected.
      if (command.planLane === "done" && laneThread.attention.length > 0) {
        return [
          planLaneSetEvent,
          {
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: command.threadId,
              occurredAt,
              commandId: command.commandId,
            })),
            causationEventId: planLaneSetEvent.eventId,
            type: "thread.attention-cleared",
            payload: {
              threadId: command.threadId,
              updatedAt: occurredAt,
            },
          },
        ];
      }
      return planLaneSetEvent;
    }

    case "thread.attention.raise": {
      yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Attention authorisation (design §8). `error` is server-only (the liveness
      // sweep sets it via a `server:`-prefixed command). The two `awaiting_*`
      // request reasons are *derived* from open approval/input requests and are
      // never stored, so they may never be raised by command. Only
      // `awaiting_acceptance` and `needs_guidance` are agent-raisable.
      if (command.reason === "error" && !command.commandId.startsWith("server:")) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Attention 'error' is server-only and cannot be raised by clients.",
        });
      }
      if (command.reason === "awaiting_approval" || command.reason === "awaiting_input") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail:
            "Attention 'awaiting_approval'/'awaiting_input' are derived from open requests and cannot be raised directly.",
        });
      }
      const occurredAt = yield* nowIso;
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.attention-raised",
        payload: {
          threadId: command.threadId,
          reason: command.reason,
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.attention.clear": {
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
        type: "thread.attention-cleared",
        payload: {
          threadId: command.threadId,
          ...(command.reason !== undefined ? { reason: command.reason } : {}),
          updatedAt: occurredAt,
        },
      };
    }

    case "thread.dependencies.set": {
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
        type: "thread.dependencies-set",
        payload: {
          threadId: command.threadId,
          // Replace-set semantics; drop self-references so a thread can never
          // block on itself. Cycles/dangling ids are tolerated (permissive).
          blockedBy: command.blockedBy.filter((id) => id !== command.threadId),
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
      // Dependency gate at the command boundary: the FIRST turn of a dep-blocked
      // sub-thread may only start once its dependencies are satisfied. This
      // closes the UI bypass (opening a `blocked`/`planned` child and sending a
      // message starts it before its deps are `done`). The dispatcher passes
      // naturally (it only fires when deps are satisfied); root threads and
      // every subsequent turn are unaffected. Keying purely off current
      // dep-satisfaction preserves the override path: clearing a child's deps
      // lets the dispatcher auto-promote it.
      if (
        targetThread.parentThreadId !== null &&
        !targetThread.messages.some((message) => message.role === "user") &&
        !areDependenciesSatisfied(
          targetThread,
          new Map(readModel.threads.map((thread) => [thread.id, thread] as const)),
        )
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Sub-thread '${command.threadId}' cannot start its first turn until every dependency is done.`,
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
      // Gate reopen (review-gates design §5.2): the SINGLE transition out of
      // `done`. Server-only (the dispatcher's gate pass sets it when looping
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
      // Sticky terminal (design §3.4/§6): a turn-start on a `done`/`cancelled`
      // thread is a re-engagement — it changes neither the plan lane nor stored
      // attention; runtime alone reflects the activity.
      const targetTerminal =
        targetThread.planLane === "done" || targetThread.planLane === "cancelled";
      const trailingEvents: Array<Omit<OrchestrationEvent, "sequence">> = [];
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
      // Reopen observability (design §5.2/R3): a STARTED dependent is never
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
      return [userMessageEvent, turnStartRequestedEvent, ...trailingEvents];
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
      // No-silent-halt (design §6.1). A HUMAN stop (bare commandId) of a
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
        type: "thread.user-input-response-requested",
        payload: {
          threadId: command.threadId,
          requestId: command.requestId,
          answers: command.answers,
          createdAt: command.createdAt,
        },
      };
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
        type: "thread.session-stop-requested",
        payload: {
          threadId: command.threadId,
          createdAt: command.createdAt,
        },
      };
    }

    case "thread.session.set": {
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
          metadata: {},
        })),
        type: "thread.session-set",
        payload: {
          threadId: command.threadId,
          session: command.session,
        },
      };
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

    // v2: streaming reasoning chunks are transient (ReasoningStreamBus) and
    // never become domain events. The only durable reasoning event is the
    // completion, carrying the full accumulated text with REPLACE semantics.
    case "thread.message.reasoning.complete": {
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
        type: "thread.message-reasoning",
        payload: {
          threadId: command.threadId,
          messageId: command.messageId,
          turnId: command.turnId ?? null,
          reasoningText: command.reasoningText,
          reasoningStreaming: false,
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

    // Review gates (design §3/§4): the single terminal call. One transaction
    // emits the report pointer, the structured outcome record, and the events
    // the routing decision implies — lane changes, attention, or a gate
    // traversal (`thread.route-taken`) the dispatcher's gate pass executes. The
    // routing decision itself is the shared pure `routeWorkSubmit` (also
    // mirrored by the submit endpoint for its response echo).
    case "thread.work.submit": {
      const submitThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Terminal-lane guard: a submit landing on a terminal thread never flips
      // lanes — cancelled stays dead (mirroring reopen's never-from-cancelled)
      // and a done thread has already completed.
      if (submitThread.planLane === "done" || submitThread.planLane === "cancelled") {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is ${submitThread.planLane}; workstream_submit cannot act on a terminal thread.`,
        });
      }
      const occurredAt = yield* nowIso;
      const outcome = command.outcome ?? "done";
      const routing = routeWorkSubmit(
        submitThread,
        readModel.threads.filter((thread) => thread.deletedAt === null),
        outcome,
      );
      const decision = routing.decision;
      const reportSetEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.report-set",
        payload: {
          threadId: command.threadId,
          reportPath: command.reportPath,
          updatedAt: occurredAt,
        },
      };
      const outcomeRecordedEvent: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        causationEventId: reportSetEvent.eventId,
        type: "thread.outcome-recorded",
        payload: {
          threadId: command.threadId,
          outcome,
          decision,
          round: routing.round,
          ...(command.contested !== undefined ? { contested: command.contested } : {}),
          ...(command.counts !== undefined ? { counts: command.counts } : {}),
          updatedAt: occurredAt,
        },
      };
      const events: PlannedOrchestrationEvent[] = [reportSetEvent, outcomeRecordedEvent];
      // `done` lane + attention-clear pair for one party (the same invariant
      // as a direct plan-lane.set done).
      const completeParty = (threadId: typeof command.threadId, hadAttention: boolean) =>
        Effect.gen(function* () {
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: threadId,
              occurredAt,
              commandId: command.commandId,
            })),
            causationEventId: outcomeRecordedEvent.eventId,
            type: "thread.plan-lane-set",
            payload: { threadId, planLane: "done", updatedAt: occurredAt },
          });
          if (hadAttention) {
            events.push({
              ...(yield* withEventBase({
                aggregateKind: "thread",
                aggregateId: threadId,
                occurredAt,
                commandId: command.commandId,
              })),
              causationEventId: outcomeRecordedEvent.eventId,
              type: "thread.attention-cleared",
              payload: { threadId, updatedAt: occurredAt },
            });
          }
        });
      if (decision === "terminal") {
        yield* completeParty(command.threadId, submitThread.attention.length > 0);
      } else if (decision === "resolve") {
        // Gate resolution (design §4.3): BOTH parties complete in one
        // transaction (multi-aggregate, the cancel-cascade precedent). The
        // counterpart is usually already `done` (round 0, no loop taken) — then
        // only the source's lane event is emitted (`resolveWith` is null).
        yield* completeParty(command.threadId, submitThread.attention.length > 0);
        if (routing.resolveWith !== null) {
          const counterpart = readModel.threads.find((thread) => thread.id === routing.resolveWith);
          yield* completeParty(routing.resolveWith, (counterpart?.attention.length ?? 0) > 0);
        }
      } else if (decision === "loop") {
        // Loop traversal (design §4.3): the submitter's lane is untouched — the
        // source stays `in_progress` waiting in the gate, and an intercepted
        // target `done` stays `in_progress` (it is NOT done while rework is
        // routed). The dispatcher's gate pass reacts to the traversal.
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          causationEventId: outcomeRecordedEvent.eventId,
          type: "thread.route-taken",
          payload: {
            threadId: command.threadId,
            to: routing.routeTo!,
            round: routing.round,
            updatedAt: occurredAt,
          },
        });
      } else if (decision === "attention") {
        // `needs_human`: sugar for the existing human flag — lane untouched.
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          causationEventId: outcomeRecordedEvent.eventId,
          type: "thread.attention-raised",
          payload: {
            threadId: command.threadId,
            reason: "needs_guidance",
            updatedAt: occurredAt,
          },
        });
      } else {
        // `yield` (unknown outcome / dead loop target, the load-bearing safe
        // default, design §3.3) and `cap-breach` (rounds exhausted, design
        // §4.3) both park the thread turn-over: lane `yielded`, neither
        // terminal nor releasing. The dispatcher's yield rail wakes the parent
        // (with both parties' reports on a cap breach).
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          causationEventId: outcomeRecordedEvent.eventId,
          type: "thread.plan-lane-set",
          payload: { threadId: command.threadId, planLane: "yielded", updatedAt: occurredAt },
        });
      }
      return events;
    }

    case "thread.activity.append": {
      yield* requireThread({
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
      return {
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
    }

    // Worktree isolation (design §3): record an isolated child's fan-in
    // settlement. Emitted by the WorkstreamFanInReactor after merging the
    // child branch back into the parent branch. Pure passthrough — the
    // projector maps it onto `fanInState`; the dependency/wake gates read it.
    case "thread.fanin.set": {
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
        type: "thread.fanin-set",
        payload: {
          threadId: command.threadId,
          fanInState: command.fanInState,
          updatedAt: command.createdAt,
        },
      };
    }

    case "thread.turn-start.fail": {
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
        type: "thread.turn-start-failed",
        payload: {
          threadId: command.threadId,
          detail: command.detail,
          createdAt: command.createdAt,
        },
      };
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
