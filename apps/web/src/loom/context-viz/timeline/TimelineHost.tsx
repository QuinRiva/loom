// loom: the timeline view's one mount beside the minimap (plan §4): while the Timeline switch is on,
// it loads the thread's report, joins it to the timeline, publishes the join for the row figures
// and draws the rail. Switched off it reads no store and makes no request.
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
  /** The row of the prompt the minimap marks as being read. */
  readonly currentRow: number | null;
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
  currentRow,
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
  useEffect(() => {
    publishTimelineFigures(figureKey, figures, { rows, shared });
  }, [figureKey, figures, rows, shared]);
  const current = currentRow === null ? undefined : rows[currentRow];
  const currentRunId =
    current?.kind === "message"
      ? (thread.runs.find((run) => run.userMessageId === current.message.id)?.id ?? null)
      : null;
  return (
    <Rail figureKey={figureKey} report={report} figures={figures} currentRunId={currentRunId} />
  );
}
