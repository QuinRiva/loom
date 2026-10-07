// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ChatAttachment, ProviderRuntimeEvent } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import type { ProviderHealthRegistryShape } from "../Services/ProviderHealthRegistry.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "../Layers/Pi/RpcProcess.ts";
import { makePiAdapter } from "./PiDriver.ts";

const INSTANCE = ProviderInstanceId.make("pi");
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);
const THREAD = ThreadId.make("aaaaaaaa-0000-4000-8000-00000000000a");

const healthyRegistry: ProviderHealthRegistryShape = {
  applyUsage: () => Effect.void,
  usage: Effect.succeed([]),
  isExhausted: () => Effect.succeed(false),
  exhaustedUntil: () => Effect.succeed(null),
  markExhausted: () => Effect.void,
  snapshot: Effect.succeed([]),
  streamChanges: Stream.empty,
};

const makeFakeProcess = () => {
  const requests: Array<Record<string, unknown>> = [];
  const process = {
    child: new NodeEvents.EventEmitter(),
    command: "pi",
    args: [],
    cwd: undefined,
    stderrTail: () => "",
    request: (command: Record<string, unknown>) => {
      requests.push(command);
      return Promise.resolve({ type: "response", requestId: "r", ok: true, data: {} });
    },
    write: () => Promise.resolve(),
    subscribe: () => () => undefined,
    stop: () => Promise.resolve(),
  } as unknown as PiRpcProcess;
  return { requests, factory: (): Promise<PiRpcProcess> => Promise.resolve(process) };
};

/** Writes the bytes where `resolveAttachmentPath` will look for them. */
const writeAttachment = (attachmentsDir: string, fileName: string, bytes: Buffer) => {
  NodeFS.mkdirSync(attachmentsDir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(attachmentsDir, fileName), bytes);
};

const attachment = (over: Partial<ChatAttachment> & { type: "image" | "file" }): ChatAttachment =>
  ({
    id: "att",
    name: "file",
    mimeType: "application/octet-stream",
    sizeBytes: 3,
    ...over,
  }) as ChatAttachment;

const withAdapter = <A, E>(
  createProcess: (options: PiRpcProcessOptions) => Promise<PiRpcProcess>,
  body: (
    adapter: ReturnType<typeof makePiAdapter>,
    serverConfig: ServerConfig["Service"],
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
    return yield* body(adapter, serverConfig);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-attachments-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

describe("PiDriver attachment boundary", () => {
  // Pi ingests image blocks only. A PDF (or a folded-paste text file) submitted
  // as base64 image data fails the turn at the model API, so non-image
  // attachments must ride as the on-disk path ProviderService puts in the text.
  effectIt.effect("sends images as image blocks and leaves other files to their path", () => {
    const fake = makeFakeProcess();
    return withAdapter(fake.factory, (adapter, serverConfig) =>
      Effect.gen(function* () {
        writeAttachment(serverConfig.attachmentsDir, "shot.png", Buffer.from("png"));
        writeAttachment(serverConfig.attachmentsDir, "report.pdf", Buffer.from("pdf"));
        writeAttachment(serverConfig.attachmentsDir, "pasted.txt", Buffer.from("txt"));
        yield* adapter.startSession({
          threadId: THREAD,
          providerInstanceId: INSTANCE,
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({
          threadId: THREAD,
          input: 'read [Attached file "report.pdf" is saved at: …]',
          attachments: [
            attachment({ type: "image", id: "shot", name: "shot.png", mimeType: "image/png" }),
            attachment({
              type: "file",
              id: "report",
              name: "report.pdf",
              mimeType: "application/pdf",
            }),
            attachment({ type: "file", id: "pasted", name: "pasted.txt", mimeType: "text/plain" }),
          ],
        });
        const prompt = fake.requests.find((request) => request.type === "prompt");
        expect(prompt?.images).toEqual([
          { type: "image", data: Buffer.from("png").toString("base64"), mimeType: "image/png" },
        ]);
      }),
    );
  });
});
