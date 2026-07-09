// Review gates Phase 3 (docs/design/workstream-review-gates.md §4–§5):
// decider-level routing on `thread.work.submit` (loop / resolve / cap-breach /
// interception via `pendingRework`), the terminal-lane submit guard, and the
// server-only `reopen` turn-start flag (done → in_progress, never from
// cancelled) with its released-dependents warning activity.
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-01-01T00:00:00.000Z";
const PARENT = ThreadId.make("parent-1");
const CODER = ThreadId.make("coder-1");
const REVIEWER = ThreadId.make("reviewer-1");

let seededSequence = 0;

const seedEvent = (
  overrides: Pick<OrchestrationEvent, "aggregateKind" | "aggregateId" | "type" | "payload">,
): OrchestrationEvent =>
  ({
    sequence: ++seededSequence,
    eventId: EventId.make(`evt-${seededSequence}`),
    occurredAt: now,
    commandId: CommandId.make("server:seed"),
    causationEventId: null,
    correlationId: CommandId.make("server:seed"),
    metadata: {},
    ...overrides,
  }) as OrchestrationEvent;

const threadCreated = (threadId: ThreadId, extra: Record<string, unknown> = {}) =>
  seedEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    payload: {
      threadId,
      projectId: ProjectId.make("project-1"),
      title: `Thread ${threadId}`,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      ...extra,
    },
  });

const apply = (readModel: OrchestrationReadModel, events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    let model = readModel;
    for (const event of events) model = yield* projectEvent(model, event);
    return model;
  });

/** Apply decided (sequence-less) events back onto the read model. */
const applyDecided = (
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
) =>
  apply(
    readModel,
    events.map((event) => ({ ...event, sequence: ++seededSequence }) as OrchestrationEvent),
  );

const GATE_ROUTES = [
  { on: ["needs_rework"], kind: "loop", to: CODER, maxRounds: 2 },
  { on: ["clean", "fixed_inline"], kind: "resolve" },
];

/** Parent + gated coder/reviewer pair, coder already `done` at round 0. */
const seedGateModel = Effect.gen(function* () {
  seededSequence = 0;
  return yield* apply(createEmptyReadModel(now), [
    seedEvent({
      aggregateKind: "project",
      aggregateId: ProjectId.make("project-1"),
      type: "project.created",
      payload: {
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project-1",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
    threadCreated(PARENT),
    threadCreated(CODER, { parentThreadId: PARENT, planLane: "done" }),
    threadCreated(REVIEWER, {
      parentThreadId: PARENT,
      planLane: "in_progress",
      routes: GATE_ROUTES,
      blockedBy: [CODER],
    }),
  ]);
});

const submit = (threadId: ThreadId, outcome?: string): OrchestrationCommand => ({
  type: "thread.work.submit",
  commandId: CommandId.make(`server:workstream-submit:test-${threadId}-${outcome ?? "done"}`),
  threadId,
  reportPath: `/reports/${threadId}.md`,
  ...(outcome !== undefined ? { outcome } : {}),
  createdAt: now,
});

const turnStart = (
  threadId: ThreadId,
  overrides: Partial<Extract<OrchestrationCommand, { type: "thread.turn.start" }>> = {},
): OrchestrationCommand => ({
  type: "thread.turn.start",
  commandId: CommandId.make(`server:workstream-gate:test:${threadId}`),
  threadId,
  message: {
    messageId: MessageId.make(`msg-${threadId}-${seededSequence}`),
    role: "user",
    text: "resume",
    attachments: [],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: now,
  ...overrides,
});

const decide = (command: OrchestrationCommand, readModel: OrchestrationReadModel) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((decided) => (Array.isArray(decided) ? decided : [decided])),
  );

it.layer(NodeServices.layer)("decider review-gate routing (Phase 3)", (it) => {
  it.effect(
    "reviewer needs_rework under the cap → loop: outcome + route-taken, lane untouched",
    () =>
      Effect.gen(function* () {
        const readModel = yield* seedGateModel;
        const events = yield* decide(submit(REVIEWER, "needs_rework"), readModel);
        expect(events.map((event) => event.type)).toEqual([
          "thread.report-set",
          "thread.outcome-recorded",
          "thread.route-taken",
        ]);
        expect(events[1]?.payload).toMatchObject({ decision: "loop", round: 1 });
        expect(events[2]?.payload).toMatchObject({ threadId: REVIEWER, to: CODER, round: 1 });
        // Projection: the traversal opens the coder's rework round and advances
        // the reviewer's round counter.
        const next = yield* applyDecided(readModel, events);
        expect(next.threads.find((t) => t.id === CODER)?.pendingRework).toBe(true);
        expect(next.threads.find((t) => t.id === REVIEWER)?.gateRounds).toBe(1);
        // The reviewer's lane is untouched — it waits in the gate in_progress.
        expect(next.threads.find((t) => t.id === REVIEWER)?.planLane).toBe("in_progress");
      }),
  );

  it.effect("reviewer clean with coder already done → resolve emits only the reviewer's done", () =>
    Effect.gen(function* () {
      const readModel = yield* seedGateModel;
      const events = yield* decide(submit(REVIEWER, "clean"), readModel);
      const laneEvents = events.filter((event) => event.type === "thread.plan-lane-set");
      expect(laneEvents).toHaveLength(1);
      expect(laneEvents[0]?.payload).toMatchObject({ threadId: REVIEWER, planLane: "done" });
      expect(events[1]?.payload).toMatchObject({ decision: "resolve" });
    }),
  );

  it.effect("gate reopen: server turn-start with reopen flips done → in_progress atomically", () =>
    Effect.gen(function* () {
      const readModel = yield* seedGateModel;
      const events = yield* decide(turnStart(CODER, { reopen: true }), readModel);
      const laneEvents = events.filter((event) => event.type === "thread.plan-lane-set");
      expect(laneEvents).toHaveLength(1);
      expect(laneEvents[0]?.payload).toMatchObject({ threadId: CODER, planLane: "in_progress" });
    }),
  );

  it.effect("reopen is rejected from a non-server command id", () =>
    Effect.gen(function* () {
      const readModel = yield* seedGateModel;
      const exit = yield* Effect.exit(
        decide(
          turnStart(CODER, { reopen: true, commandId: CommandId.make("11111111-2222") }),
          readModel,
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("reopen is rejected on a cancelled thread — cancelled stays dead", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedGateModel, (model) =>
        apply(model, [
          seedEvent({
            aggregateKind: "thread",
            aggregateId: CODER,
            type: "thread.plan-lane-set",
            payload: { threadId: CODER, planLane: "cancelled", updatedAt: now },
          }),
        ]),
      );
      const exit = yield* Effect.exit(decide(turnStart(CODER, { reopen: true }), readModel));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect(
    "reopen with an already-started dependent appends the §5.2 warning activity on the parent",
    () =>
      Effect.gen(function* () {
        const DOWNSTREAM = ThreadId.make("downstream-1");
        const readModel = yield* Effect.flatMap(seedGateModel, (model) =>
          apply(model, [
            threadCreated(DOWNSTREAM, { parentThreadId: PARENT, blockedBy: [CODER] }),
            // Started: the dependent already has a user message (its kickoff ran).
            seedEvent({
              aggregateKind: "thread",
              aggregateId: DOWNSTREAM,
              type: "thread.message-sent",
              payload: {
                threadId: DOWNSTREAM,
                messageId: MessageId.make("msg-downstream"),
                role: "user",
                text: "kickoff",
                attachments: [],
                turnId: null,
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            }),
          ]),
        );
        const events = yield* decide(turnStart(CODER, { reopen: true }), readModel);
        const warning = events.find((event) => event.type === "thread.activity-appended");
        expect(warning).toBeDefined();
        expect(warning?.aggregateId).toBe(PARENT);
        expect(warning?.payload).toMatchObject({ threadId: PARENT });
        const activity = (warning?.payload as { activity: { kind: string; summary: string } })
          .activity;
        expect(activity.kind).toBe("workstream.gate.reopened-with-started-dependents");
        expect(activity.summary).toContain("Warning");
      }),
  );

  it.effect("full loop round-trip: rework → intercepted done → delta re-verify → resolve", () =>
    Effect.gen(function* () {
      let model = yield* seedGateModel;
      // Round 1 opens: reviewer returns findings.
      model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
      // Gate pass reopens the coder (done → in_progress).
      model = yield* applyDecided(model, yield* decide(turnStart(CODER, { reopen: true }), model));
      expect(model.threads.find((t) => t.id === CODER)?.planLane).toBe("in_progress");
      // Coder submits done mid-round → INTERCEPTED: stays in_progress, routes
      // back to the reviewer, and the open round closes.
      const intercepted = yield* decide(submit(CODER, "done"), model);
      expect(intercepted.map((event) => event.type)).toEqual([
        "thread.report-set",
        "thread.outcome-recorded",
        "thread.route-taken",
      ]);
      expect(intercepted[1]?.payload).toMatchObject({ decision: "loop", round: 1 });
      expect(intercepted[2]?.payload).toMatchObject({ threadId: CODER, to: REVIEWER, round: 1 });
      model = yield* applyDecided(model, intercepted);
      const coder = model.threads.find((t) => t.id === CODER);
      expect(coder?.planLane).toBe("in_progress");
      expect(coder?.pendingRework).toBe(false);
      // Reverse traversal advances no counters.
      expect(model.threads.find((t) => t.id === REVIEWER)?.gateRounds).toBe(1);
      // Reviewer re-verifies clean → BOTH parties complete in one transaction.
      const resolved = yield* decide(submit(REVIEWER, "clean"), model);
      const laneEvents = resolved.filter((event) => event.type === "thread.plan-lane-set");
      expect(laneEvents.map((event) => event.payload)).toEqual([
        expect.objectContaining({ threadId: REVIEWER, planLane: "done" }),
        expect.objectContaining({ threadId: CODER, planLane: "done" }),
      ]);
      model = yield* applyDecided(model, resolved);
      expect(model.threads.find((t) => t.id === REVIEWER)?.planLane).toBe("done");
      expect(model.threads.find((t) => t.id === CODER)?.planLane).toBe("done");
    }),
  );

  it.effect("cap breach: needs_rework with rounds exhausted → reviewer yielded, no route", () =>
    Effect.gen(function* () {
      let model = yield* seedGateModel;
      // Consume both rounds.
      for (const round of [1, 2]) {
        model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
        model = yield* applyDecided(
          model,
          yield* decide(
            turnStart(CODER, {
              reopen: round === 1 ? true : undefined,
              commandId: CommandId.make(`server:workstream-gate:test:${round}`),
            }),
            model,
          ),
        );
        model = yield* applyDecided(model, yield* decide(submit(CODER, "done"), model));
      }
      expect(model.threads.find((t) => t.id === REVIEWER)?.gateRounds).toBe(2);
      const events = yield* decide(submit(REVIEWER, "needs_rework"), model);
      expect(events.map((event) => event.type)).toEqual([
        "thread.report-set",
        "thread.outcome-recorded",
        "thread.plan-lane-set",
      ]);
      expect(events[1]?.payload).toMatchObject({ decision: "cap-breach", round: 2 });
      expect(events[2]?.payload).toMatchObject({ threadId: REVIEWER, planLane: "yielded" });
    }),
  );

  it.effect("coder mid-round non-done outcome routes back for re-verification", () =>
    Effect.gen(function* () {
      let model = yield* seedGateModel;
      model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
      model = yield* applyDecided(model, yield* decide(turnStart(CODER, { reopen: true }), model));
      const events = yield* decide(submit(CODER, "fixed"), model);
      expect(events.map((event) => event.type)).toEqual([
        "thread.report-set",
        "thread.outcome-recorded",
        "thread.route-taken",
      ]);
      expect(events[1]?.payload).toMatchObject({ outcome: "fixed", decision: "loop", round: 1 });
      expect(events[2]?.payload).toMatchObject({ threadId: CODER, to: REVIEWER, round: 1 });
    }),
  );

  it.effect("R4: reviewer needs_rework against a cancelled coder yields instead of routing", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedGateModel, (model) =>
        apply(model, [
          seedEvent({
            aggregateKind: "thread",
            aggregateId: CODER,
            type: "thread.plan-lane-set",
            payload: { threadId: CODER, planLane: "cancelled", updatedAt: now },
          }),
        ]),
      );
      const events = yield* decide(submit(REVIEWER, "needs_rework"), readModel);
      expect(events[1]?.payload).toMatchObject({ decision: "yield" });
      expect(events[2]?.payload).toMatchObject({ threadId: REVIEWER, planLane: "yielded" });
    }),
  );

  it.effect("terminal-lane guard: a submit on a cancelled thread is rejected (stays dead)", () =>
    Effect.gen(function* () {
      const readModel = yield* Effect.flatMap(seedGateModel, (model) =>
        apply(model, [
          seedEvent({
            aggregateKind: "thread",
            aggregateId: REVIEWER,
            type: "thread.plan-lane-set",
            payload: { threadId: REVIEWER, planLane: "cancelled", updatedAt: now },
          }),
        ]),
      );
      const exit = yield* Effect.exit(decide(submit(REVIEWER, "clean"), readModel));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("terminal-lane guard: a submit on an already-done thread is rejected", () =>
    Effect.gen(function* () {
      const readModel = yield* seedGateModel;
      const exit = yield* Effect.exit(decide(submit(CODER, "done"), readModel));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  // 2026-07-07 incident: parent force-`done` on the coder mid-rework-round
  // must not wedge the gate — the coder's terminal submit still routes back to
  // the reviewer (intercepted loop), instead of being rejected by the
  // terminal-lane guard while the reviewer waits forever.
  it.effect(
    "incident: a done coder with an open rework round still routes its submit to the reviewer",
    () =>
      Effect.gen(function* () {
        let model = yield* seedGateModel;
        // Round 1 opens and the gate pass reopens the coder for rework.
        model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
        model = yield* applyDecided(
          model,
          yield* decide(turnStart(CODER, { reopen: true }), model),
        );
        // Parent accepts the coder mid-round (decision 9 — the write is legal).
        const laneEvents = yield* decide(
          {
            type: "thread.plan-lane.set",
            commandId: CommandId.make("server:workstream-lane:test-force-done"),
            threadId: CODER,
            planLane: "done",
            createdAt: now,
          },
          model,
        );
        // The force-done is warned on the parent: the gate is NOT resolved.
        const warning = laneEvents.find((event) => event.type === "thread.activity-appended");
        expect(warning).toBeDefined();
        expect(warning?.aggregateId).toBe(PARENT);
        const activity = (warning!.payload as { activity: { kind: string; summary: string } })
          .activity;
        expect(activity.kind).toBe("workstream.gate.target-done-mid-round");
        expect(activity.summary).toContain("NOT resolved");
        model = yield* applyDecided(model, laneEvents);
        expect(model.threads.find((t) => t.id === CODER)?.planLane).toBe("done");
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(true);
        // The coder's terminal submit is NOT rejected: it is the intercepted
        // loop back to the reviewer, with the lane left untouched (sticky done).
        const events = yield* decide(submit(CODER, "done"), model);
        expect(events.map((event) => event.type)).toEqual([
          "thread.report-set",
          "thread.outcome-recorded",
          "thread.route-taken",
        ]);
        expect(events[1]?.payload).toMatchObject({ decision: "loop", round: 1 });
        expect(events[2]?.payload).toMatchObject({ threadId: CODER, to: REVIEWER, round: 1 });
        model = yield* applyDecided(model, events);
        expect(model.threads.find((t) => t.id === CODER)?.planLane).toBe("done");
        // The reviewer's re-verify then resolves the gate normally; the coder
        // is already terminal so only the reviewer's lane event is emitted.
        const resolved = yield* decide(submit(REVIEWER, "clean"), model);
        const resolvedLanes = resolved.filter((event) => event.type === "thread.plan-lane-set");
        expect(resolvedLanes).toHaveLength(1);
        expect(resolvedLanes[0]?.payload).toMatchObject({ threadId: REVIEWER, planLane: "done" });
      }),
  );

  it.effect(
    "incident guard: force-done on a coder WITHOUT an open round appends no warning and its submit stays rejected",
    () =>
      Effect.gen(function* () {
        const model = yield* seedGateModel;
        // Coder is round-0 done, no rework round open.
        const laneEvents = yield* decide(
          {
            type: "thread.plan-lane.set",
            commandId: CommandId.make("server:workstream-lane:test-plain-done"),
            threadId: CODER,
            planLane: "done",
            createdAt: now,
          },
          model,
        );
        expect(laneEvents.some((event) => event.type === "thread.activity-appended")).toBe(false);
        const exit = yield* Effect.exit(decide(submit(CODER, "done"), model));
        expect(Exit.isFailure(exit)).toBe(true);
      }),
  );

  it.effect("parent set_lane done on the reviewer dissolves the gate mid-loop", () =>
    Effect.gen(function* () {
      let model = yield* seedGateModel;
      model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
      model = yield* applyDecided(model, yield* decide(turnStart(CODER, { reopen: true }), model));
      // Parent accepts the reviewer as-is (server:workstream-lane path).
      model = yield* applyDecided(
        model,
        yield* decide(
          {
            type: "thread.plan-lane.set",
            commandId: CommandId.make("server:workstream-lane:test"),
            threadId: REVIEWER,
            planLane: "done",
            createdAt: now,
          },
          model,
        ),
      );
      // Gate now resolved (source terminal): the coder's next done is PLAIN
      // terminal, not intercepted, even though its rework round was open.
      const events = yield* decide(submit(CODER, "done"), model);
      expect(events[1]?.payload).toMatchObject({ decision: "terminal" });
      expect(events[2]?.payload).toMatchObject({ threadId: CODER, planLane: "done" });
    }),
  );

  // Issue 2 (2026-07-06 incident): manual gate recovery via a bare
  // `set_lane(coder, ready)` must restore the coder's lost `pendingRework` so a
  // subsequent submission still loops back to the reviewer instead of escaping
  // the gate as a plain terminal/yield.
  it.effect(
    "Issue 2: set_lane(coder, ready) recovery restores pendingRework so the next done loops to the reviewer",
    () =>
      Effect.gen(function* () {
        let model = yield* seedGateModel;
        // Round 1 opens: the reviewer loops its findings back to the coder.
        model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(true);
        // The gate state is then lost: the coder's rework round closes and it
        // lands terminal `done` WITHOUT looping back (the incident's escape).
        model = yield* apply(model, [
          seedEvent({
            aggregateKind: "thread",
            aggregateId: CODER,
            type: "thread.outcome-recorded",
            payload: {
              threadId: CODER,
              outcome: "done",
              decision: "terminal",
              round: 0,
              updatedAt: now,
            },
          }),
        ]);
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(false);
        // The reviewer still owes the loop round (non-terminal, lastOutcome=loop).
        expect(model.threads.find((t) => t.id === REVIEWER)?.lastOutcome?.decision).toBe("loop");
        // Manual recovery: the orchestrator reopens the coder to `ready`.
        model = yield* applyDecided(
          model,
          yield* decide(
            {
              type: "thread.plan-lane.set",
              commandId: CommandId.make("server:workstream-lane:test-recovery"),
              threadId: CODER,
              planLane: "ready",
              createdAt: now,
            },
            model,
          ),
        );
        // Fix: the reopen restored pendingRework from the still-open gate.
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(true);
        // The coder's plain `done` now loops back to the reviewer, not terminal.
        const events = yield* decide(submit(CODER, "done"), model);
        expect(events.map((event) => event.type)).toEqual([
          "thread.report-set",
          "thread.outcome-recorded",
          "thread.route-taken",
        ]);
        expect(events[1]?.payload).toMatchObject({ decision: "loop", round: 1 });
        expect(events[2]?.payload).toMatchObject({ threadId: CODER, to: REVIEWER, round: 1 });
      }),
  );

  it.effect(
    "Issue 2 guard: reopening a coder does NOT restore pendingRework once the gate is dissolved",
    () =>
      Effect.gen(function* () {
        let model = yield* seedGateModel;
        model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
        // The orchestrator dissolves the gate (reviewer accepted → terminal) and
        // the coder's round closes — a deliberate detach, not a recovery.
        model = yield* apply(model, [
          seedEvent({
            aggregateKind: "thread",
            aggregateId: REVIEWER,
            type: "thread.plan-lane-set",
            payload: { threadId: REVIEWER, planLane: "done", updatedAt: now },
          }),
          seedEvent({
            aggregateKind: "thread",
            aggregateId: CODER,
            type: "thread.outcome-recorded",
            payload: {
              threadId: CODER,
              outcome: "done",
              decision: "terminal",
              round: 0,
              updatedAt: now,
            },
          }),
        ]);
        // Reopening the coder finds no live source → pendingRework stays false.
        model = yield* applyDecided(
          model,
          yield* decide(
            {
              type: "thread.plan-lane.set",
              commandId: CommandId.make("server:workstream-lane:test-detach"),
              threadId: CODER,
              planLane: "ready",
              createdAt: now,
            },
            model,
          ),
        );
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(false);
        // And the coder's done is a clean terminal, not a loop into a dead gate.
        const events = yield* decide(submit(CODER, "done"), model);
        expect(events[1]?.payload).toMatchObject({ decision: "terminal" });
      }),
  );

  // Issue 1 (2026-07-08 incident): the parent CANCELS a reviewer mid-rework-
  // round and spawns a fresh replacement over the same coder. The cancel must
  // dissolve the orphaned round (clear the coder's pendingRework) so the
  // coder's later submit lands ALIVE as a plain round-0 done that releases the
  // replacement through the ordinary blockedBy edge — never a loop into the
  // dead predecessor gate (the deadlock), and never intercepted "back" to a
  // replacement that has not reviewed. The replacement restarts at round 0.
  it.effect(
    "Issue 1: cancelling a reviewer mid-round dissolves the round; the coder's submit lands alive on a replacement",
    () =>
      Effect.gen(function* () {
        const REPLACEMENT = ThreadId.make("reviewer-2");
        let model = yield* seedGateModel;
        // Round 1 opens: the original reviewer loops findings back to the coder,
        // and the gate pass reopens the coder (done → in_progress) for rework.
        model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
        model = yield* applyDecided(
          model,
          yield* decide(turnStart(CODER, { reopen: true }), model),
        );
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(true);
        expect(model.threads.find((t) => t.id === CODER)?.planLane).toBe("in_progress");
        // The parent cancels the original reviewer (near its token limit) — the
        // cancel cascade runs through the real decider + projector.
        model = yield* applyDecided(
          model,
          yield* decide(
            {
              type: "thread.plan-lane.set",
              commandId: CommandId.make("server:workstream-lane:test-cancel-reviewer"),
              threadId: REVIEWER,
              planLane: "cancelled",
              createdAt: now,
            },
            model,
          ),
        );
        expect(model.threads.find((t) => t.id === REVIEWER)?.planLane).toBe("cancelled");
        // Fix: cancelling the gate SOURCE dissolved the coder's orphaned round.
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(false);
        // The parent spawns a fresh replacement reviewer over the SAME coder,
        // blockedBy the coder, with the same gate (round 0 — a new edge).
        model = yield* apply(model, [
          threadCreated(REPLACEMENT, {
            parentThreadId: PARENT,
            planLane: "ready",
            routes: GATE_ROUTES,
            blockedBy: [CODER],
          }),
        ]);
        expect(model.threads.find((t) => t.id === REPLACEMENT)?.gateRounds).toBe(0);
        // The coder finishes its rework and submits. With the orphaned round
        // dissolved this is a PLAIN terminal done (round 0), not a loop — it
        // releases the replacement through the ordinary dependency edge.
        const events = yield* decide(submit(CODER, "done"), model);
        expect(events.map((event) => event.type)).toEqual([
          "thread.report-set",
          "thread.outcome-recorded",
          "thread.plan-lane-set",
        ]);
        expect(events[1]?.payload).toMatchObject({ decision: "terminal" });
        expect(events[2]?.payload).toMatchObject({ threadId: CODER, planLane: "done" });
        model = yield* applyDecided(model, events);
        expect(model.threads.find((t) => t.id === CODER)?.planLane).toBe("done");
        // The replacement's dependency is now satisfied (coder done) — not wedged.
        // Its later needs_rework opens a FRESH round 1 on the coder (re-granted
        // cap on the new edge), which the coder is reopened for as normal.
        const replayReview = yield* decide(submit(REPLACEMENT, "needs_rework"), model);
        expect(replayReview[1]?.payload).toMatchObject({ decision: "loop", round: 1 });
        expect(replayReview[2]?.payload).toMatchObject({
          threadId: REPLACEMENT,
          to: CODER,
          round: 1,
        });
      }),
  );

  // Issue 1 (round-1 review finding): the SYMMETRIC Decision-9 path. A parent
  // `set_lane(done)` on the reviewer source dissolves the gate exactly as a
  // cancel does (design §4.1/§5.4 — resolution keys off source terminality), so
  // it must ALSO clear the coder's orphaned round. Otherwise a replacement
  // reviewer spawned over the same still-`pendingRework` coder is mis-seen as
  // the live `gateSourceFor` and the coder's submit emits an orphaned round-0
  // loop the dispatcher never delivers — the same wedge class as the cancel
  // incident.
  it.effect(
    "Issue 1: parent set_lane(done) on the reviewer also dissolves the round; the coder's submit lands alive on a replacement",
    () =>
      Effect.gen(function* () {
        const REPLACEMENT = ThreadId.make("reviewer-2");
        let model = yield* seedGateModel;
        // Round 1 opens and the coder is reopened for rework.
        model = yield* applyDecided(model, yield* decide(submit(REVIEWER, "needs_rework"), model));
        model = yield* applyDecided(
          model,
          yield* decide(turnStart(CODER, { reopen: true }), model),
        );
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(true);
        // The parent accepts the reviewer as-is (set_lane done dissolves the gate).
        model = yield* applyDecided(
          model,
          yield* decide(
            {
              type: "thread.plan-lane.set",
              commandId: CommandId.make("server:workstream-lane:test-done-reviewer"),
              threadId: REVIEWER,
              planLane: "done",
              createdAt: now,
            },
            model,
          ),
        );
        expect(model.threads.find((t) => t.id === REVIEWER)?.planLane).toBe("done");
        // Fix: a terminal `done` source dissolves the coder's orphaned round too.
        expect(model.threads.find((t) => t.id === CODER)?.pendingRework).toBe(false);
        // A fresh replacement reviewer is spawned over the same coder.
        model = yield* apply(model, [
          threadCreated(REPLACEMENT, {
            parentThreadId: PARENT,
            planLane: "ready",
            routes: GATE_ROUTES,
            blockedBy: [CODER],
          }),
        ]);
        // The coder submits: a PLAIN terminal done (round 0), not an orphaned
        // loop into the replacement that never reviewed.
        const events = yield* decide(submit(CODER, "done"), model);
        expect(events.map((event) => event.type)).toEqual([
          "thread.report-set",
          "thread.outcome-recorded",
          "thread.plan-lane-set",
        ]);
        expect(events[1]?.payload).toMatchObject({ decision: "terminal" });
        expect(events[2]?.payload).toMatchObject({ threadId: CODER, planLane: "done" });
      }),
  );
});
