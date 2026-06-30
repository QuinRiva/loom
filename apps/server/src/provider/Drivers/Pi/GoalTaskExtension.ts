// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const EXTENSION_FILE = "t3-goal-task-extension.mjs";

const EXTENSION_SOURCE = String.raw`export default function(pi) {
  const callGoalEndpoint = async (endpoint, params, signal) => {
    const authorization = process.env.T3_WORKSTREAM_AUTHORIZATION;
    if (!endpoint || !authorization) {
      return { ok: false, error: { content: [{ type: "text", text: "T3 goal/task tools are not available in this session." }], details: { ok: false, reason: "missing_endpoint" } } };
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify(params),
      signal
    });
    const text = await response.text();
    let result;
    try { result = text ? JSON.parse(text) : null; } catch { result = null; }
    if (!response.ok) {
      const message = result?.message ?? text ?? ("T3 goal/task request failed (" + response.status + ").");
      return { ok: false, error: { content: [{ type: "text", text: message }], details: { ok: false, status: response.status, response: result ?? text } } };
    }
    return { ok: true, result };
  };

  pi.registerTool({
    name: "goal_task_add",
    label: "Add Goal Task",
    description: "Add a task to the task tree of THIS thread's active goal. The goal is resolved from the session — you never pass a goalId, and you can only ever mutate your own thread's goal. Use this to record new actionable work: an orchestrator keeps the tree current as work evolves; a child should add a discovered-but-out-of-scope actionable item (e.g. 'evaluate whether to fix pre-existing bug X') directly rather than only mentioning it in its report. Errors cleanly if this thread has no active goal.",
    promptSnippet: "add a task to this thread's goal task tree (optionally under a parent task).",
    promptGuidelines: [
      "You never pass a goalId — the task is always added to this thread's own active goal.",
      "Pass parentTaskId (a task id from this goal) to nest the new task under an existing one; omit it for a top-level task."
    ],
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The task text. Required." },
        parentTaskId: { type: "string", description: "Optional id of an existing task in this goal to nest the new task under. Omit for a top-level task." },
        position: { type: "integer", minimum: 0, description: "Optional zero-based position among siblings. Omit to append." }
      },
      required: ["text"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callGoalEndpoint(process.env.T3_GOAL_TASK_ADD_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const taskId = outcome.result?.taskId ?? "unknown";
      return {
        content: [{ type: "text", text: "Added task " + taskId + ": " + (params.text ?? "") }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "goal_task_update",
    label: "Update Goal Task",
    description: "Update an existing task in THIS thread's active goal: rename it (text), mark it done / reopen it (done), and/or reorder it (position). The goal is resolved from the session; the taskId must belong to it. A child may mark its OWN assigned task done when it finishes the work. Pass only the fields you want to change.",
    promptSnippet: "update a task in this thread's goal: rename (text), mark done/reopen (done), or reorder (position).",
    promptGuidelines: [
      "taskId must be a task in this thread's own active goal.",
      "Pass only the fields you are changing; provide at least one of text, done, or position."
    ],
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Id of the task to update. Required; must belong to this thread's goal." },
        text: { type: "string", description: "New task text (rename)." },
        done: { type: "boolean", description: "Mark the task done (true) or reopen it (false)." },
        position: { type: "integer", minimum: 0, description: "New zero-based position among its siblings." }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callGoalEndpoint(process.env.T3_GOAL_TASK_UPDATE_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const taskId = outcome.result?.taskId ?? params.taskId ?? "unknown";
      return {
        content: [{ type: "text", text: "Updated task " + taskId + "." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "goal_task_delete",
    label: "Delete Goal Task",
    description: "Delete a task (and its subtree) from THIS thread's active goal. The goal is resolved from the session; the taskId must belong to it. Use sparingly — prefer marking a task done over deleting it; delete is for tasks that were created in error or are no longer meaningful.",
    promptSnippet: "delete a task (and its subtree) from this thread's goal.",
    promptGuidelines: [
      "taskId must be a task in this thread's own active goal.",
      "Prefer marking a task done over deleting it; delete is for tasks added in error or no longer meaningful."
    ],
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Id of the task to delete. Required; must belong to this thread's goal." }
      },
      required: ["taskId"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callGoalEndpoint(process.env.T3_GOAL_TASK_DELETE_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const taskId = outcome.result?.taskId ?? params.taskId ?? "unknown";
      return {
        content: [{ type: "text", text: "Deleted task " + taskId + "." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "goal_handoff",
    label: "Hand Off New Goal",
    description: "Hand off a separate, out-of-scope piece of work as its OWN new goal and a staged (held) root session. Use when you discover follow-up work that deserves to run independently rather than as a task under THIS goal. Creates a new goal in this thread's project and a parent-less session pre-loaded with your brief, then leaves it for the human to launch with a single send (which provisions a fresh worktree). You never pass a goalId/projectId — both are inherited from this thread. Returns the new goalId + threadId.",
    promptSnippet: "hand off discovered out-of-scope work as a new goal + a staged root session pre-loaded with a brief.",
    promptGuidelines: [
      "Use this for genuinely separate work that should run concurrently in its own goal/session \u2014 not for tasks that belong under this thread's existing goal (use goal_task_add for those).",
      "The brief becomes the new session's first turn: write it as a complete, self-contained kickoff prompt, not a one-line summary.",
      "The session is created held; the human launches it. You do NOT start it and no worktree is provisioned until the human sends."
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The new goal's title. Required." },
        brief: { type: "string", description: "The handoff/kickoff prompt that becomes the new session's first turn. Required; write it self-contained." },
        description: { type: "string", description: "Optional short goal objective paragraph." }
      },
      required: ["title", "brief"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callGoalEndpoint(process.env.T3_GOAL_HANDOFF_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const goalId = outcome.result?.goalId ?? "unknown";
      const threadId = outcome.result?.threadId ?? "unknown";
      return {
        content: [{ type: "text", text: "Handed off new goal " + goalId + " with staged session " + threadId + " (" + (params.title ?? "") + "). The human launches it with one send." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "goal_update",
    label: "Update Goal",
    description: "Update the metadata of THIS thread's active goal: its title, description (the objective paragraph), and/or slug. The goal is resolved from the session — you never pass a goalId. Use this to keep the goal's framing accurate as understanding evolves. Pass only the fields you want to change.",
    promptSnippet: "update this thread's goal metadata (title / description / slug).",
    promptGuidelines: [
      "You never pass a goalId — this always updates this thread's own active goal.",
      "Pass only the fields you are changing; provide at least one of title, description, or slug."
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "New goal title." },
        description: { type: "string", description: "New goal objective paragraph (may be empty to clear it)." },
        slug: { type: "string", description: "New stable goal slug." }
      },
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callGoalEndpoint(process.env.T3_GOAL_UPDATE_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const goalId = outcome.result?.goalId ?? "this goal";
      return {
        content: [{ type: "text", text: "Updated goal " + goalId + "." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });
}
`;

export function ensurePiGoalTaskExtension(stateDir: string): string {
  const extensionDir = NodePath.join(stateDir, "pi-extensions");
  const extensionPath = NodePath.join(extensionDir, EXTENSION_FILE);
  // Write unconditionally so edits to EXTENSION_SOURCE propagate to existing
  // state dirs (a one-time existsSync guard would pin stale tool code forever).
  NodeFS.mkdirSync(extensionDir, { recursive: true });
  NodeFS.writeFileSync(extensionPath, EXTENSION_SOURCE, "utf8");
  return extensionPath;
}
