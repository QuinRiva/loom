/**
 * loom: the handoff receipt (`loomTimelineRows.ts`) — where this thread's work
 * went: a `/handoff` drafting, failed or handed off, or the thread's own
 * `goal_handoff` / `goal_continue`. Its grammar is deliberately non-message (a
 * kicker, full width) because none of it entered this thread's conversation.
 * The `/handoff` explanation is shown in full and copyable: on a failure it is
 * the second copy that makes the handoff recoverable.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { GitBranchIcon, HourglassIcon, TriangleAlertIcon } from "lucide-react";

import { MessageCopyButton } from "~/components/chat/MessageCopyButton";
import { cn } from "~/lib/utils";

import type { LoomReceiptState, LoomTimelineRow } from "./loomTimelineRows";
import { ThreadLinkChip } from "./verifiedFileChips";

export const HANDOFF_FAILURE_REASON =
  "The drafter stopped without placing a handoff, so no goal was created.";

const STATE: Record<
  LoomReceiptState,
  { kicker: string; icon: typeof GitBranchIcon; box: string; tone: string }
> = {
  drafting: {
    kicker: "Handing off",
    icon: HourglassIcon,
    box: "border-l-info/65 bg-info/5",
    tone: "text-info-foreground",
  },
  failed: {
    kicker: "Handoff needs you",
    icon: TriangleAlertIcon,
    box: "border-l-warning bg-warning/8",
    tone: "text-warning-foreground",
  },
  "handed-off": {
    kicker: "Handed off",
    icon: GitBranchIcon,
    box: "border-l-success/55 bg-success/5",
    tone: "text-success-foreground",
  },
};

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
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-l-2 border-border px-2.5 py-1.5 text-xs leading-5 text-muted-foreground",
          state.box,
        )}
      >
        <Icon className={cn("size-3.5 shrink-0", state.tone)} />
        <span
          className={cn("shrink-0 text-3xs font-semibold tracking-widest uppercase", state.tone)}
        >
          {state.kicker}
        </span>
        {row.state === "drafting" ? (
          <span>A drafter is writing the brief</span>
        ) : row.state === "failed" ? (
          <span>{HANDOFF_FAILURE_REASON}</span>
        ) : null}
        {row.destinations.map((destination) => (
          <span key={destination.threadId} className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 truncate">
              <ThreadLinkChip
                label={destination.title ?? "an archived goal"}
                threadId={destination.threadId}
                environmentId={environmentId}
              />
            </span>
            {destination.state ? (
              <span className="shrink-0 text-3xs tracking-wide uppercase">{destination.state}</span>
            ) : null}
          </span>
        ))}
        {row.state === "failed" && row.drafterThreadId ? (
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
            <span className="min-w-0 flex-1 font-medium wrap-break-word text-foreground/85">
              {row.explanation}
            </span>
            <MessageCopyButton text={row.explanation} size="icon-xs" variant="ghost" />
          </span>
        ) : null}
      </div>
    </section>
  );
}
