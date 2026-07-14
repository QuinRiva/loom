import { create } from "zustand";

import type { ViewBox } from "../lib/forkJoinLayout";

/**
 * Session-scoped UI state for the workstream panel (plan W2). Currently holds
 * the graph's last view per orchestration, keyed by the scoped root-thread key
 * (`scopedThreadKey(environmentId, rootThreadId)`), so re-opening any thread of
 * a workstream restores the zoom/pan the user left it at instead of resetting.
 *
 * Deliberately NOT persisted: a viewBox is only meaningful relative to the
 * current layout — across restarts the workstream has usually grown and a
 * restored viewport of stale coordinates is itself a surprise. Session scope
 * fully solves the reset-on-reopen complaint (the graph analogue of scroll
 * position, which is likewise never persisted). If a persisted slice is ever
 * added here, exclude `graphViewByKey` via `partialize`.
 */
export interface WorkstreamGraphView {
  readonly viewBox: ViewBox;
  /** True once the user has zoomed/panned; false means "follow fit-all". */
  readonly adjusted: boolean;
}

interface WorkstreamUiStore {
  graphViewByKey: Readonly<Record<string, WorkstreamGraphView>>;
  setGraphView: (key: string, view: WorkstreamGraphView) => void;
}

export const useWorkstreamUiStore = create<WorkstreamUiStore>((set) => ({
  graphViewByKey: {},
  setGraphView: (key, view) =>
    set((state) => ({ graphViewByKey: { ...state.graphViewByKey, [key]: view } })),
}));
