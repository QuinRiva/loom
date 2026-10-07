// The auto-open seed (`autoOpenLoomSurfaces`, the body of the
// useLoomRightPanelSurfaces effect) against the REAL stores: durable flags and
// non-overriding seeds, end to end.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { autoOpenLoomSurfaces } from "./useLoomRightPanelSurfaces";
import { selectAutoOpenedSurfaces, useWorkstreamUiStore } from "./workstreamUiStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);
const seed = (workstreamRoot: boolean, autoOpenWorkstreamPanel = true) =>
  autoOpenLoomSurfaces(refA, { workstreamRoot, autoOpenWorkstreamPanel });

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {}, userActionRevisionByThreadKey: {} });
  useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {} });
});

describe("auto-open seed", () => {
  it("a workstream root with no panel state opens the Workstream tab", () => {
    seed(true);
    expect(panel()).toEqual({
      isOpen: true,
      activeSurfaceId: "workstream",
      surfaces: [{ id: "workstream", kind: "workstream" }],
    });
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({
      workstream: true,
    });
  });

  it("another surface active → tab added, active surface and visibility unchanged", () => {
    useRightPanelStore.getState().open(refA, "diff");
    seed(true);
    expect(panel().activeSurfaceId).toBe("diff");
    expect(panel().surfaces.map((surface) => surface.id)).toEqual(["diff", "workstream"]);
  });

  it("not a root, or the setting off → no store write", () => {
    seed(false);
    seed(true, false);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("eligibility arriving late (first child spawned) seeds then, exactly once", () => {
    seed(false);
    seed(true);
    const before = useRightPanelStore.getState().byThreadKey;
    seed(true);
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });

  it("closing the seeded tab and re-firing does not bring them back", () => {
    seed(true);
    useRightPanelStore.getState().closeAllSurfaces(refA);
    seed(true);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});
