import { describe, expect, it } from "vite-plus/test";

import { buildPiRpcArgs } from "./RpcProcess.ts";

describe("buildPiRpcArgs", () => {
  it("emits a repeated --skill pair per skill path, after any --tools allowlist", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "thread-session",
      tools: ["read", "grep"],
      skills: ["/abs/skills/mdx-visual-plan", "/abs/skills/other"],
    });
    expect(args).toEqual(
      expect.arrayContaining([
        "--tools",
        "read,grep",
        "--skill",
        "/abs/skills/mdx-visual-plan",
        "--skill",
        "/abs/skills/other",
      ]),
    );
    expect(args.filter((arg) => arg === "--skill")).toHaveLength(2);
  });

  it("omits --skill and --tools entirely when neither option is set", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "thread-session",
    });
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--tools");
  });
});
