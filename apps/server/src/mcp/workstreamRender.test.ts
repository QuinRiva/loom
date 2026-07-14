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

  it("renders the scaffold graphKey inline and the purpose sub-line", () => {
    const view: WorkstreamListView = {
      callerId: "root",
      nodes: [
        {
          id: "root",
          parentThreadId: null,
          role: "orchestrator",
          title: "Root",
          planLane: "in_progress",
        },
        {
          id: "api",
          parentThreadId: "root",
          role: "coder",
          title: "Dedup API endpoint",
          graphKey: "api",
          purpose: "Adds the merge endpoint so duplicate receipts can be collapsed.",
          planLane: "ready",
        },
      ],
    };
    expect(renderWorkstreamList(view)).toBe(
      [
        "Workstream: 2 thread(s). Indentation shows lineage (parent above its children).",
        '- root (you) [orchestrator] "Root" lane=in_progress',
        '  - api [coder] "Dedup API endpoint" key=api lane=ready',
        "      purpose: Adds the merge endpoint so duplicate receipts can be collapsed.",
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

  it("renders the task-shape vocabulary and the compact profile summary", () => {
    const view: WorkstreamListView = {
      callerId: "root",
      nodes: [{ id: "root", parentThreadId: null, role: null, title: "R", planLane: "ready" }],
      modelCatalogue: [{ instanceId: "pi", models: ["a"] }],
      modelPresets: [],
      taskShapes: ["explore", "thorough", "mechanical"],
      modelProfiles: [
        { name: "Fable 5", agentic: "full", usableContext: 200000, valid: true, spawnable: true },
        {
          name: "Gemini 3.1 Pro",
          agentic: "oracle",
          usableContext: 1000000,
          valid: true,
          spawnable: false,
        },
        { name: "Stale", agentic: "full", valid: false, spawnable: true },
        { name: "Dead Oracle", agentic: "oracle", valid: false, spawnable: false },
      ],
    };
    const rendered = renderWorkstreamList(view);
    expect(rendered).toContain(
      "  task shapes (pass one as taskShape; the server picks the model):",
    );
    expect(rendered).toContain('    - "explore" — open-ended/prototype work');
    expect(rendered).toContain("  profiles (what taskShape resolves among):");
    expect(rendered).toContain('    - "Fable 5" [full] usableContext=200000');
    // Oracle shows non-spawnable AND usableContext independently.
    expect(rendered).toContain(
      '    - "Gemini 3.1 Pro" [oracle — not spawnable; consultation only] usableContext=1000000',
    );
    expect(rendered).toContain(
      '    - "Stale" [full] [INVALID — points at an unconfigured instance/model; do not use]',
    );
    // Invalid oracle shows BOTH the non-spawnable status and the invalid marker.
    expect(rendered).toContain(
      '    - "Dead Oracle" [oracle — not spawnable; consultation only] [INVALID — points at an unconfigured instance/model; do not use]',
    );
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
