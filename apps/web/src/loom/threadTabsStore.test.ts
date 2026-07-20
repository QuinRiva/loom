import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { THREAD_TABS_CAP, migratePersistedThreadTabs, useThreadTabsStore } from "./threadTabsStore";

const env = "env-1" as EnvironmentId;
const ref = (id: string) => scopeThreadRef(env, ThreadId.make(id));
const key = (id: string) => scopedThreadKey(ref(id));
const keys = () => useThreadTabsStore.getState().tabs.map((tab) => scopedThreadKey(tab));

const refA = ref("thread-A");
const refB = ref("thread-B");
const refC = ref("thread-C");

beforeEach(() => {
  useThreadTabsStore.setState({
    tabs: [],
    activeKey: null,
    previewKey: null,
    mru: [],
    recentlyClosed: [],
  });
});

describe("threadTabsStore", () => {
  describe("seedActiveTab", () => {
    it("appends an absent thread as a persistent tab and activates it", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      expect(keys()).toEqual([key("thread-A")]);
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-A"));
      expect(useThreadTabsStore.getState().previewKey).toBeNull();
    });

    it("activates an existing tab without reordering or duplicating", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().seedActiveTab(refA);
      expect(keys()).toEqual([key("thread-A"), key("thread-B")]);
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-A"));
    });

    it("does not pin the preview tab (single sidebar click stays transient)", () => {
      useThreadTabsStore.getState().openTab(refA, "preview");
      useThreadTabsStore.getState().seedActiveTab(refA);
      expect(useThreadTabsStore.getState().previewKey).toBe(key("thread-A"));
    });
  });

  describe("openTab preview semantics", () => {
    it("replaces the preview tab in place at the same index", () => {
      useThreadTabsStore.getState().openTab(refA, "persistent");
      useThreadTabsStore.getState().openTab(refB, "preview");
      expect(keys()).toEqual([key("thread-A"), key("thread-B")]);
      useThreadTabsStore.getState().openTab(refC, "preview");
      expect(keys()).toEqual([key("thread-A"), key("thread-C")]);
      expect(useThreadTabsStore.getState().previewKey).toBe(key("thread-C"));
    });

    it("pins the preview tab on a persistent open of the same thread", () => {
      useThreadTabsStore.getState().openTab(refA, "preview");
      expect(useThreadTabsStore.getState().previewKey).toBe(key("thread-A"));
      useThreadTabsStore.getState().openTab(refA, "persistent");
      expect(useThreadTabsStore.getState().previewKey).toBeNull();
      expect(keys()).toEqual([key("thread-A")]);
    });

    it("activates an already-open tab instead of duplicating", () => {
      useThreadTabsStore.getState().openTab(refA, "persistent");
      useThreadTabsStore.getState().openTab(refB, "persistent");
      useThreadTabsStore.getState().openTab(refA, "preview");
      expect(keys()).toEqual([key("thread-A"), key("thread-B")]);
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-A"));
    });
  });

  describe("pinTab", () => {
    it("promotes the preview tab and is a no-op otherwise", () => {
      useThreadTabsStore.getState().openTab(refA, "preview");
      useThreadTabsStore.getState().pinTab(refB);
      expect(useThreadTabsStore.getState().previewKey).toBe(key("thread-A"));
      useThreadTabsStore.getState().pinTab(refA);
      expect(useThreadTabsStore.getState().previewKey).toBeNull();
    });
  });

  describe("closeTab", () => {
    it("returns the index-nearest neighbour when the active tab closes", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().seedActiveTab(refC);
      const fallback = useThreadTabsStore.getState().closeTab(refC);
      expect(fallback && scopedThreadKey(fallback)).toBe(key("thread-B"));
      expect(keys()).toEqual([key("thread-A"), key("thread-B")]);
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-B"));
    });

    it("returns null and leaves the active tab when a non-active tab closes", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      const fallback = useThreadTabsStore.getState().closeTab(refA);
      expect(fallback).toBeNull();
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-B"));
    });

    it("pushes the closed tab onto recentlyClosed", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().closeTab(refA);
      expect(useThreadTabsStore.getState().recentlyClosed.map(scopedThreadKey)).toEqual([
        key("thread-A"),
      ]);
    });

    it("nulls activeKey when the last tab closes", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      const fallback = useThreadTabsStore.getState().closeTab(refA);
      expect(fallback).toBeNull();
      expect(useThreadTabsStore.getState().activeKey).toBeNull();
      expect(keys()).toEqual([]);
    });
  });

  describe("closeOthers / closeToRight / closeAll", () => {
    it("closeOthers keeps only the target and activates it", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().seedActiveTab(refC);
      useThreadTabsStore.getState().closeOthers(refA);
      expect(keys()).toEqual([key("thread-A")]);
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-A"));
      expect(useThreadTabsStore.getState().recentlyClosed.map(scopedThreadKey)).toContain(
        key("thread-B"),
      );
    });

    it("closeToRight keeps the target and everything before it", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().seedActiveTab(refC);
      useThreadTabsStore.getState().closeToRight(refA);
      expect(keys()).toEqual([key("thread-A")]);
      // Active was refC (to the right) → falls back to the kept target.
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-A"));
    });

    it("closeAll empties the set", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().closeAll();
      expect(keys()).toEqual([]);
      expect(useThreadTabsStore.getState().activeKey).toBeNull();
    });
  });

  describe("reopenClosedTab", () => {
    it("reopens the most recently closed tab as persistent", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().closeTab(refB);
      const reopened = useThreadTabsStore.getState().reopenClosedTab();
      expect(reopened && scopedThreadKey(reopened)).toBe(key("thread-B"));
      expect(keys()).toContain(key("thread-B"));
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-B"));
    });

    it("returns null with an empty history", () => {
      expect(useThreadTabsStore.getState().reopenClosedTab()).toBeNull();
    });
  });

  describe("reorderTab", () => {
    it("moves a tab to a new index", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().seedActiveTab(refC);
      useThreadTabsStore.getState().reorderTab(refC, 0);
      expect(keys()).toEqual([key("thread-C"), key("thread-A"), key("thread-B")]);
    });

    it("pins the preview tab when it is reordered", () => {
      useThreadTabsStore.getState().openTab(refA, "persistent");
      useThreadTabsStore.getState().openTab(refB, "preview");
      useThreadTabsStore.getState().reorderTab(refB, 0);
      expect(useThreadTabsStore.getState().previewKey).toBeNull();
      expect(keys()).toEqual([key("thread-B"), key("thread-A")]);
    });
  });

  describe("cap eviction", () => {
    it("evicts the least-recently-activated tab past the cap", () => {
      for (let index = 0; index < THREAD_TABS_CAP; index += 1) {
        useThreadTabsStore.getState().seedActiveTab(ref(`thread-${index}`));
      }
      // Re-activate thread-0 so it is most-recently-used and protected.
      useThreadTabsStore.getState().seedActiveTab(ref("thread-0"));
      useThreadTabsStore.getState().seedActiveTab(ref("overflow"));
      const openKeys = keys();
      expect(openKeys.length).toBe(THREAD_TABS_CAP);
      // thread-1 was the least-recently-activated non-protected tab.
      expect(openKeys).not.toContain(key("thread-1"));
      expect(openKeys).toContain(key("thread-0"));
      expect(openKeys).toContain(key("overflow"));
      expect(useThreadTabsStore.getState().recentlyClosed.map(scopedThreadKey)).toContain(
        key("thread-1"),
      );
    });

    it("never evicts the active tab being opened", () => {
      for (let index = 0; index <= THREAD_TABS_CAP; index += 1) {
        useThreadTabsStore.getState().seedActiveTab(ref(`thread-${index}`));
      }
      expect(keys()).toContain(key(`thread-${THREAD_TABS_CAP}`));
      expect(keys().length).toBe(THREAD_TABS_CAP);
    });
  });

  describe("removeThread", () => {
    it("removes a tab and repairs the active key", () => {
      useThreadTabsStore.getState().seedActiveTab(refA);
      useThreadTabsStore.getState().seedActiveTab(refB);
      useThreadTabsStore.getState().removeThread(refB);
      expect(keys()).toEqual([key("thread-A")]);
      expect(useThreadTabsStore.getState().activeKey).toBe(key("thread-A"));
    });
  });
});

describe("migratePersistedThreadTabs", () => {
  it("returns empty state for non-object input", () => {
    expect(migratePersistedThreadTabs(null)).toEqual({
      tabs: [],
      activeKey: null,
      previewKey: null,
      mru: [],
      recentlyClosed: [],
    });
  });

  it("drops malformed tab entries and dedupes by key", () => {
    const migrated = migratePersistedThreadTabs({
      tabs: [
        { environmentId: "env-1", threadId: "thread-A" },
        { environmentId: "env-1", threadId: "thread-A" },
        { environmentId: "", threadId: "thread-B" },
        { threadId: "thread-C" },
        "nonsense",
      ],
      activeKey: "env-1:thread-A",
      previewKey: "env-1:missing",
      mru: ["env-1:thread-A", "env-1:ghost"],
      recentlyClosed: [{ environmentId: "env-1", threadId: "thread-Z" }],
    });
    expect(migrated.tabs.map(scopedThreadKey)).toEqual(["env-1:thread-A"]);
    expect(migrated.activeKey).toBe("env-1:thread-A");
    expect(migrated.previewKey).toBeNull();
    expect(migrated.mru).toEqual(["env-1:thread-A"]);
    expect(migrated.recentlyClosed.map(scopedThreadKey)).toEqual(["env-1:thread-Z"]);
  });

  it("applies the tab cap on load", () => {
    const tabs = Array.from({ length: THREAD_TABS_CAP + 5 }, (_, index) => ({
      environmentId: "env-1",
      threadId: `thread-${index}`,
    }));
    const migrated = migratePersistedThreadTabs({ tabs });
    expect(migrated.tabs.length).toBe(THREAD_TABS_CAP);
  });
});
