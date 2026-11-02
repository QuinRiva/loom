// loom: the timeline view's shared state (plan §4). `TimelineHost` publishes one thread's join here;
// each row selects only its own item, so a join rebuilt by a projection change re-renders nothing
// whose figure did not change. Jumps read the latest rows and handlers the host saw.
import type { LoomContextItem, RunId } from "@t3tools/contracts";
import { create } from "zustand";

import type { MessagesTimelineRow } from "../../../components/chat/MessagesTimeline.logic";
import type { TimelineRowSharedState } from "../../../components/chat/timelineRowContext";
import type { ContextJoin, RunContextFigure } from "../join";

/** An item is amber when it is large in absolute terms and against what its turn added. */
const AMBER_TOKENS = 5_000;
const AMBER_SHARE_OF_RUN = 0.03;

export type FigureCategory = "tool" | "thinking" | "written" | "message" | "fixed";

export const CATEGORY_OF: Record<LoomContextItem["kind"], FigureCategory> = {
  tool_result: "tool",
  assistant_thinking: "thinking",
  assistant_text: "written",
  tool_call_args: "written",
  user_message: "message",
  system_section: "fixed",
  tool_schema: "fixed",
  compaction_base: "fixed",
};

export const CATEGORY_LABEL: Record<FigureCategory, string> = {
  tool: "Tool output",
  thinking: "Thinking",
  written: "Written by the agent",
  message: "Message in",
  fixed: "Fixed overhead",
};

export const CATEGORY_BAR: Record<FigureCategory, string> = {
  tool: "bg-muted-foreground/50",
  thinking: "bg-indigo-400/70",
  written: "bg-teal-500/70",
  message: "bg-sky-500/70",
  fixed: "bg-muted-foreground/25",
};

export const AMBER_BAR = "bg-warning";

/** Tokens and count per category, in first-seen order. */
export function byCategory(
  items: ReadonlyArray<LoomContextItem>,
): Array<readonly [FigureCategory, { tokens: number; count: number }]> {
  const sums = new Map<FigureCategory, { tokens: number; count: number }>();
  for (const item of items) {
    const sum = sums.get(CATEGORY_OF[item.kind]) ?? { tokens: 0, count: 0 };
    sums.set(CATEGORY_OF[item.kind], { tokens: sum.tokens + item.tokens, count: sum.count + 1 });
  }
  return [...sums];
}

export interface TimelineFigures {
  readonly join: ContextJoin;
  readonly contextWindow: number | null;
  readonly amber: ReadonlySet<string>;
  readonly runOfItem: ReadonlyMap<string, RunId>;
  /** The row key (`nativeId`, or `user:<messageId>`) under which an item's row carries it. */
  readonly rowKeyOfItem: ReadonlyMap<string, string>;
}

const derived = new WeakMap<ContextJoin, TimelineFigures>();

/** One object per join and window, so publishing an unchanged join re-renders nothing. */
export function deriveTimelineFigures(
  join: ContextJoin,
  contextWindow: number | null,
): TimelineFigures {
  const cached = derived.get(join);
  if (cached) {
    if (cached.contextWindow === contextWindow) return cached;
    const figures = { ...cached, contextWindow };
    derived.set(join, figures);
    return figures;
  }
  const runEntries = [...join.runs].flatMap(([runId, run]) =>
    run.items.map((item) => [item, runId, run] as const),
  );
  const figures: TimelineFigures = {
    join,
    contextWindow,
    amber: new Set(runEntries.flatMap(([item, , run]) => (isAmber(item, run) ? [item.id] : []))),
    runOfItem: new Map(runEntries.map(([item, runId]) => [item.id, runId])),
    rowKeyOfItem: new Map([
      ...[...join.byNativeId].map(([nativeId, item]) => [item.id, nativeId] as const),
      ...[...join.byUserMessageId].map(([id, item]) => [item.id, `user:${id}`] as const),
    ]),
  };
  derived.set(join, figures);
  return figures;
}

const isAmber = (item: LoomContextItem, run: RunContextFigure) =>
  item.tokens >= AMBER_TOKENS && item.tokens >= run.addedTokens * AMBER_SHARE_OF_RUN;

const KEPT_THREADS = 4;

export const useTimelineFigureStore = create<{
  byThreadKey: Record<string, TimelineFigures>;
}>()(() => ({ byThreadKey: {} }));

interface Navigation {
  rows: ReadonlyArray<MessagesTimelineRow>;
  shared: Pick<TimelineRowSharedState, "listRef" | "onToggleTurnFold" | "onToggleWorkGroup">;
  /** An item whose turn was unfolded for it, scrolled to once its row exists. */
  pending: string | null;
}

const navigation = new Map<string, Navigation>();

export function publishTimelineFigures(
  key: string,
  figures: TimelineFigures,
  nav: Omit<Navigation, "pending">,
) {
  const { byThreadKey } = useTimelineFigureStore.getState();
  if (byThreadKey[key] !== figures) {
    const { [key]: _previous, ...rest } = byThreadKey;
    useTimelineFigureStore.setState({
      byThreadKey: Object.fromEntries(
        [...Object.entries(rest), [key, figures] as const].slice(-KEPT_THREADS),
      ),
    });
  }
  const pending = navigation.get(key)?.pending ?? null;
  navigation.set(key, { ...nav, pending: null });
  if (pending !== null) jumpToItem(key, pending, false);
}

const rowKeysCache = new WeakMap<ReadonlyArray<MessagesTimelineRow>, Map<string, number>>();

function rowKeys(row: MessagesTimelineRow): ReadonlyArray<string> {
  switch (row.kind) {
    case "work":
      return row.groupedEntries.flatMap(
        (entry) => entry.projectedItem?.item.nativeItemRef?.nativeId ?? [],
      );
    case "work-toggle":
      return row.nativeIds;
    case "message":
      return row.message.role === "user"
        ? [`user:${row.message.id}`]
        : [row.projectedItem?.item.nativeItemRef?.nativeId ?? []].flat();
    default:
      return [];
  }
}

function rowIndexOf(rows: ReadonlyArray<MessagesTimelineRow>, rowKey: string): number {
  let index = rowKeysCache.get(rows);
  if (!index) {
    index = new Map(rows.flatMap((row, at) => rowKeys(row).map((key) => [key, at] as const)));
    rowKeysCache.set(rows, index);
  }
  return index.get(rowKey) ?? -1;
}

/**
 * Scroll the timeline to the row behind an item: open its collapsed group, or unfold its turn
 * and finish the jump when the host next publishes rows that hold it. Never animated.
 */
export function jumpToItem(key: string, itemId: string, unfold = true): void {
  const nav = navigation.get(key);
  const figures = useTimelineFigureStore.getState().byThreadKey[key];
  const rowKey = figures?.rowKeyOfItem.get(itemId);
  if (!nav || !figures || rowKey === undefined) return;
  const index = rowIndexOf(nav.rows, rowKey);
  const row = nav.rows[index];
  if (row) {
    if (row.kind === "work-toggle" && !row.expanded)
      nav.shared.onToggleWorkGroup(row.groupId, row.id);
    void nav.shared.listRef.current?.scrollToIndex({ index, animated: false, viewOffset: 24 });
    return;
  }
  const runId = figures.runOfItem.get(itemId);
  const folded = nav.rows.some(
    (candidate) =>
      candidate.kind === "turn-fold" && candidate.runId === runId && !candidate.expanded,
  );
  if (!unfold || runId === undefined || !folded) return;
  nav.pending = itemId;
  nav.shared.onToggleTurnFold(runId);
}
