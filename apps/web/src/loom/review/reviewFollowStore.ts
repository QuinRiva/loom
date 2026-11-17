/**
 * loom: a Diff panel following another thread's review (plans/diff-author-query/plan.mdx §6): Open
 * thread points the author's panel at the reviewing thread's diff state, never copying into the
 * author's own. Tiers per docs/architecture/loom-ui-state-tiers.md.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { SelectedLineRange } from "@pierre/diffs";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";
import { useRightPanelStore } from "../../rightPanelStore";
import { useConversationJumpStore } from "../conversationJump";

/** The file and lines a review was last looking at. */
export interface ReviewFocus {
  readonly filePath: string;
  readonly range: SelectedLineRange;
}

interface ReviewFollowState {
  /** Tier 1: per thread, the reviewing thread whose diff its panel shows. */
  followByThreadKey: Record<string, ScopedThreadRef>;
  /** In memory, per reviewing thread, like a remembered scroll position. */
  focusByThreadKey: Record<string, ReviewFocus>;
  unfollow: (ref: ScopedThreadRef) => void;
  setFocus: (reviewing: ScopedThreadRef, focus: ReviewFocus) => void;
}

const without = <T>(record: Record<string, T>, key: string) => {
  if (!(key in record)) return record;
  const { [key]: _removed, ...rest } = record;
  return rest;
};

export const useReviewFollowStore = create<ReviewFollowState>()(
  persist(
    (set) => ({
      followByThreadKey: {},
      focusByThreadKey: {},
      unfollow: (ref) =>
        set((state) => ({
          followByThreadKey: without(state.followByThreadKey, scopedThreadKey(ref)),
        })),
      setFocus: (reviewing, focus) =>
        set((state) => ({
          focusByThreadKey: { ...state.focusByThreadKey, [scopedThreadKey(reviewing)]: focus },
        })),
    }),
    {
      name: "t3code:loom-review-follow:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ followByThreadKey: state.followByThreadKey }),
    },
  ),
);

/**
 * Open thread's store writes: the author's panel follows the review and shows the diff (or `file`,
 * opened whole, when the card was in the whole-file view), and its timeline is parked at the
 * commit's author date. Writes nothing into the author's own diff state. When the author is the
 * reviewing thread itself, only the jump is parked.
 */
export function followReviewToAuthor(input: {
  readonly reviewing: ScopedThreadRef;
  readonly author: ScopedThreadRef;
  /** The commit's author date, which a rebase or amend keeps. */
  readonly authoredAt: string;
  readonly file?: string | undefined;
}) {
  const { reviewing, author } = input;
  if (scopedThreadKey(author) !== scopedThreadKey(reviewing)) {
    useReviewFollowStore.setState((state) => ({
      followByThreadKey: { ...state.followByThreadKey, [scopedThreadKey(author)]: reviewing },
    }));
    if (input.file === undefined) useRightPanelStore.getState().open(author, "diff");
    else useRightPanelStore.getState().openFile(author, input.file);
  }
  // Timeline rows carry UTC instants and are compared as strings; git's %aI carries an offset.
  useConversationJumpStore
    .getState()
    .setRequest({ threadId: author.threadId, at: new Date(input.authoredAt).toISOString() });
}

/**
 * Which thread a panel reads its diff state from. A follow is dropped only on a positive answer that
 * the reviewing thread is gone; while its shell is merely absent (older settled roots are cut from
 * the snapshot) it is kept, and the panel waits for that one shell.
 */
export function resolveReviewFollow(input: {
  readonly routed: ScopedThreadRef;
  readonly reviewing: ScopedThreadRef | null;
  readonly shell: "present" | "deleted" | "absent";
  /** The reviewing thread's family read, which holds it while it is active. */
  readonly family: "pending" | "failed" | "settled";
  /** Its single-shell read, which holds it while it is archived. */
  readonly shellless: "pending" | "missing" | "found";
}): { readonly threadRef: ScopedThreadRef; readonly following: boolean } {
  const { routed, reviewing } = input;
  const gone =
    input.shell === "deleted" ||
    (input.shell === "absent" && input.family === "settled" && input.shellless === "missing");
  return reviewing === null || gone
    ? { threadRef: routed, following: false }
    : { threadRef: reviewing, following: true };
}
