/**
 * loom: centre-panel thread tabs — the durable open-tab set.
 *
 * Threads open as tabs in the centre panel, mirroring how the right panel tabs
 * its surfaces. This store owns the ordered open set and its order; the active
 * tab is a pure mirror of the URL (see `useThreadTabsSync`), so effect ordering
 * never decides which tab is active.
 *
 * Tier 1 (durable UI store) per `docs/architecture/loom-ui-state-tiers.md`, with
 * one deliberate variance: it is workspace-scoped rather than keyed by
 * `scopedThreadKey` — it *contains* many thread refs rather than being scoped
 * under one. It still carries the tier's obligations: versioned migration, no
 * absence-based sweep, a `removeThread` parity hook, and the seed-not-override
 * write policy (the seed appends-if-absent and never reorders).
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { closeWithNeighbourFallback, keepOnly, truncateAfter } from "../lib/tabListOps";

const THREAD_TABS_STORAGE_KEY = "t3code:thread-tabs:v1";
const THREAD_TABS_STORAGE_VERSION = 1;

/** Soft cap on open tabs; least-recently-activated non-preview tabs evict past it. */
export const THREAD_TABS_CAP = 12;
const RECENTLY_CLOSED_CAP = 10;

export type ThreadTabOpenMode = "preview" | "persistent";

export interface ThreadTabsState {
  /** Ordered open set. Identity = scopedThreadKey(ref). No duplicates. */
  tabs: ScopedThreadRef[];
  /** scopedThreadKey of the active tab — a pure mirror of the URL. */
  activeKey: string | null;
  /** scopedThreadKey of the transient preview tab, if any; always ∈ tabs. */
  previewKey: string | null;
  /** Keys in most-recently-activated-first order; drives cap eviction. */
  mru: string[];
  /** Recently closed refs, most recent first, capped; backs reopenClosedTab. */
  recentlyClosed: ScopedThreadRef[];

  /** Route-driven seed: append-if-absent (persistent) + activate. Never reorders. */
  seedActiveTab: (ref: ScopedThreadRef) => void;
  /** Explicit open with intent; dedupes by key (activates existing rather than duplicating). */
  openTab: (ref: ScopedThreadRef, mode: ThreadTabOpenMode) => void;
  /** Promote the preview tab to persistent (clears previewKey if it matches). */
  pinTab: (ref: ScopedThreadRef) => void;
  /**
   * Remove a tab; push onto recentlyClosed. Returns the neighbour-fallback ref
   * to navigate to when the closed tab was active (null ⇒ set emptied or the
   * closed tab was not active), so the caller owns navigation.
   */
  closeTab: (ref: ScopedThreadRef) => ScopedThreadRef | null;
  closeOthers: (ref: ScopedThreadRef) => void;
  closeToRight: (ref: ScopedThreadRef) => void;
  closeAll: () => void;
  /** Pop recentlyClosed; opens it persistent. Returns the ref to navigate to (or null). */
  reopenClosedTab: () => ScopedThreadRef | null;
  /** Drag-reorder. Reordering the preview tab pins it. */
  reorderTab: (ref: ScopedThreadRef, toIndex: number) => void;
  /** Parity hook for a future real thread-deletion path. NOT called from any sweep. */
  removeThread: (ref: ScopedThreadRef) => void;
}

const keyOf = (ref: ScopedThreadRef): string => scopedThreadKey(ref);

const promoteMru = (mru: readonly string[], key: string): string[] => [
  key,
  ...mru.filter((entry) => entry !== key),
];

const pushRecentlyClosed = (
  recentlyClosed: readonly ScopedThreadRef[],
  refs: readonly ScopedThreadRef[],
): ScopedThreadRef[] => [...refs].toReversed().concat(recentlyClosed).slice(0, RECENTLY_CLOSED_CAP);

/**
 * Enforce the tab cap by evicting least-recently-activated non-preview tabs.
 * Never evicts the active tab, the preview tab, or `protectedKey` (the tab just
 * opened). Evicted refs are pushed onto `recentlyClosed`.
 */
function enforceCap(state: ThreadTabsInternal, protectedKey: string | null): ThreadTabsInternal {
  if (state.tabs.length <= THREAD_TABS_CAP) return state;
  let { tabs, mru, recentlyClosed } = state;
  const evicted: ScopedThreadRef[] = [];
  while (tabs.length > THREAD_TABS_CAP) {
    const protectedKeys = new Set(
      [state.activeKey, state.previewKey, protectedKey].filter(
        (value): value is string => value !== null,
      ),
    );
    let target: ScopedThreadRef | null = null;
    let targetRank = -Infinity;
    for (const ref of tabs) {
      const key = keyOf(ref);
      if (protectedKeys.has(key)) continue;
      const rankIndex = mru.indexOf(key);
      // Never-activated tabs (rankIndex === -1) are the least recent of all.
      const rank = rankIndex === -1 ? Infinity : rankIndex;
      if (rank > targetRank) {
        target = ref;
        targetRank = rank;
      }
    }
    if (!target) break;
    const targetKey = keyOf(target);
    evicted.push(target);
    tabs = tabs.filter((ref) => keyOf(ref) !== targetKey);
    mru = mru.filter((entry) => entry !== targetKey);
  }
  if (evicted.length === 0) return state;
  return { ...state, tabs, mru, recentlyClosed: pushRecentlyClosed(recentlyClosed, evicted) };
}

type ThreadTabsInternal = Pick<
  ThreadTabsState,
  "tabs" | "activeKey" | "previewKey" | "mru" | "recentlyClosed"
>;

const EMPTY_STATE: ThreadTabsInternal = {
  tabs: [],
  activeKey: null,
  previewKey: null,
  mru: [],
  recentlyClosed: [],
};

function isWellFormedRef(value: unknown): value is ScopedThreadRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.environmentId === "string" &&
    candidate.environmentId.length > 0 &&
    typeof candidate.threadId === "string" &&
    candidate.threadId.length > 0
  );
}

function sanitizeRefList(value: unknown): ScopedThreadRef[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: ScopedThreadRef[] = [];
  for (const entry of value) {
    if (!isWellFormedRef(entry)) continue;
    const ref: ScopedThreadRef = {
      environmentId: entry.environmentId,
      threadId: entry.threadId,
    };
    const key = keyOf(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(ref);
  }
  return result;
}

export function migratePersistedThreadTabs(persistedState: unknown): ThreadTabsInternal {
  if (!persistedState || typeof persistedState !== "object") {
    return { ...EMPTY_STATE };
  }
  const source = persistedState as Record<string, unknown>;
  const tabs = sanitizeRefList(source.tabs);
  const tabKeys = new Set(tabs.map(keyOf));

  const activeKey =
    typeof source.activeKey === "string" && tabKeys.has(source.activeKey) ? source.activeKey : null;
  const previewKey =
    typeof source.previewKey === "string" && tabKeys.has(source.previewKey)
      ? source.previewKey
      : null;
  const mru = Array.isArray(source.mru)
    ? [
        ...new Set(
          source.mru.filter(
            (entry): entry is string => typeof entry === "string" && tabKeys.has(entry),
          ),
        ),
      ]
    : [];
  const recentlyClosed = sanitizeRefList(source.recentlyClosed).slice(0, RECENTLY_CLOSED_CAP);

  return enforceCap({ tabs, activeKey, previewKey, mru, recentlyClosed }, activeKey);
}

export const useThreadTabsStore = create<ThreadTabsState>()(
  persist(
    (set, get) => ({
      ...EMPTY_STATE,

      seedActiveTab: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          const exists = state.tabs.some((entry) => keyOf(entry) === key);
          if (exists) {
            return { activeKey: key, mru: promoteMru(state.mru, key) };
          }
          const next: ThreadTabsInternal = {
            ...state,
            tabs: [...state.tabs, ref],
            activeKey: key,
            mru: promoteMru(state.mru, key),
          };
          return enforceCap(next, key);
        }),

      openTab: (ref, mode) =>
        set((state) => {
          const key = keyOf(ref);
          const existingIndex = state.tabs.findIndex((entry) => keyOf(entry) === key);
          if (existingIndex >= 0) {
            // Already open: activate; a persistent open of the preview pins it.
            const previewKey =
              mode === "persistent" && state.previewKey === key ? null : state.previewKey;
            return { activeKey: key, previewKey, mru: promoteMru(state.mru, key) };
          }

          if (mode === "preview") {
            const previewIndex =
              state.previewKey !== null
                ? state.tabs.findIndex((entry) => keyOf(entry) === state.previewKey)
                : -1;
            if (previewIndex >= 0) {
              // Replace the existing preview tab in place at the same index.
              const replacedKey = state.previewKey!;
              const tabs = state.tabs.map((entry, index) => (index === previewIndex ? ref : entry));
              return {
                tabs,
                activeKey: key,
                previewKey: key,
                mru: promoteMru(
                  state.mru.filter((entry) => entry !== replacedKey),
                  key,
                ),
              };
            }
            const next: ThreadTabsInternal = {
              ...state,
              tabs: [...state.tabs, ref],
              activeKey: key,
              previewKey: key,
              mru: promoteMru(state.mru, key),
            };
            return enforceCap(next, key);
          }

          const next: ThreadTabsInternal = {
            ...state,
            tabs: [...state.tabs, ref],
            activeKey: key,
            mru: promoteMru(state.mru, key),
          };
          return enforceCap(next, key);
        }),

      pinTab: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          if (state.previewKey !== key) return state;
          return { previewKey: null };
        }),

      closeTab: (ref) => {
        const key = keyOf(ref);
        const state = get();
        const index = state.tabs.findIndex((entry) => keyOf(entry) === key);
        if (index < 0) return null;
        const { list, fallback } = closeWithNeighbourFallback(state.tabs, key, keyOf);
        const wasActive = state.activeKey === key;
        const mru = state.mru.filter((entry) => entry !== key);
        set({
          tabs: list,
          previewKey: state.previewKey === key ? null : state.previewKey,
          recentlyClosed: pushRecentlyClosed(state.recentlyClosed, [ref]),
          activeKey: wasActive ? (fallback ? keyOf(fallback) : null) : state.activeKey,
          mru: wasActive && fallback ? promoteMru(mru, keyOf(fallback)) : mru,
        });
        return wasActive ? fallback : null;
      },

      closeOthers: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          if (!state.tabs.some((entry) => keyOf(entry) === key)) return state;
          const tabs = keepOnly(state.tabs, key, keyOf);
          if (tabs.length === state.tabs.length) return state;
          const removed = state.tabs.filter((entry) => keyOf(entry) !== key);
          return {
            tabs,
            activeKey: key,
            previewKey: state.previewKey === key ? key : null,
            mru: promoteMru([key], key),
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, removed),
          };
        }),

      closeToRight: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          const index = state.tabs.findIndex((entry) => keyOf(entry) === key);
          if (index < 0 || index === state.tabs.length - 1) return state;
          const tabs = truncateAfter(state.tabs, key, keyOf);
          const removed = state.tabs.slice(index + 1);
          const survivingKeys = new Set(tabs.map(keyOf));
          const activeSurvives = state.activeKey !== null && survivingKeys.has(state.activeKey);
          return {
            tabs,
            activeKey: activeSurvives ? state.activeKey : key,
            previewKey:
              state.previewKey !== null && survivingKeys.has(state.previewKey)
                ? state.previewKey
                : null,
            mru: state.mru.filter((entry) => survivingKeys.has(entry)),
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, removed),
          };
        }),

      closeAll: () =>
        set((state) => {
          if (state.tabs.length === 0) return state;
          return {
            tabs: [],
            activeKey: null,
            previewKey: null,
            mru: [],
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, state.tabs),
          };
        }),

      reopenClosedTab: () => {
        const state = get();
        const [ref, ...rest] = state.recentlyClosed;
        if (!ref) return null;
        const key = keyOf(ref);
        const alreadyOpen = state.tabs.some((entry) => keyOf(entry) === key);
        const next: ThreadTabsInternal = {
          ...state,
          tabs: alreadyOpen ? state.tabs : [...state.tabs, ref],
          activeKey: key,
          mru: promoteMru(state.mru, key),
          recentlyClosed: rest,
        };
        set(enforceCap(next, key));
        return ref;
      },

      reorderTab: (ref, toIndex) =>
        set((state) => {
          const key = keyOf(ref);
          const fromIndex = state.tabs.findIndex((entry) => keyOf(entry) === key);
          if (fromIndex < 0) return state;
          const clamped = Math.max(0, Math.min(toIndex, state.tabs.length - 1));
          if (clamped === fromIndex) {
            // No move, but reordering the preview tab still pins it.
            return state.previewKey === key ? { previewKey: null } : state;
          }
          const tabs = [...state.tabs];
          const [moved] = tabs.splice(fromIndex, 1);
          tabs.splice(clamped, 0, moved!);
          return {
            tabs,
            previewKey: state.previewKey === key ? null : state.previewKey,
          };
        }),

      removeThread: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          if (!state.tabs.some((entry) => keyOf(entry) === key)) return state;
          const { list, fallback } = closeWithNeighbourFallback(state.tabs, key, keyOf);
          const wasActive = state.activeKey === key;
          const mru = state.mru.filter((entry) => entry !== key);
          return {
            tabs: list,
            previewKey: state.previewKey === key ? null : state.previewKey,
            activeKey: wasActive ? (fallback ? keyOf(fallback) : null) : state.activeKey,
            mru: wasActive && fallback ? promoteMru(mru, keyOf(fallback)) : mru,
            recentlyClosed: state.recentlyClosed.filter((entry) => keyOf(entry) !== key),
          };
        }),
    }),
    {
      name: THREAD_TABS_STORAGE_KEY,
      version: THREAD_TABS_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ tabs, activeKey, previewKey, mru, recentlyClosed }) => ({
        tabs,
        activeKey,
        previewKey,
        mru,
        recentlyClosed,
      }),
      migrate: migratePersistedThreadTabs,
    },
  ),
);

export function selectTabs(state: ThreadTabsState): ScopedThreadRef[] {
  return state.tabs;
}

export function selectActiveKey(state: ThreadTabsState): string | null {
  return state.activeKey;
}

export function selectIsPreview(state: ThreadTabsState, key: string): boolean {
  return state.previewKey === key;
}
