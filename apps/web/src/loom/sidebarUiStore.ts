// loom: fork-owned durable sidebar UI state. Goal collapse is a per-goal
// user choice that should behave like the adjacent upstream project collapse
// (`uiStateStore.collapsedProjectCwds`) — durable across reloads rather than
// resetting with component lifetime. Goal ids are globally unique, so a flat
// record keyed by goal id is sufficient (no thread/environment scoping needed).
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";

interface SidebarUiStoreState {
  // Only collapsed goals are stored (present ⇒ collapsed); expanding removes the
  // key, keeping the record set-like. Orphaned ids for deleted/archived goals are
  // harmless dead keys — no sweep (goal ids never collide).
  collapsedGoalIds: Record<string, true>;
  toggleGoalCollapse: (goalId: string) => void;
}

export const useSidebarUiStore = create<SidebarUiStoreState>()(
  persist(
    (set) => ({
      collapsedGoalIds: {},
      toggleGoalCollapse: (goalId) =>
        set((state) => {
          if (state.collapsedGoalIds[goalId]) {
            const { [goalId]: _removed, ...rest } = state.collapsedGoalIds;
            return { collapsedGoalIds: rest };
          }
          return { collapsedGoalIds: { ...state.collapsedGoalIds, [goalId]: true } };
        }),
    }),
    {
      name: "t3code:loom-sidebar-ui-state:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ collapsedGoalIds: state.collapsedGoalIds }),
    },
  ),
);
