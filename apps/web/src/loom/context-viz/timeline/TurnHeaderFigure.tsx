// loom: the "Worked for" header's figure (plan §4): the window at the turn's start and end, what it
// added and its share of the window, and a Heaviest menu that jumps to the turn's largest rows.
import type { RunId } from "@t3tools/contracts";
import { ChevronDownIcon } from "lucide-react";

import { Button } from "../../../components/ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../../../components/ui/menu";
import { cn } from "../../../lib/utils";
import { formatCostUsd } from "../../costFormat";
import { formatContextTokens, formatItemTokens, formatShare } from "../format";
import {
  CardLine,
  FigureCard,
  FigureCell,
  segmentOf,
  useFigures,
  useTimelineFigureKey,
} from "./RowFigure";
import { byCategory, CATEGORY_LABEL, CATEGORY_OF, jumpToItem } from "./timelineFigures";

const HEAVIEST = 5;

export function TurnHeaderFigure({
  runId,
  defaultMenuOpen,
}: {
  readonly runId: RunId;
  /** The preview's open-menu fixture only. */
  readonly defaultMenuOpen?: boolean;
}) {
  const key = useTimelineFigureKey();
  return key ? (
    <TurnHeaderFigureOn figureKey={key} runId={runId} defaultMenuOpen={defaultMenuOpen} />
  ) : null;
}

function TurnHeaderFigureOn({
  figureKey,
  runId,
  defaultMenuOpen,
}: {
  readonly figureKey: string;
  readonly runId: RunId;
  readonly defaultMenuOpen: boolean | undefined;
}) {
  const figures = useFigures(figureKey, (current) => current);
  const run = figures?.join.runs.get(runId);
  if (!figures || !run) return null;
  const heaviest = run.items.filter((item) => item.tokens > 0).slice(0, HEAVIEST);
  const heaviestTokens = heaviest.reduce((sum, item) => sum + item.tokens, 0);
  const share = formatShare(run.endCtx, figures.contextWindow);
  // Tool-call arguments and withheld prose have no row; their tokens are the rest of the turn.
  const rest = run.addedTokens - run.items.reduce((sum, item) => sum + item.tokens, 0);
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      {heaviest.length > 0 ? (
        <Menu {...(defaultMenuOpen ? { defaultOpen: true } : {})}>
          <MenuTrigger render={<Button size="xs" variant="outline" />}>
            Heaviest
            <ChevronDownIcon />
          </MenuTrigger>
          <MenuPopup align="start" className="max-w-[30rem]">
            <MenuGroup>
              <MenuGroupLabel>
                Heaviest in this turn · these {heaviest.length} are{" "}
                {formatShare(heaviestTokens, run.addedTokens) ?? "most"} of its +
                {formatContextTokens(run.addedTokens)}
              </MenuGroupLabel>
              {heaviest.map((item) => (
                <MenuItem key={item.id} onClick={() => jumpToItem(figureKey, item.id)}>
                  <span
                    className={cn(
                      "w-12 shrink-0 text-right tabular-nums",
                      figures.amber.has(item.id)
                        ? "text-warning-foreground"
                        : "text-muted-foreground",
                    )}
                  >
                    {formatItemTokens(item)}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {item.tool?.replace(/^mcp__.+?__/, "") ??
                      CATEGORY_LABEL[CATEGORY_OF[item.kind]]}
                  </span>
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      ) : null}
      <span className="ms-auto truncate text-xs text-muted-foreground tabular-nums">
        {formatContextTokens(run.startCtx)} →{" "}
        <span className="text-foreground/80">{formatContextTokens(run.endCtx)}</span>
        {share && figures.contextWindow
          ? ` · ${share} of ${formatContextTokens(figures.contextWindow)}`
          : ""}
      </span>
      <FigureCell
        className="me-7"
        text={`+${formatContextTokens(run.addedTokens)}`}
        amber={false}
        strong
        segments={run.items.map((item) => segmentOf(item, figures.amber.has(item.id)))}
        max={figures.join.maxItemTokens}
        card={
          <FigureCard title={`This turn added ${run.addedTokens.toLocaleString()} tokens`}>
            <CardLine label="Window">
              {run.startCtx.toLocaleString()} → {run.endCtx.toLocaleString()}
            </CardLine>
            <CardLine label="Calls">
              {run.calls.length}
              {formatCostUsd(run.costUsd) ? ` · ${formatCostUsd(run.costUsd)}` : ""}
            </CardLine>
            {byCategory(run.items).map(([category, sum]) => (
              <CardLine key={category} label={CATEGORY_LABEL[category]}>
                {formatContextTokens(sum.tokens)}
              </CardLine>
            ))}
            {rest > 0 ? (
              <CardLine label="Arguments, other">≈{formatContextTokens(rest)}</CardLine>
            ) : null}
          </FigureCard>
        }
      />
    </span>
  );
}
