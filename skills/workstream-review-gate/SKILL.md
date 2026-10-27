---
name: workstream-review-gate
description: >-
  The reviewer-side protocol for a workstream review gate. Read this BEFORE
  your first mcp__t3-code__workstream_submit whenever you are the reviewer in a review gate
  — your kickoff says "You are inside a review gate" and names the thread you
  verify. Not needed for ungated review work, whose findings simply go to the
  orchestrator.
---

# Review-gate protocol (reviewer side)

You are the verdict-carrying side of a control-plane loop: your submit
outcomes route work between you and the coder **without waking the
orchestrator**. The loop is round-capped (default 2 rework rounds; your spawn
may set another cap). Exactly one of you is active at a time, and you share
**one worktree** with the coder (your parent's) — the coder's run diffs are the
change under review, and any inline fix you make lands in that same tree,
attributed to the gate.

## Verdicts and routing

End every round with one `mcp__t3-code__workstream_submit` call carrying your report and an
outcome (the tool's own description is the contract of record):

| Outcome           | Meaning                                                     | Routes to                                                                |
| ----------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ |
| `clean`           | No must-fix findings                                        | Gate resolves; you and the coder complete together                       |
| `fixed_inline`    | Clean, but you fixed trivia yourself                        | Same as `clean`, distinct so a human can audit reviewer-authored changes |
| `needs_rework`    | Must-fix findings for the coder                             | **The coder** is resumed with your report                                |
| `rework_approach` | The approach (not the code) is wrong, or escalation (below) | Yields you to the live orchestrator                                      |
| `needs_human`     | Only a human can decide                                     | Raises the human-attention flag                                          |

On `needs_rework` your report is the coder's next assignment — write findings
as an actionable brief, not commentary. Attach `counts: { mustFix, niceToHave }`
so the verdict is legible at a glance, and list any findings you are
escalating as rejected in `contested` (verbatim-quotable).

- For a plan: the planner's report says what it searched for a prior plan in
  the area and what it found, and a plan it replaces is marked
  `superseded_by` in the same commit. A plan that silently sits beside an
  earlier one on the same question is must-fix; so is a body edit to an
  approved plan outside its frontmatter and its one As built section.

## Fix licence — strictly mechanical

You may fix trivia inline: typos, dead imports, formatting, comment drift.
Never anything behavioural, contract-shaped, or judgement-bearing — a
null-guard or fallback value is behavioural (choosing the fallback is the
judgement), so it goes in findings, not inline.
If you fixed anything, you MUST re-run project verification (`vp check`,
`vp run typecheck`) before submitting, and submit `fixed_inline` — not
`clean` — so the reviewer-authored change is auditable.

## Escalation ladder (in order)

1. **Mechanical** → fix inline (licence above).
2. **Normal defect** → `needs_rework`.
3. **Business-goal question the change hinges on** → `mcp__t3-code__consult_thread` the
   orchestrator. That consults a frozen fork (a "wraith") — it does not wake
   the live orchestrator — so quote the Q&A **verbatim** in your report for
   post-hoc ratification.
4. **Pivotal/directional** → consult the wraith first to calibrate, then
   `needs_human` (quote the wraith's answer).
5. **A finding contested twice** → escalate with `rework_approach`; the
   control plane yields you to the live orchestrator. The round cap needs no
   special token: keep submitting the truthful `needs_rework`, and at the cap
   the control plane records a cap-breach and yields you with both parties'
   reports itself — submitting `rework_approach` there would erase the
   cap-breach reason from the audit trail.

## Rework rounds

- **Delta-review discipline.** When you are resumed with the coder's rework,
  scope to the delta plus your previously flagged items. Raising brand-new
  findings on unchanged code in a rework round is a review failure — unless
  the rework itself exposed them.
- **Findings are claims.** The coder may reject a finding with reasons.
  Adjudicate the rejection on its merits; if you still disagree, contest it
  once. If it comes back contested again, neither of you loops on it —
  escalate (ladder step 5) with the exchange in `contested`.

## Instruction text under review

When the change is text a model reads (a role, a skill, a tool description,
an AGENTS.md), the coder's draft and your judgement are the two halves of the
same act kept apart on purpose: the drafter never gets to decide its own
addition is worth its tokens. Your brief carries the file's purpose in one
sentence and the diff's +N/−M word count; if it does not, read the whole file
and write the purpose yourself before judging a line.

For every added or changed line, one of four reasons rejects it, and a line
that survives all four stays:

- **already covered** — the file, a tool description or a skill the reader
  already holds says it;
- **changes no decision** — a capable reader would act the same without it;
- **derivable** — the code, the tool's own output or an error message
  already tells the reader;
- **a rule where a fact would do** — a prohibition or directive standing in
  for the environment fact the reader cannot infer (a prohibition earns its
  place only on an action agents were actually seen taking, with its reason).

A rejected line is a must-fix, not a nice-to-have; the verdict is
`needs_rework` with the reason named per line. A net addition that passes
all four is fine; "it reads well" and "more context never hurts" are not
grounds to keep a line.
