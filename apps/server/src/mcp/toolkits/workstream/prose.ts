// LOOM-ONLY. Every text a model reads about Loom's agent tools. Loom supplies
// pi's preamble (`LOOM_PREAMBLE`), so pi renders no tools, rules or docs
// sections: the description in the tool schema is the ONLY surface a model
// reads for a tool, and a duty that binds after the call returns goes in its
// closing sentences, a rule for one field in that field's description
// (`defs.ts`). Keyed by the BARE MCP name (what the server registers); every
// tool named INSIDE the text uses the prefixed form the model sees
// (`mcp__t3-code__<name>`). `defs.ts` imports this record for its prose
// fields; the registration carries snippet and guidelines in the tool's `_meta`
// (`loom/promptSnippet`, `loom/promptGuidelines`) for upstream's bridge to read.
// Authoring doctrine: docs/architecture/tool-def-authoring.md.

export interface LoomToolProse {
  readonly description: string;
  /** Inert under Loom's preamble (pi lists snippets only in its own tools section); kept for the bridge. */
  readonly promptSnippet: string;
  /** Always empty: a guideline lands in pi's rules section, which Loom's preamble removes. */
  readonly promptGuidelines: string;
}

export const LOOM_TOOL_PROSE = {
  workstream_spawn: {
    description:
      "Spawn a T3 Code Workstream sub-thread as a child of the current thread. Identify the work with three distinct fields: a role, a short title (the card's name — roughly ≤6 words, leading with the distinguishing subject rather than a verb every sibling shares), and a purpose (1-3 sentences, shown on the sidebar card as the thread's 'Goal') that states the value the work delivers — the capability, fix, or decision it produces, NOT the role or the mechanical steps. Put the full instructions in brief instead. The child runs in THIS thread's worktree: every child shares its parent's checkout and has no branch of its own, so what you commit is visible to it at once and paths you give it are valid as written. A child with no dependencies starts working immediately. A child given blockedBy stays un-started until every dependency thread reaches outcome 'done', then starts automatically. To gate work, spawn the dependency first, then spawn the dependent with gate: { rework: thatChildThreadId }; gate.rework is automatically added to blockedBy. Model choice: for most spawns, pass NO model fields — the child takes a preset matching its role, or inherits this thread's model. Only when the task clearly matches one of three shapes should you pass taskShape ('explore' / 'thorough' / 'mechanical'), a single token the server resolves to a concrete model (never pick a model by name). modelSelection / modelPreset are escape hatches for the rare case you genuinely need a specific model. Full precedence: explicit modelSelection > modelPreset > taskShape > role preset > inherit this thread's model. A valid taskShape on a server with no matching profiles simply falls through to the role preset/inherit with a warning (never an error). For laying out a MULTI-NODE graph, prefer mcp__t3-code__workstream_scaffold + mcp__t3-code__workstream_brief: scaffold defines the whole topology by symbolic key in one cheap call, then briefs are written just-in-time. mcp__t3-code__workstream_spawn is the one-node shortcut (scaffold-one-node + brief in a single call).",
    promptSnippet:
      "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override. For a multi-node graph prefer mcp__t3-code__workstream_scaffold + mcp__t3-code__workstream_brief.",
    promptGuidelines: "",
  },
  workstream_scaffold: {
    description:
      "Author a whole T3 Code Workstream graph SHAPE in one call — the topology-first half of graph authoring. Reach for this as soon as work firms up into more than a couple of dependent pieces; a series of ad-hoc mcp__t3-code__workstream_spawn calls builds the same graph blind, forfeiting shape review and visible parallelism. Each node carries only cheap metadata (key, role, title, purpose, and the same optional model fields as mcp__t3-code__workstream_spawn) plus its blockedBy edges and gate, all referenced by SYMBOLIC KEY. Threads are created eagerly (real ids, returned in the result) but NONE can launch yet: a node launches only once it ALSO has a brief (mcp__t3-code__workstream_brief). This lets you lay out the entire solution shape cheaply and instantly, get it reviewed, then write each node's token-heavy brief just-in-time in topological order — a late brief can reference the actual reports of upstream nodes that already finished. Every node runs in this thread's worktree, as a spawned child does. References: use the node's `key` for an intra-scaffold edge, or `thread:<id>` for an existing child; a bare UUID-shaped key is rejected (paste an existing id with the `thread:` prefix). Validation is all-or-nothing — on any error (duplicate key, dangling reference, dependency cycle) nothing is created and the error names the offending key. A later mcp__t3-code__workstream_scaffold call is a DELTA: its blockedBy may reference existing children by key or `thread:` id, extending the live graph.",
    promptSnippet:
      "lay out a whole child graph shape in one call (nodes with keys + blockedBy/gate edges, no briefs); each node then needs mcp__t3-code__workstream_brief before it launches.",
    promptGuidelines: "",
  },
  workstream_brief: {
    description:
      "Attach the kickoff brief that becomes a scaffolded node's first-turn assignment (its recipient contract and register are on the markdown parameter), just-in-time. This is the second half of graph authoring: a node created by mcp__t3-code__workstream_scaffold cannot launch until it has a brief (its launch precondition is dependencies-satisfied AND brief-present). Identify the node by its scaffold `key` or its thread id. Valid only on a direct child that has NOT started yet; on a started child it errors (steer a running child with mcp__t3-code__workstream_prompt instead). Calling it again pre-launch overwrites (editing the brief before launch is the expected path). The brief is stored at a stable path the call returns; the kickoff reads the file's current content at launch, so writing briefs in topological order lets a late brief incorporate the actual reports of upstream nodes that already completed.",
    promptSnippet:
      "write one scaffolded node's kickoff brief (by key or thread id); the node launches once briefed and its deps are done. Overwrite allowed pre-launch.",
    promptGuidelines: "",
  },
  workstream_set_outcome: {
    description:
      "Set the PLAN outcome of a T3 Code Workstream thread you own (this thread or one you directly spawned): 'done', 'cancelled', or 'none'. 'done' is the only outcome that releases dependents and lets the next thread start; it is how you accept a child's work when the child yielded to you instead of completing (a quiescent child whose report was synthesised, an unmatched outcome token). 'cancelled' abandons the work and does NOT release dependents — and it CASCADES: cancelling a thread also cancels every non-terminal descendant (children, grandchildren, …) and interrupts any in-flight turn among them, so cancelling a runaway branch kills the whole chain beneath it (already-done descendants are left untouched). 'none' reopens a finished thread — clears its outcome so it can be prompted again; do this before you prompt a done or cancelled child, so the board never shows a finished thread working. Completing your OWN work goes through mcp__t3-code__workstream_submit, never here: a self-issued 'done' is refused while a rework is pending on you or you are a member of an unresolved review gate, because it would skip the routing; a parent's 'done' on such a child is allowed, with a warning. To dissolve a stuck gate, mark the REVIEWER done, not the coder — the coder's done is what the reviewer's verdict decides. This is the plan axis only: to pull in a human, use mcp__t3-code__workstream_request_attention.",
    promptSnippet:
      "set a thread's plan outcome: 'done' releases dependents (how you accept a yielded child); 'cancelled' cascades to the whole subtree and stops in-flight turns; 'none' reopens.",
    promptGuidelines: "",
  },
  workstream_request_attention: {
    description:
      "Raise an attention flag on a T3 Code Workstream thread you own (this thread or one you directly spawned) — the single surface that pulls in a human. A raise HOLDS the work for that human; it is your turn's last act, not a label you attach to a report. The hold clears only when a human writes to the thread or its parent prompts it (at the start of that turn), or when the thread reaches done/cancelled — so completing yourself erases the hold and releases your dependents, and the submit path refuses a plain completion while a flag you raised stands, whether you raised it this turn or an earlier one; a raise on an already-finished thread is refused too. To hand a report back with the hold intact, pass a short non-'done' outcome to mcp__t3-code__workstream_submit: the report is recorded and you yield to your parent, flag standing. Two reasons: 'awaiting_acceptance' means a human (or the parent, when it already holds the human's decision) must accept this thread's output before its outcome may reach 'done' and its dependents release — it is NOT 'some reviewer thread should look at this' (a thread whose output flows to a separate reviewer thread just completes, which releases that reviewer). 'needs_guidance' means you cannot proceed without a human — including when what you want is answers to your questions, which is guidance, not acceptance. For a child it is the LAST resort: your parent wrote your brief and holds the context, and usually no human reads a child thread — consult the parent first (mcp__t3-code__consult_thread) and raise only if that does not settle it or the parent has finished. Write the accompanying report for a human who has read none of this thread: explain the blocker without relying on internal labels or unseen reports.",
    promptSnippet:
      "raise a hold for a human — 'awaiting_acceptance' (your output needs sign-off before it may be done) or 'needs_guidance' (you're stuck, or you need answers); the raise ends your turn, so don't complete yourself in the same turn.",
    promptGuidelines: "",
  },
  workstream_stop: {
    description:
      "Stop a direct child Workstream thread you spawned: interrupt its active turn and leave it idle with its outcome unset (it stays in progress on the board). This is an ORCHESTRATOR pause — you own restarting it (resume it with mcp__t3-code__workstream_prompt). No attention flag is raised, because you are the resumer; a child you never resume eventually reads as gone quiet and is yielded back to you after the quiescence grace.",
    promptSnippet:
      "interrupt a direct child's active turn (orchestrator pause; you own the resume via mcp__t3-code__workstream_prompt).",
    promptGuidelines: "",
  },
  workstream_prompt: {
    description:
      "Send a markdown message to a DIRECT child Workstream thread you spawned — you acting on the child as its parent. On an idle child (e.g. one you paused with mcp__t3-code__workstream_stop) this starts the next turn with your message — the resume path. On a busy child with an open turn it becomes a queued steer, folded in between model rounds. A child whose turn has not begun (just launched, still starting, or waiting on an answer) cannot take a steer yet: your message is queued, then steered in once the turn is up (within about a minute), or it starts the next turn if that one ends first; the result says whether it started, steered or queued. A steer canNOT penetrate a blocked/hung tool call — if the child is stuck inside a tool call, mcp__t3-code__workstream_stop it first, then prompt to restart it with guidance. Prompting a child that holds an attention flag (needs_guidance, awaiting_acceptance, or a yield awaiting you) CLEARS that hold when the turn starts, so prompt a flagged child only when you actually hold the answer or the approval it is waiting for; clearing it is your decision as the parent, not the human's approval, and is never reported upward as such. The child reads your message labelled as its parent orchestrator's — an agent's — which the human's messages outrank. On a child that has NOT started yet (briefed but waiting on a dependency, or briefed and not yet launched): your message is appended to its brief as an amendment and no turn starts — the child reads the brief plus every amendment as its first turn when the control plane launches it, and the result names what it is still waiting on. Amendments stack in order; a later mcp__t3-code__workstream_brief replaces the whole brief, amendments included. If the child has NO brief yet, the call is rejected with guidance to call mcp__t3-code__workstream_brief first. Prompting never launches a child: launch is the control plane's, once its dependencies are done. A finished child (outcome done or cancelled) is reopened with mcp__t3-code__workstream_set_outcome 'none' before you prompt it.",
    promptSnippet:
      "send a message to a direct child, labelled to it as its parent's: resumes an idle child or steers a busy one, and clears a hold the child raised (a steer won't penetrate a hung tool call — stop first, then prompt).",
    promptGuidelines: "",
  },
  workstream_set_dependencies: {
    description:
      "Declare which threads a T3 Code Workstream thread waits on. Replaces the full blockedBy set for a thread you own (this thread or a thread you directly spawned). This is a re-planning operation: it re-gates a not-yet-started thread, but setting dependencies on an already-started thread returns a warning — the edge is recorded for display only and never un-runs the thread. To gate a child's execution from the start, pass blockedBy at spawn time instead.",
    promptSnippet:
      "adjust the blockedBy set of a not-yet-started thread (re-planning only; does not gate an already-started thread).",
    promptGuidelines: "",
  },
  workstream_submit: {
    description:
      "THE single terminal call for a T3 Code Workstream sub-thread: submit your markdown report plus a structured outcome, and the control plane derives what happens next — you never set your own outcome at completion. Omit outcome (or pass 'done') for plain completion: the report is recorded and your outcome becomes done in one step, releasing dependents — refused while an attention flag you raised stands, this turn or an earlier one, because completing would clear it (pass an outcome token instead and you yield with the flag standing). Pass outcome 'needs_human' to record the report and raise the needs_guidance flag instead (a human is pulled in; your outcome is unchanged). Any other outcome token (e.g. 'rework_approach', or review verdicts like 'needs_rework'/'clean'/'fixed_inline' when you are in a review gate) is routed by the control plane; during an active rework round it routes back to the reviewer for re-verification, otherwise an outcome with no matching route YIELDS you to your live parent orchestrator with your report — escalation is the safe default, and you are NOT done in that case. The tool result echoes the routing decision: read it — 'yielded' or a rework route means you are NOT done. Submit explicitly: a thread that ends its turn without submitting is, after a grace, treated as having gone quiet — the control plane synthesises a report from its last message and yields that to the parent, marked as synthesised, which is a worse hand-back than the one you would have written.",
    promptSnippet:
      "submit your report + outcome in one terminal call: plain completion → done; 'needs_human' → human flag; any other outcome → routed, with unmatched non-rework outcomes yielding to your orchestrator.",
    promptGuidelines: "",
  },
  workstream_list: {
    description:
      "Your workstream's thread graph, indented by lineage: each thread's id, role, title, status, attention flags and report path, plus last-activity and waits-on for threads still running. detail: \"full\" adds every thread's purpose, anchor task and pi session path. A child marked 'went quiet; report synthesised' ended its turn without submitting — its report is the control plane's reconstruction, not a hand-back.",
    promptSnippet:
      'your workstream\'s thread graph: ids, roles, status, attention and report paths; detail: "full" adds purposes, anchors and session paths.',
    promptGuidelines: "",
  },
  consult_thread: {
    description:
      'Read-only consult of another thread, answered from a frozen fork of that thread\'s session: it reaches ANY thread the server knows (across worktrees and projects), never wakes or mutates the target, and the answer is what the target knew as of its last turn. Use it to ask the thread that holds the context. For a child, that is usually your PARENT — it wrote your brief and usually no human reads your thread, so a question the brief does not settle goes here before any human hold. Also use it when the user points you at another thread by name ("ask the liveness-detection thread …") or via an @-mention. Identify the target by exactly one of: threadId (preferred; an @-mentioned thread arrives in the message as [Title](t3-thread://v1/<id>) — pass that <id>), or name (a fuzzy sidebar-title match). If a name matches several threads it returns ranked candidates instead of guessing; surface them and confirm, then call again with the chosen threadId. To push a message the target acts on, use mcp__t3-code__notify_thread. The target never learns it was asked, so quote the question and the answer verbatim in your report to put the decision on the record.',
    promptSnippet:
      "ask another thread a read-only question (answered from a frozen fork) by id, @-mention, or name; a child's first stop for anything its brief leaves unsettled is its parent.",
    promptGuidelines: "",
  },
  notify_thread: {
    description:
      'Push a markdown message into ANY other live thread the server knows, across orchestration trees, worktrees, and projects: the write counterpart of the read-only mcp__t3-code__consult_thread. Delivery is steer-or-start and never aborts a turn: a busy recipient is steered — your message is folded into its running turn between model rounds — and an idle recipient starts a new turn with it (it will spend tokens acting on it). A finished target is refused: a notification never re-engages a thread that is done, cancelled, archived or deleted. The recipient sees it framed as a notification from your thread (title, id, and your relationship to it, if any) and owes no reply: this call is fire-and-forget, and its result says how the message landed (started a turn, steered a running one, or queued), never an answer. Use it to tell a thread something it is waiting to hear, e.g. "the extraction run you depend on is complete; results at <path>". It is NOT for getting information back (mcp__t3-code__consult_thread asks a read-only question and returns the answer; or ask the recipient in your message to notify you back, and carry on until it does), not for directing your own children (mcp__t3-code__workstream_prompt), not for reporting to your parent (mcp__t3-code__workstream_submit), not for creating work (mcp__t3-code__workstream_spawn), and not for reaching non-T3 pi sessions on this machine (intercom); mcp__t3-code__notify_thread addresses durable T3 threads and leaves transcript and graph provenance. Identify the target by threadId, or by name (fuzzy sidebar-title match); an ambiguous name sends nothing and returns ranked candidates. A sender→target pair is capped at a handful of messages per hour; a back-and-forth exchange hits it.',
    promptSnippet:
      "push a fire-and-forget message into any other live thread, by id or name; it steers a busy recipient or starts an idle one, and never aborts a turn.",
    promptGuidelines: "",
  },
  set_thread_title: {
    description:
      "Rename THIS thread's own sidebar title in T3 Code. You pass only a title; the thread is always resolved from the session, so you can only ever rename yourself — never another thread or a child. Use it to keep the sidebar legible: e.g. when a root's auto-from-first-message title is unhelpful, or when a child's scope has sharpened into something more specific than its spawn title. This does not touch the goal (use mcp__t3-code__goal_update for that).",
    promptSnippet: "rename this thread's own sidebar title to keep the workstream legible.",
    promptGuidelines: "",
  },
  snooze_thread: {
    description:
      "Snooze THIS thread out of the human's inbox once your current turn ends, until the ISO-8601 datetime you pass (`until`, at most 30 days ahead). The thread is always resolved from the session, so you can only ever snooze yourself — never another thread or a child. The snooze is deferred, not immediate: a snooze applied mid-turn would be undone the moment the run completes, so the server records your request and applies it when this turn finishes idle. It is a quiet-until-something-happens hold, not a lock: any inbound message — a pull-request watch wake, a notification, a human reply, a parent's prompt — un-snoozes the thread at once, and the thread wakes on its own when `until` passes. Use it after a triage pass on work you are only babysitting (typically a watched pull request), so the thread costs the human no attention until the watch wakes you or the snooze lapses. Calling it again simply replaces the pending request — re-snooze with the same `until` after each wake you have handled; pass cancel: true to withdraw a request made earlier this turn. A turn that ends with a pending question or an attention flag is never hidden — the human must see those.",
    promptSnippet:
      "hide this thread from the human's inbox once your turn ends, until a datetime you pass; any inbound message (a PR watch wake, a reply) un-snoozes it.",
    promptGuidelines: "",
  },
  thread_fork: {
    description:
      "Fork THIS thread: create a new held thread that starts with a full copy of this thread's conversation context and then diverges independently. Use it to explore an alternate direction without disturbing this thread — the fork inherits this thread's goal, model, and worktree, and its FIRST launch forks this thread's pi session (native fork), so no tokens are spent until a human sends the divergent first message. The fork is a SIBLING that never merges back (it is divergence, not delegation — use mcp__t3-code__workstream_spawn for delegated sub-work, or mcp__t3-code__goal_continue for a fresh-context next phase of this goal). Returns the new threadId; tell the user the fork is waiting for their first message.",
    promptSnippet:
      "fork this thread into a held copy of its full context that then diverges independently; a human's first send launches it.",
    promptGuidelines: "",
  },
  goal_task_list: {
    description:
      'Read the task tree of THIS thread\'s active goal (the shared tree, resolved from the session — you never pass a goalId). Use it for orientation and reconciliation: the tree injected into your prompt is a snapshot from your spawn and is never refreshed, so a child may have marked its task done or added discovered work your snapshot does not reflect. If you are anchored to a branch, this returns THAT branch in full — its checklist block is the exact text a branch rewrite takes — preceded by the read-only spine showing where it hangs; pass scope "tree" for the complete goal, which is what an unanchored thread always gets and the only complete source for a whole-tree rewrite. This is a read — it mutates nothing; every mutation echoes the tree at your scope, so a read straight after your own write is redundant. Errors cleanly if this thread has no active goal.',
    promptSnippet:
      "read this thread's active goal's task tree — your own branch by default, scope \"tree\" for the whole goal; mutates nothing.",
    promptGuidelines: "",
  },
  goal_task_add: {
    description:
      "Append ONE task to the task tree of THIS thread's active goal — a targeted, concurrency-safe write that touches only the task it creates, so it is safe to fire mid-flight while others hold the tree. The goal is resolved from the session — you never pass a goalId, and you can only ever mutate your own thread's goal. Use it to record a single discovered actionable item (e.g. 'evaluate whether to fix pre-existing bug X') as a short imperative work item, nested under the task or theme it belongs to. It lands in your own branch by default when you are anchored; any task of the goal is a legal explicit parent, so work you discover elsewhere enters the shared tree the moment you find it — the echo shows where it landed, with its ancestors. To add several items at once, or to reshape your branch, use mcp__t3-code__goal_tasks_rewrite instead. Errors cleanly if this thread has no active goal.",
    promptSnippet: "add one task to this thread's goal task tree (nested under a parent task).",
    promptGuidelines: "",
  },
  goal_task_update: {
    description:
      "Update ONE existing task in THIS thread's active goal: rename it (text) or mark it done / reopen it (done) — a targeted, concurrency-safe write that touches only that task, so it is safe to fire mid-flight while others hold the tree. The goal is resolved from the session; the taskId must belong to it, and when you are anchored it must be in your own branch — a task outside it is refused. This is how a thread marks its OWN task done the moment it finishes the work. Work needed on a task outside your branch goes in your report; new work is recorded with mcp__t3-code__goal_task_add. Re-nesting, reordering and removing a task are not here: they are edits via mcp__t3-code__goal_tasks_rewrite.",
    promptSnippet:
      "update one task in this thread's goal: rename (text) or mark done/reopen (done).",
    promptGuidelines: "",
  },
  goal_tasks_rewrite: {
    description:
      "Replace what you own in THIS thread's goal task tree with the markdown you submit — the primary structural mutation. Restructure, re-nest, reorder, merge, rename, mark done, and prune in ONE call: submit the revised tree in the same `- [x] text (id)` checklist form mcp__t3-code__goal_task_list returns. Lines keeping an existing task's `(id)` ARE that task (its text, done-state, parent, and order become what you submitted; its creation time is preserved); lines without an id are new tasks; tasks you omit are deleted. A deleted task comes back, with its id, if you resubmit its line with its `(id)`. Indentation (two spaces per level) is the nesting, so a cycle is unrepresentable. Scope follows ownership: the thread that owns the goal submits the WHOLE tree; an anchored thread submits exactly its BRANCH — one top-level line carrying its anchor's id plus everything beneath it, leaving the rest of the goal untouched. Rewrite from a fresh mcp__t3-code__goal_task_list read at that scope, since anything added since your last read and left out is lost. Rejected for a child with no anchor: the tree's owner does the restructuring (append with mcp__t3-code__goal_task_add and tick with mcp__t3-code__goal_task_update instead).",
    promptSnippet:
      "replace the tree you own — the whole goal, or your own branch when you are anchored — with an edited markdown checklist (the mcp__t3-code__goal_task_list form); one call restructures, re-nests, renames, done-marks and prunes.",
    promptGuidelines: "",
  },
  goal_handoff: {
    description:
      "Hand off a separate, out-of-scope piece of work as its OWN new goal. Not for tasks that belong under this thread's existing goal (use mcp__t3-code__goal_task_add instead). Use when you discover follow-up work that can be actioned by an independent agent. The receiving agent is highly capable and will plan and orchestrate the solution itself. It launches a new goal-bound root in its OWN worktree, which starts immediately on your brief — the brief is all it has of this thread, so write it as a goal charter (what and why), not a doer's assignment. The root is told the brief is agent-written and treats it as a proposal, not the human's approved plan: quote the human's words where you relay them, and describe rather than instruct. A likely duplicate (an open thread already doing the work) launches nothing and is named in the result: consult or notify that thread instead, or repeat the call with notDuplicateOf when your work is genuinely distinct.",
    promptSnippet: "hand off discovered out-of-scope work as a new goal",
    promptGuidelines: "",
  },
  goal_continue: {
    description:
      "Like mcp__t3-code__goal_handoff, but continues THIS goal in THIS worktree with a fresh context window: creates a held sibling session on the same goal, inheriting this thread's worktree, branch, and model — no new goal, no new worktree. Use it when a substantial hunk of work is done and the next phase should start with clean context while the overarching goal and its shared task tree carry on. The brief becomes the new session's first turn; a predecessor pointer to this thread is appended automatically so the successor can mcp__t3-code__consult_thread this session for detail. The human launches it with a single send: sent unchanged, the brief stays your agent-authored words, not the human's and not approval of its contents; if the human edits it first, the edited message is treated as theirs. Returns the new threadId. Before calling it, bring the goal up to date — the successor starts from it, and it has usually drifted: rewrite its title and objective with mcp__t3-code__goal_update and tick or add tasks in its tree.",
    promptSnippet:
      "stage a fresh-context continuation session on THIS goal + worktree, pre-loaded with a handoff brief; a human's first send launches it.",
    promptGuidelines: "",
  },
  goal_update: {
    description:
      "Update the metadata of THIS thread's active goal: its title, description (a short objective statement, not a journal), and/or slug. The goal is resolved from the session — you never pass a goalId. Use this to keep the goal's framing accurate as understanding evolves. Pass only the fields you want to change.",
    promptSnippet: "update this thread's goal metadata (title / description / slug).",
    promptGuidelines: "",
  },
  ask_user_question: {
    description:
      "Ask the person who is reading this thread a structured question. It is active because a human has written to this thread — that is the only reason it is here. Use it for an irreversible, destructive or preference-only decision not settled by the request, codebase or prior context; otherwise state an assumption and proceed. Never ask to reconfirm scope or for approval you do not need. Coupled decisions, plan/design sign-offs or choices needing a walkthrough or supporting records belong in an MDX decision document; ask only a pointer question. A question your PARENT could answer (anything your brief left unsettled) goes to it via mcp__t3-code__consult_thread, not to the human. If you need human guidance but cannot frame options, use mcp__t3-code__workstream_request_attention with needs_guidance.",
    promptSnippet:
      "a person has written to this thread, so you can put an irreversible, destructive or preference-only decision to them as a structured question; otherwise proceed.",
    promptGuidelines: "",
  },
  // Local process tools registered by Loom's pi extension (`backgroundJobs.ts`), not MCP tools:
  // bare names, like pi's own `bash`.
  bg_start: {
    description:
      "Run here, not in bash, any command that may take more than about two minutes: an eval, a pipeline, a build or test suite, a deliberate delay. A foreground bash call holds your turn until the command ends and cannot be steered, and a `sleep` waiting for it cannot end early. The job starts at once in the working directory with stdout and stderr captured to a log; the result is the job id, pid and log path. Its exit code and last output lines reach you in bg_wait if you are waiting there, otherwise as a new message (one that starts a turn if yours has ended). Before starting, make sure the command writes progress as it runs (a line per item, a counter, a growing results file): bg_wait shows only what the job writes, and a job silent until the end cannot be told from one that is stuck. Commands that finish in seconds stay in bash. Never wait with a bash `sleep` of a minute or more for a process, a service or the clock: run the `sleep N` here instead and wait on it with bg_wait. The job dies with this session: Stop, a server restart, or more than four hours idle ends it, and your next turn is told.",
    promptSnippet:
      "start a command that may run more than about two minutes in the background, with a wake when it exits",
    promptGuidelines: "",
  },
  bg_wait: {
    description:
      "Wait for a job started with bg_start. Returns the moment the job exits, with its exit code and the last lines of its log; or when timeout_s runs out with the job still running, with how long it has run against your bounds, how much the log grew since your last check, and its latest lines. That timeout result is a progress report, not a failure: when the log is still advancing, wait again; stop the job (`kill <pid>`) only when its output shows it has stalled, is failing, or is doing the wrong work. Aborting this call leaves the job running.",
    promptSnippet:
      "wait for a background job: returns at its exit, or with its progress at a timeout",
    promptGuidelines: "",
  },
} as const satisfies Record<string, LoomToolProse>;

export type LoomProseToolName = keyof typeof LOOM_TOOL_PROSE;
