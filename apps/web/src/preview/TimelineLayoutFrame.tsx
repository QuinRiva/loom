import { useState, type ReactNode } from "react";

import {
  TIMELINE_ROW_CLASS_NAME,
  useTimelineAvailableWidthVar,
} from "../components/chat/timelineLayout";

/**
 * Reproduces the exact layout chain a `ChatMarkdown` renders inside on a real
 * thread: a scrolling viewport that publishes `--timeline-available-width` from
 * a ResizeObserver, wrapping the centred `max-w-3xl` prose column. Wide-block
 * bleed keys off that variable, so previewing a component here matches what the
 * timeline produces — rendering it bare would misreport table layout.
 *
 * The padding (`px-3 sm:px-5`) mirrors the `LegendList` scroll container in
 * `MessagesTimeline` so the measured content width matches production.
 */
export function TimelineLayoutFrame({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  useTimelineAvailableWidthVar(viewport);

  return (
    <div ref={setViewport} className="relative h-full min-h-0">
      <div className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto overflow-x-hidden px-3 sm:px-5">
        <div className={TIMELINE_ROW_CLASS_NAME} data-timeline-root="true">
          {children}
        </div>
      </div>
    </div>
  );
}
