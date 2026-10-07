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
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
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

const attentionRaise = (
  commandId: string,
  reason: "error" | "awaiting_acceptance",
): OrchestrationCommand => ({
  type: "thread.attention.raise",
  commandId: CommandId.make(commandId),
  threadId: ThreadId.make("thread-1"),
  reason,
  createdAt: now,
});

const laneSet = (commandId: string, planLane: "in_progress" | "done"): OrchestrationCommand => ({
  type: "thread.plan-lane.set",
  commandId: CommandId.make(commandId),
  threadId: ThreadId.make("thread-1"),
  planLane,
  createdAt: now,
});

it.layer(NodeServices.layer)("decider control-plane-only guards", (it) => {
  it.effect(
    "rejects attention `error` from a client/web commandId (bare UUID, no server: prefix)",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seedReadModel;
        const exit = yield* Effect.exit(
          decideOrchestrationCommand({
            command: attentionRaise("11111111-2222-3333", "error"),
            readModel,
          }),
        );
        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );

  it.effect("accepts attention `error` from a server:-prefixed commandId (the sweep)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        command: attentionRaise("server:workstream-liveness:error:thread-1", "error"),
        readModel,
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list[0]?.type).toBe("thread.attention-raised");
    }),
  );

  it.effect("accepts an agent-raisable reason (awaiting_acceptance) from a client commandId", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        command: attentionRaise("44444444-5555-6666", "awaiting_acceptance"),
        readModel,
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list[0]?.type).toBe("thread.attention-raised");
    }),
  );

  it.effect("rejects plan lane `in_progress` from a client commandId (control-plane-only)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: laneSet("77777777-8888-9999", "in_progress"),
          readModel,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("accepts plan lane `done` from a client commandId", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        command: laneSet("aaaa1111-bbbb-2222", "done"),
        readModel,
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list[0]?.type).toBe("thread.plan-lane-set");
    }),
  );
});
