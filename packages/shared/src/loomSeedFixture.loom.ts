/**
 * The Loom dev fixture's identity and control cards, shared by the dev seed
 * (`apps/server/src/dev/seedWorkstream.ts`, which writes them through real
 * commands) and the web preview fixtures (`apps/web/src/preview/loomFixtures.ts`,
 * which render them without a backend) so both show the same payloads.
 *
 * @module loomSeedFixture.loom
 */
import {
  type ControlPayload,
  GoalId,
  type LoomControlNoticeKind,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export const LOOM_SEED = {
  projectId: ProjectId.make("seed-project-0000"),
  goalId: GoalId.make("seed-goal-0000"),
  threads: {
    root: ThreadId.make("seed-thread-orchestrator"),
    coderDone: ThreadId.make("seed-thread-coder-done"),
    gateCoder: ThreadId.make("seed-thread-gate-coder"),
    gateReviewer: ThreadId.make("seed-thread-gate-reviewer"),
    quiescent: ThreadId.make("seed-thread-quiescent"),
    blocked: ThreadId.make("seed-thread-blocked"),
    unbriefed: ThreadId.make("seed-thread-unbriefed"),
    cancelledLead: ThreadId.make("seed-thread-cancelled-lead"),
    cancelledGrandchild: ThreadId.make("seed-thread-cancelled-grandchild"),
    needsGuidanceRoot: ThreadId.make("seed-thread-needs-guidance-root"),
    stagedRoot: ThreadId.make("seed-thread-staged-root"),
  },
} as const;

export interface LoomSeedControlMessage {
  /** Stable key: `digest`, `yield`, or `notice-<kind>`. */
  readonly key: string;
  /** The exact text the model would receive. */
  readonly text: string;
  readonly payload: ControlPayload;
}

const PREAMBLE = "[T3 Workstream control plane — automated notice, not from the user]";

/**
 * One digest (every item kind), one synthesised yield and one notice per
 * notice kind (seam 6), addressed to the fixture's root.
 */
export const loomSeedControlMessages = (reports: {
  readonly coderDone: string;
  readonly gateReviewer: string;
  readonly quiescent: string;
}): ReadonlyArray<LoomSeedControlMessage> => {
  const t = LOOM_SEED.threads;
  const notice = (
    kind: LoomControlNoticeKind,
    heading: string,
    items: ControlPayload["items"],
  ): LoomSeedControlMessage => ({
    key: `notice-${kind}`,
    text: `${PREAMBLE}\n\n${heading}`,
    payload: { kind: "notice", notice: kind, heading, items },
  });
  const digestHeading = "FYI digest — nothing below is blocked on you.";
  return [
    {
      key: "digest",
      text: `${PREAMBLE}\n\n${digestHeading}`,
      payload: {
        kind: "digest",
        heading: digestHeading,
        items: [
          {
            kind: "terminal",
            threadId: t.coderDone,
            role: "coder",
            title: "Completed",
            status: "done",
            reportPath: reports.coderDone,
            excerpt: "# Config loader\nImplemented the loader module and wired it into startup.",
          },
          {
            kind: "gate-resolved",
            threadId: t.gateReviewer,
            role: "reviewer",
            title: "Gate resolved (clean)",
            status: "clean",
            reportPath: reports.gateReviewer,
          },
          { kind: "recovered", threadId: t.gateCoder, title: "Recovered after a server restart" },
          {
            kind: "slow-tool",
            threadId: t.cancelledGrandchild,
            title: "A tool call has run for 6 minutes",
            excerpt: "pnpm bench --filter parser",
          },
          {
            kind: "spinning",
            threadId: t.cancelledLead,
            title: "Activity without progress for 15 minutes",
          },
          { kind: "dead-episode", threadId: t.blocked, title: "A wake could not be delivered" },
        ],
      },
    },
    {
      key: "yield",
      text: `${PREAMBLE}\n\n${t.quiescent} went quiet; its report was synthesised.`,
      payload: {
        kind: "yield",
        synthesised: true,
        heading: "Went quiet; report synthesised",
        items: [
          {
            threadId: t.quiescent,
            role: "researcher",
            title: "Survey checkpoint refs",
            status: "quiescent",
            reportPath: reports.quiescent,
            excerpt: "Checkpoint refs live under `refs/t3/checkpoints/<thread>/turn/<n>`.",
          },
        ],
      },
    },
    notice("gate-rework", "Review gate: rework requested (round 1)", [
      {
        threadId: t.gateReviewer,
        role: "reviewer",
        title: "Round 1",
        reportPath: reports.gateReviewer,
      },
    ]),
    notice("gate-reverify", "Review gate: re-verify (round 1)", [
      { threadId: t.gateCoder, role: "coder", title: "Round 1" },
    ]),
    notice("brief-needed", "A child is waiting for its brief", [
      { threadId: t.unbriefed, role: "coder", title: "Wire the loader into the CLI" },
    ]),
    notice("deadlock", "Your children cannot make progress", [
      { threadId: t.blocked, role: "coder", title: "Waits on a quiet sibling" },
    ]),
    notice("stall-nudge", "No activity for 10 minutes — are you stuck?", [
      { threadId: t.gateCoder, title: "Heartbeat frozen" },
    ]),
    notice("attention", "A child needs guidance", [
      { threadId: t.gateCoder, role: "coder", title: "needs_guidance", status: "needs_guidance" },
    ]),
    notice("notify", "Message from a sibling via notify_thread", [
      {
        threadId: t.gateReviewer,
        role: "reviewer",
        title: "The loader contract changed under me",
        excerpt: "`load()` now returns `{ ready: boolean }`; three call sites need a pass.",
      },
    ]),
  ];
};
