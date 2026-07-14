import { beforeEach, describe, expect, it } from "vite-plus/test";

import { useSidebarUiStore } from "./sidebarUiStore";

describe("sidebarUiStore", () => {
  beforeEach(() => useSidebarUiStore.setState({ collapsedGoalIds: {} }));

  it("starts with no collapsed goals", () => {
    expect(useSidebarUiStore.getState().collapsedGoalIds).toEqual({});
  });

  it("toggles a goal collapsed then expanded (set-like record)", () => {
    const { toggleGoalCollapse } = useSidebarUiStore.getState();
    toggleGoalCollapse("goal-1");
    expect(useSidebarUiStore.getState().collapsedGoalIds).toEqual({ "goal-1": true });

    toggleGoalCollapse("goal-1");
    expect(useSidebarUiStore.getState().collapsedGoalIds).toEqual({});
  });

  it("tracks multiple goals independently", () => {
    const { toggleGoalCollapse } = useSidebarUiStore.getState();
    toggleGoalCollapse("goal-1");
    toggleGoalCollapse("goal-2");
    expect(useSidebarUiStore.getState().collapsedGoalIds).toEqual({
      "goal-1": true,
      "goal-2": true,
    });

    toggleGoalCollapse("goal-1");
    expect(useSidebarUiStore.getState().collapsedGoalIds).toEqual({ "goal-2": true });
  });

  it("persists only the collapsed-ids slice under the versioned key", () => {
    const persistOptions = (
      useSidebarUiStore as unknown as {
        persist: {
          getOptions: () => {
            name: string;
            version: number;
            partialize: (state: { collapsedGoalIds: Record<string, true> }) => unknown;
          };
        };
      }
    ).persist.getOptions();
    expect(persistOptions.name).toBe("t3code:loom-sidebar-ui-state:v1");
    expect(persistOptions.version).toBe(1);
    expect(persistOptions.partialize({ collapsedGoalIds: { "goal-1": true } })).toEqual({
      collapsedGoalIds: { "goal-1": true },
    });
  });
});
