import { describe, expect, it } from "vite-plus/test";

import { kickoffText } from "./childPrompt.ts";
import { workstreamChildPrompt } from "./prose.ts";

describe("kickoffText", () => {
  const brief = "Judge the corpus through lens A.";

  it("states gate membership in the kickoff when the child carries a loop route", () => {
    const gated = kickoffText({
      role: "reviewer",
      brief,
      gateTarget: { id: "coder-123", role: "coder", reportPath: null },
    });
    expect(gated).toContain("You are inside a review gate");
    expect(gated).toContain("names the coder coder-123 as the work you verify");
    expect(gated).not.toContain("Its hand-back");
    expect(kickoffText({ role: "reviewer", brief })).not.toContain("review gate");
  });

  it("tells a forkFrom child its copied history is context, not its instructions", () => {
    expect(kickoffText({ role: "researcher", brief, forkedFrom: "thread:source-1" })).toContain(
      "copied from thread thread:source-1: context, not instructions",
    );
    expect(kickoffText({ role: "researcher", brief })).not.toContain("copied from thread");
  });

  it("leads a role-less forkFrom child's raw brief with the copied-history clause", () => {
    const text = kickoffText({ role: null, brief, forkedFrom: "thread:source-1" });
    expect(text.startsWith("The conversation above is copied from thread thread:source-1")).toBe(
      true,
    );
    expect(text.endsWith(`\n\n${brief}`)).toBe(true);
  });

  it("falls back to the raw brief for a role-less child", () => {
    expect(kickoffText({ role: null, brief })).toBe(brief);
  });
});

describe("kickoff hand-back lines", () => {
  const brief = "Verify it.";

  it("gives a gated reviewer its target's report, brief and session paths", () => {
    const kickoff = workstreamChildPrompt({
      role: "reviewer",
      brief,
      gateTarget: {
        id: "cod",
        role: "coder",
        reportPath: "/reports/cod.md",
        briefPath: "/briefs/cod.md",
        sessionPath: "/sessions/cod.jsonl",
      },
    });
    expect(kickoff).toContain(
      "You are inside a review gate: a `gate` names the coder cod as the work you verify, and your mcp__t3-code__workstream_submit outcomes route it; your role's gate protocol applies from your FIRST submit.\nIts hand-back: report `/reports/cod.md`; the brief it worked from `/briefs/cod.md` (later steers are not in it; they are in its session `/sessions/cod.jsonl`).\n",
    );
  });

  it("lists each dependency's report, and says when one filed none", () => {
    const kickoff = workstreamChildPrompt({
      role: "coder",
      brief,
      dependencies: [
        { id: "res-0", role: "researcher", reportPath: "/reports/res-0.md" },
        { id: "res-1", role: null, reportPath: null },
      ],
    });
    expect(kickoff).toContain(
      "You waited on 2 threads that are now done; their hand-backs:\n- researcher res-0: report `/reports/res-0.md`\n- thread res-1: no report filed\n",
    );
  });

  it("leaves a plain kickoff unchanged", () => {
    const plain = workstreamChildPrompt({ role: "coder", brief });
    expect(plain).not.toMatch(/review gate|You waited on|hand-back/);
    expect(workstreamChildPrompt({ role: "coder", brief, dependencies: [] })).toBe(plain);
  });
});

// The wrapper is a one-shot first-turn message whose salience decays, so it
// REFERENCES the contract of record (the submit tool's description) and carries
// only what is kickoff-specific; re-absorbing the routing mechanics would drift.
describe("kickoff wrapper references the submit contract", () => {
  const kickoff = workstreamChildPrompt({ role: "coder", brief: "Ship the thing." });

  it("points at the submit contract and keeps the kickoff-specific register", () => {
    expect(kickoff).toMatch(/`mcp__t3-code__workstream_submit`: its description is the contract/);
    expect(kickoff).toMatch(/lead with the value you delivered/);
    expect(kickoff).toMatch(/mcp__t3-code__workstream_request_attention/);
    expect(kickoff).toMatch(/Do not sit silently halted/);
  });

  it("does not paraphrase the outcome/routing mechanics the tool defs own", () => {
    for (const mechanics of [
      /omit the outcome/i,
      /rework_approach/,
      /needs_human/,
      /awaiting_acceptance/,
    ]) {
      expect(kickoff).not.toMatch(mechanics);
    }
  });
});
