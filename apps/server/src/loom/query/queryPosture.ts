/**
 * A query thread's read-only posture, as the three places that enforce it name it: the env
 * flag the session composer sets (the pi `query-guard` part refuses `edit` / `write` under it),
 * and the read-only MCP client `ProviderSessionManager` issues on that flag, whose label
 * `callLoomTool` reads to pick the query thread's allow-list over a consult fork's. A leaf:
 * the session manager imports it, so it must not reach back into the MCP toolkit.
 *
 * @module loom/query/queryPosture
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
