// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterAll, describe, expect, it } from "vite-plus/test";

import {
  SEARCH_GUARD_TIMEOUT_SECONDS,
  buildSearchGuardExtensionSource,
  ensurePiSearchGuardExtension,
} from "./searchGuardExtension.ts";

type Handler = (event: Record<string, unknown>, ctx: { cwd: string }) => unknown;

interface LoadedGuard {
  readonly toolCall: Handler;
  readonly toolResult: Handler;
  readonly analyseBashCommand: (
    command: string,
    worktree: string,
  ) => { verdict: string; root?: string; searchy?: boolean };
}

const tmpDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-guard-test-"));
let counter = 0;

// The emitted module resolves its ladder copy from T3_WORKSTREAM_ENDPOINT at
// import time (the `consult_thread` rung exists only in workstream sessions),
// so the loader pins the env across the dynamic import. Each load writes a
// fresh file → fresh module, so per-test variants do not bleed.
const loadGuard = async (workstream = true): Promise<LoadedGuard> => {
  const file = NodePath.join(tmpDir, `guard-${counter++}.mjs`);
  NodeFS.writeFileSync(file, buildSearchGuardExtensionSource(), "utf8");
  const previous = process.env.T3_WORKSTREAM_ENDPOINT;
  if (workstream) process.env.T3_WORKSTREAM_ENDPOINT = "http://127.0.0.1:9000";
  else delete process.env.T3_WORKSTREAM_ENDPOINT;
  let mod;
  try {
    mod = await import(NodeURL.pathToFileURL(file).href);
  } finally {
    if (previous === undefined) delete process.env.T3_WORKSTREAM_ENDPOINT;
    else process.env.T3_WORKSTREAM_ENDPOINT = previous;
  }
  const handlers = new Map<string, Handler>();
  mod.default({
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  });
  return {
    toolCall: handlers.get("tool_call")!,
    toolResult: handlers.get("tool_result")!,
    analyseBashCommand: mod.analyseBashCommand,
  };
};

// A worktree path shaped like production: cockpit root > project > worktree.
const WORKTREE = "/home/u/.t3/cockpit/worktrees/loom/t3code-abc";
const ctx = { cwd: WORKTREE };

const bashCall = (command: string, extra?: Record<string, unknown>) => ({
  toolName: "bash",
  toolCallId: `tc-${counter++}`,
  input: { command, ...extra },
});

afterAll(() => {
  NodeFS.rmSync(tmpDir, { recursive: true, force: true });
});

describe("search-guard analysis", () => {
  it("blocks an unbounded find over a foreign worktree (the motivating incident)", async () => {
    const guard = await loadGuard();
    const foreign = "/home/u/.roo/worktrees/PE-1593/data-pipeline-jobs";
    const result = guard.toolCall(
      bashCall(
        `cd ${foreign} && find . -name "mdx-review-blocks-spec.md" -not -path "*/node_modules/*"`,
      ),
      ctx,
    ) as { block?: boolean; reason?: string };
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain(foreign);
    expect(result?.reason).toContain("consult_thread");
    expect(result?.reason).toContain("brief paths are authoritative");
  });

  it("blocks unbounded find over vast roots: /, $HOME, worktree ancestors", async () => {
    const guard = await loadGuard();
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

  it("blocks recursive grep -r outside the worktree, including via cd", async () => {
    const guard = await loadGuard();
    const blocked = guard.toolCall(bashCall(`grep -r "needle" /home/u/other-repo`), ctx) as {
      block?: boolean;
    };
    expect(blocked?.block).toBe(true);
    const viaCd = guard.toolCall(bashCall(`cd .. && grep -rn "needle" .`), ctx) as {
      block?: boolean;
    };
    expect(viaCd?.block).toBe(true);
  });

  it("allows bounded searches of foreign trees (-maxdepth, timeout prefix)", async () => {
    const guard = await loadGuard();
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

  it("honours explicit bounds as the escape hatch: never blocked, never re-bounded", async () => {
    const guard = await loadGuard();
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

  it("never auto-bounds pipelines that write files", async () => {
    const guard = await loadGuard();
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

  it("does not mistake non-root operands or redirection targets for search roots", async () => {
    const guard = await loadGuard();
    for (const command of [
      `find . -newer /home/u/foreign/reference -name x.md`,
      `find . -name "*.ts" > /tmp/inventory.txt`,
    ]) {
      const result = guard.toolCall(bashCall(command), ctx) as { block?: boolean } | undefined;
      expect(result?.block, `should allow: ${command}`).toBeUndefined();
    }
  });

  it("sees through wrappers and subshells (env/nice prefixes, $(), parens)", async () => {
    const guard = await loadGuard();
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

  it("allows rg over a foreign worktree (gitignore-aware) but blocks rg over vast roots", async () => {
    const guard = await loadGuard();
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

  it("allows normal in-worktree searches untouched by the block layer", async () => {
    const guard = await loadGuard();
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

  it("auto-bounds pure search pipelines with the default timeout", async () => {
    const guard = await loadGuard();
    const event = bashCall(`find . -name "*.md" | head -20`);
    guard.toolCall(event, ctx);
    expect((event.input as { timeout?: number }).timeout).toBe(SEARCH_GUARD_TIMEOUT_SECONDS);
  });

  it("never overrides an explicit timeout and never bounds non-search commands", async () => {
    const guard = await loadGuard();
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

  it("appends the teaching hint only to guard-injected timeouts", async () => {
    const guard = await loadGuard();
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
    expect(result.content.map((c) => c.text).join("\n")).toContain("consult_thread");
    // A timeout the guard did not inject (explicit model choice) is untouched.
    const explicit = bashCall(`sleep 999`, { timeout: 1 });
    guard.toolCall(explicit, ctx);
    const untouched = guard.toolResult(
      { ...timedOut, toolCallId: explicit.toolCallId, input: explicit.input },
      ctx,
    );
    expect(untouched).toBeUndefined();
  });

  it("omits the consult_thread rung outside workstream sessions", async () => {
    const guard = await loadGuard(false);
    const result = guard.toolCall(bashCall(`find ${NodeOS.homedir()} -name x.md`), ctx) as {
      block?: boolean;
      reason?: string;
    };
    expect(result?.block).toBe(true);
    expect(result?.reason).not.toContain("consult_thread");
    expect(result?.reason).toContain("brief paths are authoritative");
  });

  it("guards the built-in grep/find tools' path argument", async () => {
    const guard = await loadGuard();
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

  it("degrades to allow on malformed input instead of throwing", async () => {
    const guard = await loadGuard();
    expect(guard.toolCall({ toolName: "bash", toolCallId: "b1", input: {} }, ctx)).toBeUndefined();
    expect(
      guard.toolCall({ toolName: "bash", toolCallId: "b2", input: { command: 42 } }, ctx),
    ).toBeUndefined();
    expect(guard.toolResult({ toolName: "bash", toolCallId: "nope" }, ctx)).toBeUndefined();
  });
});

describe("ensurePiSearchGuardExtension", () => {
  it("writes the extension file into the state dir", () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pi-guard-state-"));
    const path = ensurePiSearchGuardExtension(stateDir);
    expect(NodeFS.existsSync(path)).toBe(true);
    expect(NodeFS.readFileSync(path, "utf8")).toContain("t3 search guard");
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
  });
});
