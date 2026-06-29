import { describe, expect, it } from "vite-plus/test";

import { buildPiRpcArgs } from "../provider/Layers/Pi/RpcProcess.ts";
import { envWithoutWorkstream, readonlyForkTools } from "./workstreamAsk.ts";

// The consult read-only guarantee is structural: the fork is launched with
// no workstream extension and no `T3_WORKSTREAM_*` env, and with a read-only tool
// surface. These cover the two invariants that don't need a live pi process.
describe("consult_thread read-only invariants", () => {
  it("strips every T3_WORKSTREAM_* key from the fork env, keeping the rest", () => {
    const stripped = envWithoutWorkstream({
      PATH: "/usr/bin",
      T3_WORKSTREAM_SPAWN_URL: "http://x/spawn",
      T3_WORKSTREAM_CONSULT_THREAD_URL: "http://x/consult",
      T3_WORKSTREAM_AUTHORIZATION: "Bearer secret",
      HOME: "/home/u",
    });
    expect(stripped).toEqual({ PATH: "/usr/bin", HOME: "/home/u" });
    expect(Object.keys(stripped).some((key) => key.startsWith("T3_WORKSTREAM_"))).toBe(false);
  });

  it("builds a read-only fork invocation: --fork + read-only --tools, and NO extension", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      forkFrom: "target-session-id",
      sessionId: "fresh-fork-id",
      tools: readonlyForkTools(),
      appendSystemPrompt: "read-only oracle",
      // No `extensions` — the fork cannot load the workstream MCP tools.
    });
    expect(args).toContain("--mode");
    expect(args).toContain("rpc");
    expect(args).toEqual(expect.arrayContaining(["--fork", "target-session-id"]));
    expect(args).toEqual(expect.arrayContaining(["--session-id", "fresh-fork-id"]));
    expect(args).toEqual(expect.arrayContaining(["--tools", "read,grep,find,ls"]));
    expect(args).not.toContain("--extension");
  });

  it("read-only tools are exactly read,grep,find,ls (no bash/edit/write)", () => {
    expect(readonlyForkTools()).toEqual(["read", "grep", "find", "ls"]);
  });
});
