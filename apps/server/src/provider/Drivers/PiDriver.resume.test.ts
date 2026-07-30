// @effect-diagnostics nodeBuiltinImport:off
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { PiSettings, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it as effectIt } from "@effect/vitest";
import { afterEach, describe, expect } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { piProjectSessionDir, piSessionIdForThread } from "../piSessionFiles.ts";
import type { ProviderHealthRegistryShape } from "../Services/ProviderHealthRegistry.ts";
import type { PiRpcProcess, PiRpcProcessOptions } from "../Layers/Pi/RpcProcess.ts";
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

const neverStarts = (): Promise<PiRpcProcess> =>
  Promise.reject(new Error("this test never launches pi"));

const withAdapter = <A, E>(
  body: (adapter: ReturnType<typeof makePiAdapter>, cwd: string) => Effect.Effect<A, E>,
  createProcess: (options: PiRpcProcessOptions) => Promise<PiRpcProcess> = neverStarts,
) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const events = yield* Queue.unbounded<ProviderRuntimeEvent>();
    return yield* body(
      makePiAdapter({
        instanceId: INSTANCE,
        settings: decodePiSettings({}),
        serverConfig,
        events,
        modelContextWindows: new Map<string, number>(),
        healthRegistry: healthyRegistry,
        readFailover: Effect.succeed({ enabled: false } as never),
        readInstanceUsesUsageSources: Effect.succeed(false),
        createProcess,
      }),
      serverConfig.cwd,
    );
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-pi-resume-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.provideService(HostProcessPlatform, "linux"),
  );

const realHome = process.env.HOME;
afterEach(() => {
  process.env.HOME = realHome;
});

/**
 * Point the default pi sessions root (`~/.pi/agent/sessions`) at a temp home and
 * seed a session file for `threadId` in the project dir for `cwd`, writing
 * whatever lines the caller asks for. Returns the file path.
 */
const seedSessionFile = (input: {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly lines: ReadonlyArray<string>;
}): string => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-resume-home-"));
  process.env.HOME = home;
  const dir = piProjectSessionDir(input.cwd, NodePath.join(home, ".pi", "agent", "sessions"));
  NodeFS.mkdirSync(dir, { recursive: true });
  const sessionId = piSessionIdForThread(input.threadId);
  const path = NodePath.join(dir, `2026-07-30T00-00-00-000Z_${sessionId}.jsonl`);
  NodeFS.writeFileSync(path, input.lines.join("\n") + "\n");
  return path;
};

/** A valid prior conversation: session header plus one user message. */
const priorConversation = (threadId: ThreadId): ReadonlyArray<string> => [
  JSON.stringify({
    type: "session",
    id: piSessionIdForThread(threadId),
    timestamp: "2026-07-30T00:00:00.000Z",
    cwd: "/tmp/project",
  }),
  JSON.stringify({
    type: "message",
    message: { role: "user", content: "the orchestration context that must survive" },
  }),
];

describe("PiDriver resume state (driver boundary)", () => {
  // pi never produces an opaque resume cursor: its deterministic per-thread
  // session file IS the resume state, so the driver — not the recovery gate —
  // is what can answer whether a stopped thread is resumable.
  effectIt.effect("declares session-file resume state", () =>
    withAdapter((adapter) =>
      Effect.sync(() => {
        expect(adapter.capabilities.resumeState).toBe("session-file");
        expect(adapter.canResumeThread).toBeDefined();
      }),
    ),
  );

  effectIt.effect("is resumable when a valid prior conversation exists for the launch cwd", () =>
    withAdapter((adapter, serverCwd) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("44444444-0000-4000-8000-000000000004");
        const unlaunched = ThreadId.make("55555555-0000-4000-8000-000000000005");
        yield* Effect.sync(() =>
          seedSessionFile({ threadId, cwd: serverCwd, lines: priorConversation(threadId) }),
        );

        // No live session either way — resumability is answered from disk.
        expect(yield* adapter.hasSession(threadId)).toBe(false);
        expect(yield* adapter.canResumeThread!({ threadId, cwd: serverCwd })).toBe(true);
        // A thread that never launched has no file, so recovery must still
        // refuse rather than start a fresh, amnesiac session in its place.
        expect(yield* adapter.canResumeThread!({ threadId: unlaunched, cwd: serverCwd })).toBe(
          false,
        );
      }),
    ),
  );

  // The failure this guards: pi's `--session-id` lookup is scoped to the project
  // dir for its cwd and only accepts a file that parses as a session with a
  // matching header id. For anything else it WARNS AND CREATES A NEW SESSION, so
  // a probe that said "resumable" would resume the thread into an empty
  // conversation — looking alive with its context silently gone.
  effectIt.effect("is NOT resumable from a file pi would reject and replace", () =>
    withAdapter((adapter, serverCwd) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("66666666-0000-4000-8000-000000000006");

        // Right filename, content that is not a pi session.
        yield* Effect.sync(() => seedSessionFile({ threadId, cwd: serverCwd, lines: ["{}"] }));
        expect(yield* adapter.canResumeThread!({ threadId, cwd: serverCwd })).toBe(false);

        // Valid session, but under a DIFFERENT project dir than the launch cwd.
        yield* Effect.sync(() =>
          seedSessionFile({
            threadId,
            cwd: "/tmp/some/other/worktree",
            lines: priorConversation(threadId),
          }),
        );
        expect(yield* adapter.canResumeThread!({ threadId, cwd: serverCwd })).toBe(false);
      }),
    ),
  );

  // Continuity, at the level this boundary can prove: the launch pi is given the
  // deterministic session id whose file already holds the prior conversation, in
  // the cwd whose project dir contains it — exactly the triple pi requires to
  // open that file rather than create a new one.
  effectIt.effect(
    "launches against the same session file that holds the prior conversation",
    () => {
      const captured: { options?: PiRpcProcessOptions } = {};
      const fake = {
        child: new NodeEvents.EventEmitter(),
        command: "pi",
        args: [],
        cwd: undefined,
        stderrTail: () => "",
        request: () => Promise.resolve({ type: "response", requestId: "r", ok: true, data: {} }),
        write: () => Promise.resolve(),
        subscribe: () => () => undefined,
        stop: () => Promise.resolve(),
      } as unknown as PiRpcProcess;

      return withAdapter(
        (adapter, serverCwd) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("77777777-0000-4000-8000-000000000007");
            const seeded = yield* Effect.sync(() =>
              seedSessionFile({ threadId, cwd: serverCwd, lines: priorConversation(threadId) }),
            );
            expect(yield* adapter.canResumeThread!({ threadId, cwd: serverCwd })).toBe(true);

            yield* adapter.startSession({
              threadId,
              providerInstanceId: INSTANCE,
              cwd: serverCwd,
              runtimeMode: "full-access",
            });

            // pi resolves `--session-id` within `cwd`'s project dir, so this pair
            // names the seeded file: same id, same project dir.
            expect(captured.options?.sessionId).toBe(piSessionIdForThread(threadId));
            expect(captured.options?.cwd).toBe(serverCwd);
            expect(
              NodePath.join(
                piProjectSessionDir(
                  captured.options?.cwd ?? "",
                  NodePath.join(process.env.HOME ?? "", ".pi", "agent", "sessions"),
                ),
                `2026-07-30T00-00-00-000Z_${captured.options?.sessionId ?? ""}.jsonl`,
              ),
            ).toBe(seeded);
            // The prior conversation is still on disk, unrewritten by the launch.
            expect(NodeFS.readFileSync(seeded, "utf8")).toContain(
              "the orchestration context that must survive",
            );
            // No fork: a fork would copy the source into a NEW session id.
            expect(captured.options?.forkFrom).toBeUndefined();
          }),
        (options) => {
          captured.options = options;
          return Promise.resolve(fake);
        },
      );
    },
  );
});
