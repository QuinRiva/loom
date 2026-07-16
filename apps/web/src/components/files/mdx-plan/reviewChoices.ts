import { createContext } from "react";

/**
 * The interactive decision surface for `<ReviewChoice>` blocks — the tri-state
 * sibling of `questionAnswers.ts`. A per-item verdict (Accept / Reject /
 * Discuss) + note is captured as a structured choice that rides the SAME channel
 * annotation comments use: each decided item upserts one deterministic-id review
 * comment ({@link reviewChoiceCommentId}) into the composer draft, so decisions
 * appear as removable chips and inject into the review turn on send — no export
 * step (this is where MDX beats the hand-built HTML decision doc).
 *
 * The provider is {@link MdxPlanAnnotationLayer}; `<ReviewChoice>` consumes the
 * context and renders read-only when it is absent (bare renderer / tests),
 * exactly like `<QuestionForm>`.
 *
 * Source-of-truth split (identical to questions): the review comment is the wire
 * truth (its presence gates whether an item counts as decided — removing the
 * composer chip un-decides it), while the structured verdict/note live in the
 * annotation draft store ({@link reviewChoiceDraftKey}).
 */
export type ReviewVerdict = "accept" | "reject" | "discuss";

export interface PlanReviewChoice {
  /** The explicit verdict, or `null` when only a note (or nothing) was given. */
  verdict: ReviewVerdict | null;
  /** Free-text note. */
  note: string;
}

/** Identity of the widget a choice is attached to (the block passes its data). */
export interface ReviewChoiceItem {
  itemId: string;
  label?: string;
}

export const EMPTY_REVIEW_CHOICE: PlanReviewChoice = { verdict: null, note: "" };

export const isEmptyReviewChoice = (choice: PlanReviewChoice): boolean =>
  choice.verdict === null && choice.note.trim().length === 0;

export interface PlanReviewChoicesApi {
  getChoice(itemId: string): PlanReviewChoice;
  /**
   * Replace an item's choice. An empty choice clears it (comment removed).
   * `blockElement` is the widget's rendered element, used to derive the
   * comment's block anchor so it scroll-targets the item.
   */
  setChoice(item: ReviewChoiceItem, blockElement: Element | null, choice: PlanReviewChoice): void;
}

export const PlanReviewChoicesContext = createContext<PlanReviewChoicesApi | null>(null);

const REVIEW_COMMENT_PREFIX = "mdx-review:";

/** Deterministic review-comment id per (file, item) so re-deciding upserts. */
export const reviewChoiceCommentId = (filePath: string, itemId: string): string =>
  `${REVIEW_COMMENT_PREFIX}${filePath}:${itemId}`;

/** Distinguishes review-choice comments from freeform annotation comments (the
 * annotation layer's highlight overlays skip these — the widget shows the state).
 * Sibling of `isQuestionAnswerCommentId`. */
export const isReviewChoiceCommentId = (id: string): boolean =>
  id.startsWith(REVIEW_COMMENT_PREFIX);

/** The agent-facing decision prose carried as the comment text. Verdict is always
 * present; a note is appended when non-empty; a note with no verdict serialises
 * with the `comment` verb (e.g. `Review A-1 → comment — "…"`). */
export function formatReviewChoiceText(label: string, choice: PlanReviewChoice): string {
  const verb = choice.verdict ?? "comment";
  const note = choice.note.trim();
  return `Review ${label} → ${verb}${note ? ` — "${note}"` : ""}`;
}

/** Parse a persisted choice draft, degrading to undecided on any malformation. */
export function parseReviewChoiceDraft(raw: string | null): PlanReviewChoice {
  if (!raw) return EMPTY_REVIEW_CHOICE;
  try {
    const parsed = JSON.parse(raw) as { verdict?: unknown; note?: unknown };
    const verdict = parsed?.verdict;
    return {
      verdict:
        verdict === "accept" || verdict === "reject" || verdict === "discuss" ? verdict : null,
      note: typeof parsed?.note === "string" ? parsed.note : "",
    };
  } catch {
    return EMPTY_REVIEW_CHOICE;
  }
}
