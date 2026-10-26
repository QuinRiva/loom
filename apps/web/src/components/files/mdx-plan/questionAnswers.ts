import { createContext } from "react";

import type { PlanQuestion } from "./blocks/questionForm";

/**
 * Answers to `<QuestionForm>`/`<VisualQuestions>` ride the annotation comment channel:
 * each answered question upserts one deterministic-id review comment. That comment is
 * the wire truth (removing its chip un-answers); option ids live in the draft store
 * because the prose is not losslessly parseable. Read-only without a provider.
 */
export interface PlanQuestionAnswer {
  /** Selected option ids (0..1 for `mode:"single"`, any number for `"multi"`). */
  selected: string[];
  /** Write-in text (`mode:"freeform"` or `allowOther`). */
  other: string;
}

export const EMPTY_QUESTION_ANSWER: PlanQuestionAnswer = { selected: [], other: "" };

export const isEmptyQuestionAnswer = (answer: PlanQuestionAnswer): boolean =>
  answer.selected.length === 0 && answer.other.trim().length === 0;

export interface PlanQuestionAnswersApi {
  getAnswer(questionId: string): PlanQuestionAnswer;
  /**
   * Replace a question's answer. An empty answer clears it (comment removed).
   * `blockElement` is the question block's rendered element, used to derive the
   * comment's block anchor.
   */
  setAnswer(question: PlanQuestion, blockElement: Element | null, answer: PlanQuestionAnswer): void;
}

export const PlanQuestionAnswersContext = createContext<PlanQuestionAnswersApi | null>(null);

const QUESTION_COMMENT_PREFIX = "mdx-question:";

/** Deterministic review-comment id per (file, question) so re-answering upserts. */
export const questionAnswerCommentId = (filePath: string, questionId: string): string =>
  `${QUESTION_COMMENT_PREFIX}${filePath}:${questionId}`;

/** Distinguishes answer comments from freeform annotation comments (the
 * annotation layer's highlight overlays skip these — the block shows the state). */
export const isQuestionAnswerCommentId = (id: string): boolean =>
  id.startsWith(QUESTION_COMMENT_PREFIX);

/** The agent-facing answer prose ("Q: … → chose: …") carried as the comment text. */
export function formatQuestionAnswerText(
  question: PlanQuestion,
  answer: PlanQuestionAnswer,
): string {
  const labels = answer.selected.map((id) => {
    const option = question.options?.find((entry) => entry.id === id);
    return option
      ? `"${option.label}"${option.recommended ? " (the recommended option)" : ""}`
      : `"${id}"`;
  });
  const parts = [
    ...(labels.length > 0 ? [`chose: ${labels.join(", ")}`] : []),
    ...(answer.other.trim() ? [`wrote in: "${answer.other.trim()}"`] : []),
  ];
  return `Q: ${question.title} → ${parts.join("; ")}`;
}

/** Parse a persisted answer draft, degrading to unanswered on any malformation. */
export function parseQuestionAnswerDraft(raw: string | null): PlanQuestionAnswer {
  if (!raw) return EMPTY_QUESTION_ANSWER;
  try {
    const parsed: unknown = JSON.parse(raw);
    const candidate = parsed as { selected?: unknown; other?: unknown };
    return {
      selected: Array.isArray(candidate?.selected)
        ? candidate.selected.filter((value): value is string => typeof value === "string")
        : [],
      other: typeof candidate?.other === "string" ? candidate.other : "",
    };
  } catch {
    return EMPTY_QUESTION_ANSWER;
  }
}
