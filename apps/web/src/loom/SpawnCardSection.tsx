import { type ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { memo, use, useMemo, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, GitBranchIcon } from "lucide-react";
import { type SidebarThreadSummary } from "~/types";
import { isAwaitingBrief } from "~/lib/workstreamPresentation";
import { useThreadShells } from "~/state/entities";
import { buildThreadRouteParams } from "~/threadRoutes";
import { cn } from "~/lib/utils";
import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";

/**
 * Inline spawn card: a grouped, per-turn rendering of `workstream_spawn` tool
 * results. It answers *causality* (which turn spawned which children) that the
 * buried individual tool chips don't, and makes each spawned child an
 * actionable click-through into the sub-thread.
 */
export const SpawnCardSection = memo(function SpawnCardSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "spawn" }>;
}) {
  const { activeThreadEnvironmentId: environmentId } = use(TimelineRowCtx);
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);

  const childIds = useMemo(
    () =>
      row.entries
        .map((entry) => entry.spawnedChild?.childThreadId)
        .filter((id): id is ThreadId => id != null),
    [row.entries],
  );
  const allShells = useThreadShells();
  const childSummaryById = useMemo(() => {
    const wanted = new Set<string>(childIds);
    const result: Record<string, SidebarThreadSummary> = {};
    for (const shell of allShells) {
      if (shell.environmentId === environmentId && wanted.has(shell.id)) {
        result[shell.id] = shell;
      }
    }
    return result;
  }, [allShells, childIds, environmentId]);

  const openChild = (childThreadId: ThreadId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, childThreadId)),
    });

  const count = row.entries.length;
  const summaryLabel = `${count} sub-thread${count === 1 ? "" : "s"} spawned`;

  return (
    <section className="-mx-1 px-1 py-0.5" aria-label={summaryLabel}>
      <div className="rounded-lg border border-violet-400/25 bg-violet-400/[0.06]">
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] leading-5 transition-colors hover:bg-violet-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
          onClick={() => setExpanded((v) => !v)}
        >
          <span className="flex size-5 shrink-0 items-center justify-center text-violet-300">
            <GitBranchIcon className="size-3.5 shrink-0" />
          </span>
          <span className="font-medium text-foreground/82">{summaryLabel}</span>
          <ChevronDownIcon
            className={cn(
              "ml-auto size-3.5 shrink-0 opacity-60 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        {expanded ? (
          <ul className="space-y-px border-t border-violet-400/15 p-1">
            {row.entries.map((entry) => {
              const spawned = entry.spawnedChild;
              if (!spawned) return null;
              const summary = childSummaryById[spawned.childThreadId];
              const role = summary?.role?.trim() || "sub-thread";
              const title = summary?.title?.trim() || spawned.title || "Untitled sub-thread";
              const childStatus = spawnChildStatus(summary);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-violet-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                    onClick={() => openChild(spawned.childThreadId)}
                  >
                    <span
                      className={cn("size-2 shrink-0 rounded-full", childStatus.dotClass)}
                      aria-hidden
                    />
                    <span className="shrink-0 rounded border border-violet-400/30 bg-violet-400/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-200">
                      {role}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-[12px] leading-5 text-foreground/82">
                      {title}
                    </span>
                    <span className="shrink-0 text-[10.5px] text-muted-foreground/55">
                      {childStatus.label}
                    </span>
                    <ChevronRightIcon className="size-3.5 shrink-0 opacity-50" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
});

/** Lightweight status read for a spawned child, decoupled from the full Workstream board
 *  effective-status machinery (which needs the sibling map for dependency resolution). */
function spawnChildStatus(summary: SidebarThreadSummary | undefined): {
  label: string;
  dotClass: string;
} {
  if (!summary) return { label: "spawning", dotClass: "bg-muted-foreground/40" };
  // Attention (needs-a-human) overlays any lane and wins the glance signal.
  if (summary.attention.includes("error")) return { label: "Error", dotClass: "bg-rose-400" };
  if (summary.attention.includes("needs_guidance"))
    return { label: "Needs you", dotClass: "bg-orange-400" };
  if (summary.attention.includes("awaiting_acceptance"))
    return { label: "Review", dotClass: "bg-violet-400" };
  const running = summary.session?.status === "running" || summary.latestTurn?.state === "running";
  if (running) return { label: "Running", dotClass: "bg-sky-400" };
  if (summary.planLane === "done") return { label: "Done", dotClass: "bg-emerald-400" };
  if (summary.planLane === "cancelled") return { label: "Cancelled", dotClass: "bg-slate-500" };
  if (summary.planLane === "in_progress") return { label: "In progress", dotClass: "bg-sky-400" };
  if (summary.planLane === "ready")
    return isAwaitingBrief(summary)
      ? { label: "Awaiting brief", dotClass: "bg-indigo-400" }
      : { label: "Ready", dotClass: "bg-cyan-400" };
  return { label: "Planned", dotClass: "bg-slate-400" };
}
