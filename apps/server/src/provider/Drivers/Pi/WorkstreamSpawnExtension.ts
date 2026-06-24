// @effect-diagnostics nodeBuiltinImport:off
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const EXTENSION_FILE = "t3-workstream-spawn-extension.mjs";

const EXTENSION_SOURCE = String.raw`export default function(pi) {
  const callWorkstreamEndpoint = async (endpoint, params, signal) => {
    const authorization = process.env.T3_WORKSTREAM_AUTHORIZATION;
    if (!endpoint || !authorization) {
      return { ok: false, error: { content: [{ type: "text", text: "T3 Workstream tools are not available in this session." }], details: { ok: false, reason: "missing_endpoint" } } };
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
      const message = result?.message ?? text ?? ("T3 Workstream request failed (" + response.status + ").");
      return { ok: false, error: { content: [{ type: "text", text: message }], details: { ok: false, status: response.status, response: result ?? text } } };
    }
    return { ok: true, result };
  };

  pi.registerTool({
    name: "workstream_spawn",
    label: "Spawn Workstream Sub-thread",
    description: "Spawn a T3 Code Workstream sub-thread as a child of the current thread, assign it a role and purpose, and immediately start it working autonomously.",
    promptSnippet: "workstream_spawn: launch a durable child T3 thread for delegated work; pass role, purpose, and optional title.",
    promptGuidelines: [
      "Use workstream_spawn when you need a separate coder, reviewer, researcher, or other durable child thread to work independently.",
      "Make the purpose self-contained; the child starts fresh and does not inherit this transcript."
    ],
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role label for the child agent, e.g. coder, reviewer, researcher." },
        purpose: { type: "string", description: "Self-contained purpose/prompt for the child agent's first turn." },
        title: { type: "string", description: "Optional child thread title. Defaults to the purpose." }
      },
      required: ["role", "purpose"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_SPAWN_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const result = outcome.result;
      const childThreadId = result?.childThreadId ?? "unknown";
      const title = result?.title ?? params.title ?? params.purpose;
      return {
        content: [{ type: "text", text: "Spawned Workstream sub-thread " + childThreadId + ": " + title }],
        details: { ok: true, ...result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_set_status",
    label: "Set Workstream Status",
    description: "Set the workflow status of a T3 Code Workstream thread you own (this thread or a thread you directly spawned).",
    promptSnippet: "workstream_set_status: move a Workstream thread between planned, running, blocked, review, and done.",
    promptGuidelines: [
      "Use workstream_set_status to reflect real progress on your own thread or a child you spawned.",
      "Omit threadId to report your own status; you may only set status on your own thread or threads you directly parent."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to update; defaults to the calling thread when omitted." },
        status: { type: "string", enum: ["planned", "running", "blocked", "review", "done"], description: "New workflow status." }
      },
      required: ["status"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_STATUS_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const threadId = outcome.result?.threadId ?? params.threadId ?? "this thread";
      return {
        content: [{ type: "text", text: "Set Workstream thread " + threadId + " status to " + params.status + "." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_set_dependencies",
    label: "Set Workstream Dependencies",
    description: "Declare which threads a T3 Code Workstream thread waits on. Replaces the full blockedBy set for a thread you own (this thread or a thread you directly spawned).",
    promptSnippet: "workstream_set_dependencies: declare the threads a Workstream thread is blocked by (replace-set).",
    promptGuidelines: [
      "Use workstream_set_dependencies to declare 'waits-on' edges; blockedBy replaces the whole set each call.",
      "Omit threadId to declare your own dependencies; you may only set dependencies on your own thread or threads you directly parent."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to update; defaults to the calling thread when omitted." },
        blockedBy: { type: "array", items: { type: "string" }, description: "Full set of thread ids this thread waits on. Replaces any existing dependencies." }
      },
      required: ["blockedBy"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_DEPENDENCIES_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const count = Array.isArray(params.blockedBy) ? params.blockedBy.length : 0;
      const threadId = outcome.result?.threadId ?? params.threadId ?? "this thread";
      return {
        content: [{ type: "text", text: "Set Workstream thread " + threadId + " dependencies (" + count + " waits-on)." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });
}
`;

export function ensurePiWorkstreamSpawnExtension(stateDir: string): string {
  const extensionDir = join(stateDir, "pi-extensions");
  const extensionPath = join(extensionDir, EXTENSION_FILE);
  // Write unconditionally so edits to EXTENSION_SOURCE propagate to existing
  // state dirs (a one-time existsSync guard would pin stale tool code forever).
  mkdirSync(extensionDir, { recursive: true });
  writeFileSync(extensionPath, EXTENSION_SOURCE, "utf8");
  return extensionPath;
}
