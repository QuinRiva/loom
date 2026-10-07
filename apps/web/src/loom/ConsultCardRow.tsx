import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  turnItemDetailRevision,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import type { OrchestrationV2ProjectedTurnItem, ThreadId } from "@t3tools/contracts";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { ChevronDownIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { memo, use, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useTurnItemDetail } from "~/state/queries";

import { ThreadLinkChip } from "./verifiedFileChips";

/**
 * loom: the card a `mcp__t3-code__consult_thread` call renders as (pull 7's
 * PR #270 card, on V2's turn items).
 *
 * A consult is a conversation between two threads, and both halves of it are
 * content a reader needs. Upstream's grouped tool row shows neither: the call
 * is one line among the `echo`s and the answer a raw dump behind an expansion.
 * The card restores the exchange: who was asked (a navigable thread chip),
 * what was asked, whether it answered, and the answer as chat markdown so file
 * paths in it stay clickable. The wire withholds the answer, so it is fetched
 * (`getTurnItem`) only while the card is open.
 */
export const ConsultCardRow = memo(function ConsultCardRow({
  projectedItem,
}: {
  projectedItem: OrchestrationV2ProjectedTurnItem;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const [showFullAnswer, setShowFullAnswer] = useState(false);
  const { item } = projectedItem;
  const input = (item.type === "dynamic_tool" ? item.input : null) as Record<
    string,
    unknown
  > | null;
  const text = (key: string) =>
    typeof input?.[key] === "string" && input[key].trim() ? input[key].trim() : null;
  const [targetThreadId, targetName, question] = [text("threadId"), text("name"), text("question")];
  const target = useThreadShell(
    targetThreadId === null
      ? null
      : scopeThreadRef(ctx.activeThreadEnvironmentId, targetThreadId as ThreadId),
  );
  const status: keyof typeof STATUS =
    item.status === "completed"
      ? item.type === "dynamic_tool" && compactDynamicToolOutput(item.output)?.isError
        ? "failed"
        : "answered"
      : item.status === "failed" || item.status === "interrupted" || item.status === "cancelled"
        ? "failed"
        : "waiting";
  const detail = useTurnItemDetail(
    expanded && status !== "waiting"
      ? {
          environmentId: ctx.activeThreadEnvironmentId,
          threadId: projectedItem.sourceThreadId,
          itemId: projectedItem.sourceItemId,
          revision: turnItemDetailRevision(item),
        }
      : null,
  );
  const fetched = detail.data?.item;
  const answer = (fetched ? turnItemOutputText(fetched) : null)?.trim() ?? "";
  const clamped = !showFullAnswer && answer.length > ANSWER_CLAMP_CHARS;
  const toggle = () => setExpanded((value) => !value);

  return (
    <section
      className="-mx-1 min-w-0 px-1 py-0.5"
      aria-label={`Consult — ${target?.title ?? targetName ?? "another thread"}, ${STATUS[status].label}`}
    >
      <div className="rounded-lg border border-info/25 bg-info/6" data-consult-card={status}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={toggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            toggle();
          }}
          className="focus-visible:ring-ring/70 flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs leading-5 transition-colors hover:bg-info/10 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        >
          <MessageCircleQuestionMarkIcon className="size-3.5 shrink-0 text-info-foreground" />
          <span className="text-foreground/82 shrink-0">Consulted</span>
          {/* The chip navigates on click; the card must not also toggle. */}
          <span className="min-w-0 shrink-0" onClick={(event) => event.stopPropagation()}>
            {targetThreadId ? (
              <ThreadLinkChip
                label={target?.title ?? targetThreadId}
                threadId={targetThreadId}
                environmentId={ctx.activeThreadEnvironmentId}
              />
            ) : (
              <span className="text-muted-foreground/80 italic">«{targetName ?? "a thread"}»</span>
            )}
          </span>
          {!expanded && question ? (
            <span className="text-muted-foreground/70 min-w-0 flex-1 truncate">— {question}</span>
          ) : (
            <span className="flex-1" />
          )}
          <span className={cn("shrink-0 text-3xs tracking-wide uppercase", STATUS[status].tone)}>
            {STATUS[status].label}
          </span>
          <ChevronDownIcon
            className={cn(
              "size-3.5 shrink-0 opacity-60 transition-transform duration-200",
              expanded && "rotate-180",
            )}
            aria-hidden
          />
        </div>

        {expanded ? (
          <div className="space-y-2 border-t border-info/15 px-2.5 py-2">
            {question ? (
              <blockquote className="text-foreground/70 border-l-2 border-info/40 pl-2.5 text-xs leading-5 whitespace-pre-wrap">
                {question}
              </blockquote>
            ) : null}
            {status === "answered" && answer.length > 0 ? (
              <div>
                <div className={cn("relative overflow-hidden", clamped && "max-h-64")}>
                  <ChatMarkdown
                    text={answer}
                    cwd={ctx.markdownCwd}
                    threadRef={ctx.threadRef ?? undefined}
                    skills={ctx.skills}
                  />
                  {clamped ? (
                    <div className="from-background pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t to-transparent" />
                  ) : null}
                </div>
                {answer.length > ANSWER_CLAMP_CHARS ? (
                  <button
                    type="button"
                    className="mt-1 text-2xs font-medium text-info-foreground hover:underline focus-visible:underline focus-visible:outline-none"
                    onClick={() => setShowFullAnswer((value) => !value)}
                  >
                    {showFullAnswer ? "Show less" : "Show full answer"}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="text-muted-foreground/80 text-xs leading-5 whitespace-pre-wrap">
                {status === "waiting"
                  ? "Waiting for the answer."
                  : answer || (detail.isPending ? "Loading…" : "No answer was returned.")}
              </p>
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
});

/** Answers past this length get a clamped body with an explicit expand. */
const ANSWER_CLAMP_CHARS = 600;

const STATUS = {
  waiting: { label: "waiting", tone: "text-warning-foreground/80" },
  answered: { label: "answered", tone: "text-info-foreground/80" },
  failed: { label: "failed", tone: "text-destructive-foreground/80" },
} as const;
