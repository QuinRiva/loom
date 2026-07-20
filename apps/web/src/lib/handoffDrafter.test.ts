import { describe, expect, it } from "vite-plus/test";

import { HANDOFF_DRAFTER_ROLE, isVisibleHandoffDrafter } from "./handoffDrafter";

describe("isVisibleHandoffDrafter", () => {
  it("always shows non-drafter threads", () => {
    expect(isVisibleHandoffDrafter({ role: null, attention: [] })).toBe(true);
    expect(isVisibleHandoffDrafter({ role: "coder", attention: [] })).toBe(true);
    expect(isVisibleHandoffDrafter({ role: "reviewer", attention: ["needs_guidance"] })).toBe(true);
  });

  it("hides a healthy (attention-free) drafter", () => {
    expect(isVisibleHandoffDrafter({ role: HANDOFF_DRAFTER_ROLE, attention: [] })).toBe(false);
  });

  it("surfaces a broken drafter that the server flagged for a human", () => {
    expect(
      isVisibleHandoffDrafter({ role: HANDOFF_DRAFTER_ROLE, attention: ["needs_guidance"] }),
    ).toBe(true);
  });

  it("surfaces a drafter carrying any attention, so a failure can never be hidden", () => {
    expect(isVisibleHandoffDrafter({ role: HANDOFF_DRAFTER_ROLE, attention: ["error"] })).toBe(
      true,
    );
  });

  it("ignores the optional now argument (surfacing is server-driven, not age-based)", () => {
    expect(isVisibleHandoffDrafter({ role: HANDOFF_DRAFTER_ROLE, attention: [] }, Date.now())).toBe(
      false,
    );
  });
});
