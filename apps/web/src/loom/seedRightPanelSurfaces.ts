// Loom-owned reducer for the durable one-shot auto-open seed, spliced into the
// upstream-owned `rightPanelStore` as its `seedSurfaces` action (seam 18).
//
// One functional transition adds every eligible surface and, only on a first
// visit (no panel state yet), activates exactly one of them by an explicit
// priority. It never overrides an existing user choice: when panel state
// already exists the surfaces are added without touching `activeSurfaceId` or
// `isOpen` (docs/architecture/loom-ui-state-tiers.md, seed-not-override).
import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";

/** Seedable surface kinds, highest activation priority first. */
export const SEEDABLE_SURFACE_KINDS = ["tasks", "workstream", "graph"] as const;
export type SeedableSurfaceKind = (typeof SEEDABLE_SURFACE_KINDS)[number];

const LOOM_SURFACES = {
  tasks: { id: "tasks", kind: "tasks" },
  workstream: { id: "workstream", kind: "workstream" },
  graph: { id: "graph", kind: "graph" },
} as const satisfies Record<SeedableSurfaceKind, RightPanelSurface>;

/** The singleton surface descriptor for a Loom kind. */
export const loomSurface = (kind: SeedableSurfaceKind): RightPanelSurface => LOOM_SURFACES[kind];

/**
 * Add `kinds` to the thread's right panel in a single transition.
 *
 * - First visit (no panel state): open, add all, activate the highest-priority
 *   seeded kind.
 * - Panel state already exists: add any missing kinds as tabs, leaving the
 *   active surface and visibility untouched.
 */
export function seedRightPanelSurfaces(
  current: ThreadRightPanelState,
  kinds: readonly SeedableSurfaceKind[],
): ThreadRightPanelState {
  if (kinds.length === 0) return current;
  const missing = kinds.filter((kind) => !current.surfaces.some((surface) => surface.id === kind));
  const surfaces =
    missing.length === 0 ? current.surfaces : [...current.surfaces, ...missing.map(loomSurface)];
  if (current.isOpen || current.activeSurfaceId !== null || current.surfaces.length > 0) {
    return surfaces === current.surfaces ? current : { ...current, surfaces };
  }
  const activation = SEEDABLE_SURFACE_KINDS.find((kind) => kinds.includes(kind))!;
  return { ...current, isOpen: true, surfaces, activeSurfaceId: activation };
}
