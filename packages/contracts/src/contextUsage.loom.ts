// `loom.contextUsage`: what a pi thread's context window holds, read from its session jsonl on
// demand (plans/context-viz-experiment/plan.mdx §2.3). Token fields are Int, not NonNegativeInt: a
// negative gap is a reader bug the report surfaces in `diagnostics.negativeGaps`, never clamps.
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, ThreadId } from "./baseSchemas.ts";

/** One LLM call (a jsonl assistant entry); `index` is its position among all calls. */
export const LoomContextCall = Schema.Struct({
  index: NonNegativeInt,
  entryId: Schema.String,
  at: IsoDateTime,
  /** input + cacheRead + cacheWrite: the whole prompt at this call. */
  ctx: Schema.Int,
  /** ctx(N) − ctx(N−1) − output(N−1) over valid calls; a series' first call takes its whole ctx; 0 when invalid. */
  appendedTokens: Schema.Int,
  output: Schema.Int,
  reasoning: Schema.Int,
  input: Schema.Int,
  cacheRead: Schema.Int,
  cacheWrite: Schema.Int,
  costUsd: Schema.Number,
  /** cost.cacheRead ÷ usage.cacheRead and cost.cacheWrite ÷ usage.cacheWrite; null when the divisor is 0. */
  readUnitUsd: Schema.NullOr(Schema.Number),
  writeUnitUsd: Schema.NullOr(Schema.Number),
  stop: Schema.NullOr(Schema.String),
  /** False when ctx is 0 or the call stopped on error or abort; its pending items roll forward. */
  valid: Schema.Boolean,
  toolCallIds: Schema.Array(Schema.String),
  /** Increments after each compaction. */
  series: NonNegativeInt,
});
export type LoomContextCall = typeof LoomContextCall.Type;

export const LoomContextItemKind = Schema.Literals([
  "tool_result",
  "user_message",
  "system_section",
  "tool_schema",
  "compaction_base",
  "assistant_text",
  "assistant_thinking",
  "tool_call_args",
]);
export type LoomContextItemKind = typeof LoomContextItemKind.Type;

/** `extension` is a pi extension's `custom_message` (background-job notices, memory context). */
export const LoomContextUserKind = Schema.Literals([
  "human",
  "control_plane_notice",
  "child_notification",
  "agent_brief",
  "consult",
  "extension",
]);
export type LoomContextUserKind = typeof LoomContextUserKind.Type;

/**
 * One thing that entered the window. `id` is the toolCallId for a tool result; the entry id for a
 * user message or compaction; `entryId:c<n>` for an assistant content block; `entryId:<name>` for
 * a system section or tool schema.
 */
export const LoomContextItem = Schema.Struct({
  id: Schema.String,
  kind: LoomContextItemKind,
  tool: Schema.NullOr(Schema.String),
  label: Schema.String,
  at: IsoDateTime,
  tokens: Schema.Int,
  /** False when the gap held several items and this one's share is by character weight. */
  measured: Schema.Boolean,
  chars: NonNegativeInt,
  images: NonNegativeInt,
  isError: Schema.Boolean,
  /** The call whose prompt first held it, and how many valid calls of its series carried it. */
  firstSeenCall: NonNegativeInt,
  carriedCalls: NonNegativeInt,
  costToKeepUsd: Schema.NullOr(Schema.Number),
  userKind: Schema.NullOr(LoomContextUserKind),
  /** Assistant items only: the call that wrote it and its content index, the client's ordinal join. */
  message: Schema.NullOr(Schema.Struct({ callIndex: NonNegativeInt, contentIndex: NonNegativeInt })),
  /** The whole_file_read rule matched it. */
  wholeFile: Schema.Boolean,
});
export type LoomContextItem = typeof LoomContextItem.Type;

export const LoomContextFindingRule = Schema.Literals([
  "write_tool_echo",
  "unused_tool_schemas",
  "whole_file_read",
]);
export type LoomContextFindingRule = typeof LoomContextFindingRule.Type;

export const LoomContextFinding = Schema.Struct({
  rule: LoomContextFindingRule,
  class: Schema.Literals(["loom_tooling", "agent_guidance"]),
  tokens: Schema.Int,
  avoidableTokens: Schema.Int,
  itemIds: Schema.Array(Schema.String),
  detail: Schema.String,
  exact: Schema.Boolean,
});
export type LoomContextFinding = typeof LoomContextFinding.Type;

/** Consecutive valid calls more than an hour apart; `beforeCall` is the later one. */
export const LoomContextIdleGap = Schema.Struct({
  beforeCall: NonNegativeInt,
  minutes: Schema.Number,
  /** The later call re-wrote at least 90% of its prompt; `rewriteCostUsd` is its cache-write cost, else null. */
  cacheLapsed: Schema.Boolean,
  rewriteCostUsd: Schema.NullOr(Schema.Number),
});
export type LoomContextIdleGap = typeof LoomContextIdleGap.Type;

export const LoomContextReport = Schema.Struct({
  sessionPath: Schema.String,
  /** The last valid call's model slug; the client prices from it. */
  model: Schema.NullOr(Schema.String),
  calls: Schema.Array(LoomContextCall),
  items: Schema.Array(LoomContextItem),
  findings: Schema.Array(LoomContextFinding),
  idleGaps: Schema.Array(LoomContextIdleGap),
  /** `costUsd` sums the LLM calls; cache-warm pings are `cacheWarmCostUsd`, apart. */
  totals: Schema.Struct({
    peakCtx: Schema.Int,
    latestCtx: Schema.Int,
    costUsd: Schema.Number,
    cacheReadTokens: Schema.Int,
    cacheWriteTokens: Schema.Int,
    cacheWarmCount: NonNegativeInt,
    cacheWarmCostUsd: Schema.Number,
  }),
  diagnostics: Schema.Struct({
    malformedLines: NonNegativeInt,
    negativeGaps: NonNegativeInt,
    invalidCalls: NonNegativeInt,
  }),
});
export type LoomContextReport = typeof LoomContextReport.Type;

/** `loom.contextUsage`: null when the thread has no pi session file to read. */
export const LoomContextUsageInput = Schema.Struct({ threadId: ThreadId });
export type LoomContextUsageInput = typeof LoomContextUsageInput.Type;
export const LoomContextUsageResult = Schema.Struct({ report: Schema.NullOr(LoomContextReport) });
export type LoomContextUsageResult = typeof LoomContextUsageResult.Type;
