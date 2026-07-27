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
  /** Specialised long-poll transport for tools that wait on human input. */
  readonly mode?: "user-input";
  /**
   * Fallback text when the server response carries no `rendered` field — a
   * defensive one-liner only; the server render is the source of truth.
   */
  readonly fallbackText?: string;
}

export const WORKSTREAM_TOOL_DEFS: ReadonlyArray<ProviderToolDef> = [
  {
    name: "ask_user_question",
    label: "Ask User Question",
    description:
      "Ask the user one to four structured questions and wait for their answers — a last resort, not a routine step. Threads here frequently run unattended, so reserve this for a decision that is genuinely irreversible, destructive, or purely a matter of the user's preference; otherwise proceed on the most reasonable assumption and state it. Each question has a short header, an optional one-line `stakes` saying what it costs to get wrong, and two to four labelled options whose descriptions give the tradeoff; mark the option you would pick `recommended`. A question may allow one or multiple selections, and a single-select option may include a markdown preview. The user can always provide a custom free-text answer instead.",
    promptSnippet:
      "last resort for a genuinely irreversible, destructive, or preference-dependent fork: put one to four structured questions to the user, with labelled options and single- or multi-select answers, then block until they answer.",
    promptGuidelines: [
      "Do not call ask_user_question to resolve ordinary uncertainty. Threads here often run unattended, so the default is to choose the most reasonable option, state the assumption plainly in your output, and let the user correct it — that is nearly always better than blocking on a human.",
      "Reserve ask_user_question for a fork that is genuinely irreversible or destructive, or that turns purely on the user's preference and cannot be inferred from the request, the codebase, or prior context. Never use it to confirm scope you were already given, to get a plan approved that you could simply carry out and report, or to pick between options you can defend a choice between yourself.",
      "When ask_user_question is genuinely warranted, put every related clarification into that one call (up to four questions) instead of stacking calls. Use markdown preview only on single-select options where seeing concrete content helps the user choose.",
      "An ask_user_question call is expensive because the user has none of your context, so make each question answerable on its own terms: set `stakes` to one line on what the decision costs to get wrong (what breaks, what is hard to undo), write each option's `description` as the tradeoff it makes rather than its mechanics ('maximum control, but a bad edit breaks schema parsing', not 'edits the template'), and set `recommended: true` on the single option you would choose — order the options strongest first so that is also the first one. Never encode a recommendation in a label; the badge is the only supported form.",
    ],
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              header: {
                type: "string",
                minLength: 1,
                description: "Short tab label for this question.",
              },
              question: { type: "string", minLength: 1 },
              stakes: {
                type: "string",
                minLength: 1,
                description:
                  "Optional one-line framing shown above the options: why this decision matters and what it costs to get wrong (what breaks, what is hard to undo). Not a restatement of the question.",
              },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Concise choice label. 'Other' and 'Type something.' are reserved for Loom's custom-answer control.",
                    },
                    description: {
                      type: "string",
                      minLength: 1,
                      description:
                        "The tradeoff this option makes — what the user gains and gives up — not a description of the mechanics.",
                    },
                    preview: {
                      type: "string",
                      minLength: 1,
                      description:
                        "Optional markdown preview for this option. Valid only when the question is single-select.",
                    },
                    recommended: {
                      type: "boolean",
                      description:
                        "Set true on the one option you would choose; Loom renders it as a suggestion badge beside the label. At most one option per question.",
                    },
                  },
                  required: ["label", "description"],
                  additionalProperties: false,
                },
              },
              multiSelect: { type: "boolean", description: "Defaults to false." },
            },
            required: ["header", "question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    errorMode: "throw",
    mode: "user-input",
  },
  {
    name: "workstream_spawn",
    label: "Spawn Workstream Sub-thread",
    description:
      "Spawn a T3 Code Workstream sub-thread as a child of the current thread. Identify the work with three distinct fields: a role (e.g. coder, reviewer), a short title (the card's name — roughly ≤6 words, leading with the distinguishing subject rather than a verb every sibling shares), and a purpose (1-3 sentences, shown on the sidebar card as the thread's 'Goal') that states the value the work delivers — the capability, fix, or decision it produces, NOT the role or the mechanical steps. Put the full instructions in brief instead. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with gate: { rework: thatChildThreadId }; gate.rework is automatically added to blockedBy. Model choice: for most spawns, pass NO model fields — the child takes a preset matching its role, or inherits this thread's model. Only when the task clearly matches one of three shapes should you pass taskShape ('explore' / 'thorough' / 'mechanical'), a single token the server resolves to a concrete model (never pick a model by name). modelSelection / modelPreset are escape hatches for the rare case you genuinely need a specific model. Full precedence: explicit modelSelection > modelPreset > taskShape > role preset > inherit this thread's model. A valid taskShape on a server with no matching profiles simply falls through to the role preset/inherit with a warning (never an error). Call workstream_list to see the task-shape vocabulary, profiles, presets, and the instance/model catalogue. For laying out a MULTI-NODE graph (or when you want a human to review the solution shape before paying for briefs), prefer workstream_scaffold + workstream_brief: scaffold defines the whole topology by symbolic key in one cheap call, then briefs are written just-in-time. workstream_spawn is the one-node shortcut (scaffold-one-node + brief in a single call).",
    promptSnippet:
      "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override. For a multi-node graph prefer workstream_scaffold + workstream_brief.",
    promptGuidelines: [
      "A gated pair runs its review loop in the control plane without you: once you spawn the reviewer with gate: { rework: coderId }, 'needs_rework' loops the coder (round-capped, default 2) and 'clean'/'fixed_inline' resolve both. Wire downstream work on the reviewer (or both), never the coder alone, because a rework round can reopen the coder's done; you are woken once at gate resolution, or earlier if the gate yields.",
      "A staged (planned) graph does not run until you release it: pass staged: true to lay the whole shape out for review before any tokens are spent, then workstream_release the held subtree to let it run.",
    ],
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description:
            "Role label for the child agent, e.g. coder, reviewer, researcher. Required for a normal spawn; OMIT it when forkFrom is set (a fork inherits the source's role, and passing role with forkFrom is rejected).",
        },
        purpose: {
          type: "string",
          description:
            "Short (1-3 sentence) summary shown on the sidebar card as the thread's 'Goal'. State the value/outcome the work delivers (why it matters and how to judge it), not the mechanical actions. The role badge already conveys that (e.g.) code is being written, so do not restate the role or lead with 'Implement…'/'Review…'; lead with the capability, fix, or decision the work produces. Put the detailed instructions in brief.",
        },
        brief: {
          type: "string",
          description:
            "Full, self-contained first-turn prompt that becomes the child's assignment (optional; defaults to purpose, which suffices only when the purpose already says everything). Write it to stand on its own: the child acts on what the brief says, not on context you can see but it cannot. State the outcome it owes and the contract it works under (the goal and why it matters, the constraints, the definition of done, where the relevant code and artefacts live), and leave how to deliver that outcome to the child's role rather than scripting the steps; an over-prescribed brief that dictates every step turns a capable delegate into a transcriber, and for a delegating role like an orchestrator it can re-scope the recipient into doing the work inline.",
        },
        title: {
          type: "string",
          description:
            "Short label naming the work at a glance, the card's bold name, roughly ≤6 words. Titles appear in lists already labelled with the role, so lead with the distinguishing subject rather than a verb shared by every sibling: 'Receipt-dedup merge', not 'Implement receipt-dedup merge'; a specific verb is fine when it carries meaning ('Fix spawn title fallback'). Distinct from purpose, which is the one-sentence why.",
        },
        blockedBy: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional thread ids this child waits on; the child is created but does not start until every listed thread reaches 'done'. To run work in order (e.g. a reviewer after a coder), spawn the upstream child first, then set blockedBy to its id.",
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
            "Fork this child's session from an existing active direct child (the source) at launch: the child starts from a byte-identical copy of the source's transcript. This is the acknowledge-then-fork fan-out: one reader child reads a large shared corpus and ends with a bare acknowledgement, then each fork carries only its own lens in its brief, so every fork reasons from the same context (comparable verdicts, plus prompt-cache reuse when they launch together on a cache-supporting path). Identity is inherited: do NOT pass role / modelSelection / modelPreset / taskShape / sensitive (each is rejected); purpose and title are still required per fork. forkFrom is auto-added to blockedBy and cannot be combined with gate. Launch the forks together (the cache window is time-limited). Prefer the default shared worktree so the copied transcript's paths stay valid; use isolation:'isolated' only if the forks write code.",
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
            "Server-resolved model hint; omit for most spawns (the child takes a role-matched preset or inherits this thread's model). Pass a shape only when the work materially fits one: 'explore' (open-ended or prototype work, vague objective, plan likely to change); 'thorough' (edge cases, migrations, hardening, review gates, anywhere missing a real issue is worse than noise); 'mechanical' (bounded, self-contained, high-volume work like extraction, renames, or formatting, but NOT long-context extraction, which wants 'thorough'). The server picks the concrete model, so never guess a model name; a shape with no matching server profile falls through to the role preset (never an error). Precedence with the escape hatches is in this tool's description.",
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
            "Escape hatch for a genuine exception: a named model preset (resolved to a configured ModelSelection on the server). Preset names are deployment-specific (see modelPresets in workstream_list); an unknown name is rejected with the available names. Omit on the normal path so the role preset or inherited model applies.",
        },
        modelSelection: {
          type: "object",
          description:
            "Escape hatch for a genuine exception: an explicit model override for the child (its precedence over the other model fields is in this tool's description). Omit on the normal path so taskShape, the role preset, or the inherited model applies.",
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
      // role is required for a normal spawn but MUST be omitted with forkFrom
      // (identity is inherited); that conditional requirement is enforced by the
      // handler, so role is not in the unconditional `required` set.
      required: ["purpose", "title"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Spawned Workstream sub-thread.",
  },
  {
    name: "workstream_scaffold",
    label: "Scaffold Workstream Graph",
    description:
      "Author a whole T3 Code Workstream graph SHAPE in one call — the topology-first half of graph authoring. Reach for this as soon as work firms up into more than a couple of dependent pieces; a series of ad-hoc workstream_spawn calls builds the same graph blind, forfeiting shape review, staged release, and visible parallelism. Each node carries only cheap metadata (key, role, title, purpose, and the same optional model/isolation fields as workstream_spawn) plus its blockedBy edges and gate, all referenced by SYMBOLIC KEY. Threads are created eagerly (real ids, visible in workstream_list immediately) but NONE can launch yet: a node launches only once it ALSO has a brief (workstream_brief). This lets you lay out the entire solution shape cheaply and instantly, get it reviewed, then write each node's token-heavy brief just-in-time in topological order — a late brief can reference the actual reports of upstream nodes that already finished. References: use the node's `key` for an intra-scaffold edge, or `thread:<id>` for an existing child; a bare UUID-shaped key is rejected (paste an existing id with the `thread:` prefix). Validation is all-or-nothing — on any error (duplicate key, dangling reference, dependency cycle) nothing is created and the error names the offending key. A later workstream_scaffold call is a DELTA: its blockedBy may reference existing children by key or `thread:` id, extending the live graph. Pass staged: true to create every node held (planned) for review before releasing with workstream_release.",
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
                  "Symbolic, unique-forever key for this node among the parent's children, used to reference it from other nodes' blockedBy/gate in the same or a later call. Immutable; must NOT be UUID-shaped (reference an existing thread with the 'thread:' prefix instead).",
              },
              role: {
                type: "string",
                description:
                  "Role label for the node, e.g. coder, reviewer, researcher. Required for a normal node; OMIT it on a fork node (forkFrom set) — the fork inherits the source's role, and passing role with forkFrom is rejected.",
              },
              title: {
                type: "string",
                description:
                  "Short label naming the work at a glance (the card's bold name, ≤6 words); lead with the distinguishing subject, not a verb every sibling shares.",
              },
              purpose: {
                type: "string",
                description:
                  "Short (1-3 sentence) summary shown on the sidebar card as the node's 'Goal': the value the work delivers, not the mechanical steps. This plus title is what makes the scaffold render evaluable as a shape.",
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
                  "Fork this node's session from a source at launch, so it starts from a byte-identical copy of the source's transcript. The fork contract is as in workstream_spawn's forkFrom. Scaffold-specific only: the source is a `key` in this scaffold (typically the reader node) or `thread:<id>` for an existing child; this expresses the whole acknowledge-then-fork shape in ONE call (a reader node plus N fork nodes with forkFrom: reader, each carrying only its lens brief); fork-of-fork is allowed and resolves order-independently while a fork-edge cycle is rejected; and staging the reader and forks together lets them launch in one dispatcher pass.",
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
            // role is required for a normal node but MUST be omitted on a fork
            // node (forkFrom set); the handler enforces that conditional rule, so
            // role is not in the unconditional `required` set.
            required: ["key", "title", "purpose"],
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
      "Attach the kickoff brief that becomes a scaffolded node's first-turn assignment (its recipient contract and register are on the markdown parameter), just-in-time. This is the second half of graph authoring: a node created by workstream_scaffold cannot launch until it has a brief (its launch precondition is dependencies-satisfied AND brief-present). Identify the node by its scaffold `key` or its thread id. Valid only on a direct child that has NOT started yet; on a started child it errors (steer a running child with workstream_prompt instead). Calling it again pre-launch overwrites (editing the brief before launch is the expected path). The brief is stored at a stable path the call returns; the kickoff reads the file's current content at launch, so writing briefs in topological order lets a late brief incorporate the actual reports of upstream nodes that already completed.",
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
            "The node's full, self-contained kickoff brief, which becomes its first-turn assignment. It follows the same contract as workstream_spawn's brief; write it to that field's guidance. Overwrites any existing brief pre-launch.",
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
      "Do NOT set 'done' to finish your own work; use workstream_submit, which records your report and advances your lane. Setting 'done' directly is for a parent accepting a child's output, and 'cancelled' for abandoning work (it cascades to the whole subtree and stops in-flight turns).",
      "This is the plan axis. If you cannot proceed without a human, or your output needs sign-off, do not park the lane; raise attention with workstream_request_attention instead.",
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
      "Raise attention only when a HUMAN is needed: 'awaiting_acceptance' when your output needs sign-off before completion (not merely because a reviewer thread exists; that case is just 'done', which releases the reviewer), or 'needs_guidance' when you genuinely cannot proceed. Do not sit silently halted: advance the plan, or raise attention.",
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
        message: {
          type: "string",
          description:
            "The markdown message to send to the child; its register depends on where it lands (the description says which case applies). A steer folded into a busy child's running turn is a course-correction, not a fresh assignment, or it can re-scope work already under way; a message to an idle child starts its next turn (the resume path); on an unstarted node it is appended to that node's brief and composes the kickoff, so write it to workstream_spawn's brief contract.",
        },
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
      "End your work with ONE call to workstream_submit: your report plus an outcome. Do not call workstream_set_lane to finish.",
      "Plain success → omit outcome. Cannot proceed without a human → outcome 'needs_human'. Concluded with something other than plain success (approach wrong, blocked on a decision) → a short outcome token explaining it; the control plane hands you to your orchestrator.",
      "Read the tool result: it echoes the routing decision. 'yielded' or a rework route means you are NOT done yet.",
    ],
    parameters: {
      type: "object",
      properties: {
        markdown: {
          type: "string",
          description:
            "The markdown report to hand back, stored on disk and shown to whoever receives your work next (your parent orchestrator, or the gate counterpart in a review loop). Make it a deliberate handoff: what you did, the key results and decisions, and anything the parent must act on, not a transcript dump.",
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
      'GLOBAL read-only consult of another thread, answered from a frozen fork of that thread\'s session. It reaches ANY thread the server knows (across worktrees and projects), not just your workstream tree. Use it when the user points you at another thread — by name ("ask the liveness-detection thread …") or via an @-mention. Identify the target by exactly one of: threadId (preferred; an @-mentioned thread arrives in the message as [Title](thread://<id>) — pass that <id>), or name (a fuzzy sidebar-title match). If a name matches several threads it returns ranked candidates instead of guessing; surface them and confirm with the user, then call again with the chosen threadId. It never resumes or mutates the target; to push a message the target acts on, use notify_thread.',
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
          description:
            "The question to answer from the target thread's frozen session context. That fork shares none of your context, so make the question self-contained: name what you are asking about rather than referring to your own thread's state.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "(no answer)",
  },
  {
    name: "notify_thread",
    label: "Notify Thread (cross-thread push)",
    description:
      "Push a markdown message into ANY other thread the server knows, across orchestration trees, worktrees, and projects: the write counterpart of the read-only consult_thread. Delivery never interrupts. An idle recipient starts its next turn with your message (it will spend tokens acting on it); a busy recipient has it queued durably, then delivered as a fresh turn when it next goes idle. The recipient sees it framed as a notification from your thread (title, id, and your relationship to it, if any) and owes no reply: this call is fire-and-forget, and its result reports 'delivered' or 'queued', never an answer. Use it to tell a thread something it is waiting to hear, e.g. \"the extraction run you depend on is complete; results at <path>\". It is NOT for getting information back (consult_thread asks a read-only question and returns the answer), not for directing your own children (workstream_prompt), not for reporting to your parent (workstream_submit), not for creating work (workstream_spawn), and not for reaching non-T3 pi sessions on this machine (intercom); notify_thread addresses durable T3 threads and leaves transcript and graph provenance. Identify the target by threadId, or by name (fuzzy sidebar-title match); an ambiguous name sends nothing and returns ranked candidates.",
    promptSnippet:
      "push a fire-and-forget message into any other thread, by id or name; it never interrupts the recipient.",
    promptGuidelines: [
      "notify_thread's result is the end of the exchange; no reply arrives through it. Need an answer? consult_thread the target, or ask it (in your message) to notify_thread you back and carry on until that arrives.",
      "An unresolved name returns candidates and sends nothing: confirm the intended target, then call again with its threadId. A push engages the recipient's session, so never guess.",
    ],
    parameters: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description:
            "Exact id of the target thread, preferred when known (from workstream_list, a prior consult, or an @-mention [Title](thread://<id>)). Provide exactly one of threadId or name; supplying both is rejected.",
        },
        name: {
          type: "string",
          description:
            "Fuzzy sidebar title of the target thread, used when you do not have an exact id. An ambiguous match returns ranked candidates without sending; supplying name together with threadId is rejected.",
        },
        message: {
          type: "string",
          description:
            "The markdown message the recipient receives, framed as a notification from your thread. It lands in another agent's context with none of yours, so write it self-contained: state what you are informing it of, reference your outputs by absolute path instead of pasting bulk content, and say plainly if you are asking for anything back (the framing tells the recipient the default is nothing). A notification informs; it must never re-task, steer, or covertly delegate. To direct work, prompt your own child (workstream_prompt) or spawn a new one (workstream_spawn).",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    errorMode: "throw",
    fallbackText: "Notification accepted.",
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
          description: "The new sidebar title for this thread (non-empty).",
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
        text: { type: "string", description: "The task text." },
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
          description: "Id of the task to update; must belong to this thread's goal.",
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
          description: "Id of the task to delete; must belong to this thread's goal.",
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
      "Hand off a separate, out-of-scope piece of work as its OWN new goal. Not for tasks that belong under this thread's existing goal (use goal_task_add instead). Use when you discover follow-up work that can be actioned by an independent agent. The receiving agent is highly capable and will plan and orchestrate the solution itself.",
    promptSnippet: "hand off discovered out-of-scope work as a new goal",
    promptGuidelines: ["The new session is created held. Tell the user it is staged and waiting."],
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description:
            "A short (≤6-word) noun-phrase label that leads with the distinguishing subject of the work, not a generic verb. Names the goal.",
        },
        brief: {
          type: "string",
          description:
            "The handoff/kickoff prompt that becomes the new session's first turn. Write it as a self-contained problem/goal statement: context, motivation, constraints, and pointers to where things live. State *what* and *why*, never *how*; the receiving agent plans its own approach. If the user expressed a preferred approach, present it as an option to investigate, not a prescription.",
        },
        description: {
          type: "string",
          description:
            "One or two sentences stating the objective that the developer is trying to achieve. Focus on the business value or pain-point rather than the technical implementation.",
        },
        project: {
          type: "string",
          description:
            "Optional target project (title or id) when the work belongs in a different project than this thread's.",
        },
      },
      required: ["title", "brief", "description"],
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
