import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { changeInRows, nearestChange, rulerChanges, rulerTotalRows } from "./changeNavigation";

// 40 lines: line 6 rewritten, lines 21 to 23 deleted, two lines inserted after the old line 33.
const before = Array.from({ length: 40 }, (_, index) => `line ${index}`);
const after = [...before];
after[5] = "changed 5";
after.splice(20, 3);
after.splice(30, 0, "new A", "new B");
const fileDiff = parseDiffFromFile(
  { name: "x.ts", contents: before.join("\n") },
  { name: "x.ts", contents: after.join("\n") },
);

describe("rulerChanges", () => {
  it("places each change at its rendered row, with every unchanged line counted", () => {
    expect(rulerChanges(fileDiff, "unified")).toEqual([
      { start: 5, rows: 2, additions: 1, deletions: 1, lineNumber: 6, side: "additions" },
      { start: 21, rows: 3, additions: 0, deletions: 3, lineNumber: 21, side: "deletions" },
      { start: 34, rows: 2, additions: 2, deletions: 0, lineNumber: 31, side: "additions" },
    ]);
    // Unified gives a deleted line its own row; split pairs it with the added one beside it.
    expect(rulerTotalRows(fileDiff, "unified")).toBe(43);
    expect(rulerChanges(fileDiff, "split").map(({ start, rows }) => [start, rows])).toEqual([
      [5, 1],
      [20, 3],
      [33, 2],
    ]);
    expect(rulerTotalRows(fileDiff, "split")).toBe(42);
  });
});

describe("nearestChange", () => {
  const changes = rulerChanges(fileDiff, "unified");
  it("picks the change under a row, else the closest, the earlier on a tie", () => {
    expect(nearestChange(changes, 0)).toBe(0);
    expect(nearestChange(changes, 22)).toBe(1);
    expect(nearestChange(changes, 14)).toBe(1);
    expect(nearestChange(changes, 13)).toBe(0);
    expect(nearestChange(changes, 42)).toBe(2);
  });
  it("knows when a change is on screen", () => {
    expect(changeInRows(changes[1]!, 23, 40)).toBe(true);
    expect(changeInRows(changes[1]!, 24, 40)).toBe(false);
  });
});
