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

import { emptyWorkstream } from "../../../loom/projection/LoomStore.ts";
import {
  appendWarnings,
  boundedExcerpt,
  formatReportExcerpt,
  renderConsultCandidates,
  renderSubmitOutcome,
  renderWorkstreamList,
  REPORT_EXCERPT_LIMIT,
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

describe("report excerpts", () => {
  it("trims to 400 characters with a truncation note", () => {
    const long = "x".repeat(REPORT_EXCERPT_LIMIT + 50);
    expect(REPORT_EXCERPT_LIMIT).toBe(400);
    expect(boundedExcerpt(long)).toBe(`${"x".repeat(400)}…`);
    expect(formatReportExcerpt(long)).toContain("_[excerpt truncated");
    expect(formatReportExcerpt("  short  ")).toBe("\n\nshort");
    expect(formatReportExcerpt(null)).toBe("");
  });
});

describe("renderWorkstreamList", () => {
  it("renders lineage, the (you) marker, derived status, attention and the detail lines", () => {
    const rendered = renderWorkstreamList({
      callerId: id("root"),
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
        `    last-activity: ${AT}`,
        '  - child [coder] "Do the thing" status=in_progress attention=needs_guidance+awaiting_input',
        `      last-activity: ${AT} — started`,
        "      report: /reports/child.md",
        "      session: /sessions/child.jsonl",
        '  - dep [reviewer] "(untitled)" status=blocked',
        `      last-activity: ${AT}`,
        "      waits-on: child",
      ].join("\n"),
    );
  });

  it("derives held, needs_brief, ready and terminal statuses, keys, purpose and anchors", () => {
    const rendered = renderWorkstreamList({
      callerId: id("root"),
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

  it("renders the model-selection block with invalid markers and profile tags", () => {
    const rendered = renderWorkstreamList({
      callerId: id("root"),
      threads: [root],
      modelPresets: [
        { name: "coder", instanceId: "pi", model: "a", valid: true },
        { name: "stale", instanceId: "gone", model: "x", valid: false },
      ],
      taskShapes: ["explore"],
      modelProfiles: [
        { name: "Fable", agentic: "full", usableContext: 200000, valid: true, spawnable: true },
        { name: "Dead Oracle", agentic: "oracle", valid: false, spawnable: false },
      ],
    });
    expect(rendered).toContain("Model selection (for spawning children):");
    expect(rendered).toContain('    - "explore" — open-ended/prototype work');
    expect(rendered).toContain('    - "coder" → pi / a\n');
    expect(rendered).toContain(
      '    - "stale" → gone / x [INVALID — points at an unconfigured instance/model; do not use]',
    );
    expect(rendered).toContain('    - "Fable" [full] usableContext=200000');
    expect(rendered).toContain(
      '    - "Dead Oracle" [oracle — not spawnable; consultation only] [INVALID — points at an unconfigured instance/model; do not use]',
    );
    expect(
      renderWorkstreamList({ callerId: id("root"), threads: [root], taskShapes: ["explore"] }),
    ).toContain("  presets: none configured");
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
        "Multiple threads match that name. Confirm which one with the user, then call mcp__t3-code__consult_thread again with its threadId:",
        "- A — coder, ready [/w/a] (threadId: t1)",
        "- (untitled) — thread, unknown (threadId: t2)",
      ].join("\n"),
    );
    expect(renderConsultCandidates([])).toBe("No matching thread was found.");
  });
});
