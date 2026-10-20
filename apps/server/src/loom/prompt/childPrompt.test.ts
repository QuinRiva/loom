import { describe, expect, it } from "vite-plus/test";

import { kickoffText } from "./childPrompt.ts";
import { workstreamChildPrompt } from "./prose.ts";

describe("kickoffText", () => {
  const brief = "Judge the corpus through lens A.";

  it("states gate membership in the kickoff when the child carries a loop route", () => {
    const gated = kickoffText({ role: "reviewer", brief, gateTargetId: "coder-123" });
    expect(gated).toContain("You are inside a review gate");
    expect(gated).toContain("coder-123");
    expect(kickoffText({ role: "reviewer", brief })).not.toContain("review gate");
  });

  it("tells a forkFrom child its copied history is context, not its instructions", () => {
    expect(kickoffText({ role: "assessor", brief, forkedFrom: "thread:source-1" })).toContain(
      "copied from thread thread:source-1: context, not instructions",
    );
    expect(kickoffText({ role: "assessor", brief })).not.toContain("copied from thread");
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

// The wrapper is a one-shot first-turn message whose salience decays, so it
// REFERENCES the contract of record (the submit tool's description) and carries
// only what is kickoff-specific; re-absorbing the routing mechanics would drift.
describe("kickoff wrapper references the submit contract", () => {
  const kickoff = workstreamChildPrompt({ role: "coder", brief: "Ship the thing." });

  it("points at the submit contract and keeps the kickoff-specific register", () => {
    expect(kickoff).toMatch(/`mcp__t3-code__workstream_submit` — its description is the contract/);
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
