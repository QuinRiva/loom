import { describe, expect, it } from "vite-plus/test";

import { resolveEditBlur } from "./GoalTasksPanel";

describe("resolveEditBlur", () => {
  describe("title (emptyReverts)", () => {
    it("reverts an empty draft without dispatching", () => {
      expect(
        resolveEditBlur({ draft: "   ", serverValue: "Ship it", dirty: true, emptyReverts: true }),
      ).toEqual({ dispatch: null });
    });

    it("commits a genuine, changed edit (trimmed)", () => {
      expect(
        resolveEditBlur({
          draft: "  New title ",
          serverValue: "Old",
          dirty: true,
          emptyReverts: true,
        }),
      ).toEqual({ dispatch: "New title" });
    });

    it("resyncs (no dispatch) when the field was not edited, even if the server value moved", () => {
      // External `goal update` arrived while focused: draft is stale, but the user
      // did not touch the field, so blur must NOT commit the stale draft back.
      expect(
        resolveEditBlur({
          draft: "Old",
          serverValue: "Server changed",
          dirty: false,
          emptyReverts: true,
        }),
      ).toEqual({ dispatch: null });
    });

    it("does not dispatch when the edit lands on the current server value", () => {
      expect(
        resolveEditBlur({ draft: "Same", serverValue: "Same", dirty: true, emptyReverts: true }),
      ).toEqual({ dispatch: null });
    });
  });

  describe("description (empty allowed)", () => {
    it("commits an empty description when edited", () => {
      expect(
        resolveEditBlur({ draft: "", serverValue: "had text", dirty: true, emptyReverts: false }),
      ).toEqual({ dispatch: "" });
    });

    it("resyncs when not edited", () => {
      expect(
        resolveEditBlur({
          draft: "stale",
          serverValue: "server",
          dirty: false,
          emptyReverts: false,
        }),
      ).toEqual({ dispatch: null });
    });

    it("commits a changed description verbatim (no trim)", () => {
      expect(
        resolveEditBlur({
          draft: "  spaced  ",
          serverValue: "old",
          dirty: true,
          emptyReverts: false,
        }),
      ).toEqual({ dispatch: "  spaced  " });
    });
  });
});
