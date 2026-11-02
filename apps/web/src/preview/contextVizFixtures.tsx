/**
 * loom: the context-viz experiment's preview group (plans/context-viz-experiment §10), rendered
 * from `report.fixture.json`: P1's reader over a real 58-turn orchestrator session, labels scrubbed.
 * P3 to P5 append their fixtures to `CONTEXT_VIZ_PREVIEW_GROUP.fixtures`.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, LoomContextReport, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";

import { ContextPanelView, type ContextPanelViewProps } from "../loom/context-viz/ContextPanel";
import type { ContextUsageEntry } from "../loom/context-viz/contextUsageStore";
import { ContextVizSettingsRows } from "../loom/context-viz/ContextVizSettingsRows";
import reportJson from "../loom/context-viz/preview/report.fixture.json";
import type { PreviewGroup } from "./fixtures";

const contextVizPreviewReport = Schema.decodeUnknownSync(LoomContextReport)(reportJson);
const contextVizPreviewThreadRef = scopeThreadRef(
  "preview-env" as EnvironmentId,
  ThreadId.make("preview-context-viz"),
);

const ready: ContextUsageEntry = {
  status: "ready",
  report: contextVizPreviewReport,
  refreshKey: "preview",
};

function PanelFrame({
  short,
  children,
}: {
  readonly short: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={`flex w-[480px] flex-col rounded-lg border border-border bg-background ${short ? "h-44" : "h-[560px]"}`}
    >
      {children}
    </div>
  );
}

function Panel({ short = false, ...props }: Partial<ContextPanelViewProps> & { short?: boolean }) {
  return (
    <PanelFrame short={short}>
      <ContextPanelView
        threadRef={contextVizPreviewThreadRef}
        entry={ready}
        piThread
        composition
        growth
        turns={58}
        contextWindow={1_000_000}
        onRefresh={() => undefined}
        {...props}
      />
    </PanelFrame>
  );
}

function SettingsRows() {
  const [settings, setSettings] = useState({
    contextVizTimeline: true,
    contextVizComposition: true,
    contextVizGrowth: false,
  });
  return (
    <div className="w-[640px] rounded-xl border border-border bg-card">
      <ContextVizSettingsRows
        settings={settings}
        updateSettings={(patch) => setSettings((current) => ({ ...current, ...patch }))}
      />
    </div>
  );
}

export const CONTEXT_VIZ_PREVIEW_GROUP: PreviewGroup = {
  id: "loom-context-viz",
  title: "Context diagnostics",
  fixtures: [
    {
      id: "loom-context-viz-settings",
      title: "Settings rows",
      description:
        "The three per-device switches in Settings → Behavior; Growth is off here so its reset button shows.",
      render: () => <SettingsRows />,
    },
    {
      id: "loom-context-viz-panel",
      title: "Context tab: both panel views on",
      description:
        "Header from the fixture report (242 calls, 685K of 1M) with the Composition | Growth switch over the sub-view stubs P4 and P5 fill.",
      render: () => <Panel />,
    },
    {
      id: "loom-context-viz-panel-states",
      title: "Context tab: empty states",
      description:
        "Loading, no session file, a failed read, a thread not on pi, and both panel switches off.",
      render: () => (
        <div className="flex flex-wrap gap-4">
          <Panel short entry={{ status: "loading", report: null, refreshKey: "preview" }} />
          <Panel short entry={{ status: "none", report: null, refreshKey: "preview" }} />
          <Panel short entry={{ status: "failed", report: null, refreshKey: "preview" }} />
          <Panel short entry={null} piThread={false} />
          <Panel short composition={false} growth={false} />
        </div>
      ),
    },
  ],
};
