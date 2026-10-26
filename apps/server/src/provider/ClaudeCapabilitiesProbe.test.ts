// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process"; // loom: wedged-probe test
// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings, type ServerProvider } from "@t3tools/contracts";
import { vi } from "vite-plus/test";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem"; // loom: wedged-probe test
import * as Path from "effect/Path"; // loom: wedged-probe test
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  isLegacyClaudeModel, // loom
  probeClaudeWorkspaceSnapshot,
} from "./ClaudeProvider.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

// loom: the Claude capability probe and its legacy-model classification.
/**
 * Poll until `pid` is gone. The Agent SDK terminates an aborted subprocess on a
 * timer (SIGTERM after ~2s, SIGKILL after ~5s more), so this cannot be observed
 * synchronously — and it uses wall-clock timers, so `Effect.sleep` (virtualised
 * under `it.effect`) would never let them fire.
 */
async function awaitProcessExit(pid: number, attempts = 300): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // The probe's process is not this test's child, so no exit event reaches it.
    // @effect-diagnostics-next-line globalTimers:off - Wall-clock poll; Effect's Clock is virtualised under `it.effect`.
    await new Promise((resolve) => setTimeout(resolve, 100)); // oxlint-disable-line t3code/no-real-time-wait-in-tests -- see above
  }
  return false;
}
it("keeps only the current Claude family out of legacy models", () => {
  assert.deepStrictEqual(
    ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5", "claude-opus-5"].map((model) => [
      model,
      isLegacyClaudeModel(model),
    ]),
    [
      ["claude-fable-5-1", false],
      ["claude-opus-5-5", false],
      ["claude-sonnet-5", false],
      ["claude-opus-5", true],
    ],
  );
});
it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

// loom: an aborted probe must not orphan a wedged Claude subprocess across a restart.
it.layer(NodeServices.layer)("Claude capability probe orphan cleanup", (it) => {
  it.effect("kills a wedged probe subprocess when the server exits right after aborting", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-orphan-" });
      const executablePath = path.join(tempDir, "wedged-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      const runnerPath = path.join(tempDir, "run-probe.mjs");

      // Answers `initialize`, then ignores stdin EOF *and* SIGTERM: the shape of a
      // Claude subprocess wedged on a network or filesystem call.
      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({ pid: process.pid }));",
          'for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {});',
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request" || message.request?.subtype !== "initialize") return;',
          "  process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          "    response: {",
          '      subtype: "success",',
          "      request_id: message.request_id,",
          "      response: {",
          "        commands: [],",
          "        agents: [],",
          '        output_style: "default",',
          '        available_output_styles: ["default"],',
          "        models: [],",
          '        account: { email: "dev@example.com", subscriptionType: "pro" },',
          "      },",
          "    },",
          '  }) + "\\n");',
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      // Probe from a child that exits once the probe resolves: the SDK force-kills an aborted
      // subprocess only on unref'd timers (~7s), so this reproduces a restart mid-probe, which
      // would reparent the child to systemd. URLs are resolved because the runner's temp dir has
      // no node_modules.
      yield* fs.writeFileString(
        runnerPath,
        [
          `import * as NodeServices from "${import.meta.resolve("@effect/platform-node/NodeServices")}";`,
          `import * as Effect from "${import.meta.resolve("effect/Effect")}";`,
          `import * as Schema from "${import.meta.resolve("effect/Schema")}";`,
          `import { ClaudeSettings } from "${import.meta.resolve("@t3tools/contracts")}";`,
          `import { probeClaudeCapabilities } from "${import.meta.resolve("./ClaudeProvider.ts")}";`,
          "const settings = Schema.decodeSync(ClaudeSettings)({ binaryPath: process.env.T3_PROBE_EXECUTABLE });",
          "await Effect.runPromise(",
          "  probeClaudeCapabilities(settings, { ...process.env }, process.cwd()).pipe(",
          "    Effect.provide(NodeServices.layer),",
          "    Effect.scoped,",
          "  ),",
          ");",
          "process.exit(0);",
          "",
        ].join("\n"),
      );

      yield* Effect.promise(
        () =>
          new Promise<void>((resolve, reject) => {
            const runner = NodeChildProcess.spawn(process.execPath, [runnerPath], {
              stdio: ["ignore", "ignore", "inherit"],
              env: {
                ...process.env,
                T3_PROBE_EXECUTABLE: executablePath,
                T3_PROBE_INVOCATION_PATH: invocationPath,
              },
            });
            runner.once("error", reject);
            runner.once("exit", (code) =>
              code === 0 ? resolve() : reject(new Error(`probe runner exited with ${code}`)),
            );
          }),
      );

      // This fixture records only its pid: the flag assertions live with the
      // invocation test above, which is the one whose fake echoes argv.
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly pid: number;
      };
      assert.equal(yield* Effect.promise(() => awaitProcessExit(invocation.pid, 50)), true);
    }).pipe(Effect.scoped),
  );
});

it.effect("reports a deleted worktree's scan as finished, not pending", () =>
  Effect.gen(function* () {
    const snapshot = yield* probeClaudeWorkspaceSnapshot(
      yield* Schema.decodeEffect(ClaudeSettings)({}),
      { skills: [], slashCommands: [] } as unknown as ServerProvider,
      "/nonexistent/t3-deleted-worktree",
      { HOME: "/nonexistent/t3-home" },
    );
    assert.strictEqual(snapshot.slashCommandsPending, false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
