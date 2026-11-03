## 12. Tooling notes

- Tools: `docs/upstream-sync/pull7-tools/` (`hx.py`, `sideresolve.py`,
  `union.py`, `parsesweep.mjs`, `unmarkedsweep.sh`, `lostdecls.py`,
  `whatismissing.sh`) and `docs/upstream-sync/pull9-tools/` (`remeasure.sh`,
  `classify.py`, `automerged.py`, `dangling.py`, `zones.py`).
- `remeasure.sh` needs a clean worktree and performs its own trial merge; S0
  instead ran the four Python tools against the orchestrator's existing trial
  worktree (Appendix A). Either path gives the same captures.
- Rule A hunks: `sideresolve.py --ours` on the hunk; Rule B: `--theirs`.
- `pnpm-lock.yaml`: `git checkout --theirs pnpm-lock.yaml`, then `vp i`.
- git 2.56 is on the host; `merge-tree --write-tree` is available for
  non-mutating sizing.
