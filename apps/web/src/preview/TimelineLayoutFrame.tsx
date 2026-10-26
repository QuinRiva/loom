import { useState, type ReactNode } from "react";

import {
  TIMELINE_ROW_CLASS_NAME,
  useTimelineAvailableWidthVar,
} from "../components/chat/timelineLayout";

/**
 * Reproduces `MessagesTimeline`'s layout chain, since wide-block bleed keys off
 * `--timeline-available-width` and a bare render would misreport table layout. The padding
 * mirrors the `LegendList` scroll container so the measured width matches production.
 */
export function TimelineLayoutFrame({ children }: { children: ReactNode }) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  useTimelineAvailableWidthVar(viewport);

  return (
    <div ref={setViewport} className="relative h-full min-h-0">
      <div className="scrollbar-gutter-both h-full min-h-0 overflow-y-auto overflow-x-hidden px-3 sm:px-5">
        <div className="messages-timeline-row-frame">
          <div className={TIMELINE_ROW_CLASS_NAME} data-timeline-root="true">
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}
