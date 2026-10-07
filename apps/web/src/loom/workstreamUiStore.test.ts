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
  it("marks per thread; removeThread drops only that thread's flag", () => {
    useWorkstreamUiStore.getState().markAutoOpened(refA);
    useWorkstreamUiStore.getState().markAutoOpened(refB);
    useWorkstreamUiStore.getState().removeThread(refA);
    expect(flags(refA)).toEqual({});
    expect(flags(refB)).toEqual({ workstream: true });
  });
});
