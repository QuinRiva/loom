# Prompt-prune watch-list

On 2026-09-30 the orchestrator role (`roles/orchestrator.md`), the planner
naming rule (`roles/planner.md`) and the `mcp__t3-code__ask_user_question` tool prose
(`apps/server/src/provider/Drivers/Pi/providerToolDefs.ts`) were cut from
~3,700 to ~1,000 resident tokens. A sentence-by-sentence audit classified
every deletion as _carried by a resident tool contract_, _generic coaching a
frontier model does not need_, or _lost_; the lost ones were restored before
shipping. What remains deleted is what this page watches.

**Baseline (full text):** `f773653414` · **Pruned:** the commit that landed this
page · **Rationale and audit:** thread `8256e5f2-9c8e-445c-b870-82f0eb060030`
("Rethinking agent→human questions"); audit report
`~/.t3/cockpit/userdata/workstream-reports/d64348cf-cd48-41c3-b6b3-bc6651684e40.md`.

Prompt text is the cheapest thing in this repo to revert. When you notice a
symptom below, paste its prompt into a fresh Loom thread on this repo. Each
prompt already tells the agent to consult the thread above for the original
reasoning before choosing between restoring the baseline sentence and
drafting new wording, and to ship through the guarded flow with a
cross-family wording review.

## Symptoms

| #   | What you'd notice                                                                                                                              | Sentence that used to guard it (baseline line)                                                                                                                                                                       |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | An orchestrator kept reading/spawning/re-planning instead of laying out a graph promptly; or re-planned constantly without evidence            | "Understand the goal → evaluate the complexity → map out a loose initial effort…" / "Use replanning triggers…" (`roles/orchestrator.md` 38–41)                                                                       |
| 2   | Independent read-only research was run one child at a time instead of in parallel                                                              | "Parallelise read-only exploration." (42)                                                                                                                                                                            |
| 3   | A review gate was set to the wrong depth — trivial work looping twice, or deep work cut off after two rounds                                   | "set `maxRounds` only when the default of 2 is wrong — deep or risky work may warrant 3, trivial work 1" (45)                                                                                                        |
| 4   | A gate was pre-wired on exploratory work whose shape then changed, or a reviewer was spawned late and never wired                              | "Defer wiring when the shape is uncertain…" (49)                                                                                                                                                                     |
| 5   | An orchestrator left a gate alone that clearly needed a stop/prompt/lane change                                                                | "You can always intervene mid-gate…" (50)                                                                                                                                                                            |
| 6   | A rework loop where every round only _added_ mechanism went to the round cap instead of being interrupted                                      | "watch the ratchet: a rework loop where every round only adds mechanism…" (62)                                                                                                                                       |
| 7   | A child's result was accepted without being folded back into the tree/plan; or the human was escalated to for something routine                | "Fold results back… Escalate to the human only when human judgment is genuinely needed." (63)                                                                                                                        |
| 8   | A non-trivial review/decision arrived as a long chat message rather than an MDX document                                                       | "Communicate through artefacts, not chat walls… commission it in a child's brief when it requires fresh investigation" (65) — the shorter bullet survives; watch for the _commission from a child_ half being missed |
| 9   | A thread's title or goal drifted from what it was actually doing and wasn't renamed                                                            | "Keep your thread title and goal consistent with the actual goal…" (54)                                                                                                                                              |
| 10  | A question to you used an agent-coined code as an option label, an acronym it never explained, or lifted figures from a report you hadn't seen | Guidelines 1–3 of `mcp__t3-code__ask_user_question` — **still present**, compressed. If it recurs, the wording is too weak, not missing                                                                              |
| 11  | A question asked you to approve a plan or reconfirm scope you already gave                                                                     | "Never ask to reconfirm scope or for approval you do not need." — **restored**; recurrence means the model is reading "irreversible" too loosely                                                                     |
| 12  | An orchestrator did the work itself because its kickoff brief read like a to-do list                                                           | "Your kickoff brief frames work to orchestrate, not a to-do list…" — **restored**; recurrence is a real regression                                                                                                   |
| 13  | A planner's plan minted ids (D1, must-fix #2) that then appeared in questions or reports to you                                                | `roles/planner.md` naming rule — present, compressed; the _'Phase 2' / 'when quoted'_ examples were cut                                                                                                              |
| 14  | Anything else that a pre-prune orchestrator used to get right                                                                                  | Use the generic prompt                                                                                                                                                                                               |

## Prompts to paste

Replace the `<…>` fields. Everything else is self-contained.

### For a numbered symptom

```
An orchestrator on Loom just did this, which the pruned prompt text should have prevented:

<what happened, in one or two sentences — thread id if you have it>

This is symptom #<n> on docs/operations/prompt-prune-watchlist.md in the loom repo. The
prompt text was pruned in the commit that added that page; the full pre-prune text is at
git commit f773653414 (roles/orchestrator.md, roles/planner.md,
apps/server/src/provider/Drivers/Pi/providerToolDefs.ts).

Before changing anything, consult thread 8256e5f2-9c8e-445c-b870-82f0eb060030 with
mcp__t3-code__consult_thread: describe the incident and ask (a) why that sentence was cut, (b) whether
the incident matches the risk the audit foresaw, and (c) whether to restore the baseline
sentence verbatim or draft new minimal wording. Then make the smallest change that fixes
it — restore or redraft, never re-add the whole deleted block — get a cross-family
wording review (a GPT reviewer if the text is for Claude readers), run vp check and
vp run typecheck, and ship through the guarded ship flow. Report the before/after
sentence and its character cost.
```

### For an unlisted symptom (#14)

```
An orchestrator on Loom just did this, which I don't think it would have done before the
prompt pruning of 2026-09-30:

<what happened>

Read docs/operations/prompt-prune-watchlist.md in the loom repo. Diff the pre-prune text
at git commit f773653414 against HEAD for roles/orchestrator.md, roles/planner.md and
apps/server/src/provider/Drivers/Pi/providerToolDefs.ts and identify which deleted
sentence, if any, would have prevented this. Consult thread
8256e5f2-9c8e-445c-b870-82f0eb060030 with mcp__t3-code__consult_thread for why it was cut and whether to
restore it verbatim or redraft. If no deleted sentence explains it, say so — it may be a
pre-existing behaviour, not a regression. Fix with the smallest change, get a cross-family
wording review, run vp check and vp run typecheck, and ship through the guarded flow.
```

### Full revert (it's just worse)

```
Revert the prompt pruning in the loom repo: git revert the commit that added
docs/operations/prompt-prune-watchlist.md (it carries roles/orchestrator.md,
roles/planner.md and the mcp__t3-code__ask_user_question prose in providerToolDefs.ts). Keep the
watch-list page but add a line saying the prune was reverted and why. Run vp check and
vp run typecheck, ship through the guarded flow. The pre-prune text is f773653414 if the
revert conflicts.
```

## Removing this page

Once the pruned prompts have run for a few weeks without a restoration, delete
this page; the audit report and the thread above remain the record.
