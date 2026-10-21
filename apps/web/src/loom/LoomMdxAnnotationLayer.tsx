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
import { toastManager } from "../components/ui/toast";
import type { DraftId } from "../composerDraftStore";
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
