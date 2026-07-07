import { type ThreadId } from "@t3tools/contracts";
import { type ReactNode } from "react";
import { ChevronRightIcon, CornerLeftUpIcon } from "lucide-react";
import { type LineageSegment } from "../threadRouteLineage";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

const MAX_VISIBLE_LINEAGE_SEGMENTS = 3;

function LineageSegmentChip({
  segment,
  isRoot,
  onNavigate,
}: {
  segment: LineageSegment;
  isRoot: boolean;
  onNavigate: (threadId: ThreadId) => void;
}) {
  if (segment.missing) {
    return (
      <span className="shrink-0 truncate rounded-md border border-dashed border-border/70 px-2 py-0.5 text-xs text-muted-foreground/70">
        parent unavailable
      </span>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => onNavigate(segment.threadId)}
            className={cn(
              "flex min-w-0 items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground",
              segment.archived ? "opacity-60" : "",
            )}
          >
            {isRoot ? (
              <span className="shrink-0 font-medium">Orchestrator</span>
            ) : (
              <span className="min-w-0 max-w-32 truncate">{segment.title}</span>
            )}
          </button>
        }
      />
      <TooltipPopup side="top">
        {isRoot ? `Orchestrator \u00b7 ${segment.title}` : segment.title}
      </TooltipPopup>
    </Tooltip>
  );
}

export function ThreadLineageBreadcrumb({
  lineage,
  role,
  onNavigateToThread,
}: {
  lineage: ReadonlyArray<LineageSegment>;
  role: string | null;
  onNavigateToThread: (threadId: ThreadId) => void;
}) {
  if (lineage.length === 0) {
    return null;
  }

  const elide = lineage.length > MAX_VISIBLE_LINEAGE_SEGMENTS;
  const visible = elide ? [lineage[0]!, lineage[lineage.length - 1]!] : lineage;
  const hiddenTitles = elide ? lineage.slice(1, -1).map((segment) => segment.title) : [];

  const separator = (key: string) => (
    <ChevronRightIcon key={key} className="size-3 shrink-0 text-muted-foreground/55" />
  );

  const nodes: ReactNode[] = [];
  visible.forEach((segment, index) => {
    if (nodes.length > 0) {
      nodes.push(separator(`sep-${segment.threadId}`));
    }
    nodes.push(
      <LineageSegmentChip
        key={segment.threadId}
        segment={segment}
        isRoot={segment.isRoot}
        onNavigate={onNavigateToThread}
      />,
    );
    if (elide && index === 0) {
      nodes.push(separator("sep-ellipsis"));
      nodes.push(
        <Tooltip key="lineage-ellipsis">
          <TooltipTrigger
            render={
              <span className="shrink-0 px-1 text-xs text-muted-foreground/70">{"\u2026"}</span>
            }
          />
          <TooltipPopup side="top">{hiddenTitles.join(" \u203a ")}</TooltipPopup>
        </Tooltip>,
      );
    }
  });

  return (
    <span className="flex min-w-0 items-center gap-1 text-muted-foreground">
      <CornerLeftUpIcon className="size-3.5 shrink-0" />
      {nodes}
      {separator("sep-role")}
      <span className="shrink-0 rounded-md border border-border/60 px-2 py-0.5 text-xs text-muted-foreground">
        {role?.trim() || "sub-thread"}
      </span>
    </span>
  );
}
