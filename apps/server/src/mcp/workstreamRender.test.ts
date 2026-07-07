import { describe, expect, it } from "vite-plus/test";

import {
  appendWarnings,
  renderConsultCandidates,
  renderSubmitOutcome,
  renderWorkstreamList,
  type WorkstreamListView,
} from "./workstreamRender.ts";

describe("appendWarnings", () => {
  it("returns the text unchanged when there are no warnings", () => {
    expect(appendWarnings("ok", [])).toBe("ok");
    expect(appendWarnings("ok", undefined)).toBe("ok");
  });

  it("appends one Warning: line per warning", () => {
    expect(appendWarnings("ok", ["a", "b"])).toBe("ok\nWarning: a\nWarning: b");
  });
});

describe("renderWorkstreamList", () => {
  it("renders lineage, the (you) marker, activity/report/session/waits-on lines", () => {
    const view: WorkstreamListView = {
      callerId: "root",
      nodes: [
        {
          id: "root",
          parentThreadId: null,
          role: "orchestrator",
          title: "Root",
          planLane: "in_progress",
          attention: [],
        },
        {
          id: "child",
          parentThreadId: "root",
          role: "coder",
          title: "Do the thing",
          planLane: "ready",
          attention: ["needs_guidance"],
          lastActivityAt: "2026-07-07T00:00:00Z",
          lastActivitySummary: "started",
          reportPath: "/reports/child.md",
          sessionPath: "/sessions/child.jsonl",
        },
        {
          id: "dep",
          parentThreadId: "root",
          role: "reviewer",
          title: null,
          planLane: "planned",
        },
      ],
      waitsOnEdges: [{ from: "dep", to: "child" }],
    };
    expect(renderWorkstreamList(view)).toBe(
      [
        "Workstream: 3 thread(s). Indentation shows lineage (parent above its children).",
        '- root (you) [orchestrator] "Root" lane=in_progress',
        '  - child [coder] "Do the thing" lane=ready attention=needs_guidance',
        "      last-activity: 2026-07-07T00:00:00Z — started",
        "      report: /reports/child.md",
        "      session: /sessions/child.jsonl",
        '  - dep [reviewer] "(untitled)" lane=planned',
        "      waits-on: child",
      ].join("\n"),
    );
  });

  it("renders the model catalogue and presets block with the INVALID marker", () => {
    const view: WorkstreamListView = {
      callerId: "root",
      nodes: [{ id: "root", parentThreadId: null, role: null, title: "R", planLane: "ready" }],
      modelCatalogue: [
        { instanceId: "pi", models: ["a", "b"] },
        { instanceId: "empty", models: [] },
      ],
      modelPresets: [
        { name: "coder", instanceId: "pi", model: "a", valid: true },
        { name: "stale", instanceId: "gone", model: "x", valid: false },
      ],
    };
    expect(renderWorkstreamList(view)).toBe(
      [
        "Workstream: 1 thread(s). Indentation shows lineage (parent above its children).",
        '- root (you) [thread] "R" lane=ready',
        "",
        "Model selection (for spawning children):",
        '  - instance "pi": a, b',
        '  - instance "empty": (catalogue not yet loaded)',
        "  presets (prefer these):",
        '    - "coder" → pi / a',
        '    - "stale" → gone / x [INVALID — points at an unconfigured instance/model; do not use]',
      ].join("\n"),
    );
  });

  it("shows 'presets: none configured' when a catalogue exists but no presets", () => {
    const view: WorkstreamListView = {
      callerId: "root",
      nodes: [{ id: "root", parentThreadId: null, role: null, title: "R", planLane: "ready" }],
      modelCatalogue: [{ instanceId: "pi", models: ["a"] }],
      modelPresets: [],
    };
    expect(renderWorkstreamList(view)).toContain("  presets: none configured");
  });
});

describe("renderSubmitOutcome", () => {
  it("done", () => {
    expect(renderSubmitOutcome({ disposition: "done" })).toBe(
      "Work submitted: report recorded, plan advanced to done (dependents released).",
    );
  });

  it("needs_human", () => {
    expect(renderSubmitOutcome({ disposition: "needs_human" })).toBe(
      "Work submitted: report recorded and needs_guidance raised — a human has been flagged; your lane is unchanged.",
    );
  });

  it("resolved", () => {
    expect(renderSubmitOutcome({ disposition: "resolved", outcome: "clean" })).toBe(
      "Work submitted with outcome 'clean': the review gate RESOLVED — you and your gate counterpart are both done (dependents released).",
    );
  });

  it("routed rework leg", () => {
    expect(
      renderSubmitOutcome({
        disposition: "routed",
        outcome: "needs_rework",
        leg: "rework",
        round: 1,
      }),
    ).toBe(
      "Work submitted with outcome 'needs_rework': findings routed to the coder for rework (round 1) — you are NOT done; you will be resumed to re-verify the rework.",
    );
  });

  it("routed reverify leg", () => {
    expect(renderSubmitOutcome({ disposition: "routed", leg: "reverify", round: 2 })).toBe(
      "Work submitted: routed to the reviewer for re-verification (round 2) — you are NOT done yet; the control plane resumes you if further rework is needed.",
    );
  });

  it("cap-breach yield", () => {
    expect(
      renderSubmitOutcome({
        disposition: "yielded",
        outcome: "needs_rework",
        reason: "cap-breach",
      }),
    ).toBe(
      "Work submitted with outcome 'needs_rework': the review gate's round cap is exhausted, so you YIELDED to your parent orchestrator — you are NOT done; it decides what happens next.",
    );
  });

  it("unmatched yield", () => {
    expect(renderSubmitOutcome({ disposition: "yielded", outcome: "rework_approach" })).toBe(
      "Work submitted with outcome 'rework_approach': no route matched, so you YIELDED to your parent orchestrator — you are NOT done; it will be woken with your report and decides what happens next.",
    );
  });
});

describe("renderConsultCandidates", () => {
  it("renders the disambiguation list", () => {
    expect(
      renderConsultCandidates([
        { threadId: "t1", title: "A", role: "coder", planLane: "ready", worktreePath: "/w/a" },
        { threadId: "t2", title: null, role: null, planLane: null },
      ]),
    ).toBe(
      [
        "Multiple threads match that name. Confirm which one with the user, then call consult_thread again with its threadId:",
        "- A — coder, ready [/w/a] (threadId: t1)",
        "- (untitled) — thread, unknown (threadId: t2)",
      ].join("\n"),
    );
  });

  it("renders the empty message", () => {
    expect(renderConsultCandidates([])).toBe("No matching thread was found.");
  });
});
