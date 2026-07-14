// Loom (fork) projector cases relocated out of the upstream-owned `projector.ts`
// so upstream merges touch a single delegation guard instead of ~430 lines of
// interleaved fork event projection. See
// `plans/2026-07-07-fork-seam-campaign.md` (Slice B §B.5).
//
// MODULE CYCLE (deliberate & safe): this file imports `decodeForEvent` /
// `updateThread` / `MAX_THREAD_MESSAGES` from `projector.ts`, and `projector.ts`
// imports `projectLoomEvent` back from here. Both directions are referenced
// only inside function bodies (call time), never at module init.

import type {
  AttentionReason,
  LegacyThreadStatus,
  OrchestrationGoal,
  OrchestrationReadModel,
  LoomOrchestrationEvent,
  ThreadPlanLane,
} from "@t3tools/contracts";
import { areDependenciesSatisfied } from "@t3tools/shared/workstreamDependencies";
import { gateLoopTargetOf, gateSourceFor } from "@t3tools/shared/workstreamGraph";
import { OrchestrationMessage } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OrchestrationProjectorDecodeError } from "./Errors.ts";
import {
  ThreadMessageReasoningPayload,
  ThreadStatusSetPayload,
  ThreadPlanLaneSetPayload,
  ThreadAttentionRaisedPayload,
  ThreadAttentionClearedPayload,
  ThreadDependenciesSetPayload,
  ThreadFanInSetPayload,
  ThreadReportSetPayload,
  ThreadKickoffBriefSetPayload,
  ThreadOutcomeRecordedPayload,
  ThreadRouteTakenPayload,
  GoalCreatedPayload,
  GoalMetaUpdatedPayload,
  GoalArchivedPayload,
  GoalUnarchivedPayload,
  GoalDeletedPayload,
  GoalTaskCreatedPayload,
  GoalTaskUpdatedPayload,
  GoalTaskDeletedPayload,
} from "./Schemas.ts";
import {
  buildGoalTaskTree,
  collectSubtreeIds,
  flattenGoalTasks,
  type FlatGoalTask,
} from "./goalTaskTree.ts";
// See the module-cycle note above: these are upstream bindings that stay in
// `projector.ts`; they are only ever referenced inside the function body below.
import { decodeForEvent, updateThread, MAX_THREAD_MESSAGES } from "./projector.ts";

/**
 * Migration-only (design §9): remap a legacy `thread.status-set` into the new
 * planLane/attention axes. Pure; the deps-unmet branch of `blocked` is decided
 * by the caller (which has the read model) and passed as `depsSatisfied`.
 * `error`/`review`/`blocked` are additive on the attention set so a thread that
 * already carries a flag keeps it.
 */
export const remapLegacyStatus = (input: {
  readonly planLane: ThreadPlanLane;
  readonly attention: ReadonlyArray<AttentionReason>;
  readonly status: LegacyThreadStatus;
  readonly depsSatisfied: boolean;
}): { readonly planLane: ThreadPlanLane; readonly attention: ReadonlyArray<AttentionReason> } => {
  const withReason = (reason: AttentionReason): ReadonlyArray<AttentionReason> =>
    input.attention.includes(reason) ? input.attention : [...input.attention, reason];
  switch (input.status) {
    case "planned":
      return { planLane: "planned", attention: input.attention };
    case "running":
      return { planLane: "in_progress", attention: input.attention };
    case "done":
      return { planLane: "done", attention: [] };
    case "error":
      return { planLane: "in_progress", attention: withReason("error") };
    case "review":
      return { planLane: "in_progress", attention: withReason("awaiting_acceptance") };
    case "blocked":
      // Lane → `ready` (matches SQL migration 042 so the two migration paths
      // agree and a rebuilt legacy `blocked` thread is not stranded held at
      // `planned`): with unmet deps it is board-blocked (derived) and runs once
      // they clear; with deps satisfied it was paused on a human, so also flag
      // `needs_guidance` (a cosmetic flag that self-clears on the next
      // turn-start — the lane is the load-bearing part).
      return input.depsSatisfied
        ? { planLane: "ready", attention: withReason("needs_guidance") }
        : { planLane: "ready", attention: input.attention };
  }
};

function updateGoalTasks(
  goal: OrchestrationGoal,
  occurredAt: string,
  mutate: (flat: FlatGoalTask[]) => FlatGoalTask[],
): OrchestrationGoal {
  return {
    ...goal,
    tasks: buildGoalTaskTree(mutate(flattenGoalTasks(goal.tasks))),
    updatedAt: occurredAt,
  };
}

/**
 * Fork event projection. Called by `projectEvent` (after it has built
 * `nextBase`) for every event the fork adds — goal.*, the plan-lane/attention/
 * dependencies/report/outcome/route/fanin thread events, the legacy
 * `thread.status-set` migration remap, and `thread.message-reasoning`. Events
 * with no case (`thread.turn-start-failed`, `thread.consult-recorded`) fall to
 * the default, returning the model unchanged — identical to the upstream
 * projector's default for those types.
 */
export function projectLoomEvent(
  nextBase: OrchestrationReadModel,
  event: LoomOrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "goal.created":
      return decodeForEvent(GoalCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = nextBase.goals.find((entry) => entry.id === payload.goalId);
          const goal: OrchestrationGoal = {
            id: payload.goalId,
            projectId: payload.projectId,
            slug: payload.slug,
            title: payload.title,
            titleProvenance: payload.titleProvenance ?? "curated", // loom: §4
            description: payload.description,
            tasks: [],
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            deletedAt: null,
          };
          return {
            ...nextBase,
            goals: existing
              ? nextBase.goals.map((entry) => (entry.id === goal.id ? goal : entry))
              : [...nextBase.goals, goal],
          };
        }),
      );

    case "goal.meta-updated":
      return decodeForEvent(GoalMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) =>
            goal.id === payload.goalId
              ? {
                  ...goal,
                  ...(payload.slug !== undefined ? { slug: payload.slug } : {}),
                  ...(payload.title !== undefined ? { title: payload.title } : {}),
                  ...(payload.titleProvenance !== undefined
                    ? { titleProvenance: payload.titleProvenance }
                    : {}),
                  ...(payload.description !== undefined
                    ? { description: payload.description }
                    : {}),
                  updatedAt: payload.updatedAt,
                }
              : goal,
          ),
        })),
      );

    case "goal.archived":
      return decodeForEvent(GoalArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) =>
            goal.id === payload.goalId
              ? { ...goal, archivedAt: payload.archivedAt, updatedAt: payload.updatedAt }
              : goal,
          ),
        })),
      );

    case "goal.unarchived":
      return decodeForEvent(GoalUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) =>
            goal.id === payload.goalId
              ? { ...goal, archivedAt: null, updatedAt: payload.updatedAt }
              : goal,
          ),
        })),
      );

    case "goal.deleted":
      return decodeForEvent(GoalDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) =>
            goal.id === payload.goalId
              ? { ...goal, deletedAt: payload.deletedAt, updatedAt: payload.deletedAt }
              : goal,
          ),
        })),
      );

    case "goal.task-created":
      return decodeForEvent(GoalTaskCreatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) =>
            goal.id === payload.goalId
              ? updateGoalTasks(goal, payload.updatedAt, (flat) => [
                  ...flat,
                  {
                    id: payload.taskId,
                    goalId: payload.goalId,
                    parentTaskId: payload.parentTaskId,
                    text: payload.text,
                    done: false,
                    position: payload.position,
                    createdAt: payload.createdAt,
                    updatedAt: payload.updatedAt,
                  },
                ])
              : goal,
          ),
        })),
      );

    case "goal.task-updated":
      return decodeForEvent(GoalTaskUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) =>
            goal.id === payload.goalId
              ? updateGoalTasks(goal, payload.updatedAt, (flat) =>
                  flat.map((task) =>
                    task.id === payload.taskId
                      ? {
                          ...task,
                          ...(payload.text !== undefined ? { text: payload.text } : {}),
                          ...(payload.done !== undefined ? { done: payload.done } : {}),
                          ...(payload.position !== undefined ? { position: payload.position } : {}),
                          updatedAt: payload.updatedAt,
                        }
                      : task,
                  ),
                )
              : goal,
          ),
        })),
      );

    case "goal.task-deleted":
      return decodeForEvent(GoalTaskDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          goals: nextBase.goals.map((goal) => {
            if (goal.id !== payload.goalId) return goal;
            const flat = flattenGoalTasks(goal.tasks);
            const removed = collectSubtreeIds(flat, payload.taskId);
            return updateGoalTasks(goal, payload.deletedAt, (current) =>
              current.filter((task) => !removed.has(task.id)),
            );
          }),
        })),
      );

    case "thread.plan-lane-set":
      return decodeForEvent(ThreadPlanLaneSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          // Review gates (2026-07-07/08 incident): a gate SOURCE going TERMINAL
          // via a lane-set dissolves the gate (design §4.1/§5.4: unresolved only
          // while the source is non-terminal — a parent `set_lane(done|cancelled)`
          // on the reviewer dissolves it). Clear the loop target's residual
          // `pendingRework` so the coder's later hand-back does not route into a
          // dead gate (deadlock) — and, critically, so a re-spawned replacement
          // reviewer over the same coder is not mis-seen as the live
          // `gateSourceFor` and handed an orphaned round-0 loop it never issued
          // (the wedge class the review flagged for the `set_lane(done)` path).
          // Applies to BOTH terminal lanes: on the normal resolve path the coder
          // is either already `pendingRework=false` or completing in the same
          // transaction, so it is a harmless no-op there. The source keeps its
          // loop route on this transition, so `gateLoopTargetOf` still finds the
          // target it looped to.
          const dissolvedTargetId =
            payload.planLane === "cancelled" || payload.planLane === "done"
              ? gateLoopTargetOf(
                  nextBase.threads.find((t) => t.id === payload.threadId) ?? { routes: [] },
                )
              : null;
          const threadsWithDissolvedRound =
            dissolvedTargetId !== null &&
            nextBase.threads.find((t) => t.id === dissolvedTargetId)?.pendingRework === true
              ? updateThread(nextBase.threads, dissolvedTargetId, {
                  pendingRework: false,
                  updatedAt: payload.updatedAt,
                })
              : nextBase.threads;
          return {
            ...nextBase,
            threads: updateThread(threadsWithDissolvedRound, payload.threadId, {
              planLane: payload.planLane,
              // Re-engagement epoch: a terminal→ready/planned reopen carries a
              // fresh spawnGeneration so the re-run's completion joins a new
              // generation (and fires a new parent wake) instead of being deduped
              // by the first completion's receipt.
              ...(payload.spawnGeneration !== undefined
                ? { spawnGeneration: payload.spawnGeneration }
                : {}),
              // Design §3 state invariant, enforced structurally: a terminal lane
              // (`done`/`cancelled`) carries no stored attention. The decider emits
              // an explicit `attention-cleared` on new terminal transitions, but
              // this guard also backfills threads whose terminal transition predates
              // that fix (replayed from history) and is robust to any event ordering
              // (e.g. an `error` raised after `done`). Mirrors `remapLegacyStatus`
              // (`done → attention: []`). Derived `awaiting_*` reasons are projected
              // separately and unaffected.
              ...(payload.planLane === "done" || payload.planLane === "cancelled"
                ? { attention: [] }
                : {}),
              // Worktree isolation (design §3 step 5): fan-in settlement only
              // applies while the thread is `done`. Leaving `done` for a
              // non-terminal lane (a gate reopen, or an orchestrator re-opening a
              // `conflicted` child to resolve + resubmit) clears `fanInState` back
              // to `none`, so the resubmit's `done` re-arms the fan-in sweep
              // instead of the child staying wedged as a permanent `conflicted`.
              ...(payload.planLane !== "done" && payload.planLane !== "cancelled"
                ? {
                    fanInState: "none" as const,
                    // Review gates (design §4.3): manual gate recovery. Reopening a
                    // rework TARGET to a non-terminal lane (the documented
                    // `set_lane(coder, ready)` recovery move) restores its
                    // `pendingRework` when a non-terminal gate source still owes it
                    // an unresolved rework round — i.e. the source looped its
                    // findings back (`lastOutcome.decision === "loop"`) and awaits
                    // rework. Without this the reopened target's next submission
                    // escapes the gate as plain terminal/yield instead of looping
                    // back to the reviewer (the incident's round-2 `done` escape).
                    // A dissolved gate (source terminal/cancelled ⇒ no
                    // `gateSourceFor`) or a source that never looped restores
                    // nothing, so an orchestrator detaching a coder from a dead gate
                    // still works as before.
                    ...(gateSourceFor(payload.threadId, nextBase.threads)?.lastOutcome?.decision ===
                    "loop"
                      ? { pendingRework: true }
                      : {}),
                  }
                : {}),
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.attention-raised":
      return decodeForEvent(
        ThreadAttentionRaisedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              attention: thread.attention.includes(payload.reason)
                ? thread.attention
                : [...thread.attention, payload.reason],
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.attention-cleared":
      return decodeForEvent(
        ThreadAttentionClearedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          // Omitted reason → clear all stored attention; a present reason clears
          // just that flag.
          const attention =
            payload.reason === undefined
              ? []
              : thread.attention.filter((reason) => reason !== payload.reason);
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              attention,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    // Migration-only (design §9): historical event remapped onto the new axes.
    case "thread.status-set":
      return decodeForEvent(ThreadStatusSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
          if (!thread) return nextBase;
          const remapped = remapLegacyStatus({
            planLane: thread.planLane,
            attention: thread.attention,
            status: payload.status,
            depsSatisfied: areDependenciesSatisfied(
              thread,
              new Map(nextBase.threads.map((entry) => [entry.id, entry] as const)),
            ),
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              planLane: remapped.planLane,
              attention: remapped.attention,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );

    case "thread.dependencies-set":
      return decodeForEvent(
        ThreadDependenciesSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            blockedBy: payload.blockedBy,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.report-set":
      return decodeForEvent(ThreadReportSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            reportPath: payload.reportPath,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    // Scaffold-first graph authoring: attach the on-disk kickoff-brief pointer.
    // Pre-launch overwrites are ordinary re-emits (last write wins).
    case "thread.kickoff-brief-set":
      return decodeForEvent(
        ThreadKickoffBriefSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            kickoffBriefPath: payload.kickoffBriefPath,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    // Review gates (design §3.2): record the submitted outcome + routing verdict
    // on the thread. `recordedByEventId` keys the dispatcher's per-yield-episode
    // wake dedup. Any recorded outcome also closes an open rework round on the
    // thread (design §4.3: `pendingRework` cleared by the next submit).
    case "thread.outcome-recorded":
      return decodeForEvent(
        ThreadOutcomeRecordedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            lastOutcome: {
              outcome: payload.outcome,
              decision: payload.decision,
              round: payload.round,
              ...(payload.contested !== undefined ? { contested: payload.contested } : {}),
              ...(payload.counts !== undefined ? { counts: payload.counts } : {}),
              recordedByEventId: event.eventId,
              at: payload.updatedAt,
            },
            pendingRework: false,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    // Review gates (design §4.3/§4.4): a control-plane loop traversal. A
    // loop-EDGE traversal (the source carries a loop route naming `to`) opens a
    // rework round on the target and advances the source's round counter; the
    // reverse (re-verify) traversal advances neither. Nothing emits this event
    // until Phase 3 wires routing.
    case "thread.route-taken":
      return decodeForEvent(ThreadRouteTakenPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const from = nextBase.threads.find((entry) => entry.id === payload.threadId);
          const isLoopTraversal =
            from?.routes.some((route) => route.kind === "loop" && route.to === payload.to) ?? false;
          if (!isLoopTraversal) return nextBase;
          return {
            ...nextBase,
            threads: updateThread(
              updateThread(nextBase.threads, payload.to, {
                pendingRework: true,
                updatedAt: payload.updatedAt,
              }),
              payload.threadId,
              { gateRounds: payload.round, updatedAt: payload.updatedAt },
            ),
          };
        }),
      );

    // Worktree isolation (design §3): the projected fan-in settlement for an
    // isolated child after its branch is merged back into the parent branch.
    case "thread.fanin-set":
      return decodeForEvent(ThreadFanInSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            fanInState: payload.fanInState,
            updatedAt: payload.updatedAt,
          }),
        })),
      );

    case "thread.message-reasoning":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadMessageReasoningPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = nextBase.threads.find((entry) => entry.id === payload.threadId);
        if (!thread) {
          return nextBase;
        }

        // v2 REPLACE semantics: the durable event carries the full accumulated
        // reasoning text, so set it directly (never append).
        const existingMessage = thread.messages.find((entry) => entry.id === payload.messageId);
        const messages = existingMessage
          ? thread.messages.map((entry) =>
              entry.id === payload.messageId
                ? {
                    ...entry,
                    reasoningText: payload.reasoningText,
                    reasoningStreaming: payload.reasoningStreaming,
                    updatedAt: payload.updatedAt,
                  }
                : entry,
            )
          : [
              ...thread.messages,
              yield* decodeForEvent(
                OrchestrationMessage,
                {
                  id: payload.messageId,
                  role: "assistant",
                  text: "",
                  turnId: payload.turnId,
                  streaming: true,
                  reasoningText: payload.reasoningText,
                  reasoningStreaming: payload.reasoningStreaming,
                  createdAt: payload.createdAt,
                  updatedAt: payload.updatedAt,
                },
                event.type,
                "message",
              ),
            ];
        const cappedMessages = messages.slice(-MAX_THREAD_MESSAGES);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });

    default:
      return Effect.succeed(nextBase);
  }
}
