// loom: the growth view's findings (plan §6): one card per rule the server fired, then the task's
// size as plain sums by kind and the fixed overhead. Clicking a card lights its items on the chart.
import type { LoomContextFinding, LoomContextReport } from "@t3tools/contracts";

import { formatContextTokens, formatShare, paletteInk, plural } from "../format";
import type { LitGroup } from "./BiggestStep";
import {
  CLASS_META,
  type GrowthClass,
  type GrowthModel,
  type StepItem,
  shortToolName,
} from "./series";

interface Card extends LitGroup {
  readonly detail: string;
}

const CLASS_ORDER: ReadonlyArray<GrowthClass> = ["loom_tooling", "agent_guidance", "task", "fixed"];
const CLASS_WHAT: Record<GrowthClass, string> = {
  loom_tooling: "a tool returned or kept more than it should",
  agent_guidance: "the agent did something avoidable",
  task: "the work was that big",
  fixed: "paid on every call",
};
const RULE_NAMES: Record<LoomContextFinding["rule"], string> = {
  write_tool_echo: "write tools echoing large payloads",
  unused_tool_schemas: "never-called tool schemas",
  whole_file_read: "whole-file reads with no range",
};
const READS = new Set(["bash", "read", "read_full", "Read"]);

const sum = (entries: ReadonlyArray<StepItem>) =>
  entries.reduce((total, entry) => total + entry.item.tokens, 0);
/** `bash 36.6K, write 8.8K, edit 5.4K`: the three largest totals by `by`. */
const largest = (entries: ReadonlyArray<StepItem>, by: (entry: StepItem) => string) => {
  const totals = new Map<string, number>();
  for (const entry of entries)
    totals.set(by(entry), (totals.get(by(entry)) ?? 0) + entry.item.tokens);
  return [...totals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, tokens]) => `${name} ${formatContextTokens(tokens)}`)
    .join(", ");
};

function findingTitle(finding: LoomContextFinding, report: LoomContextReport, tools: string[]) {
  switch (finding.rule) {
    case "write_tool_echo":
      return `${tools.join(" and ")} echo a large payload on every write`;
    case "unused_tool_schemas":
      return `${finding.itemIds.length} of ${report.items.filter((item) => item.kind === "tool_schema").length} tool schemas never called`;
    case "whole_file_read":
      return `${plural(finding.itemIds.length, "whole-file read")} with no range`;
  }
}

export function growthCards(report: LoomContextReport, model: GrowthModel): ReadonlyArray<Card> {
  const byId = new Map(model.items.map((entry) => [entry.item.id, entry]));
  const findings = report.findings.map((finding): Card => {
    const tools = [
      ...new Set(finding.itemIds.flatMap((id) => byId.get(id)?.item.tool ?? []).map(shortToolName)),
    ];
    return {
      key: finding.rule,
      cls: finding.class,
      title: findingTitle(finding, report, tools),
      detail: finding.detail,
      ids: new Set(finding.itemIds),
      tokens: finding.tokens,
      avoidable: finding.avoidableTokens,
      exact: finding.exact,
    };
  });
  const rest = model.items.filter(
    (entry) => entry.item.inWindow && !model.classOf.has(entry.item.id),
  );
  const of = (pred: (entry: StepItem) => boolean) => rest.filter(pred);
  const tool = (entry: StepItem) => shortToolName(entry.item.tool ?? "");
  const reads = of((e) => e.item.kind === "tool_result" && READS.has(e.item.tool ?? ""));
  const wrote = of((e) => e.item.kind === "tool_call_args");
  const talk = of((e) => e.item.kind === "user_message" || e.item.kind === "assistant_text");
  const others = of((e) => e.item.kind === "tool_result" && !READS.has(e.item.tool ?? ""));
  const sums: ReadonlyArray<[string, GrowthClass, string, string, ReadonlyArray<StepItem>]> = [
    [
      "reads",
      "task",
      `${plural(reads.length, "command")} and file reads`,
      `bash, read and read_full results not flagged above: the investigation itself. Largest: ${largest(reads, (e) => e.label)}.`,
      reads,
    ],
    [
      "wrote",
      "task",
      "What the agent wrote: briefs, prompts, edits",
      `Its own tool-call arguments, re-sent on every later call; split from output tokens by character share. Largest: ${largest(wrote, tool)}.`,
      wrote,
    ],
    [
      "thinking",
      "task",
      "Thinking",
      "Reasoning stays in the window on this model. Exact from the call's reasoning tokens.",
      of((e) => e.item.kind === "assistant_thinking"),
    ],
    [
      "talk",
      "task",
      "Conversation: messages in and assistant text",
      `${largest(talk, (e) => e.cause.label)}.`,
      talk,
    ],
    [
      "tools",
      "task",
      "Other tool results",
      `Tool results not flagged above. Largest: ${largest(others, tool)}.`,
      others,
    ],
    [
      "compaction",
      "task",
      "Compacted summary and kept messages",
      "What the last compaction left in the window.",
      of((e) => e.item.kind === "compaction_base"),
    ],
    [
      "fixed",
      "fixed",
      "System prompt and the tool schemas it uses",
      "Sections and the schemas of tools this session called: paid on every call.",
      of((e) => e.cls === "fixed"),
    ],
  ];
  return [
    ...findings,
    ...sums
      .filter(([, , , , entries]) => entries.length > 0)
      .map(([key, cls, title, detail, entries]): Card => ({
        key,
        cls,
        title,
        detail,
        ids: new Set(entries.map((e) => e.item.id)),
        tokens: sum(entries),
        avoidable: null,
        exact: entries.every((e) => e.item.measured),
      }))
      .sort((a, b) => b.tokens - a.tokens),
  ];
}

export function FindingsList({
  cards,
  latestCtx,
  lit,
  onSelect,
}: {
  readonly cards: ReadonlyArray<Card>;
  readonly latestCtx: number;
  readonly lit: string | null;
  readonly onSelect: (card: Card | null) => void;
}) {
  const quiet = (Object.keys(RULE_NAMES) as Array<LoomContextFinding["rule"]>).filter(
    (rule) => !cards.some((card) => card.key === rule),
  );
  return (
    <section className="rounded-lg border border-border/70 px-1.5 py-3">
      <h3 className="px-2 text-sm font-semibold text-foreground">Findings</h3>
      <p className="px-2 pb-1 text-xs text-muted-foreground">
        {cards.some((card) => card.avoidable !== null)
          ? "Three arithmetic rules, run by the server over this session. Click one to light its calls on the chart."
          : "None of the three rules fired on this session. Click a row to light its calls on the chart."}
      </p>
      {CLASS_ORDER.map((cls) => {
        const group = cards.filter((card) => card.cls === cls);
        if (group.length === 0) return null;
        return (
          <div key={cls} className="mt-2">
            <div className="flex items-baseline gap-2 px-2 pb-0.5 text-xs text-muted-foreground">
              <span
                className="size-2.5 self-center rounded-sm"
                style={{ background: CLASS_META[cls].color }}
              />
              <span className="font-medium">{CLASS_META[cls].name}</span>
              <span className="truncate">{CLASS_WHAT[cls]}</span>
              <span className="ml-auto font-mono">
                {formatContextTokens(group.reduce((total, card) => total + card.tokens, 0))}
              </span>
            </div>
            {group.map((card) => (
              <button
                key={card.key}
                type="button"
                aria-pressed={lit === card.key}
                onClick={() => onSelect(lit === card.key ? null : card)}
                className={`grid w-full grid-cols-[3px_minmax(0,1fr)_auto] gap-x-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/50 ${lit === card.key ? "bg-accent/50 ring-1 ring-border" : ""}`}
              >
                <span className="rounded-sm" style={{ background: CLASS_META[cls].color }} />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{card.title}</span>
                  <span className="block text-xs text-muted-foreground">{card.detail}</span>
                </span>
                <span className="text-right whitespace-nowrap">
                  <span className="block font-mono text-sm text-foreground">
                    {card.exact ? "" : "≈"}
                    {formatContextTokens(card.tokens)}
                  </span>
                  <span className="block text-2xs text-muted-foreground">
                    {formatShare(card.tokens, latestCtx)} of context
                  </span>
                  {card.avoidable !== null ? (
                    <span
                      className="block text-2xs"
                      style={{ color: paletteInk(CLASS_META[cls].color) }}
                    >
                      avoidable {card.exact ? "" : "≈ "}
                      {formatContextTokens(card.avoidable)}
                    </span>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        );
      })}
      {quiet.length > 0 && quiet.length < 3 ? (
        <p className="px-2 pt-2 text-xs text-muted-foreground">
          Checked and found nothing material: {quiet.map((rule) => RULE_NAMES[rule]).join(", ")}.
        </p>
      ) : null}
    </section>
  );
}
