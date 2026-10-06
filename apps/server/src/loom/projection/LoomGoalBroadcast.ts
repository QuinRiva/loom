/**
 * Goal broadcast (plans/upstream-pull9-phase2-substrate/plan.mdx §4, D21,
 * DL-200): goals are plain tables, so a goal write emits no thread event and
 * the shell stream would never carry it. This PubSub carries unsequenced
 * `goal.updated` / `goal.removed` shell-stream items instead: Phase 3a's
 * handlers publish after their write, and the reactor below publishes after a
 * projector-folded cascade (last-thread archive, unarchive, sole-thread
 * rename, last-thread delete). `ws.ts` merges the items — and puts `goals` on
 * the authoritative snapshot — only for subscribers that pass `loom: true`.
 *
 * @module loom/projection/LoomGoalBroadcast
 */
import type {
  LoomGoal,
  LoomGoalShell,
  LoomGoalShellStreamItem,
  OrchestrationProjectShell,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Struct from "effect/Struct";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import { LoomStoreV2 } from "./LoomStore.ts";

export class LoomGoalBroadcast extends Context.Service<
  LoomGoalBroadcast,
  {
    readonly publish: (item: LoomGoalShellStreamItem) => Effect.Effect<void>;
    readonly subscribe: Effect.Effect<
      PubSub.Subscription<LoomGoalShellStreamItem>,
      never,
      Scope.Scope
    >;
  }
>()("t3/loom/projection/LoomGoalBroadcast") {}

const toGoalShell = (goal: LoomGoal): LoomGoalShell => Struct.omit(goal, ["deletedAt"]);

/** The shell-stream item that states a goal's current state. */
export const goalShellItem = (goal: LoomGoal): LoomGoalShellStreamItem =>
  goal.deletedAt === null
    ? { kind: "goal.updated", goal: toGoalShell(goal) }
    : { kind: "goal.removed", goalId: goal.id };

/**
 * Publishes the goal a cascade changed. The projector stamps the goal's
 * `updatedAt` with the event's `occurredAt`, so equality is exactly "this event
 * moved the goal" — an archive that left other live threads, or a rename of a
 * non-sole thread, publishes nothing.
 */
const goalCascadeReactor = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2;
  const loomStore = yield* LoomStoreV2;
  const broadcast = yield* LoomGoalBroadcast;
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
      if (
        event.type !== "thread.archived" &&
        event.type !== "thread.unarchived" &&
        event.type !== "thread.deleted" &&
        event.type !== "thread.metadata-updated"
      ) {
        return Effect.void;
      }
      return Effect.gen(function* () {
        const goalId = (yield* loomStore.getWorkstream(event.threadId))?.goalId ?? null;
        if (goalId === null) return;
        const goal = yield* loomStore.goals.get(goalId);
        if (goal !== null && goal.updatedAt === DateTime.formatIso(event.occurredAt)) {
          yield* broadcast.publish(goalShellItem(goal));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("loom.goal-broadcast.cascade-read-failed", { cause }),
        ),
      );
    }),
  );
});

export const layer = Layer.effect(
  LoomGoalBroadcast,
  Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<LoomGoalShellStreamItem>();
    return {
      publish: (item) => PubSub.publish(pubsub, item).pipe(Effect.asVoid),
      subscribe: PubSub.subscribe(pubsub),
    };
  }),
);

/** The broadcast service with its cascade reactor running. */
export const layerWithReactor = Layer.effectDiscard(goalCascadeReactor).pipe(
  Layer.provideMerge(layer),
);

/**
 * The shell subscription's goal surface (DL-200): `goals` for the
 * authoritative snapshot and the live goal items, both empty unless the
 * subscriber passed `loom: true`. The subscription is taken here, before the
 * snapshot loads, so no write between snapshot and tail is lost.
 */
export const loomShellGoals = Effect.fn("loom.shellGoals")(function* (input: {
  readonly loom?: boolean;
}) {
  if (input.loom !== true) {
    return {
      snapshotGoals: (_projects: ReadonlyArray<OrchestrationProjectShell>) => Effect.succeed({}),
      items: Stream.empty as Stream.Stream<LoomGoalShellStreamItem>,
    };
  }
  const loomStore = yield* LoomStoreV2;
  const subscription = yield* (yield* LoomGoalBroadcast).subscribe;
  return {
    snapshotGoals: (projects: ReadonlyArray<OrchestrationProjectShell>) =>
      Effect.forEach(projects, (project) => loomStore.goals.listByProject(project.id)).pipe(
        Effect.map((goals) => ({ goals: goals.flat().map(toGoalShell) })),
      ),
    items: Stream.fromSubscription(subscription),
  };
});
