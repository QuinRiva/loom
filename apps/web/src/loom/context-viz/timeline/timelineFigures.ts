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

export type FigureCategory = "tool" | "written" | "thinking" | "text" | "message" | "fixed";

export const CATEGORY_OF: Record<LoomContextItem["kind"], FigureCategory> = {
  tool_result: "tool",
  tool_call_args: "written",
  assistant_thinking: "thinking",
  assistant_text: "text",
  user_message: "message",
  system_section: "fixed",
  tool_schema: "fixed",
  compaction_base: "fixed",
};

export const CATEGORY_LABEL: Record<FigureCategory, string> = {
  tool: "Tool results",
  written: "Written into tool calls",
  thinking: "Thinking",
  text: "Assistant text",
  message: "Incoming messages",
  fixed: "System prompt and tools",
};

export const CATEGORY_BAR: Record<FigureCategory, string> = {
  tool: "bg-muted-foreground/50",
  written: "bg-violet-400/70",
  thinking: "bg-indigo-400/70",
  text: "bg-teal-500/70",
  message: "bg-sky-500/70",
  fixed: "bg-muted-foreground/25",
};

export const AMBER_BAR = "bg-warning";

/** Tokens and count per category, heaviest first. */
export function byCategory(
  items: ReadonlyArray<LoomContextItem>,
): Array<readonly [FigureCategory, { tokens: number; count: number }]> {
  const sums = new Map<FigureCategory, { tokens: number; count: number }>();
  for (const item of items) {
    const sum = sums.get(CATEGORY_OF[item.kind]) ?? { tokens: 0, count: 0 };
    sums.set(CATEGORY_OF[item.kind], { tokens: sum.tokens + item.tokens, count: sum.count + 1 });
  }
  return [...sums].toSorted((a, b) => b[1].tokens - a[1].tokens);
}

/** An item's name in a list: its tool call's label, or what kind of system text it is. */
export const itemTitle = (item: LoomContextItem) =>
  item.kind === "system_section"
    ? `System prompt section: ${item.label}`
    : item.kind === "tool_schema"
      ? `Tool definition: ${item.label.replace(/^mcp__.+?__/, "")}`
      : item.label;

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
      ...[...join.argsOfTool].map(([toolCallId, item]) => [item.id, toolCallId] as const),
    ]),
  };
  derived.set(join, figures);
  return figures;
}

const isAmber = (item: LoomContextItem, run: RunContextFigure) =>
  item.tokens >= AMBER_TOKENS && item.tokens >= run.addedTokens * AMBER_SHARE_OF_RUN;

export const KEPT_THREADS = 4;

export const useTimelineFigureStore = create<{
  byThreadKey: Record<string, TimelineFigures>;
}>()(() => ({ byThreadKey: {} }));

interface Navigation {
  rows: ReadonlyArray<MessagesTimelineRow>;
  shared: Pick<TimelineRowSharedState, "listRef" | "onToggleTurnFold" | "onToggleWorkGroup">;
  /** An item whose turn was unfolded for it, scrolled to once its row exists. */
  pending: LoomContextItem | null;
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

export function rowKeys(row: MessagesTimelineRow): ReadonlyArray<string> {
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

interface RunRows {
  /** The first row naming the run. */
  readonly first: number;
  /** Its collapsed `turn-fold` row, when the turn is folded. */
  readonly fold: number | null;
}

const runRowsCache = new WeakMap<ReadonlyArray<MessagesTimelineRow>, Map<RunId, RunRows>>();

/** The runs the loaded rows name, which history pages in from the end of the session. */
function loadedRuns(rows: ReadonlyArray<MessagesTimelineRow>): ReadonlyMap<RunId, RunRows> {
  const cached = runRowsCache.get(rows);
  if (cached) return cached;
  const runs = new Map<RunId, RunRows>();
  rows.forEach((row, index) => {
    const runId =
      row.kind === "turn-fold" || row.kind === "attempt-fold" || row.kind === "work-toggle"
        ? row.runId
        : row.kind === "message"
          ? row.message.runId
          : null;
    if (!runId) return;
    const fold = row.kind === "turn-fold" && !row.expanded ? index : null;
    const known = runs.get(runId);
    runs.set(runId, { first: known?.first ?? index, fold: known?.fold ?? fold });
  });
  runRowsCache.set(rows, runs);
  return runs;
}

/** Every landing names a row a drag can scroll to; only `kind` differs in what a click does. */
export type ItemLanding =
  | { readonly kind: "row"; readonly index: number }
  | { readonly kind: "folded"; readonly index: number; readonly runId: RunId }
  /** The run's first row: a superseded attempt or a steer segment hides the item. */
  | { readonly kind: "hidden"; readonly index: number }
  /** System prompt, tool schemas, compaction base: no row anywhere. */
  | { readonly kind: "fixed"; readonly index: 0 }
  /** A turn history has not paged in yet. */
  | { readonly kind: "unloaded"; readonly index: 0 };

/** Where an item lands in the rows the host last published; null before it has published. */
export function landingOf(key: string, item: LoomContextItem): ItemLanding | null {
  const nav = navigation.get(key);
  const figures = useTimelineFigureStore.getState().byThreadKey[key];
  if (!nav || !figures) return null;
  const rowKey = figures.rowKeyOfItem.get(item.id);
  const index = rowKey === undefined ? -1 : rowIndexOf(nav.rows, rowKey);
  if (index >= 0) return { kind: "row", index };
  const runId = figures.runOfItem.get(item.id);
  const run = runId === undefined ? undefined : loadedRuns(nav.rows).get(runId);
  if (runId !== undefined && run)
    return run.fold === null
      ? { kind: "hidden", index: run.first }
      : { kind: "folded", index: run.fold, runId };
  return { kind: CATEGORY_OF[item.kind] === "fixed" ? "fixed" : "unloaded", index: 0 };
}

export function scrollToRow(key: string, index: number, viewPosition: number): void {
  void navigation
    .get(key)
    ?.shared.listRef.current?.scrollToIndex({ index, animated: false, viewPosition });
}

/**
 * Scroll the timeline to the row behind an item: open its collapsed group, or unfold its turn
 * and finish the jump when the host next publishes rows that hold it. Never animated. Returns the
 * landing it acted on; "fixed" and "unloaded" it leaves to the caller.
 */
export function jumpToItem(key: string, item: LoomContextItem, unfold = true): ItemLanding | null {
  const nav = navigation.get(key);
  const landing = landingOf(key, item);
  if (!nav || !landing) return null;
  const row = nav.rows[landing.index];
  if (landing.kind === "row" || landing.kind === "hidden") {
    if (landing.kind === "row" && row?.kind === "work-toggle" && !row.expanded)
      nav.shared.onToggleWorkGroup(row.groupId, row.id);
    void nav.shared.listRef.current?.scrollToIndex({
      index: landing.index,
      animated: false,
      viewOffset: 24,
    });
  } else if (landing.kind === "folded" && unfold) {
    nav.pending = item;
    nav.shared.onToggleTurnFold(landing.runId);
  }
  return landing;
}
