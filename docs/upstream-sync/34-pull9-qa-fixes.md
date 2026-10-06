# Pull 9 — fixes from Carl's QA pass

Bugs Carl found pairing with the Phase 4 QA instance (`http://localhost:13940`,
`docs/upstream-sync/33-pull9-phase4-qa-guide.md`), and what was done about each. Decision
numbering continues from DL-600. The PR is the rollback boundary; nothing here is merged or
deployed.

## Decision log

- **DL-600 — PR retargeted.** A GitHub PR's head branch cannot be changed, so #332
  (head `ws/t3code/plan-next-upstream-merge/orchestrator-05cb7527` @ `bcee87ca65`) was
  closed with a pointer and replaced by **#333**, head `t3code/plan-next-upstream-merge`
  (= `bcee87ca65` + the Phase 4 fan-in merge `580362746c`). History is unchanged; every QA
  fix lands on this branch. Not merged.
