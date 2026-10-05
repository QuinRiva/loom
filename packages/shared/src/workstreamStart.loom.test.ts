import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isEligibleToStart, type StartNode } from "./workstreamStart.loom.ts";

const node = (id: string, overrides: Partial<StartNode> = {}): StartNode => ({
  id: id as ThreadId,
  parentThreadId: "parent" as ThreadId,
  held: false,
  outcome: null,
  kickoffAt: null,
  kickoffBriefPath: "/briefs/b.md",
  blockedBy: [],
  archivedAt: null,
  deletedAt: null,
  ...overrides,
});

describe("isEligibleToStart", () => {
  it("releases on an archived done dependency and ignores a deleted (absent) one; an open dependency gates", () => {
    const dep = node("dep", { outcome: "done", archivedAt: "2026-10-05T00:00:00Z" });
    const child = node("child", { blockedBy: [dep.id, "gone" as ThreadId] });
    expect(isEligibleToStart(child, new Map([dep, child].map((n) => [n.id, n])))).toBe(true);
    const open = node("dep", { outcome: null });
    expect(isEligibleToStart(child, new Map([open, child].map((n) => [n.id, n])))).toBe(false);
  });
});
