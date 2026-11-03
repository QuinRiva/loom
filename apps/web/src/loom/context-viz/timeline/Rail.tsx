// loom: the context rail as the timeline's scrollbar (context-viz-rail plan): an 8 px track at the
// right edge coloured by the session's context window in tokens, a thumb for the rows in view in
// token space. Wheel scrolls the timeline, a drag scrolls through tokens, a click lands on the
// item's row, hover names it. Fine pointers only; touch keeps the native scrollbar.
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
  segmentAt,
  segmentTitle,
  thumbSpan,
} from "./railLayout";
import {
  CATEGORY_OF,
  jumpToItem,
  landingOf,
  loadedRuns,
  scrollToRow,
  type TimelineFigures,
} from "./timelineFigures";
import { subscribeVisibleRows, type VisibleRows, visibleRows } from "./visibleRows";

/** Movement past this many pixels from the pointer-down point makes a press a drag. */
const DRAG_SLOP = 3;

interface Gesture {
  readonly downY: number;
  /** The pointer's fraction of the track at pointer-down: where the landing row is held. */
  readonly viewPosition: number;
  dragging: boolean;
  clientY: number;
  /** The row last scrolled to, or -1; `Infinity` for the end. */
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
  if (layout.total === 0) return null;

  const labelAt = (segment: LaidSegment) => (segment.start + segment.tokens / 2) / layout.total;
  const fractionOf = (track: HTMLElement, clientY: number) => {
    const box = track.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientY - box.top) / box.height));
  };
  const scrollFrame = (track: HTMLElement, drag: Gesture) => {
    drag.frame = null;
    const f = fractionOf(track, drag.clientY);
    if (f >= 1) {
      if (drag.commanded !== Infinity) void listRef.current?.scrollToEnd({ animated: false });
      drag.commanded = Infinity;
      return;
    }
    const landing = landingOf(figureKey, itemAt(layout, f * layout.total));
    if (!landing || landing.index === drag.commanded) return;
    drag.commanded = landing.index;
    scrollToRow(figureKey, landing.index, drag.viewPosition);
  };

  // A click lands on the item's row; a turn history has not paged in yet is the one way it pages.
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
      : [layout.starts[veilStart]!, veilEnd < 0 ? layout.total : layout.starts[veilEnd]!];

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
  // A published range becomes two style writes in the frame the timeline measured it.
  const attachThumb = (thumb: HTMLSpanElement | null) => {
    if (!thumb) return;
    const paint = (range: VisibleRows | null) => {
      const span =
        range && range.start !== null && range.end !== null
          ? thumbSpan(range.rows, range.start, range.end, figures.join, layout)
          : null;
      if (!span) return;
      thumb.hidden = false;
      thumb.style.top = `min(${(span[0] / layout.total) * 100}%, 100% - 4px)`;
      thumb.style.height = `max(4px, ${((span[1] - span[0]) / layout.total) * 100}%)`;
    };
    thumb.hidden = true;
    paint(visibleRows(figureKey));
    return subscribeVisibleRows(figureKey, paint);
  };

  return (
    <div className="absolute inset-y-0 right-0 hidden w-2 [@media(pointer:fine)]:block">
      <div
        ref={attachTrack}
        className="absolute inset-0 touch-none overflow-hidden bg-muted/40 opacity-60 hover:opacity-100"
        role="group"
        aria-label={`Context window, ${formatContextTokens(layout.total)} in session order`}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = {
            downY: event.clientY,
            viewPosition: fractionOf(event.currentTarget, event.clientY),
            dragging: false,
            clientY: event.clientY,
            commanded: -1,
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
          drag.dragging ||= Math.abs(event.clientY - drag.downY) > DRAG_SLOP;
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
        <span
          ref={attachThumb}
          aria-hidden
          className="pointer-events-none absolute inset-x-0 rounded-xs bg-foreground/10 ring-1 ring-foreground/70 ring-inset"
        />
      </div>
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
