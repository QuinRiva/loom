## 12. Risks

| Risk | Owner | Mitigation |
| --- | --- | --- |
| The §4.3 guard is written in one pass and not the other, or against the wrong column, and the first cockpit boot deletes Loom's history | S1, Gate 1 | Gate 1 reads both clauses against §4.1's SQL; S2a's test covers both passes; S3 counts the 41,855 rows before and after the copy's first pass; the deploy is behind a snapshot either way |
| The first due prune pass on the cockpit (1.3 M deletions, 50 a page, 10 % duty) runs for hours and the WAL grows while it does | S3, deploy | S3 forces a due pass on the copy and records duration, WAL size and UI responsiveness (`PRAGMA wal_autocheckpoint` is larger this week, #31804); the deploy notes say when to expect it (24 h after the first boot) |
| The Effect 4.1 sweep (39 diagnostics plus the `Crypto` removal) is bigger than the grep ceiling and S2a runs long | S2a | Counts after the first `vp run typecheck`; a diagnostic over a day gets per-site off-switches with a DL row and a follow-up (§8.2); the `Crypto` swap is mechanical by the checker's list |
| `strictPeerDependencies: true` makes `vp i` refuse a Loom-only dependency's peer | S1 | The first `vp i` after the lockfile step; a `peerDependencyRules.allowedVersions` entry, marked, with a DL row |
| The Slack bridge breaks on Effect 4.1.2 (`effect/rpc` or `effect/socket` changed under it) | deploy | The bridge's imports are the stable modules; the deploy's bridge restart and its root Slack message are the check; rollback is `deployctl rollbackTo` plus the bridge restart it performs |
| Loom's usage-hub re-apply (§6.4) misses upstream's `hub` plumbing and the Usage page shows no accounts | S1, Gate 1 | Gate 1 reads `cliproxyApi.ts`; `UsageLimitSources.test.ts`'s hub-login case on the new shape; S4 opens the Usage page with the hub configured |
| `ws.ts` hunk 3: the provider-status stream loses Loom's exhaustion marks or upstream's per-cwd catalog stripping | S1, Gate 1 | Gate 1 reads; S4 watches a usage-limited provider's status in the composer |
| `/clear`'s `freshContext` interacts with Loom's steered tier or pending-steering stash in a way the unions do not show | Gate 2a, S4 | Gate 2a reads `Orchestrator.ts` hunk 3 with `pendingSteering.ts`; S4's `clear` journey |
| A held steer (compaction hold) is dropped by a SIGTERM during compaction, and Loom's stash does not have it | Gate 2b | Gate 2b reads `sendPrompt` against the stash; it is upstream's behaviour for upstream's steers too; a DL row sizes a Loom stash of held prompts if it matters |
| `origin/main` moves before S1 (Loom PRs in flight) | S1 | Merge it in first (DL-901's method); re-run `remeasure.sh` only if a merged PR touches a conflicted path |
