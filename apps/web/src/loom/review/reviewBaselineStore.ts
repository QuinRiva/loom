// Loom's change-review baseline (plans/change-review/plan.mdx §5), beside upstream's
// `diffPanelStore`, never inside it:
//
// - `intervalIdByThreadKey` (tier 1, per thread): the selected review interval (`"live"` or a
//   closing message id). Null once the user picks an upstream scope; absent until the thread is
//   first seen with an interval, when "Since your message" is seeded (seed, never override).
// - `sources` (tier 2, client-wide): the Sources toggle, "Everything" by default.
// - `marksOff` (tier 2, client-wide): the Files surface used as a plain browser, with no change
//   marks and no whole-file change view.
// - `fileChangeLayout` (tier 2, client-wide): an opened changed file side by side (the default) or
//   unified; separate from the Diff panel's layout, which defaults to unified.
// - `changedOnly` (session only, not persisted): the Files tree collapsed to marked files, kept
//   across file opens but not across reloads, so a fresh session never opens on a filtered tree.
//
// Picking an upstream scope records null for the thread: the scope menu does it in its one
// marked line, and opening a turn's diff from anywhere (a `selectTurn`) does it through the
// subscription below, also on a thread with no entry yet, so the seed never overrides the pick. Upstream's own "open the panel on Changes" writes do not clear it, so a
// chosen interval survives the panel closing and reopening.
// No orphan sweep (docs/architecture/loom-ui-state-tiers.md); `removeThread` is for parity.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoomReviewSourceKind, ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useDiffPanelStore } from "../../diffPanelStore";
import { resolveStorage } from "../../lib/storage";

export type ReviewSourcesChoice = "repo" | "everything";

export const REVIEW_SOURCE_KINDS: Record<
  ReviewSourcesChoice,
  ReadonlyArray<LoomReviewSourceKind>
> = {
  repo: ["repo"],
  everything: ["repo", "nested_repo", "artifact_path"],
};

interface ReviewBaselineState {
  intervalIdByThreadKey: Record<string, string | null>;
  sources: ReviewSourcesChoice;
  marksOff: boolean;
  changedOnly: boolean;
  fileChangeLayout: "split" | "unified";
  selectInterval: (ref: ScopedThreadRef, intervalId: string | null) => void;
  /** Selects the live interval only when the thread has no choice recorded yet. */
  seedLive: (ref: ScopedThreadRef) => void;
  setSources: (sources: ReviewSourcesChoice) => void;
  setMarksOff: (marksOff: boolean) => void;
  setChangedOnly: (changedOnly: boolean) => void;
  setFileChangeLayout: (fileChangeLayout: "split" | "unified") => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useReviewBaselineStore = create<ReviewBaselineState>()(
  persist(
    (set) => ({
      intervalIdByThreadKey: {},
      sources: "everything",
      marksOff: false,
      changedOnly: false,
      fileChangeLayout: "split",
      selectInterval: (ref, intervalId) =>
        set((state) => ({
          intervalIdByThreadKey: {
            ...state.intervalIdByThreadKey,
            [scopedThreadKey(ref)]: intervalId,
          },
        })),
      seedLive: (ref) =>
        set((state) =>
          scopedThreadKey(ref) in state.intervalIdByThreadKey
            ? state
            : {
                intervalIdByThreadKey: {
                  ...state.intervalIdByThreadKey,
                  [scopedThreadKey(ref)]: "live",
                },
              },
        ),
      setSources: (sources) => set({ sources }),
      setMarksOff: (marksOff) => set({ marksOff }),
      setChangedOnly: (changedOnly) => set({ changedOnly }),
      setFileChangeLayout: (fileChangeLayout) => set({ fileChangeLayout }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.intervalIdByThreadKey)) return state;
          const { [threadKey]: _removed, ...intervalIdByThreadKey } = state.intervalIdByThreadKey;
          return { intervalIdByThreadKey };
        }),
    }),
    {
      name: "t3code:loom-review-baseline:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        intervalIdByThreadKey: state.intervalIdByThreadKey,
        sources: state.sources,
        marksOff: state.marksOff,
        fileChangeLayout: state.fileChangeLayout,
      }),
    },
  ),
);

useDiffPanelStore.subscribe((state, previous) => {
  // Rehydration replays persisted selections; only a write after it is a user's choice.
  if (!useDiffPanelStore.persist.hasHydrated()) return;
  const cleared = Object.entries(state.byThreadKey).flatMap(([threadKey, selection]) => {
    const before = previous.byThreadKey[threadKey];
    // A `selectTurn` always moves `revealRequestId`; reconciling a turn's id does not.
    const pickedTurn =
      selection.kind === "turn" &&
      (before?.kind !== "turn" || before.revealRequestId !== selection.revealRequestId);
    return pickedTurn && useReviewBaselineStore.getState().intervalIdByThreadKey[threadKey] !== null
      ? [threadKey]
      : [];
  });
  if (cleared.length === 0) return;
  useReviewBaselineStore.setState((baseline) => ({
    intervalIdByThreadKey: {
      ...baseline.intervalIdByThreadKey,
      ...Object.fromEntries(cleared.map((threadKey) => [threadKey, null])),
    },
  }));
});
