import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

/**
 * Resolve the request's bearer token to a Workstream-capable MCP scope (the
 * per-session credential the workstream AND goal/task tools share), or
 * undefined when the token is missing/unknown or lacks the `workstream`
 * capability.
 *
 * The goal/task/handoff HTTP handlers and the workstream-spawn handlers all
 * gate on the SAME credential, so this is one fork-owned helper rather than a
 * per-file copy. (Fork-owned: not on the upstream `McpSessionRegistry.ts`,
 * whose fork delta this campaign is shrinking.)
 */
export const resolveWorkstreamScope = Effect.fn("McpHttp.resolveWorkstreamScope")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const token = request.headers.authorization?.startsWith("Bearer ")
    ? request.headers.authorization.slice("Bearer ".length).trim()
    : "";
  const scope = yield* McpSessionRegistry.resolveActiveMcpCredential(token);
  return scope && scope.capabilities.has("workstream") ? scope : undefined;
});
