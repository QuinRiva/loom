import { LOOM_SEED } from "@t3tools/shared/loomSeedFixture.loom";
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loomPreviewThreads } from "../preview/loomFixtures";
import {
  boardMembersOf,
  buildNodeContextMenuItems,
  buildTimelineRows,
  buildWorkstreamNodes,
  describeOutcomeVerdict,
  getActivity,
  getGateWaitLabel,
  getNodeStateWord,
  outcomeActionsOf,
  wrapLabel,
} from "./workstreamPresentation";

const T = LOOM_SEED.threads;
const shells: ReadonlyArray<OrchestrationV2ThreadShell> = Object.values(loomPreviewThreads);
const nodes = buildWorkstreamNodes(shells);
const node = (id: ThreadId) => nodes.get(id)!;

const patch = (
  shell: OrchestrationV2ThreadShell,
  fields: Partial<NonNullable<OrchestrationV2ThreadShell["workstream"]>>,
  shellFields: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  ...shell,
  ...shellFields,
  workstream: { ...shell.workstream!, ...fields },
});

describe("buildWorkstreamNodes", () => {
  it("derives every board column from the fixture", () => {
    expect(node(T.stagedRoot).column).toBe("held");
    expect(node(T.blocked).column).toBe("blocked");
    expect(node(T.unbriefed).column).toBe("blocked");
    expect(nodes.get("seed-thread-ready" as ThreadId)!.column).toBe("ready");
    expect(node(T.gateCoder).column).toBe("in_progress");
    expect(node(T.coderDone).column).toBe("done");
    expect(node(T.cancelledLead).column).toBe("cancelled");
  });

  it("reads attention as stored ∪ derived, highest first", () => {
    expect(node(T.quiescent).reasons).toEqual(["awaiting_orchestrator"]);
    expect(node(T.unbriefed).reasons).toEqual(["brief-needed"]);
    expect(nodes.get("seed-thread-awaiting-input" as ThreadId)!.reasons).toEqual([
      "awaiting_input",
    ]);
  });

  it("names a waiting question and its age on the card (S4)", () => {
    expect(getActivity(nodes.get("seed-thread-awaiting-input" as ThreadId)!)).toMatch(
      /^waiting for your input · Parser · \d+[smhd]$/,
    );
  });

  it("an archived unfinished dependency still gates; an archived done one releases", () => {
    const archivedAt = loomPreviewThreads.root.createdAt;
    const archivedOpen = patch(loomPreviewThreads.quiescent, {}, { archivedAt });
    expect(
      buildWorkstreamNodes([archivedOpen, loomPreviewThreads.blocked]).get(T.blocked)!.column,
    ).toBe("blocked");
    const archivedDone = patch(loomPreviewThreads.quiescent, { outcome: "done" }, { archivedAt });
    expect(
      buildWorkstreamNodes([archivedDone, loomPreviewThreads.blocked]).get(T.blocked)!.column,
    ).toBe("ready");
  });
});

describe("boardMembersOf", () => {
  it("is the root's lineage children plus the staged root that continues it", () => {
    const members = boardMembersOf(T.root, nodes).map((member) => member.id);
    expect(members).toContain(T.stagedRoot);
    expect(members).toContain(T.coderDone);
    expect(members).not.toContain(T.cancelledGrandchild);
    expect(members).not.toContain(T.needsGuidanceRoot);
  });
});

describe("outcome controls", () => {
  it("offers accept done and cancel on an open thread, reopen on a settled one", () => {
    expect(outcomeActionsOf(node(T.gateCoder)).map((action) => action.outcome)).toEqual([
      "done",
      "cancelled",
    ]);
    expect(outcomeActionsOf(node(T.coderDone)).map((action) => action.outcome)).toEqual([null]);
    expect(outcomeActionsOf(node(T.cancelledLead)).map((action) => action.outcome)).toEqual([null]);
  });

  it("puts them in the graph node menu with no release or lane item", () => {
    const ids = buildNodeContextMenuItems(node(T.quiescent)).map((item) => item.id);
    expect(ids).toEqual([
      "open",
      "parent",
      "history",
      "report",
      "outcome:done",
      "outcome:cancelled",
      "clear-flags",
    ]);
    expect(buildNodeContextMenuItems(node(T.coderDone)).map((item) => item.id)).toContain(
      "outcome:reopen",
    );
  });
});

describe("the gated pair", () => {
  it("the coder holds the open rework round; the reviewer waits on it", () => {
    expect(getGateWaitLabel(node(T.gateCoder), nodes)).toEqual({
      label: "reworking round 1",
      active: true,
    });
    expect(getGateWaitLabel(node(T.gateReviewer), nodes)).toEqual({
      label: "waiting on rework",
      active: false,
    });
    expect(getNodeStateWord(node(T.gateCoder), nodes)).toBe("reworking ⟲1");
  });

  it("describes verdicts", () => {
    expect(describeOutcomeVerdict({ outcome: "needs_rework", decision: "loop", round: 1 })).toEqual(
      {
        label: "needs rework ⟲1",
        tone: "warning",
      },
    );
    expect(
      describeOutcomeVerdict({ outcome: "quiescent", decision: "yield", round: 0 })?.tone,
    ).toBe("info");
    expect(describeOutcomeVerdict({ outcome: "done", decision: "terminal", round: 0 })).toBeNull();
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
      { ...last, round: 0, eventId: null, at: reviewer.createdAt, reportPath: "/r/a.md" },
      { ...last, reportPath: "/r/a.round-1.md" },
    ]);
    expect(rows.filter((row) => row.reportPath).map((row) => row.reportPath)).toEqual([
      "/r/a.md",
      "/r/a.round-1.md",
    ]);
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
