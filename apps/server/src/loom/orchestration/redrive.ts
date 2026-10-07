/**
 * The re-drive planner (plans/upstream-pull9-phase2-substrate/plan.mdx §4, D3,
 * D16; DL-199, DL-213). The arm writes only to the commanded thread, so every
 * effect on another thread — cancel, archive, unarchive and delete cascades,
 * wedged dependents, goal attach, gate legs — is derived here from sidecar
 * state as one per-thread command with an episode-keyed `server:` id. A
 * receipted id is done (accepted or dead) and never re-sent; a deferral leaves
 * no receipt, so the same id is retried on the next pass.
 *
 * The dispatcher (`dispatcher/WorkstreamDispatcher.ts`) runs the pass first in
 * every control-plane pass, with the real gate-leg composer (`dispatcher/gateLegs.ts`).
 *
 * @module loom/orchestration/redrive
 */
import {
  CommandId,
  type ControlPayload,
  type GoalId,
  type IsoDateTime,
  type LoomAttentionReason,
  type LoomThreadWorkstream,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";
import { descendantsOf } from "@t3tools/shared/workstreamGraph";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  CommandReceiptStoreV2,
  type CommandReceiptStoreV2Error,
} from "../../orchestration-v2/CommandReceiptStore.ts";
import { LOOM_CASCADE_CANCEL_PREFIX } from "../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";

/** Every command the control plane dispatches targets (and locks) one thread. */
export type ThreadServerCommand = Extract<
  OrchestrationV2ServerCommand,
  { readonly threadId: ThreadId }
>;

/** A gate leg that carries a control message (resolve carries none). */
export interface GateLeg {
  readonly kind: "rework" | "reverify";
  /** The thread whose route was taken (reviewer for rework, coder for reverify); its report is the leg's subject. */
  readonly source: LoomThreadWorkstream;
  readonly targetThreadId: ThreadId;
  readonly round: number;
}

/** Composes a gate leg's control message; the dispatcher's is `makeGateLegComposer`. */
export type GateLegComposer = (leg: GateLeg) => {
  readonly text: string;
  readonly controlPayload: ControlPayload;
};

const outcomeSet = (threadId: ThreadId, outcome: "cancelled", now: IsoDateTime, id: string) =>
  ({
    type: "thread.outcome.set",
    commandId: CommandId.make(id),
    threadId,
    createdAt: now,
    outcome,
  }) satisfies OrchestrationV2ServerCommand;
const attentionRaise = (
  threadId: ThreadId,
  reason: LoomAttentionReason,
  now: IsoDateTime,
  id: string,
) =>
  ({
    type: "thread.attention.raise",
    commandId: CommandId.make(id),
    threadId,
    createdAt: now,
    reason,
  }) satisfies OrchestrationV2ServerCommand;
const upstreamThreadCommand = (
  type: "thread.archive" | "thread.unarchive" | "thread.delete",
  threadId: ThreadId,
  id: string,
) => ({ type, commandId: CommandId.make(id), threadId }) satisfies OrchestrationV2ServerCommand;
const goalSet = (threadId: ThreadId, goalId: GoalId, now: IsoDateTime, id: string) =>
  ({
    type: "thread.goal.set",
    commandId: CommandId.make(id),
    threadId,
    createdAt: now,
    goalId,
  }) satisfies OrchestrationV2ServerCommand;

/**
 * The leg a source's latest route implies: loop → rework on the target;
 * loop-back → reverify on the reviewer; resolve → resolve on the counterpart.
 * Id: the strategy's `server:workstream-gate:<reviewerId>:<round>:<leg>`.
 */
const gateLegCommand = (
  source: LoomThreadWorkstream,
  now: IsoDateTime,
  compose: GateLegComposer,
): ThreadServerCommand => {
  const route = source.lastRoute!;
  const leg =
    route.kind === "loop" ? "rework" : route.kind === "loop-back" ? "reverify" : "resolve";
  const reviewerId = route.kind === "loop-back" ? route.to : source.threadId;
  const commandId = CommandId.make(`server:workstream-gate:${reviewerId}:${route.round}:${leg}`);
  const base = {
    commandId,
    threadId: route.to,
    createdAt: now,
    sourceThreadId: source.threadId,
    routeEventId: route.eventId,
  };
  if (leg === "resolve") return { type: "thread.gate.resolve", ...base };
  const message = compose({
    kind: leg,
    source,
    targetThreadId: route.to,
    round: route.round,
  });
  return {
    type: leg === "rework" ? "thread.gate.rework" : "thread.gate.reverify",
    ...base,
    round: route.round,
    message: { messageId: MessageId.make(`message:${commandId}`), ...message },
  };
};

/** One episode-keyed command per affected thread. Pure: the graph snapshot, the clock and the gate-leg text come in; commands come out. */
export const planReDrive = (input: {
  readonly rows: ReadonlyArray<LoomThreadWorkstream>; // LoomStoreV2.listReDriveInput()
  readonly now: IsoDateTime; // every Loom command carries createdAt
  readonly gateLeg: GateLegComposer;
}): ReadonlyArray<ThreadServerCommand> => {
  const { rows, now } = input;
  const byId = new Map(rows.map((row) => [row.threadId, row]));
  const nodes = rows.map((row) => ({ ...row, id: row.threadId }));
  const descendants = (threadId: ThreadId) => descendantsOf(threadId, nodes);
  const parentOf = (row: LoomThreadWorkstream) =>
    row.parentThreadId === null ? undefined : byId.get(row.parentThreadId);
  // Episode scoping: a cascade reaches only descendants that existed when the episode was stamped,
  // and only episodes with a stamp (imported rows carry none — they are history, not news).
  const under = (root: LoomThreadWorkstream, at: IsoDateTime) =>
    descendants(root.threadId).filter((d) => d.deletedAt === null && d.createdAt <= at);
  return [
    // cancel cascade
    ...rows
      .filter((r) => r.outcome === "cancelled" && r.outcomeEventId !== null)
      .flatMap((root) =>
        under(root, root.outcomeAt!)
          .filter((d) => d.outcome === null)
          .map((d) =>
            outcomeSet(
              d.threadId,
              "cancelled",
              now,
              `${LOOM_CASCADE_CANCEL_PREFIX}${root.outcomeEventId}:${d.threadId}`,
            ),
          ),
      ),
    // wedged dependents: a live, unstarted node blocked on a cancelled same-parent sibling
    ...rows
      .filter(
        (r) =>
          r.outcome === null && r.kickoffAt === null && !r.attention.includes("needs_guidance"),
      )
      .flatMap((r) =>
        r.blockedBy.flatMap((depId) => {
          const dep = byId.get(depId);
          return dep?.outcome === "cancelled" &&
            dep.outcomeEventId !== null &&
            dep.parentThreadId === r.parentThreadId
            ? [
                attentionRaise(
                  r.threadId,
                  "needs_guidance",
                  now,
                  `server:loom:wedged:${dep.outcomeEventId}:${r.threadId}`,
                ),
              ]
            : [];
        }),
      ),
    // archive / unarchive / delete cascades (upstream commands with Loom-derived ids)
    ...rows
      .filter((r) => r.archivedAt !== null)
      .flatMap((root) =>
        under(root, root.archivedAt!)
          .filter((d) => d.archivedAt === null)
          .map((d) =>
            upstreamThreadCommand(
              "thread.archive",
              d.threadId,
              `server:loom:cascade-archive:${root.threadId}:${root.archivedAt}:${d.threadId}`,
            ),
          ),
      ),
    // DL-199: bounded by unarchivedAt — a child a human re-archived after the unarchive stays archived
    ...rows
      .filter(
        (r) => r.unarchivedEventId !== null && r.unarchivedAt !== null && r.archivedAt === null,
      )
      .flatMap((root) =>
        under(root, root.unarchivedAt!)
          .filter((d) => d.archivedAt !== null && d.archivedAt <= root.unarchivedAt!)
          .map((d) =>
            upstreamThreadCommand(
              "thread.unarchive",
              d.threadId,
              `server:loom:cascade-unarchive:${root.unarchivedEventId}:${d.threadId}`,
            ),
          ),
      ),
    ...rows
      .filter((r) => r.deletedAt !== null)
      .flatMap((root) =>
        descendants(root.threadId)
          .filter((d) => d.deletedAt === null)
          .map((d) =>
            upstreamThreadCommand(
              "thread.delete",
              d.threadId,
              `server:loom:cascade-delete:${root.threadId}:${root.deletedAt}:${d.threadId}`,
            ),
          ),
      ),
    // goal attach down: a child with no goal whose parent has one
    ...rows.flatMap((r) => {
      const goalId = parentOf(r)?.goalId ?? null;
      return r.goalId === null && r.deletedAt === null && goalId !== null
        ? [goalSet(r.threadId, goalId, now, `server:loom:goal-attach:${r.threadId}:${goalId}`)]
        : [];
    }),
    // gate legs from the latest route on a source
    ...rows
      .filter((r) => r.lastRoute !== null && r.outcome !== "cancelled")
      .map((r) => gateLegCommand(r, now, input.gateLeg)),
  ];
};

export interface ReDrivePassResult {
  readonly accepted: ReadonlyArray<CommandId>;
  /** `LoomDispatchDeferredError`: no receipt, retried next pass. */
  readonly deferred: ReadonlyArray<CommandId>;
  /** Rejected and receipted: the episode is dead (the dispatcher's dispatch helper records it for the digest). */
  readonly dead: ReadonlyArray<CommandId>;
}

/** What a `server:` dispatch came to: `receipted` = sent before (accepted, or dead when `accepted` is false). */
export type ServerDispatchOutcome =
  | { readonly status: "accepted" | "deferred" }
  | { readonly status: "dead"; readonly error: string }
  | { readonly status: "receipted"; readonly accepted: boolean };

/**
 * The receipt discipline for every `server:` control command (re-expressing
 * V1's `receiptDedup.ts` on `CommandReceiptStoreV2`): an id with a receipt was
 * delivered (accepted) or is dead (rejected) and is never re-sent; a
 * `LoomDispatchDeferredError` leaves no receipt, so the same id retries next pass.
 */
export const dispatchServerCommand = Effect.fn("loom.dispatchServerCommand")(function* (
  command: ThreadServerCommand,
): Effect.fn.Return<
  ServerDispatchOutcome,
  CommandReceiptStoreV2Error,
  CommandReceiptStoreV2 | OrchestratorV2
> {
  const receipts = yield* CommandReceiptStoreV2;
  const orchestrator = yield* OrchestratorV2;
  const receipt = yield* receipts.getByCommandId(command.commandId);
  if (Option.isSome(receipt)) {
    // Delivered earlier, or dead: never re-sent.
    return { status: "receipted", accepted: receipt.value.status === "accepted" };
  }
  return yield* orchestrator.dispatch(command).pipe(
    Effect.as<ServerDispatchOutcome>({ status: "accepted" }),
    Effect.catch((error) =>
      error._tag === "LoomDispatchDeferredError"
        ? Effect.succeed<ServerDispatchOutcome>({ status: "deferred" })
        : Effect.logWarning("loom.control-plane.dead-episode", {
            commandId: command.commandId,
            commandType: command.type,
            threadId: command.threadId,
            error: error.message,
          }).pipe(Effect.as<ServerDispatchOutcome>({ status: "dead", error: error.message })),
    ),
  );
});

/**
 * One re-drive: plan over `listReDriveInput` and dispatch each command
 * SEQUENTIALLY — one thread lock at a time, never nested — through `dispatch`
 * (the dispatcher's pass helper, or the bare `dispatchServerCommand`).
 */
export const runReDrivePass = <E, R>(
  gateLeg: GateLegComposer,
  dispatch: (
    command: ThreadServerCommand,
  ) => Effect.Effect<{ readonly status: "receipted" | "accepted" | "deferred" | "dead" }, E, R>,
) =>
  Effect.gen(function* () {
    const loomStore = yield* LoomStoreV2;
    const commands = planReDrive({
      rows: yield* loomStore.listReDriveInput(),
      now: DateTime.formatIso(yield* DateTime.now),
      gateLeg,
    });
    const result = {
      accepted: [] as CommandId[],
      deferred: [] as CommandId[],
      dead: [] as CommandId[],
    };
    for (const command of commands) {
      const { status } = yield* dispatch(command);
      if (status !== "receipted") result[status].push(command.commandId);
    }
    return result satisfies ReDrivePassResult;
  }).pipe(Effect.withSpan("loom.runReDrivePass"));

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
/** The events that enqueue a control-plane pass (besides a terminal `run.updated`). */
export const PASS_TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  // Loom graph and wake events
  "thread.workstream-created",
  "thread.outcome-set",
  "thread.outcome-recorded",
  "thread.route-taken",
  "thread.attention-raised",
  "thread.dependencies-set",
  "thread.kickoff-brief-set",
  "thread.goal-set",
  "thread.peer-message-recorded",
  // upstream lifecycle the cascades follow (they must not wait for the tick)
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  // a request opening or settling changes the parent's wake set
  "runtime-request.updated",
]);

/** A graph change, a wake-bearing event, or a run ending (so a deferred wake retries when its target goes idle). */
export const isPassTrigger = (event: OrchestrationV2DomainEvent) =>
  PASS_TRIGGER_EVENT_TYPES.has(event.type) ||
  (event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status));
