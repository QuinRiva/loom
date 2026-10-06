# Pull 9 — Phase 4: import Carl's history into a sandboxed QA instance

Phase 4 brings Carl's workstream history — goals, task trees, the workstream
fields of his threads, each thread's binding to its pi session, the lineage that
keeps children out of the sidebar — into a **QA instance** he can test for days,
per `plans/upstream-pull9-phase4-import/plan.mdx` (reviewed clean over two
rounds; re-signed by the Phase 4 orchestrator with the recorded facts folded in).
Phase 3's record is `docs/upstream-sync/31-cadence-pull-9-phase3.md`
(DL-300–487); this note continues the decision-log numbering from **DL-500**.
Scope, verbatim from Carl: *work through to phase 4 including data import, but
not deletions and cut-over … run this without overwriting the local DB … ensure
that we can still rollback.* Nothing in Phase 4 deletes V1 code, merges to
`main`, deploys, or writes to `~/.t3/cockpit` (other than this worktree),
`~/.t3/userdata`, `~/loom-releases`, the global pi or `~/.pi`.

## 1. Upstream boundary

- Phase 3 pinned `upstream/main` at `6302d66f77`. At the Phase 4 boundary
  `upstream/main` had advanced to `9bd1d8009a` (68 commits). Merge recorded in
  §3 (DL-501) once landed; `UPSTREAM_BASE` advanced with it.

## 2. Environment and ranges

- Phase 3's §2 carries over verbatim: `CI=true vp i --no-frozen-lockfile`; server
  tests need git ≥ 2.56 (`PATH=/home/Carl/.cache/pull9-git256/bin:$PATH`);
  `--no-verify` on merge-touching commits; never `git stash`; kill only captured
  PIDs; live DB copies only via `VACUUM INTO` from
  `~/.t3/cockpit/userdata/state.sqlite`.
- Migrations: Phase 4 uses **1052 only**; 1051 is free and stays free.
- The QA world is `~/.t3/qa-pull9/` — with this worktree, the only writable
  place outside the sandbox.
- DL ranges: **DL-500–509** orchestrator; **DL-510–529** importer coder/gate;
  **DL-530–549** QA-scripts coder/gate; **DL-550–579** QA-world build and
  evidence gate; **DL-580+** hand-off.

## 3. Decision log

| #      | Decision | Trigger | Resolution | Why | Evidence | Reversal cost |
| ------ | -------- | ------- | ---------- | --- | -------- | ------------- |
| DL-500 | Recorded facts folded into the Phase 4 plan before coders were briefed | brief items 2–4: parent rulings, the plan review's four nice-to-haves, Phase 3's seam shapes and launch isolation | one callout "Recorded facts folded at implementation" added to the plan; the four nice-to-haves applied in place (preview.sql `WHERE`, provider-fix model from the raw V1 JSON else `PI_DEFAULT_MODEL`, foreign report/brief paths rewritten into the QA state dir — never NULLed, the stale 1051 sentence); PR-watch row removed from §5 and the GH-token question resolved as *drop*; `pi-agent/` added to the layout with `PI_CODING_AGENT_DIR` on the unit (amends D10); guide renumbered to `33-pull9-phase4-qa-guide.md`; plan re-signed | the plan is the authority coders consult; a ruling that lives only in a brief is lost to `consult_manager` | `plans/upstream-pull9-phase4-import/plan.mdx` manifest | trivial |
