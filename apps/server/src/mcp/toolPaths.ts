// LOOM-ONLY. Dependency-free leaf: the single source of truth mapping each
// provider tool NAME to its HTTP route path, plus the base-URL derivation the
// driver uses to point the generated pi extension at this server. The HTTP
// handler modules register their routes from this table (so "tool exists" is
// compiler-connected to "route exists"), and PiDriver imports ONLY this leaf —
// never an HTTP handler module — to feed the child's endpoint env var.
//
// Imports nothing: this must stay a constants leaf so the driver's dependency
// on it carries no engine/Effect weight.

/**
 * Derive the child-facing base URL from the MCP endpoint: strip the trailing
 * `/mcp` suffix (the provider-tool routes are siblings of `/mcp`, not children).
 * A tool URL is then `base + PROVIDER_TOOL_PATHS[name]`.
 */
export const workstreamBaseUrlFromMcpEndpoint = (mcpEndpoint: string): string =>
  mcpEndpoint.endsWith("/mcp")
    ? mcpEndpoint.slice(0, -"/mcp".length)
    : mcpEndpoint.replace(/\/$/, "");

/**
 * Every provider tool's route path, keyed by tool name. The HTTP layers consume
 * these values when registering routes and the extension generator serialises
 * them into the child extension — one constant, two consumers, no drift.
 */
export const PROVIDER_TOOL_PATHS = {
  workstream_spawn: "/provider-tools/workstream/spawn",
  workstream_set_lane: "/provider-tools/workstream/lane",
  workstream_request_attention: "/provider-tools/workstream/attention",
  workstream_release: "/provider-tools/workstream/release",
  workstream_stop: "/provider-tools/workstream/stop",
  workstream_prompt: "/provider-tools/workstream/prompt",
  workstream_set_dependencies: "/provider-tools/workstream/dependencies",
  workstream_submit: "/provider-tools/workstream/submit",
  workstream_list: "/provider-tools/workstream/list",
  consult_thread: "/provider-tools/workstream/consult-thread",
  set_thread_title: "/provider-tools/thread/set-title",
  thread_fork: "/provider-tools/thread/fork",
  goal_task_list: "/provider-tools/goal/task/list",
  goal_task_add: "/provider-tools/goal/task/add",
  goal_task_update: "/provider-tools/goal/task/update",
  goal_task_delete: "/provider-tools/goal/task/delete",
  goal_update: "/provider-tools/goal/update",
  goal_handoff: "/provider-tools/goal/handoff",
  goal_continue: "/provider-tools/goal/continue",
} as const satisfies Record<string, `/provider-tools/${string}`>;

export type ProviderToolName = keyof typeof PROVIDER_TOOL_PATHS;
