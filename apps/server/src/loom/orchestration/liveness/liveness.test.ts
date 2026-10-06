/**
 * The liveness sweep on the real orchestrator (smoke steps 18, 19): a frozen
 * running child is nudged once then raised `error`, or raised at once when the
 * nudge could not steer; a child inside a printing tool is never a stall and
 * gets one slow-tool advisory; approval waits are exempt and questions are not;
 * a flat work product under an advancing heartbeat is a `spinning` advisory;
 * a sustained failed run is dead and `usage_limit` is not. The sweep's clock
 * is the TestClock; each test builds its own layer so it starts at 0.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailureClass,
  type OrchestrationV2RuntimeRequest,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { CommandReceiptStoreV2 } from "../../../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import { LoomStoreV2 } from "../../projection/LoomStore.ts";
import {
  LoomOrchestratorTestLayer,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../../testkit/loomOrchestratorLayer.ts";
import { stallNudgeCommandId } from "../dispatcher/controlMessage.ts";
import { type AdviseInput, WorkstreamDispatcher } from "../dispatcher/WorkstreamDispatcher.ts";
import { LoomHeartbeat } from "./heartbeat.ts";
import {
  classifyLiveness,
  DEFAULT_LIVENESS_THRESHOLDS,
  decideStallAction,
  livenessDeadCommandId,
  livenessStallCommandId,
  makeWorkstreamLivenessSweepLive,
  WorkstreamLivenessSweep,
} from "./WorkstreamLivenessSweep.ts";

const MIN = 60_000;

/** The dispatcher's `advise` hook, spied (3b-2's tests prove advise → digest). */
const advised: Array<AdviseInput> = [];
const SpyDispatcherLayer = Layer.sync(WorkstreamDispatcher, () => {
  advised.length = 0;
  return {
    start: Effect.void,
    drain: Effect.void,
    runPass: Effect.void,
    advise: (input) => Effect.sync(() => void advised.push(input)),
    deferredWakes: Effect.succeed(new Map()),
  };
});

const withSweep = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      makeWorkstreamLivenessSweepLive().pipe(
        Layer.provide(SpyDispatcherLayer),
        Layer.provideMerge(LoomOrchestratorTestLayer),
      ),
    ),
  );

const sweep = Effect.flatMap(WorkstreamLivenessSweep, (s) => s.sweep);
const minutes = (n: number) => TestClock.adjust(n * MIN);
const receipt = (id: string) =>
  Effect.flatMap(CommandReceiptStoreV2, (receipts) =>
    Effect.map(receipts.getByCommandId(CommandId.make(id)), Option.getOrNull),
  );
const attention = (threadId: ThreadId) =>
  Effect.flatMap(LoomStoreV2, (store) =>
    Effect.map(store.getWorkstream(threadId), (row) => row!.attention),
  );
const nudges = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
    Effect.map(o.getThreadProjection(threadId), (p) =>
      p.messages.filter((message) => message.loom?.controlPayload?.notice === "stall-nudge"),
    ),
  );

/** A root and one running child (`live` binds an inert session, so upstream's steer conversion takes a nudge). */
const seedRunningChild = (name: string, live: boolean) =>
  Effect.gen(function* () {
    const root = ThreadId.make(`${name}-root`);
    const child = ThreadId.make(`${name}-child`);
    yield* seedThread({ threadId: root });
    yield* spawnChild({ parentThreadId: root, threadId: child });
    yield* seedRunningRun({ threadId: child, live });
    return { root, child };
  });

let eventCounter = 0;
const event = (threadId: ThreadId, body: Record<string, unknown>) =>
  Effect.map(
    DateTime.now,
    (now) =>
      ({
        id: EventId.make(`event:liveness-test:${++eventCounter}`),
        threadId,
        runId: seededRunIds(threadId).runId,
        occurredAt: now,
        ...body,
      }) as unknown as OrchestrationV2DomainEvent,
  );

/** A Pi `bash` call on the seeded run's active attempt. */
const bashItem = (
  threadId: ThreadId,
  input: {
    readonly key: string;
    readonly status: "running" | "completed";
    readonly command: string;
    readonly ordinal: number;
    readonly output?: string;
  },
) =>
  Effect.flatMap(DateTime.now, (now) => {
    const ids = seededRunIds(threadId);
    return event(threadId, {
      type: "turn-item.updated",
      payload: {
        id: TurnItemId.make(`turn-item:${threadId}:${input.key}`),
        threadId,
        runId: ids.runId,
        nodeId: ids.nodeId,
        providerThreadId: ids.providerThreadId,
        providerTurnId: ids.providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: input.ordinal,
        status: input.status,
        title: "bash",
        startedAt: DateTime.makeUnsafe(0),
        completedAt: input.status === "completed" ? now : null,
        updatedAt: now,
        type: "command_execution",
        input: input.command,
        ...(input.output === undefined ? {} : { output: input.output }),
      },
    });
  });

const pendingRequest = (threadId: ThreadId, kind: OrchestrationV2RuntimeRequest["kind"]) =>
  Effect.flatMap(DateTime.now, (now) =>
    event(threadId, {
      type: "runtime-request.updated",
      payload: {
        id: RuntimeRequestId.make(`request:${threadId}`),
        nodeId: seededRunIds(threadId).nodeId,
        providerTurnId: seededRunIds(threadId).providerTurnId,
        nativeRequestRef: null,
        kind,
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      } satisfies OrchestrationV2RuntimeRequest,
    }),
  );

/** Ends the seeded run `failed` with a root error item of `failureClass`. */
const failRun = (threadId: ThreadId, failureClass: OrchestrationV2ProviderFailureClass) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const ids = seededRunIds(threadId);
    const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId))
      .runs[0]!;
    yield* writeEvents([
      yield* event(threadId, {
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make(`turn-item:${threadId}:error`),
          threadId,
          runId: ids.runId,
          nodeId: ids.nodeId,
          providerThreadId: ids.providerThreadId,
          providerTurnId: ids.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 50,
          status: "failed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: {
            class: failureClass,
            message: "provider went away",
            code: null,
            retryable: null,
          },
        },
      }),
      yield* event(threadId, {
        type: "run.updated",
        payload: { ...run, status: "failed", completedAt: now },
      }),
    ]);
  });

it("decideStallAction escalates a fresh episode the nudge cannot steer into", () => {
  const base = { priorEpisodeMs: null, episodeMs: 5, msSinceNudge: null, nudgeGraceMs: 2 * MIN };
  assert.equal(decideStallAction({ ...base, hasOpenTurn: true }), "nudge");
  assert.equal(decideStallAction({ ...base, hasOpenTurn: false }), "escalate");
  const nudged = { ...base, priorEpisodeMs: 5, hasOpenTurn: true };
  assert.equal(decideStallAction({ ...nudged, msSinceNudge: MIN }), "wait");
  assert.equal(decideStallAction({ ...nudged, msSinceNudge: 2 * MIN }), "escalate");
});

it("classifyLiveness exempts every approval kind but not a question", () => {
  const input = (kind: OrchestrationV2RuntimeRequest["kind"] | null) =>
    classifyLiveness({
      shell: {
        activityRunStatus: "running",
        activityRunStartedAt: DateTime.makeUnsafe(0),
        pendingRuntimeRequest:
          kind === null
            ? null
            : { id: RuntimeRequestId.make("r"), kind, createdAt: DateTime.makeUnsafe(0) },
      },
      heartbeatMs: 0,
      hasInFlightTool: false,
      failureCount: 0,
      sweepStartedAtMs: 0,
      now: 11 * MIN,
      thresholds: DEFAULT_LIVENESS_THRESHOLDS,
    })?.kind ?? null;
  for (const kind of [
    "command",
    "file-read",
    "file-change",
    "mcp-elicitation",
    "permission",
    "dynamic_tool_call",
    "auth_refresh",
  ] as const)
    assert.isNull(input(kind), kind);
  assert.equal(input("user_input"), "stalled");
  assert.equal(input(null), "stalled");
});

it.effect("a frozen steerable child is nudged once, then raised error once (step 18)", () =>
  withSweep(
    Effect.gen(function* () {
      const { child } = yield* seedRunningChild("frozen", true);
      yield* sweep;
      yield* minutes(9);
      yield* sweep; // within the stale window
      assert.lengthOf(yield* nudges(child), 0);

      yield* minutes(2); // 11 min frozen
      yield* sweep;
      const [nudge, ...rest] = yield* nudges(child);
      assert.lengthOf(rest, 0);
      assert.equal(nudge?.id, `message:${stallNudgeCommandId(child, 0)}`);
      assert.equal(nudge?.loom?.origin, "control_notice");
      assert.include(nudge?.text ?? "", "appears to have stalled");
      assert.include(nudge?.text ?? "", "mcp__t3-code__workstream_request_attention");
      // Steered into the frozen run, not queued behind it.
      const runs = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(child)).runs;
      assert.deepEqual(
        runs.map((run) => run.status),
        ["running"],
      );

      yield* minutes(1);
      yield* sweep; // within the nudge grace
      assert.lengthOf(yield* nudges(child), 1);
      assert.deepEqual(yield* attention(child), []);

      yield* minutes(1); // still frozen past the grace
      yield* sweep;
      assert.equal((yield* receipt(livenessStallCommandId(child, 0)))?.status, "accepted");
      assert.deepEqual(yield* attention(child), ["error"]);
      yield* minutes(5);
      yield* sweep;
      yield* sweep;
      assert.lengthOf(yield* nudges(child), 1);
      assert.deepEqual(yield* attention(child), ["error"]);
    }),
  ),
);

it.effect("a frozen child the nudge cannot steer into is raised error with no message", () =>
  withSweep(
    Effect.gen(function* () {
      const { child } = yield* seedRunningChild("unsteerable", false);
      yield* minutes(11);
      yield* sweep;
      assert.lengthOf(yield* nudges(child), 0);
      assert.equal((yield* receipt(livenessStallCommandId(child, 0)))?.status, "accepted");
      assert.isNull(yield* receipt(stallNudgeCommandId(child, 0)));
      assert.deepEqual(yield* attention(child), ["error"]);
    }),
  ),
);

it.effect(
  "a child inside a printing tool is never a stall; past 5 min one slow-tool advisory (step 19)",
  () =>
    withSweep(
      Effect.gen(function* () {
        const { root, child } = yield* seedRunningChild("printing", true);
        const heartbeat = yield* LoomHeartbeat;
        for (let minute = 1; minute <= 12; minute++) {
          yield* minutes(1);
          yield* writeEvents([
            yield* bashItem(child, {
              key: "sleep",
              status: "running",
              command: "while true; do sleep 60; echo tick; done",
              ordinal: 1,
              output: "tick\n".repeat(minute),
            }),
          ]);
          yield* heartbeat.awaitBeat(child, minute * MIN);
          yield* sweep;
          assert.lengthOf(advised, minute < 5 ? 0 : 1, `minute ${minute}`);
        }
        assert.lengthOf(yield* nudges(child), 0);
        assert.deepEqual(yield* attention(child), []);
        const [advice] = advised;
        assert.equal(advice?.parentId, root);
        assert.equal(advice?.item.kind, "slow-tool");
        assert.equal(advice?.item.threadId, child);
        assert.include(advice?.item.excerpt ?? "", "long-running tool `bash` in flight ~5 min");
        assert.include(advice?.item.excerpt ?? "", "no agent-visible output ~0 min");
      }),
    ),
);

it.effect("a silent in-flight tool suppresses the stall (no heartbeat for 11 min)", () =>
  withSweep(
    Effect.gen(function* () {
      const { child } = yield* seedRunningChild("silent", true);
      yield* writeEvents([
        yield* bashItem(child, {
          key: "build",
          status: "running",
          command: "make all # eta: 20m",
          ordinal: 1,
        }),
      ]);
      yield* minutes(11);
      yield* sweep;
      assert.lengthOf(yield* nudges(child), 0);
      assert.deepEqual(yield* attention(child), []);
      // The declared estimate defers the slow-tool advisory to 20 min × 1.2.
      assert.lengthOf(advised, 0);
      yield* minutes(14);
      yield* sweep;
      assert.lengthOf(advised, 1);
      assert.include(advised[0]?.item.excerpt ?? "", "child estimated ~20 min, now overrun");
    }),
  ),
);

it.effect("the heartbeat tracks Loom threads only and ignores incoming user messages", () =>
  withSweep(
    Effect.gen(function* () {
      const { child } = yield* seedRunningChild("beat", false);
      const { child: other } = yield* seedRunningChild("beat-other", false);
      const upstream = ThreadId.make("beat-upstream");
      yield* seedThread({ threadId: upstream });
      const heartbeat = yield* LoomHeartbeat;
      yield* minutes(1);
      yield* writeEvents([
        yield* bashItem(child, { key: "a", status: "completed", command: "ls", ordinal: 1 }),
      ]);
      yield* minutes(1);
      yield* writeEvents([
        yield* event(child, {
          type: "turn-item.updated",
          payload: {
            id: TurnItemId.make("turn-item:beat-user"),
            threadId: child,
            runId: seededRunIds(child).runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "completed",
            title: null,
            startedAt: null,
            completedAt: null,
            updatedAt: yield* DateTime.now,
            type: "user_message",
            messageId: "message:beat-user",
            inputIntent: "steer",
            text: "a nudge",
            attachments: [],
            createdBy: "agent",
            creationSource: "server",
          },
        }),
        yield* bashItem(upstream, { key: "u", status: "completed", command: "ls", ordinal: 1 }),
        yield* bashItem(other, { key: "o", status: "completed", command: "ls", ordinal: 1 }),
      ]);
      yield* heartbeat.awaitBeat(other, 2 * MIN); // events are consumed in order
      assert.equal(heartbeat.lastHeartbeatMs(child), MIN);
      assert.equal(heartbeat.lastHeartbeatMs(upstream), 0);
    }),
  ),
);

it.effect("an approval wait is exempt; a pending question is not", () =>
  withSweep(
    Effect.gen(function* () {
      const { child: approving } = yield* seedRunningChild("approval", true);
      const { child: asking } = yield* seedRunningChild("question", true);
      yield* writeEvents([
        yield* pendingRequest(approving, "command"),
        yield* pendingRequest(asking, "user_input"),
      ]);
      yield* minutes(11);
      yield* sweep;
      assert.lengthOf(yield* nudges(approving), 0);
      assert.lengthOf(yield* nudges(asking), 1);
    }),
  ),
);

it.effect("a flat work product under an advancing heartbeat is one spinning advisory", () =>
  withSweep(
    Effect.gen(function* () {
      const { root, child } = yield* seedRunningChild("spin", true);
      const heartbeat = yield* LoomHeartbeat;
      yield* writeEvents([
        yield* bashItem(child, {
          key: "same",
          status: "completed",
          command: "cat notes.md",
          ordinal: 1,
        }),
      ]);
      // The same completed call re-reported each minute: activity without new work.
      for (let minute = 1; minute <= 14; minute++) {
        yield* minutes(1);
        yield* writeEvents([
          yield* bashItem(child, {
            key: "same",
            status: "completed",
            command: "cat notes.md",
            ordinal: 1,
          }),
        ]);
        yield* heartbeat.awaitBeat(child, minute * MIN);
        yield* sweep;
      }
      // First busy sweep at 2 min starts the flat clock; it advises at 12 min, once.
      assert.lengthOf(advised, 1);
      const [advice] = advised;
      assert.equal(advice?.parentId, root);
      assert.equal(advice?.item.kind, "spinning");
      assert.equal(advice?.episodeKey, `spinning:${child}:${2 * MIN}`);
      assert.include(advice?.item.excerpt ?? "", "possibly spinning");
      assert.lengthOf(yield* nudges(child), 0);
      assert.deepEqual(yield* attention(child), []);
    }),
  ),
);

it.effect("three sweeps of a failed latest run raise error; usage_limit raises nothing", () =>
  withSweep(
    Effect.gen(function* () {
      const { child: dead } = yield* seedRunningChild("dead", false);
      const { child: limited } = yield* seedRunningChild("limited", false);
      yield* failRun(dead, "transport_error");
      yield* failRun(limited, "usage_limit");
      const runId = seededRunIds(dead).runId;
      yield* sweep;
      yield* sweep;
      assert.deepEqual(yield* attention(dead), []);
      yield* sweep;
      assert.equal((yield* receipt(livenessDeadCommandId(dead, runId)))?.status, "accepted");
      assert.deepEqual(yield* attention(dead), ["error"]);
      for (let i = 0; i < 4; i++) yield* sweep;
      assert.deepEqual(yield* attention(limited), []);
      assert.isNull(yield* receipt(livenessDeadCommandId(limited, seededRunIds(limited).runId)));
    }),
  ),
);
