import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { relocationClause, shouldReprovisionIsolatedChild } from "./ProviderCommandReactor.ts";

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
  it("names the merge commit and instructs re-verification, without read-only framing", () => {
    const clause = relocationClause("abc1234");
    expect(clause).toContain("abc1234");
    expect(clause).toContain("no longer exists");
    expect(clause).toMatch(/re-verify/i);
    expect(clause).not.toMatch(/read-only|cannot edit/i);
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
