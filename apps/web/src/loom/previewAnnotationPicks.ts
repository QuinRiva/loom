// loom: in-flight preview annotation picks, keyed by runtime tab id.
//
// The annotate pop-up and the note typed into it live inside the previewed
// page, and ElectronBrowserHost keeps that page alive however the right panel
// changes. So a pick belongs to the tab, not to whichever PreviewView happens
// to be mounted: an automatic panel switch, a thread switch or a closed and
// reopened panel must leave the pop-up and its text alone. A pick ends only
// when the user cancels it (toggle or Escape), submits it, or the tab or its
// page goes away (main settles the pick then).
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
