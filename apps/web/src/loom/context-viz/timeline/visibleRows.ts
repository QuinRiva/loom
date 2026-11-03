// loom: context-viz, the timeline's visible row range carried to the scrollbar without a React
// render. The timeline publishes per rAF-throttled scroll with the switch off too, so the map is
// bounded like the figure store.
import type { MessagesTimelineRow } from "../../../components/chat/MessagesTimeline.logic";
import { KEPT_THREADS } from "./timelineFigures";

export interface VisibleRows {
  readonly start: number | null;
  readonly end: number | null;
  /** The rows `start` and `end` index. */
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
}

const ranges = new Map<string, VisibleRows>();
const listeners = new Map<string, Set<(range: VisibleRows) => void>>();

export function publishVisibleRows(
  key: string,
  { start, end }: Pick<VisibleRows, "start" | "end">,
  rows: ReadonlyArray<MessagesTimelineRow>,
) {
  const last = ranges.get(key);
  if (last?.start === start && last.end === end && last.rows === rows) return;
  const range = { start, end, rows };
  ranges.delete(key);
  ranges.set(key, range);
  if (ranges.size > KEPT_THREADS) ranges.delete(ranges.keys().next().value!);
  for (const listener of listeners.get(key) ?? []) listener(range);
}

export const visibleRows = (key: string) => ranges.get(key) ?? null;

export function subscribeVisibleRows(key: string, listener: (range: VisibleRows) => void) {
  const set = listeners.get(key) ?? new Set();
  listeners.set(key, set.add(listener));
  return () => {
    set.delete(listener);
    if (set.size === 0) listeners.delete(key);
  };
}
