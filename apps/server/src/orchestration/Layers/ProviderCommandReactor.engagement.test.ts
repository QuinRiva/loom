import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isDiscussLaunch, shouldReprovisionIsolatedChild } from "./ProviderCommandReactor.ts";

/**
 * Post-completion sub-thread engagement — Phase 1 capability tests for the two
 * durable-state decisions that make "a human opens a completed, fanned-in
 * sub-thread and talks to it" work, extracted as pure functions so the
 * capability is provable without spinning the whole provider harness.
 *
 * The remaining Phase 1 capabilities are covered where their mechanism actually
 * lives:
 *  - "resume never spawns a same-id sibling session" and "Discuss cannot write"
 *    → `Pi/RpcProcess.test.ts` (the launched argv: `--session <file> --cwd`, no
 *    `--session-id`; read-only `--tools`, no `--extension`), plus the installed-
 *    binary contract test `Pi/PiCwdOverride.contract.test.ts`;
 *  - "conversing does not notify the orchestrator" → `WorkstreamDispatcher.test.ts`
 *    (`terminalEpisodeKey`/`childReportedCommandId` are unchanged by a Discuss
 *    turn, so the delta-rail wake never re-arms).
 */
describe("post-completion engagement — Discuss-launch decision (isDiscussLaunch)", () => {
  // CAPABILITY: a human can converse with a fanned-in child — read-only.
  it("routes a terminal thread that has run (session file present) to a read-only Discuss launch", () => {
    expect(isDiscussLaunch({ planLane: "done", sessionFileExists: true })).toBe(true);
    expect(isDiscussLaunch({ planLane: "cancelled", sessionFileExists: true })).toBe(true);
  });

  it("does NOT Discuss a terminal thread that never ran (no session file)", () => {
    // A terminal-but-never-run thread is not a completed interlocutor; it takes
    // the normal path (and, if genuinely never provisioned, is provisioned).
    expect(isDiscussLaunch({ planLane: "done", sessionFileExists: false })).toBe(false);
    expect(isDiscussLaunch({ planLane: "cancelled", sessionFileExists: false })).toBe(false);
  });

  it("gives a non-terminal thread the normal full launch even when it has a session file", () => {
    // Guards the mode split: session-file existence alone must NOT force Discuss —
    // only a terminal lane does. A running/paused child resumes writable.
    expect(isDiscussLaunch({ planLane: "in_progress", sessionFileExists: true })).toBe(false);
    expect(isDiscussLaunch({ planLane: "ready", sessionFileExists: true })).toBe(false);
    expect(isDiscussLaunch({ planLane: "planned", sessionFileExists: true })).toBe(false);
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
