// loom: the composition's tree (plan §5): what the latest call's window holds, fixed part and
// conversation, category → tool → item; and Group repeats (Carl's rule: same tool, tokens within
// 15% of that tool's median, at least three).
import type { LoomContextItem, LoomContextReport } from "@t3tools/contracts";

import { formatContextTokens } from "../format";

export type Lens = "tokens" | "cost";

export interface Node {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly hatch: boolean;
  readonly items: ReadonlyArray<LoomContextItem>;
  /** Sub-rows; null when the rows under it are its items, or `leaves` is false and it has none. */
  readonly children: ReadonlyArray<Node> | null;
  readonly leaves: boolean;
  readonly tokens: number;
  readonly cost: number;
  readonly measured: boolean;
  readonly note?: string;
}

export interface RepeatGroup {
  readonly id: string;
  readonly tool: string;
  readonly items: ReadonlyArray<LoomContextItem>;
  readonly tokens: number;
  readonly cost: number;
  /** The total less the newest copy. */
  readonly superseded: number;
  readonly latest: LoomContextItem;
}

export const COLORS = {
  fixed: "#8a93b8",
  defs: "#7b86c4",
  compaction: "#64748b",
  tools: "#e0a24e",
  args: "#46b5a2",
  msgs: "#6f8dff",
  think: "#a88cf5",
  text: "#9ca3af",
  img: "#e37aa7",
} as const;

export const shortTool = (name: string) => name.replace(/^mcp__.+?__/, "");
export const itemCost = (item: LoomContextItem) => item.costToKeepUsd ?? 0;
export const value = (node: { tokens: number; cost: number }, lens: Lens) =>
  lens === "tokens" ? node.tokens : node.cost;

const shade = (color: string, index: number) =>
  index === 0 ? color : `color-mix(in oklab, ${color} ${Math.max(38, 100 - index * 15)}%, #0e0e0e)`;

function node(
  id: string,
  label: string,
  color: string,
  items: ReadonlyArray<LoomContextItem>,
  children: ReadonlyArray<Node> | null = null,
  extra: { hatch?: boolean; note?: string; leaves?: boolean } = {},
): Node {
  return {
    id,
    label,
    color,
    hatch: extra.hatch ?? false,
    leaves: children === null && (extra.leaves ?? true),
    items,
    children,
    tokens: items.reduce((sum, item) => sum + item.tokens, 0),
    cost: items.reduce((sum, item) => sum + itemCost(item), 0),
    measured: items.every((item) => item.measured),
    ...(extra.note ? { note: extra.note } : {}),
  };
}

function groupBy<K>(items: ReadonlyArray<LoomContextItem>, key: (item: LoomContextItem) => K) {
  const groups = new Map<K, LoomContextItem[]>();
  for (const item of items) {
    const k = key(item);
    groups.set(k, [...(groups.get(k) ?? []), item]);
  }
  return groups;
}

const SECTION_LABEL: Record<string, string> = {
  addendum: "Work-model addendum",
  skills: "Skills list",
  project_context: "AGENTS.md files",
  preamble: "Preamble and cwd",
  cwd: "Preamble and cwd",
};

/** An item's row label: system sections and schemas by their readable names. */
export const itemLabel = (item: LoomContextItem) =>
  item.kind === "system_section"
    ? (SECTION_LABEL[item.label] ?? item.label)
    : item.kind === "tool_schema"
      ? shortTool(item.label)
      : item.label;

const USER_KIND_LABEL: Record<string, string> = {
  human: "From you",
  control_plane_notice: "Control-plane notices",
  child_notification: "Child notifications",
  agent_brief: "Briefs from the parent",
  consult: "Consult answers",
  extension: "Extension messages",
};

/** Sub-rows by a key, heaviest first; those under 1% of the window fold into one "N other" row. */
function byKey(
  parentId: string,
  items: ReadonlyArray<LoomContextItem>,
  color: string,
  key: (item: LoomContextItem) => string,
  label: (key: string) => string,
  foldBelow: number,
  otherNoun: string,
): Node[] {
  const sorted = [...groupBy(items, key)].sort(
    (a, b) => b[1].reduce((s, i) => s + i.tokens, 0) - a[1].reduce((s, i) => s + i.tokens, 0),
  );
  const size = (group: LoomContextItem[]) => group.reduce((s, i) => s + i.tokens, 0);
  const small = sorted.filter(([, group]) => size(group) < foldBelow);
  const kept = small.length > 1 ? sorted.filter(([, group]) => size(group) >= foldBelow) : sorted;
  const nodes = kept.map(([k, group], index) =>
    node(`${parentId}/${k}`, label(k), shade(color, index), group),
  );
  if (small.length < 2) return nodes;
  const otherColor = shade(color, nodes.length);
  return [
    ...nodes,
    node(
      `${parentId}/other`,
      `${small.length} other ${otherNoun}`,
      otherColor,
      small.flatMap(([, group]) => group),
      small.map(([k, group]) => node(`${parentId}/other/${k}`, label(k), otherColor, group)),
    ),
  ];
}

export interface Composition {
  readonly window: ReadonlyArray<LoomContextItem>;
  readonly used: number;
  readonly fixed: Node;
  readonly conversation: Node;
  /** Times each tool was called in the session, by name. */
  readonly calledByTool: ReadonlyMap<string, number>;
}

export function buildComposition(report: LoomContextReport): Composition {
  const window = report.items.filter((item) => item.inWindow);
  const used = window.reduce((sum, item) => sum + item.tokens, 0);
  const foldBelow = used * 0.01;
  const calledByTool = new Map(
    [
      ...groupBy(
        report.items.filter((item) => item.kind === "tool_result"),
        (item) => item.tool ?? "",
      ),
    ].map(([tool, items]) => [tool, items.length]),
  );
  const schemas = window.filter((item) => item.kind === "tool_schema");
  const unused = report.findings.find((finding) => finding.rule === "unused_tool_schemas");
  const sections = [
    ...groupBy(
      window.filter((item) => item.kind === "system_section"),
      (item) => SECTION_LABEL[item.label] ?? item.label,
    ),
  ];
  const fixedRows = [
    node("f/defs", "Tool definitions", COLORS.defs, schemas, null, {
      hatch: true,
      ...(unused
        ? {
            note: `${unused.itemIds.length} of ${schemas.length} tools never called in this thread: ${unused.exact ? "" : "≈"}${formatContextTokens(unused.tokens)} on every call.`,
          }
        : {}),
    }),
    ...sections.map(([label, items]) =>
      node(`f/${label}`, label, COLORS.fixed, items, null, { hatch: true, leaves: false }),
    ),
  ].filter((row) => row.items.length > 0);
  const fixed = node(
    "f",
    "Fixed overhead",
    COLORS.defs,
    fixedRows.flatMap((row) => row.items),
    fixedRows,
    { hatch: true },
  );

  const isImage = (item: LoomContextItem) => item.images > 0;
  const of = (kind: LoomContextItem["kind"]) =>
    window.filter((item) => item.kind === kind && !isImage(item));
  const toolKey = (item: LoomContextItem) => item.tool ?? "";
  const categories = [
    node(
      "c/compaction",
      "Compacted: summary and kept messages",
      COLORS.compaction,
      of("compaction_base"),
    ),
    node(
      "c/tools",
      "Tool results",
      COLORS.tools,
      of("tool_result"),
      byKey("c/tools", of("tool_result"), COLORS.tools, toolKey, shortTool, foldBelow, "tools"),
    ),
    node(
      "c/args",
      "Agent's own writing",
      COLORS.args,
      of("tool_call_args"),
      byKey("c/args", of("tool_call_args"), COLORS.args, toolKey, shortTool, foldBelow, "tools"),
      {
        note: "Tool-call arguments: the briefs, prompts, commands and tree rewrites it wrote. They stay in context, though the timeline shows them only as tool calls.",
      },
    ),
    node(
      "c/msgs",
      "Incoming messages",
      COLORS.msgs,
      of("user_message"),
      byKey(
        "c/msgs",
        of("user_message"),
        COLORS.msgs,
        (item) => item.userKind ?? "human",
        (kind) => USER_KIND_LABEL[kind] ?? kind,
        0,
        "kinds",
      ),
    ),
    node("c/think", "Thinking", COLORS.think, of("assistant_thinking"), null, {
      note: "Kept in the window on every later call, never dropped.",
    }),
    node("c/text", "Assistant text", COLORS.text, of("assistant_text")),
    node("c/img", "Images", COLORS.img, window.filter(isImage)),
  ].filter((category) => category.items.length > 0);
  return {
    window,
    used,
    fixed,
    conversation: node(
      "c",
      "Conversation",
      COLORS.tools,
      categories.flatMap((c) => c.items),
      categories,
    ),
    calledByTool,
  };
}

const median = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Carl's Group repeats: per tool (results and arguments apart), the items within 15% of its median. */
export function repeatGroups(window: ReadonlyArray<LoomContextItem>): RepeatGroup[] {
  const candidates = window.filter(
    (item) => item.tool !== null && (item.kind === "tool_result" || item.kind === "tool_call_args"),
  );
  return [...groupBy(candidates, (item) => `${item.kind}|${item.tool}`)].flatMap(([key, items]) => {
    const middle = median(items.map((item) => item.tokens));
    const members = items.filter((item) => Math.abs(item.tokens - middle) <= 0.15 * middle);
    if (members.length < 3) return [];
    const latest = members.reduce((a, b) => (b.firstSeenCall >= a.firstSeenCall ? b : a));
    const tokens = members.reduce((sum, item) => sum + item.tokens, 0);
    return [
      {
        id: `g/${key}`,
        tool: shortTool(members[0]!.tool ?? ""),
        items: members,
        tokens,
        cost: members.reduce((sum, item) => sum + itemCost(item), 0),
        superseded: tokens - latest.tokens,
        latest,
      },
    ];
  });
}
