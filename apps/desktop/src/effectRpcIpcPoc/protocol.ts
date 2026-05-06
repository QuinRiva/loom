import { Effect, Schema, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

export const DESKTOP_IPC_POC_METHODS = {
  getRuntimeInfo: "desktop.poc.getRuntimeInfo",
  echo: "desktop.poc.echo",
  subscribeTicks: "desktop.poc.subscribeTicks",
} as const;

export const DesktopIpcPocRuntimeInfo = Schema.Struct({
  appVersion: Schema.String,
  platform: Schema.String,
  ipcTransport: Schema.Literal("electron-ipc"),
});
export type DesktopIpcPocRuntimeInfo = typeof DesktopIpcPocRuntimeInfo.Type;

export const DesktopIpcPocEchoInput = Schema.Struct({
  text: Schema.String,
});
export type DesktopIpcPocEchoInput = typeof DesktopIpcPocEchoInput.Type;

export const DesktopIpcPocEchoResult = Schema.Struct({
  text: Schema.String,
  echoedAt: Schema.String,
});
export type DesktopIpcPocEchoResult = typeof DesktopIpcPocEchoResult.Type;

export const DesktopIpcPocSubscribeTicksInput = Schema.Struct({
  take: Schema.Number,
});
export type DesktopIpcPocSubscribeTicksInput = typeof DesktopIpcPocSubscribeTicksInput.Type;

export const DesktopIpcPocTick = Schema.Struct({
  sequence: Schema.Number,
  label: Schema.String,
});
export type DesktopIpcPocTick = typeof DesktopIpcPocTick.Type;

export const DesktopIpcPocGetRuntimeInfoRpc = Rpc.make(DESKTOP_IPC_POC_METHODS.getRuntimeInfo, {
  payload: Schema.Struct({}),
  success: DesktopIpcPocRuntimeInfo,
});

export const DesktopIpcPocEchoRpc = Rpc.make(DESKTOP_IPC_POC_METHODS.echo, {
  payload: DesktopIpcPocEchoInput,
  success: DesktopIpcPocEchoResult,
});

export const DesktopIpcPocSubscribeTicksRpc = Rpc.make(DESKTOP_IPC_POC_METHODS.subscribeTicks, {
  payload: DesktopIpcPocSubscribeTicksInput,
  success: DesktopIpcPocTick,
  stream: true,
});

export const DesktopIpcPocRpcGroup = RpcGroup.make(
  DesktopIpcPocGetRuntimeInfoRpc,
  DesktopIpcPocEchoRpc,
  DesktopIpcPocSubscribeTicksRpc,
);

export const makeDesktopIpcPocHandlersLayer = (options?: {
  readonly appVersion?: string;
  readonly platform?: string;
  readonly now?: () => Date;
}) => {
  const now = options?.now ?? (() => new Date());

  return DesktopIpcPocRpcGroup.toLayer(
    DesktopIpcPocRpcGroup.of({
      [DESKTOP_IPC_POC_METHODS.getRuntimeInfo]: () =>
        Effect.succeed({
          appVersion: options?.appVersion ?? "0.0.0-poc",
          platform: options?.platform ?? process.platform,
          ipcTransport: "electron-ipc" as const,
        }),
      [DESKTOP_IPC_POC_METHODS.echo]: (input) =>
        Effect.sync(() => ({
          text: input.text,
          echoedAt: now().toISOString(),
        })),
      [DESKTOP_IPC_POC_METHODS.subscribeTicks]: (input) =>
        Stream.fromIterable(
          Array.from({ length: Math.max(0, Math.floor(input.take)) }, (_, index) => ({
            sequence: index + 1,
            label: `tick:${index + 1}`,
          })),
        ),
    }),
  );
};

export const makeDesktopIpcPocClient = RpcClient.make(DesktopIpcPocRpcGroup);
type DesktopIpcPocClientFactory = typeof makeDesktopIpcPocClient;
export type DesktopIpcPocClient =
  DesktopIpcPocClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
