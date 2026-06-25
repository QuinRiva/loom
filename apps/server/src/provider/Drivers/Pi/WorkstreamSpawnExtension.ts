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
    description: "Spawn a T3 Code Workstream sub-thread as a child of the current thread and assign it a role. Give it a short purpose (1-3 sentence summary shown in the sidebar) and, for non-trivial work, a full self-contained brief that becomes the child's first-turn prompt. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with blockedBy: [thatChildThreadId]. Model selection precedence: an explicit modelSelection wins; otherwise a named modelPreset is used; otherwise a preset matching the child's role (if one is configured) is used; otherwise the child inherits this thread's model.",
    promptSnippet: "workstream_spawn: launch a durable child T3 thread for delegated work; pass role, a short purpose, an optional full brief (the child's kickoff prompt; defaults to purpose), optional title, optional blockedBy (waits-on thread ids), and an optional model override (modelSelection or a named modelPreset; with neither, a preset named after the role is used when configured, else the parent's model is inherited).",
    promptGuidelines: [
      "Use workstream_spawn when you need a separate coder, reviewer, researcher, or other durable child thread to work independently.",
      "Keep purpose short — a 1-3 sentence human-readable summary of why the sub-thread exists; it is what the sidebar card shows and seeds the title.",
      "For anything beyond a trivial task, pass a full self-contained brief: it becomes the child's first-turn prompt verbatim, and the child starts fresh without inheriting this transcript. Omit brief only when the short purpose is already a sufficient prompt.",
      "To run work in order (e.g. a reviewer that waits on a coder), spawn the upstream child first, then spawn the dependent with blockedBy set to the upstream child's id.",
      "To run a child on a specific model, pass either modelSelection (a full selection) or modelPreset (a configured preset name). If you omit both, a preset whose name matches the child's role is used when one is configured, otherwise the child inherits this thread's model."
    ],
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role label for the child agent, e.g. coder, reviewer, researcher." },
        purpose: { type: "string", description: "Short (1-3 sentence) human-readable summary of why the sub-thread exists, shown in the sidebar. Required." },
        brief: { type: "string", description: "Full, self-contained prompt for the child's first turn (optional; defaults to purpose). Use this for the complete kickoff instructions so the short purpose stays a clean summary." },
        title: { type: "string", description: "Optional child thread title. Defaults to the purpose." },
        blockedBy: { type: "array", items: { type: "string" }, description: "Optional thread ids this child waits on. The child is created but does not start until every listed thread reaches 'done'." },
        modelPreset: { type: "string", description: "Optional named model preset to run the child on (resolved to a configured ModelSelection on the server). Preset names are deployment-specific. Ignored when modelSelection is given; an unknown name is rejected. When both modelSelection and modelPreset are omitted, a preset whose name matches the child's role is used if configured, otherwise the parent's model is inherited." },
        modelSelection: {
          type: "object",
          description: "Optional explicit model override for the child. Takes precedence over modelPreset and the role default. Omit to fall back to modelPreset, the role preset, or this thread's model.",
          properties: {
            instanceId: { type: "string", description: "Configured provider instance id to route to." },
            model: { type: "string", description: "Model slug for that instance." },
            options: {
              type: "array",
              description: "Optional per-model options, e.g. thinking level.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: ["string", "boolean"] }
                },
                required: ["id", "value"],
                additionalProperties: false
              }
            }
          },
          required: ["instanceId", "model"],
          additionalProperties: false
        }
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
    name: "workstream_report",
    label: "Report Workstream Result",
    description: "Record a deliberate markdown handoff of what this T3 Code Workstream sub-thread wants to communicate back to its parent orchestrator (not your whole transcript). The report is stored and shown to the parent when it is woken on your completion. Call this just before marking yourself 'done', 'review', or 'blocked'.",
    promptSnippet: "workstream_report: hand a concise markdown result back to your parent orchestrator before you finish.",
    promptGuidelines: [
      "Write a self-contained markdown summary: what you did, key results/decisions, and anything the parent must act on.",
      "Call workstream_report before workstream_set_status so the parent sees your report when it is woken.",
      "Keep it a deliberate handoff, not a transcript dump."
    ],
    parameters: {
      type: "object",
      properties: {
        markdown: { type: "string", description: "The markdown report to hand back to the parent orchestrator." }
      },
      required: ["markdown"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_REPORT_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      return {
        content: [{ type: "text", text: "Recorded Workstream report for the parent orchestrator." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_set_dependencies",
    label: "Set Workstream Dependencies",
    description: "Declare which threads a T3 Code Workstream thread waits on. Replaces the full blockedBy set for a thread you own (this thread or a thread you directly spawned). This is a re-planning operation: it re-gates a not-yet-started thread, but a thread that has already started running is never un-run — the edge is recorded for display only. To gate a child's execution from the start, pass blockedBy at spawn time instead.",
    promptSnippet: "workstream_set_dependencies: declare the threads a Workstream thread is blocked by (replace-set, re-planning only).",
    promptGuidelines: [
      "Use workstream_set_dependencies to declare 'waits-on' edges; blockedBy replaces the whole set each call.",
      "To actually defer a child's start until its dependencies finish, set blockedBy when you spawn it; setting dependencies after a thread is already running does not stop it.",
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
