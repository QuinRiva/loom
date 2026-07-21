import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ChildIndex } from "../lib/workstreamPresentation";
import type { SidebarThreadSummary } from "../types";
import { WorkstreamQuickFacts } from "./WorkstreamQuickFacts";

const EMPTY_INDEX: ChildIndex = new Map();

// The card reads a broad slice of the shell; build a minimal object and cast,
// matching the lib tests' fixture convention.
const summary = (over: Partial<SidebarThreadSummary>): SidebarThreadSummary =>
  ({
    id: ThreadId.make("child"),
    parentThreadId: ThreadId.make("parent"),
    title: "Session store",
    role: "coder",
    purpose: "Replace the in-memory session map with a Redis-backed store.",
    modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "vertex/claude-opus-4-8" },
    toolUses: null,
    cumulativeCostUsd: undefined,
    lastActivityPreview: null,
    routes: [],
    gateRounds: 0,
    fanInState: "none",
    isolation: "isolated",
    forkFromThreadId: null,
    attention: [],
    planLane: "in_progress",
    blockedBy: [],
    kickoffBriefPath: "/b.md",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  }) as unknown as SidebarThreadSummary;

const render = (thread: SidebarThreadSummary) =>
  renderToStaticMarkup(<WorkstreamQuickFacts thread={thread} threadById={EMPTY_INDEX} />);

describe("WorkstreamQuickFacts", () => {
  it("renders tool calls, the provider pill, cost and the turn line for a running thread", () => {
    const markup = render(
      summary({
        toolUses: 16,
        cumulativeCostUsd: 1.43,
        lastActivityPreview: "Editing sessionStore.ts",
        latestTurn: { state: "running" } as never,
      }),
    );
    expect(markup).toContain("⚒ 16");
    expect(markup).toContain("vertex"); // pill provider
    expect(markup).toContain("$1.43");
    expect(markup).toContain("›");
    expect(markup).toContain("Editing sessionStore.ts");
    // Goal is shown in full — no line clamp on the purpose block.
    expect(markup).not.toContain("line-clamp-3");
  });

  it("degrades honestly for a not-yet-run planned thread", () => {
    const markup = render(summary({ planLane: "planned", toolUses: null, kickoffBriefPath: null }));
    expect(markup).toContain("not started yet");
    expect(markup).toContain("no turns yet");
    expect(markup).toContain("—");
  });

  it("footer hint points to right-click actions, not the removed ⓘ", () => {
    const markup = render(summary({}));
    expect(markup).toContain("right-click for actions");
    expect(markup).not.toContain("ⓘ");
  });
});
