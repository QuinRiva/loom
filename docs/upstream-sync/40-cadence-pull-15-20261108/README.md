---
manager_sessions:
  - id: 01a1bd62-7c48-7681-b888-63171ee929a4
    name: Pull 15 runbook (S0)
    role: plan
    authored_at: 2026-11-08T23:49:21.412Z
---

# 40: Cadence pull 15 (base `fa31b66bbb` → `upstream/main` `3fa57b92a2`, 2026-11-08)

**Status: S0 written (DL-1800–DL-1809); awaiting the gate review. No §8.1 row: Carl decides nothing before S1 starts (§8.1).**
This is the runbook for pull 15, in pull 14's shape (doc 39): one branch, one
merge commit, sessions with a definition of done each, and a decision log the
coders append to.

This page carries the status, the session plan (§9, below, with the
files each session reads) and the contents; every other section is its own
file named by its section number, so §6.4 is in `06-*.md`. The decision
log (§11) is `decision-log.md`, one table that every session appends
to: grep it for a `DL-` number or a path rather than reading it whole.
Where a section file and a later decision-log row disagree, the row wins.
Session records are their own files (`s3-record.md`, `s4-record.md`,
`deploy.md`). Gate 2's clean-overlap review is `clean-overlap-review.md`,
its zone lists `clean-overlap-zones.md`.

Carl's words that started it, in full: "Can you begin the next upstream
pull". Everything else here is measured from the trial merge and the two
trees.

---

## Contents

- [0. Headline](00-headline.md)
- [1. Topology and invariants](01-topology.md)
- [2. Departures from pull 14's shape](02-departures.md)
- [3. Surface sizing, by zone (measured in S0)](03-sizing.md)
- [4. Upstream prunes the event log, and Loom's workstream timeline reads it](04-event-prune.md)
- [5. Toolchain: Effect 4.1.2, `@effect/tsgo`, the `.repos/effect` rename](05-toolchain.md)
- [6. Other seams, read and recorded](06-other-seams.md)
- [7. Upstream change digest and per-zone resolution doctrine](07-doctrine.md)
- [8. Pre-rulings](08-pre-rulings.md)
- 9. Sequencing: sessions, order, definition of done (below)
- [10. Gate and audit checklist for the end state](10-gate-checklist.md)
- [11. Decision log (coders append here)](decision-log.md)
- [12. Risks](12-risks.md)
- [13. Tooling notes](13-tooling.md)
- [Appendix A: reproduce the sizing](a-reproduce-sizing.md)
- [Appendix B: exact file-to-zone partition (74 conflicted files)](b-conflict-partition.md)
- [Appendix C: silently merged overlap (187 files)](c-silent-overlap.md)
- [Appendix D: where a Loom hunk moves this week](d-rehoming.md)
- [For deploy](deploy.md)
- S3 record, S4 record, clean-overlap review and zones: written by those sessions

## 9. Sequencing: sessions, order, definition of done

| Session | Reads | Delivers | Definition of done |
| --- | --- | --- | --- |
| S0: substrate (this) | Writes every file here | This runbook; measurement; DL-1800 onward | Signed; gate-reviewed |
| S1: the merge (one coder, whole tree) | §1 [`01-topology.md`](01-topology.md), §4.3 [`04-event-prune.md`](04-event-prune.md), §5.1–5.2 [`05-toolchain.md`](05-toolchain.md), §6 [`06-other-seams.md`](06-other-seams.md), §7 [`07-doctrine.md`](07-doctrine.md), §8 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix B [`b-conflict-partition.md`](b-conflict-partition.md), Appendix D [`d-rehoming.md`](d-rehoming.md), §13 [`13-tooling.md`](13-tooling.md); Rule T: [pull 13 §5.2](../38-cadence-pull-13-20261025/05-test-prune.md) | The merge command (§1) in this worktree; every conflicted path resolved per §7 and Appendix B (`sideresolve.py` only after the §7.1 caveat grep; Rule D by hand; unions by hand; Rule E inside Loom hunks); **the two §4.3 guard clauses in `ProjectionMaintenance.ts`**; `.repos/effect/.envrc` removed; lockfile regenerated (`vp i` with tsgo and Effect 4.1.2 arriving); one merge commit (`--no-verify`, resolved files `vp fmt`-ed first); trial worktree removed | `git diff --check` clean outside `patches/`; 0 markers; `parsesweep.mjs` clean; `dangling.py` 0 outside the six known false positives; `unmarkedsweep.sh` gate clean vs `origin/main` evaluated against the new base (DL-921's method); `Migrations.ts` byte-identical; the per-file `loom`-line check of Rule D done for every Rule D file; every departure from §7/§8 a DL row. Typecheck observed with `vp run typecheck` per package under tsgo, recorded (the Effect 4.1 and diagnostic counts for S2), not gated |
| Gate 1: reviewer | §4.3, §7.1 [`07-doctrine.md`](07-doctrine.md); the `prune-guard` and `hosted` checks in §10 [`10-gate-checklist.md`](10-gate-checklist.md); S1's rows in the decision log | Read-only review of the merge | `clean` / `fixed_inline` / `needs_rework`. Must look at: **the two guard clauses in `ProjectionMaintenance.ts` against §4.1's SQL**; the three Rule A caveat hunks (§7.1) and the two in disguise; `Orchestrator.ts` hunks 1 and 3; `ws.ts` hunk 3; `cliproxyApi.ts` and `UsageLimitSources.ts` (§6.4); `ChatView.tsx` hunks 2–3 and `Sidebar.tsx` hunk 2 (every Loom line inside the wrapper); `MarkdownThreadLink.tsx`; `builtInDrivers.ts` and `settings.ts` (standing); the `hosted` check |
| S2a: server track | §4.3, §5.2–5.3 [`05-toolchain.md`](05-toolchain.md), §6.1, §6.3–6.4 [`06-other-seams.md`](06-other-seams.md) | `apps/server`, `packages/*`, `scripts`, `evals` typecheck 0 under tsgo; the `effect/Crypto` → `SecureRandom`/`Digest` swap in the 8 Loom-only files and the test layers (`NodeCrypto.layer`); the mechanical-refactor sites (§5.3) and every other Effect diagnostic the first run lists; `ProjectionMaintenance.loom.test.ts` re-pointed with the V2 case; `loomProjection.test.ts` and `ToolOutputImageReclaim.loom.test.ts` re-pointed at the `ProjectionReplay` testkit (§4.3); the usage-hub tests on the `hub` shape; `agentContextBudget.json` re-measured (DL-1654); lint conformance for server and packages; Loom tests named below pass | Owned packages typecheck 0 (exit code); `vp lint apps/server packages scripts evals` 0 errors; `LoomMigrations` (+ v1copy), `PiCwdOverride.contract`, `PiAdapterV2.loom`, `registration`, `capabilities`, `families`, `mcpExtensionSource.loom`, `ProjectionMaintenance.loom`, `ShellStream.loom`, `ProviderSessionManager.loom`, `ThreadSearch.loom`, `prToolkit`, `UsageLimitSources`, `cliproxyApi` pass; a DL row with the diagnostic counts per rule |
| S2b: web/client track | §5.3–5.4 [`05-toolchain.md`](05-toolchain.md), §6.2, §6.5, §6.10 [`06-other-seams.md`](06-other-seams.md) | `apps/web`, `apps/mobile`, `packages/client-runtime`, `apps/desktop` typecheck 0 under tsgo (mobile now runs the Effect rules too); `max-settings-description-length` fixes; `chatPathScan.test.ts` against upstream's new path regex; `/preview` screenshots of the Loom surfaces (chips, artefact viewer, MDX plan incl. tables and Mermaid, workstream panel and Timeline tab, graph, context-viz rail, file change view) | Typecheck 0; `vp lint apps/web/src apps/mobile/src packages/client-runtime apps/desktop` 0 errors; `reactCompilerCoverage.test.ts` passes; unit tests for touched files pass; `vp run lint:mobile` passes |
| S3: integrate | §10 [`10-gate-checklist.md`](10-gate-checklist.md), §13 [`13-tooling.md`](13-tooling.md), §4.3, Appendix C [`c-silent-overlap.md`](c-silent-overlap.md); writes `s3-record.md` and `clean-overlap-zones.md` | Fresh install (every `node_modules` deleted; `vp i` until unchanged); `vp run typecheck` (all); `vp check`; `vp run knip:check`; **`pnpm build`**; full `vp test` for server, shared, contracts, provider-core, provider-pi, client-runtime, web (unit + browser), mobile, **`@t3tools/scripts`**; audits (`unmarkedsweep.sh --report`, `lostdecls.py`, `whatismissing.sh`); ledger boot on a cockpit-DB copy with timings (077–080 run, nothing new in `loom_sql_migrations`, **the Loom history row counts before and after the first prune pass**, a forced due pass's duration and `deletedEventCount` if affordable, `scripts/loom-evals/run.sh` against the copy after it, why the cockpit's `compacted-at` breadcrumb is two days stale, first shell read); a fresh-home boot showing no `orchestration_v2_message_search*` object survives 069→074→1065; `UPSTREAM_BASE` advanced; §10 filled; clean-overlap zones handed to Gate 2 | All green from a fresh install; the only tolerated failure is an environment one recorded as a DL row |
| Gate 2 ×4: clean-overlap review | §3.2 [`03-sizing.md`](03-sizing.md), §8.3 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md), `clean-overlap-zones.md`; writes `clean-overlap-review.md` | 2a server-core + MCP seams (30 + 8 files, plus `OrchestrationEventStore.ts`, `DatabaseStorage.ts`, `ThreadSettlementService.ts` with #527/DL-1705/#20058, `PullRequestWatchReactor.ts`, `ProviderTurnStartService.ts`, `McpHttpServer.ts`'s registrations, `RestartContinuation.ts` with `freshContext`); 2b server-other + provider packages + persistence (24 + 9 + 5, incl. `adapter.ts`'s `sendPrompt` hold and teardown against `pendingSteering.ts`, `driver.ts`, `Sqlite.ts`, `DatabaseMaintenance.ts`, the `SecureRandom`/`Digest` swaps); 2c web (16 + 31 + 3) + client-runtime (12), incl. `MessagesTimeline.logic.ts`'s visibility filter against `insertLoomTimelineRows`, `useComposerSend.ts` (DL-1725 survived), `composerDraftStore.ts`/`shared/model.ts` (DL-1720), `composerContextPresentation.tsx`; 2d contracts + shared + mobile + desktop + docs/config (11 + 12 + 9 + 3 + 14). Doc 29 method: disposition per file | Disposition table per file in `clean-overlap-review.md`; every DEFECT fixed before S4 |
| S4: agent-run smoke (a `fixes-review` of Gate 2's fixes runs in parallel) | §4, §6.1–6.2, §6.4 [`06-other-seams.md`](06-other-seams.md); [pull 14's S4 record](../39-cadence-pull-14-20261101/s4-record.md); writes `s4-record.md` | Pull 14's S4 list (its journeys, DL-1311's base) on a seeded dev-verify instance and on a cockpit copy, plus: **the Timeline tab of a workstream older than a day still lists its outcomes, flags and routes after the copy's prune pass** (§4); `/clear` on a pi root (§10 `clear`); a steer during a pi compaction lands after it; the Usage page with the hub (§10 `usage`) and a title generated through cliproxy; a finished Loom root with an open PR stays active, one without settles; `hideAll` tool-call visibility on a Loom root shows its consult and control cards; Copy thread's clipboard text pasted into a composer is the chip; a cold connect shows an active root's badge and a flagged child's `!`; `workstream_stop` and Stop complete on pi; `ask_user_question` single and multi-select; the Loom surfaces on the single design; a Pi turn resumes after a restart with a stashed steer | Passes |
| Shipper | [`deploy.md`](deploy.md) | `pnpm ship --merge-only` on Carl's approval | PR merged, branch deleted. Deploy notes in `deploy.md`; the bridge check (§10 `bridge`) is the deploy's |
