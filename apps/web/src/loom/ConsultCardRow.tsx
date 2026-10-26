import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  turnItemDetailRevision,
  turnItemOutputText,
} from "@t3tools/client-runtime/work-log/item-detail";
import {
  type LoomConsultStep,
  type LoomLiveConsult,
  type OrchestrationV2ProjectedTurnItem,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { compactDynamicToolOutput } from "@t3tools/shared/toolOutput";
import { formatTokens } from "@t3tools/shared/usageFormat";
import * as DateTime from "effect/DateTime";
import { ChevronDownIcon, MessageCircleQuestionMarkIcon } from "lucide-react";
import { memo, type ReactNode, use, useState } from "react";

import ChatMarkdown from "~/components/ChatMarkdown";
import { TimelineRowCtx } from "~/components/chat/timelineRowContext";
import { Button } from "~/components/ui/button";
import { WorkstreamModelPill } from "~/components/WorkstreamModelPill";
import { cn } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useTurnItemDetail } from "~/state/queries";
import { useAtomCommand } from "~/state/use-atom-command";

import { formatCostUsd } from "./costFormat";
import { useLiveConsult } from "./liveConsult";
import { loomCommands } from "./loomGoalState";
import { formatElapsed, StepElapsed } from "./StepElapsed";
import { ThreadLinkChip } from "./verifiedFileChips";

/**
 * loom: the card a `mcp__t3-code__consult_thread` call renders as, restoring the exchange upstream's
 * tool row hides: who was asked (a thread chip), the question, whether it answered, and the answer
 * as chat markdown, fetched (`getTurnItem`) only while open. A running consult also shows its fork's
 * live progress (`useLiveConsult`), this session only; after a reload a finished card shows the exchange.
 */
export const ConsultCardRow = memo(function ConsultCardRow({
  projectedItem,
}: {
  projectedItem: OrchestrationV2ProjectedTurnItem;
}) {
  const ctx = use(TimelineRowCtx);
  const [expanded, setExpanded] = useState(() => EXPANDED.has(projectedItem.sourceItemId));
  const [showFullAnswer, setShowFullAnswer] = useState(false);
  const [stopping, setStopping] = useState(false);
  const cancel = useAtomCommand(loomCommands.consultCancel, "Could not stop the consult");
  const { item } = projectedItem;
  const status: ConsultStatus =
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
  // The wire summarises a large input; the fetched item carries it whole.
  const source = fetched ?? item;
  const input = (source.type === "dynamic_tool" ? source.input : null) as Record<
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
  const startedAt = item.startedAt === null ? null : DateTime.formatIso(item.startedAt);
  const completedAt =
    status === "waiting" || item.completedAt === null ? null : DateTime.formatIso(item.completedAt);
  const live = useLiveConsult({
    environmentId: ctx.activeThreadEnvironmentId,
    askerThreadId: projectedItem.sourceThreadId,
    question,
    startedAt,
    completedAt,
  });
  const answer = (fetched ? turnItemOutputText(fetched) : null)?.trim() ?? "";
  const clamped = !showFullAnswer && answer.length > ANSWER_CLAMP_CHARS;
  const markdown = (body: string) => (
    <ChatMarkdown
      text={body}
      cwd={ctx.markdownCwd}
      threadRef={ctx.threadRef ?? undefined}
      skills={ctx.skills}
    />
  );

  return (
    <ConsultCardView
      status={status}
      targetLabel={target?.title ?? targetName ?? "another thread"}
      target={
        targetThreadId ? (
          <ThreadLinkChip
            label={target?.title ?? targetThreadId}
            threadId={targetThreadId}
            environmentId={ctx.activeThreadEnvironmentId}
          />
        ) : (
          <span className="text-muted-foreground/80 italic">«{targetName ?? "a thread"}»</span>
        )
      }
      question={question}
      startedAt={startedAt}
      completedAt={completedAt}
      live={live}
      expanded={expanded}
      onToggle={() => {
        if (expanded) EXPANDED.delete(projectedItem.sourceItemId);
        else EXPANDED.add(projectedItem.sourceItemId);
        setExpanded(!expanded);
      }}
      stopping={stopping}
      onStop={() => {
        if (live === null) return;
        setStopping(true);
        void cancel({
          environmentId: ctx.activeThreadEnvironmentId,
          input: { consultId: live.consultId },
        }).then((result) => {
          if (result._tag === "Failure") setStopping(false);
        });
      }}
      renderTranscript={(path) => markdown(`\`${path}\``)}
      body={
        status === "answered" && answer.length > 0 ? (
          <div>
            <div className={cn("relative overflow-hidden", clamped && "max-h-64")}>
              {markdown(answer)}
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
        ) : status === "waiting" ? null : (
          <p className="text-muted-foreground/80 text-xs leading-5 whitespace-pre-wrap">
            {answer || (detail.isPending ? "Loading…" : "No answer was returned.")}
          </p>
        )
      }
    />
  );
});

export type ConsultStatus = "waiting" | "answered" | "failed";

/**
 * The consult card's presentation, shared by the timeline row and the
 * `/preview` fixtures. `live` is the fork's figures when this session has
 * them; `body` is the answer, or the failure's reason, below them.
 */
export function ConsultCardView({
  status,
  target,
  targetLabel,
  question,
  startedAt,
  completedAt,
  live,
  expanded,
  onToggle,
  body,
  renderTranscript,
  onStop,
  stopping,
}: {
  readonly status: ConsultStatus;
  readonly target: ReactNode;
  readonly targetLabel: string;
  readonly question: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly live: LoomLiveConsult | null;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly body: ReactNode;
  readonly renderTranscript: (path: string) => ReactNode;
  readonly onStop: () => void;
  readonly stopping: boolean;
}) {
  const [showSteps, setShowSteps] = useState(false);
  // The fork is still working: the strip, the running log and Stop.
  const running = status === "waiting" && live !== null && live.endedAt === null;
  const earlier = live === null ? 0 : live.toolCalls - live.recent.length;
  const transcript = live?.forkSessionPath ? renderTranscript(live.forkSessionPath) : null;
  const log =
    live !== null && live.recent.length > 0 ? (
      <div className="flex flex-col gap-0.5 rounded-md bg-muted/40 px-2 py-1.5">
        {earlier > 0 ? (
          <div className="text-3xs text-muted-foreground/80">
            {earlier} earlier step{earlier === 1 ? "" : "s"}
          </div>
        ) : null}
        {live.recent.map((step) => (
          <ConsultStepRow key={`${step.startedAt}:${step.title}:${step.detail}`} step={step} />
        ))}
      </div>
    ) : null;

  return (
    <section
      className="-mx-1 min-w-0 px-1 py-0.5"
      aria-label={`Consult: ${targetLabel}, ${STATUS[status].label}`}
    >
      <div className="rounded-lg border border-info/25 bg-info/6" data-consult-card={status}>
        <div
          role="button"
          tabIndex={0}
          aria-expanded={expanded}
          onClick={onToggle}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onToggle();
          }}
          className="focus-visible:ring-ring/70 flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-xs leading-5 transition-colors hover:bg-info/10 focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
        >
          <MessageCircleQuestionMarkIcon className="size-3.5 shrink-0 text-info-foreground" />
          <span className="text-foreground/82 shrink-0">Consulted</span>
          {/* The chip navigates on click; the card must not also toggle. */}
          <span className="min-w-0 shrink-0" onClick={(event) => event.stopPropagation()}>
            {target}
          </span>
          {!expanded && question ? (
            <span className="text-muted-foreground/70 min-w-0 flex-1 truncate">({question})</span>
          ) : (
            <span className="flex-1" />
          )}
          {startedAt ? (
            <>
              {/* A long consult is normal: its total never turns amber, only a stuck step does. */}
              <span className="shrink-0 text-muted-foreground">
                <StepElapsed since={startedAt} until={completedAt} amber={false} />
              </span>
              <span aria-hidden className="shrink-0 text-muted-foreground/50">
                ·
              </span>
            </>
          ) : null}
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

        {running ? <ConsultLiveStrip live={live} /> : null}

        {expanded ? (
          <div className="space-y-2 border-t border-info/15 px-2.5 py-2">
            {question ? (
              <blockquote className="text-foreground/70 border-l-2 border-info/40 pl-2.5 text-xs leading-5 whitespace-pre-wrap">
                {question}
              </blockquote>
            ) : null}
            {live !== null ? <ConsultFacts live={live} running={running} /> : null}
            {running ? (
              <>
                {log}
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="min-w-0 flex-1 truncate text-xs">{transcript}</div>
                  <Button
                    size="compact"
                    variant="destructive-outline"
                    disabled={stopping}
                    onClick={onStop}
                  >
                    {stopping ? "Stopping…" : "Stop consult"}
                  </Button>
                </div>
              </>
            ) : status === "waiting" ? (
              <p className="text-muted-foreground/80 text-xs leading-5">Waiting for the answer.</p>
            ) : null}
            {status === "answered" && live !== null ? (
              <>
                <div className="flex min-w-0 items-center gap-2.5 text-2xs text-muted-foreground">
                  {log ? (
                    <button
                      type="button"
                      aria-expanded={showSteps}
                      className="shrink-0 hover:text-foreground focus-visible:underline focus-visible:outline-none"
                      onClick={() => setShowSteps((value) => !value)}
                    >
                      {showSteps ? "▾" : "▸"} {live.toolCalls} step{live.toolCalls === 1 ? "" : "s"}
                    </button>
                  ) : null}
                  <div className="min-w-0 flex-1 truncate text-xs">{transcript}</div>
                </div>
                {showSteps ? log : null}
              </>
            ) : null}
            {status === "failed" ? log : null}
            {body}
            {status === "failed" && transcript ? (
              <div className="min-w-0 truncate text-xs">{transcript}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/**
 * The running consult's second header line: the fork's step, its own duration
 * (amber past `LONG_STEP_MS`), tool count and cost; and the fork's last
 * sentence, only once it has said one.
 */
function ConsultLiveStrip({ live }: { readonly live: LoomLiveConsult }) {
  const cost = formatCostUsd(live.spend?.costUsd);
  return (
    <div className="space-y-0.5 pr-2.5 pb-1.5 pl-7 text-2xs leading-4 text-muted-foreground">
      <div className="flex min-w-0 items-center gap-2">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-info" />
        <span className="min-w-0 flex-1 truncate">
          {live.step === null ? (
            "starting"
          ) : (
            <>
              <strong className="font-medium text-foreground">
                {live.step.kind === "model" ? "thinking" : (live.step.title ?? "tool")}
              </strong>
              {live.step.detail ? ` · ${live.step.detail}` : null}
            </>
          )}
        </span>
        {live.step ? (
          <span className="shrink-0">
            <StepElapsed since={live.step.since} />
          </span>
        ) : null}
        <span aria-hidden className="shrink-0 opacity-45">
          │
        </span>
        <span className="shrink-0 tabular-nums">
          ⚒ {live.toolCalls}
          {cost ? ` · ${cost}` : null}
        </span>
      </div>
      {live.narration ? (
        <div className="truncate pl-3.5 text-muted-foreground/80 italic">“{live.narration}”</div>
      ) : null}
    </div>
  );
}

/** The fork's model, cost and tokens (and, finished, its tool count): the hover card's fact row. */
function ConsultFacts({
  live,
  running,
}: {
  readonly live: LoomLiveConsult;
  readonly running: boolean;
}) {
  const cost = formatCostUsd(live.spend?.costUsd);
  const spend = live.spend;
  const bar = (
    <span aria-hidden className="shrink-0 opacity-45">
      │
    </span>
  );
  return (
    <div className="flex min-w-0 items-center gap-2 text-2xs leading-4 text-muted-foreground">
      {live.model ? (
        <span className="min-w-0 shrink">
          <WorkstreamModelPill selection={{ instanceId: PI_INSTANCE, model: live.model }} />
        </span>
      ) : null}
      {running ? null : (
        <>
          <span className="shrink-0 tabular-nums">⚒ {live.toolCalls}</span>
          {cost || spend ? bar : null}
        </>
      )}
      {cost ? <span className="shrink-0 text-foreground/80 tabular-nums">{cost}</span> : null}
      {spend && spend.inputTokens + spend.outputTokens + spend.cachedTokens > 0 ? (
        <>
          {cost ? bar : null}
          <span className="min-w-0 truncate tabular-nums">
            {`${formatTokens(spend.inputTokens)} in · ${formatTokens(spend.outputTokens)} out · ${formatTokens(spend.cachedTokens)} cached`}
          </span>
        </>
      ) : null}
    </div>
  );
}

/** `✓ 1.4s  read  path`: the live row ticks; a cut-short or failed one is marked. */
function ConsultStepRow({ step }: { readonly step: LoomConsultStep }) {
  const ms = step.endedAt === null ? 0 : Date.parse(step.endedAt) - Date.parse(step.startedAt);
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 text-2xs leading-4",
        step.ok === true ? "text-muted-foreground" : "text-foreground/90",
      )}
    >
      <span
        className={cn(
          "w-16 shrink-0 tabular-nums",
          step.ok === null
            ? "text-info-foreground"
            : step.ok
              ? "text-success-foreground"
              : "text-warning-foreground",
        )}
      >
        {step.endedAt === null ? (
          <>
            ● <StepElapsed since={step.startedAt} />
          </>
        ) : (
          `${step.ok ? "✓" : "✗"} ${ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms)}`
        )}
      </span>
      <strong className="w-12 shrink-0 truncate font-medium text-foreground">{step.title}</strong>
      <span className="min-w-0 truncate">{step.detail}</span>
    </div>
  );
}

/**
 * The cards open this session, by item id. The timeline's virtual list
 * remounts rows as the turn around them changes (upstream lifts its own
 * disclosures out of the rows for the same reason), and a running consult's
 * card is open precisely to be watched.
 */
const EXPANDED = new Set<string>();

/** Consult forks are pi; the pill reads the provider from the `provider/id` slug. */
const PI_INSTANCE = ProviderInstanceId.make("pi");

/** Answers past this length get a clamped body with an explicit expand. */
const ANSWER_CLAMP_CHARS = 600;

const STATUS = {
  waiting: { label: "waiting", tone: "text-warning-foreground/80" },
  answered: { label: "answered", tone: "text-info-foreground/80" },
  failed: { label: "failed", tone: "text-destructive-foreground/80" },
} as const;
