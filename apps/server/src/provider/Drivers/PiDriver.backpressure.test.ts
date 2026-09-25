// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { PiRpcProcess } from "../Layers/Pi/RpcProcess.ts";
import { makePiAdapter } from "./PiDriver.ts";

const INSTANCE = ProviderInstanceId.make("pi");
const THREAD = ThreadId.make("33333333-3333-4333-8333-333333333333");
const SETTINGS = Schema.decodeUnknownSync(PiSettings)({});

// The listener the driver registers on pi's stdout; its return value is what
// the stdout reader counts as in flight.
type Listener = (message: unknown) => void | Promise<unknown>;

const withAdapter = <A, E>(
  capacity: number,
  body: (input: {
    readonly events: Queue.Queue<ProviderRuntimeEvent>;
    readonly child: NodeEvents.EventEmitter;
    readonly deliver: Listener;
  }) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const events = yield* Queue.bounded<ProviderRuntimeEvent>(capacity);
    const child = new NodeEvents.EventEmitter();
    let listener: Listener = () => undefined;
    const process = {
      child,
      command: "pi",
      args: [],
      cwd: undefined,
      stderrTail: () => "",
      request: () => Promise.resolve({ type: "response", command: "test", success: true }),
      write: () => Promise.resolve(),
      subscribe: (next: Listener) => {
        listener = next;
        return () => undefined;
      },
      stop: () => Promise.resolve(),
    } as unknown as PiRpcProcess;
    const adapter = makePiAdapter({
      instanceId: INSTANCE,
      settings: SETTINGS,
      serverConfig: yield* ServerConfig,
      events,
      createProcess: () => Promise.resolve(process),
      modelContextWindows: new Map(),
      healthRegistry: {
        applyUsage: () => Effect.void,
        usage: Effect.succeed([]),
        isExhausted: () => Effect.succeed(false),
        exhaustedUntil: () => Effect.succeed(null),
        markExhausted: () => Effect.void,
        snapshot: Effect.succeed([]),
        streamChanges: Stream.empty,
      },
      readFailover: Effect.succeed({ enabled: false } as never),
      readInstanceUsesUsageSources: Effect.succeed(false),
    });
    // startSession emits session.started + thread.started; drain them so the
    // test starts from an empty queue.
    const start = yield* adapter
      .startSession({ threadId: THREAD, providerInstanceId: INSTANCE, runtimeMode: "full-access" })
      .pipe(Effect.forkChild);
    expect((yield* Queue.take(events)).type).toBe("session.started");
    expect((yield* Queue.take(events)).type).toBe("thread.started");
    yield* Fiber.join(start);
    return yield* body({ events, child, deliver: (message) => listener(message) });
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-backpressure-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

const textDelta = (delta: string) => ({
  type: "message_update",
  assistantMessageEvent: { type: "text_delta", delta },
});

describe("PiDriver stdout backpressure", () => {
  effectIt.effect("holds an in-flight promise only while handling is suspended", () =>
    withAdapter(1, ({ events, deliver }) =>
      Effect.gen(function* () {
        // Handled synchronously: nothing for the reader to count.
        expect(deliver({ type: "turn_start" })).toBeUndefined();
        expect(deliver({ type: "message_start" })).toBeUndefined();
        // Fits in the empty queue: offered synchronously, still no promise.
        expect(deliver(textDelta("a"))).toBeUndefined();
        // Queue full: the offer suspends and the listener hands back its promise.
        const pending = deliver(textDelta("b"));
        expect(pending).toBeInstanceOf(Promise);
        let settled = false;
        void pending!.then(() => {
          settled = true;
        });
        yield* Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));
        expect(settled).toBe(false);
        // Freeing a slot lets the suspended offer land, which settles the promise.
        expect((yield* Queue.take(events)).type).toBe("content.delta");
        yield* Effect.promise(() => pending!);
        const delivered = yield* Queue.take(events);
        expect(delivered.type === "content.delta" && delivered.payload.delta).toBe("b");
      }),
    ),
  );
});
