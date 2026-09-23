import { type ConsultStatus } from "@t3tools/shared/consultActivity.loom";
import { ChevronDownIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { memo, use, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";
import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { cn } from "~/lib/utils";

import { ThreadLinkChip } from "./verifiedFileChips";

/**
 * loom: the card a `consult_thread` call renders as.
 *
 * A consult is a conversation between two threads, and both halves of it —
 * the question this thread asked and the answer the other one gave — are
 * content a reader needs. Upstream's grouped tool row shows neither: the call
 * becomes a "Consult_thread" line among the `echo`s, and the answer is a raw
 * result dump behind an expansion. The card restores the exchange: who was
 * asked (a navigable thread chip), what was asked, whether it answered, and
 * the answer itself as real chat markdown, so file paths in it stay clickable
 * chips rather than degrading to plain text.
 */
export const ConsultCardRow = memo(function ConsultCardRow({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "consult" }>;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(false);
  const [showFullAnswer, setShowFullAnswer] = useState(false);
  const consult = row.consult;
  const status = STATUS[consult.status];
  const answer = consult.answer?.trim() ?? "";
  const clamped = !showFullAnswer && answer.length > ANSWER_CLAMP_CHARS;
  const toggle = () => setExpanded((value) => !value);

  return (
    <section
      className="-mx-1 min-w-0 px-1 py-0.5"
      aria-label={`Consult — ${consult.targetTitle ?? "another thread"}, ${status.label}`}
    >
      <div
        className="rounded-lg border border-teal-400/25 bg-teal-400/[0.06]"
        data-consult-card={consult.status}
      >
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
          className="focus-visible:ring-ring/70 flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] leading-5 transition-colors hover:bg-teal-400/10 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        >
          <MessageCircleQuestionMarkIcon className="size-3.5 shrink-0 text-teal-300" />
          <span className="text-foreground/82 shrink-0">Consulted</span>
          {/* The chip navigates on click and goes inert when the thread is gone;
              the card must not also toggle when it is used. */}
          <span className="min-w-0 shrink-0" onClick={(event) => event.stopPropagation()}>
            {consult.targetThreadId ? (
              <ThreadLinkChip
                label={consult.targetTitle ?? "thread"}
                threadId={consult.targetThreadId}
                environmentId={ctx.activeThreadEnvironmentId}
              />
            ) : (
              <span className="text-muted-foreground/80 italic">a thread by name</span>
            )}
          </span>
          {!expanded && consult.question ? (
            <span className="text-muted-foreground/70 min-w-0 flex-1 truncate">
              — {consult.question}
            </span>
          ) : (
            <span className="flex-1" />
          )}
          <span className={cn("shrink-0 text-[10px] tracking-wide uppercase", status.tone)}>
            {status.label}
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
          <div className="space-y-2 border-t border-teal-400/15 px-2.5 py-2">
            {consult.question ? (
              <blockquote className="text-foreground/70 border-l-2 border-teal-400/40 pl-2.5 text-[12px] leading-5 whitespace-pre-wrap">
                {consult.question}
              </blockquote>
            ) : null}
            {consult.status === "answered" && answer.length > 0 ? (
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
                    className="mt-1 text-[11px] font-medium text-teal-300 hover:underline focus-visible:underline focus-visible:outline-none"
                    onClick={() => setShowFullAnswer((value) => !value)}
                  >
                    {showFullAnswer ? "Show less" : "Show full answer"}
                  </button>
                ) : null}
              </div>
            ) : consult.note ? (
              <p className="text-muted-foreground/80 text-[12px] leading-5 whitespace-pre-wrap">
                {consult.note}
              </p>
            ) : (
              <p className="text-muted-foreground/70 text-[12px] leading-5 italic">
                {consult.status === "pending"
                  ? "Waiting for the answer."
                  : "No answer was returned."}
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

const STATUS: Record<ConsultStatus, { label: string; tone: string }> = {
  pending: { label: "waiting", tone: "text-amber-300/80" },
  answered: { label: "answered", tone: "text-teal-300/80" },
  unresolved: { label: "no match", tone: "text-muted-foreground/70" },
  failed: { label: "failed", tone: "text-rose-300/80" },
};
