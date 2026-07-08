import { describe, expect, it } from "vite-plus/test";

import { publishTimelineAvailableWidth, TIMELINE_AVAILABLE_WIDTH_VAR } from "./timelineLayout";

describe("publishTimelineAvailableWidth", () => {
  it("publishes the rounded viewport width onto the bleed variable the CSS keys off", () => {
    const store = new Map<string, string>();
    const element = {
      style: {
        setProperty: (name: string, value: string) => store.set(name, value),
      },
    } as unknown as HTMLElement;

    publishTimelineAvailableWidth(element, 1234.6);

    // The wide-table bleed CSS in index.css reads this exact variable; the
    // rounding keeps the published value pixel-stable across observer ticks.
    expect(store.get(TIMELINE_AVAILABLE_WIDTH_VAR)).toBe("1235px");
  });

  it("exposes the variable name the bleed CSS depends on", () => {
    // Guard against renaming the contract out from under index.css.
    expect(TIMELINE_AVAILABLE_WIDTH_VAR).toBe("--timeline-available-width");
  });
});
