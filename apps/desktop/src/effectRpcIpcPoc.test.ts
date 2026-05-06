import { Effect, Stream } from "effect";
import { RpcClient, RpcServer } from "effect/unstable/rpc";
import { describe, expect, it } from "vitest";

import {
  DESKTOP_IPC_POC_METHODS,
  DesktopIpcPocRpcGroup,
  makeDesktopIpcPocClient,
  makeDesktopIpcPocHandlersLayer,
} from "./effectRpcIpcPoc/protocol.ts";
import {
  getEffectRpcIpcRendererBridge,
  makeEffectRpcIpcRendererPort,
  makeEffectRpcIpcRendererProtocol,
} from "./effectRpcIpcPoc/client.ts";
import { makeEffectRpcIpcMainProtocol } from "./effectRpcIpcPoc/main.ts";
import { EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY } from "./effectRpcIpcPoc/ipc.ts";
import type {
  EffectRpcIpcMainFrame,
  EffectRpcIpcMainSource,
  EffectRpcIpcRendererFrame,
} from "./effectRpcIpcPoc/ipc.ts";

describe("effect RPC over Electron IPC proof of concept", () => {
  it("round-trips unary requests through the renderer/main protocol pair", async () => {
    const ipc = new InMemoryEffectRpcIpc();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mainProtocol = yield* makeEffectRpcIpcMainProtocol(ipc.mainPort);

          yield* RpcServer.make(DesktopIpcPocRpcGroup).pipe(
            Effect.provideService(RpcServer.Protocol, mainProtocol),
            Effect.provide(
              makeDesktopIpcPocHandlersLayer({
                appVersion: "1.2.3",
                platform: "test-os",
                now: () => new Date("2026-05-06T12:00:00.000Z"),
              }),
            ),
            Effect.forkScoped,
          );

          const rendererProtocol = yield* makeEffectRpcIpcRendererProtocol(
            makeEffectRpcIpcRendererPort(getEffectRpcIpcRendererBridge(ipc.rendererGlobal)),
          );
          const client = yield* makeDesktopIpcPocClient.pipe(
            Effect.provideService(RpcClient.Protocol, rendererProtocol),
          );

          const runtimeInfo = yield* client[DESKTOP_IPC_POC_METHODS.getRuntimeInfo]({});
          const echo = yield* client[DESKTOP_IPC_POC_METHODS.echo]({ text: "hello ipc" });

          return { runtimeInfo, echo };
        }),
      ),
    );

    expect(result).toEqual({
      runtimeInfo: {
        appVersion: "1.2.3",
        platform: "test-os",
        ipcTransport: "electron-ipc",
      },
      echo: {
        text: "hello ipc",
        echoedAt: "2026-05-06T12:00:00.000Z",
      },
    });
  });

  it("keeps Effect RPC streaming semantics over the same IPC envelope", async () => {
    const ipc = new InMemoryEffectRpcIpc();

    const ticks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mainProtocol = yield* makeEffectRpcIpcMainProtocol(ipc.mainPort);

          yield* RpcServer.make(DesktopIpcPocRpcGroup).pipe(
            Effect.provideService(RpcServer.Protocol, mainProtocol),
            Effect.provide(makeDesktopIpcPocHandlersLayer()),
            Effect.forkScoped,
          );

          const rendererProtocol = yield* makeEffectRpcIpcRendererProtocol(
            makeEffectRpcIpcRendererPort(getEffectRpcIpcRendererBridge(ipc.rendererGlobal)),
          );
          const client = yield* makeDesktopIpcPocClient.pipe(
            Effect.provideService(RpcClient.Protocol, rendererProtocol),
          );

          return yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({ take: 3 }).pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
        }),
      ),
    );

    expect(ticks).toEqual([
      { sequence: 1, label: "tick:1" },
      { sequence: 2, label: "tick:2" },
      { sequence: 3, label: "tick:3" },
    ]);
  });
});

class InMemoryEffectRpcIpc {
  private readonly mainListeners = new Set<
    (source: EffectRpcIpcMainSource, frame: EffectRpcIpcRendererFrame) => void
  >();
  private readonly rendererListeners = new Set<(frame: EffectRpcIpcMainFrame) => void>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  readonly source: EffectRpcIpcMainSource = {
    id: 1,
    send: (frame) => {
      queueMicrotask(() => {
        for (const listener of this.rendererListeners) {
          listener(frame);
        }
      });
    },
    isClosed: () => this.closed,
    onClose: (listener) => {
      this.closeListeners.add(listener);
      return () => {
        this.closeListeners.delete(listener);
      };
    },
  };

  readonly mainPort = {
    subscribe: (
      listener: (source: EffectRpcIpcMainSource, frame: EffectRpcIpcRendererFrame) => void,
    ) => {
      this.mainListeners.add(listener);
      return () => {
        this.mainListeners.delete(listener);
      };
    },
  };

  readonly rendererPort = {
    send: (frame: EffectRpcIpcRendererFrame) => {
      queueMicrotask(() => {
        for (const listener of this.mainListeners) {
          listener(this.source, frame);
        }
      });
    },
    subscribe: (listener: (frame: EffectRpcIpcMainFrame) => void) => {
      this.rendererListeners.add(listener);
      return () => {
        this.rendererListeners.delete(listener);
      };
    },
  };

  readonly rendererGlobal = {
    [EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY]: this.rendererPort,
  };

  close(): void {
    this.closed = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}
