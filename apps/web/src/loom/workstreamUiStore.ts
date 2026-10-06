// Loom-owned UI state for the workstream surfaces (state tiers 1 and 4,
// docs/architecture/loom-ui-state-tiers.md).
//
// - `autoOpenedByThreadKey` (tier 1, persisted): the durable "auto-open
//   already fired" record per surface, so a remount can never resurrect an
//   auto-open over a user's choice.
// - `graphViewByKey` (session-scoped, NOT persisted): the graph's last
//   zoom/pan per orchestration, keyed by the scoped ROOT-thread key. A viewBox
//   is only meaningful against the current layout, so it does not survive a
//   restart.
//
// No orphan sweep (the client has no catch-up-complete signal); `removeThread`
// exists for parity with the upstream per-thread stores.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ViewBox } from "../lib/forkJoinLayout";
import { resolveStorage } from "../lib/storage";
import type { SeedableSurfaceKind } from "./seedRightPanelSurfaces";

export type AutoOpenedSurfaces = Partial<Record<SeedableSurfaceKind, true>>;

export interface WorkstreamGraphView {
  readonly viewBox: ViewBox;
  /** True once the user has zoomed/panned; false means "follow fit-all". */
  readonly adjusted: boolean;
}

interface WorkstreamUiStoreState {
  autoOpenedByThreadKey: Record<string, AutoOpenedSurfaces>;
  /** Session-scoped; excluded from persistence via `partialize`. */
  graphViewByKey: Readonly<Record<string, WorkstreamGraphView>>;
  setGraphView: (key: string, view: WorkstreamGraphView) => void;
  markAutoOpened: (ref: ScopedThreadRef, kinds: readonly SeedableSurfaceKind[]) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useWorkstreamUiStore = create<WorkstreamUiStoreState>()(
  persist(
    (set) => ({
      autoOpenedByThreadKey: {},
      graphViewByKey: {},
      setGraphView: (key, view) =>
        set((state) => ({ graphViewByKey: { ...state.graphViewByKey, [key]: view } })),
      markAutoOpened: (ref, kinds) =>
        set((state) => {
          if (kinds.length === 0) return state;
          const threadKey = scopedThreadKey(ref);
          return {
            autoOpenedByThreadKey: {
              ...state.autoOpenedByThreadKey,
              [threadKey]: {
                ...state.autoOpenedByThreadKey[threadKey],
                ...Object.fromEntries(kinds.map((kind) => [kind, true])),
              },
            },
          };
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.autoOpenedByThreadKey)) return state;
          const { [threadKey]: _removed, ...autoOpenedByThreadKey } = state.autoOpenedByThreadKey;
          return { autoOpenedByThreadKey };
        }),
    }),
    {
      // v2: the V1 panel slice (board/graph view, spawn draft) is gone — graph
      // is its own surface and manual spawn has no V2 command.
      name: "t3code:loom-workstream-ui:v1",
      version: 2,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ autoOpenedByThreadKey: state.autoOpenedByThreadKey }),
      migrate: (persisted) => ({
        autoOpenedByThreadKey:
          (persisted as { autoOpenedByThreadKey?: Record<string, AutoOpenedSurfaces> } | null)
            ?.autoOpenedByThreadKey ?? {},
      }),
    },
  ),
);

export function selectAutoOpenedSurfaces(
  state: Pick<WorkstreamUiStoreState, "autoOpenedByThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): AutoOpenedSurfaces {
  return ref ? (state.autoOpenedByThreadKey[scopedThreadKey(ref)] ?? {}) : {};
}
