import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const panel = () => selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA);

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
});

describe("rightPanelStore.seedWorkstream", () => {
  it("adds a tab without stealing focus or visibility when panel state exists", () => {
    useRightPanelStore.getState().open(refA, "diff");
    useRightPanelStore.getState().close(refA);
    useRightPanelStore.getState().seedWorkstream(refA);
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
    useRightPanelStore.getState().seedWorkstream(refA);
    const before = useRightPanelStore.getState().byThreadKey;
    useRightPanelStore.getState().seedWorkstream(refA);
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });

  it("does not count as a user choice", () => {
    const revision = useRightPanelStore.getState().getUserActionRevision(refA);
    useRightPanelStore.getState().seedWorkstream(refA);
    expect(useRightPanelStore.getState().getUserActionRevision(refA)).toBe(revision);
  });
});
