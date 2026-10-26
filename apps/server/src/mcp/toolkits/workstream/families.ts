/**
 * Loom's tool families and upstream withhold list as pi sees them (`mcp__t3-code__<name>`). Roles
 * get LEAF_CORE plus their `toolsets:`; other permitted tools stay `deferred` behind `tool_search`,
 * and UPSTREAM_WITHHELD_TOOLS are registered `hidden` so no search surfaces them, unless a role's
 * `toolsets:` names the family they belong to (`withheldFrom`).
 */
import { AttachmentToolkit } from "../attachment/tools.ts";
import { DeviceToolkit } from "../device/tools.ts";
import { EnvironmentToolkit } from "../environment/tools.ts";
import { HtmlToolkit } from "../html/tools.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { PreviewToolkit } from "../preview/tools.ts";
import { PreviewControlsToolkit } from "../previewControls/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { PullRequestsToolkit } from "../pullRequests/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import { WorktreeToolkit } from "../worktree/tools.ts";

/** The name upstream's bridge registers an MCP tool under in pi. */
export const agentToolName = <const Name extends string>(name: Name) =>
  `mcp__t3-code__${name}` as const;

const namesOf = (...toolkits: ReadonlyArray<{ readonly tools: Record<string, unknown> }>) =>
  toolkits.flatMap((toolkit) => Object.keys(toolkit.tools).map(agentToolName));

const prefixed = <const Names extends ReadonlyArray<string>>(names: Names) =>
  names.map(agentToolName) as { readonly [K in keyof Names]: `mcp__t3-code__${Names[K]}` };

/** Resident for every role: completion, attention, orientation, consultation, self-upkeep (title, snooze), task-tree upkeep. */
export const LEAF_CORE = prefixed([
  "workstream_submit",
  "workstream_request_attention",
  "workstream_list",
  "consult_thread",
  "set_thread_title",
  "snooze_thread",
  "goal_task_list",
  "goal_task_add",
  "goal_task_update",
  "goal_tasks_rewrite",
] as const);

/** Graph authoring, child management and the other parent-/root-shaped acts. */
export const DELEGATION = prefixed([
  "workstream_spawn",
  "workstream_scaffold",
  "workstream_brief",
  "workstream_set_outcome",
  "workstream_stop",
  "workstream_prompt",
  "workstream_set_dependencies",
  "notify_thread",
  "thread_fork",
  "goal_handoff",
  "goal_continue",
  "goal_update",
] as const);

/** Search over every thread's content, for the roles that look up past decisions. */
export const HISTORY = prefixed(["thread_search"] as const);

/**
 * A query thread's one write (`plans/plan-query-threads/plan.mdx` §2.3). No role lists it: a
 * query thread declares its author's tools (the prompt-cache key) and reaches it by `tool_search`.
 */
export const DOCUMENT_QUERY = prefixed(["document_query_promote"] as const);

/** The structured-question surface, registered by Loom's extension rather than /mcp. */
export const HUMAN_INPUT = prefixed(["ask_user_question"] as const);

/** Upstream's PR toolkit, resident for orchestrator and shipper (seam 13). */
export const PULL_REQUESTS = namesOf(PullRequestsToolkit);

/** Upstream's scheduled-task tools, carved out of the withheld OrchestratorToolkit for the roles that name them. */
export const SCHEDULING = prefixed([
  "schedule_task",
  "list_scheduled_tasks",
  "update_scheduled_task",
  "delete_scheduled_task",
] as const);

/** Families a role keeps resident by naming them in `toolsets:`. */
export const TOOLSETS = {
  delegation: DELEGATION,
  "human-input": HUMAN_INPUT,
  history: HISTORY,
  "pull-requests": PULL_REQUESTS,
  scheduling: SCHEDULING,
} as const;

/**
 * Upstream tools a Loom thread never sees: registered `hidden` and kept out of
 * its active set. Read from upstream's own toolkit exports, so a tool upstream
 * adds to these toolkits is withheld by construction. Most also fail on the
 * server, whose Loom credential lacks `orchestration`.
 */
export const UPSTREAM_WITHHELD_TOOLS = namesOf(
  OrchestratorToolkit,
  ThreadToolkit,
  ProjectToolkit,
  AttachmentToolkit,
  EnvironmentToolkit,
  WorktreeToolkit,
);

/**
 * The families a thread reaches by `tool_search`, each with the model-facing phrase that announces
 * it (`deferredCapabilitiesClause`): a capability in plain words, anchored by tool names BM25 matches.
 * With the lists above it partitions the registered catalogue, so a toolkit without one fails CI.
 * SCHEDULING has none: withheld unless a role names it, it is never behind `tool_search`.
 */
export const CAPABILITIES: ReadonlyArray<{
  readonly id: string;
  readonly tools: ReadonlyArray<string>;
  readonly phrase: string;
}> = [
  {
    id: "browser",
    tools: namesOf(PreviewToolkit, PreviewControlsToolkit, HtmlToolkit),
    phrase:
      "a headless browser: `html_preview` renders an HTML document to a screenshot with its console output, and `preview_*` drives a live tab at any URL that the human can watch (navigate, click, type, snapshot)",
  },
  {
    id: "devices",
    tools: namesOf(DeviceToolkit),
    phrase:
      "iOS simulators and Android emulators streamed to the human's Device panel (`device_*`)",
  },
  {
    id: "pull-requests",
    tools: PULL_REQUESTS,
    phrase:
      "pull requests: link one to this thread and be woken when its checks or comments change instead of polling (`watch_pull_request`, `link_pull_request`)",
  },
  {
    id: "delegation",
    tools: DELEGATION,
    phrase:
      "children of your own and the graph around them (`workstream_spawn`, `workstream_scaffold`, `notify_thread`)",
  },
  {
    id: "history",
    tools: HISTORY,
    phrase: "search over every past thread's content (`thread_search`)",
  },
];

/** The withheld tools a role's profile (`tools`, its `toolsets:` included) does not name. */
export const withheldFrom = (tools: ReadonlyArray<string>) =>
  UPSTREAM_WITHHELD_TOOLS.filter((name) => !tools.includes(name));
