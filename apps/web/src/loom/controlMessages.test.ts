import { loomSeedControlMessages } from "@t3tools/shared/loomSeedFixture.loom";
import { describe, expect, it } from "vite-plus/test";

import { controlCardModel } from "./controlMessages";

const seed = loomSeedControlMessages({
  coderDone: "a.md",
  gateReviewer: "b.md",
  quiescent: "c.md",
});

describe("controlCardModel", () => {
  it("cards every seam-6 kind, notice and item kind the seed writes", () => {
    const labels = seed.map(({ key, text, payload }) => {
      const model = controlCardModel({ origin: "control_notice", controlPayload: payload }, text);
      expect(model?.kind, key).toBe("card");
      return model?.kind === "card"
        ? [key, model.label, model.items.map((entry) => entry.kindLabel)]
        : [key];
    });
    expect(labels).toEqual([
      [
        "digest",
        "Digest",
        ["finished", "gate resolved", "recovered", "slow tool", "spinning", "dead"],
      ],
      ["yield", "Yield", [null]],
      ["notice-gate-rework", "Rework round", [null]],
      ["notice-gate-reverify", "Re-verify", [null]],
      ["notice-brief-needed", "Brief needed", [null]],
      ["notice-deadlock", "Deadlock", [null]],
      ["notice-stall-nudge", "Stall nudge", [null]],
      ["notice-attention", "Attention", [null]],
      ["notice-notify", "Thread notification", [null]],
    ]);
  });

  it("falls back to the raw text for an unknown kind, notice or item kind", () => {
    const unknown = [
      { kind: "future", items: [] },
      { kind: "notice", notice: "future", items: [] },
      { kind: "digest", items: [{ kind: "future", title: "x" }] },
    ] as never[];
    for (const controlPayload of unknown) {
      expect(controlCardModel({ controlPayload }, "text")?.kind).toBe("raw");
    }
  });

  it("leaves human, kickoff and short payload-less messages to upstream's bubble", () => {
    expect(controlCardModel(null, "hi")).toBeNull();
    expect(controlCardModel({ origin: "kickoff" }, "x".repeat(900))).toBeNull();
    expect(controlCardModel({ origin: "control_notice" }, "Rework round 2.")).toBeNull();
    expect(controlCardModel({ origin: "notify" }, "x".repeat(900))?.kind).toBe("raw");
  });
});
