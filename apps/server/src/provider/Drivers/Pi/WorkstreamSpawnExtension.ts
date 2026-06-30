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
    description: "Spawn a T3 Code Workstream sub-thread as a child of the current thread. Identify the work with three distinct fields: a role (e.g. coder, reviewer), a short title (the card's name — an imperative label of roughly ≤6 words), and a purpose (1-3 sentences, shown on the sidebar card as the thread's 'Goal') that states the value the work delivers — the capability, fix, or decision it produces, NOT the role or the mechanical steps. Put the full instructions in brief instead. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with blockedBy: [thatChildThreadId]. Model selection precedence: an explicit modelSelection wins; otherwise a named modelPreset is used; otherwise a preset matching the child's role (if one is configured) is used; otherwise the child inherits this thread's model.",
    promptSnippet: "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override.",
    promptGuidelines: [
      "Name the work with three distinct fields: title is a short imperative label (the card name, ≤6 words), purpose is the one-sentence why (the card's Goal), and brief is the full self-contained instructions.",
      "To run work in order (e.g. a reviewer that waits on a coder), spawn the upstream child first, then spawn the dependent with blockedBy set to the upstream child's id.",
      "To run a child on a specific model, pass either modelSelection (a full selection) or modelPreset (a configured preset name). If you omit both, a preset whose name matches the child's role is used when one is configured, otherwise the child inherits this thread's model.",
      "By default a spawned child is released and runs once its dependencies clear. Pass staged: true to create it held (planned) instead — use this to lay out a whole DAG for review before any tokens are spent, then workstream_release the held subtree to let it run."
    ],
    parameters: {
      type: "object",
      properties: {
        role: { type: "string", description: "Role label for the child agent, e.g. coder, reviewer, researcher." },
        purpose: { type: "string", description: "Short (1-3 sentence) summary shown on the sidebar card as the thread's 'Goal'. State the value/outcome the work delivers — why it matters and how to judge it — not the mechanical actions. The role badge already conveys that (e.g.) code is being written, so do not restate the role or lead with 'Implement…'/'Review…'; lead with the capability, fix, or decision the work produces. Put the detailed instructions in brief. Required." },
        brief: { type: "string", description: "Full, self-contained prompt for the child's first turn (optional; defaults to purpose). Use this for the complete kickoff instructions so the short purpose stays a clean summary." },
        title: { type: "string", description: "Short imperative label naming the work at a glance — the card's bold name, roughly ≤6 words (e.g. 'Fix spawn title fallback'). Distinct from purpose, which is the one-sentence why. Required." },
        blockedBy: { type: "array", items: { type: "string" }, description: "Optional thread ids this child waits on. The child is created but does not start until every listed thread reaches 'done'." },
        staged: { type: "boolean", description: "Create the child held (plan lane 'planned') instead of released. Default false → 'ready', which runs once dependencies clear. Set true to stage a DAG for review before any tokens are spent; release it later with workstream_release." },
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
      required: ["role", "purpose", "title"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_SPAWN_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const result = outcome.result;
      const childThreadId = result?.childThreadId ?? "unknown";
      const title = result?.title ?? params.title;
      return {
        content: [{ type: "text", text: "Spawned Workstream sub-thread " + childThreadId + ": " + title }],
        details: { ok: true, ...result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_set_lane",
    label: "Set Workstream Plan Lane",
    description: "Advance the PLAN of a T3 Code Workstream thread you own (this thread or one you directly spawned) along its lifecycle: planned (held) → ready (released) → done, or cancelled. 'done' is the only lane that releases dependents and lets the next thread start; 'cancelled' abandons the work and does NOT release dependents — and it CASCADES: cancelling a thread also cancels every non-terminal descendant (children, grandchildren, …) and interrupts any in-flight turn among them, so cancelling a runaway branch kills the whole chain beneath it (already-done descendants are left untouched). 'in_progress' is set automatically when a turn starts and is never settable here. This is the PLAN axis only — to flag that a human is needed, use workstream_request_attention instead.",
    promptSnippet: "advance a Workstream thread's plan lane (planned/ready/done/cancelled). 'done' releases dependents; 'cancelled' cascades to the whole subtree and stops in-flight turns; 'in_progress' is automatic.",
    promptGuidelines: [
      "Set 'done' when the work is genuinely complete — it releases any dependents/reviewers. Set 'cancelled' to abandon work (dependents stay blocked); cancelling cascades to the entire subtree below the target and interrupts any running turns, so one cancel kills a runaway branch.",
      "Use 'ready'/'planned' to release or hold staged work. Omit threadId to advance your own plan; you may only set the lane on your own thread or threads you directly parent.",
      "This is the plan axis. If you cannot proceed without a human, or your output needs sign-off, do not park the lane — raise attention with workstream_request_attention."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to update; defaults to the calling thread when omitted." },
        planLane: { type: "string", enum: ["planned", "ready", "done", "cancelled"], description: "New plan lane. 'done' releases dependents; 'cancelled' abandons (does not release) and cascades — it also cancels every non-terminal descendant and interrupts their in-flight turns, leaving already-done descendants untouched. 'in_progress' is control-plane-only and not settable." }
      },
      required: ["planLane"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_LANE_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const threadId = outcome.result?.threadId ?? params.threadId ?? "this thread";
      return {
        content: [{ type: "text", text: "Set Workstream thread " + threadId + " plan lane to " + params.planLane + "." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_request_attention",
    label: "Request Workstream Attention",
    description: "Raise an attention flag on a T3 Code Workstream thread you own (this thread or one you directly spawned) — the single surface that pulls in a human. Two reasons: 'awaiting_acceptance' means a human (or the parent acting for the human) must accept this thread's output before its plan may reach 'done' and its dependents release — it is NOT 'some reviewer thread should look at this' (a thread whose output flows to a separate reviewer thread just goes 'done', which releases that reviewer). 'needs_guidance' means you cannot proceed without a human. The flag clears automatically when the thread resumes or reaches done/cancelled.",
    promptSnippet: "flag that a human is needed — 'awaiting_acceptance' (your output needs sign-off before done) or 'needs_guidance' (you're stuck).",
    promptGuidelines: [
      "Raise 'awaiting_acceptance' only when a HUMAN must accept your output before completion — not merely because a reviewer thread exists (that case is just 'done', which releases the reviewer).",
      "Raise 'needs_guidance' when you genuinely cannot proceed without a human. Don't sit silently halted — either advance the plan, or raise attention.",
      "Omit threadId to flag your own thread; you may only raise attention on your own thread or threads you directly parent."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the thread to flag; defaults to the calling thread when omitted." },
        reason: { type: "string", enum: ["awaiting_acceptance", "needs_guidance"], description: "Why a human is needed: 'awaiting_acceptance' (output needs human sign-off before done) or 'needs_guidance' (cannot proceed without a human)." }
      },
      required: ["reason"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_ATTENTION_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const threadId = outcome.result?.threadId ?? params.threadId ?? "this thread";
      return {
        content: [{ type: "text", text: "Flagged Workstream thread " + threadId + " for attention: " + params.reason + "." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_release",
    label: "Release Workstream Subtree",
    description: "Release a held (staged) Workstream subtree: flip every 'planned' node in the target thread's subtree to 'ready' so it runs once its dependencies clear. Use this after laying out a DAG with staged spawns and reviewing the work breakdown. The result names exactly which nodes were flipped so an intentional mixed-hold is not silently erased. Default target is your own subtree.",
    promptSnippet: "flip a held (planned) subtree to ready so it starts running; reports which nodes were released.",
    promptGuidelines: [
      "Use workstream_release once you've reviewed a staged DAG and want it to run. Only 'planned' nodes in the subtree are flipped; already-released/running nodes are untouched.",
      "Omit threadId to release your own subtree; you may only release your own thread or a thread you directly parent."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Root of the subtree to release; defaults to the calling thread when omitted." }
      },
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_RELEASE_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const released = Array.isArray(outcome.result?.released) ? outcome.result.released : [];
      const text = released.length > 0
        ? "Released " + released.length + " held sub-thread(s): " + released.join(", ") + "."
        : "No held (planned) sub-threads to release in that subtree.";
      return { content: [{ type: "text", text }], details: { ok: true, ...outcome.result } };
    }
  });

  pi.registerTool({
    name: "workstream_stop",
    label: "Stop Workstream Child",
    description: "Stop a direct child Workstream thread you spawned: interrupt its active turn and pause it, leaving its plan lane 'in_progress'. This is an ORCHESTRATOR pause — you own restarting it (send it a prompt to resume). No attention flag is raised, because you are the resumer; if you forget to resume, the idle backstop surfaces it for a human after a grace window.",
    promptSnippet: "interrupt a direct child's active turn (orchestrator pause; you own the resume).",
    promptGuidelines: [
      "Use workstream_stop to pause a child you intend to redirect or resume yourself. To resume, just send it a prompt (the next turn continues).",
      "This is for direct children only. A human stop from the board raises needs_guidance instead, because no agent owns the resume."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the direct child thread to stop." }
      },
      required: ["threadId"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_STOP_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const threadId = outcome.result?.threadId ?? params.threadId;
      return {
        content: [{ type: "text", text: "Stopped Workstream child " + threadId + " (paused, lane stays in_progress — resume by sending it a prompt)." }],
        details: { ok: true, ...outcome.result }
      };
    }
  });

  pi.registerTool({
    name: "workstream_report",
    label: "Report Workstream Result",
    description: "Record a deliberate markdown handoff of what this T3 Code Workstream sub-thread wants to communicate back to its parent orchestrator (not your whole transcript). The report is stored and shown to the parent when it is woken on your completion. Call this just before you advance your plan lane (e.g. to 'done') or raise attention.",
    promptSnippet: "hand a concise markdown result back to your parent before you finish.",
    promptGuidelines: [
      "Write a self-contained markdown summary: what you did, key results/decisions, and anything the parent must act on.",
      "Call workstream_report before you advance your plan lane (workstream_set_lane) or raise attention so the parent sees your report when it is woken.",
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
    promptSnippet: "adjust the blockedBy set of a not-yet-started thread (re-planning only; does not gate an already-started thread).",
    promptGuidelines: [
      "blockedBy replaces the whole set each call; to actually defer a child's start, set blockedBy at spawn time — setting dependencies after a thread is already running does not stop it."
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
    description: "List your workstream: the whole graph of threads in your orchestration tree (every node's id, role, title, plan lane, attention flags, spawn generation, parent, last-activity, and report/session file paths) plus lineage and waits-on edges. This is how you discover the ids of sibling/other threads you were not handed directly, so you can then consult them or read their report/session files.",
    promptSnippet: "see your whole workstream graph — ids, roles, plan lanes/attention, last-activity, report/session paths — to find any thread without searching.",
    promptGuidelines: [
      "Call workstream_list first when you need to coordinate with another thread but only know it exists, not its id; the returned tree is exactly your workstream scope."
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
    name: "consult_thread",
    label: "Consult Thread (user-directed)",
    description: "GLOBAL read-only consult of another thread, answered from a frozen fork of that thread's session. It reaches ANY thread the server knows (across worktrees and projects), not just your workstream tree. Use it when the user points you at another thread — by name (\"ask the liveness-detection thread …\") or via an @-mention. Identify the target by exactly one of: threadId (preferred; an @-mentioned thread arrives in the message as [Title](thread://<id>) — pass that <id>), or name (a fuzzy sidebar-title match). If a name matches several threads it returns ranked candidates instead of guessing; surface them and confirm with the user, then call again with the chosen threadId. It never resumes or mutates the target.",
    promptSnippet: "ask another thread a read-only question (answered from a frozen fork) by id, @-mention, or name; never mutates it.",
    promptGuidelines: [
      "Prefer threadId: an @-mentioned thread arrives as [Title](thread://<id>); pass that exact <id>. Otherwise pass name for a fuzzy title match.",
      "If the result is unresolved with candidates, do not guess — confirm which thread was meant before consulting again with its threadId."
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Exact id of the target thread. Preferred when known (e.g. from an @-mention [Title](thread://<id>)). Provide threadId OR name, not both." },
        name: { type: "string", description: "Fuzzy sidebar title/name of the target thread. Used when you don't have an exact id; an ambiguous name returns ranked candidates to confirm with the user." },
        question: { type: "string", description: "The question to answer from the target thread's frozen session context." }
      },
      required: ["question"],
      additionalProperties: false
    },
    async execute(_id, params, signal) {
      const outcome = await callWorkstreamEndpoint(process.env.T3_WORKSTREAM_CONSULT_THREAD_URL, params, signal);
      if (!outcome.ok) return outcome.error;
      const result = outcome.result ?? {};
      if (result.resolved === false) {
        const candidates = Array.isArray(result.candidates) ? result.candidates : [];
        const lines = candidates.map((candidate) =>
          "- " + (candidate.title ?? "(untitled)") + " — " + (candidate.role ?? "thread") + ", " + (candidate.planLane ?? "unknown") +
          (candidate.worktreePath ? " [" + candidate.worktreePath + "]" : "") + " (threadId: " + candidate.threadId + ")"
        );
        const text = candidates.length > 0
          ? "Multiple threads match that name. Confirm which one with the user, then call consult_thread again with its threadId:\n" + lines.join("\n")
          : "No matching thread was found.";
        return { content: [{ type: "text", text }], details: { ok: true, ...result } };
      }
      const answer = result.answer ?? "(no answer)";
      return {
        content: [{ type: "text", text: answer }],
        details: { ok: true, ...result }
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
