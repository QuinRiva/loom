import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore.seedSurfaces", () => {
  it("first visit (no panel state): opens, adds, and activates the seeded surface", () => {
    useRightPanelStore.getState().seedSurfaces(refA, ["tasks"], "tasks");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "tasks",
      surfaces: [{ id: "tasks", kind: "tasks" }],
    });
  });

  it("seeds both surfaces in one transition and activates tasks over workstream", () => {
    useRightPanelStore.getState().seedSurfaces(refA, ["tasks", "workstream"], "tasks");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "tasks",
      surfaces: [
        { id: "tasks", kind: "tasks" },
        { id: "workstream", kind: "workstream" },
      ],
    });
  });

  it("activates the only seeded surface when the preferred one is not seeded", () => {
    useRightPanelStore.getState().seedSurfaces(refA, ["workstream"], "tasks");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "workstream",
      surfaces: [{ id: "workstream", kind: "workstream" }],
    });
  });

  it("adds a tab without stealing focus or visibility when panel state exists", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().close(refA);
    useRightPanelStore.getState().seedSurfaces(refA, ["tasks"], "tasks");
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff" },
        { id: "tasks", kind: "tasks" },
      ],
    });
  });

  it("is idempotent: reseeding an existing surface makes no change", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().seedSurfaces(refA, ["tasks"], "tasks");
    const before = useRightPanelStore.getState().byThreadKey;
    useRightPanelStore.getState().seedSurfaces(refA, ["tasks"], "tasks");
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });
});
