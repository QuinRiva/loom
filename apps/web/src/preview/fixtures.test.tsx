import { isValidElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { PREVIEW_FIXTURES, PREVIEW_GROUPS } from "./fixtures";

describe("preview fixtures", () => {
  it("registers at least one group with fixtures", () => {
    expect(PREVIEW_GROUPS.length).toBeGreaterThan(0);
    expect(PREVIEW_FIXTURES.length).toBeGreaterThan(0);
  });

  it("has unique fixture ids so the picker can key/select reliably", () => {
    const ids = PREVIEW_FIXTURES.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("renders each fixture to a React element without throwing", () => {
    for (const fixture of PREVIEW_FIXTURES) {
      const element = fixture.render();
      expect(isValidElement(element)).toBe(true);
    }
  });
});
