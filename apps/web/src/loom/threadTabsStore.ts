/**
 * loom: centre-panel thread tabs — the durable open-tab set, grouped per
 * orchestration tree.
 *
 * Threads open as tabs in the centre panel, mirroring how the right panel tabs
 * its surfaces. Tabs are **grouped by their lineage root**: a root orchestrator
 * thread and all of its subthreads form one group, and switching to a thread
 * under a *different* root shows that root's own strip of tabs. The active tab
 * is a pure mirror of the URL (see `useThreadTabsSync`), so effect ordering
 * never decides which tab is active; the active *group* is derived from the
 * active thread (the group that contains `activeKey`), never stored as a
 * competing source of truth.
 *
 * The store stays pure: it never computes lineage itself. The sync hook has the
 * shell map, so it supplies the group key to the seed/open/reopen actions and
 * drives coalescing (moving a tab from a provisional group into its real root
 * group once ancestor shells replay). Close/reorder/pin locate the group that
 * contains the ref themselves.
 *
 * Tier 1 (durable UI store) per `docs/architecture/loom-ui-state-tiers.md`, with
 * the same deliberate variance as before: it is workspace-scoped rather than
 * keyed by `scopedThreadKey` — it *contains* many thread refs (now bucketed by
 * group) rather than being scoped under one. It still carries the tier's
 * obligations: versioned migration, no absence-based sweep, a `removeThread`
 * parity hook, and the seed-not-override write policy (the seed appends-if-absent
 * within its group and never reorders).
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { closeWithNeighbourFallback, keepOnly, truncateAfter } from "../lib/tabListOps";

// The storage key is kept at the v1 name so the version bump below is what
// triggers migration: the migrator drops any pre-v2 (flat) persisted shape.
const THREAD_TABS_STORAGE_KEY = "t3code:thread-tabs:v1";
const THREAD_TABS_STORAGE_VERSION = 2;

/** Soft cap on open tabs, applied per group; least-recently-activated non-preview tabs evict past it. */
export const THREAD_TABS_CAP = 12;
const RECENTLY_CLOSED_CAP = 10;

export type ThreadTabOpenMode = "preview" | "persistent";

/** One orchestration tree's worth of tabs: the ordered open set for that group. */
export interface ThreadTabGroup {
  /** Ordered open set for this group. Identity = scopedThreadKey(ref). No duplicates. */
  tabs: ScopedThreadRef[];
  /** scopedThreadKey of this group's transient preview tab, if any; always ∈ tabs. */
  previewKey: string | null;
  /** Keys in most-recently-activated-first order; drives this group's cap eviction. */
  mru: string[];
}

export interface ThreadTabsState {
  /** Open tabs bucketed by group key (the lineage root's scopedThreadKey). */
  groups: Record<string, ThreadTabGroup>;
  /** scopedThreadKey of the active tab — a pure mirror of the URL. The active
   * group is derived as the group that contains this key. */
  activeKey: string | null;
  /** Recently closed refs (global across groups), most recent first, capped; backs reopenClosedTab. */
  recentlyClosed: ScopedThreadRef[];

  /** Route-driven seed into `groupKey`: append-if-absent (persistent) + activate.
   * Never reorders; moves the ref out of a stale group if it lived elsewhere. */
  seedActiveTab: (ref: ScopedThreadRef, groupKey: string) => void;
  /** Explicit open with intent into `groupKey`; dedupes by key (activates existing rather than duplicating). */
  openTab: (ref: ScopedThreadRef, groupKey: string, mode: ThreadTabOpenMode) => void;
  /** Promote the preview tab to persistent within its group (no-op otherwise). */
  pinTab: (ref: ScopedThreadRef) => void;
  /**
   * Remove a tab from its group; push onto recentlyClosed. Returns the
   * neighbour-fallback ref (within the group) to navigate to when the closed tab
   * was active (null ⇒ group emptied or the closed tab was not active), so the
   * caller owns navigation.
   */
  closeTab: (ref: ScopedThreadRef) => ScopedThreadRef | null;
  closeOthers: (ref: ScopedThreadRef) => void;
  closeToRight: (ref: ScopedThreadRef) => void;
  /** Close every tab in the active group (the group containing `activeKey`). */
  closeAll: () => void;
  /** Pop recentlyClosed; opens it persistent into `groupKey`. Returns the ref to navigate to (or null). */
  reopenClosedTab: (groupKey: string) => ScopedThreadRef | null;
  /** Drag-reorder within the ref's group. Reordering the preview tab pins it. */
  reorderTab: (ref: ScopedThreadRef, toIndex: number) => void;
  /** Parity hook for a future real thread-deletion path. NOT called from any sweep. */
  removeThread: (ref: ScopedThreadRef) => void;
  /**
   * Coalesce provisional groups into their resolved root groups once lineage
   * replays. Each move merges the `from` group into the `to` group (order
   * preserved, per-group cap re-applied). Driven purely by the sync hook.
   */
  coalesceGroups: (moves: ReadonlyArray<{ from: string; to: string }>) => void;
}

const keyOf = (ref: ScopedThreadRef): string => scopedThreadKey(ref);

const EMPTY_GROUP: ThreadTabGroup = { tabs: [], previewKey: null, mru: [] };

const promoteMru = (mru: readonly string[], key: string): string[] => [
  key,
  ...mru.filter((entry) => entry !== key),
];

const pushRecentlyClosed = (
  recentlyClosed: readonly ScopedThreadRef[],
  refs: readonly ScopedThreadRef[],
): ScopedThreadRef[] => [...refs].toReversed().concat(recentlyClosed).slice(0, RECENTLY_CLOSED_CAP);

/** The group key whose tabs contain `tabKey`, or null. */
export function findGroupKeyByTab(
  groups: Record<string, ThreadTabGroup>,
  tabKey: string | null,
): string | null {
  if (tabKey === null) return null;
  for (const [groupKey, group] of Object.entries(groups)) {
    if (group.tabs.some((entry) => keyOf(entry) === tabKey)) return groupKey;
  }
  return null;
}

/** Groups with `groupKey` removed if it is now empty; otherwise updated in place. */
function setGroup(
  groups: Record<string, ThreadTabGroup>,
  groupKey: string,
  group: ThreadTabGroup,
): Record<string, ThreadTabGroup> {
  const next = { ...groups };
  if (group.tabs.length === 0) delete next[groupKey];
  else next[groupKey] = group;
  return next;
}

/** Remove `tabKey` from `groupKey`, repairing that group's preview/mru; drops the group if emptied. */
function detachTab(
  groups: Record<string, ThreadTabGroup>,
  groupKey: string,
  tabKey: string,
): Record<string, ThreadTabGroup> {
  const group = groups[groupKey];
  if (!group) return groups;
  const tabs = group.tabs.filter((entry) => keyOf(entry) !== tabKey);
  if (tabs.length === group.tabs.length) return groups;
  return setGroup(groups, groupKey, {
    tabs,
    previewKey: group.previewKey === tabKey ? null : group.previewKey,
    mru: group.mru.filter((entry) => entry !== tabKey),
  });
}

/**
 * Enforce the per-group tab cap by evicting least-recently-activated non-preview
 * tabs. Never evicts the active tab, the group's preview tab, or `protectedKey`
 * (the tab just opened). Returns the trimmed group plus evicted refs.
 */
function enforceCapGroup(
  group: ThreadTabGroup,
  opts: { activeKey: string | null; protectedKey: string | null },
): { group: ThreadTabGroup; evicted: ScopedThreadRef[] } {
  if (group.tabs.length <= THREAD_TABS_CAP) return { group, evicted: [] };
  let { tabs, mru } = group;
  const evicted: ScopedThreadRef[] = [];
  while (tabs.length > THREAD_TABS_CAP) {
    const protectedKeys = new Set(
      [opts.activeKey, group.previewKey, opts.protectedKey].filter(
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
  if (evicted.length === 0) return { group, evicted };
  return { group: { ...group, tabs, mru }, evicted };
}

type ThreadTabsInternal = Pick<ThreadTabsState, "groups" | "activeKey" | "recentlyClosed">;

const EMPTY_STATE: ThreadTabsInternal = {
  groups: {},
  activeKey: null,
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

/** Sanitize a single persisted v2 group, repairing preview/mru and applying the cap. */
function sanitizeGroup(value: unknown, activeKey: string | null): ThreadTabGroup | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const tabs = sanitizeRefList(source.tabs);
  if (tabs.length === 0) return null;
  const tabKeys = new Set(tabs.map(keyOf));
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
  const { group } = enforceCapGroup({ tabs, previewKey, mru }, { activeKey, protectedKey: null });
  return group;
}

export function migratePersistedThreadTabs(
  persistedState: unknown,
  version: number,
): ThreadTabsInternal {
  // Any pre-v2 (flat) persisted shape is dropped: clean slate. Only a
  // v2-shaped `{ groups }` payload is carried forward (defensively sanitized).
  if (
    version < THREAD_TABS_STORAGE_VERSION ||
    !persistedState ||
    typeof persistedState !== "object" ||
    !("groups" in persistedState) ||
    typeof (persistedState as Record<string, unknown>).groups !== "object"
  ) {
    return { ...EMPTY_STATE };
  }
  const source = persistedState as Record<string, unknown>;
  const rawGroups = (source.groups ?? {}) as Record<string, unknown>;
  const activeKey = typeof source.activeKey === "string" ? source.activeKey : null;

  const groups: Record<string, ThreadTabGroup> = {};
  for (const [groupKey, rawGroup] of Object.entries(rawGroups)) {
    const group = sanitizeGroup(rawGroup, activeKey);
    if (group) groups[groupKey] = group;
  }
  const activeStillOpen = findGroupKeyByTab(groups, activeKey) !== null;
  const recentlyClosed = sanitizeRefList(source.recentlyClosed).slice(0, RECENTLY_CLOSED_CAP);

  return { groups, activeKey: activeStillOpen ? activeKey : null, recentlyClosed };
}

export const useThreadTabsStore = create<ThreadTabsState>()(
  persist(
    (set, get) => ({
      ...EMPTY_STATE,

      seedActiveTab: (ref, groupKey) =>
        set((state) => {
          const key = keyOf(ref);
          // Lineage-lag move: if the ref sits in a different group (it was seeded
          // provisionally before its root resolved), detach it first.
          const currentGroupKey = findGroupKeyByTab(state.groups, key);
          let groups =
            currentGroupKey && currentGroupKey !== groupKey
              ? detachTab(state.groups, currentGroupKey, key)
              : state.groups;

          const group = groups[groupKey] ?? EMPTY_GROUP;
          const exists = group.tabs.some((entry) => keyOf(entry) === key);
          const nextGroup: ThreadTabGroup = exists
            ? { ...group, mru: promoteMru(group.mru, key) }
            : { ...group, tabs: [...group.tabs, ref], mru: promoteMru(group.mru, key) };
          const { group: capped, evicted } = enforceCapGroup(nextGroup, {
            activeKey: key,
            protectedKey: key,
          });
          groups = setGroup(groups, groupKey, capped);
          return {
            groups,
            activeKey: key,
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, evicted),
          };
        }),

      openTab: (ref, groupKey, mode) =>
        set((state) => {
          const key = keyOf(ref);
          const currentGroupKey = findGroupKeyByTab(state.groups, key);

          if (currentGroupKey === groupKey) {
            // Already open in the target group: activate; a persistent open of
            // the preview pins it.
            const group = state.groups[groupKey]!;
            const previewKey =
              mode === "persistent" && group.previewKey === key ? null : group.previewKey;
            return {
              groups: {
                ...state.groups,
                [groupKey]: { ...group, previewKey, mru: promoteMru(group.mru, key) },
              },
              activeKey: key,
            };
          }

          // Not in the target group (possibly stale in another) → detach then place.
          let groups = currentGroupKey
            ? detachTab(state.groups, currentGroupKey, key)
            : state.groups;
          const group = groups[groupKey] ?? EMPTY_GROUP;

          if (mode === "preview") {
            const previewIndex =
              group.previewKey !== null
                ? group.tabs.findIndex((entry) => keyOf(entry) === group.previewKey)
                : -1;
            if (previewIndex >= 0) {
              // Replace the existing preview tab in place at the same index.
              const replacedKey = group.previewKey!;
              const tabs = group.tabs.map((entry, index) => (index === previewIndex ? ref : entry));
              groups = setGroup(groups, groupKey, {
                tabs,
                previewKey: key,
                mru: promoteMru(
                  group.mru.filter((entry) => entry !== replacedKey),
                  key,
                ),
              });
              return { groups, activeKey: key };
            }
            const { group: capped, evicted } = enforceCapGroup(
              {
                tabs: [...group.tabs, ref],
                previewKey: key,
                mru: promoteMru(group.mru, key),
              },
              { activeKey: key, protectedKey: key },
            );
            groups = setGroup(groups, groupKey, capped);
            return {
              groups,
              activeKey: key,
              recentlyClosed: pushRecentlyClosed(state.recentlyClosed, evicted),
            };
          }

          const { group: capped, evicted } = enforceCapGroup(
            {
              tabs: [...group.tabs, ref],
              previewKey: group.previewKey,
              mru: promoteMru(group.mru, key),
            },
            { activeKey: key, protectedKey: key },
          );
          groups = setGroup(groups, groupKey, capped);
          return {
            groups,
            activeKey: key,
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, evicted),
          };
        }),

      pinTab: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          const groupKey = findGroupKeyByTab(state.groups, key);
          if (!groupKey) return state;
          const group = state.groups[groupKey]!;
          if (group.previewKey !== key) return state;
          return { groups: { ...state.groups, [groupKey]: { ...group, previewKey: null } } };
        }),

      closeTab: (ref) => {
        const key = keyOf(ref);
        const state = get();
        const groupKey = findGroupKeyByTab(state.groups, key);
        if (!groupKey) return null;
        const group = state.groups[groupKey]!;
        const { list, fallback } = closeWithNeighbourFallback(group.tabs, key, keyOf);
        const wasActive = state.activeKey === key;
        const mru = group.mru.filter((entry) => entry !== key);
        const nextGroup: ThreadTabGroup = {
          tabs: list,
          previewKey: group.previewKey === key ? null : group.previewKey,
          mru: wasActive && fallback ? promoteMru(mru, keyOf(fallback)) : mru,
        };
        set({
          groups: setGroup(state.groups, groupKey, nextGroup),
          recentlyClosed: pushRecentlyClosed(state.recentlyClosed, [ref]),
          activeKey: wasActive ? (fallback ? keyOf(fallback) : null) : state.activeKey,
        });
        return wasActive ? fallback : null;
      },

      closeOthers: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          const groupKey = findGroupKeyByTab(state.groups, key);
          if (!groupKey) return state;
          const group = state.groups[groupKey]!;
          const tabs = keepOnly(group.tabs, key, keyOf);
          if (tabs.length === group.tabs.length) return state;
          const removed = group.tabs.filter((entry) => keyOf(entry) !== key);
          return {
            groups: {
              ...state.groups,
              [groupKey]: {
                tabs,
                previewKey: group.previewKey === key ? key : null,
                mru: promoteMru([key], key),
              },
            },
            activeKey: key,
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, removed),
          };
        }),

      closeToRight: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          const groupKey = findGroupKeyByTab(state.groups, key);
          if (!groupKey) return state;
          const group = state.groups[groupKey]!;
          const index = group.tabs.findIndex((entry) => keyOf(entry) === key);
          if (index < 0 || index === group.tabs.length - 1) return state;
          const tabs = truncateAfter(group.tabs, key, keyOf);
          const removed = group.tabs.slice(index + 1);
          const survivingKeys = new Set(tabs.map(keyOf));
          const activeSurvives = state.activeKey !== null && survivingKeys.has(state.activeKey);
          return {
            groups: {
              ...state.groups,
              [groupKey]: {
                tabs,
                previewKey:
                  group.previewKey !== null && survivingKeys.has(group.previewKey)
                    ? group.previewKey
                    : null,
                mru: group.mru.filter((entry) => survivingKeys.has(entry)),
              },
            },
            activeKey: activeSurvives ? state.activeKey : key,
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, removed),
          };
        }),

      closeAll: () =>
        set((state) => {
          const groupKey = findGroupKeyByTab(state.groups, state.activeKey);
          if (!groupKey) return state;
          const group = state.groups[groupKey]!;
          return {
            groups: setGroup(state.groups, groupKey, EMPTY_GROUP),
            activeKey: null,
            recentlyClosed: pushRecentlyClosed(state.recentlyClosed, group.tabs),
          };
        }),

      reopenClosedTab: (groupKey) => {
        const state = get();
        const [ref, ...rest] = state.recentlyClosed;
        if (!ref) return null;
        const key = keyOf(ref);
        // The ref may already be open (in this or another group); detach a stale
        // copy so reopen never duplicates it across groups.
        const currentGroupKey = findGroupKeyByTab(state.groups, key);
        let groups =
          currentGroupKey && currentGroupKey !== groupKey
            ? detachTab(state.groups, currentGroupKey, key)
            : state.groups;
        const group = groups[groupKey] ?? EMPTY_GROUP;
        const exists = group.tabs.some((entry) => keyOf(entry) === key);
        const nextGroup: ThreadTabGroup = exists
          ? { ...group, mru: promoteMru(group.mru, key) }
          : { ...group, tabs: [...group.tabs, ref], mru: promoteMru(group.mru, key) };
        const { group: capped, evicted } = enforceCapGroup(nextGroup, {
          activeKey: key,
          protectedKey: key,
        });
        groups = setGroup(groups, groupKey, capped);
        set({
          groups,
          activeKey: key,
          recentlyClosed: pushRecentlyClosed(rest, evicted),
        });
        return ref;
      },

      reorderTab: (ref, toIndex) =>
        set((state) => {
          const key = keyOf(ref);
          const groupKey = findGroupKeyByTab(state.groups, key);
          if (!groupKey) return state;
          const group = state.groups[groupKey]!;
          const fromIndex = group.tabs.findIndex((entry) => keyOf(entry) === key);
          if (fromIndex < 0) return state;
          const clamped = Math.max(0, Math.min(toIndex, group.tabs.length - 1));
          if (clamped === fromIndex) {
            // No move, but reordering the preview tab still pins it.
            return group.previewKey === key
              ? { groups: { ...state.groups, [groupKey]: { ...group, previewKey: null } } }
              : state;
          }
          const tabs = [...group.tabs];
          const [moved] = tabs.splice(fromIndex, 1);
          tabs.splice(clamped, 0, moved!);
          return {
            groups: {
              ...state.groups,
              [groupKey]: {
                ...group,
                tabs,
                previewKey: group.previewKey === key ? null : group.previewKey,
              },
            },
          };
        }),

      removeThread: (ref) =>
        set((state) => {
          const key = keyOf(ref);
          const groupKey = findGroupKeyByTab(state.groups, key);
          if (!groupKey) return state;
          const group = state.groups[groupKey]!;
          const { list, fallback } = closeWithNeighbourFallback(group.tabs, key, keyOf);
          const wasActive = state.activeKey === key;
          const mru = group.mru.filter((entry) => entry !== key);
          const nextGroup: ThreadTabGroup = {
            tabs: list,
            previewKey: group.previewKey === key ? null : group.previewKey,
            mru: wasActive && fallback ? promoteMru(mru, keyOf(fallback)) : mru,
          };
          return {
            groups: setGroup(state.groups, groupKey, nextGroup),
            activeKey: wasActive ? (fallback ? keyOf(fallback) : null) : state.activeKey,
            recentlyClosed: state.recentlyClosed.filter((entry) => keyOf(entry) !== key),
          };
        }),

      coalesceGroups: (moves) =>
        set((state) => {
          if (moves.length === 0) return state;
          let groups = state.groups;
          let recentlyClosed = state.recentlyClosed;
          for (const { from, to } of moves) {
            if (from === to) continue;
            const fromGroup = groups[from];
            if (!fromGroup || fromGroup.tabs.length === 0) continue;
            const toGroup = groups[to] ?? EMPTY_GROUP;
            const toKeys = new Set(toGroup.tabs.map(keyOf));
            const incoming = fromGroup.tabs.filter((entry) => !toKeys.has(keyOf(entry)));
            // At most one preview per group: keep the destination's preview, and
            // demote the source's preview to persistent if both had one.
            const previewKey =
              toGroup.previewKey ??
              (fromGroup.previewKey && !toKeys.has(fromGroup.previewKey)
                ? fromGroup.previewKey
                : null);
            const mergedTabs = [...toGroup.tabs, ...incoming];
            const mergedMru = [...new Set([...toGroup.mru, ...fromGroup.mru])].filter((entry) =>
              mergedTabs.some((ref) => keyOf(ref) === entry),
            );
            const { group: capped, evicted } = enforceCapGroup(
              { tabs: mergedTabs, previewKey, mru: mergedMru },
              { activeKey: state.activeKey, protectedKey: null },
            );
            const withoutFrom = { ...groups };
            delete withoutFrom[from];
            groups = setGroup(withoutFrom, to, capped);
            recentlyClosed = pushRecentlyClosed(recentlyClosed, evicted);
          }
          if (groups === state.groups) return state;
          return { groups, recentlyClosed };
        }),
    }),
    {
      name: THREAD_TABS_STORAGE_KEY,
      version: THREAD_TABS_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ groups, activeKey, recentlyClosed }) => ({
        groups,
        activeKey,
        recentlyClosed,
      }),
      migrate: migratePersistedThreadTabs,
    },
  ),
);

/** The group key of the active group (the group that contains `activeKey`), or null. */
export function selectActiveGroupKey(state: ThreadTabsState): string | null {
  return findGroupKeyByTab(state.groups, state.activeKey);
}

/** The active group, or null when no tab is active. */
export function selectActiveGroup(state: ThreadTabsState): ThreadTabGroup | null {
  const groupKey = selectActiveGroupKey(state);
  return groupKey ? (state.groups[groupKey] ?? null) : null;
}

export function selectActiveKey(state: ThreadTabsState): string | null {
  return state.activeKey;
}

export function selectIsPreview(group: ThreadTabGroup | null, key: string): boolean {
  return group?.previewKey === key;
}
