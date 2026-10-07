import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

/** loom: a `mcp__t3-code__consult_thread` call, which the timeline renders as its own card (`ConsultCardRow.tsx`). */
export const isConsultToolItem = (item: OrchestrationV2TurnItem) =>
  item.type === "dynamic_tool" && item.toolName === "mcp__t3-code__consult_thread";
