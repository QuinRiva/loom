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

const statusSet = (commandId: string, status: "error" | "done"): OrchestrationCommand => ({
  type: "thread.status.set",
  commandId: CommandId.make(commandId),
  threadId: ThreadId.make("thread-1"),
  status,
  createdAt: now,
});

it.layer(NodeServices.layer)("decider error-status server-only guard", (it) => {
  it.effect("rejects `error` from a client/web commandId (bare UUID, no server: prefix)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const exit = yield* Effect.exit(
        decideOrchestrationCommand({
          command: statusSet("11111111-2222-3333", "error"),
          readModel,
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("accepts `error` from a server:-prefixed commandId (the sweep)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        command: statusSet("server:workstream-liveness:error:thread-1", "error"),
        readModel,
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list[0]?.type).toBe("thread.status-set");
    }),
  );

  it.effect("still accepts non-error statuses from a client commandId", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decideOrchestrationCommand({
        command: statusSet("44444444-5555-6666", "done"),
        readModel,
      });
      const list = Array.isArray(events) ? events : [events];
      expect(list[0]?.type).toBe("thread.status-set");
    }),
  );
});
