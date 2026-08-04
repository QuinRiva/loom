import { useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { buildThreadLineage, EMPTY_LINEAGE, type LineageSegment } from "../threadRouteLineage";
import { buildThreadRouteParams } from "../threadRoutes";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShells } from "../state/entities";
import type { Thread } from "../types";
import type { SeedableSurfaceKind } from "./seedRightPanelSurfaces";
import { selectAutoOpenedSurfaces, useWorkstreamUiStore } from "./workstreamUiStore";

export interface LoomThreadExtensions {
  readonly threadLineage: ReadonlyArray<LineageSegment>;
  readonly navigateToThread: (targetThreadId: ThreadId) => void;
  readonly addTasksSurface: () => void;
  readonly toggleTasksSurface: () => void;
  readonly addWorkstreamSurface: () => void;
}

/**
 * Fork-owned chat extensions hoisted out of `ChatView`: thread-lineage
 * derivation + navigation, the Tasks/Workstream right-panel surface openers,
 * and the goal-bound tasks auto-open effect. All are Loom additions with no
 * upstream counterpart, so they live here rather than inflating the
 * upstream-owned ChatView.
 */
export function useLoomThreadExtensions(inputs: {
  activeThread: Thread | undefined;
  activeThreadRef: ScopedThreadRef | null;
  activeThreadKey: string | null;
  autoOpenGoalTasksPanel: boolean;
  autoOpenWorkstreamPanel: boolean;
}): LoomThreadExtensions {
  const {
    activeThread,
    activeThreadRef,
    activeThreadKey,
    autoOpenGoalTasksPanel,
    autoOpenWorkstreamPanel,
  } = inputs;
  const navigate = useNavigate();

  const allThreadShells = useThreadShells();
  const threadShellById = useMemo(() => {
    const map: Record<ThreadId, (typeof allThreadShells)[number]> = {};
    if (activeThread) {
      for (const shell of allThreadShells) {
        if (shell.environmentId === activeThread.environmentId) map[shell.id] = shell;
      }
    }
    return map;
  }, [allThreadShells, activeThread]);
  const threadLineage = useMemo(
    () =>
      activeThread?.parentThreadId != null
        ? buildThreadLineage(threadShellById, activeThread.id)
        : EMPTY_LINEAGE,
    [activeThread?.parentThreadId, activeThread?.id, threadShellById],
  );
  const navigateToThread = useCallback(
    (targetThreadId: ThreadId) => {
      if (!activeThread) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(activeThread.environmentId, targetThreadId)),
      });
    },
    [activeThread, navigate],
  );

  const addTasksSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "tasks");
  }, [activeThreadRef]);
  // The goal chip's one dispatch: open the Goal panel, or collapse the panel
  // when it is already the active surface.
  const toggleTasksSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().toggle(activeThreadRef, "tasks");
  }, [activeThreadRef]);
  const addWorkstreamSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "workstream");
  }, [activeThreadRef]);

  // A thread "participates in a workstream" when it is a sub-thread
  // (`parentThreadId != null`) or has spawned at least one child in the shell
  // list. Deliberately NOT "is a server thread", which would seed an empty
  // Workstream panel on every ordinary thread. Eligibility can flip true
  // mid-session (first child spawned); the effect below simply fires then and
  // the one-shot flag keeps it single.
  const isWorkstreamParticipant =
    activeThread != null &&
    (activeThread.parentThreadId != null ||
      allThreadShells.some(
        (shell) =>
          shell.environmentId === activeThread.environmentId &&
          shell.parentThreadId === activeThread.id,
      ));

  // Durable one-shot auto-open (plan W1). The "already fired" record is a
  // persisted per-thread flag (loom workstreamUiStore) whose lifetime matches
  // the choice it guards — remounts from route changes can no longer resurrect
  // an auto-open over a surface the user has since selected or closed. Both
  // eligible surfaces are seeded in ONE store transition (never per-surface),
  // so which surface ends up active does not depend on effect ordering; `tasks`
  // wins activation over `workstream` when both are seeded on a first visit.
  useEffect(() => {
    if (!activeThreadRef || !activeThread) return;
    const flags = selectAutoOpenedSurfaces(useWorkstreamUiStore.getState(), activeThreadRef);
    const eligible: SeedableSurfaceKind[] = [];
    if (autoOpenGoalTasksPanel && activeThread.goalId != null && !flags.tasks) {
      eligible.push("tasks");
    }
    if (autoOpenWorkstreamPanel && isWorkstreamParticipant && !flags.workstream) {
      eligible.push("workstream");
    }
    if (eligible.length === 0) return;
    useRightPanelStore.getState().seedSurfaces(activeThreadRef, eligible, "tasks");
    useWorkstreamUiStore.getState().markAutoOpened(activeThreadRef, eligible);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeThreadRef is reset transitively
  }, [
    activeThreadKey,
    activeThread?.goalId,
    isWorkstreamParticipant,
    autoOpenGoalTasksPanel,
    autoOpenWorkstreamPanel,
  ]);

  return {
    threadLineage,
    navigateToThread,
    addTasksSurface,
    toggleTasksSurface,
    addWorkstreamSurface,
  };
}
