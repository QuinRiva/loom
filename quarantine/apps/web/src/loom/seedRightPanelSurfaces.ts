// Loom-owned reducer for the durable one-shot auto-open seed (plan W1).
//
// Spliced into the upstream-owned `rightPanelStore` as the `seedSurfaces`
// action so the upstream-file touch stays splice-sized. This is the pure core:
// one functional transition that adds the eligible surfaces and, only on a
// first visit (no panel state yet), activates exactly one of them. It never
// overrides an existing user choice — when panel state already exists the
// surfaces are added without touching `activeSurfaceId` or `isOpen`.
//
// The single-transition rule matters: seeding surfaces one at a time would let
// the first seed create panel state and demote the rest to non-activating adds,
// making the active surface depend on effect ordering — the exact bug this plan
// removes.
import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";

export type SeedableSurfaceKind = "tasks" | "workstream";

const seedSurface = (kind: SeedableSurfaceKind): RightPanelSurface =>
  kind === "tasks" ? { id: "tasks", kind: "tasks" } : { id: "workstream", kind: "workstream" };

/**
 * Add `kinds` to the thread's right panel in a single transition.
 *
 * - First visit (no panel state): open + add all + activate `preferredActivation`
 *   (or the first kind, when the preferred one is not being seeded).
 * - Panel state already exists: add any missing kinds as tabs, leaving the
 *   active surface and visibility untouched (a non-overriding seed).
 */
export function seedRightPanelSurfaces(
  current: ThreadRightPanelState,
  kinds: readonly SeedableSurfaceKind[],
  preferredActivation: SeedableSurfaceKind,
): ThreadRightPanelState {
  if (kinds.length === 0) return current;
  const hasPanelState =
    current.isOpen || current.activeSurfaceId !== null || current.surfaces.length > 0;

  const missing = kinds.filter((kind) => !current.surfaces.some((surface) => surface.id === kind));
  const surfaces =
    missing.length === 0 ? current.surfaces : [...current.surfaces, ...missing.map(seedSurface)];

  if (hasPanelState) {
    return surfaces === current.surfaces ? current : { ...current, surfaces };
  }

  const activation = kinds.includes(preferredActivation) ? preferredActivation : kinds[0]!;
  return { isOpen: true, surfaces, activeSurfaceId: activation };
}
