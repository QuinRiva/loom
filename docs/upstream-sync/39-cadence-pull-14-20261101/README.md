---
manager_sessions:
  - id: 01a19953-19ca-727e-a52c-b61428b2c642
    name: Pull 14 runbook (S0)
    role: plan
    authored_at: 2026-11-01T23:44:16.020Z
---

# 39: Cadence pull 14 (base `b76a110aa4` → `upstream/main` `fa31b66bbb`, 2026-11-01)

**Status: S1 merged (DL-1608–DL-1627); S2a/S2b gated clean; S3 recorded (DL-1690–DL-1699); every suite green after the Gate 2 fixes (the two web browser reds DL-1700/DL-1701, the scripts suite DL-1707); Gate 2 fixes DL-1705–DL-1712; S4 recorded (DL-1713–DL-1719): ship-ready, the deploy build fixed in DL-1713, four display findings left as follow-ups. No §8.1 row blocks S1 (see §8.1).**
This is the runbook for pull 14, in pull 13's shape (doc 38): one branch, one
merge commit, sessions with a definition of done each, and a decision log the
coders append to.

This page carries the status, the session plan (§9, below, with the
files each session reads) and the contents; every other section is its own
file named by its section number, so §6.3 is in `06-*.md`. The decision
log (§11) is `decision-log.md`, one table that every session appends
to: grep it for a `DL-` number or a path rather than reading it whole.
Where a section file and a later decision-log row disagree, the row wins.
Session records are their own files (`s3-record.md`, `s4-record.md`,
`deploy.md`). Gate 2's clean-overlap review is `clean-overlap-review.md`,
its zone lists `clean-overlap-zones.md`.

Carl's words that started it, in full: "Prepare the weekly upstream merge of
T3 code". Everything else here is measured from the trial merge and the two
trees.

---

## Contents

- [0. Headline](00-headline.md)
- [1. Topology and invariants](01-topology.md)
- [2. Departures from pull 13's shape](02-departures.md)
- [3. Surface sizing, by zone (measured in S0)](03-sizing.md)
- [4. The cold shell is built from an index, and Loom's keep rule must follow](04-cold-shell-index.md)
- [5. Tool surface: renames, linked environments, side chats](05-tool-surface.md)
- [6. Other seams, read and recorded](06-other-seams.md)
- [7. Upstream change digest and per-zone resolution doctrine](07-doctrine.md)
- [8. Pre-rulings](08-pre-rulings.md)
- 9. Sequencing: sessions, order, definition of done (below)
- [10. Gate and audit checklist for the end state](10-gate-checklist.md)
- [11. Decision log (coders append here)](decision-log.md)
- [12. Risks](12-risks.md)
- [13. Tooling notes](13-tooling.md)
- [Appendix A: reproduce the sizing](a-reproduce-sizing.md)
- [Appendix B: exact file-to-zone partition (123 conflicted files)](b-conflict-partition.md)
- [Appendix C: silently merged overlap (180 files)](c-silent-overlap.md)
- [Appendix D: where a Loom hunk moves this week](d-rehoming.md)
- [S3 record: integration gates (2026-11-02)](s3-record.md)
- [S4 record: agent-run smoke (2026-11-02)](s4-record.md)
- [For deploy](deploy.md)
- [Clean-overlap review (Gate 2)](clean-overlap-review.md)
- [Clean-overlap zones (Gate 2's file lists)](clean-overlap-zones.md)

## 9. Sequencing: sessions, order, definition of done

| Session | Reads | Delivers | Definition of done |
| --- | --- | --- | --- |
| S0: substrate (this) | Writes every file here | This runbook; measurement; DL-1600 onward | Signed; gate-reviewed; §8.1 row 1 filled in if Carl rules |
| S1: the merge (one coder, whole tree) | §1 [`01-topology.md`](01-topology.md), §7 [`07-doctrine.md`](07-doctrine.md), §8 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix B [`b-conflict-partition.md`](b-conflict-partition.md), Appendix D [`d-rehoming.md`](d-rehoming.md), §13 [`13-tooling.md`](13-tooling.md); Rule T: [pull 13 §5.2](../38-cadence-pull-13-20261025/05-test-prune.md) | The merge command (§1) in this worktree; every conflicted path resolved per §7 and Appendix B (`hx.py`/`sideresolve.py` for Rules A/B with the §7.1 caveat check, Rule T by pull 13 §5.2, Rule D by hand, unions by hand); the two UD deletions taken, Loom's `ComposerActivityStatus` diagnostic re-homed (Appendix D) and `useFileSaveCoordinator*` deleted; `providerClients.ts` move; lockfile regenerated; one merge commit (`--no-verify`, resolved files `vp fmt`-ed first); trial worktree removed | `git diff --check` clean outside `patches/`; 0 markers; `parsesweep.mjs` clean; `dangling.py` 0 outside the six known false positives; `unmarkedsweep.sh` gate clean vs `origin/main` evaluated against the new base (DL-921's method); `Migrations.ts` byte-identical; the per-file `loom`-line check of Rule D done for every Rule D file; every departure from §7/§8 a DL row. Typecheck observed with `vp run typecheck` per package, recorded, not gated |
| Gate 1: reviewer | §7.1 [`07-doctrine.md`](07-doctrine.md); the `hosted` check in §10 [`10-gate-checklist.md`](10-gate-checklist.md); S1's rows in the decision log | Read-only review of the merge | `clean` / `fixed_inline` / `needs_rework`. Must look at: the §7.1 caveat hunks (`ProjectionStore.ts`, `providerRuntime.ts`, `TimelineV2EventRow.tsx`, `CommandPalette.tsx`, `_chat.tsx`); `Orchestrator.ts` hunks 4–7 (hunk 4: `loomAskTakesAnswer` in the message branch, `loomAskAnswer` gone); `ShellStream.ts`; `serverSettings.ts` (the memo swap); `VcsStatusBroadcaster.ts`/`GitVcsDriverCore.ts`; `FilePreviewPanel.tsx`; `DiffPanel.tsx`; `MarkdownThreadLink.tsx`; the `hosted` check; `builtInDrivers.ts` |
| S2a: server track | §4.3 [`04-cold-shell-index.md`](04-cold-shell-index.md), §5.1 [`05-tool-surface.md`](05-tool-surface.md) | `apps/server`, `packages/*` typecheck 0 (tsc-rs with the new Effect diagnostics); **§4.3 index half** (`listActiveShellIndex` join, `keepsLoomEntryInColdShell`, `ShellStream.loom.test.ts`); `SCHEDULING`/`families.test.ts`/`registration.test.ts` (§5.1); `prToolkit.test.ts` layer; lint conformance for server and packages; Loom tests named below pass | Owned packages typecheck 0 (exit code); `vp lint apps/server packages` 0 errors; `LoomMigrations` (+ v1copy), `PiCwdOverride.contract`, `PiAdapterV2.loom`, `registration`, `capabilities`, `families`, `LoomV1WorkstreamImporter`, `mcpExtensionSource.loom`, `ProjectionMaintenance.loom`, `ShellStream.loom`, `ProviderSessionManager.loom`, `ThreadSearch.loom`, `prToolkit` pass |
| S2b: web/client track | §6.3 [`06-other-seams.md`](06-other-seams.md) | `apps/web`, `apps/mobile`, `packages/client-runtime` typecheck 0; §6.3 (c)'s import fixes; 56 effect reasons; jsdom `excludeFiles`; promoted-rule fixes; `resolveThreadLinkRef` repoints; `/preview` screenshots of the Loom surfaces (chips, artefact viewer, MDX plan incl. tables and Mermaid, workstream panel, graph, file change view) on the new design | Typecheck 0; `vp lint apps/web/src apps/mobile/src packages/client-runtime` 0 errors; `reactCompilerCoverage.test.ts` passes; unit tests for touched files pass; `vp run lint:mobile` passes |
| S3: integrate | §10 [`10-gate-checklist.md`](10-gate-checklist.md), §13 [`13-tooling.md`](13-tooling.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md); writes [`s3-record.md`](s3-record.md) and [`clean-overlap-zones.md`](clean-overlap-zones.md) | Fresh install (`vp i` until unchanged); `vp run typecheck` (all); `vp check`; full `vp test` for server, shared, contracts, provider-core, provider-pi, client-runtime, web (unit + browser), mobile; audits (`unmarkedsweep.sh --report`, `lostdecls.py`, `whatismissing.sh`); ledger boot on a cockpit-DB copy with timings (070–076 run, 074's early return, nothing new in `loom_sql_migrations`, index read time with and without the join, first shell read, Loom history rows before/after compaction); a fresh-home boot showing no `orchestration_v2_message_search*` object survives 069→074→1065; `UPSTREAM_BASE` advanced; §10 filled; clean-overlap zones handed to Gate 2 | All green from a fresh install; the only tolerated failure is an environment one recorded as a DL row |
| Gate 2 ×4: clean-overlap review | §3.2 [`03-sizing.md`](03-sizing.md), §8.3 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md), [`clean-overlap-zones.md`](clean-overlap-zones.md); writes [`clean-overlap-review.md`](clean-overlap-review.md) | 2a server-core + MCP seams (30 + 7 files, plus `ShellStream.ts`, `loomShellJoin.ts`, `ProjectionStore.listActiveShellIndex`, `ThreadForkService.ts`, `ProviderTurnStartService.ts`, `McpInvocationContext.ts`, `RemoteDelegation.ts`, `DelegatedTaskQuestionReactor.ts`); 2b server-other + provider packages + persistence (25 + 13 + 3, incl. `adapter.ts`'s interrupt path, `mcpExtensionSource.ts`, `DatabaseMaintenance.ts`, `ProjectionMaintenance.ts`); 2c web (33 + 17 + 2) + client-runtime (10), incl. `loomTimelineRows.ts` against paging; 2d contracts + shared + mobile + desktop + config/docs (9 + 9 + 6 + 3 + 13). Doc 29 method: disposition per file | Disposition table per file in `clean-overlap-review.md`; every DEFECT fixed before S4 |
| S4: agent-run smoke | §4 [`04-cold-shell-index.md`](04-cold-shell-index.md), §6.1 [`06-other-seams.md`](06-other-seams.md); [pull 13's S4 record](../38-cadence-pull-13-20261025/s4-record.md); writes [`s4-record.md`](s4-record.md) | Pull 13's S4 list (its `.artifacts/pull13-s4/smoke.md` journeys, DL-1311's base) on a seeded dev-verify instance and on a cockpit copy, plus: a cold browser connect shows an active root's full badge and a flagged child's `!` before the root is opened (§4); an agent's `ask_user_question` answered in the UI (one single-select, one multi-select) returns as the tool result with no duplicate chat message (§6.1); `workstream_stop` on a running pi child completes and Stop on a pi root completes without Force stop; a root longer than one history page shows Loom's cards in place; `/side` opens a side chat beside a Loom root and a Query still promotes onto a plan; pinning and archiving a project leaves Loom's sidebar sections intact; the Loom surfaces on the single design; a Pi turn resumes after a restart with a stashed steer | Passes |
| Shipper | [`deploy.md`](deploy.md) | `pnpm ship --merge-only` on Carl's approval | PR merged, branch deleted. Deploy notes in `deploy.md` |
