import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type ScopedThreadRef } from "@t3tools/contracts";
import { useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useComposerDraftStore } from "../composerDraftStore";
import { newDraftId, newThreadId } from "../lib/utils";
import { readThreadShell } from "../state/entities";

/**
 * Thread fork (MVP): fork the given server thread into a fresh local draft that
 * starts with a full copy of the source's conversation context and then
 * diverges. The draft carries `forkFromThreadId = source`, inherits the
 * source's goal / model / worktree / branch, and carries over the source's
 * COMPLETE unsent composer draft — prompt, images, attachments, terminal and
 * element contexts, preview annotations, review comments (never prior message
 * text). No tokens are spent until the human sends — the first send forks the
 * source's pi session (fork-once, in the pi driver) via the bootstrap
 * `thread.create`.
 *
 * Returns a callback; navigation lands on the new `/draft/:draftId`.
 */
export function useForkThread(): (sourceRef: ScopedThreadRef) => Promise<void> {
  const router = useRouter();
  return useCallback(
    async (sourceRef: ScopedThreadRef) => {
      const store = useComposerDraftStore.getState();
      const source = readThreadShell(sourceRef);
      if (!source) {
        return;
      }
      const draftId = newDraftId();
      const threadId = newThreadId();
      const projectRef = scopeProjectRef(source.environmentId, source.projectId);

      store.createForkDraftThread(draftId, projectRef, {
        threadId,
        forkFromThreadId: sourceRef.threadId,
        branch: source.branch,
        worktreePath: source.worktreePath,
        goalId: source.goalId,
        runtimeMode: source.runtimeMode,
        interactionMode: source.interactionMode,
      });
      // Continue on the source's model by default (the user can still change it).
      store.setModelSelection(draftId, source.modelSelection);
      // Carry over the source's COMPLETE unsent composer draft — not its
      // conversation. Merges over the model set above.
      store.cloneComposerDraftContent(
        scopeThreadRef(source.environmentId, sourceRef.threadId),
        draftId,
      );

      await router.navigate({ to: "/draft/$draftId", params: { draftId } });
    },
    [router],
  );
}
