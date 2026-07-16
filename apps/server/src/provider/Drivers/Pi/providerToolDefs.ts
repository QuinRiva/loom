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
      "Spawn a T3 Code Workstream sub-thread as a child of the current thread. Identify the work with three distinct fields: a role (e.g. coder, reviewer), a short title (the card's name — roughly ≤6 words, leading with the distinguishing subject rather than a verb every sibling shares), and a purpose (1-3 sentences, shown on the sidebar card as the thread's 'Goal') that states the value the work delivers — the capability, fix, or decision it produces, NOT the role or the mechanical steps. Put the full instructions in brief instead. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with gate: { rework: thatChildThreadId }; gate.rework is automatically added to blockedBy. Model choice: for most spawns, pass NO model fields — the child takes a preset matching its role, or inherits this thread's model. Only when the task clearly matches one of three shapes should you pass taskShape ('explore' / 'thorough' / 'mechanical'), a single token the server resolves to a concrete model (never pick a model by name). modelSelection / modelPreset are escape hatches for the rare case you genuinely need a specific model. Full precedence: explicit modelSelection > modelPreset > taskShape > role preset > inherit this thread's model. A valid taskShape on a server with no matching profiles simply falls through to the role preset/inherit with a warning (never an error). Call workstream_list to see the task-shape vocabulary, profiles, presets, and the instance/model catalogue. For laying out a MULTI-NODE graph (or when you want a human to review the solution shape before paying for briefs), prefer workstream_scaffold + workstream_brief: scaffold defines the whole topology by symbolic key in one cheap call, then briefs are written just-in-time. workstream_spawn is the one-node shortcut (scaffold-one-node + brief in a single call).",
    promptSnippet:
      "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override. For a multi-node graph prefer workstream_scaffold + workstream_brief.",
    promptGuidelines: [
      "Name the work with three distinct fields: title is a short label (the card name, ≤6 words), purpose is the one-sentence why (the card's Goal), and brief is the full self-contained instructions. Titles are read in role-labelled lists, so lead with the distinguishing subject, not a verb every sibling shares — 'Receipt-dedup merge', not 'Implement receipt-dedup merge'.",
      "To run work in order (e.g. a reviewer that waits on a coder), spawn the upstream child first, then spawn the dependent with blockedBy set to the upstream child's id.",
      "For most spawns omit every model field — the child takes a role-matched preset or inherits this thread's model; that is the normal path. Reach for taskShape only when the work materially fits one of three shapes: 'explore' (open-ended/prototype, vague objective, plan likely to change), 'thorough' (edge cases, migrations, hardening, review gates — missing a real issue is worse than noise), or 'mechanical' (bounded, self-contained, high-volume: extraction, renames, formatting). The server then picks the model — don't guess model names. Add sensitive: 'security' on security/crypto/bio-adjacent work so the resolver avoids models whose safety classifier would interrupt the run. modelSelection / modelPreset are escape hatches for genuine exceptions only.",
      "By default a spawned child is released and runs once its dependencies clear. Pass staged: true to create it held (planned) instead — use this to lay out a whole graph for review before any tokens are spent, then workstream_release the held subtree to let it run.",
      "To put a coder under review, spawn the coder first, then spawn a reviewer with gate: { rework: coderId }. gate.rework is automatically added to blockedBy, so the reviewer waits for the coder before running. The review loop then runs in the control plane without you — 'needs_rework' loops the coder (round-capped, default 2), 'clean'/'fixed_inline' resolve the gate and complete both threads. Wire downstream work on the reviewer (or both), never the coder alone: a rework round can reopen the coder's done. You are woken once at gate resolution, or earlier if the gate yields (round cap, approach wrong).",
      "When several children must analyse the SAME large corpus through different lenses, use forkFrom instead of re-reading it N times: spawn one reader child to read the corpus and end its turn with a bare acknowledgement, then spawn N children with forkFrom: readerId — each forks the reader's session (byte-identical prefix → provider cache hits + comparable verdicts) and its brief carries only its own lens. Don't pass role/model fields on a fork (identity is inherited); forkFrom auto-adds the reader to blockedBy; launch the forks together so they share the cache window.",
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
        forkFrom: {
          type: "string",
          description:
            "Fork this child's pi session from an existing active direct child (the 'source') at its first launch, so the child starts from a byte-identical copy of the source's transcript. Use it for acknowledge-then-fork fan-out: one reader child reads a large shared corpus and ends its turn with a bare acknowledgement, then you fork N children off it — each fork's brief carries only its differentiated lens/task. The identical prefix means provider prompt-cache hits on every fork and verdict comparability (the forks reason from literally the same context). Identity is INHERITED from the source: do NOT pass role / modelSelection / modelPreset / taskShape / sensitive (each is rejected, not ignored) — the fork adopts the source's role and applied model; purpose + title are still required per fork. forkFrom is auto-added to blockedBy (a fork waits for its source to finish). Cannot be combined with gate. Cache note: the cache is time-limited, so release/launch the forks together promptly — scattering their launches over hours forfeits the cache (correctness is unaffected). Worktree: prefer the default (shared) so the copied transcript's file paths stay valid; only use isolation:'isolated' if the forks write code (an isolated fork's copied transcript still references the source's worktree paths).",
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
        taskShape: {
          type: "string",
          enum: ["explore", "thorough", "mechanical"],
          description:
            "Optional. Omit it for most spawns (the child takes a role-matched preset or inherits this thread's model — the normal path). Pass a shape ONLY when the work materially fits one of these rows, and the server resolves a concrete model (no model-name guessing): 'explore' — open-ended/prototype work, vague objective, plan likely to change; 'thorough' — edge cases, migrations, hardening, review gates, anywhere missing a real issue is worse than noise; 'mechanical' — bounded, self-contained, high-volume work (extraction, renames, formatting), NOT long-context extraction (use 'thorough'). Overridden by modelSelection/modelPreset; ignored (with a warning) when either is also given. A valid shape with no matching server profiles falls through to the role preset/inherit — never an error.",
        },
        sensitive: {
          type: "string",
          enum: ["security"],
          description:
            "Optional sensitivity marker paired with taskShape. 'security' excludes models flagged unsuitable for security/crypto/bio-adjacent work (whose safety classifier can interrupt or reroute a run mid-flight). Use it whenever the child's task is security-adjacent.",
        },
        modelPreset: {
          type: "string",
          description:
            "Escape hatch for a genuine exception: a named model preset (resolved to a configured ModelSelection on the server), overriding taskShape. Preset names are deployment-specific — see modelPresets in workstream_list. Ignored when modelSelection is given; an unknown name is rejected with the available names. Most spawns should omit this and let the role preset / inherited model apply.",
        },
        modelSelection: {
          type: "object",
          description:
            "Escape hatch for a genuine exception: an explicit model override for the child, taking precedence over taskShape, modelPreset, and the role default. Most spawns should omit this (and taskShape) and let the role preset / inherited model apply. Omit to fall back to taskShape / modelPreset / the role preset / this thread's model.",
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
    name: "workstream_scaffold",
    label: "Scaffold Workstream Graph",
    description:
      "Author a whole T3 Code Workstream graph SHAPE in one call — the topology-first half of graph authoring. Each node carries only cheap metadata (key, role, title, purpose, and the same optional model/isolation fields as workstream_spawn) plus its blockedBy edges and gate, all referenced by SYMBOLIC KEY. Threads are created eagerly (real ids, visible in workstream_list immediately) but NONE can launch yet: a node launches only once it ALSO has a brief (workstream_brief). This lets you lay out the entire solution shape cheaply and instantly, get it reviewed, then write each node's token-heavy brief just-in-time in topological order — a late brief can reference the actual reports of upstream nodes that already finished. References: use the node's `key` for an intra-scaffold edge, or `thread:<id>` for an existing child; a bare UUID-shaped key is rejected (paste an existing id with the `thread:` prefix). Validation is all-or-nothing — on any error (duplicate key, dangling reference, dependency cycle) nothing is created and the error names the offending key. A later workstream_scaffold call is a DELTA: its blockedBy may reference existing children by key or `thread:` id, extending the live graph. Pass staged: true to create every node held (planned) for review before releasing with workstream_release.",
    promptSnippet:
      "lay out a whole child graph shape in one call (nodes with keys + blockedBy/gate edges, no briefs); each node then needs workstream_brief before it launches.",
    promptGuidelines: [
      "Author the SHAPE first: one workstream_scaffold call with every node (key + role + short title + purpose) and all blockedBy/gate edges by key. Then write briefs one at a time with workstream_brief in topological order — the first node launches as soon as its brief lands, and a downstream node's brief written after its dependencies finished can reference their actual reports.",
      "Reference edges by symbolic key for nodes in this scaffold, or by `thread:<id>` for a pre-existing child. Keys are unique-forever per parent and immutable. Validation is all-or-nothing: a cycle or dangling reference creates nothing and names the offending key.",
      "A gate is declared exactly as in workstream_spawn: gate: { rework: <key-or-thread:id> } on the reviewer node; gate.rework is auto-added to that node's blockedBy. Model fields (taskShape/modelPreset/modelSelection/sensitive) and isolation work per node exactly as in workstream_spawn — omit them for the normal path.",
      "Use staged: true to hold the whole batch (planned) so a human can review the shape before any node runs; release it with workstream_release. A scaffolded node never launches on shape alone — it always waits for its brief too.",
    ],
    parameters: {
      type: "object",
      properties: {
        staged: {
          type: "boolean",
          description:
            "Create every node in this call held (plan lane 'planned') instead of released. Default false — nodes are 'ready' and launch once their dependencies clear AND they have a brief. Set true to lay out a graph for shape review before any node runs, then release with workstream_release.",
        },
        nodes: {
          type: "array",
          description:
            "The nodes to create (or add, for a delta call). Each is a workstream_spawn node MINUS brief, PLUS a symbolic key. Briefs are attached separately with workstream_brief.",
          items: {
            type: "object",
            properties: {
              key: {
                type: "string",
                description:
                  "Symbolic, unique-forever key for this node among the parent's children, used to reference it from other nodes' blockedBy/gate in the same or a later call. Immutable; must NOT be UUID-shaped (reference an existing thread with the 'thread:' prefix instead). Required.",
              },
              role: {
                type: "string",
                description: "Role label for the node, e.g. coder, reviewer, researcher. Required.",
              },
              title: {
                type: "string",
                description:
                  "Short label naming the work at a glance (the card's bold name, ≤6 words) — lead with the distinguishing subject, not a verb every sibling shares. Required.",
              },
              purpose: {
                type: "string",
                description:
                  "Short (1-3 sentence) summary shown on the sidebar card as the node's 'Goal' — the value the work delivers, not the mechanical steps. This plus title is what makes the scaffold render evaluable as a shape. Required.",
              },
              blockedBy: {
                type: "array",
                items: { type: "string" },
                description:
                  "References this node waits on: a `key` of another node in this scaffold, or `thread:<id>` for a pre-existing child. The node does not start until every referenced thread reaches 'done'.",
              },
              gate: {
                type: "object",
                description:
                  "Declare a review gate on this node (typically a reviewer): rework names the node it verifies (a key or `thread:<id>`). gate.rework is auto-added to this node's blockedBy. Routing is identical to workstream_spawn.",
                properties: {
                  rework: {
                    type: "string",
                    description:
                      "The node this gate loops rework back to (the work under review) — a `key` in this scaffold or a `thread:<id>` of an existing sibling.",
                  },
                  maxRounds: {
                    type: "number",
                    description: "Maximum rework loops before the gate yields to you. Default 2.",
                  },
                },
                required: ["rework"],
                additionalProperties: false,
              },
              forkFrom: {
                type: "string",
                description:
                  "Fork this node's pi session from a source node/child at launch, so it starts from a byte-identical copy of the source's transcript — a `key` of another node in this scaffold (typically the reader node) or `thread:<id>` for an existing child. This is the acknowledge-then-fork shape as ONE call: a reader node that reads the shared corpus, then N fork nodes (forkFrom: reader) each carrying only their lens brief — identical prefixes give provider cache hits and verdict comparability. Identity is INHERITED from the source: do NOT set role / modelSelection / modelPreset / taskShape / sensitive on a fork node (each is rejected); purpose + title are still required. forkFrom is auto-added to the node's blockedBy, and cannot be combined with gate. Fork-of-fork is allowed and resolves order-independently; a fork-edge cycle is rejected. Stage the reader + forks together and release them together so the forks launch in one dispatcher pass (the cache is time-limited; scattering launches forfeits it, correctness unaffected). Prefer shared isolation (the default) unless the forks write code — an isolated fork's copied transcript still references the source's worktree paths.",
              },
              isolation: {
                type: "string",
                enum: ["isolated", "shared"],
                description:
                  "Worktree isolation, as in workstream_spawn. Omit to take the role default; a gated reviewer is always attached regardless.",
              },
              taskShape: {
                type: "string",
                enum: ["explore", "thorough", "mechanical"],
                description:
                  "Optional task-shape model hint, resolved by the server exactly as in workstream_spawn. Omit for the normal path (role preset / inherit).",
              },
              sensitive: {
                type: "string",
                enum: ["security"],
                description:
                  "Optional sensitivity marker paired with taskShape, as in workstream_spawn.",
              },
              modelPreset: {
                type: "string",
                description:
                  "Escape hatch: a named model preset, overriding taskShape. As in workstream_spawn.",
              },
              modelSelection: {
                type: "object",
                description:
                  "Escape hatch: an explicit model override for this node, taking precedence over taskShape/modelPreset. As in workstream_spawn.",
                properties: {
                  instanceId: { type: "string", description: "Configured provider instance id." },
                  model: { type: "string", description: "Model slug for that instance." },
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
            required: ["key", "role", "title", "purpose"],
            additionalProperties: false,
          },
        },
      },
      required: ["nodes"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Scaffolded Workstream graph.",
  },
  {
    name: "workstream_brief",
    label: "Brief Workstream Node",
    description:
      "Attach the kickoff brief — the full, self-contained first-turn instructions — to one scaffolded node, just-in-time. This is the second half of graph authoring: a node created by workstream_scaffold cannot launch until it has a brief (its launch precondition is dependencies-satisfied AND brief-present). Identify the node by its scaffold `key` or its thread id. Valid only on a direct child that has NOT started yet; on a started child it errors (steer a running child with workstream_prompt instead). Calling it again pre-launch overwrites (editing the brief before launch is the expected path). The brief is stored at a stable path the call returns; the kickoff reads the file's current content at launch, so writing briefs in topological order lets a late brief incorporate the actual reports of upstream nodes that already completed.",
    promptSnippet:
      "write one scaffolded node's kickoff brief (by key or thread id); the node launches once briefed and its deps are done. Overwrite allowed pre-launch.",
    promptGuidelines: [
      "After workstream_scaffold lays out the shape, brief nodes one at a time in topological order. The first node launches as soon as its brief lands; you are woken to brief the next node when its dependencies finish — exactly the moment their reports are available to fold into its brief.",
      "A brief may only target a node you directly parent that has not started. To change what a running child does, use workstream_prompt (steer), not workstream_brief.",
    ],
    parameters: {
      type: "object",
      properties: {
        node: {
          type: "string",
          description:
            "The scaffolded node to brief: its symbolic `key` or its thread id (optionally `thread:`-prefixed). Must be a direct child that has not started.",
        },
        markdown: {
          type: "string",
          description:
            "The full, self-contained kickoff brief (the node's first-turn instructions). Overwrites any existing brief pre-launch.",
        },
      },
      required: ["node", "markdown"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Attached Workstream brief.",
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
      "Send a markdown message to a DIRECT child Workstream thread you spawned. On an idle child (e.g. one you paused with workstream_stop) this starts the next turn with your message — the resume path. On a busy child with an open turn it becomes a queued steer, folded in between model rounds. A steer canNOT penetrate a blocked/hung tool call — if the child is stuck inside a tool call, workstream_stop it first, then workstream_prompt to restart it with guidance. On a scaffolded child that has NOT started: if it has a brief, your message is appended to that brief and the two compose its kickoff turn; if it has NO brief yet, the call is rejected with guidance to call workstream_brief first (briefing, not steering, is how an unstarted node gets its first turn).",
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
  {
    name: "thread_fork",
    label: "Fork Thread",
    description:
      "Fork THIS thread: create a new staged thread that starts with a full copy of this thread's conversation context and then diverges independently. Use it to explore an alternate direction without disturbing this thread — the fork inherits this thread's goal, model, and worktree, and its FIRST launch forks this thread's pi session (native fork), so no tokens are spent until the human (or you, via workstream_prompt) sends the divergent first message. The fork is a SIBLING that never merges back (it is divergence, not delegation — use workstream_spawn for delegated sub-work). Returns the new threadId.",
    promptSnippet:
      "fork this thread into a staged copy of its full context that then diverges independently.",
    promptGuidelines: [
      "Use this to branch the CONVERSATION (keep the context, explore an alternate direction) — not to delegate sub-work (workstream_spawn) and not to start a fresh-context next phase (goal_continue).",
      "The fork carries no brief: its first message is the divergent continuation. It is created held; a single send launches it and forks the session at that moment.",
      "Forking is refused while this thread is mid-turn (the session file is being written). Fork between turns.",
      "Name the sidebar card with threadTitle: a short (≤6-word) label for the divergent line of work. Defaults to this thread's title + ' (fork)'.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadTitle: {
          type: "string",
          description:
            "Optional sidebar name for the staged fork: a short (≤6-word) label for the divergent work. Defaults to this thread's title + ' (fork)'.",
        },
      },
      required: [],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Forked this thread.",
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
      "Hand off a separate, out-of-scope piece of work as its OWN new goal and a staged (held) root session. Use when you discover follow-up work that deserves to run independently rather than as a task under THIS goal. Creates a new goal and a parent-less session pre-loaded with your brief, then leaves it for the human to launch with a single send (which provisions a fresh worktree). Pass threadTitle to name the session's sidebar card — a short label leading with the distinguishing subject (defaults to the goal title). Defaults to this thread's project; pass project (a project title or id) only when the work belongs elsewhere — inbox/concierge threads MUST pass it, since their own project is a mailbox, not a workspace (an invalid project errors back with the list of valid ones). Returns the new goalId + threadId.",
    promptSnippet:
      "hand off discovered out-of-scope work as a new goal + a staged root session pre-loaded with a brief.",
    promptGuidelines: [
      "Use this for genuinely separate work that should run concurrently in its own goal/session — not for tasks that belong under this thread's existing goal (use goal_task_add for those).",
      "The brief becomes the new session's first turn: write it as a complete, self-contained kickoff prompt, not a one-line summary.",
      "The session is created held; the human launches it. You do NOT start it and no worktree is provisioned until the human sends.",
      "The handoff lands in THIS thread's project unless you pass project. If your thread is an inbox/concierge (its project is not where real work lives), always pass project — the work's home repo, not yours.",
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
        project: {
          type: "string",
          description:
            "Optional target project (title or id) when the work belongs in a different project than this thread's. The staged session's worktree is provisioned from that project's workspace at launch. Required for inbox/concierge threads. An unknown or ambiguous value errors back with the list of active projects.",
        },
      },
      required: ["title", "brief"],
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Handed off new goal.",
  },
  {
    name: "goal_continue",
    label: "Continue Goal in Fresh Session",
    description:
      "Like goal_handoff, but continues THIS goal in THIS worktree with a fresh context window: creates a staged (held) sibling session on the same goal, inheriting this thread's worktree, branch, and model — no new goal, no new worktree. Use it when a substantial hunk of work is done and the next phase should start with clean context while the overarching goal and its shared task tree carry on. The brief becomes the new session's first turn; a predecessor pointer to this thread is appended automatically so the successor can consult_thread this session for detail. The human launches it with a single send. Returns the new threadId.",
    promptSnippet:
      "stage a fresh-context continuation session on THIS goal + worktree, pre-loaded with a handoff brief.",
    promptGuidelines: [
      "Use this for the NEXT PHASE of this goal's work (fresh context, same goal/worktree/task tree) — not for separate work that deserves its own goal (use goal_handoff) and not for delegated sub-work (use workstream_spawn).",
      "The brief becomes the successor's first turn: write it self-contained — current state, what was done, what to do next, and where key artefacts live. A pointer back to this thread is appended automatically, so the successor can consult_thread you for anything you leave out.",
      "The session is created held; the human launches it with one send. Update the goal's task tree (mark done / add next steps) before handing off — the successor sees the same tree.",
      "Name the sidebar card with threadTitle: a short (≤6-word) label for the next phase, e.g. 'Feature-importance deep dive'. Defaults to the goal title + '(continued)'.",
    ],
    parameters: {
      type: "object",
      properties: {
        brief: {
          type: "string",
          description:
            "The handoff/kickoff prompt that becomes the continuation session's first turn. Required; write it self-contained (state, done, next, artefact locations).",
        },
        threadTitle: {
          type: "string",
          description:
            "Optional sidebar name for the staged continuation session: a short (≤6-word) label for the next phase of work. Defaults to the goal title + '(continued)'.",
        },
      },
      required: ["brief"],
      additionalProperties: false,
    },
    errorMode: "soft",
    fallbackText: "Staged continuation session.",
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
