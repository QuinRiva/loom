/**
 * loom: URL ↔ active-tab sync. The URL is the single source of truth for the active tab; the store
 * owns only the grouped open set and order. `useThreadTabsSync`, called from the thread route every
 * navigation funnels through, is the one seed writer and owns group-key derivation and regrouping;
 * `useThreadTabActions` acts on the active group, so `activeKey` has one write path (URL → seed).
 */
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { buildThreadRouteParams } from "../threadRoutes";
import { isThreadGone, resolveThreadGroupKey, useThreadTabLineage } from "./threadTabGroups";
import { findGroupKeyByTab, selectActiveGroup, useThreadTabsStore } from "./threadTabsStore";

/**
 * Seed the open-tab set from the resolved route thread, gated on `bootstrapComplete &&
 * routeThreadExists` so a bad deep link never plants a phantom tab; append-if-absent, never
 * reordering or pinning. A second effect regroups tabs whose lineage arrived late and prunes
 * archived or deleted threads, except the route's own thread while it is on screen.
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

  // Reads the latest ref and lineage, so the seed fires once per navigation
  // (keyed on the thread) without re-seeding when lineage changes; regrouping
  // is the first effect below. A thread the index does not know yet is its own group.
  const seed = useStableCallback(() => {
    if (threadRef)
      seedActiveTab(
        threadRef,
        resolveThreadGroupKey(lineage, threadRef) ?? scopedThreadKey(threadRef),
      );
  });

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
    if (key && bootstrapComplete && routeThreadExists) seed();
  }, [key, bootstrapComplete, routeThreadExists, seed]);
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

  const navigateToRef = (ref: ScopedThreadRef) => {
    void navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };
  const navigateHome = () => {
    void navigate({ to: "/" });
  };

  // After a structural close (others/right/all), navigate only if the current
  // view's thread was removed. The store has already set a deterministic
  // activeKey; navigation re-affirms it through the seed.
  const reconcileAfterStructuralClose = () => {
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
  };

  const closeTab = (ref: ScopedThreadRef) => {
    const wasActive =
      activeRouteRef !== null && scopedThreadKey(activeRouteRef) === scopedThreadKey(ref);
    const fallback = useThreadTabsStore.getState().closeTab(ref);
    if (!wasActive) return;
    if (fallback) navigateToRef(fallback);
    else navigateHome();
  };

  const closeOthers = (ref: ScopedThreadRef) => {
    useThreadTabsStore.getState().closeOthers(ref);
    reconcileAfterStructuralClose();
  };

  const closeToRight = (ref: ScopedThreadRef) => {
    useThreadTabsStore.getState().closeToRight(ref);
    reconcileAfterStructuralClose();
  };

  const closeAll = () => {
    useThreadTabsStore.getState().closeAll();
    reconcileAfterStructuralClose();
  };

  const reopenClosed = () => {
    const state = useThreadTabsStore.getState();
    const nextRef = state.recentlyClosed[0];
    if (!nextRef) return;
    const ref = state.reopenClosedTab(
      resolveThreadGroupKey(lineage, nextRef) ?? scopedThreadKey(nextRef),
    );
    if (ref) navigateToRef(ref);
  };

  const goAdjacentTab = (direction: "previous" | "next") => {
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
  };

  const jumpToTab = (index: number) => {
    const tabs = selectActiveGroup(useThreadTabsStore.getState())?.tabs ?? [];
    const target = tabs[index];
    if (!target) return false;
    navigateToRef(target);
    return true;
  };

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
