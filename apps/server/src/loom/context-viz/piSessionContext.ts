// @effect-diagnostics nodeBuiltinImport:off - streams a multi-MB jsonl line by line, as usageTranscriptReader.
/**
 * A pi session jsonl to calls and attributed items (plans/context-viz-experiment/plan.mdx §2.1). Per
 * call, input + cacheRead + cacheWrite is the whole prompt, so what entered between two valid calls is
 * exactly ctx(N) − ctx(N−1) − output(N−1); one item in the gap takes it all, several split it by
 * character weight. Reference implementation: `.artifacts/context-viz/analyse.py`.
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeReadline from "node:readline";

import type {
  LoomContextCall,
  LoomContextIdleGap,
  LoomContextItem,
  LoomContextReport,
  LoomContextUserKind,
} from "@t3tools/contracts";

export const IMAGE_TOKENS = 1543;
// Labels cross the wire once per item on every thread open; 60 characters names a call.
const LABEL_CHARS = 60;
const IDLE_GAP_MINUTES = 60;
const KEPT_TYPES = ["message", "compaction", "usage", "session", "custom_message"].map(
  (type) => `"type":"${type}"`,
);
const LABEL_KEYS = [
  "path",
  "file_path",
  "pattern",
  "query",
  "url",
  "question",
  "threadId",
  "taskId",
  "title",
  "text",
  "name",
  "id",
  "command",
];

interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly cost: {
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}
type Block =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "thinking"; readonly thinking: string }
  | { readonly type: "image" }
  | {
      readonly type: "toolCall";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    };
type Content = string | ReadonlyArray<Block>;
interface Entry {
  readonly type: string;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd?: string;
  readonly summary?: string;
  readonly kind?: string;
  readonly usage?: Usage;
  readonly content?: Content;
  readonly message?: {
    readonly role: string;
    readonly content: Content;
    readonly model?: string;
    readonly usage?: Usage;
    readonly stopReason?: string;
    readonly sections?: Record<string, string>;
    readonly toolsAdded?: ReadonlyArray<{ name: string; description: string; parameters: unknown }>;
    readonly toolsRemoved?: ReadonlyArray<{ name: string }>;
    readonly toolCallId?: string;
    readonly toolName?: string;
    readonly isError?: boolean;
  };
}

/** An item before its gap is attributed. */
type Pending = Pick<
  LoomContextItem,
  "id" | "kind" | "tool" | "label" | "at" | "chars" | "images" | "isError" | "userKind" | "message"
>;

/** The wire call plus what the reader needs and no view reads; stripped before the report leaves. */
interface Call extends LoomContextCall {
  readonly entryId: string;
  readonly reasoning: number;
  readonly readUnitUsd: number | null;
  readonly model: string | null;
  readonly blocks: ReadonlyArray<Block>;
}

export interface PiSessionContext extends Omit<LoomContextReport, "findings"> {
  /** Each tool call's arguments by toolCallId, for the rules that read them. */
  readonly toolArgs: ReadonlyMap<string, unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const squash = (text: string) => text.split(/\s+/).filter(Boolean).join(" ");
const sum = (values: ReadonlyArray<number>) => values.reduce((a, b) => a + b, 0);

/** `total` across `weights` with cumulative rounding, so the parts sum to it exactly. */
const share = (total: number, weights: ReadonlyArray<number>): number[] => {
  const weightSum = sum(weights);
  let acc = 0;
  let given = 0;
  return weights.map((weight) => {
    acc += weightSum > 0 ? weight : 1;
    const upto = Math.round((total * acc) / (weightSum > 0 ? weightSum : weights.length));
    const part = upto - given;
    given = upto;
    return part;
  });
};

const contentOf = (content: Content) =>
  typeof content === "string"
    ? { text: content, images: 0 }
    : {
        text: content.map((block) => (block.type === "text" ? block.text : "")).join(""),
        images: content.filter((block) => block.type === "image").length,
      };

const userKindOf = (text: string): LoomContextUserKind =>
  text.startsWith("[T3 Workstream control plane")
    ? "control_plane_notice"
    : text.startsWith("Notification from thread")
      ? "child_notification"
      : text.startsWith("[Brief from") || text.startsWith("[From your parent")
        ? "agent_brief"
        : text.slice(0, 60).includes("[Consult")
          ? "consult"
          : "human";

const labelFor = (name: string, args: unknown, cwd: string | null): string => {
  if (!isRecord(args)) return String(args).slice(0, LABEL_CHARS);
  if (name === "bash") {
    const command = squash(String(args.command ?? ""));
    return (cwd === null ? command : command.replaceAll(cwd, "."))
      .replace(/^cd \.?(\/\S*)?\s*(&&|;)\s*/, (_, dir?: string) =>
        dir ? `${dir.replace(/^\/+/, "")}: ` : "",
      )
      .slice(0, LABEL_CHARS);
  }
  const key = LABEL_KEYS.find((candidate) => args[candidate]);
  if (key === undefined) return JSON.stringify(args.queries ?? args).slice(0, LABEL_CHARS);
  const value = squash(String(args[key]));
  return (cwd === null ? value : value.replaceAll(`${cwd}/`, "")).slice(0, LABEL_CHARS);
};

// Dollars to the micro-dollar and unit prices to six figures: float noise doubles the payload.
const usd = (value: number) => Math.round(value * 1e6) / 1e6;
const unitPrice = (cost: number, tokens: number) =>
  tokens > 0 ? Number((cost / tokens).toPrecision(6)) : null;

interface OutputBlock {
  readonly contentIndex: number;
  readonly kind: "assistant_thinking" | "assistant_text" | "tool_call_args";
  readonly tool: string | null;
  readonly label: string;
  readonly chars: number;
}

/** The thinking, text and tool-call items a call's output leaves in the window, dated at `next`. */
const assistantItems = (
  call: Call,
  next: Call,
  labels: ReadonlyMap<string, string>,
): LoomContextItem[] => {
  const blocks = call.blocks.flatMap((block, contentIndex): OutputBlock[] => {
    if (block.type === "thinking") {
      const label = squash(block.thinking.slice(0, 400));
      return [
        {
          contentIndex,
          kind: "assistant_thinking",
          tool: null,
          label,
          chars: block.thinking.length,
        },
      ];
    }
    if (block.type === "text") {
      const label = squash(block.text.slice(0, 400));
      return [
        { contentIndex, kind: "assistant_text", tool: null, label, chars: block.text.length },
      ];
    }
    if (block.type !== "toolCall") return [];
    const chars = block.name.length + JSON.stringify(block.arguments ?? null).length;
    const label = labels.get(block.id) ?? block.name;
    return [{ contentIndex, kind: "tool_call_args", tool: block.name, label, chars }];
  });
  const thinking = blocks.filter((block) => block.kind === "assistant_thinking");
  const rest = blocks.filter((block) => block.kind !== "assistant_thinking");
  const thinkingTokens =
    rest.length === 0
      ? call.output
      : thinking.length === 0
        ? 0
        : call.reasoning > 0
          ? Math.min(call.reasoning, call.output)
          : Math.round(
              (call.output * sum(thinking.map((block) => block.chars))) /
                Math.max(1, sum(blocks.map((block) => block.chars))),
            );
  const thinkingShares = share(
    thinkingTokens,
    thinking.map((block) => block.chars),
  );
  const restShares = share(
    call.output - thinkingTokens,
    rest.map((block) => block.chars),
  );
  const tokens = new Map([
    ...thinking.map((block, index) => [block.contentIndex, thinkingShares[index]!] as const),
    ...rest.map((block, index) => [block.contentIndex, restShares[index]!] as const),
  ]);
  return blocks.map(({ contentIndex, label, ...block }) => ({
    ...block,
    id: `${call.entryId}:c${contentIndex}`,
    label: label.slice(0, LABEL_CHARS),
    at: next.at,
    tokens: tokens.get(contentIndex)!,
    measured: block.kind === "assistant_thinking" && thinking.length === 1 && call.reasoning > 0,
    images: 0,
    isError: false,
    firstSeenCall: next.index,
    carriedCalls: 0,
    inWindow: false,
    costToKeepUsd: null,
    userKind: null,
    message: { callIndex: call.index, contentIndex },
    wholeFile: false,
  }));
};

/** An item's tokens guessed from its characters, images apart. */
const weightOf = (item: Pending) =>
  item.chars / (item.kind === "tool_schema" ? 2.4 : item.kind === "tool_result" ? 2.6 : 2.8);

/** The gap's budget over its items: exact for one; else images reserved, then chars by weight. */
const attribute = (
  pending: ReadonlyArray<Pending>,
  budget: number,
  call: Call,
): LoomContextItem[] => {
  const images = sum(pending.map((item) => item.images));
  const reserve = Math.min(images * IMAGE_TOKENS, Math.max(budget, 0));
  const weights = pending.map(weightOf);
  const weightSum = sum(weights);
  const tokens = share(
    budget,
    pending.map(
      (item, index) =>
        (weightSum > 0 ? ((budget - reserve) * weights[index]!) / weightSum : 0) +
        (images > 0 ? (reserve * item.images) / images : 0),
    ),
  );
  return pending.map((item, index) => ({
    ...item,
    tokens: tokens[index]!,
    measured: pending.length === 1,
    firstSeenCall: call.index,
    carriedCalls: 0,
    inWindow: false,
    costToKeepUsd: null,
    wholeFile: false,
  }));
};

/** Reads a session file; null when it is absent. */
export const readPiSessionContext = async (path: string): Promise<PiSessionContext | null> => {
  if ((await NodeFSP.stat(path).catch(() => null)) === null) return null;
  const calls: Call[] = [];
  const items: LoomContextItem[] = [];
  const toolArgs = new Map<string, unknown>();
  const labels = new Map<string, string>();
  let pending: Pending[] = [];
  let compaction: { id: string; at: string; chars: number } | null = null;
  let prev: Call | null = null;
  // A later system entry replaces sections and adds or removes tools: what it retires leaves the window.
  const live = new Map<string, string>();
  const tokensById = new Map<string, number>();
  const lastCall = new Map<string, number>();
  let retired: string[] = [];
  let series = 0;
  let cwd: string | null = null;
  let malformedLines = 0;
  let negativeGaps = 0;
  let cacheWarmCount = 0;
  let cacheWarmCostUsd = 0;

  const onCall = (entry: Entry, message: NonNullable<Entry["message"]>, usage: Usage) => {
    const blocks = typeof message.content === "string" ? [] : message.content;
    const toolCalls = blocks.filter((block) => block.type === "toolCall");
    for (const block of toolCalls) {
      toolArgs.set(block.id, block.arguments);
      labels.set(block.id, labelFor(block.name, block.arguments, cwd));
    }
    const ctx = usage.input + usage.cacheRead + usage.cacheWrite;
    const call: Call = {
      index: calls.length,
      entryId: entry.id,
      at: entry.timestamp,
      ctx,
      output: usage.output,
      reasoning: usage.reasoning ?? 0,
      input: usage.input,
      cacheRead: usage.cacheRead,
      cacheWrite: usage.cacheWrite,
      costUsd: usd(usage.cost.total),
      readUnitUsd: unitPrice(usage.cost.cacheRead, usage.cacheRead),
      writeUnitUsd: unitPrice(usage.cost.cacheWrite, usage.cacheWrite),
      valid: ctx > 0 && message.stopReason !== "error" && message.stopReason !== "aborted",
      toolCallIds: toolCalls.map((block) => block.id),
      series,
      model: message.model ?? null,
      blocks,
    };
    if (!call.valid) {
      calls.push(call);
      return;
    }
    if (compaction !== null) {
      // The summary and the kept messages are one block whose size only this call measures.
      calls.push(call);
      items.push({
        id: compaction.id,
        kind: "compaction_base",
        tool: null,
        label: "Compacted: summary and kept messages",
        at: compaction.at,
        tokens: ctx,
        measured: true,
        chars: compaction.chars,
        images: 0,
        isError: false,
        firstSeenCall: call.index,
        carriedCalls: 0,
        inWindow: false,
        costToKeepUsd: null,
        userKind: null,
        message: null,
        wholeFile: false,
      });
      compaction = null;
      live.clear();
    } else {
      const budget = prev === null ? ctx : ctx - prev.ctx - prev.output;
      calls.push(call);
      if (prev !== null) items.push(...assistantItems(prev, call, labels));
      // A model that takes mid-conversation system messages gets a changed section or tool appended
      // in full and keeps the old one; any other gets its head rewritten. The measured gap says which.
      const freed = sum(retired.map((id) => tokensById.get(id) ?? 0));
      const expected =
        sum(pending.map(weightOf)) + IMAGE_TOKENS * sum(pending.map((item) => item.images));
      const replaced = Math.abs(budget + freed - expected) < Math.abs(budget - expected);
      if (replaced) for (const id of retired) lastCall.set(id, prev!.index);
      const gap = replaced ? budget + freed : budget;
      if (gap < 0) negativeGaps += 1;
      for (const added of attribute(pending, gap, call)) {
        tokensById.set(added.id, added.tokens);
        items.push(added);
      }
    }
    pending = [];
    retired = [];
    prev = call;
  };

  const onEntry = (entry: Entry) => {
    const item = { id: entry.id, at: entry.timestamp, tool: null, isError: false, images: 0 };
    const userItem = (content: Content, userKind: (text: string) => LoomContextUserKind) => {
      const { text, images } = contentOf(content);
      const label = squash(text.slice(0, 400)).slice(0, LABEL_CHARS);
      const kind = "user_message";
      pending.push({
        ...item,
        kind,
        label,
        chars: text.length,
        images,
        userKind: userKind(text),
        message: null,
      });
    };
    const message = entry.message;
    if (entry.type === "session") cwd = entry.cwd ?? null;
    else if (entry.type === "usage" && entry.kind === "cache_warm") {
      cacheWarmCount += 1;
      cacheWarmCostUsd += entry.usage?.cost.total ?? 0;
    } else if (entry.type === "compaction") {
      compaction = { id: entry.id, at: entry.timestamp, chars: entry.summary?.length ?? 0 };
      series += 1;
    } else if (entry.type === "custom_message") userItem(entry.content ?? "", () => "extension");
    else if (message === undefined) return;
    else if (message.role === "user") userItem(message.content, userKindOf);
    else if (message.role === "system") {
      const retire = (key: string, id: string | null) => {
        const old = live.get(key);
        if (id === null) live.delete(key);
        else live.set(key, id);
        if (old === undefined) return;
        const before = pending.length;
        pending = pending.filter((entry) => entry.id !== old);
        if (pending.length === before) retired.push(old);
      };
      for (const [section, text] of Object.entries(message.sections ?? {})) {
        const id = `${entry.id}:${section}`;
        retire(`section:${section}`, text ? id : null);
        if (!text) continue;
        const kind = "system_section";
        pending.push({
          ...item,
          id,
          kind,
          label: section,
          chars: text.length,
          userKind: null,
          message: null,
        });
      }
      for (const { name } of message.toolsRemoved ?? []) retire(`tool:${name}`, null);
      for (const { name, description, parameters } of message.toolsAdded ?? []) {
        retire(`tool:${name}`, `${entry.id}:${name}`);
        pending.push({
          ...item,
          id: `${entry.id}:${name}`,
          kind: "tool_schema",
          tool: name,
          label: name,
          chars: JSON.stringify({ name, description, parameters }).length,
          userKind: null,
          message: null,
        });
      }
    } else if (message.role === "toolResult") {
      const { text, images } = contentOf(message.content);
      const id = message.toolCallId ?? entry.id;
      pending.push({
        ...item,
        id,
        kind: "tool_result",
        tool: message.toolName ?? null,
        label: labels.get(id) ?? message.toolName ?? "",
        chars: text.length,
        images,
        isError: message.isError === true,
        userKind: null,
        message: null,
      });
    } else if (message.role === "assistant" && message.usage !== undefined) {
      onCall(entry, message, message.usage);
    }
  };

  const lines = NodeReadline.createInterface({
    input: NodeFS.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    // pi writes `type` first, so `{"type":"…"` at offset 1 picks the entries without parsing the rest.
    if (!KEPT_TYPES.some((type) => line.startsWith(type, 1))) continue;
    try {
      onEntry(JSON.parse(line) as Entry);
    } catch {
      malformedLines += 1;
    }
  }

  // Carried calls and cost to keep run from an item's first call to the end of its series.
  const validCalls = calls.filter((call) => call.valid);
  const position = new Map(validCalls.map((call, index) => [call.index, index]));
  const seriesEnd = new Map(validCalls.map((call, index) => [call.series, index]));
  const readUnitPrefix = [0];
  for (const call of validCalls)
    readUnitPrefix.push(readUnitPrefix.at(-1)! + (call.readUnitUsd ?? 0));

  const idleGaps: LoomContextIdleGap[] = validCalls.slice(1).flatMap((call, index) => {
    const minutes = (Date.parse(call.at) - Date.parse(validCalls[index]!.at)) / 60_000;
    if (!(minutes > IDLE_GAP_MINUTES)) return [];
    const cacheLapsed = call.cacheWrite >= 0.9 * call.ctx;
    const rewriteCostUsd = cacheLapsed ? usd(call.cacheWrite * (call.writeUnitUsd ?? 0)) : null;
    return [{ beforeCall: call.index, minutes: Math.round(minutes), cacheLapsed, rewriteCostUsd }];
  });

  const last = validCalls.at(-1);
  return {
    sessionPath: path,
    model: last?.model ?? null,
    calls: calls.map(
      ({ model: _m, blocks: _b, entryId: _e, reasoning: _r, readUnitUsd: _u, ...call }) => call,
    ),
    items: items.map((item) => {
      const first = calls[item.firstSeenCall]!;
      const from = position.get(first.index)!;
      const dropped = lastCall.get(item.id);
      const to = dropped === undefined ? seriesEnd.get(first.series)! : position.get(dropped)!;
      const reads = readUnitPrefix[to + 1]! - readUnitPrefix[from + 1]!;
      return {
        ...item,
        carriedCalls: to - from + 1,
        inWindow: to === validCalls.length - 1,
        costToKeepUsd:
          first.writeUnitUsd === null ? null : usd(item.tokens * (first.writeUnitUsd + reads)),
      };
    }),
    idleGaps,
    totals: {
      peakCtx: Math.max(0, ...calls.map((call) => call.ctx)),
      latestCtx: last?.ctx ?? 0,
      costUsd: usd(sum(calls.map((call) => call.costUsd))),
      cacheReadTokens: sum(calls.map((call) => call.cacheRead)),
      cacheWriteTokens: sum(calls.map((call) => call.cacheWrite)),
      cacheWarmCount,
      cacheWarmCostUsd: usd(cacheWarmCostUsd),
    },
    diagnostics: { malformedLines, negativeGaps, invalidCalls: calls.length - validCalls.length },
    toolArgs,
  };
};
