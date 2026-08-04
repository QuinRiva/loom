import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  relocationClause,
  shouldReprovisionIsolatedChild,
  threadIdentityClause,
} from "./ProviderCommandReactor.ts";

/**
 * Post-completion sub-thread engagement — capability tests for the durable-state
 * decisions that make "a human opens a completed, fanned-in sub-thread and talks
 * to it" work, extracted as pure functions so the capability is provable without
 * spinning the whole provider harness.
 *
 * There is no read-only engagement mode: EVERY thread, terminal or not, resumes
 * with its full launch (role overlay, goal context, ship policy, skills, full
 * tools, workstream extension). The remaining capabilities are covered where
 * their mechanism lives:
 *  - "resume never spawns a same-id sibling session" and "a terminal resume is a
 *    full launch" → `Pi/RpcProcess.test.ts` (the launched argv: `--session
 *    <file> --cwd`, no `--session-id`, no restrictive `--tools`, the workstream
 *    `--extension` present), plus the installed-binary contract test
 *    `Pi/PiCwdOverride.contract.test.ts`;
 *  - "a re-submit after done reports as news" → `WorkstreamDispatcher.test.ts`
 *    (`terminalEpisodeKey` prefers the newest outcome id).
 */
describe("post-completion engagement — relocation clause (relocationClause)", () => {
  // CAPABILITY: a relocated thread is told its remembered paths are historical
  // and instructed to re-verify — care, NOT incapacity (it can still edit).
  it("names the destination cwd and the merge commit, and instructs re-verification", () => {
    const clause = relocationClause({
      finalCommitSha: "abc1234",
      cwd: "/tmp/parent-worktree",
    });
    // The concrete replacement location, not just "the tree you are in" — the
    // thread must not have to rediscover where it now is.
    expect(clause).toContain("/tmp/parent-worktree");
    expect(clause).toContain("abc1234");
    expect(clause).toContain("no longer exists");
    expect(clause).toMatch(/re-verify/i);
    // Care, not incapacity: the thread resumes with its full tool surface.
    expect(clause).not.toMatch(/read-only|cannot edit/i);
  });
});

describe("thread identity clause (threadIdentityClause)", () => {
  const threadId = ThreadId.make("a1b2c3d4-0000-4000-8000-000000000001");

  // CAPABILITY: a thread knows who and where it is without running commands —
  // its id, its workspace, and how to find its own transcript on disk.
  it("names the thread id, the workspace cwd, and how to reach the session jsonl", () => {
    const clause = threadIdentityClause({ threadId, cwd: "/tmp/child-worktree" });
    expect(clause).toContain(threadId);
    expect(clause).toContain("/tmp/child-worktree");
    expect(clause).toContain("PI_SESSION_FILE");
    expect(clause).toContain(`*_${threadId}.jsonl`);
  });

  // pi's sessions root is CONFIGURABLE (`--session-dir`,
  // `PI_CODING_AGENT_SESSION_DIR`, the `sessionDir` setting, `PI_CODING_AGENT_DIR`)
  // and PiDriver pins none of them, so asserting pi's default root would inject a
  // false path wherever the store is configured. Only the truthful facts are
  // stated: the `$PI_SESSION_FILE` env and the filename convention.
  it("claims no sessions root, only $PI_SESSION_FILE and the filename convention", () => {
    const clause = threadIdentityClause({ threadId, cwd: "/tmp/child-worktree" });
    expect(clause).not.toContain(".pi/agent/sessions");
    expect(clause).not.toContain("~/.pi");
    expect(clause).toContain("$PI_SESSION_FILE");
  });

  // pi scopes session files by project slug (`--<cwd>--`, per
  // `piProjectSessionDir`), so an ISOLATED sibling in its own worktree sits in a
  // different directory (as does this thread's own history after a relocation).
  // The clause must not send an agent hunting a sibling's suffix in its own dir;
  // cross-thread history goes via the report or `consult_thread`.
  it("does not claim another thread's jsonl shares this thread's directory", () => {
    const clause = threadIdentityClause({ threadId, cwd: "/tmp/child-worktree" });
    expect(clause).not.toMatch(/alongside/i);
    expect(clause).toContain("consult_thread");
    expect(clause).toMatch(/not necessarily in the same directory/);
  });

  // The jsonl name is the sanitised thread id (piSessionIdForThread), so a
  // thread id carrying non-id characters still gets a truthful filename glob.
  it("uses the sanitised session id in the file convention", () => {
    const clause = threadIdentityClause({
      threadId: ThreadId.make("server:child/one"),
      cwd: "/tmp/w",
    });
    expect(clause).toContain("*_server-child-one.jsonl");
  });
});

describe("post-completion engagement — turn-start re-provision guard (shouldReprovisionIsolatedChild)", () => {
  const threadId = ThreadId.make("child-fanned-in");

  // CAPABILITY: conversing with a fanned-in child creates NO worktree and
  // re-delivers NO kickoff brief. Fan-in repoints the child's branch to the
  // parent's ("main" here), so the branch-name predicate alone would misread it
  // as never-provisioned and re-provision + re-deliver the brief. Session-file
  // existence is the durable "has provably run" proof that blocks that.
  it("never re-provisions a thread that has provably run (session file present)", () => {
    expect(
      shouldReprovisionIsolatedChild({
        sessionFileExists: true,
        isolation: "isolated",
        branch: "main", // repointed to the parent by fan-in — looks unprovisioned
        threadId,
      }),
    ).toBe(false);
  });

  it("still re-provisions a genuinely never-started isolated child (no session file, parent-pointing branch)", () => {
    // The legitimate purpose of the re-provision path: a child parked at promote
    // (branch still the parent's) that never ran.
    expect(
      shouldReprovisionIsolatedChild({
        sessionFileExists: false,
        isolation: "isolated",
        branch: "main",
        threadId,
      }),
    ).toBe(true);
  });

  it("does not re-provision an already-provisioned child (its own ws/ branch)", () => {
    expect(
      shouldReprovisionIsolatedChild({
        sessionFileExists: false,
        isolation: "isolated",
        branch: "ws/main/coder-child-fa",
        threadId,
      }),
    ).toBe(false);
  });

  it("never re-provisions a shared (non-isolated) thread", () => {
    expect(
      shouldReprovisionIsolatedChild({
        sessionFileExists: false,
        isolation: "shared",
        branch: "main",
        threadId,
      }),
    ).toBe(false);
  });
});
