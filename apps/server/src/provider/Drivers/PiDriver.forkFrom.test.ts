// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PI_DEFAULT_MODEL, PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import {
  isKickoffDelivered,
  readLaunchIdentity,
  writeLaunchIdentity,
} from "../../orchestration/workstreamLaunchIdentity.ts";
import { piSessionIdForThread } from "../piSessionFiles.ts";
import type { ProviderHealthRegistryShape } from "../Services/ProviderHealthRegistry.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "../Layers/Pi/RpcProcess.ts";
import { makePiAdapter } from "./PiDriver.ts";

const INSTANCE = ProviderInstanceId.make("pi");
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);

// A controllable fake pi process: captures the argv/options the driver produces
// and lets the test drive the stdout stream (agent_end etc.) without a real pi.
const makeFakeProcess = () => {
  const emitter = new NodeEvents.EventEmitter();
  const requests: Array<Record<string, unknown>> = [];
  const captured: { options?: PiRpcProcessOptions } = {};
  let listener: (message: unknown) => void = () => {};
  let rejectPrompt = false;
  const process = {
    child: emitter,
    command: "pi",
    args: [],
    cwd: undefined,
    stderrTail: () => "",
    request: (command: Record<string, unknown>) => {
      requests.push(command);
      if (command.type === "prompt" && rejectPrompt) {
        return Promise.reject(new Error("simulated send failure"));
      }
      return Promise.resolve({ type: "response", requestId: "r", ok: true, data: {} });
    },
    write: () => Promise.resolve(),
    subscribe: (l: (message: unknown) => void) => {
      listener = l;
      return () => undefined;
    },
    stop: () => Promise.resolve(),
  } as unknown as PiRpcProcess;
  const factory = (options: PiRpcProcessOptions): Promise<PiRpcProcess> => {
    captured.options = options;
    return Promise.resolve(process);
  };
  return {
    factory,
    captured,
    requests,
    emit: (message: unknown) => listener(message),
    setRejectPrompt: (value: boolean) => {
      rejectPrompt = value;
    },
    factoryCalled: () => captured.options !== undefined,
  };
};

const healthyRegistry: ProviderHealthRegistryShape = {
  isExhausted: () => Effect.succeed(false),
  exhaustedUntil: () => Effect.succeed(null),
  markExhausted: () => Effect.void,
  snapshot: Effect.succeed([]),
  streamChanges: Stream.empty,
};

const withAdapter = <A, E>(
  createProcess: (options: PiRpcProcessOptions) => Promise<PiRpcProcess>,
  body: (
    adapter: ReturnType<typeof makePiAdapter>,
    dir: string,
    events: Queue.Queue<ProviderRuntimeEvent>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const adapter = makePiAdapter({
      instanceId: INSTANCE,
      settings: decodePiSettings({}),
      serverConfig,
      events,
      modelContextWindows: new Map<string, number>(),
      healthRegistry: healthyRegistry,
      readFailover: Effect.succeed({ enabled: false } as never),
      readInstanceUsesUsageSources: Effect.succeed(false),
      createProcess,
    });
    return yield* body(adapter, serverConfig.workstreamLaunchIdentityDir, events);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-forkfrom-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

// Drain events until (and including) the first turn.completed, returning all
// taken events. Because completeTurn/failTurn persist the record BEFORE emitting
// turn.completed on a single fiber, receiving turn.completed proves the record
// write already happened.
const takeUntilTurnCompleted = (events: Queue.Queue<ProviderRuntimeEvent>) =>
  Effect.gen(function* () {
    const taken: Array<ProviderRuntimeEvent> = [];
    for (;;) {
      const event = yield* Queue.take(events);
      taken.push(event);
      if (event.type === "turn.completed") return taken;
    }
  });

describe("PiDriver forkFrom launch identity (driver boundary)", () => {
  effectIt.effect(
    "captures the composed argv + writes the launch-identity record at a non-fork launch",
    () => {
      const fake = makeFakeProcess();
      return withAdapter(fake.factory, (adapter, dir) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("11111111-0000-4000-8000-000000000001");
          yield* adapter.startSession({
            threadId,
            providerInstanceId: INSTANCE,
            modelSelection: { instanceId: INSTANCE, model: "test-model" },
            appendSystemPrompt: "role overlay",
            tools: ["read"],
            skills: ["/skill"],
            runtimeMode: "full-access",
          });
          // The driver passed the composed argv (no fork).
          expect(fake.captured.options?.forkFrom).toBeUndefined();
          expect(fake.captured.options?.appendSystemPrompt).toBe("role overlay");
          expect(fake.captured.options?.tools).toEqual(["read"]);
          expect(fake.captured.options?.skills).toEqual(["/skill"]);
          // ...and captured the identity record.
          const record = readLaunchIdentity(dir, threadId);
          expect(record?.appendSystemPrompt).toBe("role overlay");
          expect(record?.model).toBe("test-model");
          expect(record?.tools).toEqual(["read"]);
          expect(record?.providerInstanceId).toBe(INSTANCE);
        }),
      );
    },
  );

  effectIt.effect(
    "replays the SOURCE record verbatim (forkFrom + final argv, no double prepend) at a fork's first launch",
    () => {
      const fake = makeFakeProcess();
      return withAdapter(fake.factory, (adapter, dir) =>
        Effect.gen(function* () {
          const source = ThreadId.make("22222222-0000-4000-8000-000000000002");
          const fork = ThreadId.make("33333333-0000-4000-8000-000000000003");
          // The source's captured identity (final argv bytes, one WORK_MODEL).
          writeLaunchIdentity(dir, source, {
            providerInstanceId: INSTANCE,
            model: "src-model",
            options: [{ id: "thinkingLevel", value: "high" }],
            appendSystemPrompt: "WORK_MODEL\n\nreader overlay",
            tools: ["read", "grep"],
            skills: ["/skill-a"],
          });
          yield* adapter.startSession({
            threadId: fork,
            providerInstanceId: INSTANCE,
            // The reactor would recompose these; the replay MUST ignore them.
            modelSelection: { instanceId: INSTANCE, model: "src-model" },
            appendSystemPrompt: "reactor recomposed overlay",
            tools: ["edit"],
            skills: ["/composed"],
            runtimeMode: "full-access",
            forkFromThreadId: source,
          });
          // Forks the source session, and replays the source's final argv verbatim.
          expect(fake.captured.options?.forkFrom).toBe(piSessionIdForThread(source));
          expect(fake.captured.options?.appendSystemPrompt).toBe("WORK_MODEL\n\nreader overlay");
          expect(fake.captured.options?.appendSystemPrompt?.match(/WORK_MODEL/g)?.length).toBe(1);
          expect(fake.captured.options?.tools).toEqual(["read", "grep"]);
          expect(fake.captured.options?.skills).toEqual(["/skill-a"]);
          // The fork's OWN record carries the replayed argv (so a fork-of-fork inherits it).
          expect(readLaunchIdentity(dir, fork)?.appendSystemPrompt).toBe(
            "WORK_MODEL\n\nreader overlay",
          );
        }),
      );
    },
  );

  effectIt.effect(
    "refuses a fork's first launch when the source has no captured record (loud, no launch)",
    () => {
      const fake = makeFakeProcess();
      return withAdapter(fake.factory, (adapter) =>
        Effect.gen(function* () {
          const fork = ThreadId.make("44444444-0000-4000-8000-000000000004");
          const source = ThreadId.make("55555555-0000-4000-8000-000000000005");
          const result = yield* adapter
            .startSession({
              threadId: fork,
              providerInstanceId: INSTANCE,
              modelSelection: { instanceId: INSTANCE, model: "m" },
              runtimeMode: "full-access",
              forkFromThreadId: source,
            })
            .pipe(
              Effect.as("launched" as const),
              Effect.catch(() => Effect.succeed("refused" as const)),
            );
          expect(result).toBe("refused");
          // The refusal happens before any process is created.
          expect(fake.factoryCalled()).toBe(false);
        }),
      );
    },
  );

  effectIt.effect("marks the kickoff delivered only after pi ACCEPTS the prompt", () => {
    const accept = makeFakeProcess();
    return withAdapter(accept.factory, (adapter, dir) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("66666666-0000-4000-8000-000000000006");
        yield* adapter.startSession({
          threadId,
          providerInstanceId: INSTANCE,
          modelSelection: { instanceId: INSTANCE, model: "test-model" },
          runtimeMode: "full-access",
        });
        // Launch alone does not deliver a kickoff.
        expect(isKickoffDelivered(dir, threadId)).toBe(false);
        yield* adapter.sendTurn({ threadId, input: "hello" });
        expect(isKickoffDelivered(dir, threadId)).toBe(true);
      }),
    );
  });

  effectIt.effect("does NOT mark the kickoff delivered when the prompt send fails", () => {
    const reject = makeFakeProcess();
    reject.setRejectPrompt(true);
    return withAdapter(reject.factory, (adapter, dir) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("77777777-0000-4000-8000-000000000007");
        yield* adapter.startSession({
          threadId,
          providerInstanceId: INSTANCE,
          modelSelection: { instanceId: INSTANCE, model: "test-model" },
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "hello" }).pipe(Effect.catch(() => Effect.void));
        expect(isKickoffDelivered(dir, threadId)).toBe(false);
      }),
    );
  });

  effectIt.effect(
    "advances the applied selection at completeTurn BEFORE emitting turn.completed",
    () => {
      const fake = makeFakeProcess();
      return withAdapter(fake.factory, (adapter, dir, events) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("88888888-0000-4000-8000-000000000008");
          // Launch on the default model with LOW thinking.
          yield* adapter.startSession({
            threadId,
            providerInstanceId: INSTANCE,
            modelSelection: {
              instanceId: INSTANCE,
              model: PI_DEFAULT_MODEL,
              options: [{ id: "thinkingLevel", value: "low" }],
            },
            runtimeMode: "full-access",
          });
          // Turn runs with HIGH thinking (an in-session change).
          yield* adapter.sendTurn({
            threadId,
            input: "go",
            modelSelection: {
              instanceId: INSTANCE,
              model: PI_DEFAULT_MODEL,
              options: [{ id: "thinkingLevel", value: "high" }],
            },
          });
          // Drive a clean agent_end.
          fake.emit({
            type: "agent_end",
            willRetry: false,
            messages: [{ role: "assistant", stopReason: "completed" }],
          });
          const taken = yield* takeUntilTurnCompleted(events);
          const completed = taken.find((event) => event.type === "turn.completed");
          expect(completed?.payload).toMatchObject({ state: "completed" });
          // When turn.completed is observed, the record already reflects the
          // applied selection that served the turn (HIGH), not the launch LOW.
          const record = readLaunchIdentity(dir, threadId);
          expect(record?.options).toContainEqual({ id: "thinkingLevel", value: "high" });
        }),
      );
    },
  );

  effectIt.effect(
    "advances the applied selection on failTurn too (a post-send error settlement)",
    () => {
      const fake = makeFakeProcess();
      return withAdapter(fake.factory, (adapter, dir, events) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("99999999-0000-4000-8000-000000000009");
          yield* adapter.startSession({
            threadId,
            providerInstanceId: INSTANCE,
            modelSelection: {
              instanceId: INSTANCE,
              model: PI_DEFAULT_MODEL,
              options: [{ id: "thinkingLevel", value: "low" }],
            },
            runtimeMode: "full-access",
          });
          yield* adapter.sendTurn({
            threadId,
            input: "go",
            modelSelection: {
              instanceId: INSTANCE,
              model: PI_DEFAULT_MODEL,
              options: [{ id: "thinkingLevel", value: "high" }],
            },
          });
          // A non-retryable client error settles the turn via failTurn.
          fake.emit({
            type: "agent_end",
            willRetry: false,
            messages: [
              {
                role: "assistant",
                stopReason: "error",
                errorMessage: "invalid_request_error: bad",
              },
            ],
          });
          const taken = yield* takeUntilTurnCompleted(events);
          expect(taken.some((event) => event.type === "runtime.error")).toBe(true);
          const completed = taken.find((event) => event.type === "turn.completed");
          expect(completed?.payload).toMatchObject({ state: "failed" });
          expect(readLaunchIdentity(dir, threadId)?.options).toContainEqual({
            id: "thinkingLevel",
            value: "high",
          });
        }),
      );
    },
  );
});
