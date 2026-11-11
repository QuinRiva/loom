// loom: the context rail as the timeline's scrollbar (context-viz-rail plan, token-rail-puck brief):
// a coloured track at the right edge, caught from wider than it is, and a puck for the rows in view.
// Wheel scrolls, a drag on the puck carries the chat from where it was, a drag elsewhere scrolls
// through the window, a click lands on the item's row, hover names it. Fine pointers only.
import type { LegendListRef } from "@legendapp/list/react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoomContextReport } from "@t3tools/contracts";
import { type RefObject, useRef, useState } from "react";

import type { MessagesTimelineRow } from "../../../components/chat/MessagesTimeline.logic";
import { forwardWheelToTimeline } from "../../../components/chat/timelineMinimapWheel";
import { cn } from "../../../lib/utils";
import { useConversationJumpStore } from "../../conversationJump";
import { formatContextTokens } from "../format";
import {
  itemAt,
  type LaidSegment,
  railLayout,
  rowSpan,
  segmentAt,
  segmentTitle,
  thumbSpan,
} from "./railLayout";
import {
  CATEGORY_OF,
  jumpToItem,
  landingOf,
  loadedRuns,
  rowPoint,
  rowStartOffset,
  scrollToRow,
  type TimelineFigures,
} from "./timelineFigures";
import { subscribeVisibleRows, type VisibleRows, visibleRows } from "./visibleRows";

/** Movement past this many pixels from the pointer-down point makes a press a drag. */
const DRAG_SLOP = 3;
/** The puck's least height, centred on the rows in view, so a screen of prose is still a target. */
const PUCK_MIN = "28px";

interface Gesture {
  readonly downY: number;
  /** The pointer's fraction of the track at pointer-down: where the landing row is held. */
  readonly viewPosition: number;
  /** The list's header and padding above its rows, read once from its layout at pointer-down. */
  readonly startOffset: number;
  /**
   * Pressed on the puck: how far below the viewport's top the content point under the pointer sat,
   * which the drag then holds, so the chat moves from where it was. Null for a press elsewhere.
   */
  readonly grab: number | null;
  /** The track fraction the drag last scrolled from. */
  at: number;
  dragging: boolean;
  clientY: number;
  /** The row (or, for a puck drag, the offset) last scrolled to, or -1; `Infinity` for the end. */
  commanded: number;
  frame: number | null;
}

export function Rail({
  figureKey,
  report,
  figures,
  rows,
  listRef,
}: {
  readonly figureKey: string;
  readonly report: LoomContextReport;
  readonly figures: TimelineFigures;
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly listRef: RefObject<LegendListRef | null>;
}) {
  const layout = railLayout(report, figures.amber);
  const [hovered, setHovered] = useState<LaidSegment | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const puck = useRef<HTMLSpanElement | null>(null);
  if (layout.total === 0) return null;

  const labelAt = (segment: LaidSegment) => (segment.start + segment.tokens / 2) / layout.total;
  const fractionOf = (track: HTMLElement, clientY: number) => {
    const box = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - box.top) / box.height));
  };
  // The content point behind a place on the track: its item's row, and as far into the row as the
  // place is into the row's span, so a drag through one tall row still moves the chat.
  const contentPoint = (f: number, startOffset: number) => {
    const t = f * layout.total;
    const landing = landingOf(figureKey, itemAt(layout, t));
    if (!landing) return null;
    const span = rowSpan(rows[landing.index], figures.join, layout);
    const within = span ? Math.min(1, Math.max(0, (t - span[0]) / (span[1] - span[0]))) : 0;
    return rowPoint(figureKey, landing.index, within, startOffset);
  };
  const scrollFrame = (track: HTMLElement, drag: Gesture) => {
    drag.frame = null;
    const f = fractionOf(track, drag.clientY);
    if (f >= 1) {
      if (drag.commanded !== Infinity) void listRef.current?.scrollToEnd({ animated: false });
      drag.commanded = Infinity;
      return;
    }
    if (drag.grab !== null) {
      const point = contentPoint(f, drag.startOffset);
      const offset = point === null ? drag.commanded : point - drag.grab;
      // A turn's items can sit on the track either side of its prompt's row (a resumed session
      // re-sends system sections ahead of it), so a step that would scroll against the pointer holds.
      if (Math.abs(offset - drag.commanded) < 1 || (offset - drag.commanded) * (f - drag.at) < 0)
        return;
      drag.commanded = offset;
      drag.at = f;
      void listRef.current?.scrollToOffset({
        offset: Math.max(0, drag.commanded),
        animated: false,
      });
      return;
    }
    const landing = landingOf(figureKey, itemAt(layout, f * layout.total));
    if (!landing || landing.index === drag.commanded) return;
    drag.commanded = landing.index;
    scrollToRow(figureKey, landing.index, drag.viewPosition, drag.startOffset);
  };

  // A click lands on the item's row; a click in the veil is the one way the rail pages history.
  const click = (track: HTMLElement, clientY: number) => {
    const item = itemAt(layout, fractionOf(track, clientY) * layout.total);
    const landing = jumpToItem(figureKey, item);
    const threadId = parseScopedThreadKey(figureKey)?.threadId;
    if (landing?.kind === "unloaded" && threadId)
      useConversationJumpStore.getState().setRequest({ threadId, at: item.at });
    else if (landing?.kind === "fixed") scrollToRow(figureKey, 0, 0);
  };

  // Turns not loaded yet: from the first item past the fixed overhead to the first loaded run.
  const runs = loadedRuns(rows);
  const veilStart = layout.items.findIndex((item) => CATEGORY_OF[item.kind] !== "fixed");
  const veilEnd = layout.items.findIndex((item, index) => {
    const runId = figures.runOfItem.get(item.id);
    return index >= veilStart && runId !== undefined && runs.has(runId);
  });
  const veil =
    veilStart < 0 || veilEnd === veilStart
      ? null
      : ([
          layout.starts[veilStart]!,
          veilEnd < 0 ? layout.total : layout.starts[veilEnd]!,
        ] as const);

  // The scroller's attribute and the wheel forward live exactly as long as the track does.
  const attachTrack = (track: HTMLDivElement | null) => {
    const scroller = listRef.current?.getScrollableNode();
    if (!track || !scroller) return;
    scroller.dataset.contextScrollbar = "";
    const onWheel = (event: WheelEvent) => forwardWheelToTimeline(event, scroller);
    track.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      delete scroller.dataset.contextScrollbar;
      track.removeEventListener("wheel", onWheel);
    };
  };
  // A published range becomes two style writes in the frame the timeline measured it. Below its
  // least height the puck is centred on the rows in view and stops at the track's ends.
  const attachThumb = (thumb: HTMLSpanElement | null) => {
    puck.current = thumb;
    if (!thumb) return;
    const paint = (range: VisibleRows | null) => {
      const state = listRef.current?.getState();
      const shown = (index: number) => {
        const top = state?.positionAtIndex(index);
        const size = state?.sizeAtIndex(index);
        if (!state || !range || top === undefined || !size) return [0, 1] as const;
        const at = (y: number) => Math.min(1, Math.max(0, (y - top) / size));
        return [at(range.scroll), at(range.scroll + state.scrollLength)] as const;
      };
      const span =
        range && range.start !== null && range.end !== null
          ? thumbSpan(range.rows, range.start, range.end, figures.join, layout, shown)
          : null;
      if (!span) return;
      const height = `max(${PUCK_MIN}, ${((span[1] - span[0]) / layout.total) * 100}%)`;
      const centre = `${((span[0] + span[1]) / 2 / layout.total) * 100}%`;
      thumb.hidden = false;
      thumb.style.top = `clamp(0px, ${centre} - ${height} / 2, 100% - ${height})`;
      thumb.style.height = height;
    };
    thumb.hidden = true;
    paint(visibleRows(figureKey));
    return subscribeVisibleRows(figureKey, paint);
  };

  // The outer box is the catch zone: 24 px, twice the 12 px track. Below `sm` the lane's padding is
  // 12 px, so the zone, the puck and an 8 px track keep within it rather than cover the prose.
  return (
    <div
      ref={attachTrack}
      className="group/rail absolute inset-y-0 right-0 hidden w-3 touch-none sm:w-6 [@media(pointer:fine)]:block"
      role="group"
      aria-label={`Context window, ${formatContextTokens(layout.total)} in session order`}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const box = puck.current?.getBoundingClientRect();
        const startOffset = rowStartOffset(figureKey);
        const onPuck =
          box && !puck.current?.hidden && event.clientY >= box.top && event.clientY <= box.bottom;
        const f = fractionOf(event.currentTarget, event.clientY);
        const point = onPuck ? contentPoint(f, startOffset) : null;
        const scrollTop = listRef.current?.getScrollableNode()?.scrollTop;
        const grab = point === null || scrollTop === undefined ? null : point - scrollTop;
        gesture.current = {
          downY: event.clientY,
          viewPosition: f,
          startOffset,
          grab,
          at: f,
          dragging: false,
          clientY: event.clientY,
          commanded: grab === null ? -1 : (scrollTop ?? -1),
          frame: null,
        };
      }}
      onPointerMove={(event) => {
        const track = event.currentTarget;
        const f = fractionOf(track, event.clientY);
        setHovered(segmentAt(layout, Math.min(f, 0.999_999) * layout.total));
        const drag = gesture.current;
        if (!drag) return;
        drag.clientY = event.clientY;
        if (!drag.dragging) drag.dragging = Math.abs(event.clientY - drag.downY) > DRAG_SLOP;
        if (drag.dragging && drag.frame === null)
          drag.frame = requestAnimationFrame(() => scrollFrame(track, drag));
      }}
      onPointerUp={(event) => {
        if (gesture.current?.dragging === false) click(event.currentTarget, event.clientY);
        gesture.current = null;
      }}
      onPointerCancel={() => {
        gesture.current = null;
      }}
      onPointerLeave={() => {
        if (!gesture.current) setHovered(null);
      }}
    >
      <div className="absolute inset-y-0 right-0 w-2 overflow-hidden bg-muted/40 sm:w-3 opacity-60 group-hover/rail:opacity-100">
        {layout.segments.map((segment) => (
          <span
            key={segment.items[0]!.id}
            aria-hidden
            className={cn("absolute inset-x-0 min-h-px", segment.className)}
            style={{
              top: `${(segment.start / layout.total) * 100}%`,
              height: `${(segment.tokens / layout.total) * 100}%`,
            }}
          />
        ))}
        {veil ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bg-background/60"
            style={{
              top: `${(veil[0] / layout.total) * 100}%`,
              height: `${((veil[1] - veil[0]) / layout.total) * 100}%`,
            }}
          />
        ) : null}
      </div>
      <span
        ref={attachThumb}
        aria-hidden
        className="pointer-events-none absolute right-0 w-3 rounded-sm bg-foreground/65 ring-2 ring-background sm:w-4"
      />
      {hovered && layout.segments.includes(hovered) ? (
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute end-[calc(100%+0.5rem)] z-30 max-w-72 truncate rounded-md border bg-popover px-1.5 py-0.5 text-xs whitespace-nowrap text-popover-foreground shadow-md/5",
            labelAt(hovered) < 0.1
              ? ""
              : labelAt(hovered) > 0.9
                ? "-translate-y-full"
                : "-translate-y-1/2",
          )}
          style={{ top: `${labelAt(hovered) * 100}%` }}
        >
          {segmentTitle(hovered)}
        </span>
      ) : null}
    </div>
  );
}
