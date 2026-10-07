// Loom-owned reducer for the durable one-shot auto-open seed, spliced into the
// upstream-owned `rightPanelStore` as its `seedWorkstream` action (seam 18).
//
// One functional transition adds the Workstream surface and, only on a first
// visit (no panel state yet), opens and activates it. It never overrides an
// existing user choice: when panel state already exists the tab is added
// without touching `activeSurfaceId` or `isOpen`
// (docs/architecture/loom-ui-state-tiers.md, seed-not-override). Goal tasks is
// never seeded: the panel reopens as the user left it (G3).
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
