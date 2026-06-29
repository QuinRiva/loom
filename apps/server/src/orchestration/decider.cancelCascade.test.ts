import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type ThreadPlanLane,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const now = "2026-01-01T00:00:00.000Z";
const projectId = asProjectId("project-cascade");

// Build a parent→child→grandchild graph with seeded plan lanes. thread.created
// accepts planLane directly, so we seed in_progress / done without going through
// the decider's authorisation chokepoint.
const seedThread = (
  readModel: Parameters<typeof projectEvent>[0],
  sequence: number,
  id: string,
  parentThreadId: string | null,
  planLane: ThreadPlanLane,
) =>
  projectEvent(readModel, {
    sequence,
    eventId: asEventId(`evt-thread-${id}`),
    aggregateKind: "thread",
    aggregateId: asThreadId(id),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId(`cmd-thread-${id}`),
    causationEventId: null,
    correlationId: asCommandId(`cmd-thread-${id}`),
    metadata: {},
    payload: {
      threadId: asThreadId(id),
      projectId,
      parentThreadId: parentThreadId === null ? null : asThreadId(parentThreadId),
      planLane,
      title: `Thread ${id}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

const seedReadModel = Effect.gen(function* () {
  let readModel = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: asEventId("evt-project"),
    aggregateKind: "project",
    aggregateId: projectId,
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project"),
    metadata: {},
    payload: {
      projectId,
      title: "Cascade",
      workspaceRoot: "/tmp/cascade",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  // root → childA → {grandchild, gcRunning}; root → childB (done, untouched).
  readModel = yield* seedThread(readModel, 2, "root", null, "ready");
  readModel = yield* seedThread(readModel, 3, "childA", "root", "in_progress");
  readModel = yield* seedThread(readModel, 4, "childB", "root", "done");
  readModel = yield* seedThread(readModel, 5, "grandchild", "childA", "ready");
  readModel = yield* seedThread(readModel, 6, "gcRunning", "childA", "in_progress");
  // grandchild is sitting flagged for a human; cancelling must clear that.
  readModel = yield* projectEvent(readModel, {
    sequence: 7,
    eventId: asEventId("evt-gc-attn"),
    aggregateKind: "thread",
    aggregateId: asThreadId("grandchild"),
    type: "thread.attention-raised",
    occurredAt: now,
    commandId: asCommandId("cmd-gc-attn"),
    causationEventId: null,
    correlationId: asCommandId("cmd-gc-attn"),
    metadata: {},
    payload: { threadId: asThreadId("grandchild"), reason: "needs_guidance", updatedAt: now },
  });
  return readModel;
});

it.layer(NodeServices.layer)("decider cancel cascade", (it) => {
  it.effect(
    "cancels the whole subtree, skips done, interrupts in-flight, clears attention, raises none",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel;
        const decided = yield* decideOrchestrationCommand({
          command: {
            type: "thread.plan-lane.set",
            commandId: asCommandId("cmd-cancel-root"),
            threadId: asThreadId("root"),
            planLane: "cancelled",
            createdAt: now,
          },
          readModel,
        });
        const events = Array.isArray(decided) ? decided : [decided];

        const cancelledIds = events
          .filter((event) => event.type === "thread.plan-lane-set")
          .map((event) => (event.payload as { threadId: ThreadId }).threadId);
        const interruptedIds = events
          .filter((event) => event.type === "thread.turn-interrupt-requested")
          .map((event) => (event.payload as { threadId: ThreadId }).threadId);

        // Target + every non-terminal descendant is cancelled; the already-done
        // childB is left untouched.
        expect(new Set(cancelledIds)).toEqual(
          new Set(["root", "childA", "grandchild", "gcRunning"].map(asThreadId)),
        );
        expect(cancelledIds).not.toContain(asThreadId("childB"));
        events
          .filter((event) => event.type === "thread.plan-lane-set")
          .forEach((event) =>
            expect((event.payload as { planLane: string }).planLane).toBe("cancelled"),
          );

        // Every in-flight turn in the subtree is interrupted so token burn stops.
        expect(new Set(interruptedIds)).toEqual(new Set(["childA", "gcRunning"].map(asThreadId)));

        // The cascade must not spray attention flags across the subtree.
        expect(events.some((event) => event.type === "thread.attention-raised")).toBe(false);
        // A cancelled node that was flagged for a human gets that flag cleared.
        const clearedIds = events
          .filter((event) => event.type === "thread.attention-cleared")
          .map((event) => (event.payload as { threadId: ThreadId }).threadId);
        expect(clearedIds).toEqual([asThreadId("grandchild")]);

        // Project the cascade and confirm the resulting lanes/attention.
        let projected = readModel;
        let sequence = readModel.snapshotSequence;
        for (const event of events) {
          sequence += 1;
          projected = yield* projectEvent(projected, { ...event, sequence });
        }
        const laneOf = (id: string) =>
          projected.threads.find((thread) => thread.id === asThreadId(id))?.planLane;
        expect(laneOf("root")).toBe("cancelled");
        expect(laneOf("childA")).toBe("cancelled");
        expect(laneOf("grandchild")).toBe("cancelled");
        expect(laneOf("gcRunning")).toBe("cancelled");
        expect(laneOf("childB")).toBe("done");
        projected.threads.forEach((thread) => expect(thread.attention).toEqual([]));
      }),
  );
});
