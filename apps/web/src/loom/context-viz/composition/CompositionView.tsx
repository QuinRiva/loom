// loom: the Composition sub-view (plan §5): what the latest call's window holds, fixed part first,
// in tokens or in what each thing has cost to keep. A call row parks a conversation jump.
import type { LoomContextItem, RunId } from "@t3tools/contracts";
import { type ReactNode, useState } from "react";

import { Toggle, ToggleGroup } from "../../../components/ui/toggle-group";
import { useQuietThreadProjection } from "../../../state/entities";
import { useConversationJumpStore } from "../../conversationJump";
import type { ContextViewProps } from "../contextUsageStore";
import { formatContextTokens, paletteInk } from "../format";
import { contextJoin } from "../join";
import {
  CacheSection,
  HATCH,
  LargestRows,
  ReclaimRows,
  type RowContext,
  Swatch,
  TreeRows,
  formatPct,
  formatValue,
  nodeTip,
} from "./CompositionRows";
import { cachePrices, coldCacheUsd, formatUsd } from "./costLens";
import { COLORS, type Lens, type Node, buildComposition, repeatGroups, value } from "./model";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="pt-3.5 pb-1">
      <div className="mb-1.5 flex items-baseline gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
        <span className="ml-auto flex items-center gap-2 text-2xs text-muted-foreground">
          {aside}
        </span>
      </div>
      {children}
    </section>
  );
}

export function CompositionView({
  report,
  threadRef,
  contextWindow,
  initialLens = "tokens",
  initialGrouped = true,
}: ContextViewProps & { readonly initialLens?: Lens; readonly initialGrouped?: boolean }) {
  const composition = buildComposition(report);
  const groups = repeatGroups(composition.window);
  const prices = cachePrices(report);
  const projection = useQuietThreadProjection(threadRef)?.projection ?? null;
  const ordinal = new Map<RunId, number>(projection?.runs.map((run) => [run.id, run.ordinal]));
  const turnOfCall =
    projection === null
      ? null
      : new Map(
          [...contextJoin(report, projection).runs].flatMap(([runId, figure]) =>
            figure.calls.map((call) => [call, ordinal.get(runId) ?? 0] as const),
          ),
        );
  const [lens, setLens] = useState<Lens>(initialLens);
  const [grouped, setGrouped] = useState(initialGrouped);
  const [lit, setLit] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(() => {
    const tools = composition.conversation.children?.find((node) => node.id === "c/tools");
    return new Set(["c/tools", tools?.children?.[0]?.id ?? ""]);
  });
  const { fixed, conversation, used, calledByTool } = composition;
  const total = lens === "tokens" ? used : fixed.cost + conversation.cost;
  const ctx: RowContext = {
    lens,
    total,
    used,
    lit,
    onLit: setLit,
    calledByTool,
    turnOf: (item: LoomContextItem) =>
      turnOfCall?.get(item.message?.callIndex ?? item.firstSeenCall) ?? null,
    onJump: (item) =>
      useConversationJumpStore.getState().setRequest({ threadId: threadRef.threadId, at: item.at }),
  };
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const schemas = fixed.children?.find((node) => node.id === "f/defs");
  const toolResults = conversation.children?.find((node) => node.id === "c/tools");
  const cold = coldCacheUsd(report, prices);
  const scale = lens === "tokens" ? (contextWindow ?? used) : total;
  // The bar: each fixed part hatched, tool results by tool, the other categories whole.
  const segments: ReadonlyArray<{ node: Node; crumb: string }> = [
    ...(fixed.children ?? []).map((node) => ({ node, crumb: `Fixed › ${node.label}` })),
    ...(conversation.children ?? []).flatMap((node) =>
      node.id === "c/tools"
        ? (node.children ?? []).map((tool) => ({
            node: tool,
            crumb: `Tool results › ${tool.label}`,
          }))
        : [{ node, crumb: node.label }],
    ),
  ];
  const litSegment = (id: string) =>
    lit !== null && (lit === id || lit.startsWith(`${id}/`) || id.startsWith(`${lit}/`));
  const toolsStart =
    fixed.tokens +
    (conversation.children?.[0]?.id === "c/compaction" ? conversation.children[0].tokens : 0);

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">
          {lens === "tokens" ? "What the latest call holds" : "What each thing has cost to keep"}
        </span>
        <ToggleGroup
          aria-label="Composition lens"
          className="ml-auto"
          value={[lens]}
          onValueChange={(next) => {
            if (next[0] === "tokens" || next[0] === "cost") setLens(next[0]);
          }}
        >
          <Toggle value="tokens">In window</Toggle>
          <Toggle value="cost">Cost to keep</Toggle>
        </ToggleGroup>
      </div>

      <section className="pt-3">
        <div className="flex h-[26px] overflow-hidden rounded-md bg-muted/60 ring-1 ring-border ring-inset">
          {segments.map(({ node, crumb }) => (
            <Tooltip key={node.id}>
              <TooltipTrigger
                render={
                  <div
                    className="h-full border-l border-background first:border-l-0"
                    style={{
                      width: `${(100 * value(node, lens)) / (scale || 1)}%`,
                      background: node.color,
                      opacity: lit === null || litSegment(node.id) ? 1 : 0.28,
                      ...(node.hatch ? HATCH : {}),
                    }}
                    onMouseEnter={() => setLit(node.id)}
                    onMouseLeave={() => setLit(null)}
                  />
                }
              />
              <TooltipPopup side="bottom" className="max-w-80">
                {nodeTip(node, crumb, used)}
              </TooltipPopup>
            </Tooltip>
          ))}
        </div>
        <div className="relative mt-1 h-[30px] text-2xs whitespace-nowrap text-muted-foreground">
          {lens === "tokens" ? (
            <>
              {toolResults ? (
                <span
                  className="absolute top-0 -translate-x-1/2"
                  style={{
                    left: `${(100 * (toolsStart + toolResults.tokens / 2)) / scale}%`,
                    color: paletteInk(COLORS.tools),
                  }}
                >
                  tool results {formatContextTokens(toolResults.tokens)}
                </span>
              ) : null}
              <span
                className="absolute top-0 -translate-x-full text-foreground/85"
                style={{ left: `${(100 * used) / scale}%` }}
              >
                {formatContextTokens(used)} used ▴
              </span>
              {contextWindow && contextWindow > used ? (
                <span className="absolute top-0 right-0">
                  {formatContextTokens(contextWindow - used)} free
                </span>
              ) : null}
              <span className="absolute top-3.5 left-0" style={{ color: paletteInk(COLORS.defs) }}>
                ▴ fixed {formatContextTokens(fixed.tokens)}, hatched
              </span>
            </>
          ) : (
            <>
              <span className="absolute top-0 left-0" style={{ color: paletteInk(COLORS.defs) }}>
                ▴ fixed {formatUsd(fixed.cost)}
              </span>
              <span className="absolute top-0 right-0">
                whole window, cost to keep so far ≈ {formatUsd(total)}
              </span>
              {cold !== null ? (
                <span className="absolute top-3.5 right-0 text-warning-foreground">
                  a cold cache now would cost {formatUsd(cold)}
                </span>
              ) : null}
            </>
          )}
        </div>
        <div className="mt-0.5 grid grid-cols-2 gap-2">
          <div className="rounded-lg border border-primary/40 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Swatch color={COLORS.defs} hatch />
              Fixed overhead
            </div>
            <div className="mt-px text-base font-semibold tabular-nums">
              {formatValue(value(fixed, lens), lens)}
              <small className="ml-1 text-2xs font-medium text-muted-foreground">
                {formatPct(value(fixed, lens), total)}
              </small>
            </div>
            <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">
              {lens === "tokens"
                ? `System prompt and ${schemas?.items.length ?? 0} tool schemas. Identical on every call, and set by Loom.`
                : `Small, but re-read on all ${report.calls.filter((call) => call.valid).length} calls.`}
            </div>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 px-2.5 py-2">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Swatch
                color={`linear-gradient(90deg, ${COLORS.tools} 55%, ${COLORS.args} 55% 75%, ${COLORS.msgs} 75%)`}
              />
              Conversation
            </div>
            <div className="mt-px text-base font-semibold tabular-nums">
              {formatValue(value(conversation, lens), lens)}
              <small className="ml-1 text-2xs font-medium text-muted-foreground">
                {formatPct(value(conversation, lens), total)}
              </small>
            </div>
            <div className="mt-0.5 text-2xs leading-snug text-muted-foreground">
              Everything that arrived since the first call.
              {toolResults
                ? ` Tool results are ${formatPct(value(toolResults, lens), value(conversation, lens))} of it.`
                : ""}
            </div>
          </div>
        </div>
      </section>

      <Section
        title="Fixed: sent on every call, before any work"
        aside={`${formatValue(value(fixed, lens), lens)} · ${formatPct(value(fixed, lens), total)}`}
      >
        <div className="-mx-1.5">
          <TreeRows
            nodes={fixed.children ?? []}
            level={1}
            parentValue={value(fixed, lens)}
            crumb="Fixed"
            ctx={ctx}
            open={open}
            onToggle={toggle}
          />
        </div>
      </Section>

      <Section
        title="Conversation: what arrived since"
        aside={`bar: share of parent · %: of ${lens === "tokens" ? "window" : "total cost to keep"}`}
      >
        <div className="-mx-1.5">
          <TreeRows
            nodes={conversation.children ?? []}
            level={1}
            parentValue={total}
            crumb=""
            ctx={ctx}
            open={open}
            onToggle={toggle}
          />
        </div>
      </Section>

      <Section
        title="Largest single items"
        aside={
          <ToggleGroup
            aria-label="Largest items grouping"
            value={[grouped ? "group" : "each"]}
            onValueChange={(next) => {
              if (next[0] === "group" || next[0] === "each") setGrouped(next[0] === "group");
            }}
          >
            <Toggle value="group">Group repeats</Toggle>
            <Toggle value="each">Each item</Toggle>
          </ToggleGroup>
        }
      >
        <div className="-mx-1.5">
          <LargestRows window={composition.window} groups={grouped ? groups : null} ctx={ctx} />
        </div>
      </Section>

      <Section title="Cache on the latest call" aside="exact, from the provider's usage">
        <CacheSection report={report} prices={prices} />
      </Section>

      <Section title="What could be reclaimed" aside="tag: where the fix lives">
        <ReclaimRows report={report} window={composition.window} used={used} prices={prices} />
      </Section>

      <p className="mt-2.5 text-2xs text-muted-foreground">
        <span>≈</span> estimated split of an exact total (by character share). Every other figure is
        measured from the provider's per-call usage.
      </p>
    </div>
  );
}
