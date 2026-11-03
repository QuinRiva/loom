## 13. Tooling notes

- Tools: `docs/upstream-sync/pull7-tools/` (`hx.py`, `sideresolve.py`,
  `union.py`, `parsesweep.mjs`, `unmarkedsweep.sh`, `lostdecls.py`,
  `whatismissing.sh`) and `docs/upstream-sync/pull9-tools/` (`remeasure.sh`,
  `classify.py`, `automerged.py`, `dangling.py`, `zones.py`). Pull 13's S0
  scripts (`hunks.py`, `imports.py`, `rehome.py`, `peek.py`) are in
  `/tmp/pull13-measure/` and, re-pointed, in `/tmp/pull14-measure/`; Appendix A
  describes them. S1 may copy them into `pull9-tools/` with a commit if they
  earn their keep (two pulls now).
- Rule A hunks: `sideresolve.py --ours` **after** the §7.1 caveat grep; Rule
  B: `--theirs`; Rule T: by hand; Rule D: `--theirs` then re-apply from
  `git diff b76a110aa4 origin/main -- <file>`.
- `pnpm-lock.yaml`: `git checkout --theirs pnpm-lock.yaml`, then `vp i` until
  unchanged.
- The host `sqlite3` CLI (3.34.1) predates trigram FTS5; use Node's SQLite
  (`node -e` with `node:sqlite`) to inspect FTS tables.
- `vp run typecheck` is the typecheck command (tsc-rs underneath, Effect
  diagnostics included); `vp lint <paths>` for a scoped lint. Pre-commit now
  lints and runs knip; merge commits are `--no-verify`.
- Linked environments and managed policy are testable without a second
  machine only as refusals; neither is in S4's list beyond the Labs toggle.
