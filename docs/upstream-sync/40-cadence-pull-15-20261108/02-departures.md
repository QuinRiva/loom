## 2. Departures from pull 14's shape

- **The centrepiece is a server seam that S1 must close, not S2a.** Pull 14's
  §4 (the cold-shell index) was S2a work because S1 could not do it without a
  SQL change. This week's §4 (event-log pruning vs Loom's history reads) is
  two marked SQL clauses inside a conflicted file, and the first cockpit-copy
  boot (S3) would otherwise delete 33,696 rows a minute after start. S1
  writes the clauses as part of resolving `ProjectionMaintenance.ts`; S2a
  writes the second test case; Gate 1 reads the SQL.
- **Typecheck is a different program.** `vp run typecheck` now runs
  `effect-tsgo tsrs --noEmit` per package (still cached per package by the
  root script). S2's definition of done is "exit 0 under tsgo with
  `tsconfig.effect.json`'s diagnostics", and the first run after `vp i` is the
  measurement of the Effect sweep, not a grep. `AGENTS.md`'s tsc-rs sentence
  is replaced by upstream's (§6.9).
- **Rule A is almost absent (3 markers), Rule D is in-file and small.** 23
  hunks in 20 files have a side of 20 lines or more; most are an upstream
  wrapper (a `<ul>`, a `<div className="relative">`, a `WorkspaceMutationIdContext`)
  around a Loom block, or an upstream test block beside a Loom test block.
  Appendix D has two entries.
- **No lint-rule sweep.** Pull 14's 56 effect reasons and 22 Effect
  diagnostics are done; upstream added two oxlint rules this week
  (`t3code/max-settings-description-length` on web, a mobile import
  restriction) and 39 Effect diagnostics (§5.3). Loom's PRs since pull 14
  were linted under pull 14's rules, so the sweep is the typecheck, not lint.
- **Gate 2 keeps four reviewers;** 2a's read list is the two prune passes
  (§4), the usage-hub re-apply (§6.4), `Orchestrator.ts`'s three unions and
  `ws.ts`'s provider-status stream; 2b reads the pi adapter's compaction hold
  and `--offline` (§6.1) and the Effect 4.1 `SecureRandom`/`Digest` swaps.
- **S3 adds `pnpm build` and the `@t3tools/scripts` suite to its gates**, and
  **a `fixes-review` runs in parallel with S4** (pull 14's orchestrator asked
  for both after DL-1707 and DL-1713).
- **A deploy consequence outside the repo:** the Slack bridge's `effect`
  symlink moves to 4.1.2 with the release (For deploy). Pull 14 had no such
  check; this pull names it.
