/**
 * loom: task→thread chips for the Goal panel's task tree.
 *
 * A sub-thread may be anchored to one task of its goal (`anchorTaskId`, see
 * plans/task-tree-branch-scoping/plan.mdx §5). This is where that binding pays
 * the human back: the task row names the thread working it and opens it on
 * click — task→thread navigation the panel has never had.
 *
 * Derived entirely from the thread shells already in the client store: no new
 * websocket payload and no server query. Archived threads are dropped (matching
 * `GoalThreadsSection`, where archive is the app's remove-from-lists
 * affordance); a cancelled thread stays, dimmed, because "the thread that owned
 * this task was cancelled" is exactly what a human reading a stalled task row
 * needs to see.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ClipboardCheckIcon,
  CodeIcon,
  MapIcon,
  NetworkIcon,
  ScanEyeIcon,
  SearchIcon,
  ShipIcon,
} from "lucide-react";
import { useMemo } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import { getRoleLabel } from "../lib/workstreamPresentation";
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import type { SidebarThreadSummary } from "../types";

/** The repo's `roles/` vocabulary; anything else falls back to the generic glyph. */
const ROLE_ICONS: Record<string, typeof BotIcon> = {
  assessor: ClipboardCheckIcon,
  coder: CodeIcon,
  orchestrator: NetworkIcon,
  planner: MapIcon,
  researcher: SearchIcon,
  reviewer: ScanEyeIcon,
  shipper: ShipIcon,
};

export type AnchoredThreadsByTask = ReadonlyMap<string, ReadonlyArray<SidebarThreadSummary>>;

/**
 * Goal tasks → the threads anchored to them, oldest first so a fork sits after
 * the thread it was cut from (two threads legitimately share one anchor).
 */
export function useAnchoredThreadsByTask(
  goalId: string,
  environmentId: EnvironmentId,
): AnchoredThreadsByTask {
  const shells = useThreadShells();
  return useMemo(() => {
    const byTask = new Map<string, SidebarThreadSummary[]>();
    for (const thread of shells) {
      if (thread.environmentId !== environmentId || thread.goalId !== goalId) continue;
      if (thread.anchorTaskId === null || thread.archivedAt !== null) continue;
      byTask.set(thread.anchorTaskId, [...(byTask.get(thread.anchorTaskId) ?? []), thread]);
    }
    for (const threads of byTask.values())
      threads.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return byTask;
  }, [shells, environmentId, goalId]);
}

export function TaskThreadChip({ thread }: { thread: SidebarThreadSummary }) {
  const navigate = useNavigate();
  const role = getRoleLabel(thread);
  const Icon = ROLE_ICONS[role.toLowerCase()] ?? BotIcon;
  const cancelled = thread.planLane === "cancelled";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() =>
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
              })
            }
            className={cn(
              "ml-1.5 inline-flex max-w-[11rem] translate-y-px items-center gap-1 rounded-full border border-border/60 px-1.5 align-middle text-[10px] text-muted-foreground no-underline hover:bg-accent hover:text-foreground",
              // Cancelled is not archived: dimmed, never hidden.
              cancelled && "opacity-60 hover:opacity-100",
            )}
          />
        }
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{thread.title}</span>
      </TooltipTrigger>
      <TooltipPopup>{`${role} · ${thread.title}${cancelled ? " · cancelled" : ""}`}</TooltipPopup>
    </Tooltip>
  );
}
