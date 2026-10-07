// Loom's right-panel surfaces (seam 18): the launcher / "+" menu entry for
// the Workstream graph, and its one-shot auto-open seed. Hoisted out of the
// upstream-owned ChatView and RightPanelTabs so each carries one marked
// call/prop. Goal tasks (shortcut G) is RightPanelTabs' `onAddTasks` entry.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { type LucideIcon, Network } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShell } from "../state/entities";
import { useHasLoomChildren } from "./loomChildren";
import { selectAutoOpenedSurfaces, useWorkstreamUiStore } from "./workstreamUiStore";

/** One launcher / "+" menu entry, the shape RightPanelTabs renders. */
export interface LoomSurfaceAction {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut: string;
  readonly available: boolean;
  readonly disabledReason: string;
  readonly onClick: () => void;
}

export interface LoomSurfaceEligibility {
  /** The thread has Loom children: a workstream root (or sub-orchestrator). */
  readonly workstreamRoot: boolean;
  readonly autoOpenWorkstreamPanel: boolean;
}

/**
 * The auto-open seed (docs/architecture/loom-ui-state-tiers.md): a workstream
 * root seeds the Workstream tab once, never overriding a persisted choice; the
 * durable per-thread flag makes a closed tab stay closed across remounts and
 * reloads.
 */
export function autoOpenLoomSurfaces(ref: ScopedThreadRef, eligibility: LoomSurfaceEligibility) {
  if (!eligibility.autoOpenWorkstreamPanel || !eligibility.workstreamRoot) return;
  if (selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), ref).workstream) return;
  useRightPanelStore.getState().seedWorkstream(ref);
  useWorkstreamUiStore.getState().markAutoOpened(ref);
}

export function useLoomRightPanelSurfaces(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<LoomSurfaceAction> {
  const autoOpenWorkstreamPanel = useClientSettings((settings) => settings.autoOpenWorkstreamPanel);
  const workstreamThread = useThreadShell(threadRef)?.source.workstream !== undefined;
  const workstreamRoot = useHasLoomChildren(threadRef);

  useEffect(() => {
    if (threadRef) autoOpenLoomSurfaces(threadRef, { workstreamRoot, autoOpenWorkstreamPanel });
  }, [threadRef, workstreamRoot, autoOpenWorkstreamPanel]);

  return useMemo(
    () => [
      {
        label: "Workstream",
        icon: Network,
        shortcut: "W",
        available: threadRef !== null && workstreamThread,
        disabledReason: "Available on a workstream thread.",
        onClick: () => {
          if (threadRef) useRightPanelStore.getState().open(threadRef, "workstream");
        },
      },
    ],
    [threadRef, workstreamThread],
  );
}
