// LOOM-ONLY. Every text a model reads about Loom's agent tools. Loom supplies
// pi's preamble (`LOOM_PREAMBLE`), so pi renders no tools, rules or docs
// sections: the description in the tool schema is the ONLY surface a model
// reads for a tool. A description says what the tool does, the consequences
// the caller must act on, and when another tool is the better choice; a rule
// about one field is on that field (`defs.ts`); a mechanism the result reports
// or the control plane handles either way is not written. Keyed by the BARE
// MCP name (what the server registers); every tool named INSIDE the text uses
// the prefixed form the model sees (`mcp__t3-code__<name>`). `defs.ts` imports
// this record for its prose fields; the registration carries snippet and
// guidelines in the tool's `_meta` (`loom/promptSnippet`,
// `loom/promptGuidelines`) for upstream's bridge to read.
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
      "Spawn a child thread of this thread: delegated work with its own role, title, purpose and brief. The child runs in this worktree, so what you commit it sees at once and paths you give it are valid as written. It starts as soon as every thread in blockedBy is done, at once when there are none. For a graph of several dependent nodes, lay out the shape with mcp__t3-code__workstream_scaffold and brief each node with mcp__t3-code__workstream_brief.",
    promptSnippet:
      "launch a durable child thread for delegated work: role + short title + purpose + optional brief, blockedBy (waits-on ids), and an optional model override. For a multi-node graph prefer mcp__t3-code__workstream_scaffold + mcp__t3-code__workstream_brief.",
    promptGuidelines: "",
  },
  workstream_scaffold: {
    description:
      "Create a whole child graph in one call: nodes named by symbolic key, with blockedBy and gate edges between them. The threads exist at once, but none launches until it has a brief (mcp__t3-code__workstream_brief) and its dependencies are done, so briefs are written in topological order and a late one can cite the reports of nodes already finished. A node runs in this worktree, as a spawned child does. A later call is a delta: its edges may name existing children by key or `thread:<id>`.",
    promptSnippet:
      "lay out a whole child graph shape in one call (nodes with keys + blockedBy/gate edges, no briefs); each node then needs mcp__t3-code__workstream_brief before it launches.",
    promptGuidelines: "",
  },
  workstream_brief: {
    description:
      "Write a scaffolded node's kickoff brief, by key or thread id; the node launches once it is briefed and its dependencies are done. Valid only on a direct child that has not started. Calling it again before launch replaces the whole brief, amendments from mcp__t3-code__workstream_prompt included. A started child is steered with mcp__t3-code__workstream_prompt.",
    promptSnippet:
      "write one scaffolded node's kickoff brief (by key or thread id); the node launches once briefed and its deps are done. Overwrite allowed pre-launch.",
    promptGuidelines: "",
  },
  workstream_set_outcome: {
    description:
      "Set the plan outcome of this thread or a direct child. 'done' is how you accept a child that yielded to you instead of completing; 'none' reopens a finished child before you prompt it again. Your own completion goes through mcp__t3-code__workstream_submit, which routes it. To pull in a human, mcp__t3-code__workstream_request_attention.",
    promptSnippet:
      "set a thread's plan outcome: 'done' releases dependents (how you accept a yielded child); 'cancelled' cascades to the whole subtree and stops in-flight turns; 'none' reopens.",
    promptGuidelines: "",
  },
  workstream_request_attention: {
    description:
      "Raise an attention flag that holds this thread, or a child you spawned, for a human; make it your turn's last act, since completing clears it. 'awaiting_acceptance': a human (or your parent, holding the human's decision) must accept this thread's output before it can be done. 'needs_guidance': you cannot proceed without a human, including when what you need is answers. To hand back a report while the flag stands, submit with a short non-'done' outcome. A child consults its parent first (mcp__t3-code__consult_thread); usually no human reads a child thread. Write the report for someone who has read none of this thread.",
    promptSnippet:
      "raise a hold for a human: 'awaiting_acceptance' (your output needs sign-off before it may be done) or 'needs_guidance' (you're stuck, or you need answers); the raise ends your turn, so don't complete yourself in the same turn.",
    promptGuidelines: "",
  },
  workstream_stop: {
    description:
      "Interrupt a direct child's active turn and leave it idle with its outcome unset, for you to resume with mcp__t3-code__workstream_prompt; no attention flag is raised.",
    promptSnippet:
      "interrupt a direct child's active turn (orchestrator pause; you own the resume via mcp__t3-code__workstream_prompt).",
    promptGuidelines: "",
  },
  workstream_prompt: {
    description:
      "Send a markdown message to a direct child you spawned, as its parent. It starts or steers the child's next turn; a child that has not launched yet reads it as part of its brief. A steer reaches a child waiting in bg_wait at once but waits out any other tool call in progress, so mcp__t3-code__workstream_stop a child stuck in one first. Prompting a child that holds an attention flag clears the hold when its turn starts: do it only when you hold what the child is waiting for. Reopen a finished child (mcp__t3-code__workstream_set_outcome 'none') before prompting it.",
    promptSnippet:
      "send a message to a direct child, labelled to it as its parent's: resumes an idle child or steers a busy one, and clears a hold the child raised (a steer won't penetrate a hung tool call: stop first, then prompt).",
    promptGuidelines: "",
  },
  workstream_set_dependencies: {
    description:
      "Replace the blockedBy set of this thread or a direct child. It re-gates a child that has not started; on a started thread the edge is recorded for display only and never pauses or re-runs it (pause with mcp__t3-code__workstream_stop).",
    promptSnippet:
      "adjust the blockedBy set of a not-yet-started thread (re-planning only; does not gate an already-started thread).",
    promptGuidelines: "",
  },
  workstream_submit: {
    description:
      "Your terminal call: hand back your markdown report with an outcome, and the control plane routes it; you never set your own outcome at completion. Omitted or 'done' completes you and releases your dependents; it is refused while an attention flag you raised stands (pass another token and you yield with the flag intact). 'needs_human' records the report and raises needs_guidance. A review-gate verdict ('clean', 'fixed_inline', 'needs_rework') routes the gate; in a rework round every outcome but 'needs_human' routes back to the reviewer; any other token yields you to your parent, and you are not done. A turn that ends without submitting is, after a grace, treated as gone quiet: the control plane synthesises a report from your last message and yields that instead.",
    promptSnippet:
      "submit your report + outcome in one terminal call: plain completion → done; 'needs_human' → human flag; any other outcome → routed, with unmatched non-rework outcomes yielding to your orchestrator.",
    promptGuidelines: "",
  },
  workstream_list: {
    description:
      "Your workstream's thread graph by lineage: each thread's id, role, title, status, attention flags and report path, plus last activity and waits-on for threads still running. A child marked 'went quiet; report synthesised' never submitted; its report is the control plane's reconstruction, not a hand-back.",
    promptSnippet:
      'your workstream\'s thread graph: ids, roles, status, attention and report paths; detail: "full" adds purposes, anchors and session paths.',
    promptGuidelines: "",
  },
  consult_thread: {
    description:
      "Ask any thread the server knows a read-only question, answered from a frozen fork of its session as of its last turn; the target is never woken or changed and never learns it was asked, so quote the question and answer in your report. For a child, the parent that wrote its brief is usually the thread to ask, before any human hold. To push a message the target acts on, mcp__t3-code__notify_thread.",
    promptSnippet:
      "ask another thread a read-only question (answered from a frozen fork) by id, @-mention, or name; a child's first stop for anything its brief leaves unsettled is its parent.",
    promptGuidelines: "",
  },
  thread_search: {
    description:
      "Find the past thread where something was discussed, decided or built: it searches every thread's title, purpose, brief, goal and tasks, the human's and the orchestrator's messages, each turn's final answer and every workstream report, archived threads included, by meaning as well as by words, and returns top-level threads best-first with the sub-thread and the kind of text that matched. A short phrase in the words the thread would have used finds more than a long keyword bag; a ticket, file or PR name matches exactly. Each hit carries the report path of the thread that matched, the distilled record to read first; for what the report leaves open, mcp__t3-code__consult_thread asks that thread directly.",
    promptSnippet:
      "find the past thread where something was discussed or decided, by meaning or exact identifier, archived included; hits carry the matched thread's report path.",
    promptGuidelines: "",
  },
  notify_thread: {
    description:
      "Push a markdown message into any other live thread, across trees, worktrees and projects: it steers a busy recipient or starts an idle one, never aborts a turn, and earns no reply. Use it to tell a thread something it is waiting to hear. For an answer, mcp__t3-code__consult_thread; to direct your own child, mcp__t3-code__workstream_prompt. A sender-to-target pair is capped at a few messages an hour, which a back-and-forth exchange hits.",
    promptSnippet:
      "push a fire-and-forget message into any other live thread, by id or name; it steers a busy recipient or starts an idle one, and never aborts a turn.",
    promptGuidelines: "",
  },
  set_thread_title: {
    description:
      "Rename this thread's own sidebar title, e.g. when a root's auto-title is unhelpful or a child's scope has sharpened. The goal's title is mcp__t3-code__goal_update's.",
    promptSnippet: "rename this thread's own sidebar title to keep the workstream legible.",
    promptGuidelines: "",
  },
  snooze_thread: {
    description:
      "Hide this thread from the human's inbox once this turn ends, until `until`; any inbound message (a pull-request watch wake, a notification, a reply, a parent's prompt) un-snoozes it at once. Use it after a triage pass on work you are only babysitting, typically a watched pull request. Calling it again replaces the pending request. A turn that ends with a pending question or an attention flag is never hidden.",
    promptSnippet:
      "hide this thread from the human's inbox once your turn ends, until a datetime you pass; any inbound message (a PR watch wake, a reply) un-snoozes it.",
    promptGuidelines: "",
  },
  thread_fork: {
    description:
      "Fork this thread into a new held thread that starts with a full copy of its context and then diverges on its own; it inherits this thread's goal, model and worktree, and a human's first message launches it, so tell the user it is waiting. It never merges back: delegated sub-work is mcp__t3-code__workstream_spawn, a fresh-context next phase of this goal is mcp__t3-code__goal_continue.",
    promptSnippet:
      "fork this thread into a held copy of its full context that then diverges independently; a human's first send launches it.",
    promptGuidelines: "",
  },
  goal_task_list: {
    description:
      "Read this thread's goal task tree. The tree in your prompt is a snapshot from your spawn, so read this before a rewrite or when a child may have changed it. Anchored, you get your branch in full, the exact checklist a branch rewrite takes, under the read-only spine it hangs from; scope 'tree' is the whole goal, which an unanchored thread always gets.",
    promptSnippet:
      "read this thread's active goal's task tree: your own branch by default, scope \"tree\" for the whole goal; mutates nothing.",
    promptGuidelines: "",
  },
  goal_task_add: {
    description:
      "Append one task to this thread's goal tree, nested under the task or theme it belongs to; a targeted write that is safe while others hold the tree. It lands in your own branch by default, and any task of the goal is a legal parent, so work discovered elsewhere is recorded where it belongs. Several items at once, or a reshaped branch, is mcp__t3-code__goal_tasks_rewrite.",
    promptSnippet: "add one task to this thread's goal task tree (nested under a parent task).",
    promptGuidelines: "",
  },
  goal_task_update: {
    description:
      "Rename one task of this thread's goal, or mark it done or reopened; a targeted write that is safe while others hold the tree. Anchored, the task must be in your own branch: this is how you tick your own task the moment the work lands. Work needed outside your branch goes in your report; re-nesting, reordering and removing are mcp__t3-code__goal_tasks_rewrite.",
    promptSnippet:
      "update one task in this thread's goal: rename (text) or mark done/reopen (done).",
    promptGuidelines: "",
  },
  goal_tasks_rewrite: {
    description:
      "Replace what you own in this thread's goal task tree with a markdown checklist: restructure, re-nest, reorder, merge, rename, tick and prune in one call. The goal's owner submits the whole tree; an anchored thread submits exactly its branch, one top-level line carrying its anchor's id plus everything beneath it, and the rest of the goal is untouched; a child with no anchor is refused and instead appends with mcp__t3-code__goal_task_add and ticks with mcp__t3-code__goal_task_update. Rewrite from a fresh mcp__t3-code__goal_task_list read at that scope, since anything added since your last read and left out is lost.",
    promptSnippet:
      "replace the tree you own (the whole goal, or your own branch when you are anchored) with an edited markdown checklist (the mcp__t3-code__goal_task_list form); one call restructures, re-nests, renames, done-marks and prunes.",
    promptGuidelines: "",
  },
  goal_handoff: {
    description:
      "Hand off a separate, out-of-scope piece of work as its own new goal: a root session in its own worktree starts on your brief at once, and the brief is all it has of this thread. A likely duplicate (an open thread already doing the work) launches nothing and is named in the result; consult or notify that thread, or repeat the call with notDuplicateOf when your work is distinct. Work that belongs under this goal is mcp__t3-code__goal_task_add.",
    promptSnippet: "hand off discovered out-of-scope work as a new goal",
    promptGuidelines: "",
  },
  goal_continue: {
    description:
      "Continue this goal in a fresh context window: a held sibling root session on the same goal, worktree, branch and model, launched by the human's first send with your brief as its first turn (a pointer back to this thread is appended, so it can consult you). Use it when a substantial hunk of work is done and the next phase should start clean. Bring the goal up to date first, with mcp__t3-code__goal_update and the task tree, since the successor starts from them. A new goal in a new worktree is mcp__t3-code__goal_handoff.",
    promptSnippet:
      "stage a fresh-context continuation session on THIS goal + worktree, pre-loaded with a handoff brief; a human's first send launches it.",
    promptGuidelines: "",
  },
  goal_update: {
    description:
      "Update this thread's goal: its title, objective statement or slug, keeping the framing accurate as understanding evolves. Only the goal's owner, its root, may.",
    promptSnippet: "update this thread's goal metadata (title / description / slug).",
    promptGuidelines: "",
  },
  ask_user_question: {
    description:
      "Ask the person reading this thread a structured question; it is available because a human has written here. For an irreversible, destructive or preference-only decision the request, codebase and prior context do not settle; otherwise state an assumption and proceed, and do not ask to reconfirm scope or for approval you do not need. Coupled decisions and plan or design sign-offs go in an MDX decision document (the mdx-visual-recap skill), with the question a pointer to it. What your parent could answer goes to mcp__t3-code__consult_thread; guidance you cannot frame as options is mcp__t3-code__workstream_request_attention with needs_guidance.",
    promptSnippet:
      "a person has written to this thread, so you can put an irreversible, destructive or preference-only decision to them as a structured question; otherwise proceed.",
    promptGuidelines: "",
  },
  // Local process tools registered by Loom's pi extension (`backgroundJobs.ts`), not MCP tools:
  // bare names, like pi's own `bash`.
  bg_start: {
    description:
      "Run here, not in bash, a command that may take more than a couple of minutes (an eval, a build, a test suite, a long sleep): a foreground bash call holds your turn and cannot be steered, while a message sent to you during bg_wait reaches you at once. The job runs in the working directory with its output captured to a log; its exit reaches you in bg_wait, or as a new message that starts a turn if yours has ended. Make the command write progress as it runs, since bg_wait shows only what the job writes and a silent job cannot be told from a stuck one. The job dies with this session (Stop, a server restart, a long idle), and your next turn is told.",
    promptSnippet:
      "start a command that may run more than about two minutes in the background, with a wake when it exits",
    promptGuidelines: "",
  },
  bg_wait: {
    description:
      "Wait for a bg_start job: returns when it exits, with its exit code and the last lines of its log, or at timeout_s with its progress (run time against your bounds, log growth, latest lines). A message sent to you while it waits ends the wait early, with the same progress and the job untouched. A timeout is a progress report, not a failure: while the log advances, wait again; kill the pid only when the output shows the job stalled, failing or doing the wrong work. Aborting this call leaves the job running.",
    promptSnippet:
      "wait for a background job: returns at its exit, or with its progress at a timeout or when a message arrives",
    promptGuidelines: "",
  },
} as const satisfies Record<string, LoomToolProse>;

export type LoomProseToolName = keyof typeof LOOM_TOOL_PROSE;
