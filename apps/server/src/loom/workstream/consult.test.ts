/**
 * A consult has no duration bound, so stopping the asker is what ends a fork
 * that never answers. Stopping aborts the asker's `consult_thread` HTTP call;
 * that must interrupt the consult and kill the fork's whole process group
 * (pi and anything its tools started); the fork's transcript stays in
 * `workstream-consults/`.
 */
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../../config.ts";
import {
  LOOM_TEST_THREAD,
  mcpTestLayer,
  serveMcp,
} from "../../mcp/toolkits/workstream/mcpHttp.testkit.ts";
import { v2PullRequestThread } from "../../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { loomPaths } from "../loomPaths.ts";
import { layer } from "./consult.ts";

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

describe.skipIf(HostProcessPlatform.defaultValue() === "win32")("consult_thread", () => {
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
            getThreadRecords: () => Effect.succeed({ providerThreads: [providerThread] } as never),
          },
          consult: layer.pipe(
            Layer.provide(ServerSettings.layerTest({ providers: { pi: { binaryPath } } })),
            Layer.orDie,
          ),
        },
        { threadId: LOOM_TEST_THREAD, capabilities: ["workstream"] },
      );

      const call = yield* Effect.forkChild(
        mcp.callTool("consult_thread", { threadId: target.id, question: "?" }),
      );
      const pidsFile = path.join(dir, "pids");
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
      for (let tries = 0; tries < 100 && pids.some(isAlive); tries++)
        yield* Effect.sleep("50 millis");
      assert.isFalse(pids.some(isAlive));
      assert.isTrue(yield* fs.exists(retained));
    }).pipe(Effect.scoped, Effect.provide(mcpTestLayer)),
  );
});
