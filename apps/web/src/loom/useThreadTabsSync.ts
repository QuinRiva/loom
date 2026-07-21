/**
 * loom: URL ↔ active-tab sync for centre-panel thread tabs.
 *
 * The URL (`/$environmentId/$threadId`) is the single source of truth for the
 * *active* tab; the store owns only the grouped open set and each group's order.
 * `useThreadTabsSync` is the one seed writer, called from the thread route — the
 * chokepoint every thread navigation funnels through. It also owns **group-key
 * derivation and coalescing**: the store never computes lineage, so this hook
 * supplies the group key to the seed and reconciles provisional groups into
 * their real root group once ancestor shells replay. `useThreadTabActions`
 * bundles the navigate-aware handlers (activate / close family / reopen /
 * traversal), which operate on the *active group* (the group containing the
 * active thread), so tab activation always flows URL → seed and there is exactly
 * one write-path for `activeKey`.
 */
import { useNavigate } from "@tanstack/react-router";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useRef } from "react";

import { buildThreadRouteParams } from "../threadRoutes";
import { useThreadGroupResolver, type ThreadGroupResolver } from "./threadTabGroups";
import {
  findGroupKeyByTab,
  selectActiveGroup,
  type ThreadTabGroup,
  useThreadTabsStore,
} from "./threadTabsStore";

/**
 * The whole-group merges needed to move every group into the group its tabs now
 * resolve to. A group needs coalescing when its tabs' resolved root key differs
 * from its current bucket key (a provisional group whose ancestors have arrived).
 * All tabs in one provisional group share the same resolved root, so probing the
 * first tab is sufficient.
 */
export function computeGroupMoves(
  groups: Record<string, ThreadTabGroup>,
  resolveGroupKey: ThreadGroupResolver,
): Array<{ from: string; to: string }> {
  const moves: Array<{ from: string; to: string }> = [];
  for (const [groupKey, group] of Object.entries(groups)) {
    const probe = group.tabs[0];
    if (!probe) continue;
    const resolved = resolveGroupKey(probe);
    if (resolved !== groupKey) moves.push({ from: groupKey, to: resolved });
  }
  return moves;
}

/**
 * Seed the open-tab set from the resolved route thread. Gated on
 * `bootstrapComplete && routeThreadExists` so a bad deep link (which the route
 * redirects to `/`) never plants a phantom tab, and a valid thread seeds only
 * once its replay resolves. The seed appends-if-absent into the thread's group
 * and activates; it never reorders the strip and never pins/unpins the preview
 * tab. A separate coalescing effect folds provisional groups into their real
 * root group as ancestor shells arrive.
 */
export function useThreadTabsSync(
  threadRef: ScopedThreadRef | null,
  options: { bootstrapComplete: boolean; routeThreadExists: boolean },
): void {
  const seedActiveTab = useThreadTabsStore((state) => state.seedActiveTab);
  const coalesceGroups = useThreadTabsStore((state) => state.coalesceGroups);
  const resolveGroupKey = useThreadGroupResolver();
  const key = threadRef ? scopedThreadKey(threadRef) : null;
  const { bootstrapComplete, routeThreadExists } = options;

  const refRef = useRef(threadRef);
  refRef.current = threadRef;
  // Resolver kept in a ref so the seed fires once per navigation (keyed on the
  // thread), reading the latest lineage without re-seeding on every shell tick;
  // shell-driven regrouping is the coalescing effect's job.
  const resolveRef = useRef(resolveGroupKey);
  resolveRef.current = resolveGroupKey;

  useEffect(() => {
    if (!key || !bootstrapComplete || !routeThreadExists) return;
    const ref = refRef.current;
    if (ref) seedActiveTab(ref, resolveRef.current(ref));
  }, [key, bootstrapComplete, routeThreadExists, seedActiveTab]);

  // Coalesce provisional groups into their real root group as lineage resolves.
  // Re-runs whenever the resolver identity changes (i.e. the shell list changed).
  useEffect(() => {
    const moves = computeGroupMoves(useThreadTabsStore.getState().groups, resolveGroupKey);
    if (moves.length > 0) coalesceGroups(moves);
  }, [resolveGroupKey, coalesceGroups]);
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
  const resolveGroupKey = useThreadGroupResolver();

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
    const ref = state.reopenClosedTab(resolveGroupKey(nextRef));
    if (ref) navigateToRef(ref);
  }, [navigateToRef, resolveGroupKey]);

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
