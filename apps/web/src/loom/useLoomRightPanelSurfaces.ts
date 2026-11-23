// Loom's right-panel surfaces (seam 18): the launcher / "+" menu entries for
// the Workstream graph and the Context tab, and the one-shot auto-open seed. Hoisted out of the
// upstream-owned ChatView and RightPanelTabs so each carries one marked
// call/prop. Goal tasks (shortcut G) is RightPanelTabs' `onAddTasks` entry.
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Layers, type LucideIcon, Network } from "lucide-react";
import { useEffect } from "react";

import { useClientSettings, useClientSettingsHydrationStatus } from "../hooks/useSettings";
import { selectThreadRightPanelState, useRightPanelStore } from "../rightPanelStore";
import { useQuietThreadProjection, useThreadShell } from "../state/entities";
import { isPiThread } from "./context-viz/contextUsageStore";
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
  /** The thread belongs to a Loom goal: Goal tasks is its first tab. */
  readonly goalThread: boolean;
  /** The thread has Loom children: a workstream root (or sub-orchestrator). */
  readonly workstreamRoot: boolean;
  readonly autoOpenWorkstreamPanel: boolean;
  /** `contextVizComposition || contextVizGrowth`: the Context tab follows these switches. */
  readonly contextPanels: boolean;
}

/**
 * The auto-open seed (docs/architecture/loom-ui-state-tiers.md): Goal tasks and Workstream once per
 * thread, never over a persisted choice; the durable flag keeps a closed tab closed. Context is
 * never seeded, but both its switches off takes away a Context tab the thread holds.
 */
export function autoOpenLoomSurfaces(ref: ScopedThreadRef, eligibility: LoomSurfaceEligibility) {
  const opened = selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), ref);
  const tasks = eligibility.goalThread && !opened.tasks;
  const workstream =
    eligibility.autoOpenWorkstreamPanel && eligibility.workstreamRoot && !opened.workstream;
  const context =
    !eligibility.contextPanels &&
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, ref).surfaces.some(
      (surface) => surface.kind === "context",
    );
  if (!tasks && !workstream && !context) return;
  useRightPanelStore.getState().seedWorkstream(ref, {
    ...(tasks ? { tasks } : {}),
    ...(workstream ? { workstream } : {}),
    ...(context ? { context: false } : {}),
  });
  if (tasks) useWorkstreamUiStore.getState().markAutoOpened(ref, "tasks");
  if (workstream) useWorkstreamUiStore.getState().markAutoOpened(ref, "workstream");
}

export function useLoomRightPanelSurfaces(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<LoomSurfaceAction> {
  const autoOpenWorkstreamPanel = useClientSettings((settings) => settings.autoOpenWorkstreamPanel);
  const contextPanels = useClientSettings(
    (settings) => settings.contextVizComposition || settings.contextVizGrowth,
  );
  const shell = useThreadShell(threadRef);
  // A draft has no shell, so no detail subscription for a thread the server lacks; nor with the
  // switches off, when the Context entry is unavailable anyway.
  const piThread = isPiThread(useQuietThreadProjection(contextPanels && shell ? threadRef : null));
  const workstreamThread = shell?.source.workstream !== undefined;
  const goalThread = Boolean(shell?.source.workstream?.goalId);
  const workstreamRoot = useHasLoomChildren(threadRef);
  // Seeding on the all-on defaults before stored settings load would add a tab a user switched off.
  const hydration = useClientSettingsHydrationStatus();
  const settingsKnown = hydration === "ready" || hydration === "failed";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- auto-opens the Goal tasks and Workstream tabs in the right-panel store, seeding without overriding the user's choice
  useEffect(() => {
    if (threadRef && settingsKnown)
      autoOpenLoomSurfaces(threadRef, {
        goalThread,
        workstreamRoot,
        autoOpenWorkstreamPanel,
        contextPanels,
      });
  }, [
    threadRef,
    settingsKnown,
    goalThread,
    workstreamRoot,
    autoOpenWorkstreamPanel,
    contextPanels,
  ]);

  return [
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
    {
      label: "Context",
      icon: Layers,
      shortcut: "C",
      available: threadRef !== null && piThread && contextPanels,
      disabledReason: "Available on a pi thread while Composition or Growth is on in Settings.",
      onClick: () => {
        if (threadRef) useRightPanelStore.getState().open(threadRef, "context");
      },
    },
  ];
}
