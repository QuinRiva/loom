// @effect-diagnostics nodeBuiltinImport:off
// loom: the driver work item's adapter hunks (driver plan §2–§4): the Loom open-session field
// reaches pi's argv, every resume carries cwdOverride, and the terminal tokenUsage carries the
// turn's pi-priced costUsd (live frames its spend so far). Phase 3c: a pi quota error ends the turn as usage_limit with a reset
// time that satisfies upstream's limit-recovery arm (3c-1).
//
// A minimal in-process `pi --mode rpc` (the same technique as PiAdapterV2.test.ts's fake, which
// is not exported): every request is recorded and auto-acknowledged, and the test pushes events.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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

import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { threadErrorSummary } from "@t3tools/shared/orchestrationV2ThreadError";

import * as ServerConfig from "../../config.ts";
import { LoomProviderHealthLive } from "../../loom/serverLayers.ts";
import * as PendingSteering from "../../loom/steering/pendingSteering.ts";
import {
  LoomPiAdapterHooks,
  type LoomPiAdapterHooksShape,
} from "../../provider/Drivers/Pi/loomAdapterHooks.loom.ts";
import { PI_QUOTA_ERROR_TEXTS } from "../../provider/Drivers/Pi/piQuotaClassifier.fixtures.loom.ts";
import { ProviderHealthRegistry } from "../../provider/ProviderHealthRegistry.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { limitRecoveryCommand } from "../UsageLimitRecoveryWorker.ts";
import {
  EMPTY_LOOM_OPEN_SESSION_FIELDS,
  type LoomOpenSessionFields,
} from "../../loom/prompt/sessionComposer.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { ProviderAdapterV2RuntimePolicy, type ProviderAdapterV2Event } from "../ProviderAdapter.ts";
import { makePiAdapterV2 } from "./PiAdapterV2.ts";
import { makePiRpcConnection, type PiRpcRecord } from "./PiRpc.ts";
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
  // The session file's bytes at the moment each switch_session frame reached pi.
  const switchedFiles: Array<string | null> = [];
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
              if (record["type"] === "switch_session") {
                const path = String(record["sessionPath"]);
                switchedFiles.push(
                  NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : null,
                );
              }
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
  return { spawner, emit, requests, spawns, switchedFiles };
});

const openRuntime = Effect.fnUntraced(function* (
  loom?: LoomOpenSessionFields,
  hooks?: LoomPiAdapterHooksShape,
) {
  const fake = yield* makeFakePi;
  const adapter = makePiAdapterV2({
    instanceId: PI_INSTANCE_ID,
    settings: { enabled: true, binaryPath: "pi", launchArgs: "--approve", customModels: [] },
    environment: {},
    spawner: fake.spawner,
    fileSystem: yield* FileSystem.FileSystem,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    serverConfig: yield* ServerConfig.ServerConfig,
    ...(hooks === undefined ? {} : { loom: hooks }),
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
      for (const [index, cost] of [0.0125, 0.0075].entries()) {
        yield* fake.emit({ type: "message_start", message: { role: "assistant" } });
        // The streaming message's cost so far: half of what it ends at.
        yield* fake.emit({
          type: "message_update",
          usage: { totalTokens: 600 + index, input: 500, cost: { total: cost / 2 } },
        });
        yield* fake.emit({
          type: "message_end",
          message: {
            role: "assistant",
            content: [],
            usage: {
              input: 100,
              output: 20,
              cacheRead: 300,
              cacheWrite: 40,
              cost: { total: cost },
            },
          },
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
      // Live frames carry the turn's spend so far: finished messages plus the streaming one.
      assert.lengthOf(live, 2);
      assert.closeTo(live[0]!.usage.costUsd!, 0.00625, 1e-12);
      assert.closeTo(live[1]!.usage.costUsd!, 0.0125 + 0.00375, 1e-12);
      assert.lengthOf(terminal, 1);
      assert.closeTo(terminal[0]!.usage.costUsd!, 0.02, 1e-12);
      // 3c-3: the turn's own tokens (two messages) in upstream's per-turn slot, not the
      // session-wide stats; live frames carry none.
      const turnUsage = turnUpdates.flatMap((event) =>
        event.type === "provider_turn.updated" && event.providerTurn.turnTokenUsage !== undefined
          ? [{ status: event.providerTurn.status, usage: event.providerTurn.turnTokenUsage }]
          : [],
      );
      assert.deepEqual(turnUsage, [
        {
          status: "completed",
          usage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            inputTokens: 880,
            cachedInputTokens: 600,
            cacheCreationTokens: 80,
            outputTokens: 40,
            hasSubagents: false,
          },
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

// ── 3c-1: pi quota errors as upstream's usage_limit ─────────────────────────

const COOLING_DOWN_WITH_RETRY_AFTER = PI_QUOTA_ERROR_TEXTS.find(
  (entry) => entry.retryAfterMs === 3_639_000 && entry.text.includes("cooling down"),
)!;
const ANTHROPIC_SELECTION = { instanceId: PI_INSTANCE_ID, model: "anthropic/claude-opus-5" };
const WEEKLY_RESET = "2099-01-01T00:00:00.000Z";

/** Loom's live hooks over a real health registry, optionally holding a spent weekly window. */
const liveHooks = (spentWeekly: boolean) =>
  Effect.gen(function* () {
    if (spentWeekly)
      yield* (yield* ProviderHealthRegistry).applyUsage({
        providerName: "claudeAgent",
        providerInstanceId: null,
        windows: [
          { kind: "secondary", usedPercent: 100, resetsAt: WEEKLY_RESET, windowDurationMins: null },
        ],
        observedAt: "2026-10-06T00:00:00.000Z",
      });
    return yield* LoomPiAdapterHooks;
  }).pipe(Effect.provide(LoomProviderHealthLive.pipe(Layer.provide(serverSettingsLayerTest()))));

/** Run one turn that pi fails with `events`, and return what the orchestrator would read. */
const runFailedTurn = Effect.fnUntraced(function* (
  hooks: LoomPiAdapterHooksShape | undefined,
  selection: typeof modelSelection,
  events: ReadonlyArray<PiRpcRecord>,
) {
  const { fake, runtime, events: adapterEvents } = yield* openRuntime(undefined, hooks);
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection: selection,
    runtimePolicy,
  });
  const runId = RunId.make(`run:${THREAD_ID}:quota`);
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
      messageId: `message:${THREAD_ID}:quota` as never,
      text: "Hello pi",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: selection,
    runtimePolicy,
  });
  yield* fake.emit({ type: "agent_start" });
  for (const event of events) yield* fake.emit(event);
  yield* fake.emit({ type: "agent_settled" });
  let providerTurn: Extract<ProviderAdapterV2Event, { type: "provider_turn.updated" }> | undefined;
  let sessionError: string | null = null;
  while (true) {
    const event = yield* Queue.take(adapterEvents);
    if (event.type === "provider_turn.updated") providerTurn = event;
    if (event.type === "provider_session.updated") sessionError = event.providerSession.lastError;
    if (event.type === "turn.terminal")
      return { terminal: event, providerTurn: providerTurn!, sessionError, runId };
  }
});

const modelError = (errorMessage: string): PiRpcRecord => ({
  type: "message_end",
  message: { role: "assistant", content: [], stopReason: "error", errorMessage },
});

describe("PiAdapterV2 (loom) — quota errors", () => {
  it.effect("a weekly-limit error with no reset in its text arms upstream's limit recovery", () =>
    Effect.gen(function* () {
      const hooks = yield* liveHooks(true);
      const { terminal, providerTurn, sessionError, runId } = yield* runFailedTurn(
        hooks,
        ANTHROPIC_SELECTION,
        [modelError("weekly limit reached")],
      );
      assert.equal(providerTurn.providerTurn.status, "failed");
      assert.equal(terminal.failure?.class, "usage_limit");
      assert.equal(terminal.failure?.resetAt, WEEKLY_RESET);
      assert.equal(terminal.failure?.message, "weekly limit reached"); // upstream's message kept

      // The shell fields upstream derives from this failure, fed to upstream's own arm predicate.
      const summary = threadErrorSummary(terminal.failure, sessionError);
      const completedAt = providerTurn.providerTurn.completedAt!;
      const command = limitRecoveryCommand(
        {
          id: THREAD_ID,
          status: "failed",
          lastErrorClass: summary.lastErrorClass,
          latestRunId: runId,
          usageLimitResetAt: summary.usageLimitResetAt,
          archivedAt: null,
          settledOverride: null,
          pendingRuntimeRequest: null,
          latestRunCompletedAt: completedAt,
          updatedAt: completedAt,
          limitRecovery: null,
          snoozedUntil: null,
        },
        true,
        DateTime.toEpochMillis(completedAt),
      );
      assert.equal(command?.type, "thread.metadata.update");
      assert.deepEqual(
        command?.type === "thread.metadata.update" ? command.limitRecovery : undefined,
        { runId, resetAt: WEEKLY_RESET, autoResume: true, snooze: false },
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("pi's exhausted retries on the proxy's cooling-down 429 reset at its Retry-After", () =>
    Effect.gen(function* () {
      const hooks = yield* liveHooks(false);
      const before = DateTime.toEpochMillis(yield* DateTime.now);
      const text = COOLING_DOWN_WITH_RETRY_AFTER.text;
      const { terminal } = yield* runFailedTurn(hooks, modelSelection, [
        modelError(text),
        { type: "auto_retry_start", attempt: 1, maxAttempts: 1, delayMs: 0, errorMessage: text },
        modelError(text),
        { type: "auto_retry_end", success: false, attempt: 1, finalError: text },
      ]);
      const after = DateTime.toEpochMillis(yield* DateTime.now);
      assert.equal(terminal.failure?.class, "usage_limit");
      const resetMs = Date.parse(terminal.failure!.resetAt!);
      assert.isAtLeast(resetMs, before + 3_639_000);
      assert.isAtMost(resetMs, after + 3_639_000);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("a non-quota model error stays provider_error", () =>
    Effect.gen(function* () {
      const hooks = yield* liveHooks(true);
      const { terminal } = yield* runFailedTurn(hooks, ANTHROPIC_SELECTION, [
        modelError('400 {"type":"error","error":{"type":"invalid_request_error","message":"bad"}}'),
      ]);
      assert.equal(terminal.failure?.class, "provider_error");
      assert.isUndefined(terminal.failure?.resetAt);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("the default hooks leave upstream's classification unchanged", () =>
    Effect.gen(function* () {
      const { terminal } = yield* runFailedTurn(undefined, ANTHROPIC_SELECTION, [
        modelError(COOLING_DOWN_WITH_RETRY_AFTER.text),
      ]);
      assert.equal(terminal.failure?.class, "provider_error");
      assert.isUndefined(terminal.failure?.resetAt);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

// ── 3c-2: the codex→Anthropic session sanitiser on resume ───────────────────

const CODEX_HISTORY = [
  JSON.stringify({ type: "session", version: 3, id: "s1", cwd: THREAD_CWD }),
  JSON.stringify({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_abc|fc_123", name: "read", arguments: {} }],
    },
  }),
  JSON.stringify({
    type: "message",
    message: { role: "toolResult", toolCallId: "call_abc|fc_123", content: [] },
  }),
].join("\n");

/** Resume a codex-history session file under `model` and return what pi loaded. */
const resumeCodexHistoryUnder = Effect.fnUntraced(function* (model: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-pi-resume-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
  );
  const sessionFile = NodePath.join(dir, "0001_codex.jsonl");
  NodeFS.writeFileSync(sessionFile, CODEX_HISTORY);
  const { fake, runtime } = yield* openRuntime(undefined, yield* liveHooks(false));
  const providerThread = yield* runtime.ensureThread({
    threadId: THREAD_ID,
    modelSelection,
    runtimePolicy,
  });
  yield* runtime.resumeThread({
    providerThread: {
      ...providerThread,
      nativeThreadRef: { ...providerThread.nativeThreadRef!, nativeId: sessionFile },
    },
    modelSelection: { instanceId: PI_INSTANCE_ID, model },
  });
  assert.lengthOf(fake.switchedFiles, 1);
  return fake.switchedFiles[0]!;
});

describe("PiAdapterV2 (loom) — sanitiser before switch_session", () => {
  it.effect("an Anthropic-family resume loads a file already rid of codex tool ids", () =>
    Effect.gen(function* () {
      const loaded = yield* resumeCodexHistoryUnder("cliproxy/claude-opus-5-5");
      assert.notInclude(loaded, "|");
      assert.include(loaded, "call_abc_fc_123");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("a codex resume leaves the file untouched", () =>
    Effect.gen(function* () {
      assert.equal(yield* resumeCodexHistoryUnder("openai-codex/gpt-6.1-sol"), CODEX_HISTORY);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

// ── Assistant citations reach pi expanded, as V1's ProviderService.sendTurn did ───────────

describe("PiAdapterV2 (loom) — assistant citations", () => {
  it.effect("expands citations on both the turn and the steer prompt", () =>
    Effect.gen(function* () {
      const { fake, runtime, events } = yield* openRuntime();
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      const cite = (comment: string) =>
        serializeAssistantCitation({
          version: 1,
          environmentId: EnvironmentId.make("environment-loom"),
          threadId: THREAD_ID,
          messageId: "message:provider:pi:native-item:assistant-1" as never,
          text: "validates the result with $deploy",
          start: 10,
          end: 43,
          prefix: "",
          suffix: "",
          comment,
        });
      const message = (text: string) =>
        ({
          messageId: "message:cite" as never,
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        }) as const;
      const runId = RunId.make(`run:${THREAD_ID}:cite`);
      yield* runtime.startTurn({
        appThread: yield* appThread,
        threadId: THREAD_ID,
        runId,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make(`run-attempt:${runId}:1`),
        rootNodeId: NodeId.make(`node:${runId}:root`),
        providerThread,
        message: message(`${cite("Why?")} please explain`),
        modelSelection,
        runtimePolicy,
      });
      let providerTurnId: string | undefined;
      while (providerTurnId === undefined) {
        const event = yield* Queue.take(events);
        if (event.type === "provider_turn.updated") providerTurnId = event.providerTurn.id;
      }
      yield* fake.emit({ type: "agent_start" });
      yield* runtime.steerTurn({
        threadId: THREAD_ID,
        runId,
        providerThread,
        providerTurnId: providerTurnId as never,
        message: message(`and ${cite("Also this")}`),
      });
      while (fake.requests.filter((request) => request["type"] === "prompt").length < 2) {
        yield* Effect.yieldNow;
      }
      const [turn, steer] = fake.requests
        .filter((request) => request["type"] === "prompt")
        .map((request) => String(request["message"]));
      for (const [prompt, comment] of [
        [turn!, "Why?"],
        [steer!, "Also this"],
      ] as const) {
        assert.notInclude(prompt, "t3-citation://");
        assert.include(prompt, "[assistant-quote-1]");
        assert.include(prompt, "<assistant_citations>");
        assert.include(prompt, `"comment": "${comment}"`);
        // Quoted text is not skill-expanded.
        assert.include(prompt, "validates the result with $deploy");
      }
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

// ── 3c-3: pi's undelivered steers are mirrored to the stash (seam 20, DL-691) ───

describe("PiAdapterV2 (loom) — steer stash", () => {
  it.effect("mirrors pi's steering queue, and a turn ending does not clear it", () =>
    Effect.gen(function* () {
      const { fake, runtime, events } = yield* openRuntime(undefined, yield* liveHooks(false));
      const providerThread = yield* runtime.ensureThread({
        threadId: THREAD_ID,
        modelSelection,
        runtimePolicy,
      });
      const runId = RunId.make(`run:${THREAD_ID}:steer`);
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
          messageId: `message:${THREAD_ID}:hello` as never,
          text: "Hello pi",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      yield* fake.emit({ type: "agent_start" });
      // pi's queue as it reports it; the usage frame after it is processed after it, so seeing
      // that frame's provider_turn.updated means the stash write has happened.
      let frames = 0;
      const queue = Effect.fnUntraced(function* (steering: ReadonlyArray<string>) {
        yield* fake.emit({ type: "queue_update", steering, followUp: [] });
        yield* fake.emit({ type: "message_update", usage: { totalTokens: ++frames } });
        while (true) {
          const event = yield* Queue.take(events);
          if (
            event.type === "provider_turn.updated" &&
            event.providerTurn.tokenUsage?.usedTokens === frames
          )
            break;
        }
        return yield* PendingSteering.read(THREAD_ID);
      });

      // Each mirror is stamped with the run whose turn pi holds the steers for.
      assert.deepEqual(yield* queue(["first steer"]), { runId, text: "first steer" });
      assert.deepEqual(yield* queue(["first steer", "second steer"]), {
        runId,
        text: "first steer\n\nsecond steer",
      });
      // pi injects the first into the conversation: consumed, so never redelivered.
      assert.deepEqual(yield* queue(["second steer"]), { runId, text: "second steer" });

      // The turn ends with the second still undelivered (a stop or restart cut it, DL-561): the
      // stash keeps it; startup recovery delivers it only if a restart cut this run (DL-694).
      yield* fake.emit({ type: "agent_settled" });
      while ((yield* Queue.take(events)).type !== "turn.terminal");
      assert.deepEqual(yield* PendingSteering.read(THREAD_ID), { runId, text: "second steer" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

// Issue #342: every pi child (sessions, consults, goal reactor, text-gen) must resolve
// its worktree's own binaries first, or a bare `vp` lands on another checkout's install.
describe("PiRpc (loom) — worktree-local node_modules/.bin", () => {
  it.effect("prepends <cwd>/node_modules/.bin to the spawned pi's PATH", () =>
    Effect.gen(function* () {
      let spawnedEnv: NodeJS.ProcessEnv | undefined;
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (ChildProcess.isStandardCommand(command)) spawnedEnv = command.options.env;
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(999_999_997),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      yield* makePiRpcConnection({
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: "/w/tree",
        env: { PATH: "/release/node_modules/.bin:/usr/bin" },
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      assert.equal(
        spawnedEnv?.PATH,
        "/w/tree/node_modules/.bin:/release/node_modules/.bin:/usr/bin",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
