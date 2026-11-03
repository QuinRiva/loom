## 12. Risks

| Risk | Owner | Mitigation |
| --- | --- | --- |
| The index join (§4.3) slows the sidebar shell read that #27106 sped up | S2a | S3 times `listActiveShellIndex` with and without the join on the cockpit copy; the SQL is a coarse superset so it cannot disagree with the TypeScript predicate; the fallback is a second sidecar read in the same transaction |
| A §7.1 caveat hunk keeps upstream-deleted code (a duplicate `layerMemory`, a dead V1 schema) that typechecks and silently stays | S1 | The per-file `loom`-line check plus `lostdecls.py`/`whatismissing.sh` in S3; Gate 1 reads the five named hunks |
| The 22 Effect diagnostics at error turn S2a's typecheck into a larger sweep than grep predicts | S2a | Counts recorded after the first `vp run typecheck`; if a diagnostic's hits exceed a day, a reasoned `@effect-diagnostics <name>:off` per site as upstream's own files do (e.g. `databaseMigrationHead.ts`), with a DL row and a follow-up |
| Loom's spliced timeline rows land above the first loaded history page (#26240) | Gate 2c | S4 opens a long root; if seen, `loomTimelineRows.ts` splices only rows newer than the oldest loaded message and holds the rest until the page loads (small, Loom-only) |
| Pi does not confirm an interrupt within upstream's timeout, so Stop shows Force stop on every pi turn | S4 | S4 stops a pi root and a pi child; if the timeout fires, Gate 2b's read of `adapter.ts`'s `interruptTurn` says why and a DL row sizes the fix |
| The repository-batch re-apply in `VcsStatusBroadcaster.ts` misses upstream's new lock discipline and two refreshes race | S1 | Gate 1 reads; `VcsStatusBroadcaster.test.ts`'s batch cases on upstream's harness |
| `origin/main` moves before S1 (Loom PRs in flight) | S1 | Merge it in first (DL-901's method); re-run `remeasure.sh` only if a merged PR touches a conflicted path |
