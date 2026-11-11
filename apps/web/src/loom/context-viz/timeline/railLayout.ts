// loom: context-viz, the scrollbar's token-space map: the window's items in session order, each
// item's [start, end) in tokens from the top, and the two lookups between the track and the rows.
import type { LoomContextItem, LoomContextReport } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "../../../components/chat/MessagesTimeline.logic";
import { formatContextTokens, formatItemTokens } from "../format";
import type { ContextJoin } from "../join";
import { AMBER_BAR, byCategory, CATEGORY_BAR, rowKeys } from "./timelineFigures";

/**
 * Neighbours under this share of the window merge into one segment (about 2 px on a 600 px track),
 * coloured by the category that holds most of its tokens; amber items always stand alone.
 */
const MERGE_SHARE = 0.004;

interface RailSegment {
  readonly items: ReadonlyArray<LoomContextItem>;
  readonly tokens: number;
  readonly amber: boolean;
}

export type LaidSegment = RailSegment & { readonly className: string; readonly start: number };

export interface RailLayout {
  readonly total: number;
  readonly segments: ReadonlyArray<LaidSegment>;
  readonly segmentStarts: ReadonlyArray<number>;
  /** The window's items in session order, and each one's start in tokens from the top. */
  readonly items: ReadonlyArray<LoomContextItem>;
  readonly starts: ReadonlyArray<number>;
  /** Each item's [start, end) in tokens from the top. */
  readonly span: ReadonlyMap<string, readonly [number, number]>;
}

const layouts = new WeakMap<ReadonlySet<string>, RailLayout>();

export function railLayout(report: LoomContextReport, amber: ReadonlySet<string>): RailLayout {
  const cached = layouts.get(amber);
  if (cached) return cached;
  const items = report.items.filter((item) => item.inWindow && item.tokens > 0);
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  const segments: Array<RailSegment> = [];
  const span = new Map<string, readonly [number, number]>();
  const starts: Array<number> = [];
  let at = 0;
  for (const item of items) {
    span.set(item.id, [at, at + item.tokens]);
    starts.push(at);
    at += item.tokens;
    const amberItem = amber.has(item.id);
    const last = segments.at(-1);
    const small = !amberItem && item.tokens < total * MERGE_SHARE;
    if (small && last && !last.amber && last.tokens < total * MERGE_SHARE) {
      segments[segments.length - 1] = {
        items: [...last.items, item],
        tokens: last.tokens + item.tokens,
        amber: false,
      };
    } else {
      segments.push({ items: [item], tokens: item.tokens, amber: amberItem });
    }
  }
  const laid = segments.map((segment) => ({
    ...segment,
    start: span.get(segment.items[0]!.id)![0],
    className: segment.amber ? AMBER_BAR : CATEGORY_BAR[byCategory(segment.items)[0]![0]],
  }));
  const layout = {
    total,
    span,
    items,
    starts,
    segments: laid,
    segmentStarts: laid.map((segment) => segment.start),
  };
  layouts.set(amber, layout);
  return layout;
}

/** The index of the last entry of an ascending list at or before `t`. */
function lastAtOrBefore(starts: ReadonlyArray<number>, t: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid]! <= t) low = mid;
    else high = mid - 1;
  }
  return low;
}

/** The item and the segment holding token `t`. */
export const itemAt = (layout: RailLayout, t: number) =>
  layout.items[lastAtOrBefore(layout.starts, t)]!;

export const segmentAt = (layout: RailLayout, t: number) =>
  layout.segments[lastAtOrBefore(layout.segmentStarts, t)]!;

export function segmentTitle(segment: RailSegment): string {
  const [first] = segment.items;
  return segment.items.length === 1 && first
    ? `${formatItemTokens(first)} · ${first.label}`
    : `${segment.items.length} small items · ${formatContextTokens(segment.tokens)}`;
}

/** The items a row shows: a collapsed turn its whole run, any other row the items its keys name. */
function rowItems(row: MessagesTimelineRow, join: ContextJoin) {
  if (row.kind === "turn-fold") return row.expanded ? [] : (join.runs.get(row.runId)?.items ?? []);
  return rowKeys(row).flatMap((key) =>
    key.startsWith("user:")
      ? [join.byUserMessageId.get(key.slice("user:".length)) ?? []].flat()
      : [join.byNativeId.get(key) ?? [], join.argsOfTool.get(key) ?? []].flat(),
  );
}

/** The token span of a row's items, or null when it holds no item in the window. */
export function rowSpan(
  row: MessagesTimelineRow | undefined,
  join: ContextJoin,
  layout: RailLayout,
): readonly [number, number] | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (const item of row ? rowItems(row, join) : []) {
    const span = layout.span.get(item.id);
    if (!span) continue;
    top = Math.min(top, span[0]);
    bottom = Math.max(bottom, span[1]);
  }
  return top < bottom ? [top, bottom] : null;
}

/**
 * The puck's span for the rows in view: each row's span cut to the part of the row that shows, as
 * `shown` gives it, so the puck moves as a tall row scrolls by. Rows past the report's last item
 * (the latest answer, which no later call has measured yet) pin a zero-height span to the end of
 * the nearest row above.
 */
export function thumbSpan(
  rows: ReadonlyArray<MessagesTimelineRow>,
  start: number,
  end: number,
  join: ContextJoin,
  layout: RailLayout,
  shown: (index: number) => readonly [number, number],
): readonly [number, number] | null {
  let top = Infinity;
  let bottom = -Infinity;
  for (let index = start; index <= end; index += 1) {
    const span = rowSpan(rows[index], join, layout);
    if (!span) continue;
    const [from, to] = shown(index);
    top = Math.min(top, span[0] + from * (span[1] - span[0]));
    bottom = Math.max(bottom, span[0] + to * (span[1] - span[0]));
  }
  if (top <= bottom) return [top, bottom];
  for (let index = start - 1; index >= 0; index -= 1) {
    const above = rowSpan(rows[index], join, layout);
    if (above) return [above[1], above[1]];
  }
  return null;
}
