/**
 * loom: the MDX annotation layer with query threads bound
 * (plans/plan-query-threads/plan.mdx §5 steps 9-10). Query asks `loom.documentQuery`,
 * which forks the document's author (or reuses its live query thread for this
 * revision) and sends the question as that thread's first turn; the main window
 * then opens the query thread. A pin opens it scrolled to its question.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import {
  MdxPlanAnnotationLayer,
  type PlanQueryBinding,
} from "../components/files/mdx-plan/annotation/MdxPlanAnnotationLayer";
import { isQuestionAnswerCommentId } from "../components/files/mdx-plan/questionAnswers";
import { isReviewChoiceCommentId } from "../components/files/mdx-plan/reviewChoices";
import { toastManager } from "../components/ui/toast";
import { refreshArchivedThreadsForEnvironment } from "../lib/archivedThreadsState";
import { type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { waitForThreadShell } from "../state/entities";
import { useAtomCommand } from "../state/use-atom-command";
import { buildThreadRouteParams } from "../threadRoutes";
import { useConversationJumpStore } from "./conversationJump";
import { useDocumentQueryAuthor, useDocumentQueryPins } from "./documentQueryPins";
import { loomCommands } from "./loomGoalState";

export function LoomMdxAnnotationLayer({
  source,
  filePath,
  threadRef,
  composerDraftTarget,
}: {
  readonly source: string;
  readonly filePath: string;
  /** The viewing thread: the author a Query forks (or, on a query thread, its author). */
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const navigate = useNavigate();
  const documentQuery = useAtomCommand(loomCommands.documentQuery, { reportFailure: false });
  const authorId = useDocumentQueryAuthor(threadRef);
  const pins = useDocumentQueryPins(threadRef.environmentId, authorId, filePath);
  const open = (ref: ScopedThreadRef) =>
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });

  const query: PlanQueryBinding | undefined =
    authorId === null
      ? undefined
      : {
          pins,
          ask: async (input) => {
            const result = await documentQuery({
              environmentId: threadRef.environmentId,
              input: { ...input, sourceThreadId: authorId },
            });
            if (result._tag === "Failure") {
              if (isAtomCommandInterrupted(result)) return null;
              const error = squashAtomCommandFailure(result);
              return error instanceof Error ? error.message : "Could not ask the author's fork.";
            }
            // A fresh fork archived any stale-revision query thread; the graph reads
            // archived shells from a one-shot snapshot, so refetch it or the
            // superseded satellite vanishes instead of receding.
            if (result.value.created) refreshArchivedThreadsForEnvironment(threadRef.environmentId);
            // Navigating before the query thread's shell reaches this client reads
            // as a missing thread and bounces to `/` (as `/retro` avoids).
            const queryRef = scopeThreadRef(threadRef.environmentId, result.value.queryThreadId);
            // Asked either way: the card closes, so a slow shell must not invite a resend.
            if (await waitForThreadShell(queryRef)) open(queryRef);
            else
              toastManager.add({
                type: "info",
                title: "Question sent",
                description: "The query thread will appear in the sidebar shortly.",
              });
            return null;
          },
          openPin: (pin) => {
            useConversationJumpStore
              .getState()
              .setRequest({ threadId: pin.queryThreadId, at: pin.askedAt });
            open(scopeThreadRef(threadRef.environmentId, pin.queryThreadId));
          },
        };

  return (
    <MdxPlanAnnotationLayer
      source={source}
      filePath={filePath}
      composerDraftTarget={composerDraftTarget}
      query={query}
    />
  );
}

/**
 * The file panel header's review count ("1 comment · 2 queries"): pending
 * annotation comments in the viewing composer plus the questions pinned on
 * this document. Answers and verdicts are counted by their own blocks.
 */
export function LoomMdxReviewCount({
  filePath,
  threadRef,
  composerDraftTarget,
}: {
  readonly filePath: string;
  readonly threadRef: ScopedThreadRef;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
}) {
  const comments = useComposerDraftStore(
    (store) =>
      (store.getComposerDraft(composerDraftTarget)?.reviewComments ?? []).filter(
        (c) =>
          c.kind === "mdx-anchor" &&
          c.filePath === filePath &&
          !isQuestionAnswerCommentId(c.id) &&
          !isReviewChoiceCommentId(c.id),
      ).length,
  );
  const authorId = useDocumentQueryAuthor(threadRef);
  const queries = useDocumentQueryPins(threadRef.environmentId, authorId, filePath).length;
  const parts = [
    comments > 0 ? `${comments} ${comments === 1 ? "comment" : "comments"}` : null,
    queries > 0 ? `${queries} ${queries === 1 ? "query" : "queries"}` : null,
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : (
    <span className="shrink-0 px-2 text-2xs text-muted-foreground" data-mdx-review-count>
      {parts.join(" · ")}
    </span>
  );
}
