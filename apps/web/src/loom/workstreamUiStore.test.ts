import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectAutoOpenedSurfaces, useWorkstreamUiStore } from "./workstreamUiStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));
const flags = (ref: typeof refA) => selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), ref);

beforeEach(() => {
  useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {}, graphViewByKey: {} });
});

describe("workstreamUiStore auto-open flags", () => {
  it("marks surfaces per thread, merging repeated calls", () => {
    expect(flags(refA)).toEqual({});
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["workstream"]);
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["graph"]);
    expect(flags(refA)).toEqual({ workstream: true, graph: true });
    expect(flags(refB)).toEqual({});
  });

  it("marking with no kinds is a no-op", () => {
    const before = useWorkstreamUiStore.getState();
    useWorkstreamUiStore.getState().markAutoOpened(refA, []);
    expect(useWorkstreamUiStore.getState()).toBe(before);
  });

  it("removeThread drops only that thread's flags", () => {
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["workstream"]);
    useWorkstreamUiStore.getState().markAutoOpened(refB, ["graph"]);
    useWorkstreamUiStore.getState().removeThread(refA);
    expect(flags(refA)).toEqual({});
    expect(flags(refB)).toEqual({ graph: true });
  });
});
