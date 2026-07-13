import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { GitForkIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useThreadShell } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ForkedFromBadgeProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onNavigateToThread: (threadId: ThreadId) => void;
}

/**
 * Thread fork (MVP) lineage: when the active thread was forked from another,
 * show a compact "forked from <source>" chip in the header. Clicking jumps to
 * the source. Distinct from the delegation lineage breadcrumb — a fork is
 * divergence, not a parent/child spawn.
 */
export const ForkedFromBadge = memo(function ForkedFromBadge({
  environmentId,
  threadId,
  onNavigateToThread,
}: ForkedFromBadgeProps) {
  const selfRef = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const self = useThreadShell(selfRef);
  const forkFromThreadId = self?.forkFromThreadId ?? null;
  const sourceRef = useMemo(
    () => (forkFromThreadId ? scopeThreadRef(environmentId, forkFromThreadId) : null),
    [environmentId, forkFromThreadId],
  );
  const source = useThreadShell(sourceRef);
  if (!forkFromThreadId) {
    return null;
  }
  const sourceTitle = source?.title ?? "source thread";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`Forked from ${sourceTitle}`}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-transparent bg-accent/40 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => onNavigateToThread(forkFromThreadId)}
          >
            <GitForkIcon className="size-3" />
            <span className="max-w-32 truncate">forked from {sourceTitle}</span>
          </button>
        }
      />
      <TooltipPopup side="bottom">
        Forked from “{sourceTitle}” — full context copied, then diverged. Jump to source.
      </TooltipPopup>
    </Tooltip>
  );
});
