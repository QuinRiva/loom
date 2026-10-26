// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - the background-jobs cases run real processes on the wall clock.
// Loom's extension parts (plan track 3c, seam 3), each built exactly as 3a's assembler
// wraps it — `(pi, ctx) => { <source> }` — and driven through a stub pi. The search-guard
// cases are quarantine's searchGuardExtension.test.ts, unchanged but for the loader.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";

import { LOOM_EXTENSION_PARTS, type LoomExtensionPart } from "../loomExtension.ts";
import { backgroundJobsPart } from "./backgroundJobs.ts";
import { cacheWarmingGatePart } from "./cacheWarmingGate.ts";
import { commandGuardsPart } from "./commandGuards.ts";
import { instructionGuardPart } from "./instructionGuard.ts";
import { pgrepSelfMatchPart } from "./pgrepSelfMatch.ts";
import { promptDebugPart } from "./promptDebug.ts";
import { SEARCH_GUARD_TIMEOUT_SECONDS, searchGuardPart } from "./searchGuard.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

const CONSULT = "mcp__t3-code__consult_thread";

/**
 * Runs a part's body against a stub pi and `ctx` (and the assembled module's `loomFetch`, a free
 * variable in the part), returning the handlers it registered.
 */
const loadPart = (
  part: LoomExtensionPart,
  ctx: Record<string, unknown> = {},
  tools: ReadonlyArray<string | { name: string; description: string; parameters: unknown }> = [],
  loomFetch: (...args: ReadonlyArray<unknown>) => Promise<unknown> = () => Promise.resolve(null),
) => {
  const handlers = new Map<string, Handler>();
  const all = tools.map((tool) => (typeof tool === "string" ? { name: tool } : tool));
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => all,
    getActiveTools: () => all.map((tool) => tool.name),
    registerTool: () => undefined,
    sendMessage: () => undefined,
  };
  new Function("pi", "ctx", "loomFetch", part.source)(pi, ctx, loomFetch);
  return handlers;
};

let counter = 0;

// A Loom thread's session has the consult tool and tool_search; a plain pi session neither.
const loadGuard = (workstream = true) => {
  const handlers = loadPart(searchGuardPart, {}, workstream ? [CONSULT, "tool_search"] : []);
  return { toolCall: handlers.get("tool_call")!, toolResult: handlers.get("tool_result")! };
};

// A worktree path shaped like production: cockpit root > project > worktree.
const WORKTREE = "/home/u/.t3/cockpit/worktrees/loom/t3code-abc";
const ctx = { cwd: WORKTREE };

const bashCall = (command: string, extra?: Record<string, unknown>) => ({
  toolName: "bash",
  toolCallId: `tc-${counter++}`,
  input: { command, ...extra },
});

describe("search-guard part", () => {
  it("blocks an unbounded find over a foreign worktree (the motivating incident)", () => {
    const guard = loadGuard();
    const foreign = "/home/u/.roo/worktrees/PE-1593/data-pipeline-jobs";
    const result = guard.toolCall(
      bashCall(
        `cd ${foreign} && find . -name "mdx-review-blocks-spec.md" -not -path "*/node_modules/*"`,
      ),
      ctx,
    ) as { block?: boolean; reason?: string };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(foreign);
    expect(result?.reason).toContain(CONSULT);
    expect(result?.reason).toContain("brief paths are authoritative");
    expect(result?.reason).toContain(
      "(0) if what you are hunting is a tool or a capability (a browser, a simulator, a linter a skill named), it is probably provided: `tool_search` loads loom's tools, and a skill's bundled files resolve against the skill's own directory, not your cwd; (1)",
    );
  });

  it("blocks unbounded find over vast roots: /, $HOME, worktree ancestors", () => {
    const guard = loadGuard();
    for (const root of [
      "/",
      NodeOS.homedir(),
      "/home/u/.t3/cockpit/worktrees", // strict ancestor of the worktree
      "/usr", // depth-1 dir
    ]) {
      const result = guard.toolCall(bashCall(`find ${root} -name x.md`), ctx) as {
        block?: boolean;
      };
      expect(result?.block, `should block find over ${root}`).toBe(true);
    }
  });

  it("blocks recursive grep -r outside the worktree, including via cd", () => {
    const guard = loadGuard();
    const blocked = guard.toolCall(bashCall(`grep -r "needle" /home/u/other-repo`), ctx) as {
      block?: boolean;
    };
    expect(blocked?.block).toBe(true);
    const viaCd = guard.toolCall(bashCall(`cd .. && grep -rn "needle" .`), ctx) as {
      block?: boolean;
    };
    expect(viaCd?.block).toBe(true);
  });

  it("allows bounded searches of foreign trees (-maxdepth, timeout prefix)", () => {
    const guard = loadGuard();
    for (const command of [
      `find /home/u/other-repo -maxdepth 3 -name x.md`,
      `timeout 120 find /home/u/other-repo -name x.md`,
      `cd /home/u/other-repo && find . -maxdepth 2 -name x.md`,
      `rg --max-depth=2 needle /home/u/other-repo`,
      `fd -d3 needle /home/u/other-repo`,
    ]) {
      const result = guard.toolCall(bashCall(command), ctx) as { block?: boolean } | undefined;
      expect(result?.block, `should allow: ${command}`).toBeUndefined();
    }
  });

  it("honours explicit bounds as the escape hatch: never blocked, never re-bounded", () => {
    const guard = loadGuard();
    // Explicit tool-level timeout on a foreign unbounded find: allowed as-is.
    const explicitTool = bashCall(`find /home/u/other-repo -name x.md`, { timeout: 120 });
    expect(guard.toolCall(explicitTool, ctx)).toBeUndefined();
    expect((explicitTool.input as { timeout?: number }).timeout).toBe(120);
    // timeout-prefix and depth-bounded walkers: no auto-timeout injected.
    for (const command of [
      `timeout 120 find . -name x.md`,
      `find . -maxdepth 3 -name x.md`,
      `rg --max-depth=2 needle .`,
    ]) {
      const event = bashCall(command);
      guard.toolCall(event, ctx);
      expect(
        (event.input as { timeout?: number }).timeout,
        `should not re-bound: ${command}`,
      ).toBeUndefined();
    }
  });

  it("never auto-bounds pipelines that write files", () => {
    const guard = loadGuard();
    for (const command of [
      `find . -name "*.ts" > inventory.txt`,
      `find . | sort -o inventory.txt`,
      `find . | sort -oinventory.txt`,
      `find . -fprint inventory.txt`,
      `find . -name "*.ts" >> log.txt`,
    ]) {
      const event = bashCall(command);
      guard.toolCall(event, ctx);
      expect(
        (event.input as { timeout?: number }).timeout,
        `should not bound: ${command}`,
      ).toBeUndefined();
    }
    // /dev/null and stderr-dup redirections stay bounded (still pure reads).
    const devNull = bashCall(`find . -name "*.ts" 2>/dev/null | head`);
    guard.toolCall(devNull, ctx);
    expect((devNull.input as { timeout?: number }).timeout).toBe(SEARCH_GUARD_TIMEOUT_SECONDS);
  });

  it("does not mistake non-root operands or redirection targets for search roots", () => {
    const guard = loadGuard();
    for (const command of [
      `find . -newer /home/u/foreign/reference -name x.md`,
      `find . -name "*.ts" > /tmp/inventory.txt`,
    ]) {
      const result = guard.toolCall(bashCall(command), ctx) as { block?: boolean } | undefined;
      expect(result?.block, `should allow: ${command}`).toBeUndefined();
    }
  });

  it("sees through wrappers and subshells (env/nice prefixes, $(), parens)", () => {
    const guard = loadGuard();
    const home = NodeOS.homedir();
    for (const command of [
      `env LC_ALL=C find ${home} -name x.md`,
      `nice -n 10 find ${home} -name x.md`,
      `sudo -u nobody find ${home} -name x.md`,
      `env -u HOME find ${home} -name x.md`,
      `stdbuf -o L find ${home} -name x.md`,
      `files=$(find ${home} -name x.md)`,
      `(cd /home/u/foreign && find . -name x.md)`,
    ]) {
      const result = guard.toolCall(bashCall(command), ctx) as { block?: boolean };
      expect(result?.block, `should block: ${command}`).toBe(true);
    }
  });

  it("allows rg over a foreign worktree (gitignore-aware) but blocks rg over vast roots", () => {
    const guard = loadGuard();
    const foreignOk = guard.toolCall(
      bashCall(`rg "needle" /home/u/.roo/worktrees/PE-1593`),
      ctx,
    ) as { block?: boolean } | undefined;
    expect(foreignOk?.block).toBeUndefined();
    const vast = guard.toolCall(bashCall(`rg "needle" ${NodeOS.homedir()}`), ctx) as {
      block?: boolean;
    };
    expect(vast?.block).toBe(true);
  });

  it("allows normal in-worktree searches untouched by the block layer", () => {
    const guard = loadGuard();
    for (const command of [
      `find . -name "*.ts"`,
      `grep -rn "needle" apps/server/src`,
      `rg "needle" .`,
      `ls -la && find apps -name "*.test.ts" | head`,
    ]) {
      const result = guard.toolCall(bashCall(command), ctx) as { block?: boolean } | undefined;
      expect(result?.block, `should allow: ${command}`).toBeUndefined();
    }
  });

  it("auto-bounds pure search pipelines with the default timeout", () => {
    const guard = loadGuard();
    const event = bashCall(`find . -name "*.md" | head -20`);
    guard.toolCall(event, ctx);
    expect((event.input as { timeout?: number }).timeout).toBe(SEARCH_GUARD_TIMEOUT_SECONDS);
  });

  it("never overrides an explicit timeout and never bounds non-search commands", () => {
    const guard = loadGuard();
    const explicit = bashCall(`find . -name "*.md"`, { timeout: 600 });
    guard.toolCall(explicit, ctx);
    expect((explicit.input as { timeout?: number }).timeout).toBe(600);
    for (const command of [
      `pnpm install`,
      `vp run typecheck`,
      `find . -name "*.log" -delete`,
      `find . -name "*.ts" -exec wc -l {} +`,
      `grep -rn "needle" src && pnpm test`,
    ]) {
      const event = bashCall(command);
      guard.toolCall(event, ctx);
      expect(
        (event.input as { timeout?: number }).timeout,
        `should not bound: ${command}`,
      ).toBeUndefined();
    }
  });

  it("appends the teaching hint only to guard-injected timeouts", () => {
    const guard = loadGuard();
    const event = bashCall(`find . -name "*.md"`);
    guard.toolCall(event, ctx);
    const timedOut = {
      toolName: "bash",
      toolCallId: event.toolCallId,
      input: event.input,
      isError: true,
      content: [{ type: "text", text: "partial\n\nCommand timed out after 30 seconds" }],
    };
    const result = guard.toolResult(timedOut, ctx) as {
      content: Array<{ text: string }>;
    };
    expect(result.content.map((c) => c.text).join("\n")).toContain(CONSULT);
    // A timeout the guard did not inject (explicit model choice) is untouched.
    const explicit = bashCall(`sleep 999`, { timeout: 1 });
    guard.toolCall(explicit, ctx);
    const untouched = guard.toolResult(
      { ...timedOut, toolCallId: explicit.toolCallId, input: explicit.input },
      ctx,
    );
    expect(untouched).toBeUndefined();
  });

  it("omits the mcp__t3-code__consult_thread rung outside workstream sessions", () => {
    const guard = loadGuard(false);
    const result = guard.toolCall(bashCall(`find ${NodeOS.homedir()} -name x.md`), ctx) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toContain(CONSULT);
    expect(result?.reason).not.toContain("tool_search");
    expect(result?.reason).toContain("it is probably provided: a skill's bundled files resolve");
  });

  it("lets an explicitly bounded search over a vast root run, then appends the ladder", () => {
    const guard = loadGuard();
    const resultOf = (event: ReturnType<typeof bashCall>) =>
      guard.toolResult(
        {
          toolName: "bash",
          toolCallId: event.toolCallId,
          content: [{ type: "text", text: "out" }],
        },
        ctx,
      ) as { content: Array<{ text: string }> } | undefined;
    // 26 Oct: a planner hunting a skill's linter, escaping the guard with its own timeout.
    const planner = bashCall(
      `wc -l /home/Carl/.pi/agent/skills/mdx-doc-core/references/*.md; ls /home/Carl/.pi/agent/skills/mdx-doc-core/; find / -name lint-plan.mjs -path "*apps/web/scripts*" 2>/dev/null | head -3`,
      { timeout: 60 },
    );
    expect(guard.toolCall(planner, ctx)).toBeUndefined();
    expect((planner.input as { timeout?: number }).timeout).toBe(60);
    const note = resultOf(planner)!.content[1]!.text;
    expect(note).toMatch(
      /^\n\n\[t3 search guard\] Your bound let this search walk \/\. When a file/,
    );
    expect(note).toContain("`tool_search` loads loom's tools");
    expect(note).toContain(CONSULT);
    expect(note).not.toContain("bound it explicitly");
    for (const command of [
      `timeout 90 find ${NodeOS.homedir()} -name x`,
      `find / -maxdepth 6 -path '*node_modules/playwright/package.json' 2>/dev/null | head -3`,
    ]) {
      const event = bashCall(command);
      expect(guard.toolCall(event, ctx), command).toBeUndefined();
      expect(resultOf(event)?.content[1]?.text, command).toContain(
        "Your bound let this search walk",
      );
    }
    // Bounded searches of ordinary trees, and in-worktree ones, hear nothing.
    for (const command of [
      `ls ~/.n/lib/node_modules; ls ~/.cache/ms-playwright/; find ~/.n/lib/node_modules -maxdepth 3 -name "playwright*" -type d 2>/dev/null | head`,
      `find /home/u/other-repo -maxdepth 3 -name x.md`,
      `timeout 120 find . -name x.md`,
    ]) {
      const event = bashCall(command);
      guard.toolCall(event, ctx);
      expect(resultOf(event), command).toBeUndefined();
    }
    const explicitForeign = bashCall(`find /home/u/other-repo -name x.md`, { timeout: 120 });
    guard.toolCall(explicitForeign, ctx);
    expect(resultOf(explicitForeign)).toBeUndefined();
  });

  it("guards the built-in grep/find tools' path argument", () => {
    const guard = loadGuard();
    const blocked = guard.toolCall(
      { toolName: "find", toolCallId: "f1", input: { pattern: "*.md", path: NodeOS.homedir() } },
      ctx,
    ) as { block?: boolean };
    expect(blocked?.block).toBe(true);
    const allowed = guard.toolCall(
      { toolName: "grep", toolCallId: "g1", input: { pattern: "x", path: "apps/server" } },
      ctx,
    );
    expect(allowed).toBeUndefined();
  });

  it("degrades to allow on malformed input instead of throwing", () => {
    const guard = loadGuard();
    expect(guard.toolCall({ toolName: "bash", toolCallId: "b1", input: {} }, ctx)).toBeUndefined();
    expect(
      guard.toolCall({ toolName: "bash", toolCallId: "b2", input: { command: 42 } }, ctx),
    ).toBeUndefined();
    expect(guard.toolResult({ toolName: "bash", toolCallId: "nope" }, ctx)).toBeUndefined();
  });
});

describe("pgrep-self-match part", () => {
  const rewrite = (command: string) => {
    const call = bashCall(command);
    expect(loadPart(pgrepSelfMatchPart).get("tool_call")!(call, ctx)).toBeUndefined();
    return (call.input as { command: string }).command;
  };
  // As pi runs it: `bash -c` with the shellCommandPrefix line, so bash never execs away.
  const runAsPi = (command: string) =>
    NodeChildProcess.spawnSync("bash", ["-c", `export LOOM_PREFIX=1\n${command}`], {
      encoding: "utf8",
    });

  it("stops pgrep -f matching the tool shell that runs it", () => {
    const marker = `loom-pgrep-self-match-${process.pid}`;
    const command = `while pgrep -f "${marker} loop" >/dev/null; do exit 9; done; pgrep -f ${marker} || echo none`;

    expect(runAsPi(command).status).toBe(9);
    const rewritten = rewrite(command);
    expect(rewritten).not.toContain(marker);
    const result = runAsPi(rewritten);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("none");
  });

  it("leaves commands without pgrep/pkill untouched", () => {
    for (const command of ["ls -la", "grep -r pgreps src", "echo pkilled"]) {
      expect(rewrite(command)).toBe(command);
    }
  });
});

describe("command guards then pgrep rewrite, as assembled", () => {
  // pi's emitToolCall: every extension tool_call handler in registration order, on one shared
  // event, stopping at the first block.
  const toolCall = (command: string) => {
    const event = bashCall(command);
    for (const part of LOOM_EXTENSION_PARTS.filter((p) => p.source.includes(`pi.on("tool_call"`))) {
      const result = loadPart(part).get("tool_call")?.(event, ctx) as
        | { block?: boolean; reason?: string }
        | undefined;
      if (result?.block) return { reason: result.reason, command: event.input.command };
    }
    return { reason: undefined, command: event.input.command };
  };

  it("blocks pkill by pattern before the rewrite can hide it", () => {
    const out = toolCall("pkill -f marker; echo done");
    expect(out.reason).toMatch(/^Blocked by the t3 command guard: killing by pattern/);
    expect(out.reason).toContain("can kill another thread's process on this shared machine");
  });

  it("lets a self-matching pgrep through and rewrites it so it no longer matches its shell", () => {
    const marker = `loom-pgrep-assembled-${process.pid}`;
    const out = toolCall(
      `while pgrep -f "${marker} loop" >/dev/null; do exit 9; done; pgrep -f ${marker} || echo none`,
    );
    expect(out.reason).toBeUndefined();
    expect(out.command).not.toContain(marker);
    const result = NodeChildProcess.spawnSync(
      "bash",
      ["-c", `export LOOM_PREFIX=1\n${out.command}`],
      {
        encoding: "utf8",
      },
    );
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("none");
  });

  it("passes bracket-pattern pgrep and pkill by parent PID", () => {
    for (const command of [`pgrep -af '[v]ite'`, `pkill -P 123`]) {
      expect(toolCall(command).reason, command).toBeUndefined();
    }
  });
});

describe("prompt-debug part", () => {
  const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-prompt-debug-test-"));
  afterAll(() => NodeFS.rmSync(tmpDir, { recursive: true, force: true }));
  const agentStart = {
    prompt: "Do the thing.",
    systemPrompt: "SYSTEM ~~~~ PROMPT",
    systemPromptOptions: {
      cwd: "/w",
      appendSystemPrompt: "You are a coder.",
      selectedTools: ["read"],
    },
  };
  const declared = [
    {
      name: "mcp__t3-code__workstream_stop",
      description: "Interrupt a direct child's active turn.",
      parameters: {
        type: "object",
        properties: {
          threadId: { type: "string", description: "The direct child's id." },
          nodes: {
            type: "array",
            items: {
              type: "object",
              properties: { key: { type: "string", description: "Symbolic key." } },
            },
          },
        },
      },
    },
  ];
  /** Fires session_start and one agent start; resolves once the capture has run. */
  const start = async (profile: () => Promise<unknown>) => {
    const handlers = loadPart(promptDebugPart, { profile }, declared);
    handlers.get("session_start")?.({}, { cwd: "/w" });
    expect(handlers.get("before_agent_start")!(agentStart, { cwd: "/w" })).toBeUndefined();
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a macrotask boundary for the fire-and-forget capture, not a wait for time
    await new Promise((resolve) => setImmediate(resolve));
    return handlers;
  };

  it("writes the latest and the write-once first capture to the profile's path", async () => {
    const path = NodePath.join(tmpDir, "thread.prompt.md");
    let fetches = 0;
    const handlers = await start(async () => {
      fetches += 1;
      return { promptDebugPath: path };
    });
    const written = NodeFS.readFileSync(path, "utf8");
    expect(written).toContain("# Effective prompt");
    expect(written).toContain("You are a coder.");
    expect(written).toContain("SYSTEM ~~~~ PROMPT");
    // The declared tools array: name, description and every parameter description, counted.
    expect(written).toContain(
      "### `mcp__t3-code__workstream_stop`: 6 description + 6 parameter words",
    );
    expect(written).toContain("- `threadId`: The direct child's id.");
    expect(written).toContain("- `nodes.[].key`: Symbolic key.");
    expect(written).toContain("Total: 6 description + 6 parameter words = 12 across 1 tools.");
    expect(NodeFS.readFileSync(NodePath.join(tmpDir, "thread.prompt.first.md"), "utf8")).toBe(
      written,
    );
    // The profile is read once per session.
    handlers.get("before_agent_start")!({ ...agentStart, prompt: "Again." }, { cwd: "/w" });
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a macrotask boundary for the fire-and-forget capture, not a wait for time
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toBe(1);
    expect(NodeFS.readFileSync(path, "utf8")).toContain("Again.");
    expect(NodeFS.readFileSync(NodePath.join(tmpDir, "thread.prompt.first.md"), "utf8")).toBe(
      written,
    );
  });

  it("does nothing when the profile has no path, and re-reads after a failed fetch", async () => {
    const before = NodeFS.readdirSync(tmpDir).length;
    await start(async () => ({ promptDebugPath: null }));
    let fetches = 0;
    const handlers = await start(async () => {
      fetches += 1;
      throw new Error("profile unavailable");
    });
    handlers.get("before_agent_start")!(agentStart, { cwd: "/w" });
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a macrotask boundary for the fire-and-forget capture, not a wait for time
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toBe(2);
    expect(NodeFS.readdirSync(tmpDir).length).toBe(before);
  });
});

describe("cacheWarmingGate part", () => {
  const SUBMIT = "mcp__t3-code__workstream_submit";
  // pi's decision payload: continuationProbability 0.15 once the run has settled, 1 during it.
  const idle = { type: "cache_warming_decision", continuationProbability: 0.15, action: "warm" };
  const streaming = { ...idle, continuationProbability: 1 };
  // The part reads PI_CACHE_RETENTION once, at load; pin it so the ambient env cannot leak in.
  // Its plan reports go to a recording `loomFetch`; the gate keep-alive check answers `gate`.
  const load = (
    retention = "short",
    gate: () => Promise<unknown> = () => Promise.resolve({ keepAlive: false }),
  ) => {
    const ambient = process.env.PI_CACHE_RETENTION;
    process.env.PI_CACHE_RETENTION = retention;
    const reports: Array<unknown> = [];
    const handlers = loadPart(cacheWarmingGatePart, {}, [], (_ctx, method, path, body) => {
      if (path === "/gate-keep-alive") {
        expect(method).toBe("GET");
        return gate();
      }
      reports.push([method, path, body]);
      return Promise.resolve(null);
    });
    if (ambient === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = ambient;
    return {
      /** The plans reported so far, in order; drained by each read. */
      reported: () =>
        reports.splice(0).map((report) => {
          const [method, path, body] = report as [string, string, { warming: unknown }];
          expect([method, path]).toEqual(["POST", "/cache-warming"]);
          return body.warming;
        }),
      decide: (event: Record<string, unknown>) =>
        handlers.get("cache_warming_decision")!(event, ctx),
      settle: () => handlers.get("agent_settled")!({ type: "agent_settled" }, ctx),
      submit: (isError: boolean) =>
        handlers.get("tool_result")!({ toolName: SUBMIT, toolCallId: "s1", isError }, ctx),
      input: () => handlers.get("input")!({ type: "input", text: "again", source: "rpc" }, ctx),
      tool: (toolName: string) =>
        handlers.get("tool_result")!({ toolName, toolCallId: "t1", isError: false }, ctx),
    };
  };

  it("reports the plan at settle: undecided, scheduled for a 1-hour root, stopped after a submit", async () => {
    const short = load("short");
    await short.settle();
    short.submit(false);
    await short.settle();
    short.input();
    await short.settle();
    expect(short.reported()).toEqual([null, "stopped", null]);
    const long = load("long");
    await long.settle();
    long.submit(false);
    await long.settle();
    expect(long.reported()).toEqual(["scheduled", "stopped"]);
  });

  it("reports each idle decision's final action and never an in-run one", async () => {
    const short = load("short");
    await short.decide(streaming);
    expect(short.reported()).toEqual([]);
    await short.decide(idle);
    await short.decide({ ...idle, action: "stop" });
    expect(short.reported()).toEqual(["scheduled", "stopped"]);
    const long = load("long");
    await long.decide({ ...idle, action: "stop" });
    long.submit(false);
    await long.decide(idle);
    expect(long.reported()).toEqual(["scheduled", "stopped"]);
  });

  it("swallows a failed report", async () => {
    const handlers = loadPart(cacheWarmingGatePart, {}, [], () =>
      Promise.reject(new Error("down")),
    );
    await handlers.get("agent_settled")!({ type: "agent_settled" }, ctx);
    expect(await handlers.get("cache_warming_decision")!(idle, ctx)).toBeUndefined();
  });

  it("stops idle warming after a successful submit, and leaves streaming refreshes alone", async () => {
    const gate = load();
    expect(gate.submit(false)).toBeUndefined();
    expect(await gate.decide(idle)).toEqual({ action: "stop" });
    expect(await gate.decide(streaming)).toBeUndefined();
  });

  it("does not interfere before a submit, after a failed one, or after other tools succeed", async () => {
    const gate = load();
    expect(await gate.decide(idle)).toBeUndefined();
    gate.submit(true);
    expect(await gate.decide(idle)).toBeUndefined();
    const other = load();
    other.tool("bash");
    expect(await other.decide(idle)).toBeUndefined();
  });

  it("lets a re-opened thread warm again until it submits again", async () => {
    const gate = load();
    gate.submit(false);
    expect(gate.input()).toBeUndefined();
    expect(await gate.decide(idle)).toBeUndefined();
    gate.submit(false);
    expect(await gate.decide(idle)).toEqual({ action: "stop" });
  });

  it("warms a 1-hour root's idle refresh and leaves its in-run refreshes to pi", async () => {
    const gate = load("long");
    expect(await gate.decide({ ...idle, action: "stop" })).toEqual({ action: "warm" });
    expect(await gate.decide(streaming)).toBeUndefined();
  });

  it("leaves a 5-minute thread's idle refresh to pi's economics", async () => {
    const gate = load("short");
    expect(await gate.decide({ ...idle, action: "stop" })).toBeUndefined();
    expect(await gate.decide(idle)).toBeUndefined();
  });

  it("lets a submit stop idle warming even on a 1-hour thread", async () => {
    const gate = load("long");
    gate.submit(false);
    expect(await gate.decide(idle)).toEqual({ action: "stop" });
  });

  it("keeps a submitted gate member warm while Loom confirms a live counterpart", async () => {
    const gate = load("short", () =>
      Promise.resolve({ keepAlive: true, counterpartThreadId: "r" }),
    );
    gate.submit(false);
    await gate.settle();
    expect(await gate.decide({ ...idle, action: "stop" })).toEqual({ action: "warm" });
    expect(await gate.decide(idle)).toBeUndefined();
    expect(gate.reported()).toEqual(["scheduled", "scheduled", "scheduled"]);
  });

  it("stops a submitted thread when the gate check says no or fails", async () => {
    for (const answer of [
      () => Promise.resolve({ keepAlive: false, counterpartThreadId: null }),
      () => Promise.reject(new Error("down")),
    ]) {
      const gate = load("long", answer);
      gate.submit(false);
      await gate.settle();
      expect(await gate.decide(idle)).toEqual({ action: "stop" });
      expect(gate.reported()).toEqual(["stopped", "stopped"]);
    }
  });
});

describe("command-guards part", () => {
  const HTML_PREVIEW = "mcp__t3-code__html_preview";
  /** Runs one bash call through the guard: the block reason, the command as run, and the note. */
  const run = (command: string, tools = [HTML_PREVIEW]) => {
    const handlers = loadPart(commandGuardsPart, {}, tools);
    const event = bashCall(command);
    const result = handlers.get("tool_call")!(event, ctx) as
      | { block: boolean; reason: string }
      | undefined;
    const after = handlers.get("tool_result")!(
      { toolName: "bash", toolCallId: event.toolCallId, content: [{ type: "text", text: "out" }] },
      ctx,
    ) as { content: Array<{ text: string }> } | undefined;
    return {
      reason: result?.reason,
      command: (event.input as { command: string }).command,
      note: after?.content
        .slice(1)
        .map((c) => c.text)
        .join(""),
    };
  };
  const untouched = (command: string) => {
    const out = run(command);
    expect(out, command).toEqual({ reason: undefined, command, note: undefined });
  };

  it("drops the stray r from rg -rn style flags and says why", () => {
    for (const [before, after] of [
      [`rg -rn "needle" src`, `rg -n "needle" src`],
      [`rg -rN needle`, `rg -N needle`],
      [`cd apps && rg -rni needle | head`, `cd apps && rg -ni needle | head`],
      [`rg -nr "needle" .`, `rg -n "needle" .`],
      [`rg -r -n needle`, `rg  -n needle`],
    ]) {
      const out = run(before!);
      expect(out.command, before).toBe(after);
      expect(out.note, before).toContain("`-r` means `--replace <TEXT>`");
    }
  });

  it("leaves real rg replacements and non-rg -r alone", () => {
    for (const command of [
      `rg -r 'replacement' pattern`,
      `rg -r '$1' 'foo(\\w+)' src`,
      `rg --replace=n pattern`,
      `rg -n -- -rn`,
      `grep -rn needle src`,
      `rg -n needle src`,
    ]) {
      untouched(command);
    }
  });

  it("blocks killing by pattern", () => {
    for (const command of [
      `pkill -f vite`,
      `pkill node`,
      `pgrep -f vite | xargs kill`,
      `kill $(pgrep -f "vite --port 5173")`,
      `sleep 1; kill -9 \`pgrep node\``,
      `kill "$(pgrep -f vite)"`,
    ]) {
      expect(run(command).reason, command).toContain("killing by pattern");
    }
  });

  // The guard reads pi's group from /proc/self/stat; the stub runs it in this process, so the
  // test reads the same file rather than assuming the runner's group.
  const stat = NodeFS.readFileSync("/proc/self/stat", "utf8");
  const ownGroup = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);

  it("blocks signalling pi's own process group, or a group it cannot rule out", () => {
    for (const command of [
      `kill -- -${ownGroup}`,
      `kill -TERM -${ownGroup}`,
      `kill -9 -- -${ownGroup}`,
      `kill -s TERM -${ownGroup}`,
      `sudo /bin/kill -KILL -- -${ownGroup}`,
      `kill -TERM -- -$(ps -o pgid= -p 2455179)`,
      `kill -- -"$(ps -o pgid= -p 42 | tr -d ' ')"`,
      `PGID=$(ps -o pgid= -p 42); kill -TERM -$PGID`,
      `kill -- "-$pgid"`,
      `kill -- -0`,
      `kill -TERM -1`,
    ]) {
      const reason = run(command).reason;
      expect(reason, command).toContain("this signals a whole process group");
      expect(reason, command).toContain("`kill -TERM -- -<pgid>`");
    }
  });

  it("lets a literal process group through when it is not pi's", () => {
    for (const command of [`kill -TERM -- -${ownGroup + 1}`, `kill -9 -${ownGroup + 1}`]) {
      untouched(command);
    }
  });

  it("allows a signal option before a plain PID", () => {
    for (const command of [
      `kill -9 123`,
      `kill -TERM 123`,
      `kill -s TERM 123`,
      `kill -- 123`,
      `kill -TERM "$pid"`,
      `kill -l`,
      `pkill -TERM -P 123; kill 123`,
      `echo "never kill -- -123"`,
      `kill -TERM $(ps -eo pid=,pgid= | awk -v g="$PGID" '$2 == g { print $1 }')`,
    ]) {
      untouched(command);
    }
  });

  it("allows pgrep on its own and pkill by PID or pidfile", () => {
    for (const command of [
      `while pgrep -f "vite build"; do sleep 1; done`,
      `pgrep -f vite`,
      `pgrep -af '[v]ite'`,
      `pgrep -x node`,
      `pgrep -fx "node server.js"`,
      `pgrep -f '[v]ite build'`,
      `pgrep node`,
      `kill -0 "$pid"`,
      `kill 12345`,
      `pkill -P $$`,
      `pkill -F /tmp/server.pid`,
    ]) {
      untouched(command);
    }
  });

  it("blocks gh api field flags without an explicit method", () => {
    for (const command of [
      `gh api repos/o/r/pulls -f state=open`,
      `gh api repos/o/r/issues/1 -F labels[]=bug`,
      `gh api repos/o/r/pulls --raw-field state=open --jq '.[].number'`,
    ]) {
      const reason = run(command).reason;
      expect(reason, command).toContain("sends a POST");
      expect(reason, command).toContain("`-X GET`");
    }
    expect(run(`gh api repos/o/r/pulls -f state=open`).reason).toContain("`repos/o/r/pulls`");
  });

  it("allows gh api reads, explicit methods and graphql", () => {
    for (const command of [
      `gh api -X GET repos/o/r/pulls -f state=open`,
      `gh api --method POST repos/o/r/issues -f title=x`,
      `gh api repos/o/r/pulls --jq '.[].number'`,
      `gh api graphql -f query='{ viewer { login } }'`,
      `gh pr list -L 5`,
    ]) {
      untouched(command);
    }
  });

  it("quotes an unquoted heredoc delimiter whose body has backticks", () => {
    const out = run("cat <<EOF > msg.md\nRun `vp check` before shipping.\nEOF\ncurl -d @msg.md x");
    expect(out.command).toBe(
      "cat <<'EOF' > msg.md\nRun `vp check` before shipping.\nEOF\ncurl -d @msg.md x",
    );
    expect(out.note).toContain("(`<<EOF` became `<<'EOF'`)");
    const dash = run("cat <<-END\n\tuse `rg`\n\tEND");
    expect(dash.command).toBe("cat <<-'END'\n\tuse `rg`\n\tEND");
  });

  it("only warns when the heredoc body also expands variables or uses bare $(", () => {
    for (const command of [
      "cat <<EOF\nHello $USER, see `docs`\nEOF",
      "cat <<EOF > stamp\nBuilt at $(date)\nEOF",
      "cat <<EOF\nCommit: $(git rev-parse HEAD)\nUse `foo` here\nEOF",
      "cat <<EOF\nCost \\$5, run `x`\nEOF",
    ]) {
      const out = run(command);
      expect(out.command, command).toBe(command);
      expect(out.reason, command).toBeUndefined();
      expect(out.note, command).toContain("ran as command substitution");
    }
  });

  it("leaves quoted, plain and escaped heredocs alone and never lexes their bodies", () => {
    for (const command of [
      "cat <<'EOF'\nRun `vp check`.\nEOF",
      'cat <<"EOF"\nRun `vp check`.\nEOF',
      "cat <<EOF\nplain $HOME text\nEOF",
      "cat <<EOF\nescaped \\`tick\\`\nEOF",
      "cat <<'EOF'\npkill -f vite and rg -rn x\nEOF",
      `gh pr create --body "Never run pkill -f or rg -rn"`,
      `python3 -c "print(1 << 2)"`,
      "cat > s.sh <<'OUTER'\ncat <<EOF\nnow `date`\nEOF\nOUTER",
      `echo "pgrep x | xargs kill"`,
      `git commit -m 'never kill $(pgrep vite)'`,
    ]) {
      untouched(command);
    }
  });

  it("blocks a bash sleep of 60 s or more with the command and its length", () => {
    expect(run("sleep 600").reason).toBe(
      "Blocked by the t3 command guard: `sleep 600` would hold this turn for 10 min, cannot end early if what you are waiting for finishes, and shows nothing if it does not. To wait for a process, start it with bg_start and wait with bg_wait, which returns the moment the job exits or with its progress at your timeout. To wait for the clock, bg_start `sleep 600` and bg_wait on it. Sleeps under 60 s are not blocked.",
    );
    for (const [command, sleep, minutes] of [
      ["sleep 60", "sleep 60", "1 min"],
      ["sleep 2m && tail -5 out.log", "sleep 2m", "2 min"],
      ["timeout 1800 sleep 900", "sleep 900", "15 min"],
      ["sleep 1m 30", "sleep 1m 30", "1.5 min"],
      // A backgrounded sibling does not background the foreground sleep.
      ["sleep 600; foo &", "sleep 600", "10 min"],
    ]) {
      expect(run(command!).reason, command).toContain(
        `\`${sleep}\` would hold this turn for ${minutes},`,
      );
    }
  });

  it("passes short, variable, quoted and heredoc-body sleeps", () => {
    for (const command of [
      "sleep 30",
      "sleep $N",
      `ssh h "sleep 90"`,
      "cat <<'EOF' > wait.sh\nsleep 300\nEOF",
      "for i in 1 2 3; do sleep 20; done",
      "timeout 1800 tail --pid=123 -f /dev/null",
      // Backgrounded: the turn does not wait on these.
      "sleep 600 &",
      "(sleep 120; kill $PID) &",
    ]) {
      untouched(command);
    }
  });

  const BROWSER_NOTE =
    '[t3 command guard] Loom provides a headless browser: `html_preview` renders an HTML document to a screenshot with its console output and `preview_*` drives a live tab at any URL, both loaded with `tool_search` (query "browser screenshot"); if you need a browser of your own, carry on.';

  it("notes loom's browser, without blocking, when a command installs, launches or hunts one", () => {
    for (const command of [
      // 26 Oct: a coder hunting for a browser, an install, a figure render.
      `which chromium chromium-browser google-chrome 2>/dev/null; ls ~/.cache/ms-playwright 2>/dev/null | head`,
      `ls ~/.n/lib/node_modules; ls ~/.cache/ms-playwright/; find ~/.n/lib/node_modules -maxdepth 3 -name "playwright*" -type d 2>/dev/null | head`,
      `npm i playwright`,
      `cd /tmp/pw && npm install --no-save playwright@1.49 && npx playwright install chromium`,
      `chromium --headless --disable-gpu --no-sandbox --window-size=1500,2300 --screenshot=/tmp/f12_top.png file://$PWD/f12.html`,
      `B=$(command -v chromium || command -v google-chrome); timeout 60 $B --headless=new --screenshot=/tmp/shot.png file:///tmp/x.html`,
      `pnpm exec playwright install chromium`,
      `pip install playwright`,
      `node -e "const { chromium } = require('playwright'); (async () => { const b = await chromium.launch(); })()"`,
    ]) {
      const out = run(command);
      expect(out.reason, command).toBeUndefined();
      expect(out.command, command).toBe(command);
      expect(out.note, command).toBe("\n\n" + BROWSER_NOTE);
    }
  });

  it("notes the browser once per session, only where html_preview exists, and not for ordinary installs", () => {
    for (const command of [
      `npm i`,
      `pnpm add -D vitest`,
      `soffice --headless --convert-to pdf report.docx`,
      `export CHROME=$HOME/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`,
      `git commit -m "npm i playwright in the e2e package"`,
    ]) {
      untouched(command);
    }
    expect(run(`npm i playwright`, []).note).toBeUndefined();
    const handlers = loadPart(commandGuardsPart, {}, [HTML_PREVIEW]);
    const notes = ["npm i puppeteer", "chromium --headless --screenshot=a.png a.html"].map(
      (command) => {
        const event = bashCall(command);
        handlers.get("tool_call")!(event, ctx);
        return handlers.get("tool_result")!(
          { toolName: "bash", toolCallId: event.toolCallId, content: [] },
          ctx,
        );
      },
    );
    expect(notes[0]).toBeDefined();
    expect(notes[1]).toBeUndefined();
  });

  it("degrades to allow on malformed input instead of throwing", () => {
    const handlers = loadPart(commandGuardsPart);
    expect(handlers.get("tool_call")!({ toolName: "bash", input: {} }, ctx)).toBeUndefined();
    expect(
      handlers.get("tool_call")!({ toolName: "read", input: { path: "x" } }, ctx),
    ).toBeUndefined();
    expect(
      handlers.get("tool_result")!({ toolName: "bash", toolCallId: "nope" }, ctx),
    ).toBeUndefined();
  });
});

describe("instruction-guard part", () => {
  const SKILL = "/home/u/skills/llm-instruction-change/SKILL.md";
  const PROMPT = `<skill>\n<name>llm-instruction-change</name>\n<description>Rules.</description>\n<location>${SKILL}</location>\n</skill>`;
  /** One session: each call is a tool result through the guard, returning the appended note. */
  const session = (prompt = PROMPT) => {
    const toolResult = loadPart(instructionGuardPart).get("tool_result")!;
    return (toolName: string, path: string, isError = false) =>
      (
        toolResult(
          {
            toolName,
            toolCallId: `tc-${counter++}`,
            input: { path },
            content: [{ type: "text", text: "ok" }],
            isError,
          },
          { cwd: WORKTREE, getSystemPrompt: () => prompt } as never,
        ) as { content: Array<{ text: string }> } | undefined
      )?.content
        .slice(1)
        .map((c) => c.text)
        .join("");
  };

  it("notes an edit of a model-read file once per file, and never a non-matching one", () => {
    const call = session();
    expect(call("edit", "apps/server/src/loom/prompt/prose.ts")).toBe(
      "\n\n[t3 instruction guard] A model reads `apps/server/src/loom/prompt/prose.ts`, so this edit changes an LLM instruction. The protocol for that is the llm-instruction-change skill at `/home/u/skills/llm-instruction-change/SKILL.md`; an instruction edit ships through a reviewer gate showing its +N/−M word count.",
    );
    expect(call("edit", `${WORKTREE}/apps/server/src/loom/prompt/prose.ts`)).toBeUndefined();
    for (const path of [
      "roles/coder.md",
      ".t3code/roles/orchestrator.md",
      "skills/ship/SKILL.md",
      "~/.pi/agent/AGENTS.md",
      "apps/web/CLAUDE.md",
      "apps/server/src/mcp/toolkits/workstream/defs.ts",
      "apps/server/src/loom/handoff/retroDraft.ts",
      "apps/server/src/loom/goals/goalTaskMarkdown.ts",
    ]) {
      expect(call("write", path), path).toContain("[t3 instruction guard]");
    }
    for (const path of [
      "apps/server/src/loom/prompt/prose.test.ts",
      "apps/server/src/loom/goals/goalTasks.ts",
      "docs/roles.md",
      "skills/ship/references/gotchas.md",
      "README.md",
    ]) {
      expect(call("edit", path), path).toBeUndefined();
    }
    expect(call("read", "roles/reviewer.md")).toBeUndefined();
  });

  it("stays silent after a failed edit, after the skill is read, and where the prompt lists no such skill", () => {
    const call = session();
    expect(call("edit", "AGENTS.md", true)).toBeUndefined();
    expect(call("edit", "AGENTS.md")).toContain("[t3 instruction guard]");
    expect(call("read", SKILL)).toBeUndefined();
    expect(call("edit", "roles/coder.md")).toBeUndefined();
    expect(session("<skill><name>ship</name></skill>")("edit", "AGENTS.md")).toBeUndefined();
  });
});

describe("background-jobs part", () => {
  const SUBMIT = "mcp__t3-code__workstream_submit";
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-bg-jobs-test-"));
  afterAll(() => NodeFS.rmSync(root, { recursive: true, force: true }));
  // Every loaded instance adds a SIGTERM listener at session_start; session_shutdown removes it.
  const shutdowns: Array<() => void> = [];
  afterEach(() => shutdowns.splice(0).forEach((shutdown) => shutdown()));

  interface Sent {
    readonly message: { readonly customType: string; readonly content: string };
    readonly options: { readonly triggerTurn?: boolean; readonly deliverAs?: string };
  }
  type ToolResult = { content: Array<{ text: string }> };

  /** One pi process: the part's body against a stub pi, started on `sessionDir`'s session s1. */
  const load = (sessionDir = NodeFS.mkdtempSync(NodePath.join(root, "session-")), cwd = root) => {
    const handlers = new Map<string, (event: unknown, ext?: unknown) => unknown>();
    const tools = new Map<
      string,
      { execute: (...args: ReadonlyArray<unknown>) => Promise<ToolResult> }
    >();
    const sent: Array<Sent> = [];
    const statuses: Array<{ running: number; wake?: { summary: string; outcome: string } }> = [];
    let onSend = () => {};
    let pending = false;
    const pi = {
      on: (name: string, handler: (event: unknown, ext?: unknown) => unknown) =>
        handlers.set(name, handler),
      registerTool: (tool: { name: string; execute: () => Promise<ToolResult> }) =>
        tools.set(tool.name, tool),
      sendMessage: (message: Sent["message"], options: Sent["options"]) => {
        sent.push({ message, options });
        onSend();
      },
    };
    new Function("pi", "ctx", backgroundJobsPart.source)(pi, {});
    const ext = {
      cwd,
      ui: {
        setStatus: (key: string, text: string) => {
          expect(key).toBe("loom-jobs");
          statuses.push(JSON.parse(text));
        },
      },
      sessionManager: { getSessionDir: () => sessionDir, getSessionId: () => "s1" },
      hasPendingMessages: () => pending,
    };
    handlers.get("session_start")!({ type: "session_start" }, ext);
    const shutdown = () => handlers.get("session_shutdown")!({ type: "session_shutdown" }, ext);
    shutdowns.push(shutdown);
    const textOf = (result: ToolResult) => result.content[0]!.text;
    return {
      sessionDir,
      sent,
      statuses,
      shutdown,
      /** Resolves at the next sendMessage. */
      nextSend: () => new Promise<void>((resolve) => (onSend = resolve)),
      start: async (command: string, minMinutes = 0, maxMinutes = 1) => {
        const text = textOf(
          await tools
            .get("bg_start")!
            .execute(
              "call",
              { command, min_minutes: minMinutes, max_minutes: maxMinutes },
              undefined,
              undefined,
              ext,
            ),
        );
        const [, id, pid] = /^(?:Started|Background) job (j\w{4})(?: \(pid (\d+)\))?/.exec(text)!;
        return { text, id: id!, pid: Number(pid) };
      },
      wait: async (id: string, timeoutSeconds?: number, signal?: AbortSignal) =>
        textOf(
          await tools
            .get("bg_wait")!
            .execute(
              "call",
              { id, ...(timeoutSeconds === undefined ? {} : { timeout_s: timeoutSeconds }) },
              signal,
              undefined,
              ext,
            ),
        ),
      /** A prompt arriving while the turn runs (`streamingBehavior` set) or idle (unset). */
      input: (streamingBehavior?: "steer" | "followUp") =>
        handlers.get("input")!(
          { type: "input", text: "hello", source: "rpc", streamingBehavior },
          ext,
        ),
      /** Whether pi holds a queued message, which it sets once every input handler has resolved. */
      queue: (queued: boolean) => (pending = queued),
      submit: () =>
        handlers.get("tool_call")!({ toolName: SUBMIT, toolCallId: "s", input: {} }) as
          | { block: boolean; reason: string }
          | undefined,
    };
  };
  /** Resolves once `pid` has exited (tail checks it about once a second). */
  const exited = (pid: number) =>
    new Promise((resolve) =>
      NodeChildProcess.spawn("tail", [`--pid=${pid}`, "-f", "/dev/null"]).on("exit", resolve),
    );

  it("bg_wait returns the exit shape with the job's output, and nothing else is sent", async () => {
    const jobs = load();
    const { text, id } = await jobs.start("echo a; sleep 0.3; echo b", 0, 1);
    expect(text).toContain("Expected 0 to 1 min. bg_wait " + id + " returns when it exits;");
    const result = await jobs.wait(id, 30);
    expect(result).toMatch(
      new RegExp(
        `^Background job ${id} finished \\(exit 0\\) after 0 s, inside your 0 to 1 min: \`echo a; sleep 0.3; echo b\`\nLog: .*${id}\\.log \\(2 lines\\)\nLast 2 lines:\na\nb$`,
      ),
    );
    expect(jobs.sent).toEqual([]);
    expect(jobs.statuses.at(-1)).toEqual({ running: 0 });
    expect(await jobs.wait(id, 30)).toBe(result);
  });

  it("a timeout returns progress with growth, refuses a submit, and a later wait returns at exit", async () => {
    const jobs = load();
    const { id, pid } = await jobs.start("echo a; sleep 1; echo b", 0, 1);
    const progress = await jobs.wait(id, 0.4);
    expect(progress).toMatch(
      new RegExp(
        `^Job ${id} still running after 0 s \\(your bounds: 0 to 1 min\\)\\. Log: 1 line, 2 B; \\+1 line, \\+2 B since it started 0 s ago; last write 0 s ago\\.\nLast 1 line:\na$`,
      ),
    );
    const refused = jobs.submit();
    expect(refused?.block).toBe(true);
    expect(refused?.reason).toContain(
      `Refused: background job ${id} (\`echo a; sleep 1; echo b\`) is still running`,
    );
    expect(refused?.reason).toContain(
      `or stop it (\`kill ${pid}\`) and say so, then submit again.`,
    );
    expect(await jobs.wait(id, 30)).toContain(`Background job ${id} finished (exit 0)`);
    expect(jobs.submit()).toBeUndefined();
    expect(jobs.sent).toEqual([]);
  });

  it("a steer ends a wait early with the job untouched, and a later wait returns its exit", async () => {
    const jobs = load();
    const { id } = await jobs.start("echo a; sleep 2; echo b", 0, 1);
    const waiting = jobs.wait(id, 60);
    // An idle prompt or a follow-up is not held behind the wait, so it does not end it.
    jobs.queue(true);
    jobs.input();
    jobs.input("followUp");
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a real subprocess job: proves the wait has not resolved within a short real window
    const held = new Promise((resolve) => setTimeout(resolve, 300, "still waiting"));
    expect(await Promise.race([waiting, held])).toBe("still waiting");
    jobs.queue(false);
    jobs.input("steer");
    // Another extension's input handler may await I/O before pi queues the steer; the result
    // must not reach pi's loop before the steer does, or it would wait for the next batch.
    let queued = false;
    setTimeout(() => (queued = jobs.queue(true)), 100);
    const early = await waiting;
    expect(queued).toBe(true);
    const line = `Returned early because a message arrived for you; it follows this result. The job is untouched: bg_wait ${id} again to keep waiting.`;
    expect(early).toMatch(
      new RegExp(`^Job ${id} still running after 0 s \\(your bounds: 0 to 1 min\\)\\. `),
    );
    expect(early.slice(early.indexOf("\nLast 1 line:"))).toBe(`\nLast 1 line:\na\n${line}`);
    expect(jobs.statuses.at(-1)).toEqual({ running: 1 });
    expect(jobs.submit()?.block).toBe(true);
    // A steer still queued when a wait starts (one sent while you wrote the call) returns it at once.
    expect((await jobs.wait(id, 60)).split("\n").at(-1)).toBe(line);
    jobs.queue(false);
    expect(await jobs.wait(id, 30)).toContain(`Background job ${id} finished (exit 0)`);
    expect(jobs.sent).toEqual([]);
  });

  it("an exit with nobody waiting wakes once, the status line carrying the summary first", async () => {
    const jobs = load();
    const sent = jobs.nextSend();
    const { id } = await jobs.start("echo done; exit 3", 0, 1);
    await sent;
    expect(jobs.sent).toHaveLength(1);
    expect(jobs.sent[0]!.options).toEqual({ triggerTurn: true });
    expect(jobs.sent[0]!.message.customType).toBe("loom-bg-job");
    expect(jobs.sent[0]!.message.content).toContain(`Background job ${id} finished (exit 3)`);
    expect(jobs.statuses).toEqual([
      { running: 0 },
      { running: 1 },
      {
        running: 0,
        wake: { summary: "Background job finished (exit 3): echo done; exit 3", outcome: "failed" },
      },
    ]);
    // A wait after the wake went out points at it instead of delivering the result twice.
    expect(await jobs.wait(id, 30)).toBe(
      `Background job ${id} finished (exit 3) after 0 s, before this call; its exit report was sent to you as a message, which follows this result if you have not seen it yet.`,
    );
    expect(jobs.sent).toHaveLength(1);
  });

  it("an aborted wait leaves the job running, and its exit then wakes", async () => {
    const jobs = load();
    const { id } = await jobs.start("sleep 0.3; echo late", 0, 1);
    const abort = new AbortController();
    const waiting = jobs.wait(id, 30, abort.signal);
    abort.abort();
    await expect(waiting).rejects.toThrow();
    const sent = jobs.nextSend();
    await sent;
    expect(jobs.sent[0]!.message.content).toContain("late");
  });

  it("a job killed with pi is never woken on, and the next session start reports it lost once", async () => {
    const first = load();
    const { id, pid } = await first.start("sleep 30", 10, 30);
    first.shutdown();
    await exited(pid);
    expect(first.sent).toEqual([]);
    const record = JSON.parse(
      NodeFS.readFileSync(NodePath.join(first.sessionDir, "jobs", "s1", `${id}.json`), "utf8"),
    );
    expect(record.exit).toBeNull();

    const second = load(first.sessionDir);
    expect(second.sent).toHaveLength(1);
    expect(second.sent[0]!.options).toEqual({ deliverAs: "nextTurn" });
    expect(second.sent[0]!.message.content).toMatch(
      new RegExp(
        `^Background job ${id} \\(\`sleep 30\`\\) was lost when this thread's pi process ended at \\d\\d:\\d\\d, 0 s into your 10 to 30 min; it was not restarted\\. Its log stops at .*${id}\\.log\\.\nThe log is empty\\.$`,
      ),
    );
    expect(await second.wait(id)).toBe(second.sent[0]!.message.content);
    expect(second.submit()).toBeUndefined();
    expect(load(first.sessionDir).sent).toEqual([]);
  });

  it("reports a job that cannot start as its result, without crashing or waking", async () => {
    const jobs = load(undefined, NodePath.join(root, "no-such-dir"));
    const { text, id } = await jobs.start("echo never", 0, 1);
    expect(text).toMatch(
      new RegExp(
        `^Background job ${id} could not start \\(spawn bash ENOENT\\) after 0 s, inside your 0 to 1 min: \`echo never\`\nLog: .*\\(0 lines\\)\nThe log is empty\\.$`,
      ),
    );
    expect(await jobs.wait(id, 1)).toBe(text);
    expect(jobs.sent).toEqual([]);
    expect(jobs.statuses.at(-1)).toEqual({ running: 0 });
    expect(jobs.submit()).toBeUndefined();
  });

  it("refuses an unknown id", async () => {
    await expect(load().wait("jzzzz", 1)).rejects.toThrow("No job jzzzz in this session.");
  });
});
