import { useState, type ReactNode } from "react";

import {
  TIMELINE_ROW_CLASS_NAME,
  useTimelineAvailableWidthVar,
} from "../components/chat/timelineLayout";

/**
 * Reproduces `MessagesTimeline`'s layout chain, which the wide-block bleed keys off: the
 * production `.messages-timeline-scroll` padding, and LegendList's per-row `contain: paint`
 * that clips anything bled past the scroller's content box.
 */
export function TimelineLayoutFrame({ children }: { children: ReactNode }) {
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  useTimelineAvailableWidthVar(scroller);

  return (
    <div data-chat-canvas className="relative h-full min-h-0">
      <div
        ref={setScroller}
        className="messages-timeline-scroll scrollbar-gutter-both h-full min-h-0 overflow-y-auto overflow-x-hidden"
      >
        <div className="[contain:paint_layout_style]">
          <div className="messages-timeline-row-frame">
            <div
              className={`@container/chat-lane ${TIMELINE_ROW_CLASS_NAME}`}
              data-timeline-root="true"
            >
              {children}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
