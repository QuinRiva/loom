/**
 * Loom's tool families and the upstream withhold list, as the names pi sees
 * (`mcp__t3-code__<name>`). Replaces V1's `mcp/toolPaths.ts`: there are no
 * routes any more, only names. The role profiles (3a-5) union LEAF_CORE into
 * every role and the other families by `toolsets:`; every other permitted tool
 * stays `deferred` behind pi's `tool_search`, and UPSTREAM_WITHHELD_TOOLS are
 * registered `hidden`, so no search surfaces them.
 *
 * @module mcp/toolkits/workstream/families
 */
import { AttachmentToolkit } from "../attachment/tools.ts";
import { EnvironmentToolkit } from "../environment/tools.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { PullRequestsToolkit } from "../pullRequests/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";
import { WorktreeToolkit } from "../worktree/tools.ts";

/** The name upstream's bridge registers an MCP tool under in pi. */
export const agentToolName = <const Name extends string>(name: Name) =>
  `mcp__t3-code__${name}` as const;

const prefixed = <const Names extends ReadonlyArray<string>>(names: Names) =>
  names.map(agentToolName) as { readonly [K in keyof Names]: `mcp__t3-code__${Names[K]}` };

/** Resident for every role: completion, attention, orientation, consultation, task-tree upkeep. */
export const LEAF_CORE = prefixed([
  "workstream_submit",
  "workstream_request_attention",
  "workstream_list",
  "consult_thread",
  "set_thread_title",
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

/** The structured-question surface, registered by Loom's extension rather than /mcp. */
export const HUMAN_INPUT = prefixed(["ask_user_question"] as const);

/** Upstream's PR toolkit, resident for orchestrator and shipper (seam 13). */
export const PULL_REQUESTS = Object.keys(PullRequestsToolkit.tools).map(agentToolName);

/** Families a role keeps resident by naming them in `toolsets:`. */
export const TOOLSETS = {
  delegation: DELEGATION,
  "human-input": HUMAN_INPUT,
  "pull-requests": PULL_REQUESTS,
} as const;

/**
 * Upstream tools a Loom credential is denied (capability_denied) and the
 * profile never activates. Read from upstream's own toolkit exports, so a tool
 * upstream adds to these toolkits is withheld by construction.
 */
export const UPSTREAM_WITHHELD_TOOLS = [
  OrchestratorToolkit,
  ThreadToolkit,
  ProjectToolkit,
  AttachmentToolkit,
  EnvironmentToolkit,
  WorktreeToolkit,
].flatMap((toolkit) => Object.keys(toolkit.tools).map(agentToolName));
