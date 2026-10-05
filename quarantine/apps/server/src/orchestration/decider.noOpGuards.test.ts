// W2-4 — decider-level unchanged-value guards for the set-style commands.
//
// The acceptance form from `plans/cockpit-performance-remediation/plan.mdx`:
// replaying any set-style command with an identical payload appends ZERO events.
// Each case here writes once (asserting the real event, so a guard cannot pass by
// suppressing everything), folds that event into the read model, then replays the
// same payload under a fresh command id and asserts an empty event list.
//
// Why it matters: every event below is a `WorkstreamDispatcher` trigger, so a
// redundant echo bought a full pass over the whole active thread set (~1.5s at
// 1,168 threads; one fan-in retry incident raised an already-set attention flag
// 13,420 times).
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
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
const PROJECT = ProjectId.make("project-noop");
const PARENT = ThreadId.make("parent-1");
const CHILD_A = ThreadId.make("child-a");
const CHILD_B = ThreadId.make("child-b");

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

const threadCreated = (threadId: ThreadId, extra: Record<string, unknown> = {}) =>
  seedEvent({
    aggregateKind: "thread",
    aggregateId: threadId,
    type: "thread.created",
    payload: {
      threadId,
      projectId: PROJECT,
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

/** Project + parent + two sibling children every fixture builds on. */
const base = Effect.gen(function* () {
  seq = 0;
  return yield* apply(createEmptyReadModel(now), [
    seedEvent({
      aggregateKind: "project",
      aggregateId: PROJECT,
      type: "project.created",
      payload: {
        projectId: PROJECT,
        title: "No-op guards",
        workspaceRoot: "/tmp/noop",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      },
    }),
    threadCreated(PARENT),
    threadCreated(CHILD_A, { parentThreadId: PARENT, role: "coder", purpose: "work" }),
    threadCreated(CHILD_B, { parentThreadId: PARENT, role: "coder", purpose: "work" }),
  ]);
});

const decide = (readModel: OrchestrationReadModel, command: OrchestrationCommand) =>
  decideOrchestrationCommand({ command, readModel }).pipe(
    Effect.map((result) => (Array.isArray(result) ? result : [result])),
  );

/**
 * Write once, then replay the identical payload under a fresh command id (the
 * engine's receipt store dedups the SAME id, so a payload-level guard is only
 * observable with a different one).
 */
const writeThenReplay = (
  readModel: OrchestrationReadModel,
  command: (commandId: CommandId) => OrchestrationCommand,
) =>
  Effect.gen(function* () {
    const first = yield* decide(readModel, command(CommandId.make("server:noop:first")));
    const applied = yield* apply(
      readModel,
      first.map((event) => ({ ...event, sequence: ++seq }) as OrchestrationEvent),
    );
    const replayed = yield* decide(applied, command(CommandId.make("server:noop:replay")));
    return { first: first.map((event) => event.type), replayed, applied };
  });

it.layer(NodeServices.layer)("W2-4 unchanged-value guards (set-style commands)", (it) => {
  it.effect("thread.attention.raise — an already-raised reason emits nothing", () =>
    Effect.gen(function* () {
      const { first, replayed } = yield* writeThenReplay(yield* base, (commandId) => ({
        type: "thread.attention.raise",
        commandId,
        threadId: CHILD_A,
        reason: "needs_guidance",
        createdAt: now,
      }));
      expect(first).toEqual(["thread.attention-raised"]);
      expect(replayed).toEqual([]);
    }),
  );

  it.effect("thread.attention.clear — nothing to clear emits nothing (all + by reason)", () =>
    Effect.gen(function* () {
      const flagged = yield* apply(yield* base, [
        seedEvent({
          aggregateKind: "thread",
          aggregateId: CHILD_A,
          type: "thread.attention-raised",
          payload: { threadId: CHILD_A, reason: "needs_guidance", updatedAt: now },
        }),
      ]);
      // Clear-all: writes once, then the thread carries nothing to clear.
      const all = yield* writeThenReplay(flagged, (commandId) => ({
        type: "thread.attention.clear",
        commandId,
        threadId: CHILD_A,
        createdAt: now,
      }));
      expect(all.first).toEqual(["thread.attention-cleared"]);
      expect(all.replayed).toEqual([]);

      // By reason: the flag that is up clears once; a reason that was never up is
      // a no-op from the start.
      const byReason = yield* writeThenReplay(flagged, (commandId) => ({
        type: "thread.attention.clear",
        commandId,
        threadId: CHILD_A,
        reason: "needs_guidance",
        createdAt: now,
      }));
      expect(byReason.first).toEqual(["thread.attention-cleared"]);
      expect(byReason.replayed).toEqual([]);
      expect(
        yield* decide(flagged, {
          type: "thread.attention.clear",
          commandId: CommandId.make("server:noop:absent"),
          threadId: CHILD_A,
          reason: "awaiting_acceptance",
          createdAt: now,
        }),
      ).toEqual([]);
    }),
  );

  it.effect("thread.plan-lane.set — the stored lane emits nothing (non-terminal and done)", () =>
    Effect.gen(function* () {
      const ready = yield* writeThenReplay(yield* base, (commandId) => ({
        type: "thread.plan-lane.set",
        commandId,
        threadId: CHILD_A,
        planLane: "ready",
        createdAt: now,
      }));
      expect(ready.first).toEqual(["thread.plan-lane-set"]);
      expect(ready.replayed).toEqual([]);

      const done = yield* writeThenReplay(ready.applied, (commandId) => ({
        type: "thread.plan-lane.set",
        commandId,
        threadId: CHILD_A,
        planLane: "done",
        createdAt: now,
      }));
      expect(done.first).toEqual(["thread.plan-lane-set"]);
      expect(done.replayed).toEqual([]);
    }),
  );

  it.effect("thread.plan-lane.set cancelled — a settled subtree re-cancel emits nothing", () =>
    Effect.gen(function* () {
      // The cascade still SWEEPS on a repeat cancel (descendants and in-flight
      // turns may not have settled on the earlier pass); the guard drops only the
      // redundant lane events, so a fully-settled subtree yields nothing.
      const cancelled = yield* writeThenReplay(yield* base, (commandId) => ({
        type: "thread.plan-lane.set",
        commandId,
        threadId: PARENT,
        planLane: "cancelled",
        createdAt: now,
      }));
      expect(cancelled.first).toEqual([
        "thread.plan-lane-set",
        "thread.plan-lane-set",
        "thread.plan-lane-set",
      ]);
      expect(cancelled.replayed).toEqual([]);
    }),
  );

  it.effect("thread.dependencies.set — an identical blockedBy set emits nothing", () =>
    Effect.gen(function* () {
      const deps = yield* writeThenReplay(yield* base, (commandId) => ({
        type: "thread.dependencies.set",
        commandId,
        threadId: CHILD_A,
        blockedBy: [CHILD_B],
        createdAt: now,
      }));
      expect(deps.first).toEqual(["thread.dependencies-set"]);
      expect(deps.replayed).toEqual([]);
      // A genuine change still writes — the guard is payload-scoped, not blanket.
      expect(
        (yield* decide(deps.applied, {
          type: "thread.dependencies.set",
          commandId: CommandId.make("server:noop:cleared"),
          threadId: CHILD_A,
          blockedBy: [],
          createdAt: now,
        })).map((event) => event.type),
      ).toEqual(["thread.dependencies-set"]);
    }),
  );

  it.effect("thread.fanin.set — the stored fan-in state emits nothing", () =>
    Effect.gen(function* () {
      const fanIn = yield* writeThenReplay(yield* base, (commandId) => ({
        type: "thread.fanin.set",
        commandId,
        threadId: CHILD_A,
        fanInState: "conflicted",
        createdAt: now,
      }));
      expect(fanIn.first).toEqual(["thread.fanin-set"]);
      expect(fanIn.replayed).toEqual([]);
    }),
  );

  it.effect("thread.kickoff-brief.set — the stored brief path emits nothing", () =>
    Effect.gen(function* () {
      const brief = yield* writeThenReplay(yield* base, (commandId) => ({
        type: "thread.kickoff-brief.set",
        commandId,
        threadId: CHILD_A,
        kickoffBriefPath: "/tmp/briefs/child-a.md",
        createdAt: now,
      }));
      expect(brief.first).toEqual(["thread.kickoff-brief-set"]);
      expect(brief.replayed).toEqual([]);
    }),
  );
});
