// loom: the timeline view's one mount beside the minimap (plan §4): while the Timeline switch is on,
// it loads the thread's report, joins it to the timeline, publishes the join for the row figures
// and draws the scrollbar. Switched off it reads no store and makes no request.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoomContextReport, ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import type { MessagesTimelineRow } from "../../../components/chat/MessagesTimeline.logic";
import type { TimelineRowSharedState } from "../../../components/chat/timelineRowContext";
import { useClientSettings } from "../../../hooks/useSettings";
import { useQuietThreadProjection } from "../../../state/entities";
import { useContextUsageLoader, useContextUsageReport } from "../contextUsageStore";
import { type ContextJoinThread, contextJoin } from "../join";
import { Rail } from "./Rail";
import { deriveTimelineFigures, publishTimelineFigures } from "./timelineFigures";

interface TimelineHostProps {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly shared: TimelineRowSharedState;
}

export function TimelineHost(props: TimelineHostProps) {
  const on = useClientSettings((settings) => settings.contextVizTimeline);
  const threadRef = props.shared.threadRef;
  return on && threadRef ? <TimelineHostOn threadRef={threadRef} {...props} /> : null;
}

function TimelineHostOn({
  threadRef,
  ...props
}: TimelineHostProps & { readonly threadRef: ScopedThreadRef }) {
  useContextUsageLoader(threadRef);
  const report = useContextUsageReport(threadRef);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const contextWindow =
    projection?.providerThreads.find(
      (providerThread) => providerThread.id === projection.thread.activeProviderThreadId,
    )?.contextUsage?.maxTokens ?? null;
  return report && projection ? (
    <TimelineFiguresHost
      figureKey={scopedThreadKey(threadRef)}
      report={report}
      thread={projection}
      contextWindow={contextWindow}
      {...props}
    />
  ) : null;
}

/** The host past its data sources; the preview renders it from fixtures. */
export function TimelineFiguresHost({
  figureKey,
  report,
  thread,
  contextWindow,
  rows,
  shared,
}: Omit<TimelineHostProps, "shared"> & {
  readonly shared: Pick<
    TimelineRowSharedState,
    "listRef" | "onToggleTurnFold" | "onToggleWorkGroup"
  >;
  readonly figureKey: string;
  readonly report: LoomContextReport;
  readonly thread: ContextJoinThread;
  readonly contextWindow: number | null;
}) {
  const figures = deriveTimelineFigures(contextJoin(report, thread), contextWindow);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this timeline's figures and navigation to the store the Context tab and Heaviest menu read
  useEffect(() => {
    publishTimelineFigures(figureKey, figures, { rows, shared });
  }, [figureKey, figures, rows, shared]);
  return (
    <Rail
      figureKey={figureKey}
      report={report}
      figures={figures}
      rows={rows}
      listRef={shared.listRef}
    />
  );
}
