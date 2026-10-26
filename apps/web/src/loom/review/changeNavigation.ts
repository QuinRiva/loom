/**
 * loom: where an opened changed file's changes are, for the change ruler and the "n of m" counter.
 * Positions are code-view rows (each line's `data-line-index`), never DOM heights: the view is
 * virtualised, so most rows have no height. With every unchanged line shown, a row is a file line
 * (unified adds a row per deleted line; split pairs the two sides).
 */
import type { FileDiffMetadata } from "@pierre/diffs";
import { create } from "zustand";

export type ChangeLayout = "split" | "unified";

export interface RulerChange {
  /** First rendered row, in the layout's row space. */
  readonly start: number;
  readonly rows: number;
  readonly additions: number;
  readonly deletions: number;
  /** The line a jump centres: the first added line, or the first deleted one for a deletion. */
  readonly lineNumber: number;
  readonly side: "additions" | "deletions";
}

export function rulerChanges(fileDiff: FileDiffMetadata, layout: ChangeLayout): RulerChange[] {
  return fileDiff.hunks.flatMap((hunk) => {
    let row = layout === "split" ? hunk.splitLineStart : hunk.unifiedLineStart;
    return hunk.hunkContent.flatMap((content) => {
      const start = row;
      if (content.type === "context") {
        row += content.lines;
        return [];
      }
      const { additions, deletions } = content;
      const rows = layout === "split" ? Math.max(additions, deletions) : additions + deletions;
      row += rows;
      const onAdditions = additions > 0;
      return [
        {
          start,
          rows,
          additions,
          deletions,
          // The indexes count only the lines a patch carries (hunk mode); the starts are the file's.
          lineNumber: onAdditions
            ? hunk.additionStart + content.additionLineIndex - hunk.additionLineIndex
            : hunk.deletionStart + content.deletionLineIndex - hunk.deletionLineIndex,
          side: onAdditions ? "additions" : "deletions",
        },
      ];
    });
  });
}

export const rulerTotalRows = (fileDiff: FileDiffMetadata, layout: ChangeLayout) =>
  layout === "split" ? fileDiff.splitLineCount : fileDiff.unifiedLineCount;

const rowDistance = (change: RulerChange, row: number) =>
  Math.max(0, change.start - row, row - (change.start + change.rows - 1));

/** The change nearest a row (0 inside it); the earlier one on a tie. */
export function nearestChange(changes: ReadonlyArray<RulerChange>, row: number): number {
  let best = 0;
  changes.forEach((change, index) => {
    if (rowDistance(change, row) < rowDistance(changes[best]!, row)) best = index;
  });
  return best;
}

export const changeInRows = (change: RulerChange, first: number, last: number) =>
  change.start <= last && change.start + change.rows - 1 >= first;

/** The rows on screen in the code view's scroll container, and the one at its centre. */
export function rowsOnScreen(root: HTMLElement, layout: ChangeLayout) {
  const box = root.getBoundingClientRect();
  const middle = (box.top + box.bottom) / 2;
  let first = Infinity;
  let last = -Infinity;
  let centre: number | null = null;
  let centreDistance = Infinity;
  for (const host of root.querySelectorAll("diffs-container")) {
    for (const line of host.shadowRoot?.querySelectorAll("[data-line][data-line-index]") ?? []) {
      const rect = line.getBoundingClientRect();
      if (rect.bottom < box.top || rect.top > box.bottom) continue;
      // "unified,split"
      const row = Number(
        line.getAttribute("data-line-index")?.split(",")[layout === "split" ? 1 : 0],
      );
      first = Math.min(first, row);
      last = Math.max(last, row);
      const distance = Math.abs((rect.top + rect.bottom) / 2 - middle);
      if (distance < centreDistance) [centre, centreDistance] = [row, distance];
    }
  }
  return centre === null ? null : { first, last, centre };
}

/**
 * The opened file's changes for its header counter. One change view is open at a time (the Files
 * surface has one preview), so this is a single slot the mounted view owns; session only.
 */
export const useChangeNavigationStore = create<{
  owner: object | null;
  path: string | null;
  count: number;
  current: number;
  jump: (index: number) => void;
  step: (delta: 1 | -1) => void;
}>(() => ({
  owner: null,
  path: null,
  count: 0,
  current: 0,
  jump: () => undefined,
  step: () => undefined,
}));
