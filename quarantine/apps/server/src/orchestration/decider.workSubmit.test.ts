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
const CHILD = ThreadId.make("thread-child-1");

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

/** Seed a sub-thread of THREAD carrying a spawn generation. */
const withChild = (readModel: OrchestrationReadModel) =>
  projectEvent(readModel, {
    sequence: 3,
    eventId: EventId.make("evt-child"),
    aggregateKind: "thread",
    aggregateId: CHILD,
    type: "thread.created",
    occurredAt: now,
    commandId: CommandId.make("cmd-child"),
    causationEventId: null,
    correlationId: CommandId.make("cmd-child"),
    metadata: {},
    payload: {
      threadId: CHILD,
      projectId: ProjectId.make("project-1"),
      parentThreadId: THREAD,
      role: "coder",
      purpose: "do the thing",
      planLane: "ready",
      spawnGeneration: "gen-epoch-0",
      title: "Child",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });

/** Apply a plan lane onto a thread (as prior lifecycle events would). */
const withLane = (
  readModel: OrchestrationReadModel,
  threadId: ThreadId,
  planLane: "planned" | "ready" | "in_progress" | "done" | "cancelled",
  sequence: number,
) =>
  projectEvent(readModel, {
    sequence,
    eventId: EventId.make(`evt-lane-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.plan-lane-set",
    occurredAt: now,
    commandId: CommandId.make("server:test"),
    causationEventId: null,
    correlationId: CommandId.make("server:test"),
    metadata: {},
    payload: { threadId, planLane, updatedAt: now },
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

// Re-engagement epoch (design §5.2 exception): a parent/human reopening a
// terminal sub-thread via the lane-set path stamps a fresh spawnGeneration so
// the re-run's completion fires a fresh (receipt-deduped) parent wake instead
// of being swallowed by the first completion's receipt.
it.layer(NodeServices.layer)("decider re-engagement epoch (parent reopen)", (it) => {
  const laneSet = (
    planLane: "planned" | "ready" | "done",
    threadId: ThreadId = CHILD,
  ): OrchestrationCommand => ({
    type: "thread.plan-lane.set",
    commandId: CommandId.make("11111111-2222-3333"),
    threadId,
    planLane,
    createdAt: now,
  });

  it.effect("reopening a done sub-thread to `ready` stamps a fresh spawnGeneration", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, withChild).pipe(
        Effect.flatMap((model) => withLane(model, CHILD, "done", 4)),
      );
      const events = yield* decide(laneSet("ready"), readModel);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.plan-lane-set");
      const payload = events[0]?.payload as { spawnGeneration?: string };
      expect(payload.spawnGeneration).toBeDefined();
      expect(payload.spawnGeneration).not.toBe("gen-epoch-0");
    }),
  );

  it.effect("reopening a cancelled sub-thread to `planned` also stamps a fresh generation", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, withChild).pipe(
        Effect.flatMap((model) => withLane(model, CHILD, "cancelled", 4)),
      );
      const events = yield* decide(laneSet("planned"), readModel);
      const payload = events[0]?.payload as { spawnGeneration?: string };
      expect(payload.spawnGeneration).toBeDefined();
      expect(payload.spawnGeneration).not.toBe("gen-epoch-0");
    }),
  );

  it.effect("a non-reopen lane-set (planned → ready release) does NOT stamp a generation", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, withChild).pipe(
        Effect.flatMap((model) => withLane(model, CHILD, "planned", 4)),
      );
      const events = yield* decide(laneSet("ready"), readModel);
      expect((events[0]!.payload as { spawnGeneration?: string }).spawnGeneration).toBeUndefined();
    }),
  );

  it.effect("reopening a done ROOT thread does not stamp (no parent to wake)", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, (model) =>
        withLane(model, THREAD, "done", 3),
      );
      const events = yield* decide(laneSet("ready", THREAD), readModel);
      expect((events[0]!.payload as { spawnGeneration?: string }).spawnGeneration).toBeUndefined();
    }),
  );

  it.effect("a turn-start on a `ready` thread flips it to `in_progress` (reopened child)", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, withChild);
      const events = yield* decide(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("44444444-5555-6666"),
          threadId: CHILD,
          message: {
            messageId: MessageId.make("msg-ready"),
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

  it.effect("a gate `reopen` turn-start does NOT refresh the generation (§5.2 semantics)", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedReadModel, withChild).pipe(
        Effect.flatMap((model) => withLane(model, CHILD, "done", 4)),
      );
      const events = yield* decide(
        {
          type: "thread.turn.start",
          commandId: CommandId.make("server:workstream-gate:test"),
          threadId: CHILD,
          reopen: true,
          message: {
            messageId: MessageId.make("msg-rework"),
            role: "user",
            text: "rework findings",
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
      expect(
        (laneEvents[0]!.payload as { spawnGeneration?: string }).spawnGeneration,
      ).toBeUndefined();
    }),
  );
});
