// Loom-owned UI state for the workstream surfaces (state tiers 1 and 4,
// docs/architecture/loom-ui-state-tiers.md). No orphan sweep (the client has no catch-up-complete
// signal); `removeThread` exists for parity with the upstream per-thread stores.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ViewBox } from "../lib/forkJoinLayout";
import { resolveStorage } from "../lib/storage";

/** Keyed by surface for the persisted shape; the Workstream tab is the only seeded one. */
export type AutoOpenedSurfaces = { readonly workstream?: true };

export interface WorkstreamGraphView {
  readonly viewBox: ViewBox;
  /** True once the user has zoomed/panned; false means "follow fit-all". */
  readonly adjusted: boolean;
}

interface WorkstreamUiStoreState {
  /** Tier 1, persisted: the auto-open already fired, so a remount never resurrects it over a choice. */
  autoOpenedByThreadKey: Record<string, AutoOpenedSurfaces>;
  /**
   * Tier 1, persisted: per author thread, the query-thread promotions already seeded into its
   * composer. Recorded on seed, never removed, so deleting the chip is the dismissal.
   */
  seededPromotionIdsByThreadKey: Readonly<Record<string, ReadonlyArray<string>>>;
  markPromotionsSeeded: (ref: ScopedThreadRef, promotionIds: ReadonlyArray<string>) => void;
  /**
   * Session-scoped, excluded from persistence via `partialize`: the graph's last zoom and pan per
   * root-thread key, since a viewBox means something only against the current layout.
   */
  graphViewByKey: Readonly<Record<string, WorkstreamGraphView>>;
  setGraphView: (key: string, view: WorkstreamGraphView) => void;
  markAutoOpened: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

export const useWorkstreamUiStore = create<WorkstreamUiStoreState>()(
  persist(
    (set) => ({
      autoOpenedByThreadKey: {},
      seededPromotionIdsByThreadKey: {},
      graphViewByKey: {},
      markPromotionsSeeded: (ref, promotionIds) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const seeded = state.seededPromotionIdsByThreadKey[key] ?? [];
          return {
            seededPromotionIdsByThreadKey: {
              ...state.seededPromotionIdsByThreadKey,
              [key]: [...new Set([...seeded, ...promotionIds])],
            },
          };
        }),
      setGraphView: (key, view) =>
        set((state) => ({ graphViewByKey: { ...state.graphViewByKey, [key]: view } })),
      markAutoOpened: (ref) =>
        set((state) => ({
          autoOpenedByThreadKey: {
            ...state.autoOpenedByThreadKey,
            [scopedThreadKey(ref)]: { workstream: true },
          },
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const { [threadKey]: _removed, ...autoOpenedByThreadKey } = state.autoOpenedByThreadKey;
          const { [threadKey]: _seeded, ...seededPromotionIdsByThreadKey } =
            state.seededPromotionIdsByThreadKey;
          return { autoOpenedByThreadKey, seededPromotionIdsByThreadKey };
        }),
    }),
    {
      // v2: the V1 panel slice (board/graph view, spawn draft) is gone — the
      // workstream surface is the graph and manual spawn has no V2 command.
      // v3: seeded query-thread promotions.
      name: "t3code:loom-workstream-ui:v1",
      version: 3,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        autoOpenedByThreadKey: state.autoOpenedByThreadKey,
        seededPromotionIdsByThreadKey: state.seededPromotionIdsByThreadKey,
      }),
      migrate: (persisted) => {
        const state = persisted as {
          autoOpenedByThreadKey?: Record<string, AutoOpenedSurfaces>;
          seededPromotionIdsByThreadKey?: Record<string, ReadonlyArray<string>>;
        } | null;
        return {
          autoOpenedByThreadKey: state?.autoOpenedByThreadKey ?? {},
          seededPromotionIdsByThreadKey: state?.seededPromotionIdsByThreadKey ?? {},
        };
      },
    },
  ),
);

export function selectAutoOpenedSurfaces(
  state: Pick<WorkstreamUiStoreState, "autoOpenedByThreadKey">,
  ref: ScopedThreadRef | null | undefined,
): AutoOpenedSurfaces {
  return ref ? (state.autoOpenedByThreadKey[scopedThreadKey(ref)] ?? {}) : {};
}

const NO_SEEDED_PROMOTIONS: ReadonlyArray<string> = [];

export function selectSeededPromotionIds(
  state: Pick<WorkstreamUiStoreState, "seededPromotionIdsByThreadKey">,
  ref: ScopedThreadRef,
): ReadonlyArray<string> {
  return state.seededPromotionIdsByThreadKey[scopedThreadKey(ref)] ?? NO_SEEDED_PROMOTIONS;
}
