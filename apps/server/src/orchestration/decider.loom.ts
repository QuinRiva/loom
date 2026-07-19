// Loom (fork) decider cases relocated out of the upstream-owned `decider.ts`
// so upstream merges touch a single delegation guard instead of ~900 lines of
// interleaved fork command handling. See
// `plans/2026-07-07-fork-seam-campaign.md` (Slice B §B.2).
//
// MODULE CYCLE (deliberate & safe): this file imports `withEventBase` /
// `decideCommandSequence` / `PlannedOrchestrationEvent` from `decider.ts`, and
// `decider.ts` imports `decideLoomCommand` / `dependencyCoherenceError` back
// from here. Both directions are referenced ONLY inside function bodies (call
// time), never during module init, so there is no TDZ hazard. The cycle is
// required because the goal archive/unarchive/delete cascades route through
// `decideCommandSequence` into upstream `thread.*` commands, and upstream
// `project.delete` cascades back into `goal.delete`.

import {
  EventId,
  type GoalId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  type LoomOrchestrationCommand,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";

import { OrchestrationCommandInvariantError } from "./Errors.ts";
import { requireProject, requireThread, requireThreadAbsent } from "./commandInvariants.ts";
import {
  requireGoal,
  requireGoalAbsent,
  requireGoalActive,
  requireGoalNotDeleted,
  requireGoalParentTask,
  requireGoalTask,
  requireGoalTaskAbsent,
  requireUniqueGoalSlug,
} from "./commandInvariants.loom.ts";
import { flattenGoalTasks } from "./goalTaskTree.ts";
import { findDependencyCycle } from "@t3tools/shared/workstreamDependencies";
import { gateSourceFor, routeWorkSubmit } from "@t3tools/shared/workstreamGraph";
// See the module-cycle note above: these are upstream bindings that stay in
// `decider.ts`; they are only ever referenced inside the function bodies below.
// `collectLiveSubtreeIds` is the shared live-subtree sweep (goal/thread cascades
// live there; the cancel cascade below reuses it).
import {
  collectLiveSubtreeIds,
  withEventBase,
  decideCommandSequence,
  type PlannedOrchestrationEvent,
} from "./decider.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

type DecideLoomCommandResult = PlannedOrchestrationEvent | ReadonlyArray<PlannedOrchestrationEvent>;

/**
 * Coherence backstop shared by `thread.create` and `thread.dependencies.set` —
 * the decider is the one chokepoint every command crosses, including the web
 * board / client-runtime paths that dispatch these commands directly and bypass
 * the MCP handlers. Returns a rejection detail, or null when the proposed
 * dependency edges are coherent. Mirrors exactly the sibling-scoped edges
 * `areDependenciesSatisfied` gates on: an edge only counts when it names an
 * active (non-deleted, non-archived) same-parent sibling, so anything else —
 * self, root, dangling/non-sibling, or a cycle — never releases and is rejected
 * at the submission boundary rather than silently tolerated at runtime. Called
 * only when the command actually carries edges; the common empty-`blockedBy`
 * create/clear path never reaches it.
 */
export const dependencyCoherenceError = (params: {
  readonly readModel: OrchestrationReadModel;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly blockedBy: ReadonlyArray<ThreadId>;
  readonly loopTargets: ReadonlyArray<ThreadId>;
}): string | null => {
  const { readModel, threadId, parentThreadId, blockedBy, loopTargets } = params;
  if (parentThreadId === null)
    return `Dependencies have no effect on a root thread ('${threadId}') — only sub-threads are dependency-gated.`;
  if (blockedBy.includes(threadId)) return `A thread cannot block on itself ('${threadId}').`;
  const siblings = readModel.threads.filter(
    (thread) =>
      thread.deletedAt === null &&
      thread.archivedAt === null &&
      thread.parentThreadId === parentThreadId &&
      thread.id !== threadId,
  );
  const siblingIds = new Set(siblings.map((thread) => thread.id));
  const invalid = [...new Set([...blockedBy, ...loopTargets])].filter(
    (id) => id !== threadId && !siblingIds.has(id),
  );
  if (invalid.length > 0)
    return `Dependencies for thread '${threadId}' name non-sibling/unknown ids (${invalid.join(", ")}); a dependency can only name an active sibling (same parent). A dangling id never gates — it would silently release.`;
  const cycle = findDependencyCycle([
    { id: threadId, parentThreadId, blockedBy },
    ...siblings.map((thread) => ({
      id: thread.id,
      parentThreadId: thread.parentThreadId,
      blockedBy: thread.blockedBy,
    })),
  ]);
  if (cycle !== null)
    return `Dependencies for thread '${threadId}' would create a cycle (${cycle.join(" → ")}); a cyclic set can never release.`;
  return null;
};

/**
 * The subtree ROOTS of a goal's threads in a given state: matching threads
 * with no matching ANCESTOR reachable through live (non-deleted) parents. The
 * goal-level cascades (goal.archive/unarchive/delete) enumerate only these —
 * each root's own thread-level cascade (in `decider.ts`) sweeps its live
 * subtree, so enumerating a thread already inside another root's subtree would
 * double-apply the operation and trip an invariant mid-sequence. The ancestor
 * walk mirrors `collectLiveSubtreeIds`: it stops at a deleted parent, exactly
 * where the downward sweep stops too.
 */
const listGoalSubtreeRoots = (
  readModel: OrchestrationReadModel,
  goalId: GoalId,
  state: "active" | "archived" | "live",
) => {
  const matches = readModel.threads.filter(
    (thread) =>
      thread.goalId === goalId &&
      thread.deletedAt === null &&
      (state === "live" ||
        (state === "active" ? thread.archivedAt === null : thread.archivedAt !== null)),
  );
  const matchIds = new Set(matches.map((thread) => thread.id));
  const threadById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
  const hasMatchingAncestor = (thread: (typeof matches)[number]): boolean => {
    for (
      let parent =
        thread.parentThreadId !== null ? threadById.get(thread.parentThreadId) : undefined;
      parent !== undefined && parent.deletedAt === null;
      parent = parent.parentThreadId !== null ? threadById.get(parent.parentThreadId) : undefined
    ) {
      if (matchIds.has(parent.id)) return true;
    }
    return false;
  };
  return matches.filter((thread) => !hasMatchingAncestor(thread));
};

export const decideLoomCommand = Effect.fn("decideLoomCommand")(function* ({
  command,
  readModel,
}: {
  readonly command: LoomOrchestrationCommand;
  readonly readModel: OrchestrationReadModel;
}): Effect.fn.Return<
  DecideLoomCommandResult,
  OrchestrationCommandInvariantError | PlatformError.PlatformError,
  Crypto.Crypto
> {
  switch (command.type) {
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
          // loom: §4 title provenance. Goal titles always carry a real subject, so
          // an unspecified provenance defaults to `curated`; the emergent-goal
          // auto-create passes `derived` explicitly.
          titleProvenance: command.titleProvenance ?? "curated",
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
          // loom: §4 a direct goal.meta.update (goal_update tool) is a curated
          // rename unless the caller states otherwise.
          ...(command.title !== undefined
            ? { title: command.title, titleProvenance: command.titleProvenance ?? "curated" }
            : {}),
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
      // Only subtree ROOTS are enumerated — thread.archive sweeps each root's
      // descendants itself, so listing a child too would double-archive it and
      // trip requireThreadNotArchived mid-sequence.
      const activeThreads = listGoalSubtreeRoots(readModel, command.goalId, "active");
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
      // Inverse of goal.archive: unarchive every archived subtree root, and the
      // first thread.unarchive cascades the goal unarchive (see
      // thread.unarchive). Descendants are restored by each root's own cascade.
      const archivedThreads = listGoalSubtreeRoots(readModel, command.goalId, "archived");
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
      // Deleting a goal cascade-deletes its live subtree roots (the goal owns
      // them; thread.delete sweeps each root's descendants and cascades the
      // goal delete itself once the goal is empty — see thread.delete). The
      // empty-goal case below emits the leaf directly.
      const threads = listGoalSubtreeRoots(readModel, command.goalId, "live");
      if (threads.length > 0) {
        return yield* decideCommandSequence({
          readModel,
          commands: threads.map(
            (thread): Extract<OrchestrationCommand, { type: "thread.delete" }> => ({
              type: "thread.delete",
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
        // Transitive closure of the live subtree under the target (shared sweep).
        const subtree = collectLiveSubtreeIds(readModel, command.threadId);
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
        // M4 (dep-cancelled-then-edge ordering): a live thread OUTSIDE the
        // cancelled subtree that is un-started, still `planned`/`ready`, and
        // gated (same-parent `blockedBy`) on a member of the cancelled set is
        // now wedged forever — cancelled never releases. Surface each on the
        // "a human must look" channel so the orchestrator that issued the cancel
        // is woken to re-plan. Cancel itself always succeeds regardless.
        for (const thread of live) {
          if (subtree.has(thread.id)) continue;
          if (thread.planLane !== "planned" && thread.planLane !== "ready") continue;
          if (thread.messages.some((message) => message.role === "user")) continue;
          const gatedByCancelled = thread.blockedBy.some(
            (depId) =>
              subtree.has(depId) && threadById.get(depId)?.parentThreadId === thread.parentThreadId,
          );
          if (!gatedByCancelled) continue;
          events.push({
            ...(yield* withEventBase({
              aggregateKind: "thread",
              aggregateId: thread.id,
              occurredAt,
              commandId: command.commandId,
            })),
            type: "thread.attention-raised",
            payload: { threadId: thread.id, reason: "needs_guidance", updatedAt: occurredAt },
          });
        }
        return events;
      }
      // Re-engagement epoch (review-gates design §5.2 exception): a parent or
      // human reopening a terminal thread via the lane-set path (done/cancelled
      // → ready/planned) stamps a FRESH spawnGeneration in the same event. The
      // dispatcher's delta rail marks a reported child durably by
      // `(childId, terminalEpisodeKey)`, where the episode is the child's latest
      // outcome-event id and FALLS BACK to `spawnGeneration`. A re-cancelled
      // reopen with no fresh submit therefore relies on this new epoch to re-arm
      // (its outcome id is unchanged, so only the fresh spawnGeneration makes the
      // re-run report as news); a re-submitted reopen re-arms via the new outcome
      // id regardless. A gate `reopen` deliberately does NOT pass here — it flows
      // through `thread.turn.start` + `reopen`, and its re-submit records a fresh
      // outcome id that re-arms the marker.
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
      const laneTrailingEvents: PlannedOrchestrationEvent[] = [];
      if (command.planLane === "done" && laneThread.attention.length > 0) {
        laneTrailingEvents.push({
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
        });
      }
      // Gate observability (2026-07-07 incident): a parent force-`done` on a
      // rework TARGET while its round is open (decision 9 keeps the write
      // legal) does NOT resolve the gate — the source still awaits the
      // hand-back, and the target's next submit is still intercepted back to
      // it. Warn the parent so "accepting the coder" is not mistaken for
      // resolving the review: dissolving is a reviewer-side `done`/`cancelled`.
      const openReworkSource =
        command.planLane === "done" && laneThread.pendingRework && laneThread.planLane !== "done"
          ? gateSourceFor(
              command.threadId,
              readModel.threads.filter((thread) => thread.deletedAt === null),
            )
          : null;
      if (openReworkSource !== null && laneThread.parentThreadId !== null) {
        const activityId = yield* Crypto.Crypto.pipe(
          Effect.flatMap((crypto) => crypto.randomUUIDv4),
        );
        laneTrailingEvents.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: laneThread.parentThreadId,
            occurredAt,
            commandId: command.commandId,
          })),
          causationEventId: planLaneSetEvent.eventId,
          type: "thread.activity-appended",
          payload: {
            threadId: laneThread.parentThreadId,
            activity: {
              id: EventId.make(activityId),
              tone: "error",
              kind: "workstream.gate.target-done-mid-round",
              summary: `Warning: '${laneThread.title}' (${command.threadId}) was set done while its review gate's rework round is open. The gate is NOT resolved — its next submit still routes to reviewer '${openReworkSource.id}' for re-verification. To dissolve the gate instead, set the reviewer done/cancelled.`,
              payload: {
                targetThreadId: command.threadId,
                gateSourceThreadId: openReworkSource.id,
              },
              turnId: null,
              createdAt: occurredAt,
            },
          },
        });
      }
      return laneTrailingEvents.length > 0
        ? [planLaneSetEvent, ...laneTrailingEvents]
        : planLaneSetEvent;
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
      const targetThread = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      // Coherence backstop (R1/R2): a non-empty replace-set must name active
      // siblings and form no cycle. Clearing deps (empty set) is always allowed.
      if (command.blockedBy.length > 0) {
        const detail = dependencyCoherenceError({
          readModel,
          threadId: command.threadId,
          parentThreadId: targetThread.parentThreadId,
          blockedBy: command.blockedBy,
          loopTargets: [],
        });
        if (detail !== null)
          return yield* new OrchestrationCommandInvariantError({
            commandType: command.type,
            detail,
          });
      }
      const occurredAt = yield* nowIso;
      const dependenciesSet: PlannedOrchestrationEvent = {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt,
          commandId: command.commandId,
        })),
        type: "thread.dependencies-set",
        payload: {
          // Replace-set semantics; validated above (self/root/dangling/cycle
          // rejected), so the set is recorded verbatim.
          threadId: command.threadId,
          blockedBy: command.blockedBy,
          updatedAt: occurredAt,
        },
      };
      // R3 (M4, edge-onto-cancelled-dep ordering): wiring an un-started,
      // non-terminal target to wait on an already-`cancelled` gating sibling
      // silently wedges it (cancelled never releases). Surface it on the same
      // "a human must look" channel as the cancel-cascade scan below — direct
      // event emission, never re-entering a command handler mid-decide.
      const targetUnstarted = !targetThread.messages.some((message) => message.role === "user");
      const targetTerminal =
        targetThread.planLane === "done" || targetThread.planLane === "cancelled";
      const wedgedByCancelledDep =
        targetUnstarted &&
        !targetTerminal &&
        command.blockedBy.some((depId) => {
          const dep = readModel.threads.find((thread) => thread.id === depId);
          return (
            dep !== undefined &&
            dep.parentThreadId === targetThread.parentThreadId &&
            dep.planLane === "cancelled"
          );
        });
      if (!wedgedByCancelledDep) return dependenciesSet;
      return [
        dependenciesSet,
        {
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: command.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.attention-raised",
          payload: {
            threadId: command.threadId,
            reason: "needs_guidance",
            updatedAt: occurredAt,
          },
        },
      ];
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
      const occurredAt = yield* nowIso;
      const outcome = command.outcome ?? "done";
      const routing = routeWorkSubmit(
        submitThread,
        readModel.threads.filter((thread) => thread.deletedAt === null),
        outcome,
      );
      // Terminal-lane guard: a submit landing on a terminal thread never flips
      // lanes — cancelled stays dead (mirroring reopen's never-from-cancelled)
      // and a done thread has already completed. ONE exception (2026-07-07
      // incident): a `done` rework target whose submit the gate intercepts
      // (open rework round + live source ⇒ decision `loop`). A parent may
      // force-`done` a mid-round coder (decision 9 interruptibility), but that
      // never resolves the gate — the reviewer still awaits the hand-back, so
      // the routed submit must go through or the pair wedges (the coder's
      // report unroutable, the reviewer waiting forever). The loop decision
      // touches no lanes, so sticky-terminal is preserved.
      if (
        (submitThread.planLane === "cancelled" || submitThread.planLane === "done") &&
        !(submitThread.planLane === "done" && routing.decision === "loop")
      ) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is ${submitThread.planLane}; workstream_submit cannot act on a terminal thread.`,
        });
      }
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
        // source stays `in_progress` waiting in the gate, an intercepted
        // target stays `in_progress` (it is NOT done while rework is routed),
        // and a parent-forced `done` target stays `done` (sticky terminal; the
        // routing works regardless). The dispatcher's gate pass reacts to the
        // traversal.
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

    // consult_thread observability: record one resolved consult on the asker
    // thread. Pure passthrough — the SQL projection aggregates edges onto the
    // asker shell and the full question/answer streams to thread-detail
    // subscribers. The target thread's records are deliberately untouched.
    case "thread.consult.record": {
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
        type: "thread.consult-recorded",
        payload: {
          askerThreadId: command.threadId,
          targetThreadId: command.targetThreadId,
          targetTitle: command.targetTitle,
          question: command.question,
          answer: command.answer,
          resolved: command.resolved,
          durationMs: command.durationMs,
          ...(command.forkSessionPath !== undefined
            ? { forkSessionPath: command.forkSessionPath }
            : {}),
          createdAt: command.createdAt,
        },
      };
    }

    // `/handoff` fork-drafter (plan D5): stamp one durable handoff marker on the
    // drafter thread after its `goal_handoff` created the staged destination.
    // Pure passthrough — the projector increments `handoffCount`; the settlement
    // reactor reads it at the drafter's turn end. Idempotency is by commandId
    // (the engine receipt store), so a retried stamp is a no-op.
    case "thread.handoff.record": {
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
        type: "thread.handoff-recorded",
        payload: {
          threadId: command.threadId,
          destinationGoalId: command.destinationGoalId,
          destinationThreadId: command.destinationThreadId,
          createdAt: command.createdAt,
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

    // Scaffold-first graph authoring (plan §1a + `workstream_brief`): attach the
    // on-disk kickoff-brief pointer to a scaffolded child. Permissive by design
    // — the "child has not started yet" precondition is a handler-level check
    // (plan §1a); the decider only guarantees the target is a real sub-thread.
    case "thread.kickoff-brief.set": {
      const target = yield* requireThread({
        readModel,
        command,
        threadId: command.threadId,
      });
      if (target.parentThreadId === null) {
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: `Thread '${command.threadId}' is a root; a kickoff brief applies only to a scaffolded sub-thread (root kickoffs use the handoff 'brief').`,
        });
      }
      return {
        ...(yield* withEventBase({
          aggregateKind: "thread",
          aggregateId: command.threadId,
          occurredAt: command.createdAt,
          commandId: command.commandId,
        })),
        type: "thread.kickoff-brief-set",
        payload: {
          threadId: command.threadId,
          kickoffBriefPath: command.kickoffBriefPath,
          updatedAt: command.createdAt,
        },
      };
    }

    // Scaffold-first graph authoring (plan §0): create a whole child graph
    // atomically. Thread ids are preallocated and blockedBy/gate references are
    // already resolved to ThreadIds by the HTTP handler; this decider owns the
    // transactional graph-consistency validation against the union of the live
    // sibling graph and the batch, then emits every `thread.created` in ONE
    // engine transaction (the engine commits a command's whole event array
    // atomically, so a rejection here creates nothing). Shared per-parent fields
    // (projectId, goalId, runtimeMode, interactionMode, branch, worktreePath) are
    // inherited from the parent thread — exactly what `workstream_spawn` copies
    // from `current`.
    case "thread.scaffold": {
      const parent = yield* requireThread({
        readModel,
        command,
        threadId: command.parentThreadId,
      });
      const occurredAt = command.createdAt;
      const reject = (detail: string) =>
        new OrchestrationCommandInvariantError({ commandType: command.type, detail });

      if (command.nodes.length === 0) {
        return yield* reject("thread.scaffold carried no nodes; nothing to create.");
      }

      // Children of this parent. Key-uniqueness is "unique-forever": it spans
      // every non-deleted child (active AND terminal). Edge targets must resolve
      // to an ACTIVE sibling (non-archived), matching `areDependenciesSatisfied`.
      const parentChildren = readModel.threads.filter(
        (thread) => thread.deletedAt === null && thread.parentThreadId === command.parentThreadId,
      );
      const activeSiblingIds = new Set(
        parentChildren.filter((thread) => thread.archivedAt === null).map((thread) => thread.id),
      );
      const existingKeys = new Set(
        parentChildren
          .map((thread) => thread.graphKey)
          .filter((key): key is string => key !== null),
      );

      // UUID-shaped keys are rejected so a bare thread id pasted without the
      // 'thread:' prefix fails loudly instead of silently becoming a key.
      const uuidShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const batchKeys = new Set<string>();
      const batchIds = new Set<ThreadId>();
      for (const node of command.nodes) {
        if (uuidShaped.test(node.graphKey)) {
          return yield* reject(
            `Scaffold node key '${node.graphKey}' is UUID-shaped; keys must be symbolic (reference an existing thread with the 'thread:' prefix instead).`,
          );
        }
        if (batchKeys.has(node.graphKey)) {
          return yield* reject(
            `Scaffold node key '${node.graphKey}' is duplicated within the batch; keys are unique per parent.`,
          );
        }
        if (existingKeys.has(node.graphKey)) {
          return yield* reject(
            `Scaffold node key '${node.graphKey}' is already used by an existing child of this parent; keys are unique-forever and immutable.`,
          );
        }
        if (batchIds.has(node.threadId)) {
          return yield* reject(
            `Scaffold node key '${node.graphKey}' reuses a thread id already allocated in this batch.`,
          );
        }
        // Preallocated ids must not already exist.
        yield* requireThreadAbsent({ readModel, command, threadId: node.threadId });
        batchKeys.add(node.graphKey);
        batchIds.add(node.threadId);
      }

      // Every blockedBy / gate-loop reference must resolve to a batch member or
      // an active existing sibling (all same-parent), and never to self.
      for (const node of command.nodes) {
        const loopTargets = (node.routes ?? []).flatMap((route) =>
          route.kind === "loop" && route.to !== undefined ? [route.to] : [],
        );
        for (const ref of [...(node.blockedBy ?? []), ...loopTargets]) {
          if (ref === node.threadId) {
            return yield* reject(
              `Scaffold node '${node.graphKey}' cannot depend on / gate itself.`,
            );
          }
          if (!batchIds.has(ref) && !activeSiblingIds.has(ref)) {
            return yield* reject(
              `Scaffold node '${node.graphKey}' references '${ref}', which is neither a node in this batch nor an active sibling of the parent. A dangling reference never gates — it would silently release.`,
            );
          }
        }
      }

      // Cycle check across the union of existing sibling edges + batch edges.
      const cycle = findDependencyCycle([
        ...parentChildren
          .filter((thread) => thread.archivedAt === null)
          .map((thread) => ({
            id: thread.id,
            parentThreadId: thread.parentThreadId,
            blockedBy: thread.blockedBy,
          })),
        ...command.nodes.map((node) => ({
          id: node.threadId,
          parentThreadId: command.parentThreadId,
          blockedBy: node.blockedBy ?? [],
        })),
      ]);
      if (cycle !== null) {
        return yield* reject(
          `Scaffold would create a dependency cycle (${cycle.join(" → ")}); a cyclic set never releases.`,
        );
      }

      // All batch checks passed — emit one thread.created per node. A node is
      // born `ready` unless it names its own lane or the scaffold is `staged`.
      const events: PlannedOrchestrationEvent[] = [];
      for (const node of command.nodes) {
        const planLane = node.planLane ?? (command.staged === true ? "planned" : "ready");
        events.push({
          ...(yield* withEventBase({
            aggregateKind: "thread",
            aggregateId: node.threadId,
            occurredAt,
            commandId: command.commandId,
          })),
          type: "thread.created",
          payload: {
            threadId: node.threadId,
            projectId: parent.projectId,
            goalId: parent.goalId,
            parentThreadId: command.parentThreadId,
            role: node.role,
            purpose: node.purpose,
            graphKey: node.graphKey,
            ...(node.blockedBy !== undefined ? { blockedBy: node.blockedBy } : {}),
            ...(node.routes !== undefined ? { routes: node.routes } : {}),
            ...(node.isolation !== undefined ? { isolation: node.isolation } : {}),
            planLane,
            ...(node.spawnGeneration !== undefined && node.spawnGeneration !== null
              ? { spawnGeneration: node.spawnGeneration }
              : {}),
            ...(node.forkFromThreadId !== undefined && node.forkFromThreadId !== null
              ? { forkFromThreadId: node.forkFromThreadId }
              : {}),
            title: node.title,
            // The scaffold title is a curated label (mirrors workstream_spawn).
            titleProvenance: "curated",
            modelSelection: node.modelSelection,
            runtimeMode: parent.runtimeMode,
            interactionMode: parent.interactionMode,
            branch: parent.branch,
            worktreePath: parent.worktreePath,
            createdAt: occurredAt,
            updatedAt: occurredAt,
          },
        });
      }
      return events;
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
