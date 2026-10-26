# Intent-first workflow: the exact text of each change

Implementation contract for `plan.mdx` in this folder. Every edit is text that models read: load `llm-instruction-change` and `skill-authoring` before editing, author on a top tier or `modelPreset: planner`, and ship each PR through a reviewer gate briefed with the file's purpose sentence, the +N/−M count below and the four rejection reasons (already covered; changes no decision; derivable from code or tool output; a rule where a fact would do). Australian English, no em-dashes in new prose.

## Sequencing

| PR | Files | Wait for |
|---|---|---|
| 1 | `skills/mdx-visual-plan/SKILL.md`, `skills/mdx-doc-core/references/exemplar.md`, `roles/orchestrator.md`, `roles/planner.md` | Nothing blocks it. `t3/plan-names-domain-modeling` (+4 lines to the plan skill, held for pi-craft #21) and `t3/scheduling-tools` (one frontmatter or comment line in each role file) are in flight: whichever lands second rebases, a trivial merge in each case |
| 2 | `skills/workstream-review-gate/SKILL.md` | The review-rethink low-value-tests batch (`recaps/low-value-tests/recap.mdx`), which adds +32 to this file. Re-judge the floor/ceiling sentence against that batch's line when drafting |
| 3 | Loom `AGENTS.md` "Plans and work artifacts" | After that batch (which Carl has not seen with this line in it), as its own edit with the complete-file review Carl requires for any `AGENTS.md` change |
| later | pi-craft `wayfinder/SKILL.md` | Tailor to Loom (no GitHub-issue map when the intent is to implement now; the brief's form is the destination). After pi-craft #21. Not part of this proposal |

What is borrowed from Miessler's LifeOS (`.artifacts/intent-first/lifeos-findings.md`), in Loom's words only: checkable do-and-see lines with a must-not in place of a one-sentence wish; "questions for you" (gate approval) split from "still unknown" (do not), with low-stakes forks as Assumed lines and "go" accepting the recommendations; approaches with "wins if …", a throwaway spike where cheap, and dead ends kept with their reason; who may move which line of the brief (agents sharpen, only the owner changes meaning); near-done as an iteration boundary with passed checks and must-nots as guard rails and a `done` status; a taste-only choice between approaches as one "try A and B" question, an instance of the "new decision that is his" trigger; the gate tracing every brief line to plan work and a named verifier, running checks itself from the brief's wording rather than from the coder's claim; "check wrong or code wrong?" as the re-engagement test. Not borrowed: its 17-section artefact and probe tables, numeric thresholds on experiential goals, the three-question check test and per-client evidence rule (loom `AGENTS.md` "Hit every surface" and the reviewer role already carry them), "no should-work" (the gate already closes on evidence), the pre-mortem, hooks and telemetry, autonomous mutation loops, and "no unknowns at close" as a hard gate ("approach B does not work" is a legitimate close, recorded under Decided). Never write ISA, ISC or fog in anything Carl reads.

Unchanged on purpose: `WORK_MODEL_ADDENDUM` and `gateClause` in `apps/server/src/loom/prompt/prose.ts`, the workstream tool descriptions, the global `~/.pi/agent/AGENTS.md`, pi-craft's `grill-me` and `wayfinder` (both keep `disable-model-invocation: true`; the plan skill points at wayfinder's path, as wayfinder itself does for grill-me), `.t3code/roles/*`.

The three re-engagement triggers, in Carl's words: "contradicts something I've said in the intent brief", "makes something in the decision that I've made in the intent no longer clear", "or is something that's important for me to make a new decision on". Every surface below states them as: contradicts or reopens (blurs) a decision the brief holds, or raises a new decision that is the human's (a product trade-off, deleting data or artefacts, overriding a design document), the orchestrator role's existing list. Do not widen the third to "a decision the brief lacks": plans make many decisions a brief does not cover, and sending those is the noise this workflow removes.

## 1. `roles/orchestrator.md` (+61/−10, file 1,068 → about 1,119)

New first bullet, before "When non-trivial work firms up":

> Feature work, its result judged in use rather than by a defect being gone, starts with an intent brief (`mdx-visual-plan`) the human corrects and approves, and nothing is built before that; the plan under it is gate-reviewed against the brief, and the human is re-engaged only on the brief's terms.

In the "Non-trivial human reviews, decisions and explanations go in reviewable MDX" bullet: "a plan to approve" becomes "an intent brief to approve"; "point them at a plan's QuestionForm" becomes "point them at the brief's QuestionForm".

Purpose sentence for the gate: the unconditional doctrine of a root orchestrator, true in every project. The new bullet is the authority boundary (nothing built before the brief is approved; the plan is not the human's gate) that trim principle 3 says cannot live only in a skill.

## 2. `roles/planner.md` (+94/−32, file 589 → about 651)

Bullet 3, replace "so the human can review and annotate them in-app before any code is written." with:

> Under an approved intent brief (`plans/<slug>/intent.mdx`) the plan's reader is a reviewer gate, not the human: the brief's decisions are settled, each of its open questions is answered or carried forward, and your own open questions take their recommended answer unless one contradicts or reopens the brief or is a new decision that is the human's (a product trade-off, deleting data or artefacts, overriding a design document), which goes to the human on its own.

Last bullet, replace "Raise it only when work genuinely must wait; a plan no human has to see first just completes." with:

> Raise it only when work genuinely must wait: an intent brief waits; a plan under an approved brief completes.

The identity line "Produce intent briefs and implementation plans" is already right and stays.

## 3. `skills/mdx-visual-plan/SKILL.md` (header +63/−58; body +785/−161; file 1,512 → about 2,140)

Description (the whole `description:` value):

> Author an intent brief or an implementation plan as a reviewable MDX document. Use when a request is a new feature or changes behaviour beyond a defect fix (the brief comes first), and whenever work needs a plan. For a recap of work already done or a decision batch use mdx-visual-recap; to explain, orient or diagnose without asking for a decision use mdx-visual-explainer.

Trigger-only, as the trim left it: the procedure lives in the body.

Body: replace the opening genre paragraph ("**Genre: the implementation plan** … use **`mdx-visual-explainer`**.") and the whole "## When to write one" section with:

> **Two genres, one lifecycle.** The **intent brief** is the human's approval gate for feature work: one screen on what the feature is for and how its owner will know it works, drafted by the agent from the request and corrected by the owner in-app. The **implementation plan** is the proposal for how, written under an approved brief and reviewed by an agent against it; the owner sees a plan only where it reopens the brief. For a change that already exists, or a batch of verdicts, use **`mdx-visual-recap`**; for a document whose job is understanding rather than approval, use **`mdx-visual-explainer`**.
>
> ## Which to write
>
> A defect fix, a typo, a one-line change: neither, just do it. A feature or a change in behaviour, anything whose result the owner will judge in use rather than by a defect being gone: an intent brief first, however small; a small feature then goes straight to a coder whose reviewer judges against the brief. Medium or larger work (multi-file or ambiguous, a data-model, API or schema decision, a refactor with real risk): a plan as well, once the brief is approved.
>
> ## The intent brief
>
> `plans/<slug>/intent.mdx`, beside the plan it governs, committed with the work and signed `role: intent`. Its owner reads it in about a minute, so it states outcomes rather than mechanisms and fits one screen; when it runs long, cut prose before cutting questions. Its parts:
>
> - **Goal.** What the owner is trying to achieve or find out, opening with their literal ask quoted: the semantic goal, which may be a question ("can X make Y effortless?") rather than a deliverable.
> - **You'll know it works when.** A few lines of what the owner does and sees in the running software, each checkable by an agent at review and by the owner at near-done, and what it **must not** do or cost (what has to keep working; a cost the approach may not incur). No tool probes here; the plan derives them.
> - **Approaches in play.** The owner's idea as one candidate, plus the alternatives worth trying, each with "wins if …"; agents move among these without asking, a throwaway spike decides where that is cheap, and a dropped approach stays listed with its reason so no later round retries it.
> - **Decided.** The owner's words, quoted: the lines a plan may not cross. A low-stakes fork is an **Assumed** line here ("picking X over Y because R; redirect if wrong"), not a question.
> - **Not doing.** Scope only; hard lines.
> - **Questions for you.** A `<QuestionForm>` of a few questions at most, each with why it matters and a `recommended` answer, answerable with yes, no or a correction. These gate approval; a bare "go" accepts every recommended answer.
> - **Still unknown.** A question nobody can answer yet, stated precisely, with what settles it. These do not gate approval; by near-done each is a check, a decision or a dropped approach.
>
> Depth follows how well-defined the request is. Draft first, from the request and what the codebase settles, and ask inside the form. Interview beforehand, one question at a time with a recommended answer, when Goal or the checks cannot be drafted without guessing. For a bigger-picture or comprehensive effort, one that spans sessions or whose decisions depend on each other, `read` the wayfinder skill at `~/pi-craft/plugins/pi-craft/skills/mattpocock/wayfinder/SKILL.md` (it is `disable-model-invocation`, so it is not in your catalogue) and let its map drive the questions; the brief is its destination.
>
> The brief is rewritten in place as the work teaches, never appended to as a log; git is its history, and `status` moves `draft` → `approved` → `done`, or `dropped`. Agents may settle an unknown into a check or a dropped approach, record a chosen or dropped approach with its reason, tighten a check's wording without changing what passes it, and add or revise Assumed lines. Only the owner may change the Goal, their quoted words, what a check means, a must-not or a Decided line that is not Assumed; needing one of those changed, or finding one no longer clear, goes to the owner as one question, as does a new decision that is theirs (a product trade-off, deleting data or artefacts, overriding a design document), such as a choice between approaches that differ only on something the owner alone can judge ("try A and B", with cheap spikes to try). Wrong code never reaches the owner. At near-done the owner tries their checks and reacts; the reaction becomes changed or new checks in the same brief, beside the passed checks and must-not lines every later round is still held to, and the build goes again until the owner says it works and `status` is `done`.

Everything after ("## Where it goes" onward) stays; "Where it goes" now reads as the plan's location, which is still true. Keep the header trigger-only (no body content in the description).

## 4. `skills/mdx-doc-core/references/exemplar.md` (about +200)

Add an intent-brief skeleton beside the plan skeletons: frontmatter (`kicker: "Intent brief · draft for your corrections · <date>"`, `status: draft`), a title that states the goal, the seven bold-run-in parts above as short paragraphs (the checks as do-and-see sentences with a must-not; approaches with "wins if …" and a dropped one shown with its reason; an Assumed line under Decided), a `<QuestionForm>` for the questions for the owner with `recommended: true` on one option and a `subtitle` saying why it matters, and a "Still unknown" list in the form "the question, precisely; what settles it". The worked example in `plan.mdx` §2 (the change-review brief at about 230 words) is the model.

## 5. `skills/workstream-review-gate/SKILL.md` (+193, file 851 → about 1,076 after the pending +32)

New section after the escalation ladder:

> ## Reviewing a plan or build under an intent brief
>
> An approved intent brief sits beside the plan (`plans/<slug>/intent.mdx`) and is the human's only approval of this work. Trace each of its Goal, You'll-know-it-works, Must-not and Decided lines to plan work and to a named verification: where it is exercised (the live app for anything the human sees, not unit internals) and by whom (an agent's tool, an agent's judgement, or the human at near-done). A line the plan or change drops, narrows or softens without saying so is must-fix, and each of the brief's open questions is answered or carried forward. For a build, run each check yourself from the brief's wording and return the evidence. Mark the human's checks as theirs to try, and say in a few lines how the brief moved since approval. The brief is the floor of the review, not its ceiling. A finding that contradicts or blurs a decision the brief holds, or raises a new decision that is the human's (a product trade-off, deleting data or artefacts, overriding a design document), goes to the human as that one question (`needs_human`), not into a rework round.

"the project's coding principles still apply" was dropped as already covered by the reviewer role; the trigger list repeats the orchestrator role's on purpose, so every surface names the same three triggers.

## 6. Loom `AGENTS.md`, "Plans and work artifacts", first bullet (+30/−29)

Replace "Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling." with:

> Intent briefs and plans live in `plans/<slug>/` and are committed with the work, so a later build can consult their authors; research notes and agent scratch stay outside the worktree.

## Measurement

The November prompt census (`scripts/prompt-telemetry/` on unmerged `t3/prompt-telemetry`) counts: committed `plans/*/plan.mdx` without a sibling `intent.mdx`; planner threads that raised `awaiting_acceptance` under an approved brief; human asks per feature workstream (target: one at the brief, one near done). Held in reserve if reviewers miss the brief: name `plans/<slug>/intent.mdx` in `gateClause` (one line of code).
