## 13. Tooling notes

- Tools: `docs/upstream-sync/pull7-tools/` (`hx.py`, `sideresolve.py`,
  `union.py`, `parsesweep.mjs`, `unmarkedsweep.sh`, `lostdecls.py`,
  `whatismissing.sh`) and `docs/upstream-sync/pull9-tools/` (`remeasure.sh`,
  `classify.py`, `automerged.py`, `dangling.py`, `zones.py`). S0's three
  scripts (`hunks.py`: per-hunk ours/theirs sizes and kinds; `imports.py`:
  Loom-only import resolution; `rehome.py`: Loom hunk → new module map) are in
  `/tmp/pull13-measure/` and reproduced in Appendix A; S1 may copy them into
  `pull9-tools/` with a commit if they earn their keep.
- Rule A hunks: `sideresolve.py --ours`; Rule B: `--theirs`; Rule T rule 1:
  `--theirs`; Rule D: `--theirs` then re-apply from `git diff 07d38b8d17 origin/main -- <file>`.
- `pnpm-lock.yaml`: `git checkout --theirs pnpm-lock.yaml`, then `vp i` ×3.
- `routeTree.gen.ts`: §6.5.
- git 2.56 on the host; `merge-tree --write-tree` for non-mutating sizing.
- The host `sqlite3` CLI (3.34.1) predates trigram FTS5; use Node's SQLite
  (`node -e` with `node:sqlite`, 3.53.4) to inspect `orchestration_v2_message_search`.
- `vp run typecheck` is the typecheck command (cached, tsc-rs underneath);
  `tsc-rs` is no longer a separate binary in the lockfile.
