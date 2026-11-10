import type { ReviewCommentContextRecord } from "@t3tools/contracts";
import type { DocumentViewerInit } from "@t3tools/shared/documentViewerBridge.loom";

import { anchorForBlockElement } from "~/components/files/mdx-plan/annotation/anchoring";
import {
  EMPTY_QUESTION_ANSWER,
  isEmptyQuestionAnswer,
  parseQuestionAnswerDraft,
  type PlanQuestionAnswersApi,
  questionAnswerComment,
  questionAnswerCommentId,
} from "~/components/files/mdx-plan/questionAnswers";
import {
  EMPTY_REVIEW_CHOICE,
  isEmptyReviewChoice,
  parseReviewChoiceDraft,
  type PlanReviewChoicesApi,
  reviewChoiceComment,
  reviewChoiceCommentId,
} from "~/components/files/mdx-plan/reviewChoices";
import type { DraftId } from "~/composerDraftStore";
import { reviewCommentContextId, reviewCommentContextRecord } from "~/lib/composerContextRecords";
import {
  questionAnswerDraftKey,
  reviewChoiceDraftKey,
  useMdxAnnotationDraftStore,
} from "~/mdxAnnotationDraftStore";

/**
 * loom: the viewer's answer surface, the phone's counterpart of `MdxPlanAnnotationLayer`'s. A
 * tap stores the selection here, as web does, and posts the record web would put in its
 * composer; the app holds it in the thread's draft. An answer counts only while the app reports
 * its record present there, so removing the chip on the phone un-answers it.
 */
export function useDocumentAnswers(input: {
  readonly answers: DocumentViewerInit["answers"];
  readonly filePath: string;
  readonly present: ReadonlySet<string>;
  readonly setPresent: (update: (present: ReadonlySet<string>) => ReadonlySet<string>) => void;
  readonly upsert: (record: ReviewCommentContextRecord) => void;
  readonly remove: (contextId: ReviewCommentContextRecord["contextId"]) => void;
}): { questionAnswers: PlanQuestionAnswersApi; reviewChoices: PlanReviewChoicesApi } | null {
  const drafts = useMdxAnnotationDraftStore((store) => store.drafts);
  const setDraft = useMdxAnnotationDraftStore((store) => store.setDraft);
  const clearDraft = useMdxAnnotationDraftStore((store) => store.clearDraft);
  if (input.answers === undefined) return null;
  const { filePath, present, setPresent } = input;
  // The app's scoped thread key; web keys a thread's drafts by the same string.
  const target = input.answers.draftTarget as DraftId;
  const isPresent = (commentId: string) => present.has(reviewCommentContextId(commentId));
  const anchorOf = (block: Element | null) => {
    const root = block?.closest("[data-plan-root]");
    return block && root ? anchorForBlockElement(block, root).anchor : undefined;
  };
  const update = (
    commentId: string,
    draftKey: string,
    value: object | null,
    comment: () => Parameters<typeof reviewCommentContextRecord>[0],
  ) => {
    const contextId = reviewCommentContextId(commentId);
    if (value === null) {
      clearDraft(draftKey);
      setPresent((current) => new Set([...current].filter((id) => id !== contextId)));
      input.remove(contextId);
      return;
    }
    setDraft(draftKey, JSON.stringify(value));
    // Shown at once; the app's next `answers-present` confirms it or takes it back.
    setPresent((current) => new Set([...current, contextId]));
    input.upsert(reviewCommentContextRecord(comment()));
  };

  return {
    questionAnswers: {
      getAnswer: (questionId) =>
        isPresent(questionAnswerCommentId(filePath, questionId))
          ? parseQuestionAnswerDraft(
              drafts[questionAnswerDraftKey(target, filePath, questionId)] ?? null,
            )
          : EMPTY_QUESTION_ANSWER,
      setAnswer: (question, block, answer) =>
        update(
          questionAnswerCommentId(filePath, question.id),
          questionAnswerDraftKey(target, filePath, question.id),
          isEmptyQuestionAnswer(answer) ? null : answer,
          () => questionAnswerComment(filePath, question, answer, anchorOf(block)),
        ),
    },
    reviewChoices: {
      getChoice: (itemId) =>
        isPresent(reviewChoiceCommentId(filePath, itemId))
          ? parseReviewChoiceDraft(drafts[reviewChoiceDraftKey(target, filePath, itemId)] ?? null)
          : EMPTY_REVIEW_CHOICE,
      setChoice: (item, block, choice) =>
        update(
          reviewChoiceCommentId(filePath, item.itemId),
          reviewChoiceDraftKey(target, filePath, item.itemId),
          isEmptyReviewChoice(choice) ? null : choice,
          () => reviewChoiceComment(filePath, item, choice, anchorOf(block)),
        ),
    },
  };
}
