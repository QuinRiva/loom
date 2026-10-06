// LOOM-ONLY. Every text a model reads about Loom's agent tools: the description
// pi's tool list shows at selection time, the one-line prompt snippet for the
// system prompt's "Available tools" line, and the ambient guidelines pi appends
// per tool. Keyed by the BARE MCP name (what the server registers); every tool
// named INSIDE the text uses the prefixed form the model sees
// (`mcp__t3-code__<name>`). `defs.ts` imports this record for its prose fields;
// the registration carries snippet and guidelines in the tool's `_meta`
// (`loom/promptSnippet`, `loom/promptGuidelines`) for upstream's bridge to read.
// Authoring doctrine: docs/architecture/tool-def-authoring.md.

export interface LoomToolProse {
  readonly description: string;
  readonly promptSnippet: string;
  /** Ambient per-tool rules, one per line; empty when the description is the contract of record. */
  readonly promptGuidelines: string;
}

export const LOOM_TOOL_PROSE = {
  workstream_spawn: {
    description:
      "Spawn a T3 Code Workstream sub-thread as a child of the current thread. Identify the work with three distinct fields: a role (e.g. coder, reviewer), a short title (the card's name — roughly ≤6 words, leading with the distinguishing subject rather than a verb every sibling shares), and a purpose (1-3 sentences, shown on the sidebar card as the thread's 'Goal') that states the value the work delivers — the capability, fix, or decision it produces, NOT the role or the mechanical steps. Put the full instructions in brief instead. The child runs in THIS thread's worktree: every child shares its parent's checkout and has no branch of its own, so what you commit is visible to it at once and paths you give it are valid as written. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches outcome 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with gate: { rework: thatChildThreadId }; gate.rework is automatically added to blockedBy. Model choice: for most spawns, pass NO model fields — the child takes a preset matching its role, or inherits this thread's model. Only when the task clearly matches one of three shapes should you pass taskShape ('explore' / 'thorough' / 'mechanical'), a single token the server resolves to a concrete model (never pick a model by name). modelSelection / modelPreset are escape hatches for the rare case you genuinely need a specific model. Full precedence: explicit modelSelection > modelPreset > taskShape > role preset > inherit this thread's model. A valid taskShape on a server with no matching profiles simply falls through to the role preset/inherit with a warning (never an error). Call mcp__t3-code__workstream_list to see the task-shape vocabulary, profiles, and presets. For laying out a MULTI-NODE graph, prefer mcp__t3-code__workstream_scaffold + mcp__t3-code__workstream_brief: scaffold defines the whole topology by symbolic key in one cheap call, then briefs are written just-in-time. mcp__t3-code__workstream_spawn is the one-node shortcut (scaffold-one-node + brief in a single call).",
    promptSnippet:
      "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override. For a multi-node graph prefer mcp__t3-code__workstream_scaffold + mcp__t3-code__workstream_brief.",
    promptGuidelines: [
      "A gated pair runs its review loop in the control plane without you: once you spawn the reviewer with gate: { rework: coderId }, 'needs_rework' loops the coder (round-capped, default 2) and 'clean'/'fixed_inline' resolve both. Wire downstream work on the reviewer (or both), never the coder alone, because a rework round can reopen the coder's done; you are woken once at gate resolution, or earlier if the gate yields.",
      "Children share your worktree. Two concurrent writers on overlapping files collide in one tree, so sequence overlapping edits with blockedBy or give them to one child; and while any child is active, do not switch the tree's branch, stash, or reset — you would pull the floor out from under it.",
    ].join("\n"),
  },
  workstream_scaffold: {
    description:
      "Author a whole T3 Code Workstream graph SHAPE in one call — the topology-first half of graph authoring. Reach for this as soon as work firms up into more than a couple of dependent pieces; a series of ad-hoc mcp__t3-code__workstream_spawn calls builds the same graph blind, forfeiting shape review and visible parallelism. Each node carries only cheap metadata (key, role, title, purpose, and the same optional model fields as mcp__t3-code__workstream_spawn) plus its blockedBy edges and gate, all referenced by SYMBOLIC KEY. Threads are created eagerly (real ids, visible in mcp__t3-code__workstream_list immediately) but NONE can launch yet: a node launches only once it ALSO has a brief (mcp__t3-code__workstream_brief). This lets you lay out the entire solution shape cheaply and instantly, get it reviewed, then write each node's token-heavy brief just-in-time in topological order — a late brief can reference the actual reports of upstream nodes that already finished. Every node runs in this thread's worktree, as a spawned child does. References: use the node's `key` for an intra-scaffold edge, or `thread:<id>` for an existing child; a bare UUID-shaped key is rejected (paste an existing id with the `thread:` prefix). Validation is all-or-nothing — on any error (duplicate key, dangling reference, dependency cycle) nothing is created and the error names the offending key. A later mcp__t3-code__workstream_scaffold call is a DELTA: its blockedBy may reference existing children by key or `thread:` id, extending the live graph.",
    promptSnippet:
      "lay out a whole child graph shape in one call (nodes with keys + blockedBy/gate edges, no briefs); each node then needs mcp__t3-code__workstream_brief before it launches.",
    promptGuidelines: [
      "Author the SHAPE first: one mcp__t3-code__workstream_scaffold call with every node (key + role + short title + purpose) and all blockedBy/gate edges by key. Then write briefs one at a time with mcp__t3-code__workstream_brief in topological order — the first node launches as soon as its brief lands, and a downstream node's brief written after its dependencies finished can reference their actual reports.",
      "Reference edges by symbolic key for nodes in this scaffold, or by `thread:<id>` for a pre-existing child. Keys are unique-forever per parent and immutable. Validation is all-or-nothing: a cycle or dangling reference creates nothing and names the offending key.",
      "A gate is declared exactly as in mcp__t3-code__workstream_spawn: gate: { rework: <key-or-thread:id> } on the reviewer node; gate.rework is auto-added to that node's blockedBy. Model fields (taskShape/modelPreset/modelSelection/sensitive) work per node exactly as in mcp__t3-code__workstream_spawn — omit them for the normal path. A scaffolded node never launches on shape alone — it always waits for its brief too.",
    ].join("\n"),
  },
  workstream_brief: {
    description:
      "Attach the kickoff brief that becomes a scaffolded node's first-turn assignment (its recipient contract and register are on the markdown parameter), just-in-time. This is the second half of graph authoring: a node created by mcp__t3-code__workstream_scaffold cannot launch until it has a brief (its launch precondition is dependencies-satisfied AND brief-present). Identify the node by its scaffold `key` or its thread id. Valid only on a direct child that has NOT started yet; on a started child it errors (steer a running child with mcp__t3-code__workstream_prompt instead). Calling it again pre-launch overwrites (editing the brief before launch is the expected path). The brief is stored at a stable path the call returns; the kickoff reads the file's current content at launch, so writing briefs in topological order lets a late brief incorporate the actual reports of upstream nodes that already completed.",
    promptSnippet:
      "write one scaffolded node's kickoff brief (by key or thread id); the node launches once briefed and its deps are done. Overwrite allowed pre-launch.",
    promptGuidelines: [
      "After mcp__t3-code__workstream_scaffold lays out the shape, brief nodes one at a time in topological order. The first node launches as soon as its brief lands; you are woken to brief the next node when its dependencies finish — exactly the moment their reports are available to fold into its brief.",
      "A brief may only target a node you directly parent that has not started. To change what a running child does, use mcp__t3-code__workstream_prompt (steer), not mcp__t3-code__workstream_brief.",
    ].join("\n"),
  },
  workstream_set_outcome: {
    description:
      "Set the PLAN outcome of a T3 Code Workstream thread you own (this thread or one you directly spawned): 'done', 'cancelled', or 'none'. 'done' is the only outcome that releases dependents and lets the next thread start; it is how you accept a child's work when the child yielded to you instead of completing (a quiescent child whose report was synthesised, an unmatched outcome token). 'cancelled' abandons the work and does NOT release dependents — and it CASCADES: cancelling a thread also cancels every non-terminal descendant (children, grandchildren, …) and interrupts any in-flight turn among them, so cancelling a runaway branch kills the whole chain beneath it (already-done descendants are left untouched). 'none' reopens a finished thread — clears its outcome so it can be prompted again; do this before you prompt a done or cancelled child, so the board never shows a finished thread working. Completing your OWN work goes through mcp__t3-code__workstream_submit, never here: a self-issued 'done' is refused while a rework is pending on you or you are a member of an unresolved review gate, because it would skip the routing; a parent's 'done' on such a child is allowed, with a warning. To dissolve a stuck gate, mark the REVIEWER done, not the coder — the coder's done is what the reviewer's verdict decides. This is the plan axis only: to pull in a human, use mcp__t3-code__workstream_request_attention.",
    promptSnippet:
      "set a thread's plan outcome: 'done' releases dependents (how you accept a yielded child); 'cancelled' cascades to the whole subtree and stops in-flight turns; 'none' reopens.",
    // No guidelines by design: the description carries the outcome semantics,
    // the cascade, the gate-recovery rule and the plan-vs-attention split, and
    // mcp__t3-code__workstream_submit's description owns "never set your own
    // outcome at completion" as the contract of record.
    promptGuidelines: "",
  },
  workstream_request_attention: {
    description:
      "Raise an attention flag on a T3 Code Workstream thread you own (this thread or one you directly spawned) — the single surface that pulls in a human. A raise HOLDS the work for that human; it is your turn's last act, not a label you attach to a report. The hold clears only when a human writes to the thread or its parent prompts it (at the start of that turn), or when the thread reaches done/cancelled — so completing yourself erases the hold and releases your dependents, and the submit path refuses a plain completion while a flag you raised stands, whether you raised it this turn or an earlier one; a raise on an already-finished thread is refused too. To hand a report back with the hold intact, pass a short non-'done' outcome to mcp__t3-code__workstream_submit: the report is recorded and you yield to your parent, flag standing. Two reasons: 'awaiting_acceptance' means a human (or the parent acting for the human) must accept this thread's output before its outcome may reach 'done' and its dependents release — it is NOT 'some reviewer thread should look at this' (a thread whose output flows to a separate reviewer thread just completes, which releases that reviewer). 'needs_guidance' means you cannot proceed without a human — including when what you want is answers to your questions, which is guidance, not acceptance. For a child it is the LAST resort: your parent wrote your brief and holds the context, and no human reads a child thread unless one has written to it — consult the parent first (mcp__t3-code__consult_thread) and raise only if that does not settle it or the parent has finished. Write the accompanying report for a human who has read none of this thread: explain the blocker without relying on internal labels or unseen reports.",
    promptSnippet:
      "raise a hold for a human — 'awaiting_acceptance' (your output needs sign-off before it may be done) or 'needs_guidance' (you're stuck, or you need answers); the raise ends your turn, so don't complete yourself in the same turn.",
    // No guidelines by design: the description states both reasons, the
    // not-a-reviewer-flag nuance and the consult-parent-first rule for
    // children. "Do not sit silently halted" reaches every spawned child
    // through the kickoff wrapper, and a root converses with the human
    // directly, so no ambient copy is needed.
    promptGuidelines: "",
  },
  workstream_stop: {
    description:
      "Stop a direct child Workstream thread you spawned: interrupt its active turn and leave it idle with its outcome unset (it stays in progress on the board). This is an ORCHESTRATOR pause — you own restarting it (resume it with mcp__t3-code__workstream_prompt). No attention flag is raised, because you are the resumer; a child you never resume eventually reads as gone quiet and is yielded back to you after the quiescence grace.",
    promptSnippet:
      "interrupt a direct child's active turn (orchestrator pause; you own the resume via mcp__t3-code__workstream_prompt).",
    promptGuidelines: [
      "Use mcp__t3-code__workstream_stop to pause a child you intend to redirect or resume yourself. To resume, send it a message with mcp__t3-code__workstream_prompt (the next turn continues).",
      "This is for direct children only. A human stop from the board raises needs_guidance instead, because no agent owns the resume.",
    ].join("\n"),
  },
  workstream_prompt: {
    description:
      "Send a markdown message to a DIRECT child Workstream thread you spawned — you acting on the child as its parent. On an idle child (e.g. one you paused with mcp__t3-code__workstream_stop) this starts the next turn with your message — the resume path. On a busy child with an open turn it becomes a queued steer, folded in between model rounds. A child whose turn has not begun (just launched, still starting, or waiting on an answer) cannot take a steer yet: your message is queued as its next turn, after the current run ends; the result says whether it started, steered or queued. A steer canNOT penetrate a blocked/hung tool call — if the child is stuck inside a tool call, mcp__t3-code__workstream_stop it first, then prompt to restart it with guidance. Prompting a child that holds an attention flag (needs_guidance, awaiting_acceptance, or a yield awaiting you) CLEARS that hold when the turn starts: you are standing in for the human, so prompt a flagged child only when you actually hold the answer or the approval it is waiting for. On a scaffolded child that has NOT started: if it has a brief, your message is appended to that brief and the two compose its kickoff turn; if it has NO brief yet, the call is rejected with guidance to call mcp__t3-code__workstream_brief first (briefing, not steering, is how an unstarted node gets its first turn). A finished child (outcome done or cancelled) is reopened with mcp__t3-code__workstream_set_outcome 'none' before you prompt it.",
    promptSnippet:
      "send a message to a direct child: resumes an idle child or steers a busy one, and clears a hold the child raised (a steer won't penetrate a hung tool call — stop first, then prompt).",
    promptGuidelines: [
      "Use mcp__t3-code__workstream_prompt to resume a child you stopped, redirect a running child, or feed it new information. Idle child → your message starts its next turn; busy child → queued steer folded between model rounds.",
      "A steer cannot interrupt a blocked/hung tool call. For a child stuck inside a tool call, call mcp__t3-code__workstream_stop first, then mcp__t3-code__workstream_prompt with guidance.",
      "This is for direct children only, and it is a plain message send — it does not change the child's outcome. Reopen a done or cancelled child with mcp__t3-code__workstream_set_outcome 'none' before prompting it, or spawn a new child.",
    ].join("\n"),
  },
  workstream_set_dependencies: {
    description:
      "Declare which threads a T3 Code Workstream thread waits on. Replaces the full blockedBy set for a thread you own (this thread or a thread you directly spawned). This is a re-planning operation: it re-gates a not-yet-started thread, but setting dependencies on an already-started thread returns a warning — the edge is recorded for display only and never un-runs the thread. To gate a child's execution from the start, pass blockedBy at spawn time instead.",
    promptSnippet:
      "adjust the blockedBy set of a not-yet-started thread (re-planning only; does not gate an already-started thread).",
    promptGuidelines:
      "blockedBy replaces the whole set each call; to actually defer a child's start, set blockedBy at spawn time — setting dependencies after a thread is already running does not stop it.",
  },
  workstream_submit: {
    description:
      "THE single terminal call for a T3 Code Workstream sub-thread: submit your markdown report plus a structured outcome, and the control plane derives what happens next — you never set your own outcome at completion. Omit outcome (or pass 'done') for plain completion: the report is recorded and your outcome becomes done in one step, releasing dependents — refused while an attention flag you raised stands, this turn or an earlier one, because completing would clear it (pass an outcome token instead and you yield with the flag standing). Pass outcome 'needs_human' to record the report and raise the needs_guidance flag instead (a human is pulled in; your outcome is unchanged). Any other outcome token (e.g. 'rework_approach', or review verdicts like 'needs_rework'/'clean'/'fixed_inline' when you are in a review gate) is routed by the control plane; during an active rework round it routes back to the reviewer for re-verification, otherwise an outcome with no matching route YIELDS you to your live parent orchestrator with your report — escalation is the safe default, and you are NOT done in that case. The tool result echoes the routing decision: read it — 'yielded' or a rework route means you are NOT done. Submit explicitly: a thread that ends its turn without submitting is, after a grace, treated as having gone quiet — the control plane synthesises a report from its last message and yields that to the parent, marked as synthesised, which is a worse hand-back than the one you would have written.",
    promptSnippet:
      "submit your report + outcome in one terminal call: plain completion → done; 'needs_human' → human flag; any other outcome → routed, with unmatched non-rework outcomes yielding to your orchestrator.",
    // No guidelines by design: this description is the contract of record for
    // the completion protocol (including the routing-echo and quiescence
    // clauses), and the kickoff wrapper references it rather than paraphrasing.
    promptGuidelines: "",
  },
  workstream_list: {
    description:
      "List your workstream: the whole graph of threads in your orchestration tree (every node's id, role, title, board column and outcome, attention flags, spawn generation, parent, last-activity, and report/session file paths) plus lineage and waits-on edges, and the spawn catalogue — the task-shape vocabulary, model profiles and presets mcp__t3-code__workstream_spawn accepts. This is how you discover the ids of sibling/other threads you were not handed directly, so you can then consult them or read their report/session files. A child marked 'went quiet; report synthesised' ended its turn without submitting — its report is the control plane's reconstruction, not a hand-back.",
    promptSnippet:
      "see your whole workstream graph — ids, roles, outcomes/attention, last-activity, report/session paths — and the spawn model catalogue, to find any thread without searching.",
    promptGuidelines:
      "Call mcp__t3-code__workstream_list first when you need to coordinate with another thread but only know it exists, not its id; the returned tree is exactly your workstream scope.",
  },
  consult_thread: {
    description:
      'Read-only consult of another thread, answered from a frozen fork of that thread\'s session: it reaches ANY thread the server knows (across worktrees and projects), never wakes or mutates the target, and the answer is what the target knew as of its last turn. Use it to ask the thread that holds the context. For a child, that is usually your PARENT — it wrote your brief and no human reads your thread unless one has written to it, so a question the brief does not settle goes here before any human hold. Also use it when the user points you at another thread by name ("ask the liveness-detection thread …") or via an @-mention. Identify the target by exactly one of: threadId (preferred; an @-mentioned thread arrives in the message as [Title](thread://<id>) — pass that <id>), or name (a fuzzy sidebar-title match). If a name matches several threads it returns ranked candidates instead of guessing; surface them and confirm, then call again with the chosen threadId. To push a message the target acts on, use mcp__t3-code__notify_thread.',
    promptSnippet:
      "ask another thread a read-only question (answered from a frozen fork) by id, @-mention, or name; a child's first stop for anything its brief leaves unsettled is its parent.",
    promptGuidelines: [
      "Prefer threadId: an @-mentioned thread arrives as [Title](thread://<id>); pass that exact <id>. Otherwise pass name for a fuzzy title match.",
      "If the result is unresolved with candidates, do not guess — confirm which thread was meant before consulting again with its threadId.",
      "A consult answers from a frozen copy, so the live thread does not know it was asked: quote the question and answer verbatim in your report so the decision is on the record.",
    ].join("\n"),
  },
  notify_thread: {
    description:
      'Push a markdown message into ANY other live thread the server knows, across orchestration trees, worktrees, and projects: the write counterpart of the read-only mcp__t3-code__consult_thread. Delivery is steer-or-start and never aborts a turn: a busy recipient is steered — your message is folded into its running turn between model rounds — and an idle recipient starts a new turn with it (it will spend tokens acting on it). A finished target is refused: a notification never re-engages a thread that is done, cancelled, archived or deleted. The recipient sees it framed as a notification from your thread (title, id, and your relationship to it, if any) and owes no reply: this call is fire-and-forget, and its result says how the message landed (started a turn, steered a running one, or queued), never an answer. Use it to tell a thread something it is waiting to hear, e.g. "the extraction run you depend on is complete; results at <path>". It is NOT for getting information back (mcp__t3-code__consult_thread asks a read-only question and returns the answer), not for directing your own children (mcp__t3-code__workstream_prompt), not for reporting to your parent (mcp__t3-code__workstream_submit), not for creating work (mcp__t3-code__workstream_spawn), and not for reaching non-T3 pi sessions on this machine (intercom); mcp__t3-code__notify_thread addresses durable T3 threads and leaves transcript and graph provenance. Identify the target by threadId, or by name (fuzzy sidebar-title match); an ambiguous name sends nothing and returns ranked candidates. A sender→target pair is capped at a handful of messages per hour; a back-and-forth exchange hits it.',
    promptSnippet:
      "push a fire-and-forget message into any other live thread, by id or name; it steers a busy recipient or starts an idle one, and never aborts a turn.",
    promptGuidelines: [
      "mcp__t3-code__notify_thread's result is the end of the exchange; no reply arrives through it. Need an answer? mcp__t3-code__consult_thread the target, or ask it (in your message) to notify you back and carry on until that arrives.",
      "An unresolved name returns candidates and sends nothing: confirm the intended target, then call again with its threadId. A push engages the recipient's session, so never guess.",
    ].join("\n"),
  },
  set_thread_title: {
    description:
      "Rename THIS thread's own sidebar title in T3 Code. You pass only a title; the thread is always resolved from the session, so you can only ever rename yourself — never another thread or a child. Use it to keep the sidebar legible: e.g. when a root's auto-from-first-message title is unhelpful, or when a child's scope has sharpened into something more specific than its spawn title. This does not touch the goal (use mcp__t3-code__goal_update for that).",
    promptSnippet: "rename this thread's own sidebar title to keep the workstream legible.",
    promptGuidelines: [
      "You never pass a thread id — this always renames the calling thread itself; renaming another thread is impossible.",
      "title must be a non-empty string. Set a clear, specific title when the current one is unhelpful or your scope has sharpened.",
    ].join("\n"),
  },
  thread_fork: {
    description:
      "Fork THIS thread: create a new held thread that starts with a full copy of this thread's conversation context and then diverges independently. Use it to explore an alternate direction without disturbing this thread — the fork inherits this thread's goal, model, and worktree, and its FIRST launch forks this thread's pi session (native fork), so no tokens are spent until a human sends the divergent first message. The fork is a SIBLING that never merges back (it is divergence, not delegation — use mcp__t3-code__workstream_spawn for delegated sub-work). Returns the new threadId.",
    promptSnippet:
      "fork this thread into a held copy of its full context that then diverges independently; a human's first send launches it.",
    promptGuidelines: [
      "Use this to branch the CONVERSATION (keep the context, explore an alternate direction) — not to delegate sub-work (mcp__t3-code__workstream_spawn) and not to start a fresh-context next phase (mcp__t3-code__goal_continue).",
      "The fork carries no brief: its first message is the divergent continuation. It is created held; a single send from a human launches it and forks the session at that moment. Tell the user it is waiting.",
      "Forking is refused while this thread is mid-turn (the session file is being written). Fork between turns.",
    ].join("\n"),
  },
  goal_task_list: {
    description:
      'Read the task tree of THIS thread\'s active goal (the shared tree, resolved from the session — you never pass a goalId). Use it for orientation and reconciliation: the tree injected into your prompt is a snapshot from your spawn and is never refreshed, so a child may have marked its task done or added discovered work your snapshot does not reflect. If you are anchored to a branch, this returns THAT branch in full — its checklist block is the exact text a branch rewrite takes — preceded by the read-only spine showing where it hangs; pass scope "tree" for the complete goal, which is what an unanchored thread always gets and the only complete source for a whole-tree rewrite. This is a read — it mutates nothing. Errors cleanly if this thread has no active goal.',
    promptSnippet:
      "read this thread's active goal's task tree — your own branch by default, scope \"tree\" for the whole goal; mutates nothing.",
    promptGuidelines: [
      "You never pass a goalId — this always reads this thread's own active goal.",
      "The prompt-injected task tree is a frozen snapshot from your spawn; call this to see tasks a child has since added or completed. Every mutation echoes the tree at your scope, so you only need this read when you have not just written.",
      'Default scope is your own branch when you are anchored (the whole tree otherwise). Use scope "tree" deliberately: to place discovered work under the right phase, or — as the tree\'s owner — to get the complete rewrite source.',
    ].join("\n"),
  },
  goal_task_add: {
    description:
      "Append ONE task to the task tree of THIS thread's active goal — a targeted, concurrency-safe write that touches only the task it creates, so it is safe to fire mid-flight while others hold the tree. The goal is resolved from the session — you never pass a goalId, and you can only ever mutate your own thread's goal. Use it to record a single discovered actionable item (e.g. 'evaluate whether to fix pre-existing bug X') as a short imperative work item, nested under the task or theme it belongs to. It lands in your own branch by default when you are anchored; any task of the goal is a legal explicit parent, so work you discover elsewhere enters the shared tree the moment you find it — the echo shows where it landed, with its ancestors. To add several items at once, or to reshape your branch, use mcp__t3-code__goal_tasks_rewrite instead. Errors cleanly if this thread has no active goal.",
    promptSnippet: "add one task to this thread's goal task tree (nested under a parent task).",
    promptGuidelines: [
      "You never pass a goalId — the task is always added to this thread's own active goal.",
      "Omit parentTaskId to add inside your own branch (under your anchor). Pass a parentTaskId to nest the task under the phase it really belongs to — that is how out-of-branch discoveries reach the orchestrator live; it re-homes them if your placement was wrong. A top-level append is for a genuinely new phase of the goal, not the default.",
      "Write a short plain-language work item naming the outcome and its value (at most 300 characters), never a finding, verdict, or status note; details go in reports or memos.",
    ].join("\n"),
  },
  goal_task_update: {
    description:
      "Update ONE existing task in THIS thread's active goal: rename it (text) or mark it done / reopen it (done) — a targeted, concurrency-safe write that touches only that task, so it is safe to fire mid-flight while others hold the tree. The goal is resolved from the session; the taskId must belong to it, and when you are anchored it must be in your own branch — a task outside it is refused. This is how a thread marks its OWN task done the moment it finishes the work. Re-nesting, reordering and removing a task are not here: they are edits via mcp__t3-code__goal_tasks_rewrite.",
    promptSnippet:
      "update one task in this thread's goal: rename (text) or mark done/reopen (done).",
    promptGuidelines: [
      "taskId must be a task in this thread's own active goal, and inside your own branch when you are anchored. Work that needs doing on someone else's task goes in your report (or ask its thread with mcp__t3-code__consult_thread) — record new work with mcp__t3-code__goal_task_add.",
      "Pass only the fields you are changing; provide at least one of text or done. Mark your own task done as soon as the work lands, not at the end of the session — never rewrite it into a result record.",
      "Renamed text must be a short plain-language work item naming the outcome and its value (at most 300 characters), never a finding, verdict, or status note; details go in reports or memos.",
    ].join("\n"),
  },
  goal_tasks_rewrite: {
    description:
      "Replace what you own in THIS thread's goal task tree with the markdown you submit — the primary structural mutation. Restructure, re-nest, reorder, merge, rename, mark done, and prune in ONE call: submit the revised tree in the same `- [x] text (id)` checklist form mcp__t3-code__goal_task_list returns. Lines keeping an existing task's `(id)` ARE that task (its text, done-state, parent, and order become what you submitted; its creation time is preserved); lines without an id are new tasks; tasks you omit are deleted. Indentation (two spaces per level) is the nesting, so a cycle is unrepresentable. Scope follows ownership: the thread that owns the goal submits the WHOLE tree; an anchored thread submits exactly its BRANCH — one top-level line carrying its anchor's id plus everything beneath it, leaving the rest of the goal untouched. Rewrite from a fresh mcp__t3-code__goal_task_list read at that scope, since anything added since your last read and left out is lost. Rejected for a child with no anchor: the tree's owner does the restructuring.",
    promptSnippet:
      "replace the tree you own — the whole goal, or your own branch when you are anchored — with an edited markdown checklist (the mcp__t3-code__goal_task_list form); one call restructures, re-nests, renames, done-marks and prunes.",
    promptGuidelines: [
      "Read the live tree (mcp__t3-code__goal_task_list, or a mutation's echoed tree) and edit THAT text — keep the `(id)` marker on every task you retain, or it comes back as a brand-new task.",
      "The submission IS the resulting tree at your scope: a task you leave out is deleted, and indentation alone decides nesting. An empty submission, an unparseable line (the elision markers in an echoed open plan are deliberately unparseable — rewrite from a fresh read instead), or an `(id)` that is not in this goal is rejected and nothing is applied.",
      "Anchored: submit exactly your branch — its root line is your anchor, keeping its `(id)`. Your anchor can be renamed or ticked but never deleted, replaced or moved, and no line may carry the id of a task outside your branch.",
      "This is the tool that fixes shape and register: hang the concrete work under a handful of phase/theme parents, and rewrite journal-entry tasks into short plain-language items naming the outcome and value (at most 300 characters). The cap binds only text you add or change; retained verbatim text is grandfathered. Details, findings and verdicts go in reports or memos.",
      "A child with no anchor cannot rewrite at all: append with mcp__t3-code__goal_task_add, mark your own task done with mcp__t3-code__goal_task_update, and report a bad shape to the tree's owner.",
    ].join("\n"),
  },
  goal_handoff: {
    description:
      "Hand off a separate, out-of-scope piece of work as its OWN new goal. Not for tasks that belong under this thread's existing goal (use mcp__t3-code__goal_task_add instead). Use when you discover follow-up work that can be actioned by an independent agent. The receiving agent is highly capable and will plan and orchestrate the solution itself. It launches a new goal-bound root in its OWN worktree, which starts immediately on your brief — the brief is all it has of this thread, so write it as a goal charter (what and why), not a doer's assignment.",
    promptSnippet: "hand off discovered out-of-scope work as a new goal",
    promptGuidelines:
      "The new root starts immediately in its own worktree, with the brief as its only context of this thread; tell the user it is under way.",
  },
  goal_continue: {
    description:
      "Like mcp__t3-code__goal_handoff, but continues THIS goal in THIS worktree with a fresh context window: creates a held sibling session on the same goal, inheriting this thread's worktree, branch, and model — no new goal, no new worktree. Use it when a substantial hunk of work is done and the next phase should start with clean context while the overarching goal and its shared task tree carry on. The brief becomes the new session's first turn; a predecessor pointer to this thread is appended automatically so the successor can mcp__t3-code__consult_thread this session for detail. The human launches it with a single send. Returns the new threadId.",
    promptSnippet:
      "stage a fresh-context continuation session on THIS goal + worktree, pre-loaded with a handoff brief; a human's first send launches it.",
    promptGuidelines: [
      "Use this for the NEXT PHASE of this goal's work (fresh context, same goal/worktree/task tree) — not for separate work that deserves its own goal (mcp__t3-code__goal_handoff) and not for delegated sub-work (mcp__t3-code__workstream_spawn).",
      "The brief becomes the successor's first turn: write it self-contained — current state, what was done, what to do next, and where key artefacts live. A pointer back to this thread is appended automatically, so the successor can mcp__t3-code__consult_thread you for anything you leave out.",
      "The session is created held; the human launches it with one send. Update the goal's task tree (mark done / add next steps) before handing off — the successor sees the same tree.",
      "Name the sidebar card with threadTitle: a short (≤6-word) label for the next phase, e.g. 'Feature-importance deep dive'. Defaults to the goal title + '(continued)'.",
    ].join("\n"),
  },
  goal_update: {
    description:
      "Update the metadata of THIS thread's active goal: its title, description (a short objective statement, not a journal), and/or slug. The goal is resolved from the session — you never pass a goalId. Use this to keep the goal's framing accurate as understanding evolves. Pass only the fields you want to change.",
    promptSnippet: "update this thread's goal metadata (title / description / slug).",
    promptGuidelines: [
      "You never pass a goalId — this always updates this thread's own active goal.",
      "Pass only the fields you are changing; provide at least one of title, description, or slug.",
    ].join("\n"),
  },
  enable_toolset: {
    description:
      "Activate a dormant tool family in THIS session. Your role runs with a deliberately lean default tool surface; the full catalogue stays registered but inactive until enabled. Families: 'delegation' — the workstream graph-authoring and child-management tools (spawn, scaffold, brief, set_outcome, stop, prompt, dependencies, plus mcp__t3-code__notify_thread, mcp__t3-code__thread_fork and the goal handoff/continue/update tools) for handing work to a child — independent pieces your work splits into, or a bounded, context-heavy sub-phase of your own brief; 'human-input' — mcp__t3-code__ask_user_question, for a fork that is genuinely irreversible, destructive, or purely the user's preference, where a structured question beats a needs_guidance attention flag: it is available only to a thread a person has written to, and is refused on a child nobody has written to, whose question goes to its parent (mcp__t3-code__consult_thread) instead; 'pull-requests' — link, watch, unwatch, unlink and list the pull requests attached to this thread, so a PR's checks and merge state wake it (resident for orchestrators and shippers); 'browser' — the browser tools and T3's preview tools, for live web/UI driving and verification; 'studio' — the studio REPL and export tools; 'all' — every registered tool except the upstream orchestration and worktree tools Loom withholds from workstream threads (escape hatch). Activation applies from your next step and adds the enabled tools' own usage guidelines to your system prompt, so enable first, then act. Enable a family only when the task in front of you actually needs it — the lean default is deliberate. Enablement lasts for this session; re-enable if the tools go dormant after a restart.",
    promptSnippet:
      "activate a dormant tool family (delegation / human-input / pull-requests / browser / studio / all) when the task genuinely needs it; takes effect from your next step.",
    promptGuidelines: "",
  },
  ask_user_question: {
    description:
      "Ask the person who is reading this thread a structured question. It is active because a human has written to this thread — that is the only reason it is here. Use it for an irreversible, destructive or preference-only decision not settled by the request, codebase or prior context; otherwise state an assumption and proceed. Never ask to reconfirm scope or for approval you do not need. Coupled decisions, plan/design sign-offs or choices needing a walkthrough or supporting records belong in an MDX decision document; ask only a pointer question. A question your PARENT could answer (anything your brief left unsettled) goes to it via mcp__t3-code__consult_thread, not to the human. If you need human guidance but cannot frame options, use mcp__t3-code__workstream_request_attention with needs_guidance.",
    promptSnippet:
      "a person has written to this thread, so you can put an irreversible, destructive or preference-only decision to them as a structured question; otherwise proceed.",
    promptGuidelines: [
      "The user has read none of this thread or child reports. Even a document pointer needs, in order: the situation (what you are working on in plain words, the ticket reference so they can open it, and what just happened), one real example (named file/record/screen and literal content), stakes and why their decision is needed, then your pick with its reason.",
      "No internal shorthand as names ('D7', 'a1', 'must-fix #1'); no unexplained acronyms or symbols ('DI'); no references in place of substance ('per the report'). Explain what quoted figures measure and why they matter. A child's report is written for you, not the user: translate before you ask, and never pass on its questions, labels or ids as they stand.",
      "One question; two only if independent and answerable alone, despite the schema's capacity of four. Use mdx-visual-recap for decision documents, with evidence beside each decision.",
    ].join("\n"),
  },
} as const satisfies Record<string, LoomToolProse>;

export type LoomProseToolName = keyof typeof LOOM_TOOL_PROSE;
