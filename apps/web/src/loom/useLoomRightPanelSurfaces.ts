// Loom's right-panel surfaces (seam 18): the launcher / "+" menu entries for
// the Workstream board and Graph, and their one-shot auto-open seed. Hoisted
// out of the upstream-owned ChatView and RightPanelTabs so each carries one
// marked call/prop. 3d-3 adds the Goal tasks entry (shortcut G) and its
// eligibility here.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { GitBranch, type LucideIcon, Network } from "lucide-react";
import { useEffect, useMemo } from "react";

import { useClientSettings } from "../hooks/useSettings";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShell } from "../state/entities";
import { useHasLoomChildren } from "./loomChildren";
import type { SeedableSurfaceKind } from "./seedRightPanelSurfaces";
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
 * root seeds the Workstream board and Graph once, in one store transition,
 * never overriding a persisted choice; the durable per-thread flag makes a
 * closed tab stay closed across remounts and reloads.
 */
export function autoOpenLoomSurfaces(ref: ScopedThreadRef, eligibility: LoomSurfaceEligibility) {
  const flags = selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), ref);
  const eligible: SeedableSurfaceKind[] =
    eligibility.autoOpenWorkstreamPanel && eligibility.workstreamRoot
      ? (["workstream", "graph"] as const).filter((kind) => !flags[kind])
      : [];
  if (eligible.length === 0) return;
  useRightPanelStore.getState().seedSurfaces(ref, eligible);
  useWorkstreamUiStore.getState().markAutoOpened(ref, eligible);
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

  return useMemo(() => {
    const open = (kind: "workstream" | "graph") => () => {
      if (threadRef) useRightPanelStore.getState().open(threadRef, kind);
    };
    const available = threadRef !== null && workstreamThread;
    return [
      {
        label: "Workstream",
        icon: GitBranch,
        shortcut: "W",
        available,
        disabledReason: "Available on a workstream thread.",
        onClick: open("workstream"),
      },
      {
        label: "Graph",
        icon: Network,
        shortcut: "N",
        available,
        disabledReason: "Available on a workstream thread.",
        onClick: open("graph"),
      },
    ];
  }, [threadRef, workstreamThread]);
}
