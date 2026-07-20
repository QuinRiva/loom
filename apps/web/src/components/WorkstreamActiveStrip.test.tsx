import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ChildIndex } from "../lib/workstreamPresentation";
import type { SidebarThreadSummary } from "../types";
import { WorkstreamActiveStrip } from "./WorkstreamActiveStrip";

const summary = (over: Partial<SidebarThreadSummary>): SidebarThreadSummary =>
  ({
    id: ThreadId.make("child"),
    parentThreadId: ThreadId.make("parent"),
    title: "Session store",
    role: "coder",
    modelSelection: { instanceId: ProviderInstanceId.make("vertex"), model: "claude-opus-4-8" },
    toolUses: null,
    cumulativeCostUsd: undefined,
    lastActivityPreview: null,
    attention: [],
    planLane: "in_progress",
    blockedBy: [],
    kickoffBriefPath: "/b.md",
    session: { status: "running" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as unknown as SidebarThreadSummary;

const render = (thread: SidebarThreadSummary) => {
  const byId: ChildIndex = new Map([[thread.id, thread]]);
  return renderToStaticMarkup(
    <WorkstreamActiveStrip threads={[thread]} threadById={byId} onOpenThread={() => {}} />,
  );
};

describe("WorkstreamActiveStrip", () => {
  it("renders the turn line preview and a full meta row when data is present", () => {
    const markup = render(
      summary({
        lastActivityPreview: "Editing sessionStore.ts",
        cumulativeCostUsd: 1.43,
        toolUses: 16,
      }),
    );
    expect(markup).toContain("› Editing sessionStore.ts");
    expect(markup).toContain("vertex"); // provider pill
    expect(markup).toContain("$1.43");
    expect(markup).toContain("⚒ 16");
  });

  it("falls back to starting… and omits null cost/tool meta segments", () => {
    const markup = render(
      summary({ lastActivityPreview: null, cumulativeCostUsd: undefined, toolUses: null }),
    );
    expect(markup).toContain("starting…");
    expect(markup).not.toContain("$");
    expect(markup).not.toContain("⚒");
  });
});
