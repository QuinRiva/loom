/**
 * A frozen child is nudged once then raised `error` (at once if the nudge cannot steer); a printing
 * tool is never a stall; approvals are exempt, questions not; a flat product under a live heartbeat
 * is `spinning`; a provider failure is resumed once. The clock is the TestClock, per-test layers.
 */
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
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
  dispatch,
  LoomOrchestratorTestLayer,
  loomEvent,
  seededRunIds,
  seedRunningRun,
  seedThread,
  spawnChild,
  writeEvents,
} from "../../testkit/loomOrchestratorLayer.ts";
import { errorResumeCommandId, stallNudgeCommandId } from "../dispatcher/controlMessage.ts";
import { WORKSTREAM_CONTROL_PLANE_MARKER } from "../dispatcher/wakes.ts";
import { type AdviseInput, WorkstreamDispatcher } from "../dispatcher/WorkstreamDispatcher.ts";
import { quiescenceCandidate } from "../quiescence.ts";
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
    leaveStash: () => Effect.void,
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

/** Ends the thread's latest run `failed` with a root error item of `failureClass`. */
const failRun = (
  threadId: ThreadId,
  failureClass: OrchestrationV2ProviderFailureClass,
  message = "provider went away",
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(threadId)).runs
      .toSorted((a, b) => b.ordinal - a.ordinal)
      .at(0)!;
    yield* writeEvents([
      yield* event(threadId, {
        type: "turn-item.updated",
        runId: run.id,
        payload: {
          id: TurnItemId.make(`turn-item:${run.id}:error`),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 50,
          status: "failed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: { class: failureClass, message, code: null, retryable: null },
        },
      }),
      yield* event(threadId, {
        type: "run.updated",
        runId: run.id,
        payload: { ...run, status: "failed", completedAt: now },
      }),
    ]);
    return run.id;
  });

/** The sweep's error resumes on `threadId`. */
const errorResumes = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (o) =>
    Effect.map(o.getThreadProjection(threadId), (p) =>
      p.messages.filter((message) => message.id.startsWith("message:server:loom:error-resume:")),
    ),
  );

/** `quiescenceCandidate` as the rail reads it, with no grace at all. */
const quietNow = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return quiescenceCandidate({
      shell: (yield* orchestrator.getThreadShell(threadId))!,
      runs: projection.runs,
      userMessages: projection.messages.filter((message) => message.role === "user"),
      children: [],
      now: yield* DateTime.now,
      grace: { controlStartedMs: 0, humanStartedMs: 0 },
    });
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

it.effect("a nudge the orchestrator rejected is settled: the ladder still escalates (DL-382)", () =>
  withSweep(
    Effect.gen(function* () {
      const { child } = yield* seedRunningChild("rejected", true);
      // The episode's nudge id is already receipted dead (a rejection between the steer
      // predicate and the dispatch): every later sweep reads it as `receipted, not accepted`.
      yield* (yield* CommandReceiptStoreV2).insertIfAbsent({
        commandId: CommandId.make(stallNudgeCommandId(child, 0)),
        threadId: child,
        commandType: "message.dispatch",
        acceptedAt: DateTime.makeUnsafe(0),
        resultSequence: 0,
        status: "rejected",
        error: "steer target changed",
      });
      yield* sweep;
      yield* minutes(11);
      yield* sweep; // the nudge: dead, but settled — its grace starts
      assert.lengthOf(yield* nudges(child), 0);
      assert.deepEqual(yield* attention(child), []);
      yield* minutes(2); // past the nudge grace
      yield* sweep;
      assert.equal((yield* receipt(livenessStallCommandId(child, 0)))?.status, "accepted");
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

it.effect("a running bg_wait's timeout_s is its declared estimate", () =>
  withSweep(
    Effect.gen(function* () {
      const { child } = yield* seedRunningChild("bg-wait", true);
      const ids = seededRunIds(child);
      const now = yield* DateTime.now;
      yield* writeEvents([
        yield* event(child, {
          type: "turn-item.updated",
          payload: {
            id: TurnItemId.make(`turn-item:${child}:bg-wait`),
            threadId: child,
            runId: ids.runId,
            nodeId: ids.nodeId,
            providerThreadId: ids.providerThreadId,
            providerTurnId: ids.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "running",
            title: "bg_wait",
            startedAt: DateTime.makeUnsafe(0),
            completedAt: null,
            updatedAt: now,
            type: "dynamic_tool",
            toolName: "bg_wait",
            input: { id: "j3ab", timeout_s: 1800 },
          },
        }),
      ]);
      yield* minutes(11);
      yield* sweep;
      // 30 min × 1.2: no slow-tool notice at 5 or 11 minutes.
      assert.lengthOf(advised, 0);
      yield* minutes(26);
      yield* sweep;
      assert.lengthOf(advised, 1);
      assert.include(advised[0]?.item.excerpt ?? "", "long-running tool `bg_wait`");
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

const EOF_ERROR = '{"type":"error","error":{"type":"api_error","message":"unexpected EOF"}}';

it.effect(
  "a provider failure is resumed once, naming the error; the resume failing too raises error",
  () =>
    withSweep(
      Effect.gen(function* () {
        const { child } = yield* seedRunningChild("dead", false);
        yield* writeEvents([
          yield* loomEvent("thread.kickoff-recorded", child, {
            kickoffAt: DateTime.formatIso(yield* DateTime.now),
            messageId: seededRunIds(child).messageId,
            origin: "kickoff",
          }),
        ]);
        const failedRunId = yield* failRun(child, "transport_error", EOF_ERROR);
        // Owed a resume: never quiet, whatever the grace, so the parent is not woken.
        assert.isFalse(yield* quietNow(child));
        yield* sweep;
        const [resume, ...rest] = yield* errorResumes(child);
        assert.lengthOf(rest, 0);
        assert.equal(resume?.id, `message:${errorResumeCommandId(child, failedRunId)}`);
        assert.equal(resume?.loom?.origin, "control_notice");
        assert.include(resume?.text ?? "", WORKSTREAM_CONTROL_PLANE_MARKER);
        assert.include(resume?.text ?? "", `\`${EOF_ERROR}\``);
        assert.include(resume?.text ?? "", "Check what already landed before repeating a step.");
        assert.isFalse(yield* quietNow(child));
        for (let i = 0; i < 3; i++) yield* sweep;
        assert.lengthOf(yield* errorResumes(child), 1);
        assert.deepEqual(yield* attention(child), []);

        // The resumed run fails too: State A's ladder, exactly as before, and no second resume.
        const resumedRunId = yield* failRun(child, "provider_error", EOF_ERROR);
        assert.notEqual(resumedRunId, failedRunId);
        yield* sweep;
        yield* sweep;
        assert.deepEqual(yield* attention(child), []);
        yield* sweep;
        assert.equal(
          (yield* receipt(livenessDeadCommandId(child, resumedRunId)))?.status,
          "accepted",
        );
        assert.deepEqual(yield* attention(child), ["error"]);
        assert.lengthOf(yield* errorResumes(child), 1);
        assert.isNull(yield* receipt(errorResumeCommandId(child, resumedRunId)));
      }),
    ),
);

it.effect("usage_limit, an interrupted run and a flagged child are never resumed", () =>
  withSweep(
    Effect.gen(function* () {
      const { child: limited } = yield* seedRunningChild("limited", false);
      const { child: stopped } = yield* seedRunningChild("stopped", false);
      const { child: held } = yield* seedRunningChild("held", false);
      yield* failRun(limited, "usage_limit");
      // A human's or the parent's stop: pi ends the turn `interrupted` with no failure.
      const run = (yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(stopped))
        .runs[0]!;
      yield* writeEvents([
        yield* event(stopped, {
          type: "run.updated",
          payload: { ...run, status: "interrupted", completedAt: yield* DateTime.now },
        }),
      ]);
      yield* dispatch({
        type: "thread.attention.raise",
        commandId: CommandId.make("held-guidance"),
        threadId: held,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        reason: "needs_guidance",
      });
      yield* failRun(held, "provider_error");
      for (let i = 0; i < 4; i++) yield* sweep;
      for (const child of [limited, stopped, held]) assert.lengthOf(yield* errorResumes(child), 0);
      assert.deepEqual(yield* attention(limited), []);
      assert.deepEqual(yield* attention(stopped), []);
      assert.isNull(yield* receipt(livenessDeadCommandId(limited, seededRunIds(limited).runId)));
      // The flagged child can still die (State A raises error alongside its flag).
      assert.deepEqual(yield* attention(held), ["needs_guidance", "error"]);
    }),
  ),
);

it.effect(
  "a root gets the same one error resume, then error on itself; its child is judged as before",
  () =>
    withSweep(
      Effect.gen(function* () {
        const { root, child } = yield* seedRunningChild("root-fail", false);
        yield* seedRunningRun({ threadId: root });
        const failedRunId = yield* failRun(root, "transport_error", EOF_ERROR);
        yield* sweep;
        const [resume, ...rest] = yield* errorResumes(root);
        assert.lengthOf(rest, 0);
        assert.equal(resume?.id, `message:${errorResumeCommandId(root, failedRunId)}`);
        assert.include(resume?.text ?? "", `\`${EOF_ERROR}\``);
        for (let i = 0; i < 3; i++) yield* sweep;
        assert.lengthOf(yield* errorResumes(root), 1);
        assert.deepEqual(yield* attention(root), []);

        const resumedRunId = yield* failRun(root, "provider_error", EOF_ERROR);
        yield* sweep;
        yield* sweep;
        assert.deepEqual(yield* attention(root), []);
        yield* sweep;
        assert.equal(
          (yield* receipt(livenessDeadCommandId(root, resumedRunId)))?.status,
          "accepted",
        );
        assert.deepEqual(yield* attention(root), ["error"]);
        assert.lengthOf(yield* errorResumes(root), 1);
        // A root gets no stall or progress advisories; the child's ladder is untouched.
        assert.lengthOf(advised, 0);
        assert.lengthOf(yield* errorResumes(child), 0);
        assert.deepEqual(yield* attention(child), []);
      }),
    ),
);

it.effect("a failed root the human has written to since is not resumed", () =>
  withSweep(
    Effect.gen(function* () {
      const { root } = yield* seedRunningChild("root-human", false);
      yield* seedRunningRun({ threadId: root });
      yield* failRun(root, "provider_error", EOF_ERROR);
      yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("root-human-reply"),
        threadId: root,
        messageId: MessageId.make("message:root-human-reply"),
        text: "Carry on.",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "queue_after_active" },
      });
      for (let i = 0; i < 4; i++) yield* sweep;
      assert.lengthOf(yield* errorResumes(root), 0);
    }),
  ),
);
