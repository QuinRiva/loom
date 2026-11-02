// Loom's right-panel surfaces (seam 18): the launcher / "+" menu entries for
// the Workstream graph and the Context tab, and their one-shot auto-open seed. Hoisted out of the
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
  /** The thread has Loom children: a workstream root (or sub-orchestrator). */
  readonly workstreamRoot: boolean;
  readonly autoOpenWorkstreamPanel: boolean;
  /** The active provider thread is pi's: only its session file has a context breakdown. */
  readonly piThread: boolean;
  /** `contextVizComposition || contextVizGrowth`: the Context tab follows these switches. */
  readonly contextPanels: boolean;
}

/**
 * The auto-open seed (docs/architecture/loom-ui-state-tiers.md): each tab once per thread, never over
 * a persisted choice; the durable flag keeps a closed tab closed. Both panel switches off removes
 * the Context tab and clears its flag, writing only on a thread that holds either.
 */
export function autoOpenLoomSurfaces(ref: ScopedThreadRef, eligibility: LoomSurfaceEligibility) {
  const opened = selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), ref);
  const workstream =
    eligibility.autoOpenWorkstreamPanel && eligibility.workstreamRoot && !opened.workstream;
  const context =
    eligibility.contextPanels && eligibility.piThread && !opened.context
      ? true
      : !eligibility.contextPanels &&
          (opened.context === true ||
            selectThreadRightPanelState(
              useRightPanelStore.getState().byThreadKey,
              ref,
            ).surfaces.some((surface) => surface.kind === "context"))
        ? false
        : undefined;
  if (!workstream && context === undefined) return;
  useRightPanelStore.getState().seedWorkstream(ref, {
    ...(workstream ? { workstream } : {}),
    ...(context === undefined ? {} : { context }),
  });
  if (workstream) useWorkstreamUiStore.getState().markAutoOpened(ref, "workstream");
  if (context !== undefined)
    useWorkstreamUiStore.getState().markAutoOpened(ref, "context", context);
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
  // switches off, whose removal path never reads `piThread`.
  const piThread = isPiThread(useQuietThreadProjection(contextPanels && shell ? threadRef : null));
  const workstreamThread = shell?.source.workstream !== undefined;
  const workstreamRoot = useHasLoomChildren(threadRef);
  // Seeding on the all-on defaults before stored settings load would add a tab a user switched off.
  const hydration = useClientSettingsHydrationStatus();
  const settingsKnown = hydration === "ready" || hydration === "failed";

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- auto-opens the workstream panel in the right-panel store, seeding without overriding the user's choice
  useEffect(() => {
    if (threadRef && settingsKnown)
      autoOpenLoomSurfaces(threadRef, {
        workstreamRoot,
        autoOpenWorkstreamPanel,
        piThread,
        contextPanels,
      });
  }, [threadRef, settingsKnown, workstreamRoot, autoOpenWorkstreamPanel, piThread, contextPanels]);

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
