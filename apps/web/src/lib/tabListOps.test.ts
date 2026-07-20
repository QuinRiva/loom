import { describe, expect, it } from "vite-plus/test";

import { closeWithNeighbourFallback, keepOnly, truncateAfter } from "./tabListOps";

const idOf = (item: string) => item;

describe("tabListOps", () => {
  describe("closeWithNeighbourFallback", () => {
    it("removes the entry and returns the next neighbour when a middle item closes", () => {
      const { list, fallback } = closeWithNeighbourFallback(["a", "b", "c"], "b", idOf);
      expect(list).toEqual(["a", "c"]);
      expect(fallback).toBe("c");
    });

    it("falls back to the new last item when the last entry closes", () => {
      const { list, fallback } = closeWithNeighbourFallback(["a", "b", "c"], "c", idOf);
      expect(list).toEqual(["a", "b"]);
      expect(fallback).toBe("b");
    });

    it("returns a null fallback when the list empties", () => {
      const { list, fallback } = closeWithNeighbourFallback(["a"], "a", idOf);
      expect(list).toEqual([]);
      expect(fallback).toBeNull();
    });

    it("is a no-op with the same reference when the key is absent", () => {
      const input = ["a", "b"];
      const { list, fallback } = closeWithNeighbourFallback(input, "z", idOf);
      expect(list).toBe(input);
      expect(fallback).toBeNull();
    });
  });

  describe("keepOnly", () => {
    it("keeps only the named entry", () => {
      expect(keepOnly(["a", "b", "c"], "b", idOf)).toEqual(["b"]);
    });

    it("is a no-op with the same reference when the key is absent", () => {
      const input = ["a", "b"];
      expect(keepOnly(input, "z", idOf)).toBe(input);
    });
  });

  describe("truncateAfter", () => {
    it("keeps the named entry and everything before it", () => {
      expect(truncateAfter(["a", "b", "c", "d"], "b", idOf)).toEqual(["a", "b"]);
    });

    it("keeps the whole list when the last entry is named", () => {
      expect(truncateAfter(["a", "b"], "b", idOf)).toEqual(["a", "b"]);
    });

    it("is a no-op with the same reference when the key is absent", () => {
      const input = ["a", "b"];
      expect(truncateAfter(input, "z", idOf)).toBe(input);
    });
  });
});
