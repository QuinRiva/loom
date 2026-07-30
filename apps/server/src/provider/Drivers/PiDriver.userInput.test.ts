// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "../Layers/Pi/RpcProcess.ts";
import type { ProviderHealthRegistryShape } from "../Services/ProviderHealthRegistry.ts";
import { openPiAskUserQuestion, waitForPiAskUserQuestion } from "./Pi/askUserBroker.ts";
import { makePiAdapter } from "./PiDriver.ts";

const INSTANCE = ProviderInstanceId.make("pi");
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);
const healthyRegistry: ProviderHealthRegistryShape = {
  isExhausted: () => Effect.succeed(false),
  exhaustedUntil: () => Effect.succeed(null),
  markExhausted: () => Effect.void,
  snapshot: Effect.succeed([]),
  streamChanges: Stream.empty,
};

const makeFakeProcess = () => {
  const child = new NodeEvents.EventEmitter();
  const writes: Array<Record<string, unknown>> = [];
  let listener: (message: unknown) => void = () => undefined;
  let stderr = "";
  const process = {
    child,
    command: "pi",
    args: [],
    cwd: undefined,
    stderrTail: () => stderr,
    request: () => Promise.resolve({ type: "response", command: "test", success: true, data: {} }),
    write: (command: Record<string, unknown>) => {
      writes.push(command);
      return Promise.resolve();
    },
    subscribe: (next: (message: unknown) => void) => {
      listener = next;
      return () => undefined;
    },
    // Real `stop()` SIGTERMs pi and resolves on its `exit`, so the driver's exit
    // handler always runs on a deliberate stop too — the fake has to reproduce
    // that or the graceful path is untested.
    stop: () => {
      child.emit("exit", 0, "SIGTERM");
      return Promise.resolve();
    },
  } as unknown as PiRpcProcess;
  return {
    process,
    writes,
    factory: (_options: PiRpcProcessOptions) => Promise.resolve(process),
    emit: (message: unknown) => listener(message),
    setStderr: (next: string) => {
      stderr = next;
    },
  };
};

const withAdapter = <A, E>(
  body: (
    adapter: ReturnType<typeof makePiAdapter>,
    fake: ReturnType<typeof makeFakeProcess>,
    events: Queue.Queue<ProviderRuntimeEvent>,
  ) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const fake = makeFakeProcess();
    const adapter = makePiAdapter({
      instanceId: INSTANCE,
      settings: decodePiSettings({}),
      serverConfig,
      events,
      createProcess: fake.factory,
      modelContextWindows: new Map(),
      healthRegistry: healthyRegistry,
      readFailover: Effect.succeed({ enabled: false } as never),
      readInstanceUsesUsageSources: Effect.succeed(false),
    });
    return yield* body(adapter, fake, events);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-user-input-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

const takeEvent = <T extends ProviderRuntimeEvent["type"]>(
  events: Queue.Queue<ProviderRuntimeEvent>,
  type: T,
): Effect.Effect<Extract<ProviderRuntimeEvent, { type: T }>> =>
  Effect.gen(function* () {
    for (;;) {
      const event = yield* Queue.take(events);
      if (event.type === type) return event as Extract<ProviderRuntimeEvent, { type: T }>;
    }
  });

const startSession = (adapter: ReturnType<typeof makePiAdapter>, threadId: ThreadId) =>
  adapter.startSession({
    threadId,
    providerInstanceId: INSTANCE,
    runtimeMode: "full-access",
  });

describe("PiDriver user input", () => {
  effectIt.effect("unmaps every legacy pi dialog and emits resolved", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("11111111-1111-4111-8111-111111111111");
        yield* startSession(adapter, threadId);
        const cases: ReadonlyArray<{
          readonly id: string;
          readonly method: "select" | "confirm" | "input" | "editor";
          readonly options?: ReadonlyArray<string>;
          readonly answer: string;
          readonly response: Record<string, unknown>;
        }> = [
          {
            id: "select-1",
            method: "select",
            options: ["A", "B"],
            answer: "B",
            response: { type: "extension_ui_response", id: "select-1", value: "B" },
          },
          {
            id: "confirm-1",
            method: "confirm",
            answer: "Yes",
            response: { type: "extension_ui_response", id: "confirm-1", confirmed: true },
          },
          {
            id: "input-1",
            method: "input",
            answer: "typed input",
            response: { type: "extension_ui_response", id: "input-1", value: "typed input" },
          },
          {
            id: "editor-1",
            method: "editor",
            answer: "edited text",
            response: { type: "extension_ui_response", id: "editor-1", value: "edited text" },
          },
        ];

        for (const testCase of cases) {
          fake.emit({
            type: "extension_ui_request",
            id: testCase.id,
            method: testCase.method,
            title: "Question",
            message: "Choose",
            ...(testCase.options ? { options: testCase.options } : {}),
          });
          const requested = yield* takeEvent(events, "user-input.requested");
          expect(requested.payload.questions[0]?.options.map((option) => option.label)).toEqual(
            testCase.method === "confirm"
              ? ["Yes", "No"]
              : testCase.method === "select"
                ? ["A", "B"]
                : [],
          );
          yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(testCase.id), {
            [testCase.id]: testCase.answer,
          });
          // DELIVERY only: the durable `user-input.resolved` was already written
          // server-side (settle-first), so the adapter emits nothing here — a
          // second row would double the timeline.
          expect(fake.writes.at(-1)).toEqual(testCase.response);
        }
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  effectIt.effect("settles legacy dialogs on interrupt and explicit session stop", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("44444444-4444-4444-8444-444444444444");
        yield* startSession(adapter, threadId);

        fake.emit({
          type: "extension_ui_request",
          id: "interrupt-input",
          method: "input",
          message: "Input",
        });
        yield* takeEvent(events, "user-input.requested");
        yield* adapter.interruptTurn(threadId);
        const interrupted = yield* takeEvent(events, "user-input.resolved");
        expect(interrupted.requestId).toBe("interrupt-input");
        expect(interrupted.payload.answers).toEqual({});

        fake.emit({
          type: "extension_ui_request",
          id: "stop-editor",
          method: "editor",
          message: "Edit",
        });
        yield* takeEvent(events, "user-input.requested");
        yield* adapter.stopSession(threadId);
        const stopped = yield* takeEvent(events, "user-input.resolved");
        expect(stopped.requestId).toBe("stop-editor");
        expect(stopped.payload.answers).toEqual({});
      }),
    ),
  );

  // A deliberate stop is not a failure, but it MUST still emit session.exited:
  // ingestion uses that event to cancel every question still open on the thread
  // (durable settlement that survives a restart). Graceful labelling, same event.
  effectIt.effect("reports a deliberate stop as graceful and still settles open input", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("66666666-6666-4666-8666-666666666666");
        yield* startSession(adapter, threadId);
        // Harmless pi startup noise must NOT become the user-visible exit reason.
        fake.setStderr(
          "Warning: No project session found with id 'x'; creating a new session with that id.",
        );
        fake.emit({
          type: "extension_ui_request",
          id: "stopped-select",
          method: "select",
          message: "Choose",
          options: ["A", "B"],
        });
        yield* takeEvent(events, "user-input.requested");

        yield* adapter.stopSession(threadId);

        const resolved = yield* takeEvent(events, "user-input.resolved");
        expect(resolved.requestId).toBe("stopped-select");
        const exited = yield* takeEvent(events, "session.exited");
        expect(exited.payload).toMatchObject({ exitKind: "graceful", reason: "Session stopped." });
      }),
    ),
  );

  effectIt.effect("reports stopAll as graceful", () =>
    withAdapter((adapter, _fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("77777777-7777-4777-8777-777777777777");
        yield* startSession(adapter, threadId);
        yield* adapter.stopAll();
        const exited = yield* takeEvent(events, "session.exited");
        expect(exited.payload.exitKind).toBe("graceful");
      }),
    ),
  );

  effectIt.effect("reports an unplanned crash as an error carrying its stderr tail", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("88888888-8888-4888-8888-888888888888");
        yield* startSession(adapter, threadId);
        fake.setStderr("Stored session working directory does not exist");
        fake.process.child.emit("exit", 1, null);
        const exited = yield* takeEvent(events, "session.exited");
        expect(exited.payload).toMatchObject({
          exitKind: "error",
          reason: "Stored session working directory does not exist",
        });
      }),
    ),
  );

  effectIt.effect("settles a legacy dialog when the pi process exits", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("55555555-5555-4555-8555-555555555555");
        yield* startSession(adapter, threadId);
        fake.emit({
          type: "extension_ui_request",
          id: "crashed-select",
          method: "select",
          message: "Choose",
          options: ["A", "B"],
        });
        yield* takeEvent(events, "user-input.requested");
        fake.process.child.emit("exit", 1, null);
        const resolved = yield* takeEvent(events, "user-input.resolved");
        expect(resolved.requestId).toBe("crashed-select");
        expect(resolved.payload.answers).toEqual({});
      }),
    ),
  );

  effectIt.effect("releases a blocked broker question without a duplicate resolution event", () =>
    withAdapter((adapter, _fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("22222222-2222-4222-8222-222222222222");
        yield* startSession(adapter, threadId);
        const opened = yield* Effect.promise(() =>
          openPiAskUserQuestion(threadId, (requestId) => [
            {
              id: `${requestId}:1`,
              header: "Choice",
              question: "Which option?",
              options: [
                { label: "A", description: "First" },
                { label: "B", description: "Second", preview: "**Preview**" },
              ],
              multiSelect: false,
            },
          ]),
        );
        if ("outcome" in opened)
          throw new Error("Expected the live driver to present the question.");
        const requested = yield* takeEvent(events, "user-input.requested");
        expect(requested.requestId).toBe(opened.requestId);
        expect(requested.payload.questions[0]?.options[1]?.preview).toBe("**Preview**");

        const result = waitForPiAskUserQuestion(threadId, opened.requestId, 1_000);
        const questionId = `${opened.requestId}:1`;
        yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(opened.requestId), {
          [questionId]: "B",
        });
        // The blocked tool call is released with the answer; no runtime event is
        // emitted, because the durable resolution already exists (settle-first).
        expect(yield* Effect.promise(() => result)).toMatchObject({
          pending: false,
          outcome: "answered",
          requestId: opened.requestId,
          answers: { [questionId]: "B" },
        });
        yield* adapter.stopSession(threadId);
      }),
    ),
  );

  effectIt.effect("cancels a broker question and clears it when the turn is interrupted", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("33333333-3333-4333-8333-333333333333");
        yield* startSession(adapter, threadId);
        const opened = yield* Effect.promise(() =>
          openPiAskUserQuestion(threadId, (requestId) => [
            {
              id: `${requestId}:1`,
              header: "Choice",
              question: "Continue?",
              options: [
                { label: "Yes", description: "Continue" },
                { label: "No", description: "Stop" },
              ],
              multiSelect: false,
            },
          ]),
        );
        if ("outcome" in opened)
          throw new Error("Expected the live driver to present the question.");
        yield* takeEvent(events, "user-input.requested");
        const result = waitForPiAskUserQuestion(threadId, opened.requestId, 1_000);
        yield* adapter.interruptTurn(threadId);
        expect(fake.writes.at(-1)).toEqual({ type: "abort" });
        expect(yield* Effect.promise(() => result)).toEqual({
          pending: false,
          outcome: "cancelled",
          requestId: opened.requestId,
        });
        const resolved = yield* takeEvent(events, "user-input.resolved");
        expect(resolved.requestId).toBe(opened.requestId);
        expect(resolved.payload.answers).toEqual({});
        yield* adapter.stopSession(threadId);
      }),
    ),
  );
});
