---
manager_sessions:
  - id: 01a17555-180c-7518-acad-2fa816f509f7
    name: Pull 13 runbook (S0)
    role: plan
    authored_at: 2026-10-25T23:49:19.110Z
---

# 38: Cadence pull 13 (base `07d38b8d17` → `upstream/main` `b76a110aa4`, 2026-10-25)

**Status: S0 done and reviewed; Carl's pre-rulings recorded (§8.1, 26 Oct); S1 may start.**
This is the runbook for pull 13, in pull 12's shape (doc 37): one branch, one
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

Carl's words that started it, in full: "Can you start the next Loom upstream
pull". Everything else here is measured from the trial merge and the two trees.

---

## Contents

- [0. Headline](00-headline.md)
- [1. Topology and invariants](01-topology.md)
- [2. Departures from pull 12's shape](02-departures.md)
- [3. Surface sizing, by zone (measured in S0)](03-sizing.md)
- [4. Thread search: both sides built it in the same week](04-thread-search.md)
- [5. The test prune, and the rule that decides it](05-test-prune.md)
- [6. Other seams, read and recorded](06-other-seams.md)
- [7. Upstream change digest and per-zone resolution doctrine](07-doctrine.md)
- [8. Pre-rulings](08-pre-rulings.md)
- 9. Sequencing: sessions, order, definition of done (below)
- [10. Gate and audit checklist for the end state](10-gate-checklist.md)
- [11. Decision log (coders append here)](decision-log.md)
- [12. Risks](12-risks.md)
- [13. Tooling notes](13-tooling.md)
- [Appendix A: reproduce the sizing](a-reproduce-sizing.md)
- [Appendix B: exact file-to-zone partition (173 conflicted files)](b-conflict-partition.md)
- [Appendix C: silently merged overlap (144 files)](c-silent-overlap.md)
- [Appendix D: where each Loom hunk in the split web files goes](d-rehoming.md)
- [S3 record: integration gates (2026-10-26)](s3-record.md)
- [S4 record: agent-run smoke (2026-10-26)](s4-record.md)
- [For deploy](deploy.md)
- [Clean-overlap review (Gate 2)](clean-overlap-review.md)
- [Clean-overlap zones (Gate 2's file lists)](clean-overlap-zones.md)

## 9. Sequencing: sessions, order, definition of done

| Session | Reads | Delivers | Definition of done |
| --- | --- | --- | --- |
| S0: substrate (this) | Writes every file here | This runbook; measurement; DL-1400 onward | Signed; §8.1 rulings filled in by the orchestrator from Carl's answers |
| S1: the merge (one coder, whole tree) | §1 [`01-topology.md`](01-topology.md), §4.5 [`04-thread-search.md`](04-thread-search.md), §5.2 [`05-test-prune.md`](05-test-prune.md), §7 [`07-doctrine.md`](07-doctrine.md), §8 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix B [`b-conflict-partition.md`](b-conflict-partition.md), Appendix D [`d-rehoming.md`](d-rehoming.md), §13 [`13-tooling.md`](13-tooling.md) | The merge command (§1) in this worktree; every conflicted path resolved per §7 and Appendix B (`hx.py`/`sideresolve.py` for Rules A/B, Rule T by the §5.2 rule, Rule D by hand with Appendix D); thread-search files per §4.5 (b) mechanically (upstream's files verbatim, Loom's `.loom.ts` kept, contract union, **no integration**); lockfile regenerated; `routeTree.gen.ts` regenerated; the 11 UD deletions taken, the DU (`ThreadSearch.test.ts`) taken as upstream's file, and the three re-homed Loom tests created; one merge commit (`--no-verify`, resolved files `vp fmt`-ed first); trial worktree removed | `git diff --check` clean outside `patches/`; 0 markers; `parsesweep.mjs` clean; `dangling.py` 0 outside the four known false positives; `unmarkedsweep.sh` gate clean vs `origin/main` evaluated against the new base (DL-921's method); `Migrations.ts` byte-identical; the per-file `loom`-line check of Rule D done for every Rule D file; every departure from §7/§8 a DL row. Typecheck observed with `vp run typecheck` per package, recorded, not gated |
| Gate 1: reviewer | §5.2 [`05-test-prune.md`](05-test-prune.md) (Rule T), seam 21 in §6.1 [`06-other-seams.md`](06-other-seams.md); the `hosted` check in §10 [`10-gate-checklist.md`](10-gate-checklist.md) | Read-only review of the merge | `clean` / `fixed_inline` / `needs_rework`. Must look at: every Rule D re-apply in `Orchestrator.ts`, `ws.ts` (seam 21 on upstream's split), `serverRuntimeStartup.ts` (phase order), `ChatMarkdown.tsx` + its new modules, `SidebarThreadRow.tsx`, `useComposerSend.ts`; `GitVcsDriverCore.ts`/`VcsStatusBroadcaster.ts`; `mcpExtensionSource.ts` (DL-905) and `provider-pi/driver.ts` (DL-938); the `hosted` check; the Rule T decisions in `ProviderRegistry.test.ts` |
| S2a: server track | §5.4 [`05-test-prune.md`](05-test-prune.md), §6.1 [`06-other-seams.md`](06-other-seams.md), §8.1 row 2 [`08-pre-rulings.md`](08-pre-rulings.md) | `apps/server`, `packages/*` typecheck 0; §5.4's migration-test repoint; `DatabaseMaintenance.ts` rebuild line; `ShellStream.ts` predicate; seam 21 decision; `V1ImportBoundary.loom.test.ts`, `ProcessResourceMonitor.loom.test.ts`; lint conformance for server and packages (`prefer-effect-fn`, test rules, em dashes per row 2); Loom tests named below pass | Owned packages typecheck 0 (exit code, DL-971); `vp lint apps/server packages` 0 errors; `LoomMigrations` (+ v1copy), `PiCwdOverride.contract`, `PiAdapterV2.loom`, `registration`, `capabilities`, `families`, `LoomV1WorkstreamImporter`, `mcpExtensionSource.loom`, `ProjectionMaintenance.loom`, the hooks-binding test (DL-938), `ThreadSearch.loom.test.ts` all pass |
| S2b: web/client track | §7 [`07-doctrine.md`](07-doctrine.md) (Rules C/D) | `apps/web`, `apps/mobile`, `packages/client-runtime` typecheck 0; Rule C/D residue; the Loom browser blocks on `test/render.tsx`; `timelineMinimapItems.loom.test.ts`; `getProviderInstanceEntry`; effect-budget entries; jsdom allowlist; em dashes in UI strings; mobile lint; `/preview` screenshots of the Loom surfaces (chips, artefact viewer, MDX plan, workstream panel, graph) | Typecheck 0; `vp lint apps/web/src apps/mobile/src packages/client-runtime` 0 errors; `reactCompilerCoverage.test.ts` passes; unit tests for touched files pass |
| S2c: thread search integration (parallel with S2a/S2b after Gate 1; DL-1407) | §4.5 [`04-thread-search.md`](04-thread-search.md), §8.1 row 1 [`08-pre-rulings.md`](08-pre-rulings.md) | Build the Loom `ThreadSearch` layer with Loom's hybrid ranker first so the tree compiles; **then the ranker eval** (row 1's ruling): Loom lexical, Loom hybrid and upstream's trigram ranker on one `VACUUM INTO` copy of the cockpit DB over `threadSearchQueries.json` (57 queries, 18 expecting an archived root), top-1/top-5 per scope, numbers to Carl before integrating; then §4.5 (b) with row 1's default human scope (top-level text + reports, archived included, sub-threads a toggle; agent tool full scope); the Loom `ThreadSearch` layer with upstream's three operations; `messageId` on message-kind hits; `runtimeLayer.ts` swap; Loom's archived rows, shell-less rows, labels and sub-thread line on upstream's new palette/sidebar/mobile items; `docs/user/thread-sidebar.md`; `threadSearchEval.loom.ts` run against a cockpit copy before and after (same queries, hit lists compared) | Typecheck 0 for the touched packages; `ThreadSearch.test.ts` (upstream's) and `ThreadSearch.loom.test.ts` pass; `CommandPalette.logic.test.ts`, `Sidebar.logic.test.ts`, `threadListV2.test.ts`, `state/loom/threadSearch.test.ts` pass; the eval's top-1 agreement with `origin/main` recorded in a DL row; a seeded dev instance shows an archived root and a child-report hit in Cmd+K |
| S3: integrate | §8.1 row 3 [`08-pre-rulings.md`](08-pre-rulings.md), §10 [`10-gate-checklist.md`](10-gate-checklist.md), §13 [`13-tooling.md`](13-tooling.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md); writes [`s3-record.md`](s3-record.md) | Node 26 (row 3) and pnpm 12 on the host; fresh install (`vp i` ×3); `vp run typecheck` (all packages); `vp check`; full `vp test` for server, shared, contracts, provider-core, provider-pi, client-runtime, web (unit + browser), mobile; audits (`unmarkedsweep.sh --report`, `lostdecls.py`, `whatismissing.sh`); ledger boot on a cockpit-DB copy with timings (065–069 run, 069's build time, 066's scan time, Loom history rows before/after compaction, `t3 doctor --fix` dry run showing both rebuilds); `UPSTREAM_BASE` advanced; §10 filled; clean-overlap list handed to Gate 2 | All green from a fresh install; the only tolerated failure is an environment one recorded as a DL row |
| Gate 2 ×4: clean-overlap review | §3.2 [`03-sizing.md`](03-sizing.md), §6.1 [`06-other-seams.md`](06-other-seams.md), §8.3 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md), [`clean-overlap-zones.md`](clean-overlap-zones.md); writes [`clean-overlap-review.md`](clean-overlap-review.md) | 2a server-core + orchestration seams (24 files + §6.1's table + `ShellStream.ts`, `threadFamilies.ts`, `olderSettledThreads.ts`, `GuestShareDecider.ts`, `OrchestratorMcpService.ts`); 2b server-other + provider packages + persistence (32, incl. `ProjectionMaintenance.ts`, `DatabaseMaintenance.ts`); 2c web (39) + client-runtime (9); 2d contracts + shared + mobile + desktop + config/docs (29). Doc 29 method: disposition per file | Disposition table per file in `clean-overlap-review.md`; every DEFECT fixed before S4 |
| S4: agent-run smoke | DL-1311 in [pull 12's decision log](../37-cadence-pull-12-20261019/decision-log.md); writes [`s4-record.md`](s4-record.md) | Pull 12's S4 list (DL-1311) on a seeded dev-verify instance, plus: a cold browser connect after a child submitted `needs_guidance` shows the root's Loom badge without opening it; Cmd+K finds an archived root and a child's report, and a message-kind hit jumps on mobile; a guest link is refused while the beta is off and, with it on, a guest sees a root's timeline and cannot call anything else; the design-overhaul beta toggled once with screenshots; a Pi turn resumes after a restart with a stashed steer; `t3 project add` live | Passes |
| Shipper | [`deploy.md`](deploy.md) | `pnpm ship --merge-only` on Carl's approval (pnpm 12) | PR merged, branch deleted. Deploy notes in `deploy.md` |
