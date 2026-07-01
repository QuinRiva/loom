import type { PlanCommentAnchor, ScopedThreadRef } from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

/**
 * In-progress (unsubmitted) MDX-plan comment drafts, keyed by composer target
 * (`DraftId` / server thread) + the comment's anchor. Kept separate from the
 * composer draft store so an unfinished annotation survives dismiss→reopen and
 * page reloads — "return things as you left them" — without threading a new
 * field through the composer store's schema/migrations. Only an explicit submit
 * or discard clears an entry.
 */
interface MdxAnnotationDraftStoreState {
  drafts: Record<string, string>;
  getDraft: (key: string) => string | null;
  setDraft: (key: string, text: string) => void;
  clearDraft: (key: string) => void;
}

/** Stable per-target prefix so drafts don't collide across threads. */
export function draftTargetKey(target: ScopedThreadRef | DraftId): string {
  return typeof target === "string" ? target : scopedThreadKey(target);
}

/** Composite localStorage key for one target's draft of one anchor/comment. */
export function annotationDraftKey(
  target: ScopedThreadRef | DraftId,
  slot: { anchor?: PlanCommentAnchor; commentId?: string },
): string {
  const suffix = slot.commentId
    ? `comment\u0000${slot.commentId}`
    : `anchor\u0000${JSON.stringify(slot.anchor ?? null)}`;
  return `${draftTargetKey(target)}\u0000${suffix}`;
}

export const useMdxAnnotationDraftStore = create<MdxAnnotationDraftStoreState>()(
  persist(
    (set, get) => ({
      drafts: {},
      getDraft: (key) => get().drafts[key] ?? null,
      setDraft: (key, text) =>
        set((state) => {
          if (!text) {
            if (state.drafts[key] === undefined) return state;
            const { [key]: _dropped, ...rest } = state.drafts;
            return { drafts: rest };
          }
          if (state.drafts[key] === text) return state;
          return { drafts: { ...state.drafts, [key]: text } };
        }),
      clearDraft: (key) =>
        set((state) => {
          if (state.drafts[key] === undefined) return state;
          const { [key]: _dropped, ...rest } = state.drafts;
          return { drafts: rest };
        }),
    }),
    {
      name: "t3code:mdx-annotation-drafts:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
    },
  ),
);
