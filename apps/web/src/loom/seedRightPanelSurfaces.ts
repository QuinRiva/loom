// Loom-owned reducer for the one-shot Workstream auto-open seed, spliced into upstream's
// `rightPanelStore` as `seedWorkstream`. It adds the surface, and opens and activates it only on a
// first visit; existing panel state keeps `activeSurfaceId` and `isOpen` (seed, never override, per
// docs/architecture/loom-ui-state-tiers.md). Goal tasks is never seeded.
import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";

const LOOM_SURFACES = {
  tasks: { id: "tasks", kind: "tasks" },
  workstream: { id: "workstream", kind: "workstream" },
} as const satisfies Record<string, RightPanelSurface>;

/** The singleton surface descriptor for a Loom kind. */
export const loomSurface = (kind: keyof typeof LOOM_SURFACES): RightPanelSurface =>
  LOOM_SURFACES[kind];

/** Add the Workstream tab to the thread's right panel in a single transition. */
export function seedWorkstreamSurface(current: ThreadRightPanelState): ThreadRightPanelState {
  if (current.surfaces.some((surface) => surface.id === "workstream")) return current;
  const surfaces = [...current.surfaces, LOOM_SURFACES.workstream];
  return current.isOpen || current.activeSurfaceId !== null || current.surfaces.length > 0
    ? { ...current, surfaces }
    : { ...current, isOpen: true, surfaces, activeSurfaceId: "workstream" };
}
