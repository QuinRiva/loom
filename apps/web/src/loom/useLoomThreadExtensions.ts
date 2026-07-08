import { useCallback, useEffect, useMemo, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { buildThreadLineage, EMPTY_LINEAGE, type LineageSegment } from "../threadRouteLineage";
import { buildThreadRouteParams } from "../threadRoutes";
import { useRightPanelStore } from "../rightPanelStore";
import { useThreadShells } from "../state/entities";
import type { Thread } from "../types";

export interface LoomThreadExtensions {
  readonly threadLineage: ReadonlyArray<LineageSegment>;
  readonly navigateToThread: (targetThreadId: ThreadId) => void;
  readonly addTasksSurface: () => void;
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
}): LoomThreadExtensions {
  const { activeThread, activeThreadRef, activeThreadKey } = inputs;
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
  const addWorkstreamSurface = useCallback(() => {
    if (!activeThreadRef) return;
    useRightPanelStore.getState().open(activeThreadRef, "workstream");
  }, [activeThreadRef]);

  // When the active thread is bound to a goal, surface its goal-task tree once
  // by auto-opening the "tasks" right-panel surface (mirrors the plan-sidebar
  // auto-open). We track which scoped thread keys we've already auto-opened in a
  // ref so switching away and back doesn't re-fire the open and clobber a
  // surface the user has since selected (e.g. Workstream); the user can still
  // freely change or close the surface within the session. This coexists with
  // the plan-sidebar auto-open — both add a right-panel tab rather than fight
  // for an exclusive slot.
  const autoOpenedTasksByThreadKey = useRef(new Set<string>());
  useEffect(() => {
    if (!activeThreadRef || !activeThreadKey) return;
    if (!activeThread?.goalId) return;
    if (autoOpenedTasksByThreadKey.current.has(activeThreadKey)) return;
    autoOpenedTasksByThreadKey.current.add(activeThreadKey);
    useRightPanelStore.getState().open(activeThreadRef, "tasks");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeThreadRef is reset transitively
  }, [activeThreadKey, activeThread?.goalId]);

  return { threadLineage, navigateToThread, addTasksSurface, addWorkstreamSurface };
}
