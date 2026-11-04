// loom: the open-questions rail's explicit minimise per question (tier 1,
// docs/architecture/loom-ui-state-tiers.md). Each write prunes the thread's entry to the questions
// still pending, so answered and dismissed ones do not accumulate.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

type Collapsed = Readonly<Record<string, true>>;

interface OpenQuestionsUiState {
  collapsedByThreadKey: Readonly<Record<string, Collapsed>>;
  setCollapsed: (
    ref: ScopedThreadRef,
    requestId: string,
    collapsed: boolean,
    pendingRequestIds: ReadonlyArray<string>,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const NO_COLLAPSED: Collapsed = {};

export const useOpenQuestionsUiStore = create<OpenQuestionsUiState>()(
  persist(
    (set) => ({
      collapsedByThreadKey: {},
      setCollapsed: (ref, requestId, collapsed, pendingRequestIds) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const next = Object.fromEntries(
            pendingRequestIds
              .filter((id) =>
                id === requestId ? collapsed : state.collapsedByThreadKey[key]?.[id],
              )
              .map((id) => [id, true] as const),
          );
          const { [key]: _previous, ...rest } = state.collapsedByThreadKey;
          return {
            collapsedByThreadKey: Object.keys(next).length === 0 ? rest : { ...rest, [key]: next },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const { [scopedThreadKey(ref)]: _removed, ...collapsedByThreadKey } =
            state.collapsedByThreadKey;
          return { collapsedByThreadKey };
        }),
    }),
    {
      name: "t3code:loom-open-questions-ui:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ collapsedByThreadKey: state.collapsedByThreadKey }),
      migrate: (persisted) => ({
        collapsedByThreadKey:
          (persisted as { collapsedByThreadKey?: Record<string, Collapsed> } | null)
            ?.collapsedByThreadKey ?? {},
      }),
    },
  ),
);

export const selectCollapsedQuestions = (
  state: Pick<OpenQuestionsUiState, "collapsedByThreadKey">,
  ref: ScopedThreadRef,
): Collapsed => state.collapsedByThreadKey[scopedThreadKey(ref)] ?? NO_COLLAPSED;
