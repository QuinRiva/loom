// @effect-diagnostics nodeBuiltinImport:off
// Loom's two extension parts (plan track 3c, seam 3), each built exactly as 3a's assembler
// wraps it — `(pi, ctx) => { <source> }` — and driven through a stub pi. The search-guard
// cases are quarantine's searchGuardExtension.test.ts, unchanged but for the loader.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import type { LoomExtensionPart } from "../loomExtension.ts";
import { promptDebugPart } from "./promptDebug.ts";
import { SEARCH_GUARD_TIMEOUT_SECONDS, searchGuardPart } from "./searchGuard.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

const CONSULT = "mcp__t3-code__consult_thread";

/** Runs a part's body against a stub pi and `ctx`, returning the handlers it registered. */
const loadPart = (
  part: LoomExtensionPart,
  ctx: Record<string, unknown> = {},
  tools: ReadonlyArray<string> = [],
) => {
  const handlers = new Map<string, Handler>();
  const pi = {
    on: (event: string, handler: Handler) => handlers.set(event, handler),
    getAllTools: () => tools.map((name) => ({ name })),
  };
  new Function("pi", "ctx", part.source)(pi, ctx);
  return handlers;
};

let counter = 0;

// A Loom thread's session has the consult tool; a plain pi session does not.
const loadGuard = (workstream = true) => {
  const handlers = loadPart(searchGuardPart, {}, workstream ? [CONSULT] : []);
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

  it("omits the consult_thread rung outside workstream sessions", () => {
    const guard = loadGuard(false);
    const result = guard.toolCall(bashCall(`find ${NodeOS.homedir()} -name x.md`), ctx) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toContain(CONSULT);
    expect(result?.reason).toContain("brief paths are authoritative");
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
  /** Fires session_start and one agent start; resolves once the capture has run. */
  const start = async (profile: () => Promise<unknown>) => {
    const handlers = loadPart(promptDebugPart, { profile });
    handlers.get("session_start")?.({}, { cwd: "/w" });
    expect(handlers.get("before_agent_start")!(agentStart, { cwd: "/w" })).toBeUndefined();
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
    expect(NodeFS.readFileSync(NodePath.join(tmpDir, "thread.prompt.first.md"), "utf8")).toBe(
      written,
    );
    // The profile is read once per session.
    handlers.get("before_agent_start")!({ ...agentStart, prompt: "Again." }, { cwd: "/w" });
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
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetches).toBe(2);
    expect(NodeFS.readdirSync(tmpDir).length).toBe(before);
  });
});
