/**
 * A consult has no duration bound, so stopping the asker is what ends a fork
 * that never answers. Stopping aborts the asker's `consult_thread` HTTP call;
 * that must interrupt the consult and kill the fork's whole process group
 * (pi and anything its tools started); the fork's transcript stays in
 * `workstream-consults/`.
 */
import { assert, describe, it } from "@effect/vitest";
import {
  consultQuestionKey,
  type LoomLiveConsult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import {
  LOOM_TEST_THREAD,
  mcpTestLayer,
  serveMcp,
} from "../../mcp/toolkits/workstream/mcpHttp.testkit.ts";
import { McpSessionRegistry } from "../../mcp/McpSessionRegistry.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { loomPaths } from "../loomPaths.ts";
import { layer, LoomThreadConsult } from "./consult.ts";
import { makeConsultTracker } from "./consultTracker.ts";

// A fork that accepts the question, starts a "tool" that never ends, and never settles.
const hungPi = (dir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const argv = process.argv;
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
fs.mkdirSync(sessionDir, { recursive: true });
const fork = sessionDir + "/fork-session.jsonl";
fs.writeFileSync(fork, "");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\\n")) >= 0; ) {
    const command = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    const reply = (data) =>
      process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data }) + "\\n");
    if (command.type === "get_state") reply({ sessionFile: fork });
    if (command.type === "prompt") {
      const tool = spawn("sleep", ["600"], { stdio: "ignore" });
      fs.writeFileSync(${JSON.stringify(dir)} + "/pids", process.pid + " " + tool.pid);
      reply({ disposition: "started" });
    }
  }
});
`;

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const shell = (id: ThreadId, title: string) =>
  v2PullRequestThread({
    id,
    projectId: ProjectId.make("project-loom"),
    title,
    modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "fable" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestUserMessageAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("consult_thread", () => {
  it.live("an aborted call kills a fork that never answers and keeps its transcript", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-consult-" });
      const binaryPath = path.join(dir, "pi");
      yield* fs.writeFileString(binaryPath, hungPi(dir));
      yield* fs.chmod(binaryPath, 0o755);

      const caller = shell(LOOM_TEST_THREAD, "Asker");
      const target = shell(ThreadId.make("thread-consult-target"), "Target");
      const providerThread = {
        id: "provider-thread-target",
        driver: "pi",
        nativeThreadRef: { driver: "pi", strength: "strong", nativeId: path.join(dir, "t.jsonl") },
      };
      const mcp = yield* serveMcp(
        {
          orchestrator: {
            getShellSnapshot: () =>
              Effect.succeed({ threads: [caller, target], archivedThreads: [] } as never),
            getThreadShell: (id) => Effect.succeed(id === caller.id ? caller : target),
            getThreadRecords: () =>
              Effect.succeed({ providerThreads: [providerThread], providerSessions: [] } as never),
          },
          consult: layer.pipe(
            // The target has no launch identity record, so the fork is cold and mints nothing.
            Layer.provide(Layer.mock(McpSessionRegistry)({})),
            Layer.provide(
              ServerSettings.layerTest({
                providerInstances: {
                  [ProviderInstanceId.make("pi")]: {
                    driver: ProviderDriverKind.make("pi"),
                    config: { binaryPath },
                  },
                },
              }),
            ),
            Layer.orDie,
          ),
        },
        { threadId: LOOM_TEST_THREAD, capabilities: ["workstream"] },
      );

      const call = yield* Effect.forkChild(
        mcp.callTool("consult_thread", { threadId: target.id, question: "?" }),
      );
      const pidsFile = path.join(dir, "pids");
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests, t3code/no-real-time-wait-in-tests -- a separate pi process writes the file; nothing in this process can signal it
      while (!(yield* fs.exists(pidsFile))) yield* Effect.sleep("20 millis");
      const pids = (yield* fs.readFileString(pidsFile)).split(" ").map(Number);
      assert.isTrue(pids.every(isAlive));

      // The asker's turn is stopped: its tool call's HTTP request is aborted.
      yield* Fiber.interrupt(call);

      const retained = path.join(
        loomPaths(yield* ServerConfig.ServerConfig).workstreamConsultsDir,
        "fork-session.jsonl",
      );
      // Teardown runs server-side after the disconnect; SIGKILL lands within pi's 1s grace.
      // The processes are not this test's children, so no exit event reaches it.
      // oxlint-disable-next-line t3code/no-polling-loop-in-tests -- see above
      for (let tries = 0; tries < 100 && pids.some(isAlive); tries++)
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- see above
        yield* Effect.sleep("50 millis");
      assert.isFalse(pids.some(isAlive));
      assert.isTrue(yield* fs.exists(retained));
    }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
  );
});

const asker = ThreadId.make("thread:asker");
const target = ThreadId.make("thread:target");
const at = (second: number) => `2026-10-12T03:00:${String(second).padStart(2, "0")}.000Z`;

describe("consult tracker", () => {
  it("folds tool boundaries and message ends into the card's figures", () => {
    const tracker = makeConsultTracker({
      consultId: "c1",
      askerThreadId: asker,
      questionKey: consultQuestionKey("Why?"),
      targetThreadId: target,
      startedAt: at(0),
    });
    tracker.begin(at(1), "cliproxy/claude-opus", "/state/workstream-consults/fork.jsonl");
    assert.deepEqual(tracker.snapshot().step, {
      kind: "model",
      since: at(1),
      title: null,
      detail: null,
    });

    const usage = { input: 100, output: 20, cacheRead: 900, cacheWrite: 10, cost: { total: 0.5 } };
    assert.isTrue(
      tracker.apply(
        {
          type: "message_end",
          message: {
            role: "assistant",
            usage,
            content: [
              { type: "text", text: "Let me look at\n the resolver." },
              { type: "toolCall" },
            ],
          },
        },
        at(2),
      ),
    );
    tracker.apply(
      {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "rg tenant_name packages\necho done" },
      },
      at(3),
    );
    tracker.apply(
      {
        type: "tool_execution_start",
        toolCallId: "t2",
        toolName: "rg",
        args: { pattern: "resolve_tenant", path: "packages/x" },
      },
      at(4),
    );
    // A streamed token changes nothing.
    assert.isFalse(tracker.apply({ type: "message_update" }, at(5)));
    tracker.apply({ type: "tool_execution_end", toolCallId: "t1", isError: false }, at(6));

    const mid = tracker.snapshot();
    // The oldest tool still in flight is the step.
    assert.deepEqual(mid.step, {
      kind: "tool",
      since: at(4),
      title: "rg",
      detail: "resolve_tenant packages/x",
    });
    assert.strictEqual(mid.toolCalls, 2);
    assert.strictEqual(mid.model, "cliproxy/claude-opus");
    assert.strictEqual(mid.narration, "Let me look at the resolver.");
    assert.deepEqual(mid.spend, {
      costUsd: 0.5,
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 910,
    });
    assert.deepEqual(
      mid.recent.map((step) => [step.title, step.detail, step.ok]),
      [
        ["bash", "rg tenant_name packages", true],
        ["rg", "resolve_tenant packages/x", null],
      ],
    );

    tracker.apply({ type: "tool_execution_end", toolCallId: "t2", isError: true }, at(7));
    // A message with no text keeps the last sentence; usage still sums.
    tracker.apply(
      { type: "message_end", message: { role: "assistant", usage, content: [] } },
      at(8),
    );
    const between = tracker.snapshot();
    assert.deepEqual(between.step, { kind: "model", since: at(7), title: null, detail: null });
    assert.strictEqual(between.narration, "Let me look at the resolver.");
    assert.strictEqual(between.spend?.costUsd, 1);
    assert.isFalse(between.recent[1]!.ok);

    for (let call = 0; call < 6; call += 1)
      tracker.apply(
        { type: "tool_execution_start", toolCallId: `r${call}`, toolName: "read", args: {} },
        at(10 + call),
      );
    tracker.end(at(20));
    const ended = tracker.snapshot();
    assert.strictEqual(ended.toolCalls, 8);
    assert.lengthOf(ended.recent, 6);
    assert.deepEqual(ended.recent[0]!.endedAt, at(20));
    // Ended under a running step: marked cut short; no step once over.
    assert.isTrue(ended.recent.every((step) => step.ok === false));
    assert.isNull(ended.step);
    assert.strictEqual(ended.endedAt, at(20));
    assert.strictEqual(ended.forkSessionPath, "/state/workstream-consults/fork.jsonl");
  });
});

/**
 * A fork that says one sentence, starts a `sleep 600` tool and never finishes
 * it; it writes its pid where the test reads it.
 */
const talkingPi = (dir: string) => `#!/usr/bin/env node
const fs = require("node:fs");
const argv = process.argv;
const sessionDir = argv[argv.indexOf("--session-dir") + 1];
fs.mkdirSync(sessionDir, { recursive: true });
const fork = sessionDir + "/fork-session.jsonl";
fs.writeFileSync(fork, "");
fs.writeFileSync(${JSON.stringify(dir)} + "/pid", String(process.pid));
const send = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let at; (at = buffer.indexOf("\\n")) >= 0; ) {
    const command = JSON.parse(buffer.slice(0, at));
    buffer = buffer.slice(at + 1);
    const reply = (data) => send({ type: "response", id: command.id, command: command.type, success: true, data });
    if (command.type === "get_state") reply({ sessionFile: fork, model: { provider: "fake", id: "model-1" } });
    if (command.type === "prompt") {
      reply({ disposition: "started" });
      send({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Checking." }],
        usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } });
      send({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "sleep 600" } });
    }
  }
});
`;

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("consult cancel", () => {
  it.live("Stop ends only the consult: ask fails with the stop sentence, the fork dies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-consult-cancel-" });
      const binary = path.join(dir, "pi");
      yield* fs.writeFileString(binary, talkingPi(dir));
      yield* fs.chmod(binary, 0o755);
      const result = yield* Effect.gen(function* () {
        const consult = yield* LoomThreadConsult;
        const items = yield* consult.subscribeLive;
        const ask = yield* Effect.forkChild(
          consult.ask({
            sessionFile: "/unused/source.jsonl",
            question: "  What ran?  ",
            asker: "thread «Asker»",
            askerThreadId: asker,
            targetThreadId: target,
          }),
        );
        const updates = yield* Queue.unbounded<LoomLiveConsult>();
        const collect = yield* Effect.forkChild(
          Stream.runForEach(items, (item) => Queue.offer(updates, item.consult)),
        );
        const takeUntil = Effect.fn("takeUntil")(function* (
          done: (consult: LoomLiveConsult) => boolean,
        ) {
          let consult = yield* Queue.take(updates);
          while (!done(consult)) consult = yield* Queue.take(updates);
          return consult;
        });
        // Wait for the fork's tool step to reach the live channel.
        const running = yield* takeUntil((consult) => consult.step?.kind === "tool");
        assert.strictEqual(running.questionKey, consultQuestionKey("What ran?"));
        assert.strictEqual(running.model, "fake/model-1");
        assert.strictEqual(running.narration, "Checking.");
        assert.match(running.forkSessionPath ?? "", /workstream-consults\/fork-session\.jsonl$/);
        const pid = Number(yield* fs.readFileString(path.join(dir, "pid")));
        assert.isTrue(isAlive(pid));

        assert.isTrue(yield* consult.cancel(running.consultId));
        const exit = yield* Fiber.await(ask);
        const ended = yield* takeUntil((consult) => consult.endedAt != null);
        yield* Fiber.interrupt(collect);
        // A stopped consult cannot be stopped again.
        assert.isFalse(yield* consult.cancel(running.consultId));
        return { exit, ended, pid, kept: yield* fs.exists(ended.forkSessionPath ?? "") };
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(Layer.mock(McpSessionRegistry)({})),
            Layer.provide(
              ServerSettings.layerTest({
                providerInstances: {
                  [ProviderInstanceId.make("pi")]: {
                    driver: ProviderDriverKind.make("pi"),
                    config: { binaryPath: binary },
                  },
                },
              }),
            ),
          ),
        ),
      );

      assert.isTrue(Exit.isFailure(result.exit));
      assert.match(String(result.exit), /Stopped from the consult card after \d+s\./);
      assert.isFalse(isAlive(result.pid));
      assert.isFalse(result.ended.recent[0]!.ok);
      // The transcript stays in workstream-consults/ and the final item names it.
      assert.isTrue(result.kept);
    }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
  );
});
