import { describe, expect, it } from "vite-plus/test";

import { kickoffTextForPrompt, workstreamChildPrompt } from "./workstreamChildPrompt.ts";

// loom: forkFrom (D8). `workstream_prompt` must (re)deliver the composed kickoff
// while the child's kickoff has NOT been delivered to pi (the D7 backstop repair
// path), and must NOT re-prepend it once delivered (the delivered-then-errored
// counter-example).
describe("kickoffTextForPrompt (D8 workstream_prompt kickoff re-delivery)", () => {
  const brief = "Judge the corpus through lens A.";
  const message = "Also double-check section 3.";

  it("prepends the composed kickoff (role framing + contract reference) when undelivered", () => {
    const text = kickoffTextForPrompt({ delivered: false, role: "assessor", brief, message });
    expect(text).toContain(workstreamChildPrompt({ role: "assessor", brief }));
    expect(text).toContain("assessor sub-thread");
    expect(text).toContain("workstream_submit");
    expect(text.endsWith(message)).toBe(true);
  });

  it("sends only the plain message once the kickoff was delivered (no re-prepend)", () => {
    const text = kickoffTextForPrompt({ delivered: true, role: "assessor", brief, message });
    expect(text).toBe(message);
    expect(text).not.toContain("assessor sub-thread");
    expect(text).not.toContain(brief);
  });

  it("states gate membership in the kickoff when the child carries a loop route", () => {
    const gated = workstreamChildPrompt({ role: "reviewer", brief, gateTargetId: "coder-123" });
    expect(gated).toContain("You are inside a review gate");
    expect(gated).toContain("coder-123");
    const ungated = workstreamChildPrompt({ role: "reviewer", brief });
    expect(ungated).not.toContain("review gate");
  });

  it("falls back to the raw brief for a role-less legacy child", () => {
    const text = kickoffTextForPrompt({ delivered: false, role: null, brief, message });
    expect(text).toBe(`${brief}\n\n${message}`);
    expect(text).not.toContain("sub-thread spawned by a parent orchestrator");
  });
});

// loom: child-prompt dedup P2a. The wrapper is a one-shot first-turn message
// whose salience decays over a long transcript, so it REFERENCES the contract of
// record (workstream_submit's description, present in every request) and carries
// only what is kickoff-specific: the report register and the never-halt-silently
// duty. Re-absorbing the outcome/routing mechanics here is the duplication this
// change removed, and it would then drift from the tool def.
describe("kickoff wrapper references the submit contract (P2a)", () => {
  const kickoff = workstreamChildPrompt({ role: "coder", brief: "Ship the thing." });

  it("points at the submit contract and keeps the kickoff-specific register", () => {
    expect(kickoff).toMatch(/`workstream_submit` — its description is the contract/);
    expect(kickoff).toMatch(/lead with the value you delivered/);
    expect(kickoff).toMatch(/workstream_request_attention/);
    expect(kickoff).toMatch(/Do not sit silently halted/);
  });

  it("does not paraphrase the outcome/routing mechanics the tool defs own", () => {
    for (const mechanics of [
      /omit the outcome/i,
      /rework_approach/,
      /needs_human/,
      /awaiting_acceptance/,
      /needs_guidance/,
      /never set your own lane/i,
    ]) {
      expect(kickoff).not.toMatch(mechanics);
    }
  });
});
