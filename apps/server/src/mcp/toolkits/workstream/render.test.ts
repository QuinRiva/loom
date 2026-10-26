import {
  GoalTaskId,
  type LoomThreadShellFields,
  MessageId,
  ProjectId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { formatWakeTimestamp } from "../../../loom/orchestration/dispatcher/wakes.ts";
import { emptyWorkstream } from "../../../loom/projection/LoomStore.ts";
import {
  appendWarnings,
  renderConsultCandidates,
  renderSubmitOutcome,
  renderWorkstreamList,
  type WorkstreamListThread,
} from "./render.ts";

const AT = "2026-10-01T00:00:00.000Z";
const id = ThreadId.make;

const node = (
  threadId: string,
  title: string,
  fields: Partial<LoomThreadShellFields> = {},
  shell: Partial<WorkstreamListThread> = {},
): WorkstreamListThread => {
  const {
    notifySendLog,
    lastRoute,
    outcomeEventId,
    unarchivedEventId,
    unarchivedAt,
    attentionEpisodes,
    ...base
  } = emptyWorkstream({
    threadId: id(threadId),
    projectId: ProjectId.make("p"),
    parentThreadId: null,
    rootThreadId: id("root"),
    at: AT,
  });
  return {
    id: id(threadId),
    title,
    updatedAt: DateTime.makeUnsafe(AT),
    latestVisibleMessage: null,
    pendingRuntimeRequest: null,
    workstream: {
      ...base,
      consults: [],
      peerMessages: [],
      toolCalls: 0,
      contextUsage: null,
      activeStep: null,
      ...fields,
    },
    ...shell,
  };
};

const root = node("root", "Root", { role: "orchestrator", kickoffAt: AT });

describe("appendWarnings", () => {
  it("returns the text unchanged without warnings and appends one line per warning", () => {
    expect(appendWarnings("ok")).toBe("ok");
    expect(appendWarnings("ok", ["a", "b"])).toBe("ok\nWarning: a\nWarning: b");
  });
});

describe("renderWorkstreamList", () => {
  it("renders lineage, the (you) marker, derived status, attention and the detail lines", () => {
    const rendered = renderWorkstreamList({
      callerId: id("root"),
      detail: "full",
      threads: [
        root,
        node(
          "child",
          "Do the thing",
          {
            parentThreadId: id("root"),
            role: "coder",
            kickoffAt: AT,
            attention: ["needs_guidance"],
            reportPath: "/reports/child.md",
          },
          {
            latestVisibleMessage: {
              id: MessageId.make("m"),
              role: "assistant",
              text: "started\nsecond line",
              updatedAt: DateTime.makeUnsafe(AT),
            },
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("r"),
              kind: "user_input",
              createdAt: DateTime.makeUnsafe(AT),
            },
          },
        ),
        node("dep", "", {
          parentThreadId: id("root"),
          role: "reviewer",
          blockedBy: [id("child")],
          kickoffBriefPath: "/briefs/dep.md",
        }),
      ],
      sessionPaths: new Map([[id("child"), "/sessions/child.jsonl"]]),
    });
    expect(rendered).toBe(
      [
        "Workstream: 3 thread(s). Indentation shows lineage (parent above its children).",
        '- root (you) [orchestrator] "Root" status=in_progress',
        `    last-activity: ${formatWakeTimestamp(AT)}`,
        '  - child [coder] "Do the thing" status=in_progress attention=needs_guidance+awaiting_input',
        `      last-activity: ${formatWakeTimestamp(AT)} — started`,
        "      report: /reports/child.md",
        "      session: /sessions/child.jsonl",
        '  - dep [reviewer] "(untitled)" status=blocked',
        `      last-activity: ${formatWakeTimestamp(AT)}`,
        "      waits-on: child",
      ].join("\n"),
    );
  });

  it("derives held, needs_brief, ready and terminal statuses, keys, purpose and anchors", () => {
    const rendered = renderWorkstreamList({
      callerId: id("root"),
      detail: "full",
      threads: [
        root,
        node("held", "Held", { parentThreadId: id("root"), held: true }),
        node("unbriefed", "API", {
          parentThreadId: id("root"),
          graphKey: "api",
          purpose: "Adds the merge endpoint.",
          anchorTaskId: GoalTaskId.make("task-chip"),
        }),
        node("briefed", "Ready", {
          parentThreadId: id("root"),
          kickoffBriefPath: "/b.md",
          anchorTaskId: GoalTaskId.make("task-gone"),
        }),
        node("finished", "Done", { parentThreadId: id("root"), outcome: "done", kickoffAt: AT }),
      ],
      anchorTexts: new Map([[GoalTaskId.make("task-chip"), "Add the cost chip"]]),
    });
    expect(rendered).toContain('  - held [thread] "Held" status=held');
    expect(rendered).toContain('  - unbriefed [thread] "API" key=api status=needs_brief');
    expect(rendered).toContain("      purpose: Adds the merge endpoint.");
    expect(rendered).toContain('      anchor: task-chip "Add the cost chip"');
    expect(rendered).toContain('  - briefed [thread] "Ready" status=ready');
    expect(rendered).toContain("      anchor: task-gone (task no longer in the tree)");
    expect(rendered).toContain('  - finished [thread] "Done" status=done');
  });

  it("marks a synthesised report (seam 8)", () => {
    const rendered = renderWorkstreamList({
      callerId: id("root"),
      threads: [
        root,
        node("quiet", "Quiet", {
          parentThreadId: id("root"),
          kickoffAt: AT,
          reportPath: "/reports/quiet.quiescent-run.md",
          lastOutcome: {
            outcome: "quiescent",
            decision: "yield",
            round: 0,
            synthesised: true,
            eventId: null,
            at: AT,
          },
        }),
      ],
    });
    expect(rendered).toContain(
      "      report: /reports/quiet.quiescent-run.md (went quiet; report synthesised)",
    );
  });

  it("lean by default: no purpose, anchor or session, and a finished thread is its node and report", () => {
    const view = {
      callerId: id("root"),
      threads: [
        root,
        node("live", "Live", {
          parentThreadId: id("root"),
          kickoffAt: AT,
          purpose: "Adds the merge endpoint.",
          anchorTaskId: GoalTaskId.make("task-chip"),
          blockedBy: [id("finished")],
        }),
        node("finished", "Done", {
          parentThreadId: id("root"),
          outcome: "done",
          kickoffAt: AT,
          purpose: "Shipped the chip.",
          reportPath: "/reports/finished.md",
          blockedBy: [id("root")],
        }),
      ],
      sessionPaths: new Map([
        [id("live"), "/sessions/live.jsonl"],
        [id("finished"), "/sessions/finished.jsonl"],
      ]),
      anchorTexts: new Map([[GoalTaskId.make("task-chip"), "Add the cost chip"]]),
    };
    expect(renderWorkstreamList(view)).toBe(
      [
        "Workstream: 3 thread(s). Indentation shows lineage (parent above its children).",
        '- root (you) [orchestrator] "Root" status=in_progress',
        `    last-activity: ${formatWakeTimestamp(AT)}`,
        '  - live [thread] "Live" status=in_progress',
        `      last-activity: ${formatWakeTimestamp(AT)}`,
        "      waits-on: finished",
        '  - finished [thread] "Done" status=done',
        "      report: /reports/finished.md",
      ].join("\n"),
    );
    const full = renderWorkstreamList({ ...view, detail: "full" });
    for (const line of [
      "      purpose: Adds the merge endpoint.",
      '      anchor: task-chip "Add the cost chip"',
      "      session: /sessions/live.jsonl",
      "      purpose: Shipped the chip.",
      "      session: /sessions/finished.jsonl",
      "      waits-on: root",
    ])
      expect(full).toContain(line);
    expect(full).not.toContain("Model selection");
  });
});

describe("renderSubmitOutcome", () => {
  it("echoes every routing decision", () => {
    expect(renderSubmitOutcome({ decision: "terminal", outcome: "done" })).toBe(
      "Work submitted: report recorded, outcome done (dependents released).",
    );
    expect(renderSubmitOutcome({ decision: "attention", outcome: "needs_human" })).toContain(
      "needs_guidance raised",
    );
    expect(renderSubmitOutcome({ decision: "resolve", outcome: "clean" })).toBe(
      "Work submitted with outcome 'clean': the review gate RESOLVED — you and your gate counterpart are both done (dependents released).",
    );
    expect(
      renderSubmitOutcome({ decision: "loop", outcome: "needs_rework", leg: "rework", round: 1 }),
    ).toContain("findings routed to the coder for rework (round 1)");
    expect(
      renderSubmitOutcome({ decision: "loop", outcome: "done", leg: "reverify", round: 2 }),
    ).toContain("routed to the reviewer for re-verification (round 2)");
    expect(renderSubmitOutcome({ decision: "cap-breach", outcome: "needs_rework" })).toContain(
      "round cap is exhausted, so you YIELDED",
    );
    expect(renderSubmitOutcome({ decision: "yield", outcome: "rework_approach" })).toContain(
      "no route matched, so you YIELDED",
    );
  });
});

describe("renderConsultCandidates", () => {
  it("renders the disambiguation list with prefixed tool names, or the empty message", () => {
    expect(
      renderConsultCandidates([
        { threadId: "t1", title: "A", role: "coder", status: "ready", worktreePath: "/w/a" },
        { threadId: "t2" },
      ]),
    ).toBe(
      [
        "Multiple threads match that name. Confirm which one with whoever named it (your parent, via mcp__t3-code__consult_thread, if the name came from your brief), then call mcp__t3-code__consult_thread again with its threadId:",
        "- A — coder, ready [/w/a] (threadId: t1)",
        "- (untitled) — thread, unknown (threadId: t2)",
      ].join("\n"),
    );
    expect(renderConsultCandidates([])).toBe("No matching thread was found.");
  });
});
