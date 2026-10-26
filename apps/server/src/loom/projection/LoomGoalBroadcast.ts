/**
 * Goals are plain tables, so a write emits no thread event. This PubSub carries unsequenced
 * `goal.updated` / `goal.removed` shell items: handlers publish after their write, the reactor below
 * after a projector-folded cascade. `ws.ts` merges them only for `loom: true` subscribers.
 */
import type {
  LoomCacheShellStreamItem,
  LoomConsultShellStreamItem,
  LoomGoal,
  LoomGoalShell,
  LoomGoalShellStreamItem,
  OrchestrationV2ShellSnapshot,
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
import { LoomThreadConsult } from "../workstream/consult.ts";
import { LoomCacheBroadcast } from "./LoomCacheBroadcast.ts";
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

type SnapshotThreads = Pick<OrchestrationV2ShellSnapshot, "threads" | "archivedThreads">;

/**
 * The live goals the snapshot's threads work under. Every other goal stays off the cold connect
 * (most are long finished): a client asks `loom.goal.get` for one when a thread it opens needs it.
 */
export const loomSnapshotGoals = (snapshot: SnapshotThreads) =>
  LoomStoreV2.use((loomStore) =>
    loomStore.goals.listLive([
      ...new Set(
        [...snapshot.threads, ...snapshot.archivedThreads].flatMap(
          (thread) => thread.workstream?.goalId ?? [],
        ),
      ),
    ]),
  ).pipe(Effect.map((goals) => ({ goals: goals.map(toGoalShell) })));

/**
 * The `loom: true` shell tail: snapshot `goals`, plus live goal, consult and cache-row items. The
 * subscription is taken before the snapshot loads so no write between them is lost. Consults and
 * cache rows have no snapshot field here (a thread's persisted `workstream.cache` carries the latter).
 */
export const loomShellGoals = Effect.fn("loom.shellGoals")(function* (input: {
  readonly loom?: boolean;
}) {
  if (input.loom !== true) {
    return {
      snapshotGoals: (_snapshot: SnapshotThreads) => Effect.succeed({}),
      items: Stream.empty as Stream.Stream<
        LoomGoalShellStreamItem | LoomConsultShellStreamItem | LoomCacheShellStreamItem
      >,
    };
  }
  const loomStore = yield* LoomStoreV2;
  const subscription = yield* (yield* LoomGoalBroadcast).subscribe;
  const consults = yield* (yield* LoomThreadConsult).subscribeLive;
  const cacheRows = yield* (yield* LoomCacheBroadcast).subscribe;
  return {
    snapshotGoals: (snapshot: SnapshotThreads) =>
      loomSnapshotGoals(snapshot).pipe(Effect.provideService(LoomStoreV2, loomStore)),
    items: Stream.fromSubscription(subscription).pipe(
      Stream.merge(consults),
      Stream.merge(Stream.fromSubscription(cacheRows)),
    ),
  };
});
