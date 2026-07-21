import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { resolveThreadGroupKey } from "./threadTabGroups";
import {
  THREAD_TABS_CAP,
  migratePersistedThreadTabs,
  selectActiveGroup,
  selectActiveGroupKey,
  useThreadTabsStore,
} from "./threadTabsStore";

const env = "env-1" as EnvironmentId;
const ref = (id: string) => scopeThreadRef(env, ThreadId.make(id));
const key = (id: string) => scopedThreadKey(ref(id));
const state = () => useThreadTabsStore.getState();

// A one-tree fixture: root R with children A, B. Their group key is R's key.
const refR = ref("root");
const refA = ref("thread-A");
const refB = ref("thread-B");
const refC = ref("thread-C");
const gR = key("root");
// A second tree: root S with child Z. Its group key is S's key.
const refZ = ref("thread-Z");
const gS = key("root-2");

/** Ordered tab keys of a group. */
const groupTabs = (groupKey: string) => (state().groups[groupKey]?.tabs ?? []).map(scopedThreadKey);
/** Ordered tab keys of the active group. */
const activeTabs = () => (selectActiveGroup(state())?.tabs ?? []).map(scopedThreadKey);

beforeEach(() => {
  useThreadTabsStore.setState({ groups: {}, activeKey: null, recentlyClosed: [] });
});

describe("threadTabsStore — grouping", () => {
  it("seeds subthreads of one orchestrator into a single group", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-B")]);
    expect(Object.keys(state().groups)).toEqual([gR]);
    expect(state().activeKey).toBe(key("thread-B"));
    expect(selectActiveGroupKey(state())).toBe(gR);
  });

  it("keeps threads from different roots in different groups; active group follows the URL", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refZ, gS);
    expect(groupTabs(gR)).toEqual([key("thread-A")]);
    expect(groupTabs(gS)).toEqual([key("thread-Z")]);
    // Active is Z → active group is S's group; R's tabs are not in the active group.
    expect(activeTabs()).toEqual([key("thread-Z")]);
    // Switch back to A → active group is R's group.
    state().seedActiveTab(refA, gR);
    expect(activeTabs()).toEqual([key("thread-A")]);
  });

  it("a root thread is its own group", () => {
    state().seedActiveTab(refR, gR);
    state().seedActiveTab(refA, gR);
    expect(groupTabs(gR)).toEqual([key("root"), key("thread-A")]);
  });
});

describe("threadTabsStore — seedActiveTab", () => {
  it("appends an absent thread as a persistent tab and activates it", () => {
    state().seedActiveTab(refA, gR);
    expect(groupTabs(gR)).toEqual([key("thread-A")]);
    expect(state().activeKey).toBe(key("thread-A"));
    expect(state().groups[gR]!.previewKey).toBeNull();
  });

  it("activates an existing tab without reordering or duplicating", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().seedActiveTab(refA, gR);
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-B")]);
    expect(state().activeKey).toBe(key("thread-A"));
  });

  it("does not pin the preview tab (single sidebar click stays transient)", () => {
    state().openTab(refA, gR, "preview");
    state().seedActiveTab(refA, gR);
    expect(state().groups[gR]!.previewKey).toBe(key("thread-A"));
  });
});

describe("threadTabsStore — openTab preview semantics", () => {
  it("replaces the preview tab in place at the same index (within its group)", () => {
    state().openTab(refA, gR, "persistent");
    state().openTab(refB, gR, "preview");
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-B")]);
    state().openTab(refC, gR, "preview");
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-C")]);
    expect(state().groups[gR]!.previewKey).toBe(key("thread-C"));
  });

  it("pins the preview tab on a persistent open of the same thread", () => {
    state().openTab(refA, gR, "preview");
    expect(state().groups[gR]!.previewKey).toBe(key("thread-A"));
    state().openTab(refA, gR, "persistent");
    expect(state().groups[gR]!.previewKey).toBeNull();
    expect(groupTabs(gR)).toEqual([key("thread-A")]);
  });

  it("activates an already-open tab instead of duplicating", () => {
    state().openTab(refA, gR, "persistent");
    state().openTab(refB, gR, "persistent");
    state().openTab(refA, gR, "preview");
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-B")]);
    expect(state().activeKey).toBe(key("thread-A"));
  });
});

describe("threadTabsStore — pinTab", () => {
  it("promotes the preview tab and is a no-op otherwise", () => {
    state().openTab(refA, gR, "preview");
    state().pinTab(refB); // not open anywhere → no-op
    expect(state().groups[gR]!.previewKey).toBe(key("thread-A"));
    state().pinTab(refA);
    expect(state().groups[gR]!.previewKey).toBeNull();
  });
});

describe("threadTabsStore — close family (per group)", () => {
  it("returns the index-nearest neighbour when the active tab closes", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().seedActiveTab(refC, gR);
    const fallback = state().closeTab(refC);
    expect(fallback && scopedThreadKey(fallback)).toBe(key("thread-B"));
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-B")]);
    expect(state().activeKey).toBe(key("thread-B"));
  });

  it("returns null and leaves the active tab when a non-active tab closes", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    expect(state().closeTab(refA)).toBeNull();
    expect(state().activeKey).toBe(key("thread-B"));
  });

  it("drops the group and nulls activeKey when its last tab closes", () => {
    state().seedActiveTab(refA, gR);
    const fallback = state().closeTab(refA);
    expect(fallback).toBeNull();
    expect(state().activeKey).toBeNull();
    expect(state().groups[gR]).toBeUndefined();
    expect(state().recentlyClosed.map(scopedThreadKey)).toEqual([key("thread-A")]);
  });

  it("closeOthers keeps only the target within its group", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().seedActiveTab(refC, gR);
    // Another group is untouched by closeOthers on the R group.
    state().seedActiveTab(refZ, gS);
    state().closeOthers(refA);
    expect(groupTabs(gR)).toEqual([key("thread-A")]);
    expect(groupTabs(gS)).toEqual([key("thread-Z")]);
    expect(state().activeKey).toBe(key("thread-A"));
  });

  it("closeToRight keeps the target and everything before it", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().seedActiveTab(refC, gR);
    state().closeToRight(refA);
    expect(groupTabs(gR)).toEqual([key("thread-A")]);
    expect(state().activeKey).toBe(key("thread-A"));
  });

  it("closeAll empties only the active group", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().seedActiveTab(refZ, gS); // active group is now S
    state().seedActiveTab(refA, gR); // active group back to R
    state().closeAll();
    expect(state().groups[gR]).toBeUndefined();
    expect(groupTabs(gS)).toEqual([key("thread-Z")]);
    expect(state().activeKey).toBeNull();
  });
});

describe("threadTabsStore — reopenClosedTab", () => {
  it("reopens the most recently closed tab into the supplied group", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().closeTab(refB);
    const reopened = state().reopenClosedTab(gR);
    expect(reopened && scopedThreadKey(reopened)).toBe(key("thread-B"));
    expect(groupTabs(gR)).toContain(key("thread-B"));
    expect(state().activeKey).toBe(key("thread-B"));
  });

  it("returns null with an empty history", () => {
    expect(state().reopenClosedTab(gR)).toBeNull();
  });
});

describe("threadTabsStore — reorderTab", () => {
  it("moves a tab to a new index within its group", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().seedActiveTab(refC, gR);
    state().reorderTab(refC, 0);
    expect(groupTabs(gR)).toEqual([key("thread-C"), key("thread-A"), key("thread-B")]);
  });

  it("pins the preview tab when it is reordered", () => {
    state().openTab(refA, gR, "persistent");
    state().openTab(refB, gR, "preview");
    state().reorderTab(refB, 0);
    expect(state().groups[gR]!.previewKey).toBeNull();
    expect(groupTabs(gR)).toEqual([key("thread-B"), key("thread-A")]);
  });
});

describe("threadTabsStore — per-group cap eviction", () => {
  it("evicts the least-recently-activated tab past the cap within a group", () => {
    for (let index = 0; index < THREAD_TABS_CAP; index += 1) {
      state().seedActiveTab(ref(`r-${index}`), gR);
    }
    // Re-activate r-0 so it is most-recently-used and protected.
    state().seedActiveTab(ref("r-0"), gR);
    state().seedActiveTab(ref("overflow"), gR);
    const openKeys = groupTabs(gR);
    expect(openKeys.length).toBe(THREAD_TABS_CAP);
    expect(openKeys).not.toContain(key("r-1"));
    expect(openKeys).toContain(key("r-0"));
    expect(openKeys).toContain(key("overflow"));
    expect(state().recentlyClosed.map(scopedThreadKey)).toContain(key("r-1"));
  });

  it("caps each group independently", () => {
    for (let index = 0; index <= THREAD_TABS_CAP; index += 1) {
      state().seedActiveTab(ref(`r-${index}`), gR);
    }
    for (let index = 0; index <= THREAD_TABS_CAP; index += 1) {
      state().seedActiveTab(ref(`s-${index}`), gS);
    }
    expect(state().groups[gR]!.tabs.length).toBe(THREAD_TABS_CAP);
    expect(state().groups[gS]!.tabs.length).toBe(THREAD_TABS_CAP);
  });

  it("never evicts the active tab being opened", () => {
    for (let index = 0; index <= THREAD_TABS_CAP; index += 1) {
      state().seedActiveTab(ref(`r-${index}`), gR);
    }
    expect(groupTabs(gR)).toContain(key(`r-${THREAD_TABS_CAP}`));
    expect(groupTabs(gR).length).toBe(THREAD_TABS_CAP);
  });
});

describe("threadTabsStore — removeThread", () => {
  it("removes a tab and repairs the active key within its group", () => {
    state().seedActiveTab(refA, gR);
    state().seedActiveTab(refB, gR);
    state().removeThread(refB);
    expect(groupTabs(gR)).toEqual([key("thread-A")]);
    expect(state().activeKey).toBe(key("thread-A"));
  });
});

describe("threadTabsStore — coalesceGroups (lineage-lag reconciliation)", () => {
  it("merges a provisional group into its resolved root group, preserving order and active tab", () => {
    // A and B were each seeded provisionally under their own key before the
    // root replayed; now both resolve to root R.
    state().seedActiveTab(refA, key("thread-A"));
    state().seedActiveTab(refB, key("thread-B"));
    expect(Object.keys(state().groups).sort()).toEqual([key("thread-A"), key("thread-B")].sort());

    state().coalesceGroups([
      { from: key("thread-A"), to: gR },
      { from: key("thread-B"), to: gR },
    ]);

    expect(Object.keys(state().groups)).toEqual([gR]);
    expect(groupTabs(gR)).toEqual([key("thread-A"), key("thread-B")]);
    // Active thread (B) is unchanged; the active group is now R.
    expect(state().activeKey).toBe(key("thread-B"));
    expect(selectActiveGroupKey(state())).toBe(gR);
  });

  it("keeps at most one preview per group when merging, demoting the source preview", () => {
    state().openTab(refB, gR, "preview"); // destination group's preview
    state().openTab(refA, key("thread-A"), "preview"); // source group's preview
    state().coalesceGroups([{ from: key("thread-A"), to: gR }]);
    // Destination preview (B) wins; A is demoted to persistent.
    expect(state().groups[gR]!.previewKey).toBe(key("thread-B"));
    expect(groupTabs(gR)).toEqual([key("thread-B"), key("thread-A")]);
  });

  it("is a no-op when nothing changed", () => {
    state().seedActiveTab(refA, gR);
    const before = state().groups;
    state().coalesceGroups([{ from: gR, to: gR }]);
    expect(state().groups).toBe(before);
  });
});

describe("resolveThreadGroupKey", () => {
  const shell = (id: string, parent: string | null): EnvironmentThreadShell =>
    ({
      environmentId: env,
      id: ThreadId.make(id),
      title: id,
      parentThreadId: parent === null ? null : ThreadId.make(parent),
      archivedAt: null,
    }) as unknown as EnvironmentThreadShell;

  it("derives the lineage root as the group key", () => {
    const map = {
      [ThreadId.make("root")]: shell("root", null),
      [ThreadId.make("thread-A")]: shell("thread-A", "root"),
      [ThreadId.make("thread-B")]: shell("thread-B", "thread-A"),
    };
    expect(resolveThreadGroupKey(map, refB)).toBe(gR);
    expect(resolveThreadGroupKey(map, refA)).toBe(gR);
    expect(resolveThreadGroupKey(map, refR)).toBe(gR);
  });

  it("uses the topmost reachable ancestor when the root has not replayed (provisional)", () => {
    // Only A's shell is present, pointing at a not-yet-replayed root.
    const map = { [ThreadId.make("thread-A")]: shell("thread-A", "root") };
    // Topmost reachable is the named-but-missing root → provisional key equals R.
    expect(resolveThreadGroupKey(map, refA)).toBe(gR);
  });

  it("treats an unknown thread as its own group", () => {
    expect(resolveThreadGroupKey({}, refA)).toBe(key("thread-A"));
  });
});

describe("migratePersistedThreadTabs", () => {
  it("drops any pre-v2 (flat) persisted shape → clean slate", () => {
    const flatV1 = {
      tabs: [{ environmentId: "env-1", threadId: "thread-A" }],
      activeKey: "env-1:thread-A",
      previewKey: null,
      mru: ["env-1:thread-A"],
      recentlyClosed: [],
    };
    expect(migratePersistedThreadTabs(flatV1, 1)).toEqual({
      groups: {},
      activeKey: null,
      recentlyClosed: [],
    });
  });

  it("returns empty state for non-object input", () => {
    expect(migratePersistedThreadTabs(null, 2)).toEqual({
      groups: {},
      activeKey: null,
      recentlyClosed: [],
    });
  });

  it("sanitizes a v2-shaped payload: drops malformed tabs, repairs preview/mru, caps groups", () => {
    const migrated = migratePersistedThreadTabs(
      {
        groups: {
          [gR]: {
            tabs: [
              { environmentId: "env-1", threadId: "thread-A" },
              { environmentId: "env-1", threadId: "thread-A" }, // dup
              { environmentId: "", threadId: "thread-B" }, // malformed
              "nonsense",
            ],
            previewKey: "env-1:missing",
            mru: ["env-1:thread-A", "env-1:ghost"],
          },
          [gS]: { tabs: [], previewKey: null, mru: [] }, // empty → dropped
        },
        activeKey: "env-1:thread-A",
        recentlyClosed: [{ environmentId: "env-1", threadId: "thread-Z" }],
      },
      2,
    );
    expect(Object.keys(migrated.groups)).toEqual([gR]);
    expect(migrated.groups[gR]!.tabs.map(scopedThreadKey)).toEqual([key("thread-A")]);
    expect(migrated.groups[gR]!.previewKey).toBeNull();
    expect(migrated.groups[gR]!.mru).toEqual([key("thread-A")]);
    expect(migrated.activeKey).toBe(key("thread-A"));
    expect(migrated.recentlyClosed.map(scopedThreadKey)).toEqual([key("thread-Z")]);
  });

  it("nulls activeKey when it points at no surviving tab", () => {
    const migrated = migratePersistedThreadTabs(
      {
        groups: { [gR]: { tabs: [{ environmentId: "env-1", threadId: "thread-A" }] } },
        activeKey: "env-1:ghost",
        recentlyClosed: [],
      },
      2,
    );
    expect(migrated.activeKey).toBeNull();
  });

  it("applies the per-group cap on load", () => {
    const tabs = Array.from({ length: THREAD_TABS_CAP + 5 }, (_, index) => ({
      environmentId: "env-1",
      threadId: `thread-${index}`,
    }));
    const migrated = migratePersistedThreadTabs({ groups: { [gR]: { tabs } } }, 2);
    expect(migrated.groups[gR]!.tabs.length).toBe(THREAD_TABS_CAP);
  });
});
