// loom: a timeline row's context figure (plan §4): what the row added to the window, on one linear
// scale per session, amber when large for its turn, with the whole-file chip and a hover card.
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LoomContextItem } from "@t3tools/contracts";
import { type ReactNode, use } from "react";

import { TimelineRowCtx } from "../../../components/chat/timelineRowContext";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { useClientSettings } from "../../../hooks/useSettings";
import { cn } from "../../../lib/utils";
import { formatCostUsd } from "../../costFormat";
import { formatContextTokens, formatItemTokens, formatShare } from "../format";
import {
  AMBER_BAR,
  CATEGORY_BAR,
  CATEGORY_LABEL,
  CATEGORY_OF,
  type TimelineFigures,
  useTimelineFigureStore,
} from "./timelineFigures";

const BAR_PX = 64;

/** The row's thread key while the Timeline switch is on; null renders nothing and reads nothing. */
export function useTimelineFigureKey(): string | null {
  const on = useClientSettings((settings) => settings.contextVizTimeline);
  const { threadRef } = use(TimelineRowCtx);
  return on && threadRef ? scopedThreadKey(threadRef) : null;
}

export function useFigures<T>(key: string, select: (figures: TimelineFigures) => T): T | null {
  return useTimelineFigureStore((state) => {
    const figures = state.byThreadKey[key];
    return figures ? select(figures) : null;
  });
}

export interface FigureSegment {
  readonly id: string;
  readonly tokens: number;
  readonly className: string;
}

export const segmentOf = (item: LoomContextItem, amber: boolean): FigureSegment => ({
  id: item.id,
  tokens: item.tokens,
  className: amber ? AMBER_BAR : CATEGORY_BAR[CATEGORY_OF[item.kind]],
});

/** The margin cell: `+8.8K` and its hairline bar, a hover card on both. */
export function FigureCell(props: {
  readonly text: string;
  readonly amber: boolean;
  readonly segments: ReadonlyArray<FigureSegment>;
  readonly max: number;
  readonly card: ReactNode;
  readonly strong?: boolean;
  readonly className?: string;
}) {
  const widths = props.segments
    .filter((segment) => segment.tokens > 0)
    .map((segment) => ({
      segment,
      width: Math.max(1, (segment.tokens / Math.max(props.max, 1)) * BAR_PX),
    }));
  // Segments past the bar's end are dropped; the last one shown is cut to fit.
  const bars = widths.flatMap(({ segment, width }, index) => {
    const start = widths.slice(0, index).reduce((sum, previous) => sum + previous.width, 0);
    return start < BAR_PX ? [{ ...segment, width: Math.min(width, BAR_PX - start) }] : [];
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn("flex shrink-0 items-center gap-1.5", props.className)}
            data-context-figure=""
            onClick={(event) => event.stopPropagation()}
          />
        }
      >
        <span
          className={cn(
            "w-14 text-right text-xs tabular-nums",
            props.amber
              ? "font-medium text-warning-foreground"
              : props.strong
                ? "text-foreground/80"
                : "text-muted-foreground",
          )}
        >
          {props.text}
        </span>
        <span className="flex h-1 shrink-0 gap-px overflow-hidden" style={{ width: BAR_PX }}>
          {bars.map((bar) => (
            <span
              key={bar.id}
              className={cn("h-full shrink-0", bar.className)}
              style={{ width: bar.width }}
            />
          ))}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="left" className="max-w-80">
        {props.card}
      </TooltipPopup>
    </Tooltip>
  );
}

export function CardLine({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 tabular-nums">{children}</dd>
    </>
  );
}

export function FigureCard({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 p-1">
      <p className="truncate font-medium text-foreground">{title}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">{children}</dl>
    </div>
  );
}

function ItemCard({
  figureKey,
  item,
}: {
  readonly figureKey: string;
  readonly item: LoomContextItem;
}) {
  const run = useFigures(figureKey, (figures) => {
    const runId = figures.runOfItem.get(item.id);
    return runId === undefined ? undefined : figures.join.runs.get(runId);
  });
  const cost = formatCostUsd(item.costToKeepUsd);
  return (
    <FigureCard title={item.label}>
      <CardLine label={CATEGORY_LABEL[CATEGORY_OF[item.kind]]}>
        {item.tokens.toLocaleString()} tokens{" "}
        <span className="text-muted-foreground">
          {item.measured ? "exact" : "estimate, split by characters"}
        </span>
      </CardLine>
      <CardLine label="Size">
        {item.chars.toLocaleString()} characters
        {item.tokens > 0 && item.chars > 0
          ? ` · ${(item.chars / item.tokens).toFixed(1)} per token`
          : ""}
        {item.images > 0 ? ` · ${item.images} image${item.images === 1 ? "" : "s"}` : ""}
      </CardLine>
      {run && run.addedTokens > 0 ? (
        <CardLine label="Of its turn">
          {formatShare(item.tokens, run.addedTokens)} of +{formatContextTokens(run.addedTokens)}
        </CardLine>
      ) : null}
      <CardLine label="Re-sent">
        on {Math.max(0, item.carriedCalls - 1).toLocaleString()} later calls
        {cost ? ` · ${cost} to keep so far` : ""}
      </CardLine>
      {item.wholeFile ? (
        <CardLine label="Read">the whole file, with no offset or limit</CardLine>
      ) : null}
      {item.isError ? <CardLine label="Result">the tool call failed</CardLine> : null}
    </FigureCard>
  );
}

/**
 * A tool, thinking or assistant row by `nativeId`, or the message that opens a turn by
 * `userMessageId`. Nothing when the Timeline switch is off or the join has no figure for it.
 */
export function RowFigure(props: {
  readonly nativeId?: string | null | undefined;
  readonly userMessageId?: string | undefined;
  readonly className?: string;
}) {
  const key = useTimelineFigureKey();
  return key && (props.nativeId || props.userMessageId) ? (
    <RowFigureOn figureKey={key} {...props} />
  ) : null;
}

function RowFigureOn({
  figureKey,
  nativeId,
  userMessageId,
  className,
}: {
  readonly figureKey: string;
  readonly nativeId?: string | null | undefined;
  readonly userMessageId?: string | undefined;
  readonly className?: string | undefined;
}) {
  const item = useFigures(figureKey, (figures) =>
    nativeId
      ? figures.join.byNativeId.get(nativeId)
      : figures.join.byUserMessageId.get(userMessageId!),
  );
  const amber =
    useFigures(figureKey, (figures) => (item ? figures.amber.has(item.id) : false)) ?? false;
  const max = useFigures(figureKey, (figures) => figures.join.maxItemTokens) ?? 0;
  if (!item) return null;
  return (
    <span className={cn("flex shrink-0 items-center gap-1.5", className)}>
      {item.wholeFile ? (
        <span className="shrink-0 rounded border border-warning/30 bg-warning/10 px-1.5 text-3xs text-warning-foreground">
          whole file · {Math.max(1, Math.round(item.chars / 1_000))} KB, no cap
        </span>
      ) : null}
      <FigureCell
        text={`+${formatItemTokens(item)}`}
        amber={amber}
        segments={[segmentOf(item, amber)]}
        max={max}
        card={<ItemCard figureKey={figureKey} item={item} />}
      />
    </span>
  );
}
