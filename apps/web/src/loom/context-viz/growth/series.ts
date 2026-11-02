// loom: the Growth view's maths (plan §6), pure: one step per valid call holding the items that
// entered its prompt, turns, the "without the avoidable items" line, units per call or per turn,
// and the cliffs worth a label. Findings come from the server; this only spreads their figures.
import type {
  LoomContextCall,
  LoomContextIdleGap,
  LoomContextItem,
  LoomContextReport,
} from "@t3tools/contracts";

export type GrowthClass = "fixed" | "loom_tooling" | "agent_guidance" | "task";

export const CLASS_META: Record<GrowthClass, { readonly name: string; readonly color: string }> = {
  fixed: { name: "Fixed overhead", color: "#71717a" },
  loom_tooling: { name: "Loom tooling", color: "#f97316" },
  agent_guidance: { name: "Agent guidance", color: "#ec4899" },
  task: { name: "Task size", color: "#94a3b8" },
};

export interface Cause {
  readonly key: string;
  readonly label: string;
  readonly color: string;
}

export interface StepItem {
  readonly item: LoomContextItem;
  readonly label: string;
  readonly cause: Cause;
  readonly cls: GrowthClass;
}

export interface Step {
  readonly k: number;
  readonly call: LoomContextCall;
  readonly turn: number;
  readonly prevCtx: number;
  readonly items: ReadonlyArray<StepItem>;
  /** ctx less the Loom-tooling avoidable tokens this call still carried. */
  readonly withoutTooling: number;
  /** ctx less every finding's avoidable tokens this call still carried: the dashed line. */
  readonly withoutAvoidable: number;
  readonly idle: LoomContextIdleGap | null;
  /** The first call after a compaction: its ctx is the compacted base, a drop. */
  readonly compacted: boolean;
}

export interface GrowthModel {
  readonly steps: ReadonlyArray<Step>;
  readonly turns: number;
  readonly causes: ReadonlyArray<Cause>;
  /** What the latest call holds, by class; sums to latestCtx. */
  readonly classTotals: Record<GrowthClass, number>;
  readonly avoidableInWindow: number;
  readonly classOf: ReadonlyMap<string, GrowthClass>;
  readonly items: ReadonlyArray<StepItem>;
}

export interface Unit {
  readonly index: number;
  readonly k0: number;
  readonly k1: number;
  readonly turn: number;
  readonly steps: ReadonlyArray<Step>;
  readonly items: ReadonlyArray<StepItem & { readonly callIndex: number }>;
  readonly total: number;
  readonly prevCtx: number;
  readonly ctx: number;
  readonly compacted: boolean;
  /** Tokens by cause, largest first. */
  readonly causes: ReadonlyArray<{ readonly cause: Cause; readonly tokens: number }>;
}

const FIXED_CAUSE: Cause = { key: "system", label: "System prompt and schemas", color: "#71717a" };
const BASE_CAUSES: Record<string, Cause> = {
  thinking: { key: "thinking", label: "Thinking", color: "#8b5cf6" },
  args: { key: "args", label: "Agent's own writing", color: "#6366f1" },
  text: { key: "text", label: "Assistant text", color: "#a1a1aa" },
  human: { key: "human", label: "You", color: "var(--foreground)" },
  brief: { key: "brief", label: "Briefs and child reports", color: "#d6d3d1" },
  notice: { key: "notice", label: "Automated notices", color: "#a8a29e" },
  compaction: { key: "compaction", label: "Compacted summary", color: "#eab308" },
  other: { key: "other", label: "Other tools", color: "#64748b" },
};
const TOOL_HUES = ["#2dd4bf", "#38bdf8", "#a3e635"];

/** `mcp__t3-code__goal_task_add` → `goal_task_add`. */
export const shortToolName = (tool: string) => tool.replace(/^mcp__.+?__/, "");

const toolFamily = (tool: string) => {
  const name = shortToolName(tool);
  if (name === "read" || name === "read_full" || name === "Read") return "read";
  return name.includes("_") ? `${name.split("_")[0]}_*` : name;
};

const familyLabel = (family: string) =>
  family === "read" ? "read / read_full" : family.endsWith("_*") ? `${family} tools` : family;

const userCause = (item: LoomContextItem): Cause =>
  item.userKind === "human"
    ? BASE_CAUSES.human!
    : item.userKind === "control_plane_notice" || item.userKind === "extension"
      ? BASE_CAUSES.notice!
      : BASE_CAUSES.brief!;

const itemLabel = (item: LoomContextItem): string => {
  const tool = item.tool ? shortToolName(item.tool) : null;
  switch (item.kind) {
    case "tool_result":
      return item.label.startsWith(item.tool ?? "\0")
        ? shortToolName(item.label)
        : `${tool}: ${item.label}`;
    case "tool_call_args":
      return `wrote ${tool}: ${item.label.startsWith(item.tool ?? "\0") ? "arguments" : item.label}`;
    case "assistant_thinking":
      return "thinking";
    case "assistant_text":
      return "assistant text";
    case "tool_schema":
      return `schema: ${shortToolName(item.tool ?? item.label)}`;
    case "system_section":
      return `system: ${item.label}`;
    default:
      return item.label;
  }
};

export function buildGrowthModel(report: LoomContextReport): GrowthModel {
  const avoidableOf = new Map<string, number>();
  const classOf = new Map<string, GrowthClass>();
  const byId = new Map(report.items.map((item) => [item.id, item]));
  for (const finding of report.findings) {
    const members = finding.itemIds.flatMap((id) => byId.get(id) ?? []);
    // The server reports the finding's avoidable total; each item keeps what is above the
    // floor the rule measured against (the shortest reply for echoes, zero for the others).
    const floor =
      (members.reduce((sum, item) => sum + item.tokens, 0) - finding.avoidableTokens) /
      Math.max(1, members.length);
    for (const item of members) {
      if (classOf.has(item.id)) continue;
      classOf.set(item.id, finding.class);
      avoidableOf.set(item.id, Math.max(0, item.tokens - floor));
    }
  }

  const familyTotals = new Map<string, number>();
  for (const item of report.items)
    if (item.kind === "tool_result" && item.tool)
      familyTotals.set(
        toolFamily(item.tool),
        (familyTotals.get(toolFamily(item.tool)) ?? 0) + item.tokens,
      );
  const topFamilies = [...familyTotals]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([f]) => f);
  const causeOf = (item: LoomContextItem): Cause => {
    switch (item.kind) {
      case "system_section":
      case "tool_schema":
        return FIXED_CAUSE;
      case "assistant_thinking":
        return BASE_CAUSES.thinking!;
      case "assistant_text":
        return BASE_CAUSES.text!;
      case "tool_call_args":
        return BASE_CAUSES.args!;
      case "user_message":
        return userCause(item);
      case "compaction_base":
        return BASE_CAUSES.compaction!;
      case "tool_result": {
        const family = toolFamily(item.tool ?? "");
        const hue = topFamilies.indexOf(family);
        return hue < 0
          ? BASE_CAUSES.other!
          : { key: `tool:${family}`, label: familyLabel(family), color: TOOL_HUES[hue]! };
      }
    }
  };

  const stepItems = report.items.map((item): StepItem => ({
    item,
    label: itemLabel(item),
    cause: causeOf(item),
    cls:
      classOf.get(item.id) ??
      (item.kind === "system_section" || item.kind === "tool_schema" ? "fixed" : "task"),
  }));
  const itemsByCall = new Map<number, StepItem[]>();
  for (const entry of stepItems) {
    const list = itemsByCall.get(entry.item.firstSeenCall) ?? [];
    list.push(entry);
    itemsByCall.set(entry.item.firstSeenCall, list);
  }

  const valid = report.calls.filter((call) => call.valid);
  const position = new Map(valid.map((call, k) => [call.index, k]));
  // Difference arrays over call positions: an item's avoidable tokens count from the call that
  // first held it for as many calls as carried it, so a compaction or replacement drops them.
  const toolingDelta = Array.from({ length: valid.length + 1 }, () => 0);
  const guidanceDelta = Array.from({ length: valid.length + 1 }, () => 0);
  for (const entry of stepItems) {
    const avoidable = avoidableOf.get(entry.item.id);
    const from = position.get(entry.item.firstSeenCall);
    if (!avoidable || from === undefined) continue;
    const delta = entry.cls === "agent_guidance" ? guidanceDelta : toolingDelta;
    delta[from]! += avoidable;
    delta[Math.min(valid.length, from + entry.item.carriedCalls)]! -= avoidable;
  }

  const userCalls = report.items
    .filter((item) => item.kind === "user_message" && item.userKind !== "extension")
    .map((item) => item.firstSeenCall);
  const idleByCall = new Map(report.idleGaps.map((gap) => [gap.beforeCall, gap]));
  let tooling = 0;
  let guidance = 0;
  const steps = valid.map((call, k): Step => {
    tooling += toolingDelta[k]!;
    guidance += guidanceDelta[k]!;
    const prev = valid[k - 1];
    return {
      k,
      call,
      turn: Math.max(1, userCalls.filter((at) => at <= call.index).length),
      prevCtx: prev?.ctx ?? 0,
      items: itemsByCall.get(call.index) ?? [],
      withoutTooling: call.ctx - tooling,
      withoutAvoidable: call.ctx - tooling - guidance,
      idle: idleByCall.get(call.index) ?? null,
      compacted: prev !== undefined && prev.series !== call.series,
    };
  });

  const classTotals: Record<GrowthClass, number> = {
    fixed: 0,
    loom_tooling: 0,
    agent_guidance: 0,
    task: 0,
  };
  let avoidableInWindow = 0;
  const causes = new Map<string, Cause>();
  for (const entry of stepItems) {
    causes.set(entry.cause.key, entry.cause);
    if (!entry.item.inWindow) continue;
    classTotals[entry.cls] += entry.item.tokens;
    avoidableInWindow += avoidableOf.get(entry.item.id) ?? 0;
  }
  return {
    steps,
    turns: steps.at(-1)?.turn ?? 0,
    causes: [...causes.values()],
    classTotals,
    avoidableInWindow: Math.round(avoidableInWindow),
    classOf,
    items: stepItems,
  };
}

/** Per call, or per turn (call 0, which holds the system prompt, stays its own unit). */
export function growthUnits(steps: ReadonlyArray<Step>, perTurn: boolean): ReadonlyArray<Unit> {
  const runs: Step[][] = [];
  for (const step of steps) {
    const last = runs.at(-1);
    if (perTurn && last && last[0]!.k !== 0 && last[0]!.turn === step.turn && !step.compacted)
      last.push(step);
    else runs.push([step]);
  }
  return runs.map((run, index) => {
    const items = run.flatMap((step) =>
      step.items.map((entry) => ({ ...entry, callIndex: step.call.index })),
    );
    const byCause = new Map<string, { cause: Cause; tokens: number }>();
    for (const entry of items) {
      const slot = byCause.get(entry.cause.key) ?? { cause: entry.cause, tokens: 0 };
      slot.tokens += entry.item.tokens;
      byCause.set(entry.cause.key, slot);
    }
    return {
      index,
      k0: run[0]!.k,
      k1: run.at(-1)!.k,
      turn: run[0]!.turn,
      steps: run,
      items,
      total: items.reduce((sum, entry) => sum + entry.item.tokens, 0),
      prevCtx: run[0]!.prevCtx,
      ctx: run.at(-1)!.call.ctx,
      compacted: run[0]!.compacted,
      causes: [...byCause.values()].sort((a, b) => b.tokens - a.tokens),
    };
  });
}

export interface Cliff {
  readonly first: Unit;
  readonly last: Unit;
  readonly tokens: number;
  readonly cause: Cause;
}

/**
 * The climbs worth a label: runs of consecutive unmuted units within one turn (per call, a turn's
 * burst of large results reads as one cliff), the five largest. With a finding lit, the runs
 * holding its items instead. Call 0 (the system prompt) and compactions never.
 */
export function cliffs(
  units: ReadonlyArray<Unit>,
  mute: number,
  lit: ReadonlySet<string> | null,
): ReadonlyArray<Cliff> {
  const runs: { units: Unit[]; tokens: number }[] = [];
  let open: { units: Unit[]; tokens: number } | null = null;
  for (const unit of units) {
    const tokens = lit
      ? unit.items.reduce((sum, entry) => sum + (lit.has(entry.item.id) ? entry.item.tokens : 0), 0)
      : unit.total;
    if (unit.k0 === 0 || unit.compacted || (lit ? tokens === 0 : tokens < mute)) {
      open = null;
      continue;
    }
    if (open && open.units.at(-1)!.turn === unit.turn) {
      open.units.push(unit);
      open.tokens += tokens;
    } else runs.push((open = { units: [unit], tokens }));
  }
  return runs
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 5)
    .sort((a, b) => a.units[0]!.k0 - b.units[0]!.k0)
    .map(({ units: run, tokens }) => {
      const byCause = new Map<string, { cause: Cause; tokens: number }>();
      for (const { cause, tokens: t } of run.flatMap((unit) => unit.causes)) {
        const slot = byCause.get(cause.key) ?? { cause, tokens: 0 };
        slot.tokens += t;
        byCause.set(cause.key, slot);
      }
      const cause = [...byCause.values()].sort((a, b) => b.tokens - a.tokens)[0]!.cause;
      return { first: run[0]!, last: run.at(-1)!, tokens, cause };
    });
}

/** The largest unit after call 0: what the Biggest step panel shows before any hover. */
export const biggestUnit = (units: ReadonlyArray<Unit>) =>
  units.reduce<Unit | undefined>(
    (best, unit) =>
      unit.k0 > 0 && !unit.compacted && unit.total > (best?.total ?? -1) ? unit : best,
    undefined,
  ) ?? units[0];
