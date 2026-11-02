/**
 * loom: a `loom.contextUsage` report joined to timeline items (plan §3.4). Tool results match by id
 * (pi's toolCallId is `nativeItemRef.nativeId`); a call belongs to its tool items' provider turn,
 * else the turn whose time window holds it. Prose `…:m<k>:c<n>` takes the turn's k-th call only if
 * every tool item sits where those ordinals put it; otherwise the turn's prose is withheld.
 */
import type { ThreadStructure } from "@t3tools/client-runtime/state/models";
import type { LoomContextItem, LoomContextReport, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ContextJoinThread = Pick<
  ThreadStructure,
  "runs" | "attempts" | "providerTurns" | "turnItems"
>;

export interface RunContextFigure {
  /** Report call indices, in order. */
  readonly calls: ReadonlyArray<number>;
  /** The window as the run began (the previous call's prompt plus its output) and as it ended. */
  readonly startCtx: number;
  readonly endCtx: number;
  readonly addedTokens: number;
  readonly costUsd: number;
  /**
   * Everything its calls brought in, heaviest first: what entered before each call and each call's
   * own output. They sum to `addedTokens` but for the latest call's output, which the next measures.
   */
  readonly items: ReadonlyArray<LoomContextItem>;
}

export interface ContextJoin {
  /** By `nativeItemRef.nativeId`: tool results by toolCallId, joined prose and thinking by ordinal. */
  readonly byNativeId: ReadonlyMap<string, LoomContextItem>;
  /** The message that opens a run, by the run's `userMessageId`. */
  readonly byUserMessageId: ReadonlyMap<string, LoomContextItem>;
  /** A tool call's own arguments, which its row's figure leaves out, by toolCallId. */
  readonly argsOfTool: ReadonlyMap<string, LoomContextItem>;
  readonly runs: ReadonlyMap<RunId, RunContextFigure>;
  /** Prose and thinking rows left without a figure because their turn's order did not line up. */
  readonly withheldProse: number;
  /** The largest single item: the full bar of the session's one linear scale. */
  readonly maxItemTokens: number;
}

const PROSE_ID = /:m(\d+):c(\d+)$/;
const PROSE_KIND = {
  assistant_message: "assistant_text",
  reasoning: "assistant_thinking",
} as const;

interface TurnRows {
  readonly runId: RunId;
  readonly calls: Set<number>;
  readonly tools: Array<{ readonly ordinal: number; readonly call: number }>;
  readonly prose: Array<{
    readonly ordinal: number;
    readonly nativeId: string;
    readonly message: number;
    readonly content: number;
    readonly kind: (typeof PROSE_KIND)[keyof typeof PROSE_KIND];
  }>;
}

const cache = new WeakMap<LoomContextReport, WeakMap<ContextJoinThread, ContextJoin>>();

/** Memoised by reference on both inputs: one build per report and projection. */
export function contextJoin(report: LoomContextReport, thread: ContextJoinThread): ContextJoin {
  const byThread = cache.get(report) ?? new WeakMap<ContextJoinThread, ContextJoin>();
  cache.set(report, byThread);
  const cached = byThread.get(thread);
  if (cached) return cached;
  const join = buildContextJoin(report, thread);
  byThread.set(thread, join);
  return join;
}

export function buildContextJoin(
  report: LoomContextReport,
  thread: ContextJoinThread,
): ContextJoin {
  const callOfTool = new Map(
    report.calls.flatMap((call) => call.toolCallIds.map((id) => [id, call.index] as const)),
  );
  const toolResults = new Map(
    report.items.flatMap((item) => (item.kind === "tool_result" ? [[item.id, item] as const] : [])),
  );
  const written = new Map(
    report.items.flatMap((item) =>
      item.message
        ? [[`${item.message.callIndex}:${item.message.contentIndex}`, item] as const]
        : [],
    ),
  );

  const runOfAttempt = new Map(thread.attempts.map((attempt) => [attempt.id, attempt.runId]));
  const turns = new Map<string, TurnRows>();
  const windows = thread.providerTurns.flatMap((turn) => {
    const runId = turn.runAttemptId === null ? undefined : runOfAttempt.get(turn.runAttemptId);
    if (runId === undefined) return [];
    const rows: TurnRows = { runId, calls: new Set(), tools: [], prose: [] };
    turns.set(turn.id, rows);
    return turn.startedAt
      ? [
          {
            rows,
            start: DateTime.toEpochMillis(turn.startedAt),
            end: turn.completedAt ? DateTime.toEpochMillis(turn.completedAt) : Infinity,
          },
        ]
      : [];
  });
  for (const item of thread.turnItems) {
    const nativeId = item.nativeItemRef?.nativeId;
    const rows = item.providerTurnId === null ? undefined : turns.get(item.providerTurnId);
    if (!nativeId || !rows) continue;
    const call = callOfTool.get(nativeId);
    const prose = PROSE_ID.exec(nativeId);
    if (call !== undefined) {
      rows.tools.push({ ordinal: item.ordinal, call });
      rows.calls.add(call);
    } else if (prose && (item.type === "assistant_message" || item.type === "reasoning")) {
      rows.prose.push({
        ordinal: item.ordinal,
        nativeId,
        message: Number(prose[1]),
        content: Number(prose[2]),
        kind: PROSE_KIND[item.type],
      });
    }
  }

  const anchored = new Set([...turns.values()].flatMap((rows) => [...rows.calls]));
  for (const call of report.calls) {
    if (anchored.has(call.index)) continue;
    const at = Date.parse(call.at);
    windows.find((window) => window.start <= at && at <= window.end)?.rows.calls.add(call.index);
  }

  const byNativeId = new Map<string, LoomContextItem>();
  for (const [id, item] of toolResults) byNativeId.set(id, item);
  let withheldProse = 0;
  const callsByRun = new Map<RunId, number[]>();
  for (const rows of turns.values()) {
    const calls = [...rows.calls].toSorted((a, b) => a - b);
    callsByRun.set(rows.runId, [...(callsByRun.get(rows.runId) ?? []), ...calls]);
    const position = new Map(calls.map((call, index) => [call, index + 1]));
    const contiguous = calls.length === 0 || calls.at(-1)! - calls[0]! + 1 === calls.length;
    const lined = rows.prose.map((prose) => {
      const call = calls[prose.message - 1];
      const item = call === undefined ? undefined : written.get(`${call}:${prose.content}`);
      const ordered = rows.tools.every(
        (tool) => position.get(tool.call)! < prose.message === tool.ordinal < prose.ordinal,
      );
      return {
        prose,
        item,
        ok: call !== undefined && ordered && (item === undefined || item.kind === prose.kind),
      };
    });
    if (!contiguous || lined.some((entry) => !entry.ok)) {
      withheldProse += rows.prose.length;
      continue;
    }
    for (const { prose, item } of lined) {
      if (!item) continue;
      byNativeId.set(prose.nativeId, item);
    }
  }

  // An output item is its call's; any other entered in the gap before the call that first saw it.
  const itemsOfCall = new Map<number, LoomContextItem[]>();
  for (const item of report.items) {
    const call = item.message?.callIndex ?? item.firstSeenCall;
    const items = itemsOfCall.get(call);
    if (items) items.push(item);
    else itemsOfCall.set(call, [item]);
  }
  const argsOfTool = new Map(
    report.calls.flatMap((call) => {
      const args = (itemsOfCall.get(call.index) ?? []).filter(
        (item) => item.kind === "tool_call_args",
      );
      return call.toolCallIds.flatMap((id, index) =>
        args[index] ? [[id, args[index]] as const] : [],
      );
    }),
  );
  const byUserMessageId = new Map<string, LoomContextItem>();
  const runs = new Map<RunId, RunContextFigure>();
  for (const run of thread.runs) {
    const calls = (callsByRun.get(run.id) ?? []).toSorted((a, b) => a - b);
    const first = calls[0];
    if (first === undefined) continue;
    const valid = calls.map((index) => report.calls[index]!).filter((call) => call.valid);
    const before = report.calls.slice(0, first).findLast((call) => call.valid);
    const firstValid = valid[0]?.index ?? first;
    const opening = report.items.findLast(
      (item) =>
        item.kind === "user_message" &&
        item.firstSeenCall >= first &&
        item.firstSeenCall <= firstValid,
    );
    if (opening) byUserMessageId.set(run.userMessageId, opening);
    const last = valid.at(-1);
    const startCtx = before ? before.ctx + before.output : 0;
    const endCtx = last ? last.ctx + last.output : startCtx;
    runs.set(run.id, {
      calls,
      startCtx,
      endCtx,
      addedTokens: endCtx - startCtx,
      costUsd: calls.reduce((sum, index) => sum + report.calls[index]!.costUsd, 0),
      items: calls
        .flatMap((index) => itemsOfCall.get(index) ?? [])
        .toSorted((a, b) => b.tokens - a.tokens),
    });
  }

  return {
    byNativeId,
    byUserMessageId,
    argsOfTool,
    runs,
    withheldProse,
    maxItemTokens: Math.max(0, ...report.items.map((item) => item.tokens)),
  };
}
