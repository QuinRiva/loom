import { describe, expect, it } from "vite-plus/test";

import {
  buildExhaustionResumePrompt,
  buildUndeliveredKickoffResumePrompt,
  resolveExhaustionResumeText,
} from "./ExhaustionResumeSweep.ts";
import { workstreamChildPrompt } from "../workstreamChildPrompt.ts";

// loom: forkFrom (D8). When a first turn stalls on quota BEFORE the prompt is
// delivered (kickoff-delivered marker absent), the sweep must re-deliver the
// SAME composed kickoff the dispatcher would send — role framing + completion
// contract — not the generic "continue where you left off", which for a fork
// would leave the copied source transcript without its lens brief.
describe("buildUndeliveredKickoffResumePrompt (D8 kickoff re-delivery)", () => {
  const composed = workstreamChildPrompt({
    role: "assessor",
    brief: "Judge the corpus through lens A.",
  });

  it("wraps the composed kickoff in reset framing, not the generic continue", () => {
    const text = buildUndeliveredKickoffResumePrompt(composed);
    // Control-plane framing so the child knows this is an automated resume.
    expect(text).toContain("T3 Code control plane");
    expect(text).toContain("kickoff brief was never delivered");
    // The FULL composed kickoff rides along verbatim (role + brief + contract).
    expect(text).toContain(composed);
    expect(text).toContain("assessor sub-thread");
    expect(text).toContain("Judge the corpus through lens A.");
    expect(text).toContain("workstream_submit");
    // It is NOT the generic continue message (which drops the brief).
    expect(text).not.toContain("Continue the task from where you left off.");
  });

  it("is distinct from the generic (delivered-turn) resume prompt", () => {
    expect(buildUndeliveredKickoffResumePrompt(composed)).not.toBe(buildExhaustionResumePrompt());
    // The generic prompt carries neither the brief nor role framing.
    expect(buildExhaustionResumePrompt()).not.toContain("assessor sub-thread");
  });
});

// loom: forkFrom (D8) — the sweep's resume-text branch. Undelivered + role +
// brief → composed kickoff; every other case (delivered marker, no role, no
// brief) → generic continue. This is the readiness decision the sweep makes per
// stalled thread.
describe("resolveExhaustionResumeText (D8 sweep readiness branch)", () => {
  const brief = "Judge the corpus through lens A.";

  it("re-delivers the composed kickoff when undelivered with role + brief", () => {
    const text = resolveExhaustionResumeText({ delivered: false, role: "assessor", brief });
    expect(text).toContain(workstreamChildPrompt({ role: "assessor", brief }));
    expect(text).toContain("kickoff brief was never delivered");
  });

  it("uses the generic continue once the kickoff was delivered (delivered-then-error safety)", () => {
    expect(resolveExhaustionResumeText({ delivered: true, role: "assessor", brief })).toBe(
      buildExhaustionResumePrompt(),
    );
  });

  it("uses the generic continue when role or brief is missing (nothing to recompose)", () => {
    expect(resolveExhaustionResumeText({ delivered: false, role: null, brief })).toBe(
      buildExhaustionResumePrompt(),
    );
    expect(
      resolveExhaustionResumeText({ delivered: false, role: "assessor", brief: undefined }),
    ).toBe(buildExhaustionResumePrompt());
  });
});
