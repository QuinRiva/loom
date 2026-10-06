/**
 * loom: the two shell-derived Loom timeline rows (3d-3, see
 * `loomTimelineRows.ts`): a consult row (who this thread consulted, how often,
 * the last question) and a handoff receipt (a root that continues this thread,
 * and whether it is staged, launched or settled). Both link to the other
 * thread with the same chip the chat uses for thread references.
 */
import { ArrowRightIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { memo, use } from "react";

import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { cn } from "~/lib/utils";

import type { LoomTimelineRow as LoomTimelineRowData } from "./loomTimelineRows";
import { ThreadLinkChip } from "./verifiedFileChips";

const HANDOFF_STATE_LABEL = {
  staged: "staged",
  launched: "launched",
  done: "done",
  cancelled: "cancelled",
} as const;

export const LoomTimelineRow = memo(function LoomTimelineRow({ row }: { row: LoomTimelineRowData }) {
  const ctx = use(TimelineRowCtx);
  if (row.kind === "loom-consult") {
    const { consult } = row;
    return (
      <section
        className="-mx-1 min-w-0 px-1 py-0.5"
        aria-label={`Consulted ${consult.targetTitle}`}
        data-loom-consult={consult.targetThreadId}
      >
        <div className="flex items-center gap-1.5 rounded-lg border border-info/25 bg-info/[0.06] px-2 py-1.5 text-xs leading-5">
          <MessageCircleQuestionMarkIcon className="size-3.5 shrink-0 text-info-foreground" />
          <span className="text-foreground/82 shrink-0">Consulted</span>
          <span className="min-w-0 shrink-0">
            <ThreadLinkChip
              label={consult.targetTitle}
              threadId={consult.targetThreadId}
              environmentId={ctx.activeThreadEnvironmentId}
            />
          </span>
          <span className="text-muted-foreground/70 min-w-0 flex-1 truncate">
            — {consult.lastQuestionPreview}
          </span>
          {consult.count > 1 ? (
            <span className="text-info-foreground/80 shrink-0 text-3xs tabular-nums">
              {consult.count}×
            </span>
          ) : null}
        </div>
      </section>
    );
  }
  const { successor } = row;
  return (
    <section
      className="-mx-1 min-w-0 px-1 py-0.5"
      aria-label={`Handed off to ${successor.title}`}
      data-loom-handoff={successor.threadId}
    >
      <div className="flex items-center gap-1.5 rounded-lg border border-success/25 bg-success/[0.06] px-2 py-1.5 text-xs leading-5">
        <ArrowRightIcon className="size-3.5 shrink-0 text-success-foreground" />
        <span className="text-foreground/82 shrink-0">Handed off to</span>
        <span className="min-w-0 truncate">
          <ThreadLinkChip
            label={successor.title}
            threadId={successor.threadId}
            environmentId={ctx.activeThreadEnvironmentId}
          />
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            "shrink-0 text-3xs tracking-wide uppercase",
            successor.state === "cancelled" ? "text-muted-foreground/70" : "text-success-foreground",
          )}
        >
          {HANDOFF_STATE_LABEL[successor.state]}
        </span>
      </div>
    </section>
  );
});
