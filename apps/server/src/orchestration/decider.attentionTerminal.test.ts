import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const seed = Effect.gen(function* () {
  const withProject = yield* projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: EventId.make("evt-project"),
    aggregateKind: "project",
    aggregateId: ProjectId.make("project-1"),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-project"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-project"),
    metadata: {},
    payload: {
      projectId: ProjectId.make("project-1"),
      title: "Project",
      workspaceRoot: "/tmp/project-1",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: EventId.make("evt-thread"),
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread"),
    metadata: {},
    payload: {
      threadId: ThreadId.make("thread-1"),
      projectId: ProjectId.make("project-1"),
      title: "Thread",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

const raiseError = {
  sequence: 3,
  eventId: EventId.make("evt-attn"),
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-1"),
  type: "thread.attention-raised" as const,
  occurredAt: now,
  commandId: CommandId.make("server:workstream-liveness:error:thread-1"),
  causationEventId: null,
  correlationId: CommandId.make("server:workstream-liveness:error:thread-1"),
  metadata: {},
  payload: { threadId: ThreadId.make("thread-1"), reason: "error" as const, updatedAt: now },
};

const laneSet = (planLane: "done" | "cancelled" | "ready"): OrchestrationCommand => ({
  type: "thread.plan-lane.set",
  commandId: CommandId.make("11111111-2222-3333"),
  threadId: ThreadId.make("thread-1"),
  planLane,
  createdAt: now,
});

it.layer(NodeServices.layer)("terminal plan lane clears attention (design §3)", (it) => {
  it.effect("decider emits attention-cleared (clear all) when a flagged thread goes done", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(yield* seed, raiseError);
      const events = yield* decideOrchestrationCommand({ command: laneSet("done"), readModel });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((e) => e.type)).toEqual(["thread.plan-lane-set", "thread.attention-cleared"]);
      // Omitted reason ⇒ clears ALL stored attention.
      expect((list[1]!.payload as { reason?: string }).reason).toBeUndefined();
    }),
  );

  it.effect("decider emits no clear when an unflagged thread goes done", () =>
    Effect.gen(function* () {
      const readModel = yield* seed;
      const events = yield* decideOrchestrationCommand({ command: laneSet("done"), readModel });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((e) => e.type)).toEqual(["thread.plan-lane-set"]);
    }),
  );

  it.effect("decider does NOT clear attention on a non-terminal lane (ready)", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(yield* seed, raiseError);
      const events = yield* decideOrchestrationCommand({ command: laneSet("ready"), readModel });
      const list = Array.isArray(events) ? events : [events];
      expect(list.map((e) => e.type)).toEqual(["thread.plan-lane-set"]);
    }),
  );

  it.effect("projector strips stored attention when a terminal plan-lane-set is applied", () =>
    Effect.gen(function* () {
      // Backfill / ordering-robustness path: a plan-lane-set(done) event applied
      // on a thread that already carries `error` lands attention = [] WITHOUT a
      // matching attention-cleared event in the stream.
      const flagged = yield* projectEvent(yield* seed, raiseError);
      expect(flagged.threads[0]?.attention).toEqual(["error"]);
      const settled = yield* projectEvent(flagged, {
        sequence: 4,
        eventId: EventId.make("evt-lane"),
        aggregateKind: "thread",
        aggregateId: ThreadId.make("thread-1"),
        type: "thread.plan-lane-set",
        occurredAt: now,
        commandId: CommandId.make("cmd-lane"),
        causationEventId: null,
        correlationId: CommandId.make("cmd-lane"),
        metadata: {},
        payload: { threadId: ThreadId.make("thread-1"), planLane: "done", updatedAt: now },
      });
      expect(settled.threads[0]?.planLane).toBe("done");
      expect(settled.threads[0]?.attention).toEqual([]);
    }),
  );
});
