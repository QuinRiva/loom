// loom: the Context right-panel tab (plan §3.5): a header over whichever of Composition and Growth
// is switched on. The sub-view choice is tier 4, forgotten on close; the tab mounts the loader.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useQuietThreadProjection } from "../../state/entities";
import { Button } from "../../components/ui/button";
import { RefreshIcon } from "../../components/ui/refresh-icon";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { CompositionView } from "./composition/CompositionView";
import {
  type ContextUsageEntry,
  isPiThread,
  refreshContextUsage,
  useContextUsage,
  useContextUsageLoader,
} from "./contextUsageStore";
import { formatContextTokens, formatShare } from "./format";
import { GrowthView } from "./growth/GrowthView";

// The header re-renders with the projection; the sub-views only when their props change.
const Composition = memo(CompositionView);
const Growth = memo(GrowthView);

type SubView = "composition" | "growth";

export interface ContextPanelViewProps {
  readonly threadRef: ScopedThreadRef;
  readonly entry: ContextUsageEntry | null;
  readonly piThread: boolean;
  readonly composition: boolean;
  readonly growth: boolean;
  readonly turns: number;
  readonly contextWindow: number | null;
  readonly onRefresh: () => void;
}

export default function ContextPanel({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const composition = useClientSettings((settings) => settings.contextVizComposition);
  const growth = useClientSettings((settings) => settings.contextVizGrowth);
  // Switched off, the tab is on its way out: no request, no projection read.
  const liveRef = composition || growth ? threadRef : null;
  useContextUsageLoader(liveRef);
  const thread = useQuietThreadProjection(liveRef);
  const projection = thread?.projection;
  return (
    <ContextPanelView
      threadRef={threadRef}
      entry={useContextUsage(liveRef)}
      piThread={isPiThread(thread)}
      composition={composition}
      growth={growth}
      turns={projection?.runs.length ?? 0}
      contextWindow={
        projection?.providerThreads.find(
          (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
        )?.contextUsage?.maxTokens ?? null
      }
      onRefresh={() => refreshContextUsage(threadRef)}
    />
  );
}

export function ContextPanelView(props: ContextPanelViewProps) {
  const { entry, contextWindow } = props;
  const [chosen, setChosen] = useState<SubView>("composition");
  const report = entry?.report ?? null;
  const subView: SubView | null =
    props.composition && props.growth
      ? chosen
      : props.composition
        ? "composition"
        : props.growth
          ? "growth"
          : null;
  const latestCtx = report?.totals.latestCtx ?? 0;
  const share = formatShare(latestCtx, contextWindow);
  const message =
    subView === null
      ? "Turn on Composition or Growth under Settings → Behavior → Context diagnostics."
      : !props.piThread && entry === null
        ? "No context breakdown for this thread: it does not run on pi."
        : report !== null
          ? null
          : entry?.status === "none"
            ? "No context breakdown for this thread: its pi session file was not found."
            : entry?.status === "failed"
              ? "No context breakdown for this thread: reading its session file failed."
              : "Reading the session file…";

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/60 pb-3">
        <h2 className="min-w-0 flex-1 text-sm font-medium text-foreground">Context</h2>
        {props.composition && props.growth ? (
          <ToggleGroup
            aria-label="Context view"
            variant="segmented"
            value={[chosen]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "composition" || value === "growth") setChosen(value);
            }}
          >
            <Toggle value="composition">Composition</Toggle>
            <Toggle value="growth">Growth</Toggle>
          </ToggleGroup>
        ) : null}
        <Button
          variant="ghost-muted"
          size="icon-xs"
          aria-label="Refresh the context breakdown"
          disabled={entry === null || entry.status === "loading"}
          onClick={props.onRefresh}
        >
          <RefreshIcon />
        </Button>
        {report ? (
          <p className="w-full text-xs text-muted-foreground">
            As of the latest call: {formatContextTokens(latestCtx)}
            {contextWindow ? ` of ${formatContextTokens(contextWindow)}` : ""}
            {share ? ` (${share})` : ""} · {report.calls.filter((call) => call.valid).length} calls
            · {props.turns} {props.turns === 1 ? "turn" : "turns"}
            {report.model ? ` · ${report.model}` : ""}
          </p>
        ) : null}
      </div>
      {message !== null || report === null ? (
        <p className="text-sm text-muted-foreground/70">{message}</p>
      ) : subView === "composition" ? (
        <Composition report={report} threadRef={props.threadRef} contextWindow={contextWindow} />
      ) : (
        <Growth report={report} threadRef={props.threadRef} contextWindow={contextWindow} />
      )}
    </div>
  );
}
