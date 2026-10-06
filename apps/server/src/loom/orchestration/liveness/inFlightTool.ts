/**
 * The in-flight tool read (Phase 3 plan "Liveness"; P3-9): a quiet-but-running
 * tool call is never a stall — a steer cannot penetrate a blocked call and long
 * calls are often legitimate — so State C is suppressed while one runs, and the
 * slow-tool advisory reports it instead.
 *
 * @module loom/orchestration/liveness/inFlightTool
 */
import type { OrchestrationV2TurnItem, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OrchestratorV2 } from "../../../orchestration-v2/Orchestrator.ts";

/** The turn item kinds that are tool executions (Pi: `bash` → command_execution, `edit`/`write` → file_change, every other tool → dynamic_tool). */
export const TOOL_ITEM_TYPES = ["command_execution", "dynamic_tool", "file_change"] as const;

export type ToolTurnItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: (typeof TOOL_ITEM_TYPES)[number] }
>;

export const isToolItem = (item: OrchestrationV2TurnItem): item is ToolTurnItem =>
  (TOOL_ITEM_TYPES as ReadonlyArray<string>).includes(item.type);

/** The tool's display name: the dynamic tool's name, else the item title (Pi's tool name), else its kind. */
export const toolNameOf = (item: ToolTurnItem): string =>
  (item.type === "dynamic_tool" ? item.toolName : null) ?? item.title ?? item.type;

export interface InFlightTool {
  readonly itemId: TurnItemId;
  readonly toolName: string;
  readonly startedAtMs: number;
  /** A shell command's text (carries the `# eta:` marker); null for other tools. */
  readonly commandText: string | null;
}

/**
 * The tool call running on the active attempt of the thread's running run, or
 * null: a `running` turn item of a tool kind whose provider turn belongs to
 * that attempt.
 */
export const inFlightTool = Effect.fn("loom.liveness.inFlightTool")(function* (threadId: ThreadId) {
  const { runs, providerTurns, turnItems } = yield* (yield* OrchestratorV2).getThreadRecords(
    threadId,
    ["runs", "providerTurns", "turnItems"],
    { turnItemTypes: TOOL_ITEM_TYPES, turnItemStatuses: ["running"] },
  );
  const run = runs.find((candidate) => candidate.status === "running");
  if (run === undefined) return null;
  // The attempt's provider turns name the attempt (Pi leaves the attempt's own providerTurnId null — DL-473).
  const attemptTurnIds = new Set(
    providerTurns
      .filter((turn) => turn.runAttemptId === run.activeAttemptId)
      .map((turn) => turn.id),
  );
  const item = turnItems.findLast(
    (candidate): candidate is ToolTurnItem =>
      isToolItem(candidate) &&
      candidate.runId === run.id &&
      candidate.providerTurnId != null &&
      attemptTurnIds.has(candidate.providerTurnId),
  );
  return item === undefined
    ? null
    : ({
        itemId: item.id,
        toolName: toolNameOf(item),
        startedAtMs: DateTime.toEpochMillis(item.startedAt ?? item.updatedAt),
        commandText: item.type === "command_execution" ? item.input : null,
      } satisfies InFlightTool);
});
