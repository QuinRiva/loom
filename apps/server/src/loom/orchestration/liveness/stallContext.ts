/**
 * The last meaningful thing a State-C stalled run did, read from its projected turn items, so the
 * recovery nudge can say what happened instead of re-prompting blind.
 */
import type { OrchestrationV2TurnItem, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";
import { isToolItem, TOOL_ITEM_TYPES, toolNameOf } from "./inFlightTool.ts";

export interface StallContext {
  /** Whether the account came from a failed tool call or the last assistant message. */
  readonly source: "tool-error" | "last-assistant";
  /** The failing tool's name (tool-error source only). */
  readonly toolName: string | null;
  /** The concise, truncated account of what happened. */
  readonly detail: string;
}

/** Cap on the extracted detail embedded in a nudge (chars). */
const MAX_DETAIL_CHARS = 800;

const truncate = (text: string): string =>
  text.length > MAX_DETAIL_CHARS ? `${text.slice(0, MAX_DETAIL_CHARS)}…` : text;

const toolOutput = (item: OrchestrationV2TurnItem): string => {
  const output =
    item.type === "command_execution" || item.type === "dynamic_tool"
      ? item.output
      : item.type === "file_change"
        ? item.diffStr
        : undefined;
  return (
    typeof output === "string" ? output : output === undefined ? "" : JSON.stringify(output)
  ).trim();
};

/**
 * The LAST meaningful item, in ordinal order: a failed tool call (the error the
 * child may be stuck on) or an assistant message with text. "Error then
 * silence" surfaces the error, "spoke then silence" the last words, and a stale
 * error behind later progress is not resurfaced. Null when there is neither.
 */
const extractStallContext = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): StallContext | null => {
  let best: StallContext | null = null;
  for (const item of items.toSorted((left, right) => left.ordinal - right.ordinal)) {
    if (isToolItem(item) && item.status === "failed") {
      const detail = toolOutput(item);
      best = {
        source: "tool-error",
        toolName: toolNameOf(item),
        detail: truncate(detail.length > 0 ? detail : "(tool reported an error with no detail)"),
      };
    } else if (item.type === "assistant_message" && item.text.trim().length > 0) {
      best = { source: "last-assistant", toolName: null, detail: truncate(item.text.trim()) };
    }
  }
  return best;
};

/** Human-readable rendering of an extracted stall context (or its absence). */
export const renderStallContext = (context: StallContext | null): string => {
  if (context === null) return "(no failed tool call or last message was found in this run)";
  return context.source === "tool-error"
    ? `The last tool call${context.toolName ? ` (\`${context.toolName}\`)` : ""} failed:\n\n${context.detail}`
    : `Your last message was:\n\n${context.detail}`;
};

/** The stall context of one run, read from its tool and assistant turn items. */
export const readStallContext = Effect.fn("loom.liveness.readStallContext")(function* (
  threadId: ThreadId,
  runId: RunId,
) {
  const { turnItems } = yield* (yield* OrchestratorV2).getThreadRecords(threadId, ["turnItems"], {
    turnItemRunId: runId,
    turnItemTypes: [...TOOL_ITEM_TYPES, "assistant_message"],
  });
  return extractStallContext(turnItems);
});
