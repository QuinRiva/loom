import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  GoalId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const DRAFTER = ThreadId.make("drafter-1");
const DEST_GOAL = GoalId.make("goal-1");
const DEST_THREAD = ThreadId.make("dest-1");

let seq = 0;
const seedEvent = (
  overrides: Pick<OrchestrationEvent, "aggregateKind" | "aggregateId" | "type" | "payload">,
): OrchestrationEvent =>
  ({
    sequence: ++seq,
    eventId: EventId.make(`evt-${seq}`),
    occurredAt: now,
    commandId: CommandId.make("server:seed"),
    causationEventId: null,
    correlationId: CommandId.make("server:seed"),
    metadata: {},
    ...overrides,
  }) as OrchestrationEvent;

const seedDrafter = Effect.gen(function* () {
  seq = 0;
  return yield* projectEvent(
    createEmptyReadModel(now),
    seedEvent({
      aggregateKind: "thread",
      aggregateId: DRAFTER,
      type: "thread.created",
      payload: {
        threadId: DRAFTER,
        projectId: ProjectId.make("project-1"),
        title: "Handoff: fix retry",
        role: "handoff-drafter",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
      },
    }),
  );
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

it.layer(NodeServices.layer)("decider thread.handoff.record", (it) => {
  it.effect("derives thread.handoff-recorded carrying the destination ids", () =>
    Effect.gen(function* () {
      const readModel = yield* seedDrafter;
      const events = yield* decide(
        {
          type: "thread.handoff.record",
          commandId: CommandId.make("server:goal-handoff:record-handoff:abc"),
          threadId: DRAFTER,
          destinationGoalId: DEST_GOAL,
          destinationThreadId: DEST_THREAD,
          createdAt: now,
        },
        readModel,
      );
      expect(events.map((event) => event.type)).toEqual(["thread.handoff-recorded"]);
      expect(events[0]?.payload).toMatchObject({
        threadId: DRAFTER,
        destinationGoalId: DEST_GOAL,
        destinationThreadId: DEST_THREAD,
      });
    }),
  );
});
