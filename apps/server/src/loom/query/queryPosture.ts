/**
 * A query thread's read-only posture: the env flag the composer sets (the pi `query-guard` part
 * refuses `edit` / `write` under it) and the read-only MCP client issued on it, whose label
 * `callLoomTool` reads to pick the query allow-list. A leaf: the session manager imports it.
 */
import type { ThreadId } from "@t3tools/contracts";

import type { McpClientCaller } from "../../mcp/McpInvocationContext.ts";

export const LOOM_QUERY_FORK_ENV = "T3_LOOM_QUERY_FORK";

export const DOCUMENT_QUERY_CLIENT_LABEL = "document query";

export const documentQueryClient = (threadId: ThreadId): McpClientCaller => ({
  sessionId: `document-query:${threadId}`,
  label: DOCUMENT_QUERY_CLIENT_LABEL,
  access: "read-only",
});
