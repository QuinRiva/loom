import type { ThreadId } from "@t3tools/contracts";
import { ChevronRightIcon, CornerLeftUpIcon, GitForkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { cn } from "../lib/utils";
import type { LineageSegment } from "../threadRouteLineage";

const MAX_VISIBLE_LINEAGE_SEGMENTS = 3;

function LineageChip({
  label,
  tooltip,
  dimmed,
  onClick,
}: {
  label: ReactNode;
  tooltip: string;
  dimmed?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onClick}
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
              dimmed && "opacity-60",
            )}
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The active thread's ancestry, root → immediate parent, each a link; the
 * middle elides past three. A `forkFrom` child also shows its fork source (the
 * sidecar's `forkFromThreadId` — the shell carries no context-transfer edge;
 * upstream's Lineage panel draws that from the thread projection).
 */
export function ThreadLineageBreadcrumb({
  lineage,
  forkedFrom,
  onNavigateToThread,
}: {
  lineage: ReadonlyArray<LineageSegment>;
  forkedFrom: { readonly threadId: ThreadId; readonly title: string } | null;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  if (lineage.length === 0 && forkedFrom === null) return null;

  const elide = lineage.length > MAX_VISIBLE_LINEAGE_SEGMENTS;
  const visible = elide ? [lineage[0]!, lineage[lineage.length - 1]!] : lineage;
  const hidden = elide ? lineage.slice(1, -1).map((segment) => segment.title) : [];
  const separator = (key: string) => (
    <ChevronRightIcon key={key} className="size-3 shrink-0 text-muted-foreground/60" />
  );

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1 text-muted-foreground">
      {lineage.length > 0 ? <CornerLeftUpIcon className="size-3.5 shrink-0" /> : null}
      {visible.flatMap((segment, index) => [
        ...(index > 0 ? [separator(`sep-${segment.threadId}`)] : []),
        segment.missing ? (
          <span
            key={segment.threadId}
            className="rounded-md border border-dashed border-border px-1.5 py-0.5 text-xs text-muted-foreground/70"
          >
            parent unavailable
          </span>
        ) : (
          <LineageChip
            key={segment.threadId}
            label={
              segment.isRoot ? (
                <span className="shrink-0 font-medium">Orchestrator</span>
              ) : (
                <span className="max-w-32 truncate">{segment.title}</span>
              )
            }
            tooltip={segment.isRoot ? `Orchestrator · ${segment.title}` : segment.title}
            dimmed={segment.archived}
            onClick={() => onNavigateToThread(segment.threadId)}
          />
        ),
        ...(elide && index === 0
          ? [
              separator("sep-ellipsis"),
              <Tooltip key="lineage-ellipsis">
                <TooltipTrigger render={<span className="px-1 text-xs" />}>…</TooltipTrigger>
                <TooltipPopup side="top">{hidden.join(" › ")}</TooltipPopup>
              </Tooltip>,
            ]
          : []),
      ])}
      {forkedFrom ? (
        <LineageChip
          label={
            <>
              <GitForkIcon className="size-3 shrink-0" />
              <span className="max-w-32 truncate">{forkedFrom.title}</span>
            </>
          }
          tooltip={`Forked from ${forkedFrom.title}`}
          onClick={() => onNavigateToThread(forkedFrom.threadId)}
        />
      ) : null}
    </div>
  );
}
