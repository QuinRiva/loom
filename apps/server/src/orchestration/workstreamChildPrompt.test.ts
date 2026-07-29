import { describe, expect, it } from "vite-plus/test";

import { kickoffTextForPrompt, workstreamChildPrompt } from "./workstreamChildPrompt.ts";

// loom: forkFrom (D8). `workstream_prompt` must (re)deliver the composed kickoff
// while the child's kickoff has NOT been delivered to pi (the D7 backstop repair
// path), and must NOT re-prepend it once delivered (the delivered-then-errored
// counter-example).
describe("kickoffTextForPrompt (D8 workstream_prompt kickoff re-delivery)", () => {
  const brief = "Judge the corpus through lens A.";
  const message = "Also double-check section 3.";

  it("prepends the composed kickoff (role framing + contract) when undelivered", () => {
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
