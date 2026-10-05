// Integration coverage for the plan-W1 auto-open effect (useLoomThreadExtensions).
//
// The effect itself is a tiny React hook body with no test-renderer infra in
// this app, so `runSeedEffect` below is a faithful transcription of that body
// (compute eligible unflagged surfaces → one seed transition → set flags). It
// exercises the REAL stores, so the durable-flag / non-overriding-seed
// guarantees are verified end-to-end even though the React glue is not mounted.
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import type { SeedableSurfaceKind } from "./seedRightPanelSurfaces";
import { selectAutoOpenedSurfaces, useWorkstreamUiStore } from "./workstreamUiStore";

const refA = scopeThreadRef("env-1" as EnvironmentId, ThreadId.make("thread-A"));

function runSeedEffect(input: {
  goalBound: boolean;
  workstreamParticipant: boolean;
  autoOpenGoalTasksPanel?: boolean;
  autoOpenWorkstreamPanel?: boolean;
}) {
  const {
    goalBound,
    workstreamParticipant,
    autoOpenGoalTasksPanel = true,
    autoOpenWorkstreamPanel = true,
  } = input;
  const flags = selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA);
  const eligible: SeedableSurfaceKind[] = [];
  if (autoOpenGoalTasksPanel && goalBound && !flags.tasks) eligible.push("tasks");
  if (autoOpenWorkstreamPanel && workstreamParticipant && !flags.workstream) {
    eligible.push("workstream");
  }
  if (eligible.length === 0) return;
  useRightPanelStore.getState().seedSurfaces(refA, eligible, "tasks");
  useWorkstreamUiStore.getState().markAutoOpened(refA, eligible);
}

beforeEach(() => {
  useRightPanelStore.setState({ byThreadKey: {} });
  useWorkstreamUiStore.setState({ autoOpenedByThreadKey: {}, panelByThreadKey: {} });
});

describe("auto-open seed effect (W1)", () => {
  it("flag unset + no panel state → full open + flag set", () => {
    runSeedEffect({ goalBound: true, workstreamParticipant: false });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "tasks",
      surfaces: [{ id: "tasks", kind: "tasks" }],
    });
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({
      tasks: true,
    });
  });

  it("flag unset + another surface active → tab added, active + isOpen unchanged, flag set", () => {
    useRightPanelStore.getState().open(refA, "diff");
    runSeedEffect({ goalBound: true, workstreamParticipant: false });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "diff",
      surfaces: [
        { id: "diff", kind: "diff" },
        { id: "tasks", kind: "tasks" },
      ],
    });
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({
      tasks: true,
    });
  });

  it("flag set → no store write at all", () => {
    useWorkstreamUiStore.getState().markAutoOpened(refA, ["tasks"]);
    const rightPanelBefore = useRightPanelStore.getState().byThreadKey;
    runSeedEffect({ goalBound: true, workstreamParticipant: false });
    expect(useRightPanelStore.getState().byThreadKey).toBe(rightPanelBefore);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });

  it("both eligible + no panel state → both tabs in one transition, tasks active", () => {
    runSeedEffect({ goalBound: true, workstreamParticipant: true });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "tasks",
      surfaces: [
        { id: "tasks", kind: "tasks" },
        { id: "workstream", kind: "workstream" },
      ],
    });
    expect(selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), refA)).toEqual({
      tasks: true,
      workstream: true,
    });
  });

  it("workstream eligibility arriving late seeds then, exactly once", () => {
    // First visit: not yet a participant → only tasks seeds.
    runSeedEffect({ goalBound: true, workstreamParticipant: false });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces.map(
        (surface) => surface.id,
      ),
    ).toEqual(["tasks"]);

    // First child appears mid-session → workstream now eligible, seeds once.
    runSeedEffect({ goalBound: true, workstreamParticipant: true });
    expect(selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA)).toEqual({
      isOpen: true,
      activeSurfaceId: "tasks",
      surfaces: [
        { id: "tasks", kind: "tasks" },
        { id: "workstream", kind: "workstream" },
      ],
    });

    // A later re-fire does not reseed.
    const before = useRightPanelStore.getState().byThreadKey;
    runSeedEffect({ goalBound: true, workstreamParticipant: true });
    expect(useRightPanelStore.getState().byThreadKey).toBe(before);
  });

  it("regression: closing the seeded tab and re-firing does not bring it back", () => {
    runSeedEffect({ goalBound: true, workstreamParticipant: false });
    useRightPanelStore.getState().closeSurface(refA, "tasks");
    // Remount re-fires the effect: flag is durable, so nothing reopens.
    runSeedEffect({ goalBound: true, workstreamParticipant: false });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, refA).surfaces,
    ).toEqual([]);
  });

  it("regression: closeAllSurfaces (key pruned) then reload does not reopen", () => {
    runSeedEffect({ goalBound: true, workstreamParticipant: true });
    useRightPanelStore.getState().closeAllSurfaces(refA);
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
    // Reload / remount re-fires: durable flags suppress reseeding.
    runSeedEffect({ goalBound: true, workstreamParticipant: true });
    expect(useRightPanelStore.getState().byThreadKey).toEqual({});
  });
});
