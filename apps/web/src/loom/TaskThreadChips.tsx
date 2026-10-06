/**
 * loom: task→thread anchor chips for the goal panel's task tree (3d-3).
 *
 * A Loom thread may be anchored to one task of its goal
 * (`workstream.anchorTaskId`). The task row names the thread working it and
 * opens it on click. Derived entirely from the thread shells already held: no
 * new payload, no server query. Archived threads are dropped; a cancelled
 * thread stays, dimmed — "the thread that owned this task was cancelled" is
 * exactly what a human reading a stalled task row needs to see.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, GoalId } from "@t3tools/contracts";
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
import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";

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

export type AnchoredThreadsByTask = ReadonlyMap<string, ReadonlyArray<EnvironmentThreadShell>>;

/** Goal tasks → the threads anchored to them, oldest first (a fork sits after its source). */
export function useAnchoredThreadsByTask(
  goalId: GoalId,
  environmentId: EnvironmentId,
): AnchoredThreadsByTask {
  const shells = useThreadShells();
  return useMemo(() => {
    const byTask = new Map<string, EnvironmentThreadShell[]>();
    for (const thread of shells
      .filter(
        (thread) =>
          thread.environmentId === environmentId &&
          thread.archivedAt === null &&
          thread.source.workstream?.goalId === goalId &&
          thread.source.workstream.anchorTaskId !== null,
      )
      .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      const taskId = thread.source.workstream!.anchorTaskId!;
      byTask.set(taskId, [...(byTask.get(taskId) ?? []), thread]);
    }
    return byTask;
  }, [shells, environmentId, goalId]);
}

export function TaskThreadChip({
  thread,
  current,
}: {
  thread: EnvironmentThreadShell;
  /** The thread the panel is open on: its own anchor reads "you are here". */
  current: boolean;
}) {
  const navigate = useNavigate();
  const role = thread.source.workstream?.role ?? "thread";
  const Icon = ROLE_ICONS[role.toLowerCase()] ?? BotIcon;
  const cancelled = thread.source.workstream?.outcome === "cancelled";
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
              "ml-1.5 inline-flex max-w-[11rem] translate-y-px items-center gap-1 rounded-full border border-border/60 px-1.5 align-middle text-3xs text-muted-foreground no-underline hover:bg-accent hover:text-foreground",
              current && "border-primary/50 text-foreground",
              // Cancelled is not archived: dimmed, never hidden.
              cancelled && "opacity-60 hover:opacity-100",
            )}
          />
        }
      >
        <Icon className="size-3 shrink-0" />
        <span className="truncate">{thread.title}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {`${role} · ${thread.title}${current ? " · this thread's anchor" : ""}${cancelled ? " · cancelled" : ""}`}
      </TooltipPopup>
    </Tooltip>
  );
}
