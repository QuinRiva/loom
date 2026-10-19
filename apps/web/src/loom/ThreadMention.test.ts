import { describe, expect, it } from "vite-plus/test";

import { loomPreviewThreads as T } from "../preview/loomFixtures";
import { threadMentionStatus } from "./ThreadMention";

const index = new Map(Object.values(T).map((thread) => [thread.id, thread] as const));
const idle = { activityRunStatus: null, status: "idle" } as const;

describe("threadMentionStatus", () => {
  it.each([
    ["a started child", T.inProgress, "in_progress"],
    ["a child behind an unfinished sibling", T.blocked, "blocked"],
    ["a briefed child free to start", T.ready, "ready"],
    ["an unbriefed child free to start", T.briefNeeded, "brief-needed"],
    ["a yielded child", T.quiescent, "awaiting_orchestrator"],
    ["a child waiting on an approval", T.awaitingApproval, "awaiting_approval"],
    ["a child waiting on a question", T.awaitingInput, "awaiting_input"],
    ["a done child", T.done, "done"],
    ["a cancelled child", T.cancelled, "cancelled"],
    ["a root with a running turn", T.root, "running"],
    // deriveBoardColumn would call this root "in progress" forever.
    ["a started root gone quiet", { ...T.root, ...idle }, null],
    ["a staged root", T.held, "held"],
    ["a root flagged for guidance", T.needsGuidance, "needs_guidance"],
    ["a plain root", { ...T.root, ...idle, workstream: undefined }, null],
  ])("%s", (_, thread, expected) => {
    expect(threadMentionStatus(thread, index)).toBe(expected);
  });
});
