// loom: a collapsed tool group's header figure (plan §4): the group's total as a stacked hairline
// and `largest 26.4K move1.py`, from the group's own native ids.
import type { LoomContextItem } from "@t3tools/contracts";

import { cn } from "../../../lib/utils";
import { formatContextTokens, formatItemTokens } from "../format";
import {
  CardLine,
  FigureCard,
  FigureCell,
  segmentOf,
  useFigures,
  useTimelineFigureKey,
} from "./RowFigure";
import { byCategory, CATEGORY_LABEL } from "./timelineFigures";

export function GroupFigure({ nativeIds }: { readonly nativeIds: ReadonlyArray<string> }) {
  const key = useTimelineFigureKey();
  return key && nativeIds.length > 0 ? (
    <GroupFigureOn figureKey={key} nativeIds={nativeIds} />
  ) : null;
}

function GroupFigureOn({
  figureKey,
  nativeIds,
}: {
  readonly figureKey: string;
  readonly nativeIds: ReadonlyArray<string>;
}) {
  const figures = useFigures(figureKey, (current) => current);
  const items = figures
    ? nativeIds.flatMap((id) => figures.join.byNativeId.get(id) ?? [])
    : ([] as LoomContextItem[]);
  if (!figures || items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.tokens, 0);
  const largest = items.reduce((top, item) => (item.tokens > top.tokens ? item : top));
  const largestAmber = figures.amber.has(largest.id);
  return (
    <>
      {items.length > 1 ? (
        <span className="min-w-0 max-w-48 truncate text-xs text-muted-foreground">
          · largest{" "}
          <span className={cn("tabular-nums", largestAmber && "text-warning-foreground")}>
            {formatItemTokens(largest)}
          </span>{" "}
          {largest.label}
        </span>
      ) : null}
      <FigureCell
        className="me-7"
        text={`+${items.some((item) => !item.measured) ? "≈" : ""}${formatContextTokens(total)}`}
        amber={false}
        strong
        segments={items.map((item) => segmentOf(item, figures.amber.has(item.id)))}
        max={figures.join.maxItemTokens}
        card={
          <FigureCard title={`${items.length} rows added ${total.toLocaleString()} tokens`}>
            {byCategory(items).map(([category, sum]) => (
              <CardLine key={category} label={CATEGORY_LABEL[category]}>
                {formatContextTokens(sum.tokens)}
                <span className="text-muted-foreground"> · {sum.count}</span>
              </CardLine>
            ))}
            <CardLine label="Largest">
              {formatItemTokens(largest)} {largest.label}
            </CardLine>
          </FigureCard>
        }
      />
    </>
  );
}
