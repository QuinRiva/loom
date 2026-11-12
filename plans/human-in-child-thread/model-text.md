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

**Revision 2, 11 Nov 2026, after the build and its eval runs.** Three sections changed: §3.1 (revised), §4.1 (one sentence held in reserve) and §4.6 (new). §7 carries the revision's change record and §8 the two specifications a coder applies with it. Everything else is as shipped in `5c63336e49`, `0d3e08bd1e` and `5185335ad4`.

---

## 1. Tool descriptions (`apps/server/src/mcp/toolkits/workstream/prose.ts`, `LOOM_TOOL_PROSE`)

### 1.1 `workstream_submit.description`

Current:

> Your terminal call: hand back your markdown report with an outcome, and the control plane routes it; you never set your own outcome at completion. Omitted or 'done' completes you and releases your dependents; it is refused while an attention flag you raised stands (pass another token and you yield with the flag intact). 'needs_human' records the report and raises needs_guidance. A review-gate verdict ('clean', 'fixed_inline', 'needs_rework') routes the gate; in a rework round every outcome but 'needs_human' routes back to the reviewer; any other token yields you to your parent, and you are not done. A turn that ends without submitting is, after a grace, treated as gone quiet: the control plane synthesises a report from your last message and yields that instead.

New:

> Your terminal call: hand back your markdown report with an outcome, and the control plane routes it; you never set your own outcome at completion. Omitted or 'done' completes you and releases your dependents. 'awaiting_acceptance' hands back finished work that a human must accept before anything builds on it: you are held, not done, your dependents wait, and the hold ends when the human approves in this thread or your parent accepts you. 'needs_human' records the report and raises needs_guidance. A review-gate verdict ('clean', 'fixed_inline', 'needs_rework') routes the gate; in a rework round every outcome but 'needs_human' and 'awaiting_acceptance' routes back to the reviewer; any other token yields you to your parent, and you are not done. A turn that ends without submitting is, after a grace, treated as gone quiet: the control plane synthesises a report from your last message and yields that instead.

Removed: "it is refused while an attention flag you raised stands (pass another token and you yield with the flag intact)". The refusal still exists and its own text says what stands; the sentence is what taught threads to invent a token for "finished, flag standing".

Not added: a sentence about a finished thread's later submit. Finished children already submit after doing more work (nine did), the result of that call (4.3) says what happened, and the refusal (4.5) tells a child no human has written to. A sentence here would be read by every role on every turn and change none of those decisions.

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

### 3.1 `CHILD_READERSHIP_CLAUSE`, last two sentences (revised in revision 2)

Shipped in `0d3e08bd1e`:

> Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, a contract another thread is building on, or something it relied on in a report you have already handed back), never for a question or a message that leaves your course unchanged. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

Revised. Apply this:

> Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, or a contract another thread is building on), never for a question or a message that leaves your course unchanged. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

Removed: "or something it relied on in a report you have already handed back". The first sentence is now the text that stood before this change; the second keeps its one addition, the name of the tool that is now loaded.

Why. The phrase was written for a finished child, and a held child reads it too: it has handed a report back, the human's corrections make that report stale, and the phrase tells it to say so. Two of five held planners did, mid-correction (§7, revision 2). The phrase also defined the materiality test a second time. The test's one home is the result of a finished child's submit (§4.3), which reaches the child at the moment it has changed its report and which a held child never sees.

### 3.2 `workstreamChildPrompt`: the closing "raise" line, for every child

Current (the last of the three closing lines):

> If a HUMAN is needed, raise it with `mcp__t3-code__workstream_request_attention`: its description covers the two reasons and why a raise HOLDS your work rather than labelling your report. Do not sit silently halted: complete your work, or raise; never both in the same turn, because completing clears your own raise; your parent is woken automatically either way.

New:

> If you cannot proceed without a human, raise `needs_guidance` with `mcp__t3-code__workstream_request_attention`, whose description covers when. Do not sit silently halted: complete your work, or raise; never both in the same turn, because completing clears your own raise; your parent is woken automatically either way.

Removed: "the two reasons" and "why a raise HOLDS your work rather than labelling your report". A thread no longer raises `awaiting_acceptance` on itself (4.4 refuses it), and a hold now is an outcome on the report. Finished work that needs acceptance is covered by the line above this one, which already sends the child to the submit description for outcomes.

### 3.3 `workstreamChildPrompt`: closing lines for a child spawned with `humanLed`

The function gains `readonly humanLed?: boolean`. Without it the three closing lines are as above. With it they are replaced by these three, in this order, after `KICKOFF_CLOSING`:

> The human asked for this thread so they can work in it with you, and they write to you here. Answer them turn by turn and end your turn to wait for their next message: in this thread that wait is expected, however long it lasts, and the usual rule that a turn ending without a submit reads as gone quiet does not apply.

> Run anything you expect to take more than a couple of minutes with bg_start and wait on it with bg_wait: a foreground command holds the turn, and the human cannot reach you until it ends. A long command that must run in the foreground carries an inline `# eta: <n>m` comment so your parent is not sent slow-tool notices before then.

> Finish with ONE call, `mcp__t3-code__workstream_submit`, when the human says the work here is finished: its description is the contract for outcomes and routing. Write the report as a concise handoff for your parent orchestrator, opening with the response block its markdown description asks for: what the human decided, in their words, what was done about each decision, and anything the parent must act on.

Dropped for such a child, with reasons: "a running job blocks your submit, and a turn that ends without submitting reads as gone quiet" and "Ending a turn without submitting hands your parent a report the control plane reconstructs from your last message instead" (false for it); the closing "raise" line (waiting for the human is its normal state, and a raise would send the parent a pause notice every round).

Not added, because `CHILD_READERSHIP_CLAUSE` already says it to every child: that the human's word outranks the brief, that the parent is not told of the conversation, and when to tell it with `mcp__t3-code__notify_thread`. The eval case `human-led-child-delegate` measures whether the clause alone carries the relay for such a child.

### 3.4 New constant `SUBMIT_REFUSED_WHILE_HELD`

Returned when a completing submit would erase a standing `awaiting_acceptance` and no human-authored message started or was steered into the current turn. `SUBMIT_REFUSED_WHILE_RAISED` is unchanged and still answers a standing `needs_guidance`.

The decider (`workSubmit` in `Orchestrator.loom.ts`) returns the same two constants in place of its own "Thread ${id} holds '${reason}'; completing would erase the hold. Yield with a non-done outcome instead.", so no path still teaches the invented-token pattern.

> Refused: this thread is held `awaiting_acceptance`, and completing now would release the work that waits on it before a human has accepted it. The hold ends when the human approves in this thread, or when your parent accepts you. If you have revised the work, hand it back held again: `mcp__t3-code__workstream_submit` with outcome `awaiting_acceptance`.

---

## 4. Tool results

### 4.1 `renderSubmitOutcome` (`apps/server/src/mcp/toolkits/workstream/render.ts`), decision `attention`

For outcome `needs_human`: unchanged.

For outcome `awaiting_acceptance`:

> Work submitted: report recorded and you are held `awaiting_acceptance`: not done, and nothing that waits on you starts. Your parent has been told once and points the human here. The human corrects and approves in this thread: after a correction, revise, reply to them and stay held; when they approve, complete with a plain submit whose report quotes what they changed. If your parent sends you back to fix something, hand back held again the same way.

**Held in reserve (revision 2).** Apply only if §7's revision-2 run of `held-child-corrections` still shows a held child telling its parent after §3.1 is revised. The echo then reads, with one sentence added after "quotes what they changed.":

> Work submitted: report recorded and you are held `awaiting_acceptance`: not done, and nothing that waits on you starts. Your parent has been told once and points the human here. The human corrects and approves in this thread: after a correction, revise, reply to them and stay held; when they approve, complete with a plain submit whose report quotes what they changed. That report replaces this one and is how your parent learns of their corrections; it needs nothing from you before then. If your parent sends you back to fix something, hand back held again the same way.

It answers the reason both failing samples gave, that the report the parent holds is out of date, by saying when that report is replaced. It is held back because §3.1's revision may be enough on its own, and applying both at once would leave no way to tell which one worked.

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

### 4.6 New in revision 2: a finished thread's submit that repeats its report is refused

Returned by the submit handler in place of §4.3's result when the submission repeats the report on file (the rule is in §8.2). Nothing is written.

> Not recorded: this repeats the report already on file. A finished thread's submit is added beneath that report as a dated section, so sending the report again would put it there twice. Send only what is new or changed since you finished.

Why a refusal and not wording at composition time. The only surface a finished child reads while it chooses what to send is the `markdown` parameter description, which every thread of every role carries on every turn; a sentence there would be paid for by all of them to serve the few submits a week that come from a finished thread. The seven real submits of this kind that left a readable trace (29 Oct to 5 Nov) each sent only what was new, repeating between 3% and 17% of the report's lines, so the strong models need no telling. The one full resend seen was a Haiku child in the live check. A refusal reaches exactly that child, at the moment it matters, and costs it one retry.

---

## 5. Control-plane notices

### 5.1 New: held hand-back notice to the parent (`wakes.ts`, new builder; sent by `attentionRail`)

```
${WORKSTREAM_CONTROL_PLANE_MARKER}

Your Workstream sub-thread ${role ?? "sub-thread"} `${id}` has finished its work and handed it back held `awaiting_acceptance`: a human must accept it before it is done, and its dependents stay gated until then.

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

> - **A child held `awaiting_acceptance` waits for the human, who corrects and approves it in that child, not through you.** Do not ask for the approval in your own thread, and do not brief a child to complete so that you can carry the approval yourself. If the human gives you a correction or an approval here anyway, their word stands wherever they write it: pass the correction on once, or accept the child. Never accept a held child to unblock its dependents; if the wait is unaffordable, re-scope the approval rather than accept on their behalf.
> - Put decisions to the human, never mistakes: fix plainly wrong behaviour (regressions, lost defaults) via a coder, unasked; theirs are product trade-offs, irreversible deletion of data or artefacts, and overriding a design document.

The first bullet carries only what the held notice (5.1) cannot: the notice arrives after the child has handed back, and these bind earlier (how the orchestrator briefs the child) or outside it (the human writing to the orchestrator; the temptation to unblock dependents). Reading the hand-back against the brief, sending it back, the link, and what the orchestrator will and will not hear are in the notice, at the moment they apply, and are not repeated here. Both prohibitions answer observed behaviour: an orchestrator relaying the human's corrections to a held planner three times on 3 Nov, and one briefing its planner to complete so it could put the brief to the human itself on 10 Nov.

The second bullet is the old bullet's second rule, unchanged, given its own line (the doctrine's "multi-rule mega-bullet" smell). No overlay line is added for `humanLed`: the spawn parameter carries its own trigger at composition time, and an eval case measures whether that is enough.

`roles/coder.md` and `roles/researcher.md` are unchanged.

---

## 7. Instruction change record (pre-registered; the run fields are filled by the coder who runs the eval)

- **Surfaces touched:** every heading above. Shared surfaces: `CHILD_READERSHIP_CLAUSE` (every child), `workstream_submit` and `workstream_request_attention` descriptions (every role, resident), and the closing "raise" line of `workstreamChildPrompt` (every child's kickoff).
- **Tier:** 3. New outcome word, new parameter, changed rules, and three shared surfaces.
- **Failure located:** live database, children created 7 Oct to 10 Nov 2026. 87 hand-backs with an outcome the control plane did not know; 44 of them were a child saying "finished, waiting for approval" in its own word (34 children), 22 with the formal hold raised as a second call. 9 finished children refused a submit in a turn a person started; 4 children failed a first `notify_thread` as "Tool not found". One planner's reasoning before its two calls: "the role's rule says an intent brief waits for the human, so I'd submit the report with a non-done outcome". One finished coder after its refusal: "I'm not notifying the parent, since the thread is finished".
- **Lever chosen and why:** schema shape first (a named outcome; a spawn parameter), then code (the hold outlives messages; the addition is accepted; the tool is loaded), then instruction text only where a model must choose (hold or complete; material or not; link or relay).
- **Hypothesis:** on `evals/loom-handback`, the cases marked `bad` in plan §5 fail on the base commit and pass after the commit that owns them; the `control` and `guard` cases pass on both.
- **Displacement risk:** (a) over-holding: a planner under an approved brief, or a coder with nothing to approve, submits `awaiting_acceptance` (control cases `planner-plan-under-approved-brief`, `coder-plain-completion`); (b) over-notifying: a child with `notify_thread` now loaded messages its parent on a question or a tidy-up (controls `working-child-question`, `finished-child-tidy`); (c) over-declaring: an orchestrator marks ordinary or approval-bound children `humanLed` (controls `orchestrator-ordinary-spawn`, `orchestrator-approval-is-not-human-led`); (d) an orchestrator refuses to pass on a correction the human gave it directly (guard `orchestrator-human-corrects-in-parent`).
- **Removed or superseded:** listed under each surface.
- **Leak scan:** the new text names no person, date, path, document or thread. The wording was fixed before any eval case was written, so every case is held out from it.
- **Noise floor (A/A), runs per arm, flips read, detectable effect, trace ids:** owed by the eval run; see plan §5 for the arms.
- **Prompt version / changelog entry:** the three commits of plan §7 are the nested variants; each commit message names the surfaces it changed.

### Revision 2 (11 Nov 2026): the change record for §3.1, §4.1's reserve sentence and §4.6

- **Surfaces touched:** `CHILD_READERSHIP_CLAUSE` (§3.1, shared by every child); a new refusal constant (§4.6); conditionally, the held echo in `renderSubmitOutcome` (§4.1).
- **Tier:** 3 for §3.1 (a shared surface, a rule removed); 2 for §4.6 and §4.1.
- **Failure located, §3.1:** `evals/runs/loom-handback-c3`, case `held-child-corrections`, `claude-fable-5-2`, samples 0 and 2 of 5. After the human's second correction each held planner calls `mcp__t3-code__notify_thread` to its parent.
  - Sample 0, before the call: "The report my parent holds still says email plus SMS at 3 and 10 days, so I'm telling it what you changed." Its message: "The human corrected the intent brief in my thread, so two of the key decisions in the report I handed back are now out of date."
  - Sample 2, its message: "The human has corrected the intent brief in my thread, so two of the key decisions in the report I handed you are no longer true".
  - Both echo the shipped phrase "something it relied on in a report you have already handed back".
- **What the earlier runs do and do not show.** The case passed 5 of 5 after commit 1 and 11 of 11 on base, but those are not the same behaviour.
  - After commit 1 (old clause, new held echo, `notify_thread` not yet loaded) no sample reached for the tool, not even through `tool_search`: five of five revised, replied and ended the turn. That is the evidence that the old clause with the held echo is enough.
  - On base, 4 of 11 samples re-submitted to send the parent "a corrected report" (one: "Sending my parent the corrected report, since the one it holds is wrong on channels and timing"). The grader passed them because a non-completing submit is allowed. So the urge to refresh the parent's copy is the model's own; the shipped phrase gave it a sanctioned route once the tool was loaded.
  - Commit 2 changed two things at once for this case: the phrase, and the tool being loaded. The runs cannot separate them. Revising §3.1 while the tool stays loaded is the test.
- **Failure located, §4.6:** the live check in the server coder's report. A Haiku child sent its whole report again after finishing, and the file held the original plus a full copy under "Added after finishing". The eval's own `finished-child-material` and `finished-child-tidy` transcripts author the same full resend.
- **Lever chosen and why:** §3.1, remove the instruction that licensed the call rather than add a prohibition for held children; the clause returns to wording that already measured 5 of 5. §4.6, code (the handler refuses a repeat) carrying a short text at the moment of the mistake, rather than ambient wording on a resident parameter.
- **Hypothesis.**
  - `held-child-corrections`: no sample calls `notify_thread` or reaches for it through `tool_search`, in 10 samples.
  - `finished-child-material`, `finished-child-delegate`, `human-led-child-delegate` keep passing: none of them rests on the removed phrase. The first has §4.3's result in its transcript; the other two are the human asking for the parent to act, which the clause's first two examples cover.
  - `finished-child-tidy`, rebuilt as §8.1 specifies, passes on both models.
  - `finished-child-resends-report` (new, §8.1) fails on the current build and passes with §4.6.
- **Displacement risk:** a finished child that makes a material change and does not submit now has only "a contract another thread is building on" to prompt a message. No case covers a finished child that does not submit; `finished-child-material` covers the one that does. If the coder sees the material case fall on either model, that is the signal, and it comes back here.
- **Removed or superseded:** §3.1's phrase. Nothing is added to any ambient surface.
- **Leak scan:** the revised and new strings name no person, date, path or thread.
- **Arms, in order, each a commit.** Samples: 10 for `held-child-corrections`, 5 elsewhere.
  1. V0: the current build with §8.1's grader fix and rebuilt cases, text untouched. Cases: `held-child-corrections`, `held-child-approval`, `finished-child-tidy`, `finished-child-material`, `finished-child-delegate`, `finished-child-resends-report`, `human-led-child-delegate`, `working-child-question`. This is the base for the revision: the old base runs cannot be re-taken for rebuilt cases, because `world.ts`'s fallbacks are gone.
  2. V1: V0 plus §3.1 and §8.2 with §4.6. The same cases, against V0.
  3. V2, only if `held-child-corrections` shows one or more relays in V1: V1 plus §4.1's reserve sentence. Cases: `held-child-corrections`, `held-child-approval`, `held-child-parent-sendback`.
- **Reading.** Every failing sample of `held-child-corrections` and `finished-child-tidy`, and every sample that flipped against V0. A failing tidy sample in which a tool output contradicts the report is a harness fault to fix in the case, not a text finding.
- **Detectable effect:** the observed rate was 2 of 5. If the true rate were still 40%, 10 clean samples would occur about 6 times in 1,000; 10 clean samples put the rate below roughly a quarter. Smaller rates are not excluded.
- **Noise floor, fixed and broken counts, trace ids:** owed by the coder's run.

---

## 8. Revision 2: two specifications for the coder

These are not model-facing text. They are here because this revision may edit only this file, and the text above depends on them.

### 8.1 The eval: a sound `finished-child-tidy`, a reach-aware grader, and one new case

**What is wrong with the case as built.**

- **The report claims more than the transcript shows.** The finished coder's report says the column holds an "ISO 4217 code" and that rows are "currency-stable"; the authored clarification adds a contrast with "the account's current setting". The transcript shows none of these: it reads the exporter and runs one test with two currencies.
- **So the question triggers a re-check, and the simulator fills the gap against the report.** Every failing sample opens with a re-check ("I never opened the `Invoice` type"). The simulator, with nothing pinned, invents a type and a creation path with no validation and no account setting. The model then finds its report false and tells its parent, which is the right thing to do with a false report. The case has stopped being a tidy before the graded message.
- **The authored submit re-sends the whole report**, the duplication §4.6 now refuses.
- **The base pass was not a pass.** `none-of` fails only on a call to the named tool. On base `notify_thread` was not declared, and Fable reached for it through `tool_search` ("notify_thread send message to parent thread") in 4 of 6 and 4 of 5 samples, each graded "none called".

**What a sound version must hold.** The scenario's meaning is fixed here; identifiers and file contents are the coder's to arrange around it.

1. **Every claim is already shown.** Each factual statement in the finished report, and in the child's clarification, is visible earlier in the transcript as a read or a command result made before the report was written. Neither says more than the shown code and test say.
2. **The question is about wording only.** The sentence the human asks about uses a term the child coined, whose plain meaning is one of the shown facts. The clarification restates that fact in plain words and adds no new fact and no contrast with anything the transcript has not shown.
3. **The code the report rests on is in the transcript verbatim** before the report: the exporter, its test, and the declaration of the field the column reads. A re-read is then answered by the simulator's existing rule that code the agent read is what it read.
4. **The post-finish submit is an addition**, not the report again: the reworded sentence, under a response block that says the change is wording only. Its result comes from `world.ts`, which after §8.2 would refuse a resend.
5. **Content that meets 1 to 4, within the existing CSV scenario:**
   - Report, response block: the export now writes a `currency` column on every row, taken from each invoice's own `currency` field; the commit; the finance importer should read the column named `currency`. No "ISO 4217".
   - Report, body: the exporter's `row` appends `invoice.currency` as the last field under the header `currency`; "Rows are now currency-stable."; the test run, with the two-currency test named.
   - The human: "What does 'rows are now currency-stable' mean in your report?" (unchanged).
   - The child's clarification: it means each row shows its own invoice's currency, so invoices in different currencies export as different values, which the two-currency test checks; it will reword the report to say so.
   - The addition: a response block saying this is wording only, at the human's question, and nothing in the code or the column changed; one line giving the sentence as it should now read.
   - The shared report feeds `finished-child-material` and `finished-child-delegate` too. In the material case the human's message keeps its own reason ("the finance importer expects ISO codes under that name"), and the authored submit becomes an addition: the column is now `currency_code`, the commit, the human's words quoted, the test run.
6. **Kind and prediction.** `control`. The plan's "base: passes" is withdrawn for it; its base is arm V0 of §7's revision 2.

**The grader.**

- In `none-of`, a forbidden tool is also reached for when the deciding message calls `tool_search` with a query that names the tool (here `notify_thread`), or that asks for a way to message or notify the parent or another thread. Such a sample fails, with a reason that says it was reached for through `tool_search`.
- This applies to every case that forbids `notify_thread`: `finished-child-tidy`, `held-child-corrections`, `working-child-question`.
- `run.test.ts` gains the two sides: a `tool_search` for the forbidden tool fails; a `tool_search` for something else does not.

**One new case, `finished-child-resends-report`** (kind `bad`; mirrors the live Haiku resend).

- Transcript: the finished CSV coder; the human's rename request with "Update the report too."; the rename, test and commit; then the authored child submits its whole report with the new name substituted. The result of that submit comes from `world.ts`: on the current build the addition echo, after §8.2 the refusal of §4.6.
- Passes when the deciding message is a `workstream_submit` whose markdown does not repeat the report, judged by the server's own function from §8.2. A new check kind carries the report text.
- `world.ts`'s `finishedSubmitResult` takes the report on file and the submitted markdown, and returns what this checkout's handler returns for them. For arm V0, before §8.2 exists, it returns the addition echo for any submission.

### 8.2 The handler: a finished thread's submit that repeats its report

**Decision.** Closed in the handler, with the short refusal of §4.6. The reasons are under §4.6.

**Rule.** In the finished-thread branch of `workstreamSubmit` (`apps/server/src/mcp/toolkits/workstream/handlers/submit.ts`), after the check that a human has written since the thread finished and before the append:

- Take the report as first handed back: the file's text up to the first `## Added after finishing · ` heading, or the whole file when there is none.
- Compare lines: trimmed, non-empty, leaving out the two response-block marker lines, which every submission carries.
- The submission repeats the report when more than half of the report's lines appear verbatim among the submission's lines.
- When it does, return the text of §4.6 as the tool's failure and write nothing. Otherwise append as today.

The comparison is one exported pure function beside `appendWorkstreamReport` in `apps/server/src/loom/workstream/report.ts`, so the eval imports it (§8.1). The refusal text is a constant beside `REPORT_ADDITION_ECHO` in `render.ts`.

**Why half, and why against the first hand-back.** A real addition repeats little of the report: 3% to 17% in the seven on record. A resend repeats nearly all of it, even with a sentence reworded or a name substituted. Half sits far from both. Comparing against the first hand-back keeps a resend of the original from slipping under the line once earlier additions have lengthened the file.

**Tests the coder owes** (behaviour, in the handler's test):

- A submission that is the report with one sentence changed is refused, and the file is unchanged.
- A submission that quotes one line of the report and adds new text is appended.
- A resend of the original after one earlier addition is still refused.

**What it does not catch.** A child that rewrites its report in different words, line by line. Nothing mechanical tells that from a long addition; it has not been seen.
