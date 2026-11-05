/**
 * loom: the handoff receipt row, where this thread's work went. Its grammar is deliberately
 * non-message (a kicker, full width) because none of it entered this thread's conversation. The
 * `/handoff` explanation is shown in full and copyable: on a failure it is the second copy that
 * makes the handoff recoverable.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  GitBranchIcon,
  HourglassIcon,
  MessageSquareShareIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { MarkdownThreadLink } from "~/components/chat/MarkdownThreadLink";
import { MessageCopyButton } from "~/components/chat/MessageCopyButton";
import { cn } from "~/lib/utils";

import type { LoomPromotionRow, LoomReceiptState, LoomTimelineRow } from "./loomTimelineRows";
import { ThreadLinkChip } from "./verifiedFileChips";

export const HANDOFF_FAILURE_REASON =
  "The drafter stopped without placing a handoff, so no goal was created.";

const STATE: Record<
  LoomReceiptState,
  { kicker: string; icon: typeof GitBranchIcon; border: string; tone: string }
> = {
  waiting: {
    kicker: "Handing off",
    icon: HourglassIcon,
    border: "border-border/80",
    tone: "text-muted-foreground",
  },
  drafting: {
    kicker: "Handing off",
    icon: HourglassIcon,
    border: "border-border/80",
    tone: "text-muted-foreground",
  },
  // Only the state the user must act on keeps colour.
  failed: {
    kicker: "Handoff needs you",
    icon: TriangleAlertIcon,
    border: "border-warning/50",
    tone: "text-warning-foreground",
  },
  "handed-off": {
    kicker: "Handed off",
    icon: GitBranchIcon,
    border: "border-border/80",
    tone: "text-muted-foreground",
  },
};

const RECEIPT_FRAME =
  "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-2xl border bg-card/70 px-3 py-2 text-xs leading-5 text-muted-foreground";

/** Context-free (the preview mounts it directly). */
export function LoomTimelineRowView({
  row,
  environmentId,
}: {
  row: LoomTimelineRow;
  environmentId: EnvironmentId;
}) {
  const state = STATE[row.state];
  const Icon = state.icon;
  return (
    <section
      className="-mx-1 min-w-0 px-1 py-0.5"
      aria-label={state.kicker}
      data-loom-handoff={row.state}
    >
      <div className={cn(RECEIPT_FRAME, state.border)}>
        <Icon className={cn("size-3.5 shrink-0", state.tone)} />
        <span className={cn("shrink-0 font-medium", state.tone)}>{state.kicker}</span>
        {row.state === "waiting" ? (
          <span>The drafter starts when this turn finishes</span>
        ) : row.state === "drafting" ? (
          <span>A drafter is writing the brief</span>
        ) : row.state === "failed" ? (
          <span>{HANDOFF_FAILURE_REASON}</span>
        ) : null}
        {row.destinations.map((destination) => (
          <span key={destination.threadId} className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">
              <ThreadLinkChip
                label={destination.title ?? "another thread"}
                threadId={destination.threadId}
                environmentId={environmentId}
              />
            </span>
            {destination.state ? <span className="shrink-0">{destination.state}</span> : null}
          </span>
        ))}
        {/* Every live drafter, not only a failed one: a hung kickoff flags the source and still reads "drafting". */}
        {row.state !== "handed-off" && row.drafterThreadId ? (
          <span className="shrink-0">
            <ThreadLinkChip
              label="Open drafter"
              threadId={row.drafterThreadId}
              environmentId={environmentId}
            />
          </span>
        ) : null}
        {row.explanation ? (
          <span className="flex basis-full items-start gap-1.5">
            <span className="min-w-0 flex-1 font-medium wrap-break-word text-foreground">
              {row.explanation}
            </span>
            <MessageCopyButton text={row.explanation} size="icon-xs" variant="ghost" />
          </span>
        ) : null}
      </div>
    </section>
  );
}

/** A promoted exchange's receipt: the author thread whose composer now holds the comment. */
export function LoomPromotionRowView({
  row,
  environmentId,
}: {
  row: LoomPromotionRow;
  environmentId: EnvironmentId;
}) {
  return (
    <section className="-mx-1 min-w-0 px-1 py-0.5" aria-label="Promoted" data-loom-promotion="">
      <div className={cn(RECEIPT_FRAME, "border-border/80")}>
        <MessageSquareShareIcon className="size-3.5 shrink-0" />
        <span className="shrink-0 font-medium">Promoted</span>
        {/* `chat-markdown` gives the mention its in-chat link look. */}
        <span className="chat-markdown min-w-0">
          Comment waiting in the composer of{" "}
          <MarkdownThreadLink
            environmentId={environmentId}
            link={{ environmentId, threadId: row.authorThreadId }}
            label="the author thread"
            fromThreadRef={scopeThreadRef(environmentId, row.sourceThreadId)}
          />
        </span>
      </div>
    </section>
  );
}
