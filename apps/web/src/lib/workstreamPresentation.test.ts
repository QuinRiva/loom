import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import type { SidebarThreadSummary } from "../types";
import { formatDiffMetric, getFanInChip } from "./workstreamPresentation";

// getFanInChip/formatDiffMetric only read a handful of fields; build a minimal
// shell and cast rather than a full fixture.
const summary = (over: Partial<SidebarThreadSummary>): SidebarThreadSummary =>
  ({
    id: ThreadId.make("child"),
    parentThreadId: ThreadId.make("parent"),
    isolation: "isolated",
    fanInState: "none",
    planLane: "in_progress",
    ...over,
  }) as unknown as SidebarThreadSummary;

describe("formatDiffMetric", () => {
  it("returns null when unmeasured (both null)", () => {
    expect(formatDiffMetric(null, null)).toBeNull();
  });
  it("renders a settled zero diff distinctly from unmeasured", () => {
    expect(formatDiffMetric(0, 0)).toBe("+0 −0");
  });
  it("sums added/deleted lines", () => {
    expect(formatDiffMetric(128, 40)).toBe("+128 −40");
    expect(formatDiffMetric(5, null)).toBe("+5 −0");
  });
});

describe("getFanInChip", () => {
  it("is null for shared threads", () => {
    expect(getFanInChip(summary({ isolation: "shared" }))).toBeNull();
  });
  it("shows an amber merge-conflict chip", () => {
    expect(getFanInChip(summary({ fanInState: "conflicted" }))).toEqual({
      label: "merge conflict",
      tone: "conflict",
    });
  });
  it("shows merged once settled", () => {
    expect(getFanInChip(summary({ fanInState: "completed" }))).toEqual({
      label: "merged",
      tone: "merged",
    });
  });
  it("shows merging while a done child's branch is still folding in", () => {
    expect(getFanInChip(summary({ planLane: "done", fanInState: "none" }))).toEqual({
      label: "merging…",
      tone: "merging",
    });
  });
  it("is null for a not-yet-terminal isolated child with nothing to show", () => {
    expect(getFanInChip(summary({ planLane: "in_progress", fanInState: "none" }))).toBeNull();
  });
});
