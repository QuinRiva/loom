// Loom-owned reducer for the one-shot auto-open seeds, spliced into upstream's `rightPanelStore` as
// `seedWorkstream`. It adds each requested surface, and opens and activates one (Workstream before
// Goal tasks) only on a first visit; existing panel state keeps `activeSurfaceId` and `isOpen` (seed,
// never override, per docs/architecture/loom-ui-state-tiers.md), bar the Workstream takeover below.
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
  readonly tasks?: true;
  readonly workstream?: true;
  readonly context?: false;
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
  const added = (["tasks", "workstream"] as const).filter(
    (kind) => seed[kind] === true && !kept.some((surface) => surface.id === kind),
  );
  if (added.length === 0) return base;
  const surfaces = [...kept, ...added.map((kind) => LOOM_SURFACES[kind])];
  const workstream = added.includes("workstream");
  if (!current.isOpen && current.activeSurfaceId === null && current.surfaces.length === 0)
    return {
      ...base,
      isOpen: true,
      surfaces,
      activeSurfaceId: workstream ? "workstream" : "tasks",
    };
  // The one focus change on existing state: Workstream's first seed takes over from Goal tasks
  // while that tab is still in front of an open panel; any other choice keeps its place.
  return workstream && current.isOpen && current.activeSurfaceId === "tasks"
    ? { ...base, surfaces, activeSurfaceId: "workstream" }
    : { ...base, surfaces };
}
