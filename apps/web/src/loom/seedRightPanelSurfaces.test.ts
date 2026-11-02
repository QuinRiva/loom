import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { autoOpenLoomSurfaces } from "./useLoomRightPanelSurfaces";
import { selectAutoOpenedSurfaces, useWorkstreamUiStore } from "./workstreamUiStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {} });
});

describe("rightPanelStore.seedWorkstream", () => {
  it("adds a tab without stealing focus or visibility when panel state exists", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().close(refA);
    useRightPanelStore.getState().seedWorkstream(refA, { workstream: true });
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
    useRightPanelStore.getState().seedWorkstream(refA, { workstream: true });
    const before = useRightPanelStore.getState().byThreadKey;
    useRightPanelStore.getState().seedWorkstream(refA, { workstream: true });
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });

  it("does not count as a user choice", () => {
    const revision = useRightPanelStore.getState().getUserActionRevision(refA);
    useRightPanelStore.getState().seedWorkstream(refA, { workstream: true });
    expect(useRightPanelStore.getState().getUserActionRevision(refA)).toBe(revision);
  });
});

describe("the Context tab seed", () => {
  const seed = (contextPanels: boolean, workstreamRoot = false) =>
    autoOpenLoomSurfaces(refA, {
      workstreamRoot,
      autoOpenWorkstreamPanel: true,
      piThread: true,
      contextPanels,
    });

  it("opens on Context on a fresh thread, and on Workstream when both are seeded", () => {
    seed(true);
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "context",
      surfaces: [{ id: "context", kind: "context" }],
    });
    useRightPanelStore.setState({ byThreadKey: {} });
    useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {} });
    seed(true, true);
    expect(panel().activeSurfaceId).toBe("workstream");
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["workstream", "context"]);
  });

  it("adds the tab beside existing state without stealing focus, once", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().close(refA);
    seed(true);
    expect(panel()).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff" },
        { id: "context", kind: "context" },
      ],
    });
    useRightPanelStore.getState().closeSurface(refA, "context");
    seed(true);
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["diff"]);
  });

  it("switches off: removes the tab and its flag as an automatic transition", () => {
    useRightPanelStore.getState().open(refA, "diff");
    seed(true);
    useRightPanelStore.getState().activateSurface(refA, "context");
    const revision = useRightPanelStore.getState().getUserActionRevision(refA);
    seed(false);
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({});
    expect(useRightPanelStore.getState().getUserActionRevision(refA)).toBe(revision);
    seed(true);
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["diff", "context"]);
  });

  it("switches off on a thread with neither the tab nor its flag: no write", () => {
    useRightPanelStore.getState().open(refA, "diff");
    const panels = useRightPanelStore.getState().byThreadKey;
    const flags = useWorkstreamUiStore.getState().autoOpenedByThreadKey;
    seed(false);
    expect(useRightPanelStore.getState().byThreadKey).toBe(panels);
    expect(useWorkstreamUiStore.getState().autoOpenedByThreadKey).toBe(flags);
  });
});
