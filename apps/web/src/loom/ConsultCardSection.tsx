import { scopeThreadRef, parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { memo, use, useEffect, useState } from "react";
import { ChevronDownIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { type WorkLogEntry } from "~/session-logic";
import { buildThreadRouteParams } from "~/threadRoutes";
import ChatMarkdown from "~/components/ChatMarkdown";
import { cn } from "~/lib/utils";
import { useLoomScrollStore } from "~/loom/loomScrollStore";
import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";

/**
 * Inline consult card(s): a per-turn rendering of `consult_thread` tool results.
 * Unlike a generic tool row's `<pre>` dump, it surfaces the *content* of the
 * cross-thread exchange — the question as a quoted block and the answer as real
 * chat markdown — because answer digestibility is the whole point of the drill-in.
 * Each consult is its own collapsed-by-default accordion (multiple consults in
 * one turn stack as sequential cards).
 */
export const ConsultCardSection = memo(function ConsultCardSection({
  row,
}: {
  row: Extract<MessagesTimelineRow, { kind: "consult" }>;
}) {
  return (
    <section className="-mx-1 space-y-1 px-1 py-0.5" aria-label="Thread consults">
      {row.entries.map((entry) =>
        entry.consult ? <ConsultCard key={entry.id} entry={entry} /> : null,
      )}
    </section>
  );
});

/** Answers longer than this get a clamped body with an explicit "Show full answer" toggle. */
const CONSULT_ANSWER_CLAMP_CHARS = 600;

const ConsultCard = memo(function ConsultCard({ entry }: { entry: WorkLogEntry }) {
  const ctx = use(TimelineRowCtx);
  const environmentId = ctx.activeThreadEnvironmentId;
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const [showFullAnswer, setShowFullAnswer] = useState(false);
  const consult = entry.consult!;
  const targetTitle = consult.title?.trim() || "another thread";

  // Reveal-on-click from a Workstream consult edge: expand this card once when a
  // parked `consultReveal` targets our thread + consult target, then clear it so
  // the signal fires for a single card and the user can still collapse it.
  const consultReveal = useLoomScrollStore((store) => store.consultReveal);
  const clearConsultReveal = useLoomScrollStore((store) => store.clearConsultReveal);
  const activeThreadId = parseScopedThreadKey(ctx.routeThreadKey)?.threadId ?? null;
  useEffect(() => {
    if (
      consultReveal &&
      consultReveal.threadId === activeThreadId &&
      consultReveal.targetThreadId === consult.targetThreadId
    ) {
      setExpanded(true);
      clearConsultReveal();
    }
  }, [consultReveal, activeThreadId, consult.targetThreadId, clearConsultReveal]);
  const openTarget = () => {
    if (!consult.targetThreadId) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, consult.targetThreadId)),
    });
  };
  const answer = consult.answer?.trim() ?? "";
  const answerClamped = !showFullAnswer && answer.length > CONSULT_ANSWER_CLAMP_CHARS;

  return (
    <div className="rounded-lg border border-teal-400/25 bg-teal-400/[0.06]">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[12px] leading-5 transition-colors hover:bg-teal-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-teal-300">
          <MessageCircleQuestionMarkIcon className="size-3.5 shrink-0" />
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-1">
          <span className="shrink-0 text-foreground/82">Consulted</span>
          {consult.targetThreadId ? (
            <span
              role="link"
              tabIndex={0}
              className="shrink-0 cursor-pointer font-medium text-teal-200 underline-offset-2 hover:underline focus-visible:underline focus-visible:outline-none"
              onClick={(event) => {
                event.stopPropagation();
                openTarget();
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  event.stopPropagation();
                  openTarget();
                }
              }}
            >
              {targetTitle}
            </span>
          ) : (
            <span className="shrink-0 font-medium text-foreground/82">{targetTitle}</span>
          )}
          {!expanded && consult.question ? (
            <span className="min-w-0 truncate text-muted-foreground/70">— {consult.question}</span>
          ) : null}
        </span>
        <ChevronDownIcon
          className={cn(
            "ml-auto size-3.5 shrink-0 opacity-60 transition-transform duration-200",
            expanded && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {expanded ? (
        <div className="space-y-2 border-t border-teal-400/15 px-2.5 py-2">
          {consult.question ? (
            <blockquote className="border-l-2 border-teal-400/40 pl-2.5 text-[12px] leading-5 text-foreground/70">
              {consult.question}
            </blockquote>
          ) : null}
          {consult.resolved ? (
            answer.length > 0 ? (
              <div>
                <div className={cn("relative overflow-hidden", answerClamped && "max-h-64")}>
                  <ChatMarkdown
                    text={answer}
                    cwd={ctx.markdownCwd}
                    threadRef={ctx.threadRef ?? undefined}
                    skills={ctx.skills}
                  />
                  {answerClamped ? (
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-background to-transparent" />
                  ) : null}
                </div>
                {answer.length > CONSULT_ANSWER_CLAMP_CHARS ? (
                  <button
                    type="button"
                    className="mt-1 text-[11px] font-medium text-teal-300 hover:underline focus-visible:underline focus-visible:outline-none"
                    onClick={() => setShowFullAnswer((v) => !v)}
                  >
                    {showFullAnswer ? "Show less" : "Show full answer"}
                  </button>
                ) : null}
              </div>
            ) : (
              <p className="text-[12px] italic leading-5 text-muted-foreground/70">
                No answer was returned.
              </p>
            )
          ) : (
            <p className="text-[12px] italic leading-5 text-muted-foreground/70">
              Did not resolve to a single thread
              {consult.candidateCount ? ` — ${consult.candidateCount} candidates` : ""}.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
});
