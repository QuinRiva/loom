import { describe, expect, it } from "vite-plus/test";

import { buildPiRpcArgs } from "./RpcProcess.ts";

describe("buildPiRpcArgs", () => {
  // `--tools` is the consult fork's read-only SANDBOX (pi filters its tool
  // registries by it at launch), never a role profile — role profiles are an
  // active-set selection carried in T3_ACTIVE_TOOLS, so dormant families stay
  // registered and enable_toolset can activate them.
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

  // Thread fork: the driver's first-launch guard passes `forkFrom` (the source
  // session), which must serialise to `--fork <src>` BEFORE the child's own
  // `--session-id` — pi forks the source into the fresh id.
  it("emits --fork <source> before --session-id when forkFrom is set", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "child-session",
      forkFrom: "/abs/sessions/proj/2026_source-session.jsonl",
    });
    const forkIdx = args.indexOf("--fork");
    const sessionIdx = args.indexOf("--session-id");
    expect(forkIdx).toBeGreaterThanOrEqual(0);
    expect(args[forkIdx + 1]).toBe("/abs/sessions/proj/2026_source-session.jsonl");
    expect(sessionIdx).toBeGreaterThan(forkIdx);
  });

  // Every non-first launch (resume) omits forkFrom, so no `--fork` is emitted
  // and pi create-or-resumes the child's own session file normally.
  it("omits --fork when forkFrom is not set", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      sessionId: "child-session",
    });
    expect(args).not.toContain("--fork");
  });

  // Post-completion engagement (plan §4.2) — CAPABILITY: resume never spawns a
  // same-id sibling session. A resume names the EXISTING session file by path
  // (`--session <file>`) with the canonical cwd pinned (`--cwd <dir>`), and must
  // NOT re-declare `--session-id` — launching `--session-id` from a relocated cwd
  // silently creates an empty same-id session (the amnesia mode, plan fact 2).
  it("resumes by --session <file> --cwd <dir> and never emits --session-id", () => {
    const args = buildPiRpcArgs({
      binaryPath: "pi-test-binary",
      platform: "linux",
      // A resume carries BOTH the deterministic id (for reference) and the
      // resolved file path; the file path wins.
      sessionId: "thread-session",
      sessionFilePath: "/abs/sessions/proj/2026_thread-session.jsonl",
      cwdOverride: "/abs/parent-worktree",
    });
    const sessionIdx = args.indexOf("--session");
    expect(sessionIdx).toBeGreaterThanOrEqual(0);
    expect(args[sessionIdx + 1]).toBe("/abs/sessions/proj/2026_thread-session.jsonl");
    const cwdIdx = args.indexOf("--cwd");
    expect(cwdIdx).toBeGreaterThanOrEqual(0);
    expect(args[cwdIdx + 1]).toBe("/abs/parent-worktree");
    // The silent-amnesia guard: no `--session-id` on a resume.
    expect(args).not.toContain("--session-id");
  });
});
