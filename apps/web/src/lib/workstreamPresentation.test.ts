import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import { EventId, type OrchestrationV2ThreadShell, type ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loomPreviewThreads } from "../preview/loomFixtures";
import { buildWorkstreamNodes } from "@t3tools/client-runtime/state/loom/workstreamNodes";
import { buildTimelineRows, getNodeStateWord, wrapLabel } from "./workstreamPresentation";

const T = LOOM_SEED.threads;
const shells: ReadonlyArray<OrchestrationV2ThreadShell> = Object.values(loomPreviewThreads);
const nodes = buildWorkstreamNodes(shells);
const node = (id: ThreadId) => nodes.get(id)!;

describe("the gated pair", () => {
  it("names each party's leg in its state word", () => {
    expect(getNodeStateWord(node(T.gateCoder), nodes)).toBe("reworking ⟲1");
    expect(getNodeStateWord(node(T.gateReviewer), nodes)).toBe("waiting ⟲1");
  });
});

describe("buildTimelineRows", () => {
  it("orders the sidecar's milestones and carries the verdict and counts", () => {
    const reviewer = node(T.gateReviewer);
    const rows = buildTimelineRows(reviewer, (id) => node(id).title);
    expect(rows.map((row) => row.key.split(":")[0])).toEqual(["created", "kickoff", "outcome"]);
    expect(rows.at(-1)).toMatchObject({
      label: "needs rework ⟲1",
      detail: "round 1 · 2 must-fix · 1 nice-to-have",
      reportPath: reviewer.reportPath,
    });
  });

  it("gives every submitted outcome its own report row once the history arrives", () => {
    const reviewer = node(T.gateReviewer);
    const last = reviewer.lastOutcome!;
    const rows = buildTimelineRows(reviewer, String, [
      {
        type: "outcome",
        ...last,
        round: 0,
        eventId: null,
        at: reviewer.createdAt,
        reportPath: "/r/a.md",
      },
      { type: "outcome", ...last, reportPath: "/r/a.round-1.md" },
    ]);
    expect(rows.filter((row) => row.reportPath).map((row) => row.reportPath)).toEqual([
      "/r/a.md",
      "/r/a.round-1.md",
    ]);
  });

  it("shows flag, yield and rework history, each linked to where it happened", () => {
    const reviewer = node(T.gateReviewer);
    const at = (n: number) => `2026-10-06T00:00:0${n}.000Z`;
    const event = (n: number) => ({ eventId: EventId.make(`event:${n}`), at: at(n) });
    const rows = buildTimelineRows(reviewer, (id) => `title of ${id}`, [
      { type: "route-taken", ...event(1), to: T.gateCoder, round: 1, kind: "loop" },
      { type: "attention-raised", ...event(2), reason: "awaiting_orchestrator" },
      { type: "attention-cleared", ...event(3), reason: null },
      { type: "attention-raised", ...event(4), reason: "needs_guidance" },
      { type: "outcome-set", ...event(5), outcome: null },
    ]);
    expect(rows.slice(-5).map((row) => [row.label, row.detail])).toEqual([
      ["Rework round 1", `→ title of ${T.gateCoder}`],
      ["Yielded", "handed its turn to the orchestrator"],
      ["Resumed", "picked back up by the orchestrator"],
      ["Flag raised", "Needs guidance"],
      ["Reopened", null],
    ]);
    expect(rows.at(-1)?.jump).toEqual({ threadId: reviewer.id, at: at(5) });
    expect(rows[0]?.jump).toEqual({ threadId: reviewer.parentThreadId, at: reviewer.createdAt });
  });

  it("marks a synthesised report and a settled outcome", () => {
    expect(buildTimelineRows(node(T.quiescent), String).at(-1)?.detail).toContain(
      "report synthesised",
    );
    expect(buildTimelineRows(node(T.coderDone), String).map((row) => row.key)).toContain("outcome");
  });
});

describe("wrapLabel", () => {
  it("wraps greedily and ellipsises overflow", () => {
    expect(wrapLabel("short", 24, 2)).toEqual(["short"]);
    expect(wrapLabel("alpha beta gamma delta epsilon zeta eta theta", 12, 2)).toEqual([
      "alpha beta",
      "gamma delta…",
    ]);
  });
});
