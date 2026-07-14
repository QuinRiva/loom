// Loom-owned UI state for the workstream features (plans W1 + W2).
//
// Two DURABLE slices keyed by `scopedThreadKey`, mirroring the persisted-store
// conventions of the upstream per-thread stores (`diffPanelStore`,
// `rightPanelStore`): zustand + persist middleware, versioned migrate, and a
// per-thread `removeThread` parity action. Plus one SESSION-scoped slice
// (`graphViewByKey`) excluded from persistence via `partialize`.
//
// - `autoOpenedByThreadKey` (W1): the durable "auto-open already fired" record,
//   per surface. It replaces the old component-lifetime `useRef` guard so route
//   remounts can no longer resurrect an auto-open over a user's choice.
// - `panelByThreadKey` (W2): the Workstream panel's view, node selection, and
//   half-typed spawn form, so they survive tab switches and navigation like
//   every other per-thread surface.
//
// - `graphViewByKey` (session-scoped, NOT persisted): the graph's last
//   zoom/pan per orchestration, keyed by the scoped ROOT-thread key. A viewBox
//   is only meaningful relative to the current layout — across restarts the
//   workstream has usually grown and a restored viewport of stale coordinates
//   is itself a surprise; session scope solves reset-on-reopen (the graph
//   analogue of scroll position).
//
// Cleanup note (plan W2, rev 4): there is no automatic orphan sweep — the
// client has no catch-up-complete signal, so absence-from-live-state is not a
// safe deletion signal. Orphaned keys are tiny and match the residue class the
// upstream per-thread stores already accept. `removeThread` exists for parity
// and for the day upstream grows a real deletion path to wire into.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { ViewBox } from "../lib/forkJoinLayout";
import { resolveStorage } from "../lib/storage";
import type { SeedableSurfaceKind } from "./seedRightPanelSurfaces";

export type AutoOpenedSurfaces = { tasks?: true; workstream?: true };

export interface WorkstreamGraphView {
  readonly viewBox: ViewBox;
  /** True once the user has zoomed/panned; false means "follow fit-all". */
  readonly adjusted: boolean;
}

export type WorkstreamPanelView = "graph" | "board";

export interface WorkstreamSpawnDraft {
  role: string;
  title: string;
  purpose: string;
}

export interface WorkstreamPanelState {
  view: WorkstreamPanelView;
  selectedThreadId: ThreadId | null;
  spawnDraft: WorkstreamSpawnDraft;
}

export const EMPTY_SPAWN_DRAFT: WorkstreamSpawnDraft = { role: "", title: "", purpose: "" };

export const DEFAULT_WORKSTREAM_PANEL_STATE: WorkstreamPanelState = {
  view: "graph",
  selectedThreadId: null,
  spawnDraft: EMPTY_SPAWN_DRAFT,
};

interface WorkstreamUiStoreState {
  autoOpenedByThreadKey: Record<string, AutoOpenedSurfaces>;
  panelByThreadKey: Record<string, WorkstreamPanelState>;
  /** Session-scoped; excluded from persistence via `partialize`. */
  graphViewByKey: Readonly<Record<string, WorkstreamGraphView>>;
  setGraphView: (key: string, view: WorkstreamGraphView) => void;
  markAutoOpened: (ref: ScopedThreadRef, kinds: readonly SeedableSurfaceKind[]) => void;
  setView: (ref: ScopedThreadRef, view: WorkstreamPanelView) => void;
  setSelectedThreadId: (ref: ScopedThreadRef, threadId: ThreadId | null) => void;
  updateSpawnDraft: (ref: ScopedThreadRef, patch: Partial<WorkstreamSpawnDraft>) => void;
  clearSpawnDraft: (ref: ScopedThreadRef) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const updatePanel = (
  panelByThreadKey: Record<string, WorkstreamPanelState>,
  threadKey: string,
  updater: (current: WorkstreamPanelState) => WorkstreamPanelState,
): Record<string, WorkstreamPanelState> => {
  const current = panelByThreadKey[threadKey] ?? DEFAULT_WORKSTREAM_PANEL_STATE;
  const next = updater(current);
  if (next === current) return panelByThreadKey;
  return { ...panelByThreadKey, [threadKey]: next };
};

export const useWorkstreamUiStore = create<WorkstreamUiStoreState>()(
  persist(
    (set) => ({
      autoOpenedByThreadKey: {},
      panelByThreadKey: {},
      graphViewByKey: {},
      setGraphView: (key, view) =>
        set((state) => ({ graphViewByKey: { ...state.graphViewByKey, [key]: view } })),
      markAutoOpened: (ref, kinds) =>
        set((state) => {
          if (kinds.length === 0) return state;
          const threadKey = scopedThreadKey(ref);
          const current = state.autoOpenedByThreadKey[threadKey] ?? {};
          const next: AutoOpenedSurfaces = { ...current };
          for (const kind of kinds) next[kind] = true;
          return {
            autoOpenedByThreadKey: { ...state.autoOpenedByThreadKey, [threadKey]: next },
          };
        }),
      setView: (ref, view) =>
        set((state) => ({
          panelByThreadKey: updatePanel(state.panelByThreadKey, scopedThreadKey(ref), (current) =>
            current.view === view ? current : { ...current, view },
          ),
        })),
      setSelectedThreadId: (ref, threadId) =>
        set((state) => ({
          panelByThreadKey: updatePanel(state.panelByThreadKey, scopedThreadKey(ref), (current) =>
            current.selectedThreadId === threadId
              ? current
              : { ...current, selectedThreadId: threadId },
          ),
        })),
      updateSpawnDraft: (ref, patch) =>
        set((state) => ({
          panelByThreadKey: updatePanel(
            state.panelByThreadKey,
            scopedThreadKey(ref),
            (current) => ({
              ...current,
              spawnDraft: { ...current.spawnDraft, ...patch },
            }),
          ),
        })),
      clearSpawnDraft: (ref) =>
        set((state) => ({
          panelByThreadKey: updatePanel(state.panelByThreadKey, scopedThreadKey(ref), (current) =>
            current.spawnDraft === EMPTY_SPAWN_DRAFT
              ? current
              : { ...current, spawnDraft: EMPTY_SPAWN_DRAFT },
          ),
        })),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const hasAutoOpened = threadKey in state.autoOpenedByThreadKey;
          const hasPanel = threadKey in state.panelByThreadKey;
          if (!hasAutoOpened && !hasPanel) return state;
          const { [threadKey]: _removedFlags, ...autoOpenedByThreadKey } =
            state.autoOpenedByThreadKey;
          const { [threadKey]: _removedPanel, ...panelByThreadKey } = state.panelByThreadKey;
          return { autoOpenedByThreadKey, panelByThreadKey };
        }),
    }),
    {
      name: "t3code:loom-workstream-ui:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        autoOpenedByThreadKey: state.autoOpenedByThreadKey,
        panelByThreadKey: state.panelByThreadKey,
      }),
      migrate: () => ({ autoOpenedByThreadKey: {}, panelByThreadKey: {} }),
    },
  ),
);

export function selectAutoOpenedSurfaces(
  state: WorkstreamUiStoreState,
  ref: ScopedThreadRef | null | undefined,
): AutoOpenedSurfaces {
  if (!ref) return {};
  return state.autoOpenedByThreadKey[scopedThreadKey(ref)] ?? {};
}

export function selectWorkstreamPanelState(
  panelByThreadKey: Record<string, WorkstreamPanelState>,
  ref: ScopedThreadRef | null | undefined,
): WorkstreamPanelState {
  if (!ref) return DEFAULT_WORKSTREAM_PANEL_STATE;
  return panelByThreadKey[scopedThreadKey(ref)] ?? DEFAULT_WORKSTREAM_PANEL_STATE;
}
