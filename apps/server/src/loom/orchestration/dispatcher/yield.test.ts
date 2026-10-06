/** The yield wake, ported from V1's `buildYieldWakeMessage` / `buildYieldPayload` tests and retyped. */
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";

import { buildYieldPayload, buildYieldWakeMessage } from "./yield.ts";

const child = { id: ThreadId.make("child-1"), role: "reviewer", reportPath: "child-1.md" };
const gate = {
  rounds: 2,
  maxRounds: 2,
  counterpart: {
    id: ThreadId.make("coder-1"),
    role: "coder",
    reportPath: "/reports/coder-1.round-2.md",
    report: "Round 2: contested finding 3 again.",
  },
};

describe("buildYieldWakeMessage", () => {
  it("marks the notice, names the outcome and lays out the decision menu", () => {
    const text = buildYieldWakeMessage(child, "rework_approach", "# Why\nThe approach is wrong.");
    for (const fragment of [
      "[T3 Workstream control plane",
      "`rework_approach`",
      "child-1.md",
      "The approach is wrong.",
      "NOT finished",
      "awaiting_orchestrator",
      "mcp__t3-code__workstream_prompt",
      "mcp__t3-code__workstream_set_outcome",
    ])
      assert.include(text, fragment);
    assert.notInclude(text, "set_lane");
    assert.notInclude(text, "yielded`");
  });

  it("does not duplicate 'sub-thread' when the child has no role", () => {
    const text = buildYieldWakeMessage({ ...child, role: null, reportPath: null }, "x", null);
    assert.include(text, "Your Workstream sub-thread `child-1`");
  });

  it("a cap breach carries the round count and BOTH parties' reports", () => {
    const text = buildYieldWakeMessage(child, "needs_rework", "Still two must-fix findings.", gate);
    for (const fragment of [
      "round cap is exhausted (2/2",
      "Still two must-fix findings.",
      "coder `coder-1`",
      "/reports/coder-1.round-2.md",
      "contested finding 3 again",
      "dissolves the gate",
      "NOT resolved",
    ])
      assert.include(text, fragment);
  });

  it("a synthesised yield says the child went quiet, and that its gate is parked", () => {
    const text = buildYieldWakeMessage(child, "quiescent", "last words", undefined, {
      gateParked: true,
    });
    assert.include(text, "went quiet");
    assert.include(text, "without calling `mcp__t3-code__workstream_submit`");
    assert.include(text, "the gate is parked");
    assert.include(text, "dissolves the gate");
  });
});

describe("buildYieldPayload", () => {
  it("leads with the yielding child and appends the gate counterpart", () => {
    const payload = buildYieldPayload(child, "rework_approach", "my report", gate);
    assert.equal(payload.kind, "yield");
    assert.notProperty(payload, "synthesised");
    assert.deepInclude(payload.items[0]!, {
      threadId: ThreadId.make("child-1"),
      status: "yielded",
    });
    assert.include(payload.items[0]!.title, "rework_approach");
    assert.deepInclude(payload.items[1]!, {
      threadId: ThreadId.make("coder-1"),
      status: "counterpart",
    });
    assert.include(payload.heading, "round cap exhausted");
  });

  it("a non-gate yield carries just the child", () => {
    const payload = buildYieldPayload({ ...child, reportPath: null }, "weird_token", null);
    assert.lengthOf(payload.items, 1);
    assert.notProperty(payload.items[0], "reportPath");
    assert.include(payload.heading, "unmatched outcome");
  });

  it("a quiescent yield is marked synthesised", () => {
    const payload = buildYieldPayload(child, "quiescent", "x", undefined, undefined, {
      gateParked: false,
    });
    assert.isTrue(payload.synthesised);
    assert.include(payload.items[0]!.title, "report synthesised");
  });
});
