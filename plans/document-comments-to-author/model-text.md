# Model-facing text for the hand-over after a document review

Companion to `plans/document-comments-to-author/plan.mdx` (§4). It holds every text a model reads that this change adds or replaces, as the exact characters to ship, with the eval that decides whether each ships. A coder applies each "New" block verbatim and reviews it for fit only (does it name the tools that exist, with the behaviour the handlers have). A wording change goes back to a planner, not into the diff.

Authored under `llm-instruction-change` and the two doctrines in `docs/architecture/tool-def-authoring.md` and `docs/architecture/prompt-surface-authoring.md`. Tool names are written as the model sees them. No text below contains a value from a real thread or an eval case; the rows that motivated it are in the change record (§6), where no model reads them.

**Revision 2, 13 Nov 2026, after revision 1 failed its eval.** Revision 1's §1 ran on Claude Opus 5.5 and did not move the behaviour it was written for; it is reverted (`40fd7a689a`), and its per-reply "your parent has not been told" sentence is dropped under the stop rule it carried. This revision is written under the orchestrator's working assumption, which is put to the brief's owner and not yet answered (§0). Everything in §1, §2, §4 and §5 replaces revision 1. §6 keeps revision 1's change record, with its results, and adds revision 2's.

---

## 0. What a finished author is asked to do, under the working assumption

The brief's owner asked for one hand-over at the end of a review, with nothing before it. Revision 1's samples showed why that fails as written: every relay named work already being built from the old version. The orchestrator put the choice to him and is proceeding on this, until he answers:

> a finished author sends its parent one early message only when the parent has work under way that the change alters, and that message carries what is already decided; everything else, including later changes, waits for his closing word and goes in the one hand-over.

**Departure from that wording.** This text applies the early-message test to each change as it is settled, not once per review. A second change that redirects work already under way also goes when it is made. "At most one early message" would ask the author to sit on a change it knows coders are building against. Every relay in revision 1's samples refused exactly that, so the one-message cap rebuilds the measured failure one round later. The orchestrator agreed to this reading and is putting it to the brief's owner. What it costs him: when several rounds each change work already being built, the parent gets one message per such change, plus the hand-over.

So a child that has finished, and whose document the human reviews in its thread:

1. tells its parent at once about a change only if it alters work the child knows has started from the document;
2. holds every other change until the human says the review is finished, and does not take a set of answers as that word;
3. then sends one message covering the whole review, or none if nothing changed;
4. puts a gap it finds in its own document to the human with a proposed fix, and treats it as a change only once the human agrees. After that, rule 1 or 2 applies to it like any other change.

A held child is not aimed at: PR #568 already holds it, and nothing it reads changes.

---

## 1. `CHILD_READERSHIP_CLAUSE` (`apps/server/src/loom/prompt/prose.ts`)

The clause is one string. Only its last three sentences are shown; everything before "Your parent is not told;" is unchanged. The current text is what is on `main` and this branch after the revert.

Current:

> Your parent is not told; answer the human here and quote what they changed in your report. Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, or a contract another thread is building on), never for a question or a message that leaves your course unchanged. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

New:

> Your parent is not told; answer the human here and quote what they changed in your report. Tell your parent at once, with `mcp__t3-code__notify_thread`, only when it would act differently now (the human changed the scope, or a contract another thread is building on), never for a question or a message that leaves your course unchanged. When the human reviews a document you wrote after you finished, narrow that test: a change they make goes to your parent when you make it only if it alters work you know has started from the document (your brief or your parent said so). Anything else waits until they say the review is finished, which answering its questions is not; then one message covers the whole review, or none if nothing changed. A gap you find in your own document meanwhile is theirs to decide, even if work has started from it: propose your fix in your reply and treat it as a change only once they agree. Once they have written, `mcp__t3-code__notify_thread` and `mcp__t3-code__ask_user_question` are available to you.

Added: three sentences, from "When the human reviews" to "once they agree." (109 words on a clause of 275). Nothing is removed. "At once ... a contract another thread is building on" stays as the rule for everything that is not a review of a document; the new text narrows it for a review rather than overriding it.

**What changed from revision 1, and why, sentence by sentence.**

- **The exception is now the base rule, narrowed.** Revision 1 told the author to wait while the base sentence beside it said "at once" for "a contract another thread is building on". The model sided with the base sentence every time it knew coders were building (`finished-author-typed-correction`, 0 of 10 in every arm). The new sentence agrees with the base sentence instead of contradicting it, and narrows it from "would act differently" to "alters work you know has started". The relays in the samples all name started work, which is the line the brief's owner drew on 23 Oct: "unless the parent thread would get value from immediately being made aware of my comment".
- **"you know has started from the document (your brief or your parent said so)".** The early message needs evidence the child can point to, not a guess about what the parent might be doing. In the samples the evidence was always the child's brief ("Two coders start from it as soon as you hand it back"). Without such evidence the absent outcome applies: the change waits. This is the boundary between "the parent is building something this change alters" and "the parent might care". The second is what the per-change relay the brief's owner ruled out would follow.
- **"which answering its questions is not".** Kept from revision 1 in shorter form. Answering a document's questions must not be read as the end of the review. One 12 Nov live row and one revision 1 sample (V1 #6, "relayed the answers alone") treated a set of answers as something to hand over.
- **"one message covers the whole review, or none if nothing changed".** The hand-over, with its absent outcome named. The closing word already worked on the base text (`finished-author-closes`, 10, 8 and 10 of 10), so this only has to keep it working. "The whole review" covers changes already sent early, so the parent gets one account of where the document stands.
- **"A gap you find in your own document meanwhile is theirs to decide ...".** New. In revision 1 most relays in the cases where nothing the human settled touched started work were the planner's own fixes, found while recording his answers. That is `finished-author-answers-form` (V1 #2, #4, #8, #9) and `finished-author-questions-only` (V0 and V1, most failures). The passing samples were the ones that put the gap to him first: "Say if you'd like me to add the two tests to the plan and tell the orchestrator." (answers-form V1 #7). The reason given, "since they are reading now", is that he is in the conversation, so the wait is one reply. "even if work has started from it" closes the back door the samples used ("The coders are building now, so I'm telling the parent straight away", answers-form V1 #9). The cost is accepted: a real defect in work being built waits for his reply. Once he agrees it is his change, and the first sentence sends it at once if it alters started work.
- **Removed from revision 1:** "they may change a decision in their next message", which the model outweighed with started work every time, and the per-reply "Until then, end each reply by telling them your parent has not been told". The per-reply sentence met its stop rule's threshold in neither direction:
  - it appeared in 3 of the 6 passing changed-case samples, against a threshold of 7 of 10 per case;
  - it spread to the held planner, in 8 of 10 `held-child-corrections` replies against 0 of 10 on V0.

  It is dropped. Nothing replaces it, so an open review is visible only in the conversation's content.

This is a commonly injected surface (every child, every turn). It needs the cross-family read `docs/architecture/tool-def-authoring.md` requires before it ships.

---

## 2. `REPORT_ADDITION_ECHO` (`apps/server/src/mcp/toolkits/workstream/render.ts`)

Returned to a finished child whose submit, after a human wrote to it, was added to its report. Not applied in revision 1's runs (V2 was not reached).

Current:

> Added to your report as a dated section. You stay finished, nothing is routed, and your parent is not told. If this changes something your parent relied on or would act on, tell it once with `mcp__t3-code__notify_thread`, quoting the human; a clarification or a tidied report needs no message.

New:

> Added to your report as a dated section. You stay finished, nothing is routed, and your parent is not told. If this changes something your parent relied on or would act on, tell it once with `mcp__t3-code__notify_thread`, quoting the human; a clarification or a tidied report needs no message. While the human is reviewing a document of yours, that holds only for a change to work you know has started from it; anything else waits until they say the review is finished.

Added: the last sentence (33 words). Nothing is removed.

**Why.** The result's test ("relied on or would act on") is the broad one. A child that records a round of the review in its report, then reads this result, is told to relay a change nobody is building. The added sentence narrows the test in the same terms as §1, at the moment the child reads it. In revision 1, `finished-author-round-after-addition` relayed straight after this result in 9 of 10 samples, saying "My earlier report update doesn't reach it on its own." Under §0 those relays are now correct, because both changes alter started work. So §2 is measured instead by a case whose change touches nothing started (§4, `finished-author-unbuilt-part-after-addition`).

Not a commonly injected surface: it is a tool result seen only by a finished child a human has written to.

---

## 3. What is deliberately not changed

- **The orchestrator overlay.** `orchestrator-handover-mid-build` passed 5 of 5 in every arm, prompting only the coder whose part changed. No orchestrator text is needed.
- **The held hand-back result and `HELD_AGAIN_ECHO`.** A held child is guarded in every arm.
- **The author label and the review-comment rendering** (`packages/provider-pi/src/server/provenance.loom.ts`, `packages/shared/src/composerContextReferences.ts`). Neither knows whether the receiving thread has finished. A copy of the rule there would be a second definition beside §1's.
- **`notify_thread`'s description.** The tool is resident for every orchestrator. A sentence about a finished child's review would be ambient text for a population that never meets the case.
- **Where the text goes.** The samples settle it. A finished author decides on the human's message. Between the message and the decision it calls only pi's `read`, `edit` and `bash` (typed-correction V1: all 10 edited, linted and committed, then notified, and none submitted first). No Loom text arrives between his message and its decision. The clause is the only Loom surface in reach, and §2 covers the minority that record a round first. The human-in-child build's lesson, a sentence in the result the child reads at the moment it decides, applies to §2 and has no counterpart for §1.

---

## 4. Eval cases (`evals/loom-handback/cases.ts`)

Acme data only, built as the README's "Add a case" says, every Loom-produced message from this checkout's source, and Opus 5.5 for every arm. The scenario meanings are fixed here; identifiers and file contents are the eval coder's to arrange.

**Two scenarios.**

- **Started.** The present reminders scenario. The planner's brief says "Two coders start from it as soon as you hand it back", and the plan says "The coders build to the recommended option until you answer".
- **Waiting.** New. The same plan, report and human messages, with one difference: the planner's brief says the orchestrator starts the build once the human has reviewed the plan and said it is ready, and the plan's question-form line says the coders start once the human has answered. Nothing else differs. The child then has no evidence that work has started, and the only correct place for a change is the hand-over.

Each of the following applies to every case:

- **No phrase from §1 or §2.** The human's words in a case reuse nothing from the new strings. In particular, the closing message contains neither "review" nor "finished".
- **Every claim shown.** Every claim in the planner's report and replies is shown earlier in its transcript.
- **Shared setup.** `finishedAuthor` (a report addition is looking, answered from source; up to 10 messages before deciding) as now.

**Cases, with what changed and why.** "Correctness changed" means the working assumption changed what the right behaviour is. "Transcript only" means the pass condition is unchanged and the authored part was rebuilt so it shows behaviour that is correct under §0. No pass condition below changes to fit a result.

| id | scenario | kind, base | pass condition | what changed, and why |
| --- | --- | --- | --- | --- |
| `finished-author-answers-form` | started | bad, fails | `none-of` on `notify_thread` | Unchanged. His answers are the recommended options, so nothing started changes. A notify there is either a relay of the answers or of the planner's own unagreed fix; both are wrong under §0. |
| `finished-author-questions-only` | started | **bad, fails** (was control, passes) | `none-of` | Kind and base prediction corrected from measurement, 1 of 5 in both V0 runs. The pass condition is unchanged: a planner's own revisions after his questions are proposals under §0 rule 4. |
| `finished-author-questions-then-close` | started | bad, either | `none-of` | Unchanged. |
| `finished-author-typed-correction` | started | **guard, passes** (was bad, fails) | **`notifies` the parent, quoting his change** (one fragment of "once, on the next daily run") | **Correctness changed.** His change alters what the started job coder builds, so the early message is now correct. Revision 1 measured 10 of 10 notifies on base, so this is a guard against the new text suppressing it. |
| `finished-author-round-after-addition` | started | **guard, passes** (was bad, fails) | **`notifies`, `allQuotes`** on both changes | **Correctness changed**, as above. Both changes alter started work. It no longer measures §2 (see the after-addition case below). |
| `finished-author-closes` | **waiting** (was started) | control, passes | `notifies`, `allQuotes`, as now | **Transcript only.** Its authored rounds have the planner tell the parent nothing after two changes. In the started scenario that is now wrong behaviour, so the rounds move to the waiting scenario, where silence until the close is correct. |
| `finished-author-nothing-started` | waiting | bad, either | `none-of` | **New**, the case the brief asked for. The typed correction of `finished-author-typed-correction`, word for word, with no work started. It must stay silent. |
| `finished-author-unbuilt-part` | started | bad, either | `none-of` | **New.** A typed change to a part of the plan that neither coder's brief covers and nobody builds: the reasoning in §5, the rejected alternative. For example: "In §5, add that a per-invoice timer is also out because finance closes its books by calendar day, so exact-hour sends gain nothing." Work has started, but not on anything this alters. This is the narrowness test of §1's first sentence: "the parent might care" is not enough. |
| `finished-author-unbuilt-part-after-addition` | started | bad, fails | `none-of` | **New.** As above, with the planner's edit, commit and a report addition authored, so the deciding message follows §2's result. This is §2's case. |
| `finished-author-second-redirect` | started | guard, passes | `notifies`, quoting the second change only | **New**, from the departure in §0. Round 1: his retries change, the planner's edit, and its authored early message, which quotes it. Round 2: his SMS change, which alters the second coder's started work. The second message is correct. A sample that holds it fails. |
| `finished-author-closes-after-redirect` | started | control, either | `notifies`, quoting the round 2 change | **New.** Round 1: a change to started work, sent early. Round 2: the `unbuilt-part` change, held. Then his closing word. The hand-over goes and carries the held change. Quoting the round 1 change too is allowed, since "the whole review" may restate it. |

`finished-author-answers-form` and `finished-author-questions-only` supplied the wording of §1's last sentence, so they are in-sample. `finished-author-typed-correction` supplied the wording of its first. The held-out confirmation is: `nothing-started`, `unbuilt-part`, `unbuilt-part-after-addition`, `second-redirect` and `closes-after-redirect`, which did not shape the wording, and the Full arm.

**Guards in every arm, unchanged.** `held-child-corrections`, `held-child-approval`, `finished-child-material`, `finished-child-tidy`, `finished-child-delegate`, `human-led-child-delegate`, `working-child-question`, `orchestrator-handover-mid-build`.

**Harness work.**

- **The waiting scenario.** A variant of the planner's brief, plan and report with the two lines above changed. It reuses everything else.
- **`notifies` with a single fragment** for `finished-author-typed-correction` and `finished-author-second-redirect`, as the grader already supports.
- **No new check kind.**

---

## 5. Arms, in order, each a commit, all on `claude-opus-5-5`

The base text is unchanged since revision 1's V0 (`8f294eba7d` and `40fd7a689a` carry the same clause and echo). For the three cases whose transcript and pass condition are unchanged (`answers-form`, `questions-only`, `questions-then-close`), revision 1's two V0 runs are this revision's V0 and noise floor: `doc-review-opus-v0-new` and `doc-review-opus-v0-again`, regraded. They are not run again.

| Arm | Contents | Cases | Samples | Attempts |
| --- | --- | --- | --- | --- |
| V0 | The rebuilt and new cases; text untouched | the eight new or changed cases | 10 for the four `bad` new cases, 5 elsewhere | about 60 |
| V0 again | Same commit | the four `bad` new cases | 10 | about 40 |
| V1 | V0 plus §1 | all eleven finished-author cases, and the eight guards | 10 for the six `bad` cases, 5 elsewhere | about 125 |
| V2 | V1 plus §2 | `unbuilt-part-after-addition`, `round-after-addition`, `finished-child-material`, `finished-child-tidy`, `finished-child-resends-report` | 10 for the first, 5 elsewhere | about 30 |
| Full | The final arm's commit: every case in `evals/loom-handback`, once | all 32 | 5, as the README's default | about 165 |

About 420 attempts. At revision 1's measured rate (about 115k input tokens an attempt on the planner cases), that is roughly 45M input tokens and 3 hours of runs. The Full arm's base is the all-pass `doc-review-opus-v0` run for the 20 cases that predate this change.

**What ships.**

- **§1 ships if** all of these hold:
  - `answers-form` and `questions-only` pass on V1 (both failed V0);
  - `nothing-started`, `unbuilt-part` and `questions-then-close` pass on V1;
  - `typed-correction`, `round-after-addition` and `second-redirect` still notify;
  - `closes` and `closes-after-redirect` pass;
  - no guard flips from pass to fail.
- **A new `bad` case that already passes on V0** does not need the part of §1 aimed at it. Say so in the report, and keep the sentence only if another case needs it:
  - the first sentence serves `nothing-started` and `unbuilt-part`;
  - the last serves `answers-form` and `questions-only`.

  A sentence no case needs is removed before the Full arm.
- **§2 ships if** `unbuilt-part-after-addition` fails on V1 and passes on V2, and no guard flips.
- **In the Full arm**, every case that passed on its base passes.
- **What stops the text.** Any of the following stops the text work, and the failing samples go back to a planner:
  - a guard or Full-arm case that flips;
  - `typed-correction` or `second-redirect` falling below 8 of 10 notifies, which means the narrowing suppressed a correct early message;
  - a `bad` case that still fails with its string applied.

  The web change does not ship without this text (plan §6).

**Reading.**

- **Every failing sample of every finished-author case in every arm,** and every sample that flipped against V0 or the Full arm's base.
- **Every passing sample of `answers-form` and `questions-only`,** for whether the planner proposed its fix or simply sat on it. A pass that silently drops a real defect it found is a finding even though the grader passes it. Report the count of samples that proposed a fix and the count that found a gap and said nothing.
- **The final text of every notify in `typed-correction` and `second-redirect`,** for whether it carries only what is settled.

**Where the runs happen.** Arms are commits in this worktree, and the harness imports `apps/server` and `packages` from it. Nothing else here may check out another commit while an arm runs.

---

## 6. Instruction change record

### Revision 1 (12 Nov 2026): run, failed, reverted

- **Surfaces:** `CHILD_READERSHIP_CLAUSE` (§1 of revision 1, two sentences added); `REPORT_ADDITION_ECHO` (never applied).
- **Arms run** (Claude Opus 5.5, effort high; simulator Claude Sonnet 5.5; verdicts regraded with the fixed grader). The figures are passes:

  | Case | V0 | V0 again | V1 |
  | --- | --- | --- | --- |
  | `finished-author-answers-form` | 1/10 | 4/10 | 5/10 |
  | `finished-author-typed-correction` | 0/10 | 0/10 | 0/10 |
  | `finished-author-round-after-addition` | 0/10 | 0/10 | 1/10 |
  | `finished-author-closes` | 10/10 | 8/10 | 10/10 |
  | `finished-author-questions-only` | 1/5 | 1/5 | 3/5 |
  | `finished-author-questions-then-close` | 10/10 | 10/10 | 8/10 |
  | `orchestrator-handover-mid-build` | 5/5 | 5/5 | 5/5 |

  No guard's verdict flipped. V2 and Full were not run.
- **Run directories:** `evals/runs/doc-review-opus-v0-new`, `doc-review-opus-v0-again` and `doc-review-opus-v1`.
- **Per-reply sentence:** missed its stop rule both ways. It appeared in 3 of 6 passing changed-case samples, and in 8 of 10 `held-child-corrections` replies against 0 of 10 on V0, for example: "My parent thread hasn't been told about these changes yet; I'll pass them on when you approve."
- **Reverted** in `40fd7a689a`.

### Revision 2 (13 Nov 2026)

- **Surfaces touched:**
  - `apps/server/src/loom/prompt/prose.ts:CHILD_READERSHIP_CLAUSE`, shared by every child;
  - `apps/server/src/mcp/toolkits/workstream/render.ts:REPORT_ADDITION_ECHO`.
- **Tier:** 3. §1 is a shared surface and changes a rule; §2 changes a rule on a tool result.
- **Failure located:** revision 1's samples, read in full for the four failing cases. They contain two different failures.
  - **A relay of the human's change because work has started.** Typed-correction, all 10 V1 samples; round-after-addition, 9 of 10. "My parent has already started the coders on the plan's three-retry default, so I'm telling it now." (typed #9) "The coders started from this plan as soon as I handed it back, so they are building three retries and SMS on both reminders. Telling the parent." (round #6)

    Under §0 this is now correct behaviour. The fix is the cases' pass condition, because the human's decision changed what is right; no text is aimed at it. The text's job here is only not to suppress it.
  - **A relay of the planner's own fix, made without the human.** Answers-form V1: 5 failures, 4 of them own fixes (#2, #4, #8, #9) and 1 a relay of the answers with an own fix (#6). Questions-only V0: 8 of 10 failures, all own revisions. "A job only runs if `registry.ts` imports it, and the plan never says to add that import. The coders are building now, so I'm telling the parent straight away." (answers-form V1 #9) "Answering them showed the plan was missing contracts both coders need, so I have amended it" (questions-only V0-new #1). The passes asked first: "Say if you'd like me to add the two tests to the plan and tell the orchestrator." (answers-form V1 #7) "I'll draft the question about the gaps these answers expose, then put it to you." (questions-only V0-again #3).
- **Lever chosen and why:** instruction text, at the instruction the relays obey, rewritten to agree with the base sentence rather than override it.
  - **Schema or code levers** are ruled out by the brief's owner's choice of no new control-plane state, and by the impossibility of telling a correct early message from a wrong one in a handler.
  - **Placement** is settled by where the decision happens (§3).
- **Hypothesis, pre-registered:**
  - `answers-form` and `questions-only` move from fail on V0 to pass on V1;
  - `nothing-started` and `unbuilt-part` pass by V1;
  - `unbuilt-part-after-addition` fails on V1 and passes on V2;
  - `typed-correction`, `round-after-addition` and `second-redirect` notify in at least 8 of 10 samples in every arm;
  - `closes`, `closes-after-redirect` and `questions-then-close` pass in every arm;
  - every guard and every Full-arm case that passed on base passes.

  Prediction for V0 of the new cases: `nothing-started` either, since base "would act differently now" with no started work may already hold; `unbuilt-part` fails, since the base text and the samples treat "the plan changed" as enough; `unbuilt-part-after-addition` fails.
- **Displacement risk:**
  - **The narrowing suppresses a correct early message.** `typed-correction`, `second-redirect` and `round-after-addition`, with the stop threshold of 8 of 10.
  - **"Propose your fix" makes a planner sit on a real defect without saying so.** Measured by reading every passing `answers-form` and `questions-only` sample (§5).
  - **A held child reads "a document you wrote after you finished" as its own case.** It would then propose instead of fixing, or tell its parent on approval. `held-child-corrections`, `held-child-approval`, and `planner-holds-brief` and `held-child-parent-sendback` in the Full arm.
  - **A finished child doing other work for the human starts proposing instead of acting.** `finished-child-material` and `finished-child-delegate`.
  - **A working child narrows its own "at once".** `working-child-question` and `human-led-child-delegate`.
- **Removed or superseded:**
  - revision 1's "they may change a decision in their next message";
  - the per-reply "not told" sentence;
  - revision 1's §2 sentence, replaced.

  Nothing is removed from the base text.
- **Leak scan:** the new strings name no person, date, path, thread, product, file or job. "registry", "retries", "SMS", "coders" and "orchestrator" appear in no new string. The cases' human messages must avoid the strings' phrases (§4).
- **Composed-prompt check:** before V0 and after V1, read `requests/finished-author-typed-correction.json` in full. Confirm the clause appears once, whole, with the new sentences in place on V1 and absent on V0.
- **Noise floor:** V0 and V0 again for the four `bad` new cases. Revision 1's two V0 runs for the three unchanged cases.
- **Runs per arm, flips read, trace ids:** owed by the run.
- **Detectable effect:** with 10 samples, 10 clean samples put the true failure rate below about a quarter. A threshold of 8 of 10 notifies admits a true rate as low as about 49%, so it catches a large suppression only.
- **Held-out confirmation:** the five new child cases and the Full arm.
- **Prompt version / changelog entry:** the V1 and V2 commits are the nested variants. Each commit message names the surface it changed.

### For the brief's owner, if he accepts the working assumption

The brief's must-not and one of its checks would no longer match the behaviour. The orchestrator owns that conversation; replacement wording is in the planner's report, not here, because only the owner edits his brief.
