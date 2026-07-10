// LOOM-ONLY. Typed tool-definition tables for the pi provider extension. Each
// tool's metadata (description, prompt snippet, guidelines, JSON-schema
// parameters) lives here as data instead of being embedded in a template
// string, so it type-checks and is testable. The generator
// (providerToolExtension.ts) serialises these + the shared path table into one
// runnable `.mjs` extension whose runtime is a generic POST-and-print shim.

import { PROVIDER_TOOL_PATHS, type ProviderToolName } from "../../../mcp/toolPaths.ts";

export interface ProviderToolDef {
  readonly name: ProviderToolName;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: ReadonlyArray<string>;
  /** JSON schema, verbatim from the historical extension source. */
  readonly parameters: Record<string, unknown>;
  /**
   * Error surface: "throw" makes a non-2xx a real pi tool error (the workstream
   * tools' documented requirement — a decider rejection must reach the model as
   * a failed call); "soft" returns error content (the goal tools' current
   * behaviour). Preserved per-tool, exactly as today.
   */
  readonly errorMode: "throw" | "soft";
  /**
   * Fallback text when the server response carries no `rendered` field — a
   * defensive one-liner only; the server render is the source of truth.
   */
  readonly fallbackText?: string;
}

export const WORKSTREAM_TOOL_DEFS: ReadonlyArray<ProviderToolDef> = [
  {
    name: "workstream_spawn",
    label: "Spawn Workstream Sub-thread",
    description:
      "Spawn a T3 Code Workstream sub-thread as a child of the current thread. Identify the work with three distinct fields: a role (e.g. coder, reviewer), a short title (the card's name — roughly ≤6 words, leading with the distinguishing subject rather than a verb every sibling shares), and a purpose (1-3 sentences, shown on the sidebar card as the thread's 'Goal') that states the value the work delivers — the capability, fix, or decision it produces, NOT the role or the mechanical steps. Put the full instructions in brief instead. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with gate: { rework: thatChildThreadId }; gate.rework is automatically added to blockedBy. Model selection precedence: an explicit modelSelection wins; otherwise a named modelPreset is used; otherwise a preset matching the child's role (if one is configured) is used; otherwise the child inherits this thread's model. An explicit modelSelection is validated at spawn against the configured provider instances: an unknown instanceId (or unknown model slug) is rejected immediately with the list of valid instances and nothing is created — so prefer modelPreset, or omit both to inherit, rather than guessing ids from another environment. Call workstream_list to see the valid instances, model slugs, and preset names (its modelCatalogue / modelPresets).",
    promptSnippet:
      "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override.",
    promptGuidelines: [
      "Name the work with three distinct fields: title is a short label (the card name, ≤6 words), purpose is the one-sentence why (the card's Goal), and brief is the full self-contained instructions. Titles are read in role-labelled lists, so lead with the distinguishing subject, not a verb every sibling shares — 'Receipt-dedup merge', not 'Implement receipt-dedup merge'.",
      "To run work in order (e.g. a reviewer that waits on a coder), spawn the upstream child first, then spawn the dependent with blockedBy set to the upstream child's id.",
      "To run a child on a specific model, pass either modelSelection (a full selection) or modelPreset (a configured preset name). If you omit both, a preset whose name matches the child's role is used when one is configured, otherwise the child inherits this thread's model.",
      "By default a spawned child is released and runs once its dependencies clear. Pass staged: true to create it held (planned) instead — use this to lay out a whole graph for review before any tokens are spent, then workstream_release the held subtree to let it run.",
      "To put a coder under review, spawn the coder first, then spawn a reviewer with gate: { rework: coderId }. gate.rework is automatically added to blockedBy, so the reviewer waits for the coder before running. The review loop then runs in the control plane without you — 'needs_rework' loops the coder (round-capped, default 2), 'clean'/'fixed_inline' resolve the gate and complete both threads. Wire downstream work on the reviewer (or both), never the coder alone: a rework round can reopen the coder's done. You are woken once at gate resolution, or earlier if the gate yields (round cap, approach wrong).",
    ],
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "Role label for the child agent, e.g. coder, reviewer, researcher.",
        },
        purpose: {
          type: "string",
          description:
            "Short (1-3 sentence) summary shown on the sidebar card as the thread's 'Goal'. State the value/outcome the work delivers — why it matters and how to judge it — not the mechanical actions. The role badge already conveys that (e.g.) code is being written, so do not restate the role or lead with 'Implement…'/'Review…'; lead with the capability, fix, or decision the work produces. Put the detailed instructions in brief. Required.",
        },
        brief: {
          type: "string",
          description:
            "Full, self-contained prompt for the child's first turn (optional; defaults to purpose). Use this for the complete kickoff instructions so the short purpose stays a clean summary.",
        },
        title: {
          type: "string",
          description:
            "Short label naming the work at a glance — the card's bold name, roughly ≤6 words. Titles appear in lists already labelled with the role, so lead with the distinguishing subject rather than a verb shared by every sibling: 'Receipt-dedup merge', not 'Implement receipt-dedup merge'; a specific verb is fine when it carries meaning ('Fix spawn title fallback'). Distinct from purpose, which is the one-sentence why. Required.",
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional thread ids this child waits on. The child is created but does not start until every listed thread reaches 'done'.",
        },
        gate: {
          type: "object",
          description:
            "Declare a review gate on this child (typically a reviewer): rework names the sibling whose work it verifies. The child's workstream_submit outcomes then route in the control plane — 'needs_rework' loops that sibling for rework (round-capped), 'clean'/'fixed_inline' resolve the gate and complete both threads. gate.rework is automatically added to blockedBy so the review starts after the work completes.",
          properties: {
            rework: {
              type: "string",
              description:
                "Thread id of the sibling this gate loops rework back to (the coder under review). Must be a thread you directly parent.",
            },
            maxRounds: {
              type: "number",
              description:
                "Maximum rework loops before the gate yields to you instead of looping again. Default 2.",
            },
          },
          required: ["rework"],
          additionalProperties: false,
        },
        staged: {
          type: "boolean",
          description:
            "Create the child held (plan lane 'planned') instead of released. Default false → 'ready', which runs once dependencies clear. Set true to stage a graph for review before any tokens are spent; release it later with workstream_release.",
        },
        isolation: {
          type: "string",
          enum: ["isolated", "shared"],
          description:
            "Worktree isolation for the child. Omit to take the role default (writers — coder/planner/free-text — are 'isolated'; readers — researcher/reviewer/shipper — are 'shared'). 'isolated' gives the child its own worktree + branch that is merged back into this thread's branch on completion, so its diffs are exactly its own edits and a dependent starts from a tree already containing its output; 'shared' runs the child in this thread's worktree (no fan-in). A gated reviewer always joins the coder's worktree regardless.",
        },
        modelPreset: {
          type: "string",
          description:
            "Optional named model preset to run the child on (resolved to a configured ModelSelection on the server). Preset names are deployment-specific — see modelPresets in workstream_list. Ignored when modelSelection is given; an unknown name is rejected with the available names. When both modelSelection and modelPreset are omitted, a preset whose name matches the child's role is used if configured, otherwise the parent's model is inherited. Prefer this over modelSelection to avoid guessing instance ids/model slugs.",
        },
        modelSelection: {
          type: "object",
          description:
            "Optional explicit model override for the child. Takes precedence over modelPreset and the role default. Omit to fall back to modelPreset, the role preset, or this thread's model.",
          properties: {
            instanceId: {
              type: "string",
              description:
                "Configured provider instance id to route to. Must be a configured instance in this build (see workstream_list modelCatalogue) — an unknown id is rejected at spawn.",
            },
            model: {
              type: "string",
              description:
                "Model slug for that instance (see the instance's entry in workstream_list modelCatalogue).",
            },
            options: {
              type: "array",
              description: "Optional per-model options, e.g. thinking level.",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  value: { type: ["string", "boolean"] },
                },
                required: ["id", "value"],
                additionalProperties: false,
              },
            },
          },
          required: ["instanceId", "model"],
          additionalProperties: false,
        },
      },
      required: ["role", "purpose", "title"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Spawned Workstream sub-thread.",
  },
  {
    name: "workstream_set_lane",
    label: "Set Workstream Plan Lane",
    description:
      "Advance the PLAN of a T3 Code Workstream thread you own (this thread or one you directly spawned) along its lifecycle: planned (held) → ready (released) → done, or cancelled. 'done' is the only lane that releases dependents and lets the next thread start; 'cancelled' abandons the work and does NOT release dependents — and it CASCADES: cancelling a thread also cancels every non-terminal descendant (children, grandchildren, …) and interrupts any in-flight turn among them, so cancelling a runaway branch kills the whole chain beneath it (already-done descendants are left untouched). 'in_progress' is set automatically when a turn starts and is never settable here. This is the PLAN axis only — to flag that a human is needed, use workstream_request_attention instead.",
    promptSnippet:
      "advance a Workstream thread's plan lane (planned/ready/done/cancelled). 'done' releases dependents; 'cancelled' cascades to the whole subtree and stops in-flight turns; 'in_progress' is automatic.",
    promptGuidelines: [
      "Do NOT set 'done' to complete your own work — finish with workstream_submit, which records your report and advances your lane. Setting 'done' directly is for a parent accepting a child's output (on a gated reviewer it dissolves the gate; on a gated CODER mid-rework it does NOT — the coder's next submit still routes to the reviewer, and only a reviewer-side done/cancelled dissolves the gate). Set 'cancelled' to abandon work (dependents stay blocked); cancelling cascades to the entire subtree below the target and interrupts any running turns, so one cancel kills a runaway branch.",
      "Use 'ready'/'planned' to release or hold staged work. Omit threadId to advance your own plan; you may only set the lane on your own thread or threads you directly parent.",
      "This is the plan axis. If you cannot proceed without a human, or your output needs sign-off, do not park the lane — raise attention with workstream_request_attention.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Id of the thread to update; defaults to the calling thread when omitted.",
        },
        planLane: {
          type: "string",
          enum: ["planned", "ready", "done", "cancelled"],
          description:
            "New plan lane. 'done' releases dependents; 'cancelled' abandons (does not release) and cascades — it also cancels every non-terminal descendant and interrupts their in-flight turns, leaving already-done descendants untouched. 'in_progress' is control-plane-only and not settable.",
        },
      },
      required: ["planLane"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Set Workstream plan lane.",
  },
  {
    name: "workstream_request_attention",
    label: "Request Workstream Attention",
    description:
      "Raise an attention flag on a T3 Code Workstream thread you own (this thread or one you directly spawned) — the single surface that pulls in a human. Two reasons: 'awaiting_acceptance' means a human (or the parent acting for the human) must accept this thread's output before its plan may reach 'done' and its dependents release — it is NOT 'some reviewer thread should look at this' (a thread whose output flows to a separate reviewer thread just goes 'done', which releases that reviewer). 'needs_guidance' means you cannot proceed without a human. The flag clears automatically when the thread resumes or reaches done/cancelled.",
    promptSnippet:
      "flag that a human is needed — 'awaiting_acceptance' (your output needs sign-off before done) or 'needs_guidance' (you're stuck).",
    promptGuidelines: [
      "Raise 'awaiting_acceptance' only when a HUMAN must accept your output before completion — not merely because a reviewer thread exists (that case is just 'done', which releases the reviewer).",
      "Raise 'needs_guidance' when you genuinely cannot proceed without a human. Don't sit silently halted — either advance the plan, or raise attention.",
      "Omit threadId to flag your own thread; you may only raise attention on your own thread or threads you directly parent.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Id of the thread to flag; defaults to the calling thread when omitted.",
        },
        reason: {
          type: "string",
          enum: ["awaiting_acceptance", "needs_guidance"],
          description:
            "Why a human is needed: 'awaiting_acceptance' (output needs human sign-off before done) or 'needs_guidance' (cannot proceed without a human).",
        },
      },
      required: ["reason"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Flagged Workstream thread for attention.",
  },
  {
    name: "workstream_release",
    label: "Release Workstream Subtree",
    description:
      "Release a held (staged) Workstream subtree: flip every 'planned' node in the target thread's subtree to 'ready' so it runs once its dependencies clear. Use this after laying out a graph with staged spawns and reviewing the work breakdown. The result names exactly which nodes were flipped so an intentional mixed-hold is not silently erased. Default target is your own subtree.",
    promptSnippet:
      "flip a held (planned) subtree to ready so it starts running; reports which nodes were released.",
    promptGuidelines: [
      "Use workstream_release once you've reviewed a staged graph and want it to run. Only 'planned' nodes in the subtree are flipped; already-released/running nodes are untouched.",
      "Omit threadId to release your own subtree; you may only release your own thread or a thread you directly parent.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description:
            "Root of the subtree to release; defaults to the calling thread when omitted.",
        },
      },
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Released Workstream subtree.",
  },
  {
    name: "workstream_stop",
    label: "Stop Workstream Child",
    description:
      "Stop a direct child Workstream thread you spawned: interrupt its active turn and pause it, leaving its plan lane 'in_progress'. This is an ORCHESTRATOR pause — you own restarting it (resume it with workstream_prompt). No attention flag is raised, because you are the resumer; if you forget to resume, the idle backstop surfaces it for a human after a grace window.",
    promptSnippet:
      "interrupt a direct child's active turn (orchestrator pause; you own the resume via workstream_prompt).",
    promptGuidelines: [
      "Use workstream_stop to pause a child you intend to redirect or resume yourself. To resume, send it a message with workstream_prompt (the next turn continues).",
      "This is for direct children only. A human stop from the board raises needs_guidance instead, because no agent owns the resume.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the direct child thread to stop." },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Stopped Workstream child.",
  },
  {
    name: "workstream_prompt",
    label: "Prompt Workstream Child",
    description:
      "Send a markdown message to a DIRECT child Workstream thread you spawned. On an idle child (e.g. one you paused with workstream_stop) this starts the next turn with your message — the resume path. On a busy child with an open turn it becomes a queued steer, folded in between model rounds. A steer canNOT penetrate a blocked/hung tool call — if the child is stuck inside a tool call, workstream_stop it first, then workstream_prompt to restart it with guidance.",
    promptSnippet:
      "send a message to a direct child: resumes an idle child or steers a busy one (a steer won't penetrate a hung tool call — stop first, then prompt).",
    promptGuidelines: [
      "Use workstream_prompt to resume a child you stopped, redirect a running child, or feed it new information. Idle child → your message starts its next turn; busy child → queued steer folded between model rounds.",
      "A steer cannot interrupt a blocked/hung tool call. For a child stuck inside a tool call, call workstream_stop first, then workstream_prompt with guidance.",
      "This is for direct children only, and it is a plain message send — it does not change the child's plan lane. A done/cancelled child is rejected: re-open its lane with workstream_set_lane first, or spawn a new child.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Id of the direct child thread to prompt." },
        message: { type: "string", description: "The markdown message to send to the child." },
      },
      required: ["threadId", "message"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Sent prompt to Workstream child.",
  },
  {
    name: "workstream_submit",
    label: "Submit Workstream Work",
    description:
      "THE single terminal call for a T3 Code Workstream sub-thread: submit your markdown report plus a structured outcome, and the control plane derives what happens next — you never set your own lane at completion. Omit outcome (or pass 'done') for plain completion: the report is recorded and your plan advances to done in one step, releasing dependents. Pass outcome 'needs_human' to record the report and raise the needs_guidance flag instead (a human is pulled in; your lane is unchanged). Any other outcome token (e.g. 'rework_approach', or review verdicts like 'needs_rework'/'clean'/'fixed_inline' when you are in a review gate) is routed by the control plane; during an active rework round it routes back to the reviewer for re-verification, otherwise an outcome with no matching route YIELDS you to your live parent orchestrator with your report — escalation is the safe default, and you are NOT done in that case.",
    promptSnippet:
      "submit your report + outcome in one terminal call: plain completion → done; 'needs_human' → human flag; any other outcome → routed, with unmatched non-rework outcomes yielding to your orchestrator.",
    promptGuidelines: [
      "End your work with ONE call to workstream_submit: a self-contained markdown report (what you did, key results/decisions, anything the parent must act on — a deliberate handoff, not a transcript dump) plus an outcome. Do not call workstream_set_lane to finish.",
      "Plain success → omit outcome. Cannot proceed without a human → outcome 'needs_human'. Concluded with something other than plain success (approach wrong, blocked on a decision) → a short outcome token explaining it; the control plane hands you to your orchestrator.",
      "Read the tool result: it echoes the routing decision. 'yielded' or a rework route means you are NOT done yet.",
    ],
    parameters: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description:
            "The markdown report to hand back — stored on disk and shown to whoever receives your work next (parent orchestrator, or the gate counterpart in a review loop).",
        },
        outcome: {
          type: "string",
          description:
            "Structured outcome token. Omitted ⇒ 'done' (plain completion). Reserved: 'done', 'needs_human'. Review-gate verdicts (reviewers): 'clean', 'fixed_inline', 'needs_rework'. During an active rework round, any non-'needs_human' token routes back to the reviewer; otherwise any unmatched token yields you to the orchestrator — use a short snake_case token like 'rework_approach'.",
        },
        contested: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional: findings you reject, verbatim-quotable — preserved on the audit trail (opaque to routing).",
        },
        counts: {
          type: "object",
          description: "Optional reviewer finding counts for the verdict chip (opaque to routing).",
          properties: {
            mustFix: { type: "number", description: "Number of must-fix findings." },
            niceToHave: { type: "number", description: "Number of nice-to-have findings." },
          },
          required: ["mustFix", "niceToHave"],
          additionalProperties: false,
        },
      },
      required: ["markdown"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Work submitted.",
  },
  {
    name: "workstream_set_dependencies",
    label: "Set Workstream Dependencies",
    description:
      "Declare which threads a T3 Code Workstream thread waits on. Replaces the full blockedBy set for a thread you own (this thread or a thread you directly spawned). This is a re-planning operation: it re-gates a not-yet-started thread, but setting dependencies on an already-started thread returns a warning — the edge is recorded for display only and never un-runs the thread. To gate a child's execution from the start, pass blockedBy at spawn time instead.",
    promptSnippet:
      "adjust the blockedBy set of a not-yet-started thread (re-planning only; does not gate an already-started thread).",
    promptGuidelines: [
      "blockedBy replaces the whole set each call; to actually defer a child's start, set blockedBy at spawn time — setting dependencies after a thread is already running does not stop it.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Id of the thread to update; defaults to the calling thread when omitted.",
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Full set of thread ids this thread waits on. Replaces any existing dependencies.",
        },
      },
      required: ["blockedBy"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Set Workstream dependencies.",
  },
  {
    name: "workstream_list",
    label: "List Workstream",
    description:
      "List your workstream: the whole graph of threads in your orchestration tree (every node's id, role, title, plan lane, attention flags, spawn generation, parent, last-activity, and report/session file paths) plus lineage and waits-on edges. This is how you discover the ids of sibling/other threads you were not handed directly, so you can then consult them or read their report/session files.",
    promptSnippet:
      "see your whole workstream graph — ids, roles, plan lanes/attention, last-activity, report/session paths — to find any thread without searching.",
    promptGuidelines: [
      "Call workstream_list first when you need to coordinate with another thread but only know it exists, not its id; the returned tree is exactly your workstream scope.",
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false },
    errorMode: "throw",
    fallbackText: "Workstream: 0 thread(s).",
  },
  {
    name: "consult_thread",
    label: "Consult Thread (user-directed)",
    description:
      'GLOBAL read-only consult of another thread, answered from a frozen fork of that thread\'s session. It reaches ANY thread the server knows (across worktrees and projects), not just your workstream tree. Use it when the user points you at another thread — by name ("ask the liveness-detection thread …") or via an @-mention. Identify the target by exactly one of: threadId (preferred; an @-mentioned thread arrives in the message as [Title](thread://<id>) — pass that <id>), or name (a fuzzy sidebar-title match). If a name matches several threads it returns ranked candidates instead of guessing; surface them and confirm with the user, then call again with the chosen threadId. It never resumes or mutates the target.',
    promptSnippet:
      "ask another thread a read-only question (answered from a frozen fork) by id, @-mention, or name; never mutates it.",
    promptGuidelines: [
      "Prefer threadId: an @-mentioned thread arrives as [Title](thread://<id>); pass that exact <id>. Otherwise pass name for a fuzzy title match.",
      "If the result is unresolved with candidates, do not guess — confirm which thread was meant before consulting again with its threadId.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description:
            "Exact id of the target thread. Preferred when known (e.g. from an @-mention [Title](thread://<id>)). Provide threadId OR name, not both.",
        },
        name: {
          type: "string",
          description:
            "Fuzzy sidebar title/name of the target thread. Used when you don't have an exact id; an ambiguous name returns ranked candidates to confirm with the user.",
        },
        question: {
          type: "string",
          description: "The question to answer from the target thread's frozen session context.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "(no answer)",
  },
  {
    name: "set_thread_title",
    label: "Set Thread Title",
    description:
      "Rename THIS thread's own sidebar title in T3 Code. You pass only a title; the thread is always resolved from the session, so you can only ever rename yourself — never another thread or a child. Use it to keep the sidebar legible: e.g. when a root's auto-from-first-message title is unhelpful, or when a child's scope has sharpened into something more specific than its spawn title. This does not touch the goal (use goal_update for that).",
    promptSnippet: "rename this thread's own sidebar title to keep the workstream legible.",
    promptGuidelines: [
      "You never pass a thread id — this always renames the calling thread itself; renaming another thread is impossible.",
      "title must be a non-empty string. Set a clear, specific title when the current one is unhelpful or your scope has sharpened.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "The new sidebar title for this thread. Required; non-empty.",
        },
      },
      required: ["title"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Set this thread's title.",
  },
];

export const GOAL_TOOL_DEFS: ReadonlyArray<ProviderToolDef> = [
  {
    name: "goal_task_list",
    label: "List Goal Tasks",
    description:
      "Read the current task tree of THIS thread's active goal (the shared tree, resolved from the session — you never pass a goalId). Use it for orientation and reconciliation: the tree injected into your prompt is a snapshot from your spawn and is never refreshed, so a child may have marked its task done or added discovered work your snapshot does not reflect. This is a read — it mutates nothing. Errors cleanly if this thread has no active goal.",
    promptSnippet:
      "read this thread's active goal's current task tree (the shared tree) for orientation/reconciliation; mutates nothing.",
    promptGuidelines: [
      "You never pass a goalId — this always reads this thread's own active goal.",
      "The prompt-injected task tree is a frozen snapshot from your spawn; call this to see tasks a child has since added or completed.",
    ],
    parameters: { type: "object", properties: {}, additionalProperties: false },
    errorMode: "soft",
    fallbackText: "(no tasks yet)",
  },
  {
    name: "goal_task_add",
    label: "Add Goal Task",
    description:
      "Add a task to the task tree of THIS thread's active goal. The goal is resolved from the session — you never pass a goalId, and you can only ever mutate your own thread's goal. Use this to record new actionable work: an orchestrator keeps the tree current as work evolves; a child should add a discovered-but-out-of-scope actionable item (e.g. 'evaluate whether to fix pre-existing bug X') directly rather than only mentioning it in its report. Errors cleanly if this thread has no active goal.",
    promptSnippet: "add a task to this thread's goal task tree (optionally under a parent task).",
    promptGuidelines: [
      "You never pass a goalId — the task is always added to this thread's own active goal.",
      "Pass parentTaskId (a task id from this goal) to nest the new task under an existing one; omit it for a top-level task.",
    ],
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The task text. Required." },
        parentTaskId: {
          type: "string",
          description:
            "Optional id of an existing task in this goal to nest the new task under. Omit for a top-level task.",
        },
        position: {
          type: "integer",
          minimum: 0,
          description: "Optional zero-based position among siblings. Omit to append.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Added task.",
  },
  {
    name: "goal_task_update",
    label: "Update Goal Task",
    description:
      "Update an existing task in THIS thread's active goal: rename it (text), mark it done / reopen it (done), and/or reorder it (position). The goal is resolved from the session; the taskId must belong to it. A child may mark its OWN assigned task done when it finishes the work. Pass only the fields you want to change.",
    promptSnippet:
      "update a task in this thread's goal: rename (text), mark done/reopen (done), or reorder (position).",
    promptGuidelines: [
      "taskId must be a task in this thread's own active goal.",
      "Pass only the fields you are changing; provide at least one of text, done, or position.",
    ],
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Id of the task to update. Required; must belong to this thread's goal.",
        },
        text: { type: "string", description: "New task text (rename)." },
        done: { type: "boolean", description: "Mark the task done (true) or reopen it (false)." },
        position: {
          type: "integer",
          minimum: 0,
          description: "New zero-based position among its siblings.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Updated task.",
  },
  {
    name: "goal_task_delete",
    label: "Delete Goal Task",
    description:
      "Delete a task (and its subtree) from THIS thread's active goal. The goal is resolved from the session; the taskId must belong to it. Use sparingly — prefer marking a task done over deleting it; delete is for tasks that were created in error or are no longer meaningful.",
    promptSnippet: "delete a task (and its subtree) from this thread's goal.",
    promptGuidelines: [
      "taskId must be a task in this thread's own active goal.",
      "Prefer marking a task done over deleting it; delete is for tasks added in error or no longer meaningful.",
    ],
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Id of the task to delete. Required; must belong to this thread's goal.",
        },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Deleted task.",
  },
  {
    name: "goal_handoff",
    label: "Hand Off New Goal",
    description:
      "Hand off a separate, out-of-scope piece of work as its OWN new goal and a staged (held) root session. Use when you discover follow-up work that deserves to run independently rather than as a task under THIS goal. Creates a new goal in this thread's project and a parent-less session pre-loaded with your brief, then leaves it for the human to launch with a single send (which provisions a fresh worktree). Pass threadTitle to name the session's sidebar card — a short label leading with the distinguishing subject (defaults to the goal title). You never pass a goalId/projectId — both are inherited from this thread. Returns the new goalId + threadId.",
    promptSnippet:
      "hand off discovered out-of-scope work as a new goal + a staged root session pre-loaded with a brief.",
    promptGuidelines: [
      "Use this for genuinely separate work that should run concurrently in its own goal/session — not for tasks that belong under this thread's existing goal (use goal_task_add for those).",
      "The brief becomes the new session's first turn: write it as a complete, self-contained kickoff prompt, not a one-line summary.",
      "The session is created held; the human launches it. You do NOT start it and no worktree is provisioned until the human sends.",
      "Name the sidebar card with threadTitle: a short (≤6-word) label that leads with the distinguishing subject of the work, not a generic verb — 'Receipt-dedup migration', not 'Do the migration'. Omit it only when the goal title already reads well as the card.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "The new goal's title. Required." },
        brief: {
          type: "string",
          description:
            "The handoff/kickoff prompt that becomes the new session's first turn. Required; write it self-contained.",
        },
        description: { type: "string", description: "Optional short goal objective paragraph." },
        threadTitle: {
          type: "string",
          description:
            "Optional sidebar name for the staged root session: a short (≤6-word) label that leads with the distinguishing subject of the work rather than a generic verb. Defaults to the goal title when omitted.",
        },
      },
      required: ["title", "brief"],
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Handed off new goal.",
  },
  {
    name: "goal_update",
    label: "Update Goal",
    description:
      "Update the metadata of THIS thread's active goal: its title, description (the objective paragraph), and/or slug. The goal is resolved from the session — you never pass a goalId. Use this to keep the goal's framing accurate as understanding evolves. Pass only the fields you want to change.",
    promptSnippet: "update this thread's goal metadata (title / description / slug).",
    promptGuidelines: [
      "You never pass a goalId — this always updates this thread's own active goal.",
      "Pass only the fields you are changing; provide at least one of title, description, or slug.",
    ],
    parameters: {
      type: "object",
      properties: {
        title: { type: "string", description: "New goal title." },
        description: {
          type: "string",
          description: "New goal objective paragraph (may be empty to clear it).",
        },
        slug: { type: "string", description: "New stable goal slug." },
      },
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Updated goal.",
  },
];

/** Every provider tool def with its route path attached, ready to serialise. */
export interface ProviderToolDefWithPath extends ProviderToolDef {
  readonly path: string;
}

export const withPath = (def: ProviderToolDef): ProviderToolDefWithPath => ({
  ...def,
  path: PROVIDER_TOOL_PATHS[def.name],
});
