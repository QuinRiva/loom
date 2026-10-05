import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_WORKSTREAM_PANEL_STATE,
  selectAutoOpenedSurfaces,
  selectWorkstreamPanelState,
  useWorkstreamUiStore,
} from "./workstreamUiStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));
const refB = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-B"));

beforeEach(() => {
  useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {}, panelByThreadKey: {} });
});

describe("workstreamUiStore auto-open flags (W1)", () => {
  it("defaults to no flags for an unseen thread", () => {
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({});
  });

  it("marks surfaces auto-opened per thread, merging repeated calls", () => {
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["tasks"]);
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({
      tasks: true,
    });

    useWorkstreamUiStore.getState().markAutoOpened(refA, ["workstream"]);
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({
      tasks: true,
      workstream: true,
    });

    // Other threads are unaffected.
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refB)).toEqual({});
  });

  it("marking with no kinds is a no-op", () => {
    const before = useWorkstreamUiStore.getState();
    useWorkstreamUiStore.getState().markAutoOpened(refA, []);
    expect(useWorkstreamUiStore.getState()).toBe(before);
  });
});

describe("workstreamUiStore panel state (W2)", () => {
  it("defaults to graph view and an empty spawn draft", () => {
    expect(
      selectWorkstreamPanelState(useWorkstreamUiStore.getState().panelByThreadKey, refA),
    ).toEqual(DEFAULT_WORKSTREAM_PANEL_STATE);
  });

  it("persists view and spawn-draft edits", () => {
    useWorkstreamUiStore.getState().setView(refA, "board");
    useWorkstreamUiStore.getState().updateSpawnDraft(refA, { role: "reviewer" });
    useWorkstreamUiStore.getState().updateSpawnDraft(refA, { title: "Check W2" });

    expect(
      selectWorkstreamPanelState(useWorkstreamUiStore.getState().panelByThreadKey, refA),
    ).toEqual({
      view: "board",
      spawnDraft: { role: "reviewer", title: "Check W2", purpose: "" },
    });
  });

  it("persists only the durable per-thread slices", () => {
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["tasks"]);
    useWorkstreamUiStore.getState().setView(refA, "board");
    const partialize = useWorkstreamUiStore.persist.getOptions().partialize;

    expect(partialize?.(useWorkstreamUiStore.getState())).toEqual({
      autoOpenedByThreadKey: useWorkstreamUiStore.getState().autoOpenedByThreadKey,
      panelByThreadKey: useWorkstreamUiStore.getState().panelByThreadKey,
    });
  });

  it("resets pre-v1 persisted state during migration", () => {
    const migrate = useWorkstreamUiStore.persist.getOptions().migrate;

    expect(migrate?.({ legacy: true }, 0)).toEqual({
      autoOpenedByThreadKey: {},
      panelByThreadKey: {},
    });
  });

  it("clears the spawn draft on successful spawn while keeping the view", () => {
    useWorkstreamUiStore.getState().setView(refA, "board");
    useWorkstreamUiStore.getState().updateSpawnDraft(refA, { purpose: "half typed" });
    useWorkstreamUiStore.getState().clearSpawnDraft(refA);

    expect(
      selectWorkstreamPanelState(useWorkstreamUiStore.getState().panelByThreadKey, refA),
    ).toEqual({
      view: "board",
      spawnDraft: { role: "", title: "", purpose: "" },
    });
  });

  it("removeThread clears both slices for the thread and leaves siblings intact", () => {
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["tasks"]);
    useWorkstreamUiStore.getState().updateSpawnDraft(refA, { role: "reviewer" });
    useWorkstreamUiStore.getState().markAutoOpened(refB, ["workstream"]);

    useWorkstreamUiStore.getState().removeThread(refA);

    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({});
    expect(
      selectWorkstreamPanelState(useWorkstreamUiStore.getState().panelByThreadKey, refA),
    ).toEqual(DEFAULT_WORKSTREAM_PANEL_STATE);
    // Sibling untouched.
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refB)).toEqual({
      workstream: true,
    });
  });

  it("removeThread on an unknown thread is a no-op", () => {
    const before = useWorkstreamUiStore.getState();
    useWorkstreamUiStore.getState().removeThread(refA);
    expect(useWorkstreamUiStore.getState()).toBe(before);
  });
});
