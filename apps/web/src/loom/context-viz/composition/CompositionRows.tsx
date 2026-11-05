// loom: the composition's rows: the category → tool → item tree, the largest items, the cache on the
// latest call and what could be reclaimed. Every figure follows the In window | Cost to keep lens.
import type { LoomContextFinding, LoomContextItem, LoomContextReport } from "@t3tools/contracts";
import type { CSSProperties, ReactElement, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/utils";
import { formatContextTokens } from "../format";
import { type CachePrices, coldCacheUsd, formatUsd, pruneTradeoff } from "./costLens";
import {
  COLORS,
  type Lens,
  type Node,
  type RepeatGroup,
  itemCost,
  itemLabel,
  shortTool,
  value,
} from "./model";

export const HATCH: CSSProperties = {
  backgroundImage: "repeating-linear-gradient(135deg, rgba(0,0,0,.42) 0 2px, transparent 2px 5px)",
};

/** What the rows share: the lens, the whole they are a share of, hover, and the way to the chat. */
export interface RowContext {
  readonly lens: Lens;
  /** The lens's whole: tokens in the window, or their cost to keep. */
  readonly total: number;
  /** Tokens in the window, for the hover's share. */
  readonly used: number;
  readonly turnOf: (item: LoomContextItem) => number | null;
  readonly onJump: (item: LoomContextItem) => void;
  readonly lit: string | null;
  readonly calledByTool: ReadonlyMap<string, number>;
  readonly onLit: (id: string | null) => void;
}

const KIND_COLOR: Record<LoomContextItem["kind"], string> = {
  tool_result: COLORS.tools,
  tool_call_args: COLORS.args,
  user_message: COLORS.msgs,
  assistant_thinking: COLORS.think,
  assistant_text: COLORS.text,
  system_section: COLORS.fixed,
  tool_schema: COLORS.defs,
  compaction_base: COLORS.compaction,
};

const kindLabel = (item: LoomContextItem) =>
  item.kind === "tool_result"
    ? shortTool(item.tool ?? "tool")
    : item.kind === "tool_call_args"
      ? `${shortTool(item.tool ?? "tool")} args`
      : {
          system_section: "system prompt",
          tool_schema: "tool schema",
          user_message: "message",
          assistant_thinking: "thinking",
          assistant_text: "reply",
          compaction_base: "compaction",
        }[item.kind];

export const formatValue = (amount: number, lens: Lens) =>
  lens === "tokens" ? formatContextTokens(amount) : formatUsd(amount);

export function formatPct(part: number, total: number) {
  const pct = total > 0 ? (100 * part) / total : 0;
  return pct >= 10 ? `${Math.round(pct)}%` : pct >= 0.1 ? `${pct.toFixed(1)}%` : "<0.1%";
}

const Est = () => <span className="mr-px text-3xs text-warning-foreground">≈</span>;

export const Swatch = ({ color, hatch }: { color: string; hatch?: boolean }) => (
  <span
    className="inline-block size-2.5 shrink-0 rounded-xs"
    style={{ background: color, ...(hatch ? HATCH : {}) }}
  />
);

function Tip({ tip, children }: { tip: ReactNode; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup side="left" className="max-w-80">
        {tip}
      </TooltipPopup>
    </Tooltip>
  );
}

function TipBody({
  title,
  tokens,
  used,
  count,
  measured,
  cost,
  reads,
  turn,
}: {
  title: string;
  tokens: number;
  used: number;
  count: number;
  measured: boolean;
  cost: number;
  reads: number | null;
  turn: number | null;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="font-medium break-words text-foreground">{title}</div>
      <div>
        {tokens.toLocaleString()} tokens · {formatPct(tokens, used)} of the window
        {count > 1 ? ` · ${count} items` : ""}
      </div>
      <div className="text-muted-foreground">
        {measured ? (
          count > 1 ? (
            "sum of measured items"
          ) : (
            "measured exactly"
          )
        ) : (
          <>
            <Est />
            {count > 1 ? "includes estimated splits" : "estimated split of an exact total"}
          </>
        )}
      </div>
      <div className="text-muted-foreground">
        Cost to keep so far {formatUsd(cost)}:{" "}
        {reads === null
          ? "one cache write each, plus every later cache read"
          : `written to cache once, then re-read on ${reads.toLocaleString()} later calls`}
      </div>
      {turn !== null ? (
        <div className="text-muted-foreground">Turn {turn} · click to open it in the chat</div>
      ) : null}
    </div>
  );
}

function itemTip(item: LoomContextItem, title: string, used: number, turn: number | null) {
  return (
    <TipBody
      title={title}
      tokens={item.tokens}
      used={used}
      count={1}
      measured={item.measured}
      cost={itemCost(item)}
      reads={Math.max(0, item.carriedCalls - 1)}
      turn={turn}
    />
  );
}

export const nodeTip = (node: Node, title: string, used: number) => (
  <TipBody
    title={title}
    tokens={node.tokens}
    used={used}
    count={node.items.length}
    measured={node.measured}
    cost={node.cost}
    reads={null}
    turn={null}
  />
);

function Figure({ amount, measured, lens }: { amount: number; measured: boolean; lens: Lens }) {
  return (
    <span className="text-right text-xs text-foreground/85 tabular-nums">
      {measured ? null : <Est />}
      {formatValue(amount, lens)}
    </span>
  );
}

const Pct = ({ children }: { children: ReactNode }) => (
  <span className="text-right text-2xs text-muted-foreground tabular-nums">{children}</span>
);

const LEAF_LIMIT = 5;

/**
 * One level of the tree: each node's row, its note, and when open its sub-rows or its items (the
 * five largest, then "+ N more").
 */
export function TreeRows({
  nodes,
  level,
  parentValue,
  crumb,
  ctx,
  open,
  onToggle,
}: {
  nodes: ReadonlyArray<Node>;
  level: number;
  parentValue: number;
  crumb: string;
  ctx: RowContext;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const sorted = [...nodes].sort(
    (a, b) =>
      Number(a.id.endsWith("/other")) - Number(b.id.endsWith("/other")) ||
      value(b, ctx.lens) - value(a, ctx.lens),
  );
  return sorted.map((node) => {
    const nodeValue = value(node, ctx.lens);
    const canOpen = (node.children?.length ?? 0) > 0 || (node.leaves && node.items.length > 0);
    const isOpen = canOpen && open.has(node.id);
    const title = crumb ? `${crumb} › ${node.label}` : node.label;
    const note = node.note;
    return (
      <div key={node.id}>
        <Tip tip={nodeTip(node, title, ctx.used)}>
          <div
            role={canOpen ? "button" : undefined}
            aria-expanded={canOpen ? isOpen : undefined}
            className={cn(
              "grid min-h-[25px] grid-cols-[14px_minmax(0,1fr)_84px_54px_36px] items-center gap-1.5 rounded-md pr-1.5 hover:bg-accent",
              canOpen && "cursor-pointer",
              ctx.lit === node.id && "bg-accent",
            )}
            style={{ paddingLeft: 6 + (level - 1) * 14 }}
            onMouseEnter={() => ctx.onLit(node.id)}
            onMouseLeave={() => ctx.onLit(null)}
            onClick={canOpen ? () => onToggle(node.id) : undefined}
          >
            <span
              className={cn("text-center text-3xs text-muted-foreground", isOpen && "rotate-90")}
            >
              {canOpen ? "▶" : ""}
            </span>
            <span className="flex min-w-0 items-center gap-1.5">
              <Swatch color={node.color} hatch={node.hatch} />
              <span
                className={cn(
                  "truncate text-xs",
                  level === 1 ? "font-medium text-foreground" : "text-foreground/85",
                )}
              >
                {node.label}
              </span>
              {node.items.length > 1 && canOpen ? (
                <span className="text-2xs whitespace-nowrap text-muted-foreground">
                  ×{node.items.length}
                </span>
              ) : null}
            </span>
            <span className="h-1.5 overflow-hidden rounded-full bg-muted">
              <i
                className="block h-full rounded-full"
                style={{
                  width: `${Math.max(0.6, parentValue > 0 ? (100 * nodeValue) / parentValue : 0)}%`,
                  background: node.color,
                }}
              />
            </span>
            <Figure amount={nodeValue} measured={node.measured} lens={ctx.lens} />
            <Pct>{formatPct(nodeValue, ctx.total)}</Pct>
          </div>
        </Tip>
        {note ? (
          <div
            className="pr-1.5 pb-1 text-2xs leading-snug text-muted-foreground"
            style={{ paddingLeft: 6 + (level - 1) * 14 + 35 }}
          >
            {note}
          </div>
        ) : null}
        {isOpen && node.children ? (
          <TreeRows
            nodes={node.children}
            level={level + 1}
            parentValue={nodeValue}
            crumb={title}
            ctx={ctx}
            open={open}
            onToggle={onToggle}
          />
        ) : null}
        {isOpen && !node.children ? (
          <LeafRows
            node={node}
            level={level + 1}
            crumb={title}
            ctx={ctx}
            all={open.has(`${node.id}#all`)}
            onToggleAll={() => onToggle(`${node.id}#all`)}
          />
        ) : null}
      </div>
    );
  });
}

function LeafRows({
  node,
  level,
  crumb,
  ctx,
  all,
  onToggleAll,
}: {
  node: Node;
  level: number;
  crumb: string;
  ctx: RowContext;
  all: boolean;
  onToggleAll: () => void;
}) {
  const leaves = [...node.items].sort(
    (a, b) =>
      (ctx.lens === "tokens" ? b.tokens - a.tokens : itemCost(b) - itemCost(a)) ||
      a.firstSeenCall - b.firstSeenCall,
  );
  const shown = all ? leaves : leaves.slice(0, LEAF_LIMIT);
  const rest = leaves.slice(LEAF_LIMIT);
  const restValue = rest.reduce(
    (sum, item) => sum + (ctx.lens === "tokens" ? item.tokens : itemCost(item)),
    0,
  );
  const grid =
    "grid min-h-[23px] grid-cols-[minmax(0,1fr)_32px_54px_36px] items-center gap-1.5 rounded-md pr-1.5";
  const indent = { paddingLeft: 6 + (level - 1) * 14 };
  return (
    <>
      {shown.map((item) => {
        const turn = item.kind === "tool_schema" ? null : ctx.turnOf(item);
        const jumps = item.kind !== "tool_schema" && item.kind !== "system_section";
        const amount = ctx.lens === "tokens" ? item.tokens : itemCost(item);
        return (
          <Tip key={item.id} tip={itemTip(item, `${crumb} › ${itemLabel(item)}`, ctx.used, turn)}>
            <div
              role={jumps ? "button" : undefined}
              className={cn(grid, "hover:bg-accent", jumps && "cursor-pointer")}
              style={indent}
              onClick={jumps ? () => ctx.onJump(item) : undefined}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="truncate font-mono text-2xs text-muted-foreground">
                  {itemLabel(item)}
                </span>
                {item.kind === "tool_schema" ? (
                  <Tag tone="muted">
                    {ctx.calledByTool.get(item.label)
                      ? `called ×${ctx.calledByTool.get(item.label)}`
                      : "never called"}
                  </Tag>
                ) : null}
              </span>
              <span className="text-right text-3xs text-muted-foreground tabular-nums">
                {turn === null ? "" : `T${turn}`}
              </span>
              <Figure amount={amount} measured={item.measured} lens={ctx.lens} />
              <Pct>{formatPct(amount, ctx.total)}</Pct>
            </div>
          </Tip>
        );
      })}
      {rest.length > 0 ? (
        <div
          role="button"
          className={cn(grid, "cursor-pointer hover:bg-accent")}
          style={indent}
          onClick={onToggleAll}
        >
          <span className="text-2xs text-muted-foreground">
            {all ? "Show fewer" : `+ ${rest.length} more`}
          </span>
          <span />
          <span className="text-right text-xs text-muted-foreground tabular-nums">
            {all ? "" : formatValue(restValue, ctx.lens)}
          </span>
          <Pct>{all ? "" : formatPct(restValue, ctx.total)}</Pct>
        </div>
      ) : null}
    </>
  );
}

function Tag({ tone, children }: { tone: "loom" | "guide" | "muted"; children: ReactNode }) {
  return (
    <span
      className={cn(
        "rounded border px-1.5 text-3xs leading-4 whitespace-nowrap",
        tone === "loom" && "border-warning/35 bg-warning/8 text-warning-foreground",
        tone === "guide" && "border-info/35 bg-info/8 text-info-foreground",
        tone === "muted" && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

type Largest =
  | { readonly kind: "item"; readonly item: LoomContextItem }
  | { readonly kind: "group"; readonly group: RepeatGroup };

/** The fifteen largest items, or with `groups` each group of repeats as one row. */
export function LargestRows({
  window,
  groups,
  ctx,
}: {
  window: ReadonlyArray<LoomContextItem>;
  groups: ReadonlyArray<RepeatGroup> | null;
  ctx: RowContext;
}) {
  const grouped = new Set(groups?.flatMap((group) => group.items.map((item) => item.id)));
  const amount = (row: Largest) =>
    row.kind === "group"
      ? value(row.group, ctx.lens)
      : ctx.lens === "tokens"
        ? row.item.tokens
        : itemCost(row.item);
  const rows: Largest[] = [
    ...(groups ?? []).map((group) => ({ kind: "group" as const, group })),
    ...window
      .filter((item) => !grouped.has(item.id) && item.kind !== "tool_schema")
      .map((item) => ({ kind: "item" as const, item })),
  ]
    .sort((a, b) => amount(b) - amount(a))
    .slice(0, 15);
  return rows.map((row, index) => {
    const item = row.kind === "group" ? row.group.latest : row.item;
    const turn = ctx.turnOf(item);
    const jumps = item.kind !== "system_section";
    const firstTurn =
      row.kind === "group"
        ? Math.min(...row.group.items.map((member) => ctx.turnOf(member) ?? Infinity))
        : null;
    const span =
      row.kind === "group" && turn !== null && Number.isFinite(firstTurn)
        ? `T${firstTurn}–T${turn}`
        : turn !== null
          ? `T${turn}`
          : item.kind === "system_section"
            ? "fixed"
            : "";
    const tip =
      row.kind === "group" ? (
        <div className="flex flex-col gap-0.5">
          <div className="font-medium text-foreground">
            {row.group.items.length} {row.group.tool} replies within 15% of one size
          </div>
          <div>
            {row.group.tokens.toLocaleString()} tokens · superseded ≈
            {formatContextTokens(row.group.superseded)}: all but the newest copy
          </div>
          <div className="text-muted-foreground">
            Cost to keep so far {formatUsd(row.group.cost)}
          </div>
          {turn !== null ? (
            <div className="text-muted-foreground">
              Click to open the newest, turn {turn}, in the chat
            </div>
          ) : null}
        </div>
      ) : (
        itemTip(item, itemLabel(item), ctx.used, turn)
      );
    return (
      <Tip key={row.kind === "group" ? row.group.id : item.id} tip={tip}>
        <div
          role={jumps ? "button" : undefined}
          className={cn(
            "grid min-h-[25px] grid-cols-[18px_minmax(0,1fr)_auto_54px] items-center gap-1.5 rounded-md px-1.5 hover:bg-accent",
            jumps && "cursor-pointer",
            row.kind === "group" && "items-start py-1",
          )}
          onClick={jumps ? () => ctx.onJump(item) : undefined}
        >
          <span className="text-right text-3xs text-muted-foreground tabular-nums">
            {index + 1}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            <Swatch color={KIND_COLOR[item.kind]} hatch={item.kind === "system_section"} />
            {row.kind === "group" ? (
              <>
                <span className="rounded border border-warning/45 bg-warning/8 px-1.5 text-3xs leading-4 whitespace-nowrap text-warning-foreground">
                  ×{row.group.items.length} alike
                </span>
                <span className="min-w-0 text-xs font-medium text-foreground">
                  {row.group.tool} replies, superseded ≈
                  {formatValue(
                    ctx.lens === "tokens"
                      ? row.group.superseded
                      : row.group.cost - itemCost(row.group.latest),
                    ctx.lens,
                  )}
                </span>
              </>
            ) : (
              <>
                <span className="text-2xs whitespace-nowrap text-muted-foreground">
                  {kindLabel(item)}
                </span>
                <span className="truncate text-xs text-foreground/85">{itemLabel(item)}</span>
              </>
            )}
          </span>
          <span className="pl-1.5 text-right text-3xs text-muted-foreground tabular-nums">
            {span}
          </span>
          <Figure
            amount={amount(row)}
            measured={row.kind === "group" || row.item.measured}
            lens={ctx.lens}
          />
        </div>
      </Tip>
    );
  });
}

/** The latest valid call's cache split, and what a cold cache costs here. */
export function CacheSection({
  report,
  prices,
}: {
  report: LoomContextReport;
  prices: CachePrices | null;
}) {
  const call = report.calls.findLast((candidate) => candidate.valid);
  if (!call) return null;
  const whole = call.cacheRead + call.cacheWrite + call.input || 1;
  const cold = coldCacheUsd(report, prices);
  const lapses = report.idleGaps.filter((gap) => gap.cacheLapsed);
  const worst = lapses.reduce<(typeof lapses)[number] | null>(
    (a, b) => (a === null || (b.rewriteCostUsd ?? 0) > (a.rewriteCostUsd ?? 0) ? b : a),
    null,
  );
  const lapsedCall = worst ? report.calls[worst.beforeCall] : undefined;
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded bg-muted">
        <i
          className="block h-full bg-primary/70"
          style={{ width: `${(100 * call.cacheRead) / whole}%` }}
        />
        <i
          className="block h-full bg-warning"
          style={{ width: `max(3px, ${(100 * call.cacheWrite) / whole}%)` }}
        />
      </div>
      <div className="my-1.5 flex flex-wrap gap-x-3.5 text-2xs text-muted-foreground">
        <span>
          <b className="font-medium text-foreground/85">{formatContextTokens(call.cacheRead)}</b>{" "}
          read from cache ({((100 * call.cacheRead) / whole).toFixed(1)}%)
        </span>
        <span>
          <b className="font-medium text-warning-foreground">
            {formatContextTokens(call.cacheWrite)}
          </b>{" "}
          newly written
        </span>
        <span>
          <b className="font-medium text-foreground/85">{call.input}</b> uncached
        </span>
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        This call cost {formatUsd(call.costUsd)}.
        {prices
          ? ` Cached context is billed at $${prices.price.cacheRead}/M, 1/${Math.round(prices.write / prices.read)} of the $${(prices.write * 1e6).toFixed(0)}/M write price.`
          : ""}
        {report.totals.cacheWarmCount > 0
          ? ` Kept warm by ${report.totals.cacheWarmCount} pings (${formatUsd(report.totals.cacheWarmCostUsd)}).`
          : ""}
      </p>
      {cold !== null || worst ? (
        <div className="mt-2 rounded-lg border border-warning/25 bg-warning-surface px-2.5 py-2 text-xs leading-snug text-foreground/85">
          {cold !== null ? (
            <b className="font-semibold text-warning-foreground">
              If the cache goes cold, the next call rewrites all{" "}
              {formatContextTokens(report.totals.latestCtx)}: about {formatUsd(cold)}.
            </b>
          ) : null}
          {worst && lapsedCall ? (
            <span className="block">
              {lapses.length === 1
                ? "It happened once in this thread"
                : `It happened ${lapses.length} times in this thread; the dearest`}
              : on{" "}
              {new Date(lapsedCall.at).toLocaleString(undefined, {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              , after {(worst.minutes / 60).toFixed(1)} hours idle,{" "}
              {formatContextTokens(lapsedCall.cacheWrite)} was rewritten in one call for{" "}
              {formatUsd(worst.rewriteCostUsd ?? 0)},{" "}
              {Math.round((100 * (worst.rewriteCostUsd ?? 0)) / (report.totals.costUsd || 1))}% of
              the thread's {formatUsd(report.totals.costUsd)}.
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One row per finding that fired, tagged with where its fix lives. */
export function ReclaimRows({
  report,
  window,
  used,
  prices,
}: {
  report: LoomContextReport;
  window: ReadonlyArray<LoomContextItem>;
  used: number;
  prices: CachePrices | null;
}) {
  const inWindow = new Map(window.map((item) => [item.id, item]));
  const itemsOf = (finding: LoomContextFinding) =>
    finding.itemIds.flatMap((id) => inWindow.get(id) ?? []);
  const echo = report.findings.find((finding) => finding.rule === "write_tool_echo");
  const echoes = echo ? itemsOf(echo) : [];
  const prune = prices && echoes.length > 1 ? pruneTradeoff(window, echoes, prices) : null;
  const rows = report.findings.flatMap((finding) => {
    const items = itemsOf(finding);
    if (items.length === 0) return [];
    const tools = [...new Set(items.map((item) => shortTool(item.tool ?? "")))];
    const cost = items.reduce((sum, item) => sum + itemCost(item), 0);
    const largest = [...items].sort((a, b) => b.chars - a.chars).slice(0, 2);
    return [
      finding.rule === "write_tool_echo"
        ? {
            rule: finding.rule,
            title: "Tool echoes, avoidable",
            tag: ["loom", "Loom tool"] as const,
            amount: finding.avoidableTokens,
            sub: formatPct(finding.avoidableTokens, used),
            color: COLORS.tools,
            text: `${prune ? `${prune.older} of ${items.length}` : `${items.length}`} replies from ${tools.join(" and ")} are older than the latest from the same tool. ${finding.detail} Returning one line would have kept them out; they have cost ${formatUsd(cost)} to keep.`,
          }
        : finding.rule === "unused_tool_schemas"
          ? {
              rule: finding.rule,
              title: "Tool schemas never called",
              tag: ["loom", "Loom fixed prompt"] as const,
              amount: finding.tokens,
              sub: "every call",
              color: COLORS.defs,
              text: `${finding.detail} The largest are ${largest.map((item) => `${shortTool(item.label)} (${item.chars.toLocaleString()} characters)`).join(" and ")}. Deferring them behind tool_search costs one search when needed.`,
            }
          : {
              rule: finding.rule,
              title: "Whole-file reads",
              tag: ["guide", "Agent guidance"] as const,
              amount: finding.tokens,
              sub: formatPct(finding.tokens, used),
              color: COLORS.tools,
              text: `${finding.detail} Reading with an offset and limit, or searching first, would have kept most of them out.`,
            },
    ].map((row) => ({ ...row, exact: finding.exact }));
  });
  if (rows.length === 0)
    return <p className="text-xs text-muted-foreground">No finding fired on this window.</p>;
  return (
    <div>
      {rows.map((row) => (
        <div
          key={row.rule}
          className="grid grid-cols-[minmax(0,1fr)_92px] gap-x-2.5 gap-y-0.5 border-t border-border/60 py-2 first:border-t-0"
        >
          <div className="flex items-center gap-1.5 text-xs font-medium">
            {row.title}
            <Tag tone={row.tag[0]}>{row.tag[1]}</Tag>
          </div>
          <div className="text-right text-xs font-semibold tabular-nums">
            {row.exact ? null : <Est />}
            {formatContextTokens(row.amount)}
            <small className="block text-3xs font-normal text-muted-foreground">{row.sub}</small>
          </div>
          <div className="col-span-2 my-0.5 h-1.5 overflow-hidden rounded-full bg-muted">
            <i
              className="block h-full"
              style={{
                width: `${Math.max(0.5, (100 * row.amount) / (used || 1))}%`,
                background: row.color,
              }}
            />
          </div>
          <p className="col-span-2 text-xs leading-snug text-muted-foreground">{row.text}</p>
        </div>
      ))}
      {prune ? (
        <p className="mt-1.5 border-l-2 border-border pl-2 text-2xs leading-snug text-muted-foreground">
          Dropping items mid-window breaks the cache from that point on. Removing the older echoes
          now would rewrite ≈{formatContextTokens(prune.rewrite)} once (
          {formatUsd(prune.rewriteUsd)}) to save {formatUsd(prune.savedPerCallUsd)} per later call.
          Pruning buys headroom; the saving in money comes from fixing the tool.
        </p>
      ) : null}
    </div>
  );
}
