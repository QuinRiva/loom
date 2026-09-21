import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationCommand,
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

it.layer(NodeServices.layer)("thread.create: isolation field propagation", (it) => {
  it.effect("explicit isolation values are carried to thread.created event", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = asProjectId("test-project-isolation");
      const parentThreadId = asThreadId("parent-thread");

      // Create a project and parent thread.
      let readModel = createEmptyReadModel(now);
      readModel = yield* projectEvent(readModel, {
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
          title: "Test Project",
          workspaceRoot: "/tmp/test-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      readModel = yield* projectEvent(readModel, {
        sequence: 2,
        eventId: asEventId("evt-parent"),
        aggregateKind: "thread",
        aggregateId: parentThreadId,
        type: "thread.created",
        occurredAt: now,
        commandId: asCommandId("cmd-parent"),
        causationEventId: null,
        correlationId: asCommandId("cmd-parent"),
        metadata: {},
        payload: {
          threadId: parentThreadId,
          projectId,
          title: "Parent Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("test"),
            model: "test-model",
          },
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "approval-required",
          branch: "main",
          worktreePath: "/tmp/repo",
          createdAt: now,
          updatedAt: now,
        },
      });

      // Test: isolation=isolated is copied to event
      const command1: Extract<OrchestrationCommand, { type: "thread.create" }> = {
        type: "thread.create",
        commandId: asCommandId("cmd-child-isolated"),
        threadId: asThreadId("child-iso"),
        projectId,
        parentThreadId,
        title: "Child (isolated)",
        modelSelection: {
          instanceId: ProviderInstanceId.make("test"),
          model: "test-model",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        role: "coder",
        isolation: "isolated",
        branch: "main",
        worktreePath: "/tmp/repo",
        createdAt: now,
      };

      const result1 = yield* decideOrchestrationCommand({ command: command1, readModel });
      const event1 = Array.isArray(result1) ? result1[0] : result1;
      expect(event1.type).toBe("thread.created");
      expect((event1 as any).payload.isolation).toBe("isolated");

      // Test: isolation=shared is copied to event
      const command2: Extract<OrchestrationCommand, { type: "thread.create" }> = {
        type: "thread.create",
        commandId: asCommandId("cmd-child-shared"),
        threadId: asThreadId("child-shared"),
        projectId,
        parentThreadId,
        title: "Child (shared)",
        modelSelection: {
          instanceId: ProviderInstanceId.make("test"),
          model: "test-model",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        role: "researcher",
        isolation: "shared",
        branch: "main",
        worktreePath: "/tmp/repo",
        createdAt: now,
      };

      const result2 = yield* decideOrchestrationCommand({ command: command2, readModel });
      const event2 = Array.isArray(result2) ? result2[0] : result2;
      expect(event2.type).toBe("thread.created");
      expect((event2 as any).payload.isolation).toBe("shared");
    }),
  );
});

it.layer(NodeServices.layer)("thread.create: fork source propagation", (it) => {
  it.effect("forkFromThreadId is carried to the thread.created event", () =>
    Effect.gen(function* () {
      const now = "2026-01-01T00:00:00.000Z";
      const projectId = asProjectId("test-project-fork");
      const sourceThreadId = asThreadId("source-thread");

      let readModel = createEmptyReadModel(now);
      readModel = yield* projectEvent(readModel, {
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
          title: "Test Project",
          workspaceRoot: "/tmp/test-project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });

      // The fork command names an existing source thread via forkFromThreadId.
      const command: Extract<OrchestrationCommand, { type: "thread.create" }> = {
        type: "thread.create",
        commandId: asCommandId("cmd-fork"),
        threadId: asThreadId("fork-thread"),
        projectId,
        parentThreadId: null,
        forkFromThreadId: sourceThreadId,
        title: "Source Thread (fork)",
        modelSelection: {
          instanceId: ProviderInstanceId.make("test"),
          model: "test-model",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        planLane: "planned",
        branch: "main",
        worktreePath: "/tmp/repo",
        createdAt: now,
      };

      const result = yield* decideOrchestrationCommand({ command, readModel });
      const event = Array.isArray(result) ? result[0] : result;
      expect(event.type).toBe("thread.created");
      expect((event as any).payload.forkFromThreadId).toBe(sourceThreadId);

      // And the projected thread record surfaces the fork source for the driver,
      // as a ROOT thread (parentThreadId null) so it stays out of every
      // delegation rail (dispatcher/wake/digest/fan-in all skip roots) — a fork
      // diverges, it is not a delegated child.
      const projected = yield* projectEvent(readModel, event as never);
      const forkThread = projected.threads.find((t) => t.id === "fork-thread");
      expect(forkThread?.forkFromThreadId).toBe(sourceThreadId);
      expect(forkThread?.parentThreadId).toBe(null);
    }),
  );
});
