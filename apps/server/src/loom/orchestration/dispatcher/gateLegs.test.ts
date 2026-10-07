/** The gate-leg composer, ported from V1's gate resume-message tests and retyped. */
import { assert, describe, it } from "@effect/vitest";
import { IsoDateTime, ProjectId, ThreadId } from "@t3tools/contracts";

import { emptyWorkstream } from "../../projection/LoomStore.ts";
import {
  buildGateReverifyMessage,
  buildGateReworkMessage,
  makeGateLegComposer,
} from "./gateLegs.ts";

describe("gate resume messages", () => {
  it("rework carries marker, round, reference, adjudication rules and routing visibility", () => {
    const text = buildGateReworkMessage(
      { id: ThreadId.make("rev-1"), role: "reviewer", reportPath: "/reports/rev-1.round-1.md" },
      1,
      "## Findings\n1. Fix the null guard.",
    );
    for (const fragment of [
      "[T3 Workstream control plane",
      "Review round 1",
      "/reports/rev-1.round-1.md",
      "Fix the null guard.",
      "claims, not verdicts",
      "routes back to the reviewer",
      "NOT to done",
      "`mcp__t3-code__workstream_submit`",
    ])
      assert.include(text, fragment);
  });

  it("reverify carries the delta-review discipline and the verdict routing", () => {
    const text = buildGateReverifyMessage(
      { id: ThreadId.make("coder-1"), role: "coder", reportPath: "/reports/coder-1.round-1.md" },
      1,
      "## Round report\nImplemented finding 1; rejected finding 2 (reasons).",
    );
    for (const fragment of [
      "re-verification",
      "DELTA review",
      "rejected finding 2",
      "`clean` or `fixed_inline` resolves the gate",
      "`needs_rework` loops again",
    ])
      assert.include(text, fragment);
  });

  it("makeGateLegComposer emits the gate-rework / gate-reverify notice with the source's report", () => {
    const source = {
      ...emptyWorkstream({
        threadId: ThreadId.make("rev-1"),
        projectId: ProjectId.make("p"),
        parentThreadId: ThreadId.make("root"),
        rootThreadId: ThreadId.make("root"),
        at: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
      }),
      role: "reviewer",
      reportPath: "/r/rev-1.md",
    };
    const compose = makeGateLegComposer(new Map([["/r/rev-1.md", "FINDING: null guard"]]));
    const rework = compose({
      kind: "rework",
      source,
      targetThreadId: ThreadId.make("c"),
      round: 2,
    });
    assert.equal(rework.controlPayload.kind, "notice");
    assert.equal(rework.controlPayload.notice, "gate-rework");
    assert.include(rework.text, "FINDING: null guard");
    assert.deepInclude(rework.controlPayload.items[0]!, {
      threadId: ThreadId.make("rev-1"),
      reportPath: "/r/rev-1.md",
      excerpt: "FINDING: null guard",
    });
    const reverify = compose({
      kind: "reverify",
      source,
      targetThreadId: ThreadId.make("c"),
      round: 2,
    });
    assert.equal(reverify.controlPayload.notice, "gate-reverify");
    // An unread report degrades to the reference alone.
    const bare = makeGateLegComposer(new Map())({
      kind: "rework",
      source,
      targetThreadId: ThreadId.make("c"),
      round: 1,
    });
    assert.include(bare.text, "/r/rev-1.md");
    assert.notProperty(bare.controlPayload.items[0], "excerpt");
  });
});
