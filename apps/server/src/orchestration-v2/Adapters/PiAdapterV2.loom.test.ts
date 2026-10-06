// loom: the driver work item's adapter hunks (driver plan §2–§4): the Loom open-session field
// reaches pi's argv, every resume carries cwdOverride, and the terminal tokenUsage carries the
// turn's pi-priced costUsd. Phase 3c appends its cases here.
//
// A minimal in-process `pi --mode rpc` (the same technique as PiAdapterV2.test.ts's fake, which
// is not exported): every request is recorded and auto-acknowledged, and the test pushes events.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../../config.ts";
import {
  EMPTY_LOOM_OPEN_SESSION_FIELDS,
  type LoomOpenSessionFields,
} from "../../loom/prompt/sessionComposer.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { makePiAdapterV2 } from "./PiAdapterV2.ts";
import type { PiRpcRecord } from "./PiRpc.ts";
import { buildPiRpcLaunch } from "./piT3McpInjection.ts";

const testLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-v2-loom-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

const PI_INSTANCE_ID = ProviderInstanceId.make("pi");
const THREAD_ID = ThreadId.make("thread-pi-loom");
const SESSION_FILE = "/fake/.pi/agent/sessions/--workspace--/0001_loom.jsonl";
const THREAD_CWD = "/workspace/loom-thread";
const modelSelection = { instanceId: PI_INSTANCE_ID, model: "default" };
const runtimePolicy = ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: THREAD_CWD,
});
const LOOM: LoomOpenSessionFields = {
  appendSystemPrompt: "You are a coder sub-thread.",
  skills: ["/skills/a/SKILL.md", "/skills/b/SKILL.md"],
  extensions: ["/ext/loom.ts"],
};

const RPC_DATA: Record<string, unknown> = {
  get_state: {
    sessionFile: SESSION_FILE,
    sessionId: "00000000-0000-4000-8000-000000000003",
    thinkingLevel: "high",
    isStreaming: false,
    isCompacting: false,
    pendingMessageCount: 0,
    messageCount: 0,
    model: { provider: "anthropic", id: "opus", contextWindow: 200_000 },
  },
  get_available_models: { models: [] },
  get_commands: { commands: [] },
  switch_session: { cancelled: false },
  new_session: { cancelled: false },
  get_entries: { entries: [], leafId: null },
  get_messages: { messages: [] },
  // Session-cumulative, as pi reports it; the cost here must NOT reach costUsd.
  get_session_stats: {
    contextUsage: { tokens: 1_200, contextWindow: 200_000 },
    tokens: { input: 1_000, output: 200, cacheRead: 0 },
    cost: 9.99,
  },
};

const makeFakePi = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const requests: Array<PiRpcRecord> = [];
  const spawns: Array<ReadonlyArray<string>> = [];
  const emit = (record: PiRpcRecord) =>
    Queue.offer(stdout, new TextEncoder().encode(`${JSON.stringify(record)}\n`));
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.sync(() => {
      if (ChildProcess.isStandardCommand(command)) spawns.push(command.args);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_998),
        exitCode: Effect.never,
        isRunning: Effect.succeed(true),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((chunk: Uint8Array) =>
          Effect.forEach(
            new TextDecoder().decode(chunk).split("\n").filter(Boolean),
            (line) => {
              const record = JSON.parse(line) as PiRpcRecord;
              requests.push(record);
              return emit({
                type: "response",
                id: record["id"],
                command: String(record["type"]),
                success: true,
                data: RPC_DATA[String(record["type"])],
              });
            },
            { discard: true },
          ),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, emit, requests, spawns };
});

const openRuntime = Effect.fnUntraced(function* (loom?: LoomOpenSessionFields) {
  const fake = yield* makeFakePi;
  const adapter = makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "--approve", customModels: [] },
    environment: {},
    spawner: fake.spawner,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
  });
  const runtime = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("provider-session-pi-loom"),
    modelSelection,
    runtimePolicy,
    ...(loom === undefined ? {} : { loom }),
  });
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(events, event)),
    Effect.forkScoped,
  );
  return { fake, runtime, events };
});

const appThread = Effect.gen(function* () {
  const now = yield* DateTime.now;
  return {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:fixture:pi" as OrchestrationV2AppThread["projectId"],
    title: "Pi loom thread",
    providerInstanceId: PI_INSTANCE_ID,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  } satisfies OrchestrationV2AppThread;
});

describe("PiAdapterV2 (loom)", () => {
  it("places the Loom argv after the user's launch args and before the bridge extension", () => {
    const launch = (loom?: LoomOpenSessionFields) =>
      buildPiRpcLaunch({
        launchArgs: ["--approve"],
        environment: {},
        mcpSession: undefined,
        extensionPath: "/cache/t3-bridge.ts",
        ...(loom === undefined ? {} : { loom }),
      }).args;
    assert.deepEqual(launch(LOOM), [
      "--mode",
      "rpc",
      "--approve",
      "--append-system-prompt",
      "You are a coder sub-thread.",
      "--skill",
      "/skills/a/SKILL.md",
      "--skill",
      "/skills/b/SKILL.md",
      "--extension",
      "/ext/loom.ts",
      "--extension",
      "/cache/t3-bridge.ts",
    ]);
    // The empty default composer adds no argv: upstream's launch is unchanged.
    assert.deepEqual(launch(EMPTY_LOOM_OPEN_SESSION_FIELDS), launch());
  });

  it("merges the composer env over the inherited env without shadowing T3's own variables", () => {
    const { env } = buildPiRpcLaunch({
      launchArgs: [],
      environment: { PI_CACHE_RETENTION: "long", PATH: "/bin" },
      mcpSession: {
        environmentId: EnvironmentId.make("environment-loom-env"),
        threadId: ThreadId.make("thread-loom-env"),
        providerSessionId: "mcp-session-loom-env",
        providerInstanceId: ProviderInstanceId.make("pi"),
        endpoint: "http://127.0.0.1:1/mcp",
        authorizationHeader: "Bearer real",
        browserToolsAvailable: false,
      },
      extensionPath: "/cache/t3-bridge.ts",
      loom: { ...LOOM, env: { PI_CACHE_RETENTION: "short", T3_MCP_BEARER_TOKEN: "spoofed" } },
    });
    assert.equal(env.PI_CACHE_RETENTION, "short");
    assert.equal(env.PATH, "/bin");
    assert.equal(env.T3_MCP_BEARER_TOKEN, "real");
  });

  it.effect("openSession spawns pi with the composed fields", () =>
    Effect.gen(function* () {
      const { fake } = yield* openRuntime(LOOM);
      const args = fake.spawns[0]!;
      assert.include(args.join(" "), "--append-system-prompt You are a coder sub-thread.");
      assert.deepEqual(
        args.filter((_, index) => args[index - 1] === "--skill"),
        LOOM.skills,
      );
      assert.equal(args[args.indexOf("/ext/loom.ts") - 1], "--extension");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("resumes with cwdOverride set to the session's cwd", () =>
    Effect.gen(function* () {
      const { fake, runtime } = yield* openRuntime();
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime.resumeThread({ providerThread });
      const switches = fake.requests.filter((request) => request["type"] === "switch_session");
      assert.lengthOf(switches, 1);
      assert.equal(switches[0]!["sessionPath"], SESSION_FILE);
      assert.equal(switches[0]!["cwdOverride"], THREAD_CWD);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("puts the turn's summed message cost on the terminal tokenUsage only", () =>
    Effect.gen(function* () {
      const { fake, runtime, events } = yield* openRuntime();
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      const runId = RunId.make(`run:${THREAD_ID}:1`);
      yield* runtime.startTurn({
        appThread: yield* appThread,
        threadId: THREAD_ID,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
        rootNodeId: NodeId.make(`node:${runId}:root`),
        providerThread,
        message: {
          messageId: `message:${THREAD_ID}:1` as never,
          text: "Hello pi",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      yield* fake.emit({ type: "agent_start" });
      for (const cost of [0.0125, 0.0075]) {
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        yield* fake.emit({ type: "message_update", usage: { totalTokens: 600, input: 500 } });
        yield* fake.emit({
          type: "message_end",
          message: { role: "assistant", content: [], usage: { cost: { total: cost } } },
        });
      }
      yield* fake.emit({ type: "agent_settled" });

      const turnUpdates: Array<ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(events);
        if (event.type === "turn.terminal") break;
        if (event.type === "provider_turn.updated") turnUpdates.push(event);
      }
      const usages = turnUpdates.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined
          ? [{ status: event.providerTurn.status, usage: event.providerTurn.tokenUsage }]
          : [],
      );
      const live = usages.filter((entry) => entry.status === "running");
      const terminal = usages.filter((entry) => entry.status === "completed");
      assert.isAbove(live.length, 0);
      assert.isTrue(live.every((entry) => entry.usage.costUsd === undefined));
      assert.lengthOf(terminal, 1);
      assert.closeTo(terminal[0]!.usage.costUsd!, 0.02, 1e-12);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
