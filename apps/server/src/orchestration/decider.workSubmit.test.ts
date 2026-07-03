// Review gates Phase 1–2 (docs/design/workstream-review-gates.md §3, §5):
// - `yielded` is control-plane-only on the lane-set surface (same guard as
//   `in_progress`) and is NOT sticky-terminal — any turn-start reverts it.
// - `thread.work.submit` is the single terminal call: one transaction emits the
//   report pointer, the outcome record, and the lane/attention events the
//   route-free routing decision implies.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const THREAD = ThreadId.make("thread-1");

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
    aggregateId: THREAD,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-thread"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-thread"),
    metadata: {},
    payload: {
      threadId: THREAD,
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

/** Apply a `yielded` lane onto the seeded model (as a submit's routing would). */
const withYieldedLane = (readModel: OrchestrationReadModel) =>
  projectEvent(readModel, {
    sequence: 3,
    eventId: EventId.make("evt-yielded"),
    aggregateKind: "thread",
    aggregateId: THREAD,
    type: "thread.plan-lane-set",
    occurredAt: now,
    commandId: CommandId.make("server:test"),
    causationEventId: null,
    correlationId: CommandId.make("server:test"),
    metadata: {},
    payload: { threadId: THREAD, planLane: "yielded", updatedAt: now },
  });

const submit = (outcome?: string): OrchestrationCommand => ({
  type: "thread.work.submit",
  commandId: CommandId.make(`server:workstream-submit:test-${outcome ?? "done"}`),
  threadId: THREAD,
  reportPath: "/reports/thread-1.md",
  ...(outcome !== undefined ? { outcome } : {}),
  createdAt: now,
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

it.layer(NodeServices.layer)("decider review-gate invariants (Phases 1–2)", (it) => {
  it.effect("rejects plan lane `yielded` from a client commandId (control-plane-only)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const exit = yield* Effect.exit(
        decide(
          {
            type: "thread.plan-lane.set",
            commandId: CommandId.make("11111111-2222-3333"),
            threadId: THREAD,
            planLane: "yielded",
            createdAt: now,
          },
          readModel,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("accepts plan lane `yielded` from a server:-prefixed commandId", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decide(
        {
          type: "thread.plan-lane.set",
          commandId: CommandId.make("server:test:yielded"),
          threadId: THREAD,
          planLane: "yielded",
          createdAt: now,
        },
        readModel,
      );
      expect(events[0]?.type).toBe("thread.plan-lane-set");
    }),
  );

  it.effect("a turn-start on a `yielded` thread reverts it to `in_progress` (not sticky)", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, withYieldedLane);
      const events = yield* decide(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("44444444-5555-6666"),
          threadId: THREAD,
          message: {
            messageId: MessageId.make("msg-1"),
            role: "user",
            text: "resume",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: now,
        },
        readModel,
      );
      const laneEvents = events.filter((event) => event.type === "thread.plan-lane-set");
      expect(laneEvents).toHaveLength(1);
      expect(laneEvents[0]?.payload).toMatchObject({ planLane: "in_progress" });
    }),
  );

  it.effect("submit with no outcome ⇒ report-set + outcome-recorded(terminal) + lane done", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decide(submit(), readModel);
      expect(events.map((event) => event.type)).toEqual([
        "thread.report-set",
        "thread.outcome-recorded",
        "thread.plan-lane-set",
      ]);
      expect(events[0]?.payload).toMatchObject({ reportPath: "/reports/thread-1.md" });
      expect(events[1]?.payload).toMatchObject({
        outcome: "done",
        decision: "terminal",
        round: 0,
      });
      expect(events[2]?.payload).toMatchObject({ planLane: "done" });
    }),
  );

  it.effect("submit `needs_human` ⇒ needs_guidance raised, lane untouched", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decide(submit("needs_human"), readModel);
      expect(events.map((event) => event.type)).toEqual([
        "thread.report-set",
        "thread.outcome-recorded",
        "thread.attention-raised",
      ]);
      expect(events[1]?.payload).toMatchObject({ decision: "attention" });
      expect(events[2]?.payload).toMatchObject({ reason: "needs_guidance" });
    }),
  );

  it.effect("submit with an unknown outcome ⇒ lane `yielded` (escalation is the default)", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const events = yield* decide(submit("rework_approach"), readModel);
      expect(events.map((event) => event.type)).toEqual([
        "thread.report-set",
        "thread.outcome-recorded",
        "thread.plan-lane-set",
      ]);
      expect(events[1]?.payload).toMatchObject({
        outcome: "rework_approach",
        decision: "yield",
      });
      expect(events[2]?.payload).toMatchObject({ planLane: "yielded" });
    }),
  );
});
