// Loom-owned reducer for the one-shot auto-open seeds, spliced into upstream's `rightPanelStore` as
// `seedWorkstream`. It adds each requested surface, and opens and activates one (Workstream before
// Context) only on a first visit; existing panel state keeps `activeSurfaceId` and `isOpen` (seed,
// never override, per docs/architecture/loom-ui-state-tiers.md). Goal tasks is never seeded.
import type { RightPanelSurface, ThreadRightPanelState } from "../rightPanelStore";

const LOOM_SURFACES = {
  tasks: { id: "tasks", kind: "tasks" },
  workstream: { id: "workstream", kind: "workstream" },
  context: { id: "context", kind: "context" },
} as const satisfies Record<string, RightPanelSurface>;

/** The singleton surface descriptor for a Loom kind. */
export const loomSurface = (kind: keyof typeof LOOM_SURFACES): RightPanelSurface =>
  LOOM_SURFACES[kind];

/**
 * `true` seeds the surface; `context: false` takes away a Context tab its switches no longer allow,
 * mirroring `closeSurface` but as an automatic transition (no user-action revision, no reopen
 * history); an absent key leaves the surface alone.
 */
export interface LoomSurfaceSeed {
  readonly workstream?: true;
  readonly context?: boolean;
}

/** Apply the seed to the thread's right panel in a single transition. */
export function seedLoomSurfaces(
  current: ThreadRightPanelState,
  seed: LoomSurfaceSeed,
): ThreadRightPanelState {
  const index = current.surfaces.findIndex((surface) => surface.id === "context");
  const kept = current.surfaces.filter(
    (surface) => seed.context !== false || surface.id !== "context",
  );
  const base: ThreadRightPanelState =
    kept.length === current.surfaces.length
      ? current
      : {
          ...current,
          isOpen: kept.length > 0 && current.isOpen,
          surfaces: kept,
          activeSurfaceId:
            current.activeSurfaceId === "context"
              ? (kept[Math.min(index, kept.length - 1)]?.id ?? null)
              : current.activeSurfaceId,
        };
  const added = (["workstream", "context"] as const).filter(
    (kind) => seed[kind] === true && !kept.some((surface) => surface.id === kind),
  );
  if (added.length === 0) return base;
  const surfaces = [...kept, ...added.map((kind) => LOOM_SURFACES[kind])];
  return current.isOpen || current.activeSurfaceId !== null || current.surfaces.length > 0
    ? { ...base, surfaces }
    : { ...base, isOpen: true, surfaces, activeSurfaceId: added[0]! };
}
