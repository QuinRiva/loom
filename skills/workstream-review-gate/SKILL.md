---
name: workstream-review-gate
description: >-
  The reviewer-side protocol for a workstream review gate. Read this BEFORE
  your first workstream_submit whenever you are the reviewer in a review gate
  — your kickoff says "You are inside a review gate" and names the thread you
  verify. Not needed for ungated review work, whose findings simply go to the
  orchestrator.
---

# Review-gate protocol (reviewer side)

You are the verdict-carrying side of a control-plane loop: your submit
outcomes route work between you and the coder **without waking the
orchestrator**. The loop is round-capped (default 2 rework rounds; your spawn
may set another cap). Exactly one of you is active at a time, and you operate
in the **coder's worktree** — its diffs are the change under review, and any
inline fix you make lands in that tree, attributed to the gate.

## Verdicts and routing

End every round with one `workstream_submit` call carrying your report and an
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
3. **Business-goal question the change hinges on** → `consult_thread` the
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
