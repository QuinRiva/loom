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
  ask_user_question: "/provider-tools/user-input/ask",
  workstream_spawn: "/provider-tools/workstream/spawn",
  workstream_scaffold: "/provider-tools/workstream/scaffold",
  workstream_brief: "/provider-tools/workstream/brief",
  workstream_set_lane: "/provider-tools/workstream/lane",
  workstream_request_attention: "/provider-tools/workstream/attention",
  workstream_release: "/provider-tools/workstream/release",
  workstream_stop: "/provider-tools/workstream/stop",
  workstream_prompt: "/provider-tools/workstream/prompt",
  workstream_set_dependencies: "/provider-tools/workstream/dependencies",
  workstream_submit: "/provider-tools/workstream/submit",
  workstream_list: "/provider-tools/workstream/list",
  consult_thread: "/provider-tools/workstream/consult-thread",
  notify_thread: "/provider-tools/thread/notify",
  set_thread_title: "/provider-tools/thread/set-title",
  thread_fork: "/provider-tools/thread/fork",
  goal_task_list: "/provider-tools/goal/task/list",
  goal_task_add: "/provider-tools/goal/task/add",
  goal_task_update: "/provider-tools/goal/task/update",
  goal_tasks_rewrite: "/provider-tools/goal/tasks/rewrite",
  goal_update: "/provider-tools/goal/update",
  goal_handoff: "/provider-tools/goal/handoff",
  goal_continue: "/provider-tools/goal/continue",
} as const satisfies Record<string, `/provider-tools/${string}`>;

export type ProviderToolName = keyof typeof PROVIDER_TOOL_PATHS;

// Three families partitioning the routed provider tools above by WHO needs them
// resident. Tool selection (pi's ACTIVE set — never its registry) is the single
// lever pi conditions on: deselecting a tool drops its schema from every request
// and its snippet + guideline bullets from the system prompt, while leaving it
// registered and activatable. `roleOverlay.ts` auto-unions the leaf-core family
// into every role profile and unions the others only when the role's `toolsets:`
// frontmatter names them; `enable_toolset` (local, unrouted — hence outside this
// partition) activates a dormant family mid-session. The union of the three MUST
// equal PROVIDER_TOOL_PATHS' keys with no overlap — `toolPaths.test.ts` fails
// with a named diff if a new provider tool lands in no family or in two.

/** Provider tools every child needs resident: completion, attention,
 * orientation, consultation, and task-tree upkeep. */
export const LEAF_CORE_PROVIDER_TOOLS = [
  "workstream_submit",
  "workstream_request_attention",
  "workstream_list",
  "consult_thread",
  "set_thread_title",
  "goal_task_list",
  "goal_task_add",
  "goal_task_update",
  "goal_tasks_rewrite",
] as const satisfies ReadonlyArray<ProviderToolName>;

/** The delegation family: graph authoring and child management, plus the other
 * parent-/root-shaped acts (cross-thread tasking, divergence, goal ownership) a
 * leaf reaches for about as rarely as spawning. */
export const DELEGATION_PROVIDER_TOOLS = [
  "workstream_spawn",
  "workstream_scaffold",
  "workstream_brief",
  "workstream_set_lane",
  "workstream_release",
  "workstream_stop",
  "workstream_prompt",
  "workstream_set_dependencies",
  "notify_thread",
  "thread_fork",
  "goal_handoff",
  "goal_continue",
  "goal_update",
] as const satisfies ReadonlyArray<ProviderToolName>;

/** The human-input family: the structured-question surface. Dormant for leaf
 * roles, whose resident fallback is workstream_request_attention. */
export const HUMAN_INPUT_PROVIDER_TOOLS = [
  "ask_user_question",
] as const satisfies ReadonlyArray<ProviderToolName>;

/** The local (unrouted) tool the generated extension adds: the escalation path
 * out of a lean role profile. Auto-unioned into every role profile so its
 * snippet line is the resident, role-agnostic pointer that families exist. */
export const ENABLE_TOOLSET_TOOL = "enable_toolset";

/** Dormant families addressable by `enable_toolset`, for the ones whose members
 * are provider tools; `browser`/`studio`/`all` are resolved by prefix over the
 * live registry instead. */
export const DORMANT_PROVIDER_TOOLSETS = {
  delegation: DELEGATION_PROVIDER_TOOLS,
  "human-input": HUMAN_INPUT_PROVIDER_TOOLS,
} as const;
