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
    description: "Spawn a T3 Code Workstream sub-thread as a child of the current thread and assign it a role. Give it a short purpose (1-3 sentence summary shown in the sidebar) and, for non-trivial work, a full self-contained brief that becomes the child's first-turn prompt. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with blockedBy: [thatChildThreadId].",
    promptSnippet: "workstream_spawn: launch a durable child T3 thread for delegated work; pass role, a short purpose, an optional full brief (the child's kickoff prompt; defaults to purpose), optional title, optional blockedBy (waits-on thread ids), and optional modelSelection.",
    promptGuidelines: [
      "Use workstream_spawn when you need a separate coder, reviewer, researcher, or other durable child thread to work independently.",
      "Keep purpose short — a 1-3 sentence human-readable summary of why the sub-thread exists; it is what the sidebar card shows and seeds the title.",
      "For anything beyond a trivial task, pass a full self-contained brief: it becomes the child's first-turn prompt verbatim, and the child starts fresh without inheriting this transcript. Omit brief only when the short purpose is already a sufficient prompt.",
      "To run work in order (e.g. a reviewer that waits on a coder), spawn the upstream child first, then spawn the dependent with blockedBy set to the upstream child's id.",
      "Pass modelSelection only to run a child on a different model/thinking level than this thread; omit it to inherit this thread's model."
    ],
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role label for the child agent, e.g. coder, reviewer, researcher." },
        purpose: { type: "string", description: "Short (1-3 sentence) human-readable summary of why the sub-thread exists, shown in the sidebar. Required." },
        brief: { type: "string", description: "Full, self-contained prompt for the child's first turn (optional; defaults to purpose). Use this for the complete kickoff instructions so the short purpose stays a clean summary." },
        title: { type: "string", description: "Optional child thread title. Defaults to the purpose." },
        blockedBy: { type: "array", items: { type: "string" }, description: "Optional thread ids this child waits on. The child is created but does not start until every listed thread reaches 'done'." },
        modelSelection: {
          type: "object",
          description: "Optional model override for the child. Omit to inherit this thread's model.",
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

  pi.registerTool({
    name: "workstream_list",
    label: "List Workstream",
    description: "List your workstream: the whole graph of threads in your orchestration tree (every thread's id, role, title, status, spawn generation, parent, whether it has filed a report) plus lineage and waits-on edges. This is how you discover the ids of sibling/other threads you were not handed directly, so you can then read_thread or ask_thread them.",
    promptSnippet: "workstream_list: see your whole workstream graph (thread ids, roles, statuses, edges) to discover threads you can read or ask.",
    promptGuidelines: [
      "Call workstream_list first when you need to coordinate with another thread but only know it exists, not its id.",
      "The returned tree is exactly the scope you can read_thread / ask_thread — you can only inspect threads in your own workstream."
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_LIST_URL, params ?? {}, signal);
      if (!outcome.ok) return outcome.error;
      const nodes = Array.isArray(outcome.result?.nodes) ? outcome.result.nodes : [];
      return {
        content: [{ type: "text", text: "Your workstream has " + nodes.length + " thread(s). See details for the graph." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_read_thread",
    label: "Read Workstream Thread",
    description: "Read another thread in your workstream: its filed report (markdown), role/title/status, whether it has a report, and a compact recent-activity summary (last assistant message + recent activity rows). No model call — this is a passive pull. Works on siblings and on finished/archived threads (archived targets return report + metadata without the activity summary). Use workstream_list first to find the threadId.",
    promptSnippet: "workstream_read_thread: pull another workstream thread's report + metadata (no model call).",
    promptGuidelines: [
      "Use read_thread to get a thread's filed report and recent state without re-running it.",
      "If the thread filed no report you still get its metadata and last output — it never errors empty."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the workstream thread to read (from workstream_list)." }
      },
      required: ["threadId"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_READ_THREAD_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const result = outcome.result ?? {};
      const parts = [];
      if (result.report) parts.push(result.report);
      else parts.push("(" + (result.role ?? "thread") + " " + (result.threadId ?? params.threadId) + " — " + (result.status ?? "unknown") + "; no report filed)");
      return {
        content: [{ type: "text", text: parts.join("\n\n") }],
        details: { ok: true, ...result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_ask_thread",
    label: "Ask Workstream Thread",
    description: "Ask another thread in your workstream a question, answered from a READ-ONLY frozen fork of that thread's session. It never resumes or mutates the target — the fork is a throwaway with no write/command tools and no workstream access, so it cannot change anything. Use this to get clarifying answers from a sibling/child that has the relevant context. If that thread's context does not resolve your question, the answer says so rather than guessing. Use workstream_list first to find the threadId.",
    promptSnippet: "workstream_ask_thread: ask another workstream thread a read-only question, answered from a frozen fork of its session.",
    promptGuidelines: [
      "Use ask_thread when you need a thread's reasoning/knowledge, not just its report — it consults a read-only fork of its session.",
      "It cannot mutate the target; treat the answer as advisory and expect an honest 'not resolved' when the session lacks the context."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the workstream thread to ask (from workstream_list)." },
        question: { type: "string", description: "The question to answer from the target thread's frozen session context." }
      },
      required: ["threadId", "question"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_ASK_THREAD_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const answer = outcome.result?.answer ?? "(no answer)";
      return {
        content: [{ type: "text", text: answer }],
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
