import { parseDiffFromFile } from "@pierre/diffs";
import { describe, expect, it } from "vite-plus/test";

import { buildDiffReviewComment } from "../../reviewCommentContext";
import { retypedComments } from "./typedComments";

const original = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
const working = original.map((line, index) => (index === 4 ? "agent's line 5" : line));
const typed = ["typed A", "typed B", ...working];
const compare = (lines: string[]) =>
  parseDiffFromFile(
    { name: "x.ts", contents: original.join("\n") },
    { name: "x.ts", contents: lines.join("\n") },
  );
const before = compare(working);
const after = compare(typed);

describe("retypedComments", () => {
  it("moves a comment's new-side lines with its anchor and quotes the typed text", () => {
    const comment = buildDiffReviewComment({
      id: "c",
      sectionId: "s",
      sectionTitle: "Changes",
      filePath: "x.ts",
      fileDiff: before,
      range: { start: 29, side: "additions", end: 30, endSide: "additions" },
      text: "rename this",
    })!;
    const anchor = (lineNumber: number) => [
      { side: "additions" as const, lineNumber, metadata: { entries: [{ id: "c" }] } },
    ];
    const [moved] = retypedComments({
      comments: [comment],
      before,
      after,
      anchorsBefore: anchor(30),
      anchorsAfter: anchor(32),
    });
    expect(moved?.kind === "line" && moved.selection).toEqual({
      start: 31,
      side: "additions",
      end: 32,
      endSide: "additions",
    });
    expect(moved?.kind === "line" && moved.diff).toContain(" line 29\n line 30");
    expect(moved?.text).toBe("rename this");
  });
});
