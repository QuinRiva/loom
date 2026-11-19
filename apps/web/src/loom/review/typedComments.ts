/**
 * loom: line comments on a comparison typed into (plans/inline-diff-editing). The editor carries
 * each comment's anchor (its last line) with the text; the comment the agent reads is rebuilt on
 * the typed comparison, its new-side lines moved as far as its anchor moved.
 */
import type { DiffLineAnnotation, FileDiffMetadata } from "@pierre/diffs";

import {
  buildDiffReviewComment,
  restoreDiffReviewCommentRange,
  type ReviewCommentContext,
} from "../../reviewCommentContext";

type Anchors = ReadonlyArray<
  DiffLineAnnotation<{ readonly entries: ReadonlyArray<{ readonly id: string }> }>
>;

export function retypedComments({
  comments,
  before,
  after,
  anchorsBefore,
  anchorsAfter,
}: {
  comments: ReadonlyArray<ReviewCommentContext>;
  before: FileDiffMetadata;
  after: FileDiffMetadata;
  anchorsBefore: Anchors;
  anchorsAfter: Anchors;
}): ReviewCommentContext[] {
  const anchorOf = (anchors: Anchors, id: string) =>
    anchors.find((anchor) => anchor.metadata.entries.some((entry) => entry.id === id))?.lineNumber;
  return comments.flatMap((comment) => {
    const range = restoreDiffReviewCommentRange(before, comment);
    if (comment.kind !== "line" || !range) return [];
    const [was, now] = [anchorOf(anchorsBefore, comment.id), anchorOf(anchorsAfter, comment.id)];
    const shift = was !== undefined && now !== undefined ? now - was : 0;
    const move = (line: number, side: string | undefined) =>
      side === "deletions" ? line : line + shift;
    const rebuilt = buildDiffReviewComment({
      ...comment,
      fileDiff: after,
      range: {
        ...range,
        start: move(range.start, range.side),
        end: move(range.end, range.endSide ?? range.side),
      },
    });
    return rebuilt ? [rebuilt] : [];
  });
}
