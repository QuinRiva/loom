import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { autoOpenLoomSurfaces } from "./useLoomRightPanelSurfaces";
import { useWorkstreamUiStore } from "./workstreamUiStore";

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

describe("the Goal tasks, Workstream and Context seeds", () => {
  const seed = ({ goalThread = true, workstreamRoot = false, contextPanels = true } = {}) =>
    autoOpenLoomSurfaces(refA, {
      goalThread,
      workstreamRoot,
      autoOpenWorkstreamPanel: true,
      contextPanels,
    });
  const ids = () => panel().surfaces.map((surface) => surface.id);

  it("opens a fresh goal thread on Goal tasks, never Context; on Workstream when both are due", () => {
    seed();
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "tasks",
      surfaces: [{ id: "tasks", kind: "tasks" }],
    });
    useRightPanelStore.setState({ byThreadKey: {} });
    useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {} });
    seed({ workstreamRoot: true });
    expect(panel().activeSurfaceId).toBe("workstream");
    expect(ids()).toEqual(["tasks", "workstream"]);
  });

  it("the first child brings Workstream in front of the seeded Goal tab, once", () => {
    seed();
    seed({ workstreamRoot: true });
    expect(panel().activeSurfaceId).toBe("workstream");
    useRightPanelStore.getState().activateSurface(refA, "tasks");
    seed({ workstreamRoot: true });
    expect(panel().activeSurfaceId).toBe("tasks");
  });

  it("Workstream arrives behind another choice or a closed panel", () => {
    seed();
    useRightPanelStore.getState().open(refA, "diff");
    seed({ workstreamRoot: true });
    expect(panel().activeSurfaceId).toBe("diff");
    useRightPanelStore.setState({ byThreadKey: {} });
    useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {} });
    seed();
    useRightPanelStore.getState().close(refA);
    seed({ workstreamRoot: true });
    expect(panel()).toMatchObject({ isOpen: false, activeSurfaceId: "tasks" });
    expect(ids()).toEqual(["tasks", "workstream"]);
  });

  it("adds Goal tasks beside existing state without stealing focus; closed stays closed", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().close(refA);
    seed();
    expect(panel()).toEqual({
      isOpen: false,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff" },
        { id: "tasks", kind: "tasks" },
      ],
    });
    useRightPanelStore.getState().closeSurface(refA, "tasks");
    seed();
    expect(ids()).toEqual(["diff"]);
  });

  it("switches off: removes a Context tab as an automatic transition", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().open(refA, "context");
    const revision = useRightPanelStore.getState().getUserActionRevision(refA);
    seed({ goalThread: false, contextPanels: false });
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [{ id: "diff", kind: "diff" }],
    });
    expect(useRightPanelStore.getState().getUserActionRevision(refA)).toBe(revision);
  });

  it("switches off on a thread without the tab: no write", () => {
    useRightPanelStore.getState().open(refA, "diff");
    const panels = useRightPanelStore.getState().byThreadKey;
    seed({ goalThread: false, contextPanels: false });
    expect(useRightPanelStore.getState().byThreadKey).toBe(panels);
  });
});
