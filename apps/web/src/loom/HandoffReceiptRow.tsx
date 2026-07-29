import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { EyeOffIcon, GitBranchIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react";
import { memo, use } from "react";

import { MessageCopyButton } from "~/components/chat/MessageCopyButton";
import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { buildThreadRouteParams } from "~/threadRoutes";
import { formatShortTimestamp } from "~/timestampFormat";

import { type HandoffReceiptState } from "./handoffReceipts.logic";

/**
 * loom: the `/handoff` receipt — the immediate, source-local acknowledgement
 * that a handoff is under way.
 *
 * `/handoff` writes nothing to the source thread on purpose, so without this row
 * the keystroke is indistinguishable from a no-op. Its visual grammar is
 * deliberately *non-message*: full-width and left-aligned, with a kicker and an
 * explicit "not in context" chip, so it can never be read as something the model
 * saw. A verbatim echo styled like a user bubble was explicitly rejected —
 * looking like speech is exactly what invites the belief that the handoff
 * reached the model, which is the misunderstanding this feature exists to avoid.
 *
 * The explanation is shown in full and is copyable. That is load-bearing rather
 * than decorative: it is the second on-screen copy that makes a failed dispatch
 * recoverable when the composer has since been typed into, the direct analogue
 * of the optimistic user bubble a failed normal send leaves behind. It matters
 * most in the failed state, which is also where the non-message grammar must be
 * held most strictly.
 */

const KICKERS: Record<HandoffReceiptState, string> = {
  dispatching: "Handing off",
  drafting: "Handing off",
  settled: "Handed off",
  failed: "Handoff needs you",
};

const STATE_CLASSES: Record<HandoffReceiptState, string> = {
  dispatching: "border-l-info/65 bg-info/5",
  drafting: "border-l-info/65 bg-info/5",
  settled: "border-l-primary/55 bg-primary/5",
  failed: "border-l-warning bg-warning/8",
};

const KICKER_CLASSES: Record<HandoffReceiptState, string> = {
  dispatching: "text-info-foreground",
  drafting: "text-info-foreground",
  settled: "text-primary",
  failed: "text-warning-foreground",
};

export const HandoffReceiptRow = memo(function HandoffReceiptRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "handoff-receipt" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const navigate = useNavigate();
  const { state, explanation, drafterThreadId, failureReason } = row.receipt;
  const pending = state === "dispatching" || state === "drafting";

  return (
    <div
      className={cn(
        "flex w-full flex-wrap items-start gap-x-2.5 gap-y-1.5 rounded-md border border-border border-l-2 px-2.5 py-2 text-[11.5px] text-muted-foreground",
        STATE_CLASSES[state],
      )}
      data-handoff-receipt-state={state}
    >
      <span className="flex shrink-0 items-center gap-1.5 pt-px">
        {pending ? (
          <Loader2Icon className="size-3.5 animate-spin text-info-foreground" />
        ) : state === "failed" ? (
          <TriangleAlertIcon className="size-3.5 text-warning" />
        ) : (
          <GitBranchIcon className="size-3.5 text-primary" />
        )}
        <span
          className={cn(
            "text-[9.5px] font-semibold uppercase tracking-[0.07em]",
            KICKER_CLASSES[state],
          )}
        >
          {KICKERS[state]}
        </span>
      </span>

      <span className="min-w-0 flex-1 wrap-break-word">
        <span className="block">
          {state === "dispatching"
            ? "Forking this session"
            : state === "drafting"
              ? "A drafter is composing the brief"
              : state === "settled"
                ? "Staged as its own goal"
                : failureReason}
        </span>
        {/* Verbatim and never truncated: this is the recoverable second copy. */}
        <span className="mt-0.5 block font-medium text-foreground/85">{explanation}</span>
      </span>

      {state === "failed" && drafterThreadId !== null ? (
        <button
          type="button"
          className="shrink-0 cursor-pointer font-semibold text-warning-foreground hover:underline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: buildThreadRouteParams(
                scopeThreadRef(ctx.activeThreadEnvironmentId, drafterThreadId),
              ),
            })
          }
        >
          Open drafter
        </button>
      ) : null}

      <span className="flex shrink-0 items-center gap-1.5">
        <span className="text-[10.5px] text-muted-foreground/70 tabular-nums">
          {formatShortTimestamp(row.createdAt, ctx.timestampFormat)}
        </span>
        <MessageCopyButton text={explanation} size="icon-xs" variant="ghost" />
        <Tooltip>
          <TooltipTrigger
            render={
              <span className="inline-flex cursor-help items-center gap-1 rounded-sm border border-dashed border-foreground/20 px-1 py-px text-[9.5px] font-semibold uppercase tracking-[0.03em]" />
            }
          >
            <EyeOffIcon className="size-2.5" />
            Not in context
          </TooltipTrigger>
          <TooltipPopup>
            <p>
              Presentation only. This is a timeline row, not a message — the handoff never entered
              this thread's conversation, so the model has not seen it.
            </p>
          </TooltipPopup>
        </Tooltip>
      </span>
    </div>
  );
});
