import { CommandId, EventId, ProjectId, type OrchestrationCommand } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const seedWithProject = (deletedAt: string | null) =>
  projectEvent(createEmptyReadModel(now), {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-existing"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-existing"),
      title: "Existing",
      workspaceRoot: "/tmp/shared-root",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  }).pipe(
    Effect.flatMap((model) =>
      deletedAt === null
        ? Effect.succeed(model)
        : projectEvent(model, {
            sequence: 2,
            eventId: asEventId("evt-project-delete"),
            aggregateKind: "project",
            aggregateId: asProjectId("project-existing"),
            type: "project.deleted",
            occurredAt: deletedAt,
            commandId: asCommandId("cmd-project-delete"),
            causationEventId: null,
            correlationId: asCommandId("cmd-project-delete"),
            metadata: {},
            payload: { projectId: asProjectId("project-existing"), deletedAt },
          }),
    ),
  );

const createCommand: Extract<OrchestrationCommand, { type: "project.create" }> = {
  type: "project.create",
  commandId: asCommandId("cmd-project-create-2"),
  projectId: asProjectId("project-new"),
  title: "New",
  workspaceRoot: "/tmp/shared-root",
  defaultModelSelection: null,
  createdAt: now,
};

it.layer(NodeServices.layer)("decider project.create workspace_root guard", (it) => {
  it.effect("rejects a second active project for the same workspace_root", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithProject(null);
      const error = yield* Effect.flip(
        decideOrchestrationCommand({ command: createCommand, readModel }),
      );
      expect(error.message).toContain("already exists for workspace root");
    }),
  );

  it.effect("allows re-creating a project for a soft-deleted workspace_root", () =>
    Effect.gen(function* () {
      const readModel = yield* seedWithProject("2026-01-02T00:00:00.000Z");
      const result = yield* decideOrchestrationCommand({ command: createCommand, readModel });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual(["project.created"]);
    }),
  );
});
