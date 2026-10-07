import { describe, expect, it } from "vite-plus/test";

import { kickoffTextForPrompt } from "./childPrompt.ts";
import { workstreamChildPrompt } from "./prose.ts";

// `mcp__t3-code__workstream_prompt` must deliver the composed kickoff while the
// child's kickoff has NOT been delivered, and must NOT re-prepend it once it was.
describe("kickoffTextForPrompt", () => {
  const brief = "Judge the corpus through lens A.";
  const message = "Also double-check section 3.";

  it("prepends the composed kickoff (role framing + contract reference) when undelivered", () => {
    const text = kickoffTextForPrompt({ delivered: false, role: "assessor", brief, message });
    expect(text).toBe(`${workstreamChildPrompt({ role: "assessor", brief })}\n\n${message}`);
    expect(text).toContain("mcp__t3-code__workstream_submit");
  });

  it("sends only the plain message once the kickoff was delivered (no re-prepend)", () => {
    expect(kickoffTextForPrompt({ delivered: true, role: "assessor", brief, message })).toBe(
      message,
    );
  });

  it("states gate membership in the kickoff when the child carries a loop route", () => {
    const gated = kickoffTextForPrompt({
      delivered: false,
      role: "reviewer",
      brief,
      message,
      gateTargetId: "coder-123",
    });
    expect(gated).toContain("You are inside a review gate");
    expect(gated).toContain("coder-123");
    expect(
      kickoffTextForPrompt({ delivered: false, role: "reviewer", brief, message }),
    ).not.toContain("review gate");
  });

  it("falls back to the raw brief for a role-less child", () => {
    expect(kickoffTextForPrompt({ delivered: false, role: null, brief, message })).toBe(
      `${brief}\n\n${message}`,
    );
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
