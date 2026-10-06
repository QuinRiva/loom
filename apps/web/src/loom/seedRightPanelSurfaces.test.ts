import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore.seedSurfaces", () => {
  it("first visit (no panel state): opens, adds, and activates the seeded surface", () => {
    useRightPanelStore.getState().seedSurfaces(refA, ["graph"]);
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "graph",
      surfaces: [{ id: "graph", kind: "graph" }],
    });
  });

  it("seeds several surfaces in one transition and activates by priority, not order", () => {
    useRightPanelStore.getState().seedSurfaces(refA, ["graph", "workstream"]);
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "workstream",
      surfaces: [
        { id: "graph", kind: "graph" },
        { id: "workstream", kind: "workstream" },
      ],
    });
  });

  it("tasks outranks the workstream surfaces", () => {
    useRightPanelStore.getState().seedSurfaces(refA, ["workstream", "tasks"]);
    expect(panel().activeSurfaceId).toBe("tasks");
  });

  it("adds a tab without stealing focus or visibility when panel state exists", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().close(refA);
    useRightPanelStore.getState().seedSurfaces(refA, ["workstream"]);
    expect(panel()).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff" },
        { id: "workstream", kind: "workstream" },
      ],
    });
  });

  it("is idempotent: reseeding an existing surface makes no change", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().seedSurfaces(refA, ["workstream"]);
    const before = useRightPanelStore.getState().byThreadKey;
    useRightPanelStore.getState().seedSurfaces(refA, ["workstream"]);
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });

  it("does not count as a user choice", () => {
    const revision = useRightPanelStore.getState().getUserActionRevision(refA);
    useRightPanelStore.getState().seedSurfaces(refA, ["workstream"]);
    expect(useRightPanelStore.getState().getUserActionRevision(refA)).toBe(revision);
  });
});
