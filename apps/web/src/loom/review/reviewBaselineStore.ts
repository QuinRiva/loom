// Loom's change-review baseline (plans/change-review/plan.mdx §5), beside upstream's
// `diffPanelStore`, never inside it:
//
// - `intervalIdByThreadKey` (tier 1, per thread): the selected review interval (`"live"` or a
//   closing message id). Null once the user picks an upstream scope; absent until the thread is
//   first seen with an interval, when "Since your message" is seeded (seed, never override).
// - `sources` (tier 2, client-wide): the Sources toggle, "Everything" by default.
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
  selectInterval: (ref: ScopedThreadRef, intervalId: string | null) => void;
  /** Selects the live interval only when the thread has no choice recorded yet. */
  seedLive: (ref: ScopedThreadRef) => void;
  setSources: (sources: ReviewSourcesChoice) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useReviewBaselineStore = create<ReviewBaselineState>()(
  persist(
    (set) => ({
      intervalIdByThreadKey: {},
      sources: "everything",
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
