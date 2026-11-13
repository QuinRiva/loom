# Model-facing text for the single hand-over after a document review

Companion to `plans/document-comments-to-author/plan.mdx` (§4). It holds every text a model reads that this change adds or replaces, as the exact characters to ship, with the eval that decides whether each ships. A coder applies each "New" block verbatim and reviews it for fit only (does it name the tools that exist, with the behaviour the handlers have). A wording change goes back to a planner, not into the diff.

Authored under `llm-instruction-change` and the two doctrines in `docs/architecture/tool-def-authoring.md` and `docs/architecture/prompt-surface-authoring.md`. Tool names are written as the model sees them. No text below contains a value from a real thread; the real rows that motivated it are in the change record (§6), where no model reads them.

**What the brief asks of a model.** A child that has already finished (`done`) and whose document the human then reviews in its thread:

1. sends its parent nothing while the review is open, whether the human asks questions or asks for changes;
2. does not decide for the human that the review is over;
3. once something has changed, says in each reply that its parent has not been told, so an open review is visible in the conversation (the brief's owner declined a marker on the thread);
4. on the human's closing word, tells its parent once, covering everything settled, and says it has done so;
5. sends nothing at all when the review changed nothing ("The orchestrator hears nothing, then or later").

A held child already behaves this way (PR #568, `held-child-corrections` 10 of 10). Nothing below is aimed at it.

---

## 1. `CHILD_READERSHIP_CLAUSE` (`apps/server/src/loom/prompt/prose.ts`)

The clause is one string. Only its last three sentences are shown; everything before "Your parent is not told;" is unchanged.

Current:

> Your parent is not told; answer the human here and quote what they changed in your report. Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, or a contract another thread is building on), never for a question or a message that leaves your course unchanged. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

New:

> Your parent is not told; answer the human here and quote what they changed in your report. Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, or a contract another thread is building on), never for a question or a message that leaves your course unchanged. When the human reviews a document you wrote for them (a plan, a brief, a recap, an explainer) after you have finished, that message waits: they may change a decision in their next message, so tell your parent once, when they say the review is finished, covering everything they settled; answering every question the document asks is not saying so, and a review that changed nothing needs no message. Once they have changed something, end each reply until then by telling them your parent has not been told. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

Added: the two sentences from "When the human reviews" to "has not been told." (88 words on a clause of 275). Nothing is removed: "at once" stays the rule for everything that is not a review of a document, which the brief keeps as it is.

Why here. The sentence it follows is the instruction the two located failures were obeying (§6): each child reasoned that its parent "would act differently now" and told it "right away". The rule and its exception belong in one place. A just-in-time surface was looked for and none exists at the moment of decision: a finished child decides on reading the human's message, before any tool result, and the only texts in front of it are that message and this clause. Making the human's message carry the rule would need the server to know the receiving thread is finished at the two places it projects a message for the provider (`ProviderTurnStartService.ts`, `ProviderTurnControlService.ts`), and would leave "at once" contradicting it from the system prompt.

Why each part.

- "(a plan, a brief, a recap, an explainer)" names the documents so the child's own workstream report is not read as one. A human who asks a finished coder for a code change and "update the report too" is the case `finished-child-material` guards, and it must still tell its parent at once.
- "after you have finished" keeps it off a child that is still working (its hand-back carries the review) and is the plain word for `done`. A held child has not finished; its hand-back result already tells it what to do.
- "they may change a decision in their next message" is the reason, so the model can extend it to rounds the text does not list.
- "answering every question the document asks is not saying so" is a negative constraint for one observed action (§6, the 12 Nov row), with its reason in the clause before it.
- "a review that changed nothing needs no message" names the absent outcome, so a closing word after questions alone does not produce an empty hand-over (the skill's rule 7; the brief's "then or later").
- "Once they have changed something, end each reply until then by telling them your parent has not been told" is the output shape that replaces the thread marker the owner declined. It starts at the first change so that a questions-only review does not read as a hand-over pending. It is measured separately and dropped on a miss (§5).

This is a commonly injected surface (every child, every turn). It needs the cross-family read `docs/architecture/tool-def-authoring.md` requires before it ships.

---

## 2. `REPORT_ADDITION_ECHO` (`apps/server/src/mcp/toolkits/workstream/render.ts`)

Returned to a finished child whose submit, after a human wrote to it, was added to its report.

Current:

> Added to your report as a dated section. You stay finished, nothing is routed, and your parent is not told. If this changes something your parent relied on or would act on, tell it once with `mcp__t3-code__notify_thread`, quoting the human; a clarification or a tidied report needs no message.

New:

> Added to your report as a dated section. You stay finished, nothing is routed, and your parent is not told. If this changes something your parent relied on or would act on, tell it once with `mcp__t3-code__notify_thread`, quoting the human; a clarification or a tidied report needs no message. While the human is still reviewing a document of yours, this section is a note for the record and that message waits until they say the review is finished.

Added: the last sentence. Nothing is removed.

Why. This result is where PR #568 put the test for "does my parent need to know", and it arrives at the moment a child has just recorded a round of the review. Without the added sentence it tells that child to message its parent now, against §1. With it, a section added mid-review is what the brief says a walked-away review leaves behind: a dated note in the report. At the closing word the first two sentences apply unchanged and send the one message.

Not a commonly injected surface: it is a tool result seen only by a finished child a human has written to.

---

## 3. What is deliberately not changed

- **The orchestrator overlay (`roles/orchestrator.md`).** No failure is located. §4's `orchestrator-handover-mid-build` measures what a parent does with a hand-over that arrives mid-build. If it fails on the base text, the failing samples go to a planner, who writes the line from them; no string is pre-written here for a behaviour nobody has seen fail.
- **The held hand-back result and `HELD_AGAIN_ECHO`.** A held child measured 10 of 10. They are guards in every arm.
- **The author label and the review-comment rendering** (`packages/provider-pi/src/server/provenance.loom.ts`, `packages/shared/src/composerContextReferences.ts`). Neither knows whether the receiving thread has finished, and a second copy of the rule would sit beside §1's.
- **The document skills (`skills/mdx-visual-*`).** They already say a document is signed by its author. The brief's line that a thread taking over a document signs it is met by the resolution rule (the most recent authoring signature wins, `signingSessionIds`), and a reviser that does not sign is named in the document's header by plan §2.
- **`notify_thread`'s description.** It is resident for orchestrators; the exception is a child's, and belongs with the child's rule.

---

## 4. Eval cases (`evals/loom-handback/cases.ts`)

Seven new cases, Acme data only, built as the README's "Add a case" says: every Loom-produced message comes from this checkout's source, so an arm is a commit. The scenario is fixed here; identifiers and file contents are the coder's to arrange around it.

**Shared scenario.** The reminders planner the existing held cases use, in a second form: it wrote `plan.mdx` under an approved brief, submitted `done`, and its parent has since launched two coders from the plan. The plan has a two-question form, one section on retry timing and one on message channels. Everything the planner's report and replies claim is shown earlier in the transcript as a read or a command result (the lesson of the rebuilt `finished-child-tidy`: a claim the transcript never showed made the case measure the simulator). The human's messages are built through the real path: `projectComposerContextForProvider` over `mdx-anchor` review-comment records, then `labelledForModel` with `hasParent: true`. `engagedTools` is `engagedChildTools()`.

The human's words in these cases must not reuse a phrase from §1 or §2. In particular the closing message does not contain "review" or "finished".

| id | kind | base | The transcript ends at | Passes when |
| --- | --- | --- | --- | --- |
| `finished-author-answers-form` | bad | fails | A human message that is the two form answers, each the recommended option, and nothing else. | The deciding message does not call `notify_thread` or reach for it through `tool_search` (the existing `none-of`, `plainSubmit: false`, since a report addition is allowed). |
| `finished-author-typed-correction` | bad | fails | A human message typed in the composer, with no review-comment record, asking for one change to the retry section that the first coder's work depends on. | The same `none-of`. |
| `finished-author-round-after-addition` | bad | fails | The human's two annotations asking for changes; the planner's edits; its reply; then an authored report addition and that submit's result from `world.ts`. | The same `none-of`, graded on the message after the result. Isolates §2. |
| `finished-author-closes` | bad | fails | Two authored rounds in which the planner told its parent nothing, then a human message that plainly ends it without the words "review" or "finished". | The first deciding call is `notify_thread` to the parent, and its text quotes both of the human's changes (`notifies` with the all-of quote variant below). A report addition before it does not decide (`looking`, below). |
| `finished-author-questions-only` | control | passes | Two annotations that ask why, and ask for no change. | The same `none-of`. |
| `finished-author-questions-then-close` | bad | either | Two authored rounds of questions only, each answered with nothing changed, then a plain closing word. | The same `none-of`: no message to the parent at the close. |
| `orchestrator-handover-mid-build` | control | either | In the orchestrator's thread: two coders running from the plan, then the planner's one hand-over message saying the plan is approved as it now stands and that the retry section changed, with the human's words quoted. | `prompts` with the first coder's thread id (the one whose section changed). It fails if the deciding message asks the human to confirm what they approved, or prompts the planner. |

`finished-author-answers-form` mirrors the 12 Nov row and shaped one clause of §1, so it is in-sample. The other five child cases did not shape the wording and are the held-out confirmation.

Guards, run in every arm with no change to their checks: `held-child-corrections`, `held-child-approval`, `finished-child-material`, `finished-child-tidy`, `finished-child-delegate`, `human-led-child-delegate`, `working-child-question`.

**Harness work the cases need.**

- **A live report addition does not decide, and its result comes from source.** Every new child case lists `mcp__t3-code__workstream_submit` in `looking`, as `finished-child-resends-report` lists `notify_thread`, so a report addition is not the graded message and the next message is. `simulate` in `evals/loom-handback/run.ts` answers a live `workstream_submit` itself, with `finishedSubmitResult(report, markdown, reportPath)` from `world.ts`, the way it already answers `edit`, `sign_document` and `notify_thread`. The case supplies the report on file and its path (two new optional `Case` fields). Without this the simulator model would write the result and §2 would never reach a live sample.
- **An all-of quote match.** `notifies` gains an optional `allQuotes: true`: every fragment must appear, where `quotes` today needs any one. `finished-author-closes` uses it, with one fragment per change.
- `world.ts` already returns this checkout's `REPORT_ADDITION_ECHO`, so §2 reaches the authored transcript of `finished-author-round-after-addition` with no change there.
- `run.test.ts` gains both sides of each: a submit in `looking` does not decide; `allQuotes` fails on a message that quotes one change of two.

---

## 5. Arms, in order, each a commit

| Arm | Contents | Cases | Attempts |
| --- | --- | --- | --- |
| V0 | The seven cases and the harness change; text untouched | all seven, and the seven guards | about 110 |
| V0 again | Same commit, second run | the seven new cases | about 65 |
| V1 | V0 plus §1 | as V0 | about 110 |
| V2 | V1 plus §2 | the cases whose transcript contains a report addition or may produce one: the four new `bad` child cases, `finished-child-material`, `finished-child-tidy`, `finished-child-resends-report` | about 55 |
| Full | The final arm's commit (V2, or V1 if §2 is left out): every case in `evals/loom-handback`, once per model, as `evals/README.md` asks before a merge | all 27, on `claude-fable-5-2` and on the coder preset for the coder-role cases | about 160 |

Samples: 10 for the five `bad` child cases, 5 elsewhere. About 500 attempts in all: roughly 2 hours of runs and $160 of proxy quota at the README's measured rate. The second V0 run is the noise floor for the new cases.

**What ships.**

- §1 ships if `finished-author-answers-form` and `finished-author-typed-correction` fail on V0 and pass on V1, `finished-author-closes` and `finished-author-questions-then-close` pass on V1 or V2, and no guard flips from pass to fail.
- §2 ships if `finished-author-round-after-addition` fails on V1 and passes on V2 and no guard flips.
- A `bad` case that already passes on V0 means the text aimed at it is not needed: leave that string out and say so in the report.
- In the full run, every one of the 13 cases outside the arms that passed on the base commit passes. The child cases among them read the clause: `planner-holds-brief`, `coder-holds-prototype`, `planner-plan-under-approved-brief`, `coder-plain-completion`, `held-child-parent-sendback`, `human-led-child-waits`. Their base verdicts are the last full run recorded under `evals/runs/`; if none exists for the current `main`, the full run is made on V0 as well.
- A guard or full-run case that flips, or a `bad` case that still fails with its string applied, stops the text work. The failing samples go back to a planner. The web change does not ship without this text (plan §6).

**The "not told" sentence has its own stop rule.** It is read, not pattern-matched, in the final text of every passing V1 sample (V2 where §2 applies) of the child cases where something changed (`finished-author-answers-form`, `finished-author-typed-correction`, `finished-author-round-after-addition`).

- It is kept if at least 7 of the 10 samples read in each of those cases tell the human the parent has not been told.
- It must also appear in none of the final texts of `finished-author-questions-only`, `finished-author-questions-then-close`, `working-child-question`, `human-led-child-delegate`, `held-child-corrections` and `held-child-approval`.
- On a miss, the sentence ("Once they have changed something, … has not been told.") is dropped from §1 before the full run, and the closing-word Assumed line in the brief loses the sentence the planner added to it. Nothing else in §1 changes.

**Reading.** Every failing sample of the new cases in every arm, and every sample that flipped against V0 or against the base full run.

**Where the runs happen.** Arms are commits in this worktree, and the harness imports `apps/server` and `packages` from it. Nothing else in this worktree may check out another commit while an arm is running (plan §8 takes its base-commit timings in a separate worktree for this reason).

---

## 6. Instruction change record (pre-registered; run fields are filled by the coder who runs the eval, in their report)

- **Surfaces touched:** `apps/server/src/loom/prompt/prose.ts:CHILD_READERSHIP_CLAUSE` (shared by every child); `apps/server/src/mcp/toolkits/workstream/render.ts:REPORT_ADDITION_ECHO`.
- **Tier:** 3. §1 is a shared surface and adds a rule; §2 changes a rule on a tool result.
- **Failure located:** 2 rows of 2. Of the 15 finished children a person wrote to after they finished (7 Oct to 12 Nov, live database), two received comments on a document, and both told the parent at once.
  - 12 Nov, a coder, after PR #568 was deployed. The human's message was five form answers, each the recommended option. Its reasoning before the call: "tell the parent right away, since it would plan round 3 differently now". No report addition came first.
  - 4 Nov, a planner, before PR #568. The human's message was one promoted comment carrying five decisions. Its reasoning: "I also need to tell the orchestrator about them right away through notify_thread, since the scope has changed a lot."
  - Both were single-message reviews, and both echo the clause's "at once" and "would act differently now". Neither is a multi-round review; none exists yet in the data, because until the web change in this plan a person rarely lands in a finished author. The multi-round behaviour is therefore measured by V0, not assumed.
- **Lever chosen and why:** instruction text, at the instruction that produced the behaviour. Schema and code levers were considered and set aside: the brief's owner chose no new control-plane state, and a refusal on `notify_thread` could not tell a mid-review relay from the supported "get the parent to delegate this" message.
- **Hypothesis:** in §4's table, `finished-author-answers-form`, `finished-author-typed-correction`, `finished-author-round-after-addition` and `finished-author-closes` fail on V0; the first two pass on V1; `finished-author-round-after-addition` passes on V2; `finished-author-closes` passes by V2. `finished-author-questions-then-close` is predicted either way on V0 and passes by V1. The control, every guard and every full-run case that passed on base pass in every arm. The "not told" sentence meets §5's threshold.
- **Displacement risk:**
  - a finished child holds a message that is not about a document (`finished-child-material`, `finished-child-delegate`);
  - a held child, reading "tell your parent once, when they say the review is finished", messages its parent at approval as well as completing (`held-child-approval`), or stops completing;
  - a working, held or questions-only child starts ending replies with a line about its parent (§5's zero-occurrence list);
  - a planner holding a brief for approval reads "a document you wrote for them" as its own case (`planner-holds-brief`, `held-child-parent-sendback`, in the full run);
  - a closing word after questions alone produces an empty hand-over (`finished-author-questions-then-close`);
  - a finished child treats a full set of answers as never enough and fails to hand over on a plain closing word (`finished-author-closes`).
- **Removed or superseded:** nothing removed. §1's addition is an exception to the sentence before it; §2's is an exception to the sentence before it. Both sentences they qualify stay, because the brief keeps the behaviour for everything that is not a review of a document.
- **Leak scan:** the new strings name no person, date, path, thread or product. "a plan, a brief, a recap, an explainer" are the genre names the document skills use. The cases' human messages are to be written without the strings' phrases (§4).
- **Composed-prompt check:** before V0 and after V1, read `requests/finished-author-answers-form.json` in full and confirm the clause appears once, whole, with the new sentences in place.
- **Noise floor, runs per arm, flips read, detectable effect, trace ids:** owed by the run. With 10 samples a case, 10 clean samples put the true failure rate below about a quarter; smaller rates are not excluded. The "not told" threshold of 7 of 10 per case licenses only that the sentence is usually followed, which is all a conversational cue needs.
- **Held-out confirmation:** the five child cases other than `finished-author-answers-form`, and the full run.
- **Prompt version / changelog entry:** the V1 and V2 commits are the nested variants; each commit message names the surface it changed.
