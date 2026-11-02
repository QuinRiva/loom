// loom: the Growth view's preview fixtures (plan §10), spread into the context-viz preview group.
// The orchestrator is P2's 58-turn report; the child is P1's reader over a one-turn, 75-call child
// session, labels scrubbed the same way.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, LoomContextReport, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type { ReactNode } from "react";

import type { PreviewFixture } from "../../../preview/fixtures";
import { ContextPanelView } from "../ContextPanel";
import orchestratorJson from "../preview/report.fixture.json";
import childJson from "./child-report.fixture.json";
import { GrowthView, type GrowthViewState } from "./GrowthView";

const decode = Schema.decodeUnknownSync(LoomContextReport);
const orchestrator = decode(orchestratorJson);
const child = decode(childJson);
const threadRef = scopeThreadRef("preview-env" as EnvironmentId, ThreadId.make("preview-growth"));

function Frame({
  wide = false,
  children,
}: {
  readonly wide?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border border-border bg-background p-4 ${wide ? "w-[1100px]" : "w-[480px]"}`}
    >
      {children}
    </div>
  );
}

// Keyed by fixture: the harness reuses the element across fixtures, which would keep the state.
const growth = (
  id: string,
  report: LoomContextReport,
  initial: Partial<GrowthViewState> = {},
  wide = false,
) => (
  <Frame key={id} wide={wide}>
    <GrowthView report={report} threadRef={threadRef} contextWindow={1_000_000} initial={initial} />
  </Frame>
);

export const GROWTH_PREVIEW_FIXTURES: ReadonlyArray<PreviewFixture> = [
  {
    id: "loom-context-viz-growth",
    title: "Growth: per call, mute under 5.0K",
    description:
      "The 58-turn orchestrator: peak 685K, the dashed line without the avoidable items ending at 441K, T7's burst of echoes labelled, the biggest step beside.",
    render: () => growth("default", orchestrator),
  },
  {
    id: "loom-context-viz-growth-pinned",
    title: "Growth: mute under 2.0K, call #50 pinned",
    description: "A pinned step fills the panel and parks the conversation jump at its first item.",
    render: () => growth("pinned", orchestrator, { mute: 2_000, pinned: 50 }),
  },
  {
    id: "loom-context-viz-growth-lit",
    title: "Growth: mute under 10K, the echo finding lit",
    description: "Clicking a finding lights its calls; the panel lists its items.",
    render: () => growth("lit", orchestrator, { mute: 10_000, litKey: "write_tool_echo" }),
  },
  {
    id: "loom-context-viz-growth-turns",
    title: "Growth: per turn, wide panel",
    description:
      "Steps per turn: +66K goal_* tools at T7; findings and the biggest step side by side.",
    render: () => growth("turns", orchestrator, { perTurn: true }, true),
  },
  {
    id: "loom-context-viz-growth-child",
    title: "Growth: a child thread, one turn of 75 calls",
    description:
      "Per call still tells the story: the whole-file reads at #3 to #8 and the agent-guidance finding lit.",
    render: () => growth("child", child, { litKey: "whole_file_read" }),
  },
  {
    id: "loom-context-viz-growth-alone",
    title: "Context tab: Growth alone",
    description: "Composition switched off: no sub-view switch, the tab holds Growth.",
    render: () => (
      <div className="flex h-[720px] w-[480px] flex-col rounded-lg border border-border bg-background">
        <ContextPanelView
          threadRef={threadRef}
          entry={{ status: "ready", report: child, refreshKey: "preview" }}
          piThread
          composition={false}
          growth
          turns={1}
          contextWindow={1_000_000}
          onRefresh={() => undefined}
        />
      </div>
    ),
  },
];
