// @effect-diagnostics nodeBuiltinImport:off
import { ClaudeSettings } from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  isLegacyClaudeModel,
  probeClaudeCapabilities,
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
    // @effect-diagnostics-next-line globalTimers:off - Wall-clock poll; Effect's Clock is virtualised under `it.effect`.
    await new Promise((resolve) => setTimeout(resolve, 100));
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
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: "1",
    },
    cwd: "/workspace/project",
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(options.env?.FORCE_CODE_TERMINAL, undefined);
  assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
  assert.equal(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, "1");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = path.join(tempDir, "fake-claude.mjs");
      const invocationPath = path.join(tempDir, "invocation.json");
      // The probe aborts the SDK without awaiting the child's exit, and on
      // Windows a directory that is still some process's cwd cannot be
      // removed. Keep the workspace outside the scoped directory and let it
      // go with a retrying removal once the child has gone.
      const workspaceCwd = yield* fs.makeTempDirectory({ prefix: "t3-claude-probe-cwd-" });
      // Node's own retry rather than an Effect schedule: it.effect runs on a
      // TestClock, so a scheduled retry would wait for time nobody advances.
      // If the child still holds the directory after that, an empty temp
      // directory is left behind rather than failing the test for it.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(workspaceCwd, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          }).catch(() => undefined),
        ),
      );

      yield* fs.writeFileString(
        executablePath,
        [
          "#!/usr/bin/env node",
          'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
          'import { createInterface } from "node:readline";',
          "const args = process.argv.slice(2);",
          'const mcpConfigIndex = args.indexOf("--mcp-config");',
          "const rawMcpConfig = mcpConfigIndex >= 0 ? args[mcpConfigIndex + 1] : undefined;",
          "let mcpConfig;",
          "if (rawMcpConfig) {",
          '  const contents = existsSync(rawMcpConfig) ? readFileSync(rawMcpConfig, "utf8") : rawMcpConfig;',
          "  try { mcpConfig = JSON.parse(contents); } catch { mcpConfig = contents; }",
          "}",
          "writeFileSync(process.env.T3_PROBE_INVOCATION_PATH, JSON.stringify({",
          "  args,",
          "  pid: process.pid,",
          "  cwd: process.cwd(),",
          "  connectorEnv: process.env.ENABLE_CLAUDEAI_MCP_SERVERS,",
          "  mcpConfig,",
          "}));",
          "const lines = createInterface({ input: process.stdin });",
          'lines.on("line", (line) => {',
          "  const message = JSON.parse(line);",
          '  if (message.type !== "control_request") return;',
          "  const reply = (response) => process.stdout.write(JSON.stringify({",
          '    type: "control_response",',
          '    response: { subtype: "success", request_id: message.request_id, response },',
          '  }) + "\\n");',
          '  if (message.request?.subtype === "initialize") {',
          "    reply({",
          '      commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],',
          "      agents: [],",
          '      output_style: "default",',
          '      available_output_styles: ["default"],',
          "      models: [],",
          '      account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },',
          "    });",
          "  }",
          "  // The probe follows initialize with get_usage on the same process.",
          '  if (message.request?.subtype === "get_usage") {',
          "    reply({",
          "      session: {},",
          '      subscription_type: "pro",',
          "      rate_limits_available: true,",
          '      rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },',
          "      behaviors: null,",
          "    });",
          "  }",
          "});",
          "setInterval(() => {}, 1_000);",
          "",
        ].join("\n"),
      );
      yield* fs.chmod(executablePath, 0o755);

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
        },
      });

      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly pid: number;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      // The fixture ignores stdin closing and keeps its event loop alive, exactly like a
      // wedged Claude subprocess. Aborting the probe must still terminate it, so wait for
      // the process to actually disappear rather than leaking it into the host.
      assert.equal(yield* Effect.promise(() => awaitProcessExit(invocation.pid)), true);
    }).pipe(Effect.scoped),
  );

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

      // Probe from a child process that exits as soon as the probe resolves. The
      // SDK force-kills an aborted subprocess only on unref'd timers (~7s away),
      // so this reproduces a restart landing mid-probe — routine under
      // `Restart=always` — which would otherwise reparent the child to systemd
      // and leave it counting against the service's memory.
      // Resolved URLs, because the runner lives in a temp dir with no node_modules.
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
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly pid: number;
      };
      assert.equal(yield* Effect.promise(() => awaitProcessExit(invocation.pid, 50)), true);
    }).pipe(Effect.scoped),
  );
});

it.effect("preserves initialized capabilities when optional usage times out", () =>
  Effect.gen(function* () {
    const usageStarted = yield* Deferred.make<void>();
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
      abortSignal = options?.abortController?.signal;
      return {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          Deferred.doneUnsafe(usageStarted, Effect.void);
          return new Promise(() => {});
        },
      } as ReturnType<typeof ClaudeSdk.query>;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(usageStarted);
    yield* TestClock.adjust("4 seconds");
    const capabilities = yield* Fiber.join(probe);
    assert.equal(capabilities?.email, "dev@example.com");
    assert.equal(capabilities?.subscriptionType, "pro");
    assert.equal(capabilities?.tokenSource, "oauth");
    assert.deepEqual(capabilities?.slashCommands, [
      { name: "review", description: "Review changes", input: { hint: "[path]" } },
    ]);
    assert.equal(capabilities?.usage, undefined);
    assert.equal(abortSignal?.aborted, true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
