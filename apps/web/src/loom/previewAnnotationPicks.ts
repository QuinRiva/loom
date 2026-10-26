// loom: in-flight preview annotation picks, keyed by runtime tab id. The pop-up and its note live
// in the previewed page, which ElectronBrowserHost keeps alive across panel and thread switches, so
// a pick belongs to the tab, not the mounted PreviewView. It ends only on cancel (toggle or Escape),
// submit, or the tab or its page going away (main settles the pick then).
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";

import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import type { ThreadPreviewState } from "~/previewStateStore";
import type { RightPanelSurface } from "~/rightPanelStore";

export interface PreviewPickRequest {
  cancelled: boolean;
}

const usePicks = create<{ readonly byTab: Readonly<Record<string, PreviewPickRequest>> }>(() => ({
  byTab: {},
}));

/** The tab's in-flight pick, if any. */
export const previewPick = (runtimeTabId: string): PreviewPickRequest | null =>
  usePicks.getState().byTab[runtimeTabId] ?? null;

export function beginPreviewPick(runtimeTabId: string): PreviewPickRequest {
  const request = { cancelled: false };
  usePicks.setState((state) => ({ byTab: { ...state.byTab, [runtimeTabId]: request } }));
  return request;
}

/** Ends `request` while it is still the tab's pick; false once it already ended. */
export function endPreviewPick(runtimeTabId: string, request: PreviewPickRequest): boolean {
  if (previewPick(runtimeTabId) !== request) return false;
  usePicks.setState((state) => {
    const { [runtimeTabId]: _ended, ...byTab } = state.byTab;
    return { byTab };
  });
  return true;
}

export const usePreviewPickActive = (runtimeTabId: string | null): boolean =>
  usePicks((state) => runtimeTabId !== null && state.byTab[runtimeTabId] !== undefined);

/** Whether the right panel's active surface is a browser tab with an annotation in progress. */
export function usePreviewSurfaceAnnotating(
  threadRef: ScopedThreadRef | null,
  preview: Pick<ThreadPreviewState, "activeTabId" | "serverEpoch">,
  surface: RightPanelSurface | null,
): boolean {
  const tabId = surface?.kind === "preview" ? (surface.resourceId ?? preview.activeTabId) : null;
  return usePreviewPickActive(
    threadRef && tabId ? previewRuntimeTabId(threadRef, preview.serverEpoch, tabId) : null,
  );
}
