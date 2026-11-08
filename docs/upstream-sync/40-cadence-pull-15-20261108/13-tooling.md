## 13. Tooling notes

- Tools: `docs/upstream-sync/pull7-tools/` (`hx.py`, `sideresolve.py`,
  `union.py`, `parsesweep.mjs`, `unmarkedsweep.sh`, `lostdecls.py`,
  `whatismissing.sh`) and `docs/upstream-sync/pull9-tools/` (`remeasure.sh`,
  `classify.py`, `automerged.py`, `dangling.py`, `zones.py`). Pull 13's S0
  scripts (`hunks.py`, `imports.py`, `peek.py`) are in `/tmp/pull14-measure/`
  and, re-pointed, in `/tmp/pull15-measure/`; Appendix A describes them.
  Three pulls now: S1 may copy `hunks.py`, `imports.py` and `peek.py` into
  `pull9-tools/` with a commit.
- Rule A hunks: `sideresolve.py --ours` **after** the §7.1 caveat grep (all
  three this week are moves or deletions, so `--ours` is wrong for all three
  as written); Rule B: `--theirs`; Rule T: by hand; Rule D: `--theirs` then
  re-apply from `git diff fa31b66bbb origin/main -- <file>`.
- `pnpm-lock.yaml`: `git checkout --theirs pnpm-lock.yaml`, then `vp i` until
  unchanged. This is the install that brings `@effect/tsgo` and Effect 4.1.2;
  nothing in the merged tree typechecks before it.
- `vp run typecheck` is the typecheck command (now `effect-tsgo tsrs --noEmit`
  per package, cached per package by the root script; `npx tsc` no longer
  exists in the tree). `vp lint <paths>` for a scoped lint. Pre-commit lints
  and runs knip (`knip:check` is now a two-pass Vite+ task); merge commits are
  `--no-verify`.
- The host `sqlite3` CLI (3.34.1) predates trigram FTS5; use Node's SQLite
  (`node -e` with `node:sqlite`) to inspect FTS tables. For §4's counts plain
  `sqlite3 "file:…?mode=ro"` is enough (Appendix A).
- A forced prune pass on a copy: backdate `event-log-prune-mark`'s
  `updated_at` by a day in `orchestration_v2_projection_metadata`, then boot
  (the first pass, a minute in, is then due) or call `t3 doctor compact` against the
  copy (`DatabaseMaintenance.ts`, no duty cycle).
- The `.repos/effect` rename makes `git merge` without
  `-c merge.renameLimit=30000` report 16,673 delete/add pairs; the merge
  command in §1 carries it. `git diff --stat` between the bases is dominated by
  `.repos/` too; measure the app surface with `-- . ':!.repos'`.
