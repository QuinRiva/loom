import { useEffect } from "react";

import { observeResize } from "~/lib/observeResize";

/**
 * CSS custom property the timeline publishes with the true content width its
 * viewport offers. Wide markdown blocks (tables, etc.) key their bleed budget
 * off this so they can escape the prose measure up to what the viewport
 * actually has, rather than being stranded in a narrow column on wide displays
 * (see the `.chat-markdown-table-container` rules in `index.css`).
 */
export const TIMELINE_AVAILABLE_WIDTH_VAR = "--timeline-available-width";

/**
 * Centred prose column that every timeline row renders inside: upstream's
 * `chat-content-lane` without its `overflow-x-clip`. The bleed CSS assumes this
 * measure — a `ChatMarkdown` rendered outside it would misreport table layout —
 * so the preview harness reuses the exact same class chain.
 */
export const TIMELINE_ROW_CLASS_NAME = "chat-content-lane";

/** Publish the viewport's current content width onto the bleed CSS variable. */
export function publishTimelineAvailableWidth(element: HTMLElement, viewportWidth: number): void {
  element.style.setProperty(TIMELINE_AVAILABLE_WIDTH_VAR, `${Math.round(viewportWidth)}px`);
}

/**
 * Observe `element` and keep {@link TIMELINE_AVAILABLE_WIDTH_VAR} in sync with
 * its content width. `onMeasure` receives each measured width so callers can
 * derive additional layout state from the same observation.
 */
export function useTimelineAvailableWidthVar(
  element: HTMLElement | null,
  onMeasure?: (viewportWidth: number) => void,
): void {
  useEffect(() => {
    if (!element) {
      return;
    }

    const measure = () => {
      const viewportWidth = element.getBoundingClientRect().width;
      publishTimelineAvailableWidth(element, viewportWidth);
      onMeasure?.(viewportWidth);
    };

    // observeResize delivers an initial entry, so no separate first measure.
    return observeResize(element, measure);
  }, [element, onMeasure]);
}
