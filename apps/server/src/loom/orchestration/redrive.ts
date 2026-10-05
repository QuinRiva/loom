/**
 * The re-drive planner (plans/upstream-pull9-phase2-substrate/plan.mdx §4, D3,
 * D16; DL-199, DL-213). The arm writes only to the commanded thread, so every
 * effect on another thread — cancel, archive, unarchive and delete cascades,
 * wedged dependents, goal attach, gate legs — is derived here from sidecar
 * state as one per-thread command with an episode-keyed `server:` id. A
 * receipted id is done (accepted or dead) and never re-sent; a deferral leaves
 * no receipt, so the same id is retried on the next pass.
 *
 * `LoomReDriveReactor` runs the pass on graph events and once at startup until
 * Phase 3b folds it into the dispatcher's pass.
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { CommandReceiptStoreV2 } from "../../orchestration-v2/CommandReceiptStore.ts";
import { LOOM_CASCADE_CANCEL_PREFIX } from "../../orchestration-v2/Orchestrator.loom.ts";
import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";

/** A gate leg that carries a control message (resolve carries none). */
export interface GateLeg {
  readonly kind: "rework" | "reverify";
  /** The thread whose route was taken (reviewer for rework, coder for reverify). */
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly round: number;
}

/** The gate-leg message composer: 3b passes its real one; Phase 2 passes `fixedGateLeg`. */
export type GateLegComposer = (leg: GateLeg) => {
  readonly text: string;
  readonly controlPayload: ControlPayload;
};

export const fixedGateLeg: GateLegComposer = (leg) => {
  const heading =
    leg.kind === "rework" ? "Review gate: rework requested" : "Review gate: re-verify";
  return {
    text: `${heading} (round ${leg.round}). Read ${leg.sourceThreadId}'s report and continue.`,
    controlPayload: {
      kind: "notice",
      heading,
      items: [{ threadId: leg.sourceThreadId, title: `Round ${leg.round}` }],
    },
  };
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
): OrchestrationV2ServerCommand => {
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
    sourceThreadId: source.threadId,
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
}): ReadonlyArray<OrchestrationV2ServerCommand> => {
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
  /** Rejected and receipted: the episode is dead (logged; 3b's advisory rail surfaces it). */
  readonly dead: ReadonlyArray<CommandId>;
}

/**
 * One pass: plan over `listReDriveInput`, skip ids that already have a receipt,
 * dispatch the rest SEQUENTIALLY — one thread lock at a time, never nested.
 */
export const runReDrivePass = Effect.fn("loom.runReDrivePass")(function* (
  gateLeg: GateLegComposer,
) {
  const orchestrator = yield* OrchestratorV2;
  const receipts = yield* CommandReceiptStoreV2;
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
    if (Option.isSome(yield* receipts.getByCommandId(command.commandId))) continue;
    const outcome = yield* orchestrator.dispatch(command).pipe(
      Effect.as("accepted" as const),
      Effect.catch((error) =>
        error._tag === "LoomDispatchDeferredError"
          ? Effect.succeed("deferred" as const)
          : Effect.logWarning("loom.redrive.dead-episode", {
              commandId: command.commandId,
              commandType: command.type,
              error: error.message,
            }).pipe(Effect.as("dead" as const)),
      ),
    );
    result[outcome].push(command.commandId);
  }
  return result satisfies ReDrivePassResult;
});

const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const TRIGGER_EVENT_TYPES: ReadonlySet<string> = new Set([
  "thread.outcome-set",
  "thread.route-taken",
  "thread.archived",
  "thread.unarchived",
  "thread.deleted",
  "thread.goal-set",
]);

/** A graph change, or a run ending (so a deferred gate leg retries when its target goes idle). */
export const isReDriveTrigger = (event: OrchestrationV2DomainEvent) =>
  TRIGGER_EVENT_TYPES.has(event.type) ||
  (event.type === "run.updated" && TERMINAL_RUN_STATUSES.has(event.payload.status));

/**
 * Runs a pass once after activation (startup, after recovery) and then on every
 * debounced burst of trigger events. No periodic tick: that is Phase 3b's.
 */
export const LoomReDriveReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const pass = runReDrivePass(fixedGateLeg).pipe(
      Effect.catchCause((cause) => Effect.logWarning("loom.redrive.pass-failed", { cause })),
    );
    yield* forkParked(
      Stream.merge(
        Stream.succeed("startup"),
        orchestrator.streamDomainEvents.pipe(Stream.filter(isReDriveTrigger)),
      ).pipe(
        Stream.debounce("200 millis"),
        Stream.runForEach(() => pass),
        Effect.catchCause((cause) => Effect.logWarning("loom.redrive.reactor-stopped", { cause })),
      ),
    );
  }),
);
