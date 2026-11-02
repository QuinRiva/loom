// loom: the timeline view's preview fixtures (plan §10): Loom's real row components, fed the 58-turn
// orchestrator's report and that thread's own timeline items (`join.fixture.json`), with the join
// published as `TimelineHost` would publish it. Turn 52 is the mockup's "+34.6K" turn.
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentId,
  LoomContextReport,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { type ReactNode, useState } from "react";

import type { MessagesTimelineRow } from "../../../components/chat/MessagesTimeline.logic";
import { AssistantTimelineRow } from "../../../components/chat/TimelineAssistantRows";
import {
  TimelineRowCtx,
  type TimelineRowSharedState,
  type TimelineWorkEntry,
} from "../../../components/chat/timelineRowContext";
import { SimpleWorkEntryRow } from "../../../components/chat/TimelineWorkEntryRow";
import {
  WorkGroupSection,
  WorkGroupToggleTimelineRow,
} from "../../../components/chat/TimelineWorkGroupRows";
import { WorkLogBlock } from "../../../components/chat/WorkLog";
import { Button } from "../../../components/ui/button";
import type { PreviewFixture } from "../../../preview/fixtures";
import { TimelineLayoutFrame } from "../../../preview/TimelineLayoutFrame";
import { type ContextJoinThread, contextJoin } from "../join";
import timelineJson from "../join.fixture.json";
import reportJson from "../preview/report.fixture.json";
import { TimelineFiguresHost } from "./TimelineHost";
import { TurnHeaderFigure } from "./TurnHeaderFigure";
import { deriveTimelineFigures, publishTimelineFigures } from "./timelineFigures";

const report = Schema.decodeUnknownSync(LoomContextReport)(reportJson);
const timeline = timelineJson as unknown as {
  runs: ReadonlyArray<[string, string]>;
  attempts: ReadonlyArray<[string, string]>;
  providerTurns: ReadonlyArray<[string, string, string, string]>;
  turnItems: ReadonlyArray<[string, string, string, number, string]>;
};
const thread = {
  runs: timeline.runs.map(([id, userMessageId]) => ({ id, userMessageId })),
  attempts: timeline.attempts.map(([id, runId]) => ({ id, runId })),
  providerTurns: timeline.providerTurns.map(([id, runAttemptId, startedAt, completedAt]) => ({
    id,
    runAttemptId,
    startedAt: DateTime.makeUnsafe(startedAt),
    completedAt: DateTime.makeUnsafe(completedAt),
  })),
  turnItems: timeline.turnItems.map(([type, runId, providerTurnId, ordinal, nativeId]) => ({
    type,
    runId,
    providerTurnId,
    ordinal,
    nativeItemRef: { nativeId },
  })),
} as unknown as ContextJoinThread;

const environmentId = "preview-env" as EnvironmentId;
const threadRef = scopeThreadRef(environmentId, ThreadId.make("preview-context-viz-timeline"));
const noop = () => undefined;
const shared = {
  threadRef,
  activeThreadEnvironmentId: environmentId,
  timestampFormat: "24-hour",
  routeThreadKey: "preview",
  resolvedTheme: "dark",
  markdownCwd: undefined,
  workspaceRoot: undefined,
  skills: [],
  runs: [],
  citationRequest: null,
  listRef: { current: null },
  findActive: false,
  retryableWorkspacePreparationRunIds: new Set(),
  onRetryWorkspacePreparation: null,
  onImageExpand: noop,
  onOpenThread: noop,
  onOpenTurnDiff: undefined,
  onToggleWorkGroup: noop,
  onToggleWorkEntry: noop,
  onToggleTurnFold: noop,
  onUseArtifactTemplate: noop,
  onRunShellCommand: undefined,
  onForkFromRun: undefined,
  turnItemSource: undefined,
  workGroupViewState: { scrollPositions: new Map(), expandedEntries: new Set() },
} as unknown as TimelineRowSharedState;

publishTimelineFigures(
  scopedThreadKey(threadRef),
  deriveTimelineFigures(contextJoin(report, thread), 1_000_000),
  { rows: [], shared },
);

const RUN_52 = "run-52" as RunId;
const AT = "2026-10-28T05:04:59.705Z";
const labelOf = (nativeId: string) => report.items.find((item) => item.id === nativeId)?.label;

function entry(
  nativeId: string,
  type: "command_execution" | "dynamic_tool" | "reasoning",
  label = labelOf(nativeId) ?? nativeId,
): TimelineWorkEntry {
  const reasoning = type === "reasoning";
  return {
    id: `entry-${nativeId}`,
    createdAt: AT,
    runId: RUN_52,
    label,
    tone: reasoning ? "thinking" : "tool",
    itemType: type,
    ...(reasoning ? { detail: label } : { command: label }),
    projectedItem: {
      visibility: "visible",
      item: {
        type,
        status: "completed",
        runId: RUN_52,
        nativeItemRef: { driver: "pi", nativeId, strength: "strong" },
        ...(reasoning ? { text: label } : { input: label, output: "" }),
      },
    } as unknown as OrchestrationV2ProjectedTurnItem,
  } as TimelineWorkEntry;
}

const turn52Entries = [
  entry("turn-52:m1:c0", "reasoning", "Checking the three task rows before the update."),
  entry("toolu_01YaXbt4HtQnBSfPiKrVRSej", "command_execution"),
  entry("toolu_01QhcUnyswd9yi1VmFV8aUzS", "command_execution"),
  entry("toolu_01VvtLgv3V1Tmadyc1aZiFRa", "dynamic_tool"),
  entry("toolu_017QLHUGbRChuZxye1sTzGms", "dynamic_tool"),
  entry("toolu_01Jz8wcxaJMzvqXAJ4SjBhjf", "dynamic_tool"),
];

const nativeIdsOf = (entries: ReadonlyArray<TimelineWorkEntry>) =>
  entries.flatMap((one) => one.projectedItem?.item.nativeItemRef?.nativeId ?? []);

function Rows({ children }: { readonly children: ReactNode }) {
  return (
    <div className="h-[420px] w-[760px] rounded-lg border border-border bg-background">
      <TimelineRowCtx value={shared}>
        <TimelineLayoutFrame>{children}</TimelineLayoutFrame>
      </TimelineRowCtx>
    </div>
  );
}

const groupToggle = (expanded: boolean): Extract<MessagesTimelineRow, { kind: "work-toggle" }> => ({
  kind: "work-toggle",
  id: "work-toggle:turn-52",
  createdAt: AT,
  runId: RUN_52,
  groupId: "group-turn-52",
  hiddenCount: turn52Entries.length,
  expanded,
  summary: "Ran 2 commands and used 3 tools",
  summaryKind: "mixed",
  hasFailure: false,
  nativeIds: nativeIdsOf(turn52Entries),
});

/** A replica of `TurnFoldTimelineRow`'s frame, which `MessagesTimeline.tsx` does not export. */
function TurnFold({ menuOpen }: { readonly menuOpen: boolean }) {
  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-b border-border/60 pb-2 pe-0.5 pt-1">
      <span className="px-1 text-sm leading-relaxed text-muted-foreground tabular-nums">
        Worked for 6m 12s
      </span>
      <TurnHeaderFigure runId={RUN_52} defaultMenuOpen={menuOpen} />
    </div>
  );
}

const assistantRow = (
  nativeId: string,
  text: string,
): Extract<MessagesTimelineRow, { kind: "message" }> =>
  ({
    kind: "message",
    id: `message-${nativeId}`,
    createdAt: AT,
    message: {
      id: `assistant-${nativeId}` as MessageId,
      role: "assistant",
      text,
      createdAt: AT,
      updatedAt: AT,
      streaming: false,
    },
    projectedItem: {
      visibility: "visible",
      item: {
        type: "assistant_message",
        status: "completed",
        runId: RUN_52,
        nativeItemRef: { nativeId },
      },
    },
    durationStart: AT,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
  }) as unknown as Extract<MessagesTimelineRow, { kind: "message" }>;

const railRows = thread.runs.map((run) => ({
  kind: "message",
  id: run.userMessageId,
  message: { id: run.userMessageId, role: "user" },
})) as unknown as ReadonlyArray<MessagesTimelineRow>;

/** Steps the turn being read, as scrolling would, so the outline's re-render can be timed. */
function RailFrame() {
  const [currentRow, setCurrentRow] = useState(29);
  return (
    <div className="relative h-[640px] w-[1102px] rounded-lg border border-border bg-background">
      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
        <Button
          size="xs"
          variant="outline"
          onClick={() => setCurrentRow((row) => Math.max(0, row - 1))}
        >
          Previous turn
        </Button>
        <Button
          size="xs"
          variant="outline"
          onClick={() => setCurrentRow((row) => Math.min(railRows.length - 1, row + 1))}
        >
          Next turn
        </Button>
        Reading turn {currentRow + 1}
      </div>
      <TimelineFiguresHost
        figureKey="preview-context-viz-rail"
        report={report}
        thread={thread}
        contextWindow={1_000_000}
        rows={railRows}
        shared={shared}
        currentRow={currentRow}
      />
    </div>
  );
}

export const TIMELINE_PREVIEW_FIXTURES: ReadonlyArray<PreviewFixture> = [
  {
    id: "loom-context-viz-timeline-rows",
    title: "Timeline: work rows with and without a figure",
    description:
      "Turn 52's rows through the real `SimpleWorkEntryRow`: thinking (exact, from its reasoning usage), a 3.2K command, an 18-token command, three goal_task_update echoes at 8.8K (amber: ≥5K and ≥3% of the turn's +34.6K), then a row the report has no figure for, and an assistant message (≈, split by characters). Hover a figure for its card.",
    render: () => (
      <Rows>
        <WorkLogBlock>
          <WorkGroupSection anchorKey="rows" groupedEntries={turn52Entries} isExpandedToolGroup />
        </WorkLogBlock>
        <WorkLogBlock>
          <SimpleWorkEntryRow
            workEntry={entry(
              "toolu_not_in_the_report",
              "command_execution",
              "git status (no figure)",
            )}
            workspaceRoot={undefined}
          />
        </WorkLogBlock>
        <AssistantTimelineRow
          row={assistantRow(
            "turn-52:m6:c0",
            "Three rows updated. Next I will hand the outcome back and prompt the reviewer with the new scope.",
          )}
        />
      </Rows>
    ),
  },
  {
    id: "loom-context-viz-timeline-group",
    title: "Timeline: a collapsed group header with largest …",
    description:
      "The real `WorkGroupToggleTimelineRow` for turn 52's six rows: their total as a stacked hairline and the largest row named; expanded below.",
    render: () => (
      <Rows>
        <WorkLogBlock layout="group-header">
          <WorkGroupToggleTimelineRow row={groupToggle(false)} />
        </WorkLogBlock>
        <WorkLogBlock layout="group-header">
          <WorkGroupToggleTimelineRow row={groupToggle(true)} />
        </WorkLogBlock>
        <WorkLogBlock layout="group-content">
          <WorkGroupSection anchorKey="group" groupedEntries={turn52Entries} isExpandedToolGroup />
        </WorkLogBlock>
      </Rows>
    ),
  },
  {
    id: "loom-context-viz-timeline-turn",
    title: "Timeline: turn header with the Heaviest menu open",
    description:
      "Turn 52's header: the window before and after, +34.6K and its share of 1M; the menu lists the turn's five heaviest items and jumps to each row.",
    render: () => (
      <Rows>
        <TurnFold menuOpen />
        <div className="h-64" />
      </Rows>
    ),
  },
  {
    id: "loom-context-viz-timeline-rail",
    title: "Timeline: the rail at 58 turns",
    description:
      "685K in session order, amber where a row is amber, turn 30 outlined as the turn being read. The frame is 1,100 px wide, the narrowest width that shows it.",
    render: () => <RailFrame />,
  },
];
