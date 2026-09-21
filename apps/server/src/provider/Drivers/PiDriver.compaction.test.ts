// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

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
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { piProjectSessionDir, piSessionIdForThread } from "../piSessionFiles.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "../Layers/Pi/RpcProcess.ts";
import type { ProviderHealthRegistryShape } from "../Services/ProviderHealthRegistry.ts";
import { makePiAdapter } from "./PiDriver.ts";

const INSTANCE = ProviderInstanceId.make("pi");
const decodePiSettings = Schema.decodeUnknownSync(PiSettings);
const healthyRegistry: ProviderHealthRegistryShape = {
  applyUsage: () => Effect.void,
  usage: Effect.succeed([]),
  isExhausted: () => Effect.succeed(false),
  exhaustedUntil: () => Effect.succeed(null),
  markExhausted: () => Effect.void,
  snapshot: Effect.succeed([]),
  streamChanges: Stream.empty,
};

const makeFakeProcess = (options?: { readonly failCompact?: string }) => {
  const child = new NodeEvents.EventEmitter();
  const requests: Array<Record<string, unknown>> = [];
  const launches: Array<PiRpcProcessOptions> = [];
  let listener: (message: unknown) => void = () => undefined;
  const process = {
    child,
    command: "pi",
    args: [],
    cwd: undefined,
    stderrTail: () => "",
    request: (command: Record<string, unknown>) => {
      requests.push(command);
      if (command.type === "compact" && options?.failCompact) {
        return Promise.reject(new Error(options.failCompact));
      }
      return Promise.resolve({ type: "response", command: command.type, success: true, data: {} });
    },
    write: () => Promise.resolve(),
    subscribe: (next: (message: unknown) => void) => {
      listener = next;
      return () => undefined;
    },
    stop: () => {
      child.emit("exit", 0, "SIGTERM");
      return Promise.resolve();
    },
  } as unknown as PiRpcProcess;
  return {
    process,
    requests,
    launches,
    factory: (launchOptions: PiRpcProcessOptions) => {
      launches.push(launchOptions);
      return Promise.resolve(process);
    },
    emit: (message: unknown) => listener(message),
  };
};

const withAdapter = <A, E>(
  body: (
    adapter: ReturnType<typeof makePiAdapter>,
    fake: ReturnType<typeof makeFakeProcess>,
    events: Queue.Queue<ProviderRuntimeEvent>,
    cwd: string,
  ) => Effect.Effect<A, E>,
  fake: ReturnType<typeof makeFakeProcess> = makeFakeProcess(),
) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const adapter = makePiAdapter({
      instanceId: INSTANCE,
      settings: decodePiSettings({}),
      serverConfig,
      events,
      createProcess: fake.factory,
      modelContextWindows: new Map([["anthropic/claude-x", 200_000]]),
      healthRegistry: healthyRegistry,
      readFailover: Effect.succeed({ enabled: false } as never),
      readInstanceUsesUsageSources: Effect.succeed(false),
    });
    return yield* body(adapter, fake, events, serverConfig.cwd);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-compaction-" }).pipe(
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
  adapter.startSession({ threadId, providerInstanceId: INSTANCE, runtimeMode: "full-access" });

const compactionEnd = (
  result: Record<string, unknown> | null,
  extra?: Record<string, unknown>,
) => ({
  type: "compaction_end",
  reason: "manual",
  result,
  aborted: false,
  willRetry: false,
  ...extra,
});

const realHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = realHome;
});

/**
 * Seed a linear pi session file with `prompts` user turns, as pi would write it.
 * `modelChangeBeforePrompt` inserts pi's `model_change` entry ahead of that
 * prompt index, reproducing an in-session model switch.
 */
const seedConversation = (input: {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly prompts: ReadonlyArray<string>;
  readonly modelChangeBeforePrompt?: number;
}): string => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-compaction-home-"));
  process.env.HOME = home;
  const dir = piProjectSessionDir(input.cwd, NodePath.join(home, ".pi", "agent", "sessions"));
  NodeFS.mkdirSync(dir, { recursive: true });
  const sessionId = piSessionIdForThread(input.threadId);
  const path = NodePath.join(dir, `2026-09-01T00-00-00-000Z_${sessionId}.jsonl`);
  let parentId: string | null = null;
  const lines = [
    JSON.stringify({
      type: "session",
      version: 1,
      id: sessionId,
      timestamp: "2026-09-01T00:00:00.000Z",
      cwd: input.cwd,
    }),
  ];
  input.prompts.forEach((prompt, index) => {
    if (input.modelChangeBeforePrompt === index) {
      const id = `model-change-${index}`;
      lines.push(
        JSON.stringify({
          type: "model_change",
          id,
          parentId,
          provider: "anthropic",
          modelId: "claude-x",
        }),
      );
      parentId = id;
    }
    // One turn = a user prompt, the assistant reply, and a tool result — the
    // last of which is role `toolResult`, never `user`.
    for (const message of [
      { role: "user", content: prompt },
      { role: "assistant", content: `reply ${index}` },
      { role: "toolResult", content: `tool ${index}` },
    ]) {
      const id = `${message.role}-${index}`;
      lines.push(JSON.stringify({ type: "message", id, parentId, message }));
      parentId = id;
    }
  });
  NodeFS.writeFileSync(path, lines.join("\n") + "\n");
  return path;
};

/** An entry re-parented onto an earlier one: a second branch, not the tail. */
const SIBLING_BRANCH_ENTRY =
  JSON.stringify({
    type: "message",
    id: "branch-1",
    parentId: "user-0",
    message: { role: "user", content: "sibling branch" },
  }) + "\n";

const promptsIn = (path: string): ReadonlyArray<string> =>
  NodeFS.readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { message?: { role?: string; content?: string } })
    .flatMap((entry) =>
      entry.message?.role === "user" && entry.message.content ? [entry.message.content] : [],
    );

describe("PiDriver context compaction", () => {
  effectIt.effect("declares native compaction and conversation rollback", () =>
    withAdapter((adapter) =>
      Effect.sync(() => {
        expect(adapter.compaction).toEqual({ type: "native", start: expect.any(Function) });
        expect(adapter.capabilities.supportsConversationRollback).toBe(true);
      }),
    ),
  );

  effectIt.effect("starting a compaction issues pi's compact RPC", () =>
    withAdapter((adapter, fake) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("21111111-1111-4111-8111-111111111111");
        yield* startSession(adapter, threadId);
        yield* adapter.compaction!.type === "native"
          ? adapter.compaction!.start(threadId)
          : Effect.void;
        expect(fake.requests.filter((request) => request.type === "compact")).toHaveLength(1);
      }),
    ),
  );

  // ProviderService's native compaction path waits for the `compacted` thread
  // state; without it a Compact press hangs until the 10-minute deadline.
  effectIt.effect("maps pi's compaction_end onto the compacted thread state", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("22222222-1111-4111-8111-111111111111");
        yield* startSession(adapter, threadId);
        yield* Effect.sync(() =>
          fake.emit(compactionEnd({ tokensBefore: 150_000, estimatedTokensAfter: 32_000 })),
        );

        const compacted = yield* takeEvent(events, "thread.state.changed");
        expect(compacted.payload.state).toBe("compacted");
        expect(compacted.payload.beforeTokens).toBe(150_000);
        expect(compacted.payload.afterTokens).toBe(32_000);

        // The meter has to drop now: pi reports no context usage again until
        // the next assistant response.
        const usage = yield* takeEvent(events, "thread.token-usage.updated");
        expect(usage.payload.usage.usedTokens).toBe(32_000);
      }),
    ),
  );

  effectIt.effect("reports a failed manual compaction, but stays quiet for pi's own", () =>
    withAdapter((adapter, fake, events) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("33333333-1111-4111-8111-111111111111");
        yield* startSession(adapter, threadId);

        // No manual compaction is pending: pi auto-compacted and failed, which
        // it recovers from itself. Emitting a runtime error here would fail a
        // turn pi is still running.
        const beforeAutoFailure = yield* Queue.size(events);
        yield* Effect.sync(() =>
          fake.emit(compactionEnd(null, { reason: "threshold", errorMessage: "quota exceeded" })),
        );
        expect(yield* Queue.size(events)).toBe(beforeAutoFailure);

        yield* adapter.compaction!.type === "native"
          ? adapter.compaction!.start(threadId)
          : Effect.void;
        yield* Effect.sync(() =>
          fake.emit(compactionEnd(null, { errorMessage: "quota exceeded" })),
        );
        const failure = yield* takeEvent(events, "runtime.error");
        expect(failure.payload.message).toContain("quota exceeded");
      }),
    ),
  );
});

describe("PiDriver MCP capabilities", () => {
  effectIt.effect("requests the workstream capability for every pi session", () =>
    withAdapter((adapter) =>
      Effect.sync(() => {
        // Regression (cadence pull 6): `workstream` gates every workstream/goal/
        // task MCP endpoint, so a pi session without it 401s the whole
        // orchestration toolkit. ProviderService unions what the driver requests
        // onto the issued credential.
        expect(adapter.capabilities.mcp).toEqual(["workstream"]);
      }),
    ),
  );
});

describe("PiDriver conversation rollback", () => {
  effectIt.effect("rewinds the session file by the rolled-back prompts and relaunches pi", () => {
    const fake = makeFakeProcess();
    return withAdapter(
      (adapter, _fake, _events, cwd) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("44444444-1111-4111-8111-111111111111");
          const path = yield* Effect.sync(() =>
            seedConversation({ threadId, cwd, prompts: ["first", "second", "third"] }),
          );
          yield* startSession(adapter, threadId);
          const launchesBefore = fake.launches.length;

          const snapshot = yield* adapter.rollbackThread(threadId, 2);

          // The rolled-back prompts and everything they produced are gone from
          // the history pi resumes, and the file keeps its identity so the next
          // resume opens THIS file rather than a fork pi would branch away to.
          expect(promptsIn(path)).toEqual(["first"]);
          expect(NodeFS.readFileSync(path, "utf8")).toContain(
            `"${piSessionIdForThread(threadId)}"`,
          );
          expect(snapshot.threadId).toBe(threadId);
          // Rewriting under a live pi would race its writer, so the process is
          // replaced against the rewound file.
          expect(fake.launches.length).toBe(launchesBefore + 1);
        }),
      fake,
    );
  });

  effectIt.effect("reverting every prompt leaves the same session, empty", () => {
    const fake = makeFakeProcess();
    return withAdapter(
      (adapter, _fake, _events, cwd) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("55555555-1111-4111-8111-111111111111");
          const path = yield* Effect.sync(() =>
            seedConversation({ threadId, cwd, prompts: ["first", "second"] }),
          );
          yield* startSession(adapter, threadId);

          yield* adapter.rollbackThread(threadId, 2);

          expect(promptsIn(path)).toEqual([]);
          expect(yield* adapter.canResumeThread!({ threadId, cwd })).toBe(true);
        }),
      fake,
    );
  });

  // pi rebuilds a resumed session's model from the retained branch, so a rewind
  // that drops the `model_change` brings the fresh process up on the PREVIOUS
  // model. Without a forced re-assert the adapter's dedupe sees a matching slug
  // and stays quiet, and every later turn runs on the wrong model while the
  // cost ledger bills the new one.
  effectIt.effect("re-asserts the session model when the rewind drops a model change", () => {
    const fake = makeFakeProcess();
    return withAdapter(
      (adapter, _fake, _events, cwd) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("77777777-1111-4111-8111-111111111111");
          yield* Effect.sync(() =>
            seedConversation({
              threadId,
              cwd,
              prompts: ["first", "second"],
              modelChangeBeforePrompt: 1,
            }),
          );
          yield* startSession(adapter, threadId);
          yield* adapter.sendTurn({
            threadId,
            input: "third",
            modelSelection: { instanceId: INSTANCE, model: "anthropic/claude-x" },
          });
          const setModelsBefore = fake.requests.filter(
            (request) => request.type === "set_model",
          ).length;

          yield* adapter.rollbackThread(threadId, 1);

          const setModels = fake.requests.filter((request) => request.type === "set_model");
          expect(setModels.length).toBe(setModelsBefore + 1);
          expect(setModels.at(-1)).toMatchObject({ provider: "anthropic", modelId: "claude-x" });
        }),
      fake,
    );
  });

  // A branched session would need its whole retained path rebuilt; the driver
  // never creates one, so the promise in `planPiSessionRewind` is to refuse
  // rather than truncate something it has misread.
  effectIt.effect("refuses to rewind a branched session rather than guess", () => {
    const fake = makeFakeProcess();
    return withAdapter(
      (adapter, _fake, _events, cwd) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("88888888-1111-4111-8111-111111111111");
          const path = yield* Effect.sync(() =>
            seedConversation({ threadId, cwd, prompts: ["first", "second"] }),
          );
          const original = yield* Effect.sync(() => NodeFS.readFileSync(path, "utf8"));
          yield* Effect.sync(() => NodeFS.appendFileSync(path, SIBLING_BRANCH_ENTRY));
          yield* startSession(adapter, threadId);

          const failure = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
          expect(failure.message).toContain("branched");
          // Refusing means leaving the history alone, not half-rewriting it.
          expect(NodeFS.readFileSync(path, "utf8").startsWith(original)).toBe(true);
        }),
      fake,
    );
  });

  effectIt.effect("refuses a rollback it cannot ground in a session file", () => {
    const fake = makeFakeProcess();
    return withAdapter(
      (adapter) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("66666666-1111-4111-8111-111111111111");
          const home = yield* Effect.sync(() =>
            NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-compaction-home-")),
          );
          yield* Effect.sync(() => {
            process.env.HOME = home;
          });
          yield* startSession(adapter, threadId);

          const failure = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
          expect(failure.message).toContain("cannot be rewound");
        }),
      fake,
    );
  });
});
