# Model-facing text for the human-in-child change

Companion to `plans/human-in-child-thread/plan.mdx`. Every text a model reads that this change
adds, replaces or removes, as the exact characters to ship. A coder applies each "New" block
verbatim and reviews it for schema fit only (does it name the parameters the schema has, with
the semantics the handler enforces). A wording change goes back to a planner, not into the diff.

Authored under `llm-instruction-change` and the two doctrines in
`docs/architecture/tool-def-authoring.md` and `docs/architecture/prompt-surface-authoring.md`.
Tool names are written as the model sees them (`mcp__t3-code__…`). No text below contains a
value from a real thread; the scenarios that motivated each line are named in the change record
at the end, where no model reads them.

`${…}` marks a value the code interpolates. Everything else is literal.

---

## 1. Tool descriptions (`apps/server/src/mcp/toolkits/workstream/prose.ts`, `LOOM_TOOL_PROSE`)

### 1.1 `workstream_submit.description`

Current:

> Your terminal call: hand back your markdown report with an outcome, and the control plane routes it; you never set your own outcome at completion. Omitted or 'done' completes you and releases your dependents; it is refused while an attention flag you raised stands (pass another token and you yield with the flag intact). 'needs_human' records the report and raises needs_guidance. A review-gate verdict ('clean', 'fixed_inline', 'needs_rework') routes the gate; in a rework round every outcome but 'needs_human' routes back to the reviewer; any other token yields you to your parent, and you are not done. A turn that ends without submitting is, after a grace, treated as gone quiet: the control plane synthesises a report from your last message and yields that instead.

New:

> Your terminal call: hand back your markdown report with an outcome, and the control plane routes it; you never set your own outcome at completion. Omitted or 'done' completes you and releases your dependents. 'awaiting_acceptance' hands back finished work that a human must accept before anything builds on it: you are held, not done, your dependents wait, and the hold ends when the human approves in this thread or your parent accepts you. 'needs_human' records the report and raises needs_guidance. A review-gate verdict ('clean', 'fixed_inline', 'needs_rework') routes the gate; in a rework round every outcome but 'needs_human' and 'awaiting_acceptance' routes back to the reviewer; any other token yields you to your parent, and you are not done. On a finished thread a human has since written to, the report is added to your earlier one and nothing is routed. A turn that ends without submitting is, after a grace, treated as gone quiet: the control plane synthesises a report from your last message and yields that instead.

Removed: "it is refused while an attention flag you raised stands (pass another token and you yield with the flag intact)". The refusal still exists and its own text says what stands; the sentence is what taught threads to invent a token for "finished, flag standing".

### 1.2 `workstream_submit.promptSnippet` (inert under Loom's preamble; kept truthful for the bridge)

New:

> submit your report + outcome in one terminal call: plain completion → done; 'awaiting_acceptance' → held for a human's acceptance; 'needs_human' → human flag; any other outcome → routed, with unmatched non-rework outcomes yielding to your orchestrator.

### 1.3 `workstream_request_attention.description`

Current:

> Raise an attention flag that holds this thread, or a child you spawned, for a human; make it your turn's last act, since completing clears it. 'awaiting_acceptance': a human (or your parent, holding the human's decision) must accept this thread's output before it can be done. 'needs_guidance': you cannot proceed without a human, including when what you need is answers. To hand back a report while the flag stands, submit with a short non-'done' outcome. A child consults its parent first (mcp__t3-code__consult_thread); usually no human reads a child thread. Write the report for someone who has read none of this thread.

New:

> Raise an attention flag that holds this thread, or a child you spawned, for a human. 'needs_guidance': you cannot proceed without a human, including when what you need is answers; make it your turn's last act, since completing clears it, and as a child consult your parent first (mcp__t3-code__consult_thread), since usually no human reads a child thread. 'awaiting_acceptance' is raised on a child only, to hold its output for a human's acceptance; your own finished work that needs acceptance is handed back with mcp__t3-code__workstream_submit outcome 'awaiting_acceptance', which records the report and holds you in one call.

Removed: "To hand back a report while the flag stands, submit with a short non-'done' outcome." (the second half of the two-call pattern) and "Write the report for someone who has read none of this thread." (this tool takes no report; the sentence had no referent).

### 1.4 `workstream_request_attention.promptSnippet` (inert)

New:

> raise a hold for a human: 'needs_guidance' (you're stuck, or you need answers; the raise ends your turn) or, on a child you spawned, 'awaiting_acceptance' (its output needs sign-off before it may be done).

### 1.5 `workstream_prompt.description`

Current sentence:

> Prompting a child that holds an attention flag clears the hold when its turn starts: do it only when you hold what the child is waiting for.

New sentences, in the same position:

> Prompting a child flagged needs_guidance clears that flag when its turn starts: do it only when you hold what the child is waiting for. A child held awaiting_acceptance stays held through your prompt and hands back held again.

The rest of the description is unchanged.

### 1.6 `workstream_prompt.promptSnippet` (inert)

Current ends "…and clears a hold the child raised (a steer won't penetrate a hung tool call: stop first, then prompt)." New ending:

> …and clears a needs_guidance flag the child raised (a steer won't penetrate a hung tool call: stop first, then prompt).

---

## 2. Parameter descriptions (`apps/server/src/mcp/toolkits/workstream/defs.ts`)

### 2.1 `workstream_submit` → `outcome`

Current:

> Omitted means 'done'; otherwise 'needs_human', a gate verdict, or a short snake_case token such as 'rework_approach'.

New:

> Omitted means 'done'; otherwise 'awaiting_acceptance', 'needs_human', a gate verdict, or a short snake_case token such as 'rework_approach'.

### 2.2 `workstream_spawn` → new optional boolean `humanLed`

Added to the spawn's own struct, beside `brief`. Not added to `childFields` or to scaffold nodes.

> true when the human asked for this thread so they can work in it themselves, turn by turn (walking through results, talking a design over): the child waits for the human between turns, is never reported to you as gone quiet, and finishes when the human says so. Leave it out for a child that works from its brief, including one whose deliverable the human will approve afterwards.

The last sentence guards the other tail: a planner whose brief the human approves is held by its hand-back, not by this field.

---

## 3. Prompt prose (`apps/server/src/loom/prompt/prose.ts`)

### 3.1 `CHILD_READERSHIP_CLAUSE`, last two sentences

Current:

> Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, or a contract another thread is building on), never for a question or a message that leaves your course unchanged. Once they have written, `mcp__t3-code__ask_user_question` is available to you.

New:

> Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, a contract another thread is building on, or something it relied on in a report you have already handed back), never for a question or a message that leaves your course unchanged. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

### 3.2 `workstreamChildPrompt`: closing lines for a child spawned with `humanLed`

The function gains `readonly humanLed?: boolean`. Without it the three closing lines are unchanged. With it they are replaced by these four, in this order, after `KICKOFF_CLOSING`:

> The human asked for this thread so they can work in it with you, and they write to you here. Answer them turn by turn and end your turn to wait for their next message: in this thread that wait is expected, however long it lasts, and the usual rule that a turn ending without a submit reads as gone quiet does not apply. Their word outranks this brief.

> Run anything you expect to take more than a couple of minutes with bg_start and wait on it with bg_wait: a foreground command holds the turn, and the human cannot reach you until it ends. A long command that must run in the foreground carries an inline `# eta: <n>m` comment so your parent is not sent slow-tool notices before then.

> Your parent hears nothing of the conversation. Tell it with `mcp__t3-code__notify_thread`, quoting the human, when they decide something it would act on, such as work for it to delegate; the rest goes in your report.

> Finish with ONE call, `mcp__t3-code__workstream_submit`, when the human says the work here is finished: its description is the contract for outcomes and routing. Write the report as a concise handoff for your parent orchestrator, opening with the response block its markdown description asks for: what the human decided, in their words, what was done about each decision, and anything the parent must act on.

Dropped for such a child, with reasons: "a running job blocks your submit, and a turn that ends without submitting reads as gone quiet" and "Ending a turn without submitting hands your parent a report the control plane reconstructs from your last message instead" (false for it); "If a HUMAN is needed, raise it … Do not sit silently halted" (waiting for the human is its normal state, and a raise would send the parent a pause notice every round).

### 3.3 New constant `SUBMIT_REFUSED_WHILE_HELD`

Returned when a completing submit would erase a standing `awaiting_acceptance` and no human-authored message started or was steered into the current turn. `SUBMIT_REFUSED_WHILE_RAISED` is unchanged and still answers a standing `needs_guidance`.

> Refused: this thread is held `awaiting_acceptance`, and completing now would release the work that waits on it before a human has accepted it. The hold ends when the human approves in this thread, or when your parent accepts you. If you have revised the work, hand it back held again: `mcp__t3-code__workstream_submit` with outcome `awaiting_acceptance`.

---

## 4. Tool results

### 4.1 `renderSubmitOutcome` (`apps/server/src/mcp/toolkits/workstream/render.ts`), decision `attention`

For outcome `needs_human`: unchanged.

For outcome `awaiting_acceptance`:

> Work submitted: report recorded and you are held `awaiting_acceptance`: not done, and nothing that waits on you starts. Your parent has been told once and points the human here. The human corrects and approves in this thread: after a correction, revise, reply to them and stay held; when they approve, complete with a plain submit whose report quotes what they changed. If your parent sends you back to fix something, hand back held again the same way.

### 4.2 Held hand-back repeated in a turn the human wrote in (no routing, no notice)

> Report updated. You are still held `awaiting_acceptance`, and your parent is not told of this round. When the human approves here, complete with a plain submit whose report quotes what they changed.

### 4.3 Addition to a finished thread's report

> Added to your report as a dated section. You stay finished, nothing is routed, and your parent is not told. If this changes something your parent relied on or would act on, tell it once with `mcp__t3-code__notify_thread`, quoting the human; a clarification or a tidied report needs no message.

Followed, as today, by `\nReport: ${reportPath}`.

### 4.4 Self-raise of `awaiting_acceptance` refused (`handlers/attention.ts`)

> A thread does not raise `awaiting_acceptance` on itself: no report would be recorded and your parent would not be told. Hand finished work back with `mcp__t3-code__workstream_submit` and outcome `awaiting_acceptance`; if you cannot proceed at all, the reason is `needs_guidance`.

### 4.5 Submit on a finished thread refused (`workSubmitRefusal`, `packages/shared/src/workstreamGraph.ts`)

Current, for both outcomes:

> Thread ${id} is ${outcome}; mcp__t3-code__workstream_submit cannot act on a terminal thread.

New, `done`:

> Thread ${id} is done: its hand-back is closed, so this report was not recorded and nothing was routed. If your parent has sent you more work, it reopens you before you hand back; say so to it with `mcp__t3-code__notify_thread` (loaded through `tool_search` when it is not declared). If a human writes to you here, a submit after that is added to your report.

New, `cancelled`:

> Thread ${id} is cancelled: your parent abandoned this work, so this report was not recorded and nothing was routed. If what you have would change that, tell your parent with `mcp__t3-code__notify_thread` (loaded through `tool_search` when it is not declared).

The gate-rework exception (a `done` target with `pendingRework` and decision `loop`) is unchanged and returns no refusal.

---

## 5. Control-plane notices

### 5.1 New: held hand-back notice to the parent (`wakes.ts`, new builder; sent by `attentionRail`)

```
${WORKSTREAM_CONTROL_PLANE_MARKER}

Your Workstream sub-thread ${role ?? "sub-thread"} `${id}` has finished its work and handed it back held `awaiting_acceptance`: a human must accept it before it is done, and its dependents stay gated until then. This is a hand-back, not a fault.

Report reference: `${reportPath}` (read the full report on demand).${formatReportExcerpt(report)}

Read what it handed back against your brief. If something is plainly wrong, send it back with `mcp__t3-code__workstream_prompt`: it stays held and hands back again. Otherwise tell the human it is waiting for them, with this link: [${title}](t3-thread://v1/${id}). They correct and approve it in that thread, not in yours: you hear nothing of their rounds, and the ordinary finished notice when they approve. Setting it done yourself (`mcp__t3-code__workstream_set_outcome`) gives the human's word for them, so do it only when they have already given it to you.
```

Payload: `kind: "notice"`, `notice: "attention"`, `heading: "A sub-thread finished and is held for the human's acceptance."`, one item titled `Finished: held for acceptance` with status `awaiting_acceptance`, carrying the report path and excerpt but no `documents` (see plan §1.5).

### 5.2 `buildChildWakeMessage`, the attention tail (`wakes.ts`)

Current:

> Do not treat its work as complete. If it is `awaiting_acceptance`, it stopped short of `done` on purpose because a human's word is owed on its output: accepting it yourself (`mcp__t3-code__workstream_set_outcome` done, which releases its dependents) IS giving that word, so do it only when you already hold the human's decision; otherwise leave the flag standing, put the decision to the human, and let the branch wait. If it is `needs_guidance` (e.g. a human stopped it, or it cannot proceed), a human is in the loop: plan around the pause rather than resuming it yourself. Its dependents stay gated until it reaches `done`.

New:

> Do not treat its work as complete. It is `needs_guidance` (a human stopped it, or it cannot proceed), so a human is in the loop: plan around the pause rather than resuming it yourself. Its dependents stay gated until it reaches `done`.

Removed: the `awaiting_acceptance` sentence. That reason now has its own notice (5.1) and never reaches this text.

### 5.3 The yield notice's clause for a child that also holds the approval flag (`yield.ts`, `held`)

Current:

>  It also holds an `awaiting_acceptance` flag: a human's sign-off on its output is still pending, and either prompting it or setting it done clears that hold; do so only once you hold the human's approval; otherwise escalate to the human.

New:

>  It also holds an `awaiting_acceptance` flag: a human's sign-off on its output is still pending. Prompting it leaves that hold standing; setting it done clears it, so do that only once you hold the human's approval, and otherwise escalate to the human.

---

## 6. Role files

### 6.1 `roles/planner.md`, last bullet

Current:

> - Your `mcp__t3-code__workstream_submit` response block gives the plan's location and its key decisions. When implementation must not start until a human has approved the plan, raise `awaiting_acceptance` via `mcp__t3-code__workstream_request_attention` **instead of completing** — the raise is what holds the plan, and completing in the same turn releases the coders the approval was meant to gate. Raise it only when work genuinely must wait: an intent brief waits for the human; a plan under an approved brief completes.

New:

> - Your `mcp__t3-code__workstream_submit` response block gives the plan's location and its key decisions. When implementation must not start until a human has approved your document, submit it with outcome `awaiting_acceptance` **instead of completing**: the hold is what keeps the coders behind it from starting, and the human corrects and approves the document here, in your thread. Hold only when work genuinely must wait: an intent brief waits for the human; a plan under an approved brief completes.

### 6.2 `roles/reviewer.md`

Current:

> - If your verdict itself needs a human to sign off, raise `awaiting_acceptance` via `mcp__t3-code__workstream_request_attention` instead of submitting it as final.

New:

> - If your verdict itself needs a human to sign off, submit it with outcome `awaiting_acceptance` instead of as final.

### 6.3 `roles/orchestrator.md`, the `awaiting_acceptance` bullet

Current (one bullet):

> - **A child's `awaiting_acceptance` is a human hold.** Clear it only when you hold the human's approval for that decision, not to unblock dependents; if the wait is unaffordable, re-scope the approval rather than accept on their behalf. Put decisions to the human, never mistakes: fix plainly wrong behaviour (regressions, lost defaults) via a coder, unasked; theirs are product trade-offs, irreversible deletion of data or artefacts, and overriding a design document.

New (two bullets, in the same position):

> - **A child held `awaiting_acceptance` waits for the human, who answers it in that child.** Read what it handed back against your brief and send it back yourself if something is plainly wrong; then tell the human which child is waiting, with its thread link, and leave the corrections and the approval to them there. You hear nothing of their rounds, and the ordinary finished notice when they approve. Do not ask for the approval in your own thread or carry their words to the child as a matter of course; if they give you a correction or an approval here anyway, their word stands wherever they write it: pass the correction on once, or accept the child. Never accept a held child to unblock its dependents; if the wait is unaffordable, re-scope the approval rather than accept on their behalf.
> - Put decisions to the human, never mistakes: fix plainly wrong behaviour (regressions, lost defaults) via a coder, unasked; theirs are product trade-offs, irreversible deletion of data or artefacts, and overriding a design document.

The second bullet is the old bullet's second rule, unchanged, given its own line (the doctrine's "multi-rule mega-bullet" smell). No overlay line is added for `humanLed`: the spawn parameter carries its own trigger at composition time, and an eval case measures whether that is enough.

`roles/coder.md` and `roles/researcher.md` are unchanged.

---

## 7. Instruction change record (pre-registered; the run fields are filled by the coder who runs the eval)

- **Surfaces touched:** every heading above. Shared surfaces: `CHILD_READERSHIP_CLAUSE` (every child), `workstream_submit` and `workstream_request_attention` descriptions (every role, resident), `workstreamChildPrompt` (every child's kickoff).
- **Tier:** 3. New outcome word, new parameter, changed rules, and three shared surfaces.
- **Failure located:** live database, children created 7 Oct to 10 Nov 2026. 87 hand-backs with an outcome the control plane did not know; 44 of them were a child saying "finished, waiting for approval" in its own word (34 children), 22 with the formal hold raised as a second call. 9 finished children refused a submit in a turn a person started; 4 children failed a first `notify_thread` as "Tool not found". One planner's reasoning before its two calls: "the role's rule says an intent brief waits for the human, so I'd submit the report with a non-done outcome". One finished coder after its refusal: "I'm not notifying the parent, since the thread is finished".
- **Lever chosen and why:** schema shape first (a named outcome; a spawn parameter), then code (the hold outlives messages; the addition is accepted; the tool is loaded), then instruction text only where a model must choose (hold or complete; material or not; link or relay).
- **Hypothesis:** on `evals/loom-handback`, the cases marked `bad` in plan §5 fail on the base commit and pass after the commit that owns them; the `control` and `guard` cases pass on both.
- **Displacement risk:** (a) over-holding: a planner under an approved brief, or a coder with nothing to approve, submits `awaiting_acceptance` (control cases `planner-plan-under-approved-brief`, `coder-plain-completion`); (b) over-notifying: a child with `notify_thread` now loaded messages its parent on a question or a tidy-up (controls `working-child-question`, `finished-child-tidy`); (c) over-declaring: an orchestrator marks ordinary or approval-bound children `humanLed` (controls `orchestrator-ordinary-spawn`, `orchestrator-approval-is-not-human-led`); (d) an orchestrator refuses to pass on a correction the human gave it directly (guard `orchestrator-human-corrects-in-parent`).
- **Removed or superseded:** listed under each surface.
- **Leak scan:** the new text names no person, date, path, document or thread. The wording was fixed before any eval case was written, so every case is held out from it.
- **Noise floor (A/A), runs per arm, flips read, detectable effect, trace ids:** owed by the eval run; see plan §5 for the arms.
- **Prompt version / changelog entry:** the three commits of plan §7 are the nested variants; each commit message names the surfaces it changed.
