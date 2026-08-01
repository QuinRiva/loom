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
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
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
  McpProviderSession.clearAllMcpProviderSessions();
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

/** A `createProcess` stub that records the options it was launched with. */
const capturingProcess = (): {
  readonly captured: { options?: PiRpcProcessOptions };
  readonly createProcess: (options: PiRpcProcessOptions) => Promise<PiRpcProcess>;
} => {
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
  return {
    captured,
    createProcess: (options) => {
      captured.options = options;
      return Promise.resolve(fake);
    },
  };
};

/** A valid pi session, but one belonging to a DIFFERENT conversation. */
const foreignConversation = (): ReadonlyArray<string> => [
  JSON.stringify({
    type: "session",
    id: "someone-elses-session",
    timestamp: "2026-07-30T00:00:00.000Z",
    cwd: "/tmp/project",
  }),
];

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

  // The failure this guards: a resume passes `--session <path> --cwd <dir>`, and
  // pi with `--cwd` opens that path WITHOUT reading its header. A file that is
  // not a pi session (or belongs to another conversation) would therefore open as
  // an EMPTY session — looking alive with its context silently gone — so the
  // probe validates the header the launch no longer checks.
  effectIt.effect("is NOT resumable from a file that is not this thread's session", () =>
    withAdapter((adapter, serverCwd) =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("66666666-0000-4000-8000-000000000006");

        // Right filename, content that is not a pi session.
        yield* Effect.sync(() => seedSessionFile({ threadId, cwd: serverCwd, lines: ["{}"] }));
        expect(yield* adapter.canResumeThread!({ threadId, cwd: serverCwd })).toBe(false);

        // Right filename, but the header names a DIFFERENT conversation.
        yield* Effect.sync(() =>
          seedSessionFile({
            threadId,
            cwd: serverCwd,
            lines: foreignConversation(),
          }),
        );
        expect(yield* adapter.canResumeThread!({ threadId, cwd: serverCwd })).toBe(false);
      }),
    ),
  );

  // Continuity, at the level this boundary can prove: the launch is handed the
  // absolute path of the file that already holds the prior conversation, and that
  // file is still on disk unrewritten afterwards — pi is being asked to CONTINUE
  // it, not to create or fork anything.
  effectIt.effect(
    "launches against the same session file that holds the prior conversation",
    () => {
      const { captured, createProcess } = capturingProcess();

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

            // The exact file holding the prior conversation, named outright
            // (`--session <path>`) with the cwd pinned (`--cwd <dir>`).
            expect(captured.options?.sessionFilePath).toBe(seeded);
            expect(captured.options?.cwdOverride).toBe(serverCwd);
            expect(captured.options?.cwd).toBe(serverCwd);
            // NOT `--session-id`: that is create-or-resume, which from a
            // relocated cwd silently starts an empty same-id session.
            expect(captured.options?.sessionId).toBeUndefined();
            // The prior conversation is still on disk, unrewritten by the launch.
            expect(NodeFS.readFileSync(seeded, "utf8")).toContain(
              "the orchestration context that must survive",
            );
            // No fork: a fork would copy the source into a NEW session id.
            expect(captured.options?.forkFrom).toBeUndefined();
          }),
        createProcess,
      );
    },
  );

  // Probe ↔ launch consistency for the case the `--cwd` patch exists for: loom
  // deletes a completed sub-thread's worktree at fan-in, so the session file stays
  // under the DEAD worktree's project dir while the resume launches from the
  // server's workspace root. A cwd-scoped probe answers false here while the
  // launch would resume happily — a genuinely recoverable thread refused.
  effectIt.effect("resumes a session left under a relocated worktree's project dir", () => {
    const { captured, createProcess } = capturingProcess();

    return withAdapter(
      (adapter, serverCwd) =>
        Effect.gen(function* () {
          const threadId = ThreadId.make("88888888-0000-4000-8000-000000000008");
          const reapedWorktree = NodePath.join(
            NodeOS.tmpdir(),
            "t3-reaped-worktree-does-not-exist",
          );
          const seeded = yield* Effect.sync(() =>
            seedSessionFile({
              threadId,
              cwd: reapedWorktree,
              lines: priorConversation(threadId),
            }),
          );
          // The file is NOT under the launch cwd's project dir.
          expect(NodePath.dirname(seeded)).not.toBe(
            piProjectSessionDir(
              serverCwd,
              NodePath.join(process.env.HOME ?? "", ".pi", "agent", "sessions"),
            ),
          );

          expect(yield* adapter.canResumeThread!({ threadId, cwd: reapedWorktree })).toBe(true);

          yield* adapter.startSession({
            threadId,
            providerInstanceId: INSTANCE,
            cwd: reapedWorktree,
            runtimeMode: "full-access",
          });

          // Same file, resumed by path; the dangling recorded worktree is
          // replaced by the server's workspace root so `--cwd` names a live dir.
          expect(captured.options?.sessionFilePath).toBe(seeded);
          expect(captured.options?.cwdOverride).toBe(serverCwd);
          expect(captured.options?.sessionId).toBeUndefined();
          expect(NodeFS.readFileSync(seeded, "utf8")).toContain(
            "the orchestration context that must survive",
          );
        }),
      createProcess,
    );
  });

  // CAPABILITY: a terminal-lane resume comes back with its ORCHESTRATION reach
  // intact. There is no read-only engagement mode, so `ProviderService` prepares
  // the workstream MCP session unconditionally, and the driver therefore emits
  // the provider-tool extension plus the `T3_WORKSTREAM_*` env the extension's
  // tools authenticate with. Without them a re-engaged thread has no workstream
  // tools at all — the regression that left a resumed root unable to act.
  effectIt.effect(
    "a resume with a prepared MCP session carries the workstream extension+env",
    () => {
      const { captured, createProcess } = capturingProcess();

      return withAdapter(
        (adapter, serverCwd) =>
          Effect.gen(function* () {
            const threadId = ThreadId.make("99999999-0000-4000-8000-000000000009");
            yield* Effect.sync(() =>
              seedSessionFile({ threadId, cwd: serverCwd, lines: priorConversation(threadId) }),
            );
            // What unconditional `prepareMcpSession` leaves behind for the driver.
            yield* Effect.sync(() =>
              McpProviderSession.setMcpProviderSession({
                environmentId: "env-1" as never,
                threadId,
                providerSessionId: "provider-session-1",
                providerInstanceId: INSTANCE,
                endpoint: "http://127.0.0.1:4242/mcp/workstream",
                authorizationHeader: "Bearer test-token",
              }),
            );

            yield* adapter.startSession({
              threadId,
              providerInstanceId: INSTANCE,
              cwd: serverCwd,
              runtimeMode: "full-access",
            });

            const env = captured.options?.env as Record<string, string> | undefined;
            expect(env?.T3_WORKSTREAM_ENDPOINT).toContain("127.0.0.1:4242");
            expect(env?.T3_WORKSTREAM_AUTHORIZATION).toBe("Bearer test-token");
            // The provider-tool extension rides alongside the always-on search guard.
            expect(captured.options?.extensions?.length).toBeGreaterThan(1);
            // No engagement mode narrows the tool surface on a resume.
            expect(captured.options?.tools).toBeUndefined();
          }),
        createProcess,
      );
    },
  );
});
