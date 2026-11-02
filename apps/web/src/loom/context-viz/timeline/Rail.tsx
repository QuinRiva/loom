// loom: the context rail (plan §4): the window as one vertical stacked bar in session order, each
// item's height its share, amber where its row is amber, the turn being read outlined. Click jumps
// to the row; hover names it. Hidden below 1,100 px of timeline width by a container query.
import type { LoomContextItem, LoomContextReport, RunId } from "@t3tools/contracts";

import { useState } from "react";

import { cn } from "../../../lib/utils";
import { formatContextTokens, formatItemTokens } from "../format";
import {
  AMBER_BAR,
  byCategory,
  CATEGORY_BAR,
  jumpToItem,
  type TimelineFigures,
} from "./timelineFigures";

/**
 * Neighbours under this share of the window merge into one segment (about 2 px on a 600 px rail),
 * coloured by the category that holds most of its tokens; amber items always stand alone.
 */
const MERGE_SHARE = 0.004;

interface RailSegment {
  readonly items: ReadonlyArray<LoomContextItem>;
  readonly tokens: number;
  readonly amber: boolean;
}

interface RailLayout {
  readonly total: number;
  readonly segments: ReadonlyArray<
    RailSegment & { readonly className: string; readonly start: number }
  >;
  /** Each item's [start, end) in tokens from the top. */
  readonly span: ReadonlyMap<string, readonly [number, number]>;
}

const layouts = new WeakMap<ReadonlySet<string>, RailLayout>();

function railLayout(report: LoomContextReport, amber: ReadonlySet<string>): RailLayout {
  const cached = layouts.get(amber);
  if (cached) return cached;
  const items = report.items.filter((item) => item.inWindow && item.tokens > 0);
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  const segments: Array<RailSegment> = [];
  const span = new Map<string, readonly [number, number]>();
  let at = 0;
  for (const item of items) {
    span.set(item.id, [at, at + item.tokens]);
    at += item.tokens;
    const amberItem = amber.has(item.id);
    const last = segments.at(-1);
    const small = !amberItem && item.tokens < total * MERGE_SHARE;
    if (small && last && !last.amber && last.tokens < total * MERGE_SHARE) {
      segments[segments.length - 1] = {
        items: [...last.items, item],
        tokens: last.tokens + item.tokens,
        amber: false,
      };
    } else {
      segments.push({ items: [item], tokens: item.tokens, amber: amberItem });
    }
  }
  const layout = {
    total,
    span,
    segments: segments.map((segment) => ({
      ...segment,
      start: span.get(segment.items[0]!.id)![0],
      className: segment.amber
        ? AMBER_BAR
        : CATEGORY_BAR[
            byCategory(segment.items).toSorted((a, b) => b[1].tokens - a[1].tokens)[0]![0]
          ],
    })),
  };
  layouts.set(amber, layout);
  return layout;
}

function segmentTitle(segment: RailSegment): string {
  const [first] = segment.items;
  return segment.items.length === 1 && first
    ? `${formatItemTokens(first)} · ${first.label}`
    : `${segment.items.length} small items · ${formatContextTokens(segment.tokens)}`;
}

type LaidSegment = RailLayout["segments"][number];

function RailBars({
  figureKey,
  layout,
  onHover,
}: {
  readonly figureKey: string;
  readonly layout: RailLayout;
  readonly onHover: (segment: LaidSegment | null) => void;
}) {
  return (
    <>
      {layout.segments.map((segment) => {
        const heaviest = segment.items.reduce((top, item) =>
          item.tokens > top.tokens ? item : top,
        );
        return (
          <button
            key={segment.items[0]!.id}
            type="button"
            aria-label={segmentTitle(segment)}
            className={cn("min-h-px w-full cursor-pointer hover:brightness-125", segment.className)}
            style={{ flexGrow: segment.tokens, flexBasis: 0 }}
            onPointerEnter={() => onHover(segment)}
            onClick={() => jumpToItem(figureKey, heaviest.id)}
          />
        );
      })}
    </>
  );
}

export function Rail({
  figureKey,
  report,
  figures,
  currentRunId,
}: {
  readonly figureKey: string;
  readonly report: LoomContextReport;
  readonly figures: TimelineFigures;
  /** The turn being read, from the minimap's current prompt; null draws no outline. */
  readonly currentRunId: RunId | null;
}) {
  const layout = railLayout(report, figures.amber);
  const [hovered, setHovered] = useState<LaidSegment | null>(null);
  if (layout.total === 0) return null;
  const spans = (
    currentRunId === null ? [] : (figures.join.runs.get(currentRunId)?.items ?? [])
  ).flatMap((item) => {
    const span = layout.span.get(item.id);
    return span ? [span] : [];
  });
  const top = Math.min(...spans.map(([start]) => start));
  const bottom = Math.max(...spans.map(([, end]) => end));
  return (
    <div className="pointer-events-none absolute inset-0 z-30 @container/context-rail">
      <div
        className="pointer-events-auto absolute top-6 bottom-6 hidden w-5 flex-col overflow-hidden rounded-sm bg-muted/40 @min-[1100px]/context-rail:flex"
        style={{ insetInlineEnd: "calc(var(--chat-lane-inset-end, 0px) + 1.25rem)" }}
        role="group"
        aria-label={`Context window, ${formatContextTokens(layout.total)} in session order`}
        onPointerLeave={() => setHovered(null)}
      >
        <RailBars figureKey={figureKey} layout={layout} onHover={setHovered} />
        {spans.length > 0 ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 rounded-xs ring-1 ring-foreground/70"
            style={{
              top: `${(top / layout.total) * 100}%`,
              height: `max(2px, ${((bottom - top) / layout.total) * 100}%)`,
            }}
          />
        ) : null}
      </div>
      {hovered && layout.segments.includes(hovered) ? (
        <span
          aria-hidden
          className="pointer-events-none absolute z-10 max-w-72 -translate-y-1/2 truncate rounded-md border bg-popover px-1.5 py-0.5 text-xs text-popover-foreground shadow-md/5"
          style={{
            insetInlineEnd: "calc(var(--chat-lane-inset-end, 0px) + 2.75rem)",
            top: `calc(1.5rem + (100% - 3rem) * ${(hovered.start + hovered.tokens / 2) / layout.total})`,
          }}
        >
          {segmentTitle(hovered)}
        </span>
      ) : null}
    </div>
  );
}
