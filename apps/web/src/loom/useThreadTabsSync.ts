/**
 * loom: URL ↔ active-tab sync for centre-panel thread tabs.
 *
 * The URL (`/$environmentId/$threadId`) is the single source of truth for the
 * *active* tab; the store owns only the set and its order. `useThreadTabsSync`
 * is the one seed writer, called from the thread route — the chokepoint every
 * thread navigation funnels through. `useThreadTabActions` bundles the
 * navigate-aware handlers (activate / close family / reopen / traversal) shared
 * by the tab strip and the keyboard hook, so tab activation always flows
 * URL → seed and there is exactly one write-path for `activeKey`.
 */
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { useThreadTabsStore } from "./threadTabsStore";

/**
 * Seed the open-tab set from the resolved route thread. Gated on
 * `bootstrapComplete && routeThreadExists` so a bad deep link (which the route
 * redirects to `/`) never plants a phantom tab, and a valid thread seeds only
 * once its replay resolves. The seed appends-if-absent and activates; it never
 * reorders the strip and never pins/unpins the preview tab.
 */
export function useThreadTabsSync(
  threadRef: ScopedThreadRef | null,
  options: { bootstrapComplete: boolean; routeThreadExists: boolean },
): void {
  const seedActiveTab = useThreadTabsStore((state) => state.seedActiveTab);
  const key = threadRef ? scopedThreadKey(threadRef) : null;
  const { bootstrapComplete, routeThreadExists } = options;

  const refRef = useRef(threadRef);
  refRef.current = threadRef;

  useEffect(() => {
    if (!key || !bootstrapComplete || !routeThreadExists) return;
    const ref = refRef.current;
    if (ref) seedActiveTab(ref);
  }, [key, bootstrapComplete, routeThreadExists, seedActiveTab]);
}

export interface ThreadTabActions {
  activateTab: (ref: ScopedThreadRef) => void;
  closeTab: (ref: ScopedThreadRef) => void;
  closeOthers: (ref: ScopedThreadRef) => void;
  closeToRight: (ref: ScopedThreadRef) => void;
  closeAll: () => void;
  reopenClosed: () => void;
  /** Activate the previous/next tab in strip order (no wrap). Returns whether it acted. */
  goAdjacentTab: (direction: "previous" | "next") => boolean;
  /** Activate the tab at a strip position. Returns whether it acted. */
  jumpToTab: (index: number) => boolean;
}

/**
 * Navigate-aware tab handlers. `activeRouteRef` is the true URL-active thread
 * (null on the index/draft routes); close operations use it to decide whether
 * the current view lost its thread and must navigate to a survivor.
 */
export function useThreadTabActions(activeRouteRef: ScopedThreadRef | null): ThreadTabActions {
  const navigate = useNavigate();

  const navigateToRef = useCallback(
    (ref: ScopedThreadRef) => {
      void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
    },
    [navigate],
  );
  const navigateHome = useCallback(() => {
    void navigate({ to: "/" });
  }, [navigate]);

  // After a structural close (others/right/all), navigate only if the current
  // view's thread was removed. The store has already set a deterministic
  // activeKey; navigation re-affirms it through the seed.
  const reconcileAfterStructuralClose = useCallback(() => {
    if (!activeRouteRef) return;
    const state = useThreadTabsStore.getState();
    const routeKey = scopedThreadKey(activeRouteRef);
    if (state.tabs.some((tab) => scopedThreadKey(tab) === routeKey)) return;
    const target = state.activeKey
      ? (state.tabs.find((tab) => scopedThreadKey(tab) === state.activeKey) ?? null)
      : null;
    if (target) navigateToRef(target);
    else navigateHome();
  }, [activeRouteRef, navigateHome, navigateToRef]);

  const closeTab = useCallback(
    (ref: ScopedThreadRef) => {
      const wasActive =
        activeRouteRef !== null && scopedThreadKey(activeRouteRef) === scopedThreadKey(ref);
      const fallback = useThreadTabsStore.getState().closeTab(ref);
      if (!wasActive) return;
      if (fallback) navigateToRef(fallback);
      else navigateHome();
    },
    [activeRouteRef, navigateHome, navigateToRef],
  );

  const closeOthers = useCallback(
    (ref: ScopedThreadRef) => {
      useThreadTabsStore.getState().closeOthers(ref);
      reconcileAfterStructuralClose();
    },
    [reconcileAfterStructuralClose],
  );

  const closeToRight = useCallback(
    (ref: ScopedThreadRef) => {
      useThreadTabsStore.getState().closeToRight(ref);
      reconcileAfterStructuralClose();
    },
    [reconcileAfterStructuralClose],
  );

  const closeAll = useCallback(() => {
    useThreadTabsStore.getState().closeAll();
    reconcileAfterStructuralClose();
  }, [reconcileAfterStructuralClose]);

  const reopenClosed = useCallback(() => {
    const ref = useThreadTabsStore.getState().reopenClosedTab();
    if (ref) navigateToRef(ref);
  }, [navigateToRef]);

  const goAdjacentTab = useCallback(
    (direction: "previous" | "next") => {
      const { tabs, activeKey } = useThreadTabsStore.getState();
      if (tabs.length === 0) return false;
      const index = activeKey ? tabs.findIndex((tab) => scopedThreadKey(tab) === activeKey) : -1;
      let target: ScopedThreadRef | undefined;
      if (index === -1) {
        target = direction === "next" ? tabs[0] : tabs[tabs.length - 1];
      } else {
        const nextIndex = direction === "next" ? index + 1 : index - 1;
        if (nextIndex < 0 || nextIndex >= tabs.length) return false;
        target = tabs[nextIndex];
      }
      if (!target) return false;
      navigateToRef(target);
      return true;
    },
    [navigateToRef],
  );

  const jumpToTab = useCallback(
    (index: number) => {
      const { tabs } = useThreadTabsStore.getState();
      const target = tabs[index];
      if (!target) return false;
      navigateToRef(target);
      return true;
    },
    [navigateToRef],
  );

  return {
    activateTab: navigateToRef,
    closeTab,
    closeOthers,
    closeToRight,
    closeAll,
    reopenClosed,
    goAdjacentTab,
    jumpToTab,
  };
}
