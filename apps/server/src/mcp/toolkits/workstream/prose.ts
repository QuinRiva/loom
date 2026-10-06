/**
 * PLACEHOLDER (3a-1). Session 3a-T authors the real prose for every Loom tool;
 * the orchestrator takes 3a-T's version of this file at fan-in. Only the shape
 * is load-bearing here: `defs.ts` reads the 21 MCP tools' prose from it and
 * Loom's extension (3a-4) reads `enable_toolset` / `ask_user_question`.
 *
 * @module mcp/toolkits/workstream/prose
 */

export interface LoomToolProse {
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: string;
}

const placeholder = (name: string): LoomToolProse => ({
  description: `${name} (placeholder description; authored in 3a-T).`,
  promptSnippet: `${name} (placeholder snippet).`,
  promptGuidelines: "",
});

export const LOOM_TOOL_PROSE = {
  workstream_spawn: placeholder("workstream_spawn"),
  workstream_scaffold: placeholder("workstream_scaffold"),
  workstream_brief: placeholder("workstream_brief"),
  workstream_set_outcome: placeholder("workstream_set_outcome"),
  workstream_request_attention: placeholder("workstream_request_attention"),
  workstream_stop: placeholder("workstream_stop"),
  workstream_prompt: placeholder("workstream_prompt"),
  workstream_set_dependencies: placeholder("workstream_set_dependencies"),
  workstream_submit: placeholder("workstream_submit"),
  workstream_list: placeholder("workstream_list"),
  consult_thread: placeholder("consult_thread"),
  notify_thread: placeholder("notify_thread"),
  set_thread_title: placeholder("set_thread_title"),
  thread_fork: placeholder("thread_fork"),
  goal_task_list: placeholder("goal_task_list"),
  goal_task_add: placeholder("goal_task_add"),
  goal_task_update: placeholder("goal_task_update"),
  goal_tasks_rewrite: placeholder("goal_tasks_rewrite"),
  goal_handoff: placeholder("goal_handoff"),
  goal_continue: placeholder("goal_continue"),
  goal_update: placeholder("goal_update"),
  enable_toolset: placeholder("enable_toolset"),
  ask_user_question: placeholder("ask_user_question"),
} as const satisfies Record<string, LoomToolProse>;

export type LoomProseToolName = keyof typeof LOOM_TOOL_PROSE;
