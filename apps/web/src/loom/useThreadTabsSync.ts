/**
 * loom: URL ↔ active-tab sync for centre-panel thread tabs.
 *
 * The URL (`/$environmentId/$threadId`) is the single source of truth for the
 * *active* tab; the store owns only the grouped open set and each group's order.
 * `useThreadTabsSync` is the one seed writer, called from the thread route — the
 * chokepoint every thread navigation funnels through. It also owns **group-key
 * derivation and regrouping**: the store never computes lineage, so this hook
 * supplies the group key to the seed and moves tabs into their real root group
 * once their lineage is known. `useThreadTabActions` bundles the navigate-aware handlers (activate / close family / reopen /
 * traversal), which operate on the *active group* (the group containing the
 * active thread), so tab activation always flows URL → seed and there is exactly
 * one write-path for `activeKey`.
 */
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { isThreadGone, resolveThreadGroupKey, useThreadTabLineage } from "./threadTabGroups";
import { findGroupKeyByTab, selectActiveGroup, useThreadTabsStore } from "./threadTabsStore";

/**
 * Seed the open-tab set from the resolved route thread. Gated on
 * `bootstrapComplete && routeThreadExists` so a bad deep link (which the route
 * redirects to `/`) never plants a phantom tab, and a valid thread seeds only
 * once its replay resolves. The seed appends-if-absent into the thread's group
 * and activates; it never reorders the strip and never pins/unpins the preview
 * tab. A separate effect regroups tabs whose lineage became known after they
 * were placed (a provisional seed, or the pull-9 flat strip's single bucket),
 * and prunes tabs whose thread was archived or deleted — from any surface,
 * agent or client — except the route's own thread while it is on screen.
 */
export function useThreadTabsSync(
  threadRef: ScopedThreadRef | null,
  options: { bootstrapComplete: boolean; routeThreadExists: boolean },
): void {
  const seedActiveTab = useThreadTabsStore((state) => state.seedActiveTab);
  const regroupTabs = useThreadTabsStore((state) => state.regroupTabs);
  const lineage = useThreadTabLineage();
  const key = threadRef ? scopedThreadKey(threadRef) : null;
  const { bootstrapComplete, routeThreadExists } = options;

  const refRef = useRef(threadRef);
  refRef.current = threadRef;
  // Lineage kept in a ref so the seed fires once per navigation (keyed on the
  // thread) without re-seeding when lineage changes; regrouping is the first
  // effect below. A thread the index does not know yet is its own group.
  const lineageRef = useRef(lineage);
  lineageRef.current = lineage;

  // Runs before the seed, so a mixed bucket splits in its own order. Re-runs
  // only when the lineage index changes or the route thread does.
  useEffect(() => {
    regroupTabs((ref) => resolveThreadGroupKey(lineage, ref));
    const { groups, recentlyClosed, removeThread } = useThreadTabsStore.getState();
    for (const ref of [
      ...Object.values(groups).flatMap((group) => group.tabs),
      ...recentlyClosed,
    ]) {
      if (scopedThreadKey(ref) !== key && isThreadGone(lineage, ref)) removeThread(ref);
    }
  }, [lineage, key, regroupTabs]);

  useEffect(() => {
    if (!key || !bootstrapComplete || !routeThreadExists) return;
    const ref = refRef.current;
    if (ref) seedActiveTab(ref, resolveThreadGroupKey(lineageRef.current, ref) ?? key);
  }, [key, bootstrapComplete, routeThreadExists, seedActiveTab]);
}

export interface ThreadTabActions {
  activateTab: (ref: ScopedThreadRef) => void;
  closeTab: (ref: ScopedThreadRef) => void;
  closeOthers: (ref: ScopedThreadRef) => void;
  closeToRight: (ref: ScopedThreadRef) => void;
  closeAll: () => void;
  reopenClosed: () => void;
  /** Activate the previous/next tab in the active group (strip order, no wrap). Returns whether it acted. */
  goAdjacentTab: (direction: "previous" | "next") => boolean;
  /** Activate the tab at a position in the active group. Returns whether it acted. */
  jumpToTab: (index: number) => boolean;
}

/**
 * Navigate-aware tab handlers. `activeRouteRef` is the true URL-active thread
 * (null on the index/draft routes); close operations use it to decide whether
 * the current view lost its thread and must navigate to a survivor. Traversal
 * and jump act within the active group only.
 */
export function useThreadTabActions(activeRouteRef: ScopedThreadRef | null): ThreadTabActions {
  const navigate = useNavigate();
  const lineage = useThreadTabLineage();

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
    if (findGroupKeyByTab(state.groups, routeKey) !== null) return;
    const target = state.activeKey
      ? (selectActiveGroup(state)?.tabs.find((tab) => scopedThreadKey(tab) === state.activeKey) ??
        null)
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
    const state = useThreadTabsStore.getState();
    const nextRef = state.recentlyClosed[0];
    if (!nextRef) return;
    const ref = state.reopenClosedTab(
      resolveThreadGroupKey(lineage, nextRef) ?? scopedThreadKey(nextRef),
    );
    if (ref) navigateToRef(ref);
  }, [navigateToRef, lineage]);

  const goAdjacentTab = useCallback(
    (direction: "previous" | "next") => {
      const state = useThreadTabsStore.getState();
      const tabs = selectActiveGroup(state)?.tabs ?? [];
      if (tabs.length === 0) return false;
      const activeKey = state.activeKey;
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
      const tabs = selectActiveGroup(useThreadTabsStore.getState())?.tabs ?? [];
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
