---
manager_sessions:
  - id: 01a1518f-b27b-73d3-8e51-94da7a182025
    name: Pull 12 runbook (S0)
    role: plan
    authored_at: 2026-10-19T00:50:06.245Z
---

# 37 — Cadence pull 12 (base `737192594f` → `upstream/main` `07d38b8d17`, 2026-10-19)

**Status: S0 done — runbook written and measured; awaiting Carl's pre-rulings (§7.1) before S1.**
This is the runbook for pull 12, in pull 10's shape (doc 35): one branch, one
merge commit, sessions with a definition of done each, and a decision log the
coders append to.

This page carries the status, the session plan (§8, below, with the
files each session reads) and the contents; every other section is its own
file named by its section number, so §6.3 is in `06-*.md`. The decision
log (§10) is `decision-log.md`, one table that every session appends
to: grep it for a `DL-` number or a path rather than reading it whole.
Where a section file and a later decision-log row disagree, the row wins.
Session records are their own files (`s3-record.md`, `s4-record.md`,
`deploy.md`). Gate 2's clean-overlap review is `clean-overlap-review.md`,
its zone lists `clean-overlap-zones.md`.

Carl's words that started it: "Can you start the process to do the upstream
merge pull as per the run book. I suspect there _may_ be a big conflict with
the new orchestrator approach which could need careful consideration." The
orchestration question is §4; its answer is **no mechanical conflict, two
semantic overlaps**, one of which is Carl's to rule (§7.1 row 1).

---

## Contents

- [0. Headline](00-headline.md)
- [1. Topology and invariants](01-topology.md)
- [2. Departures from pull 10's shape](02-departures.md)
- [3. Surface sizing, by zone (measured in S0)](03-sizing.md)
- [4. The orchestration overlap — upstream's subagent model vs Loom's workstream](04-orchestration-overlap.md)
- [5. Upstream change digest and per-zone resolution doctrine](05-doctrine.md)
- [6. Specific checks the brief asked for](06-checks.md)
- [7. Pre-rulings](07-pre-rulings.md)
- 8. Sequencing — sessions, order, definition of done (below)
- [9. Gate and audit checklist for the end state](09-gate-checklist.md)
- [10. Decision log (coders append here)](decision-log.md)
- [11. Risks](11-risks.md)
- [12. Tooling notes](12-tooling.md)
- [Appendix A — reproduce the sizing](a-reproduce-sizing.md)
- [Appendix B — exact file-to-zone partition (101 conflicted files)](b-conflict-partition.md)
- [Appendix C — silently merged overlap (172 files)](c-silent-overlap.md)
- [S3 record — integration gates (2026-10-19)](s3-record.md)
- [S4 record — agent-run smoke (2026-10-19)](s4-record.md)
- [For deploy](deploy.md)
- [Clean-overlap review (Gate 2)](clean-overlap-review.md)
- [Clean-overlap zones (Gate 2's file lists)](clean-overlap-zones.md)

## 8. Sequencing — sessions, order, definition of done

| Session | Reads | Delivers | Definition of done |
| --- | --- | --- | --- |
| S0 — substrate (this) | Writes every file here | This runbook; measurement; DL-1200 onward | Signed; §7.1 rulings filled in by the orchestrator from Carl's answers |
| S1 — the merge (one coder, whole tree) | §1 [`01-topology.md`](01-topology.md), §5 [`05-doctrine.md`](05-doctrine.md), §7 [`07-pre-rulings.md`](07-pre-rulings.md), Appendix B [`b-conflict-partition.md`](b-conflict-partition.md), §12 [`12-tooling.md`](12-tooling.md) | The merge command (§1) in this worktree; every conflicted path resolved per §5 using pull-7 `hx.py`/`sideresolve.py` for Rule A/B and by hand for the rest; lockfile regenerated; `WorkstreamLivenessSweep.ts` repointed; the five UD deletions taken; one merge commit (`--no-verify`, resolved files `vp fmt`-ed first); trial worktree removed | `git diff --check` clean outside `patches/`; 0 markers; `parsesweep.mjs` clean; `dangling.py` 0 outside the four known false positives; `unmarkedsweep.sh` gate clean vs `origin/main` evaluated against the new base (DL-921's method); `Migrations.ts` byte-identical; every departure from §5/§7 a DL row. Typecheck observed per package with `tsc-rs --noEmit`, recorded, not gated |
| Gate 1 — reviewer | §4.2, §4.3 [`04-orchestration-overlap.md`](04-orchestration-overlap.md); the `hosted` check in §9 [`09-gate-checklist.md`](09-gate-checklist.md) | Read-only review of the merge | `clean` / `fixed_inline` / `needs_rework`. Must look at: `VcsStatusBroadcaster.ts`/`GitVcsDriverCore.ts` interleave; `ChatMarkdown.tsx` chip pipeline; `RightPanelSurfaceContent.tsx` arms; the §4.2 reactor early returns; `hosted` check (`requireWorkstreamCaller`); `t3 project` live path (§4.3); #18498 vs the Pi resume path |
| S2a — server track | — | `apps/server`, `packages/*` typecheck 0 under `tsc-rs`; `Sqlite.ts` two-ledger check; Loom tests named below pass; `capabilities.test.ts` + `registration.test.ts` (withhold list) pass | Owned packages typecheck 0 (exit code, not error count — DL-971); `LoomMigrations`, `PiCwdOverride.contract`, `PiAdapterV2.loom`, `registration`, `capabilities`, `LoomV1WorkstreamImporter`, `mcpExtensionSource.loom`, the hooks-binding test (DL-938) all pass |
| S2b — web/client track | §5.3, §5.4 [`05-doctrine.md`](05-doctrine.md), §7.1 rows 1–2 [`07-pre-rulings.md`](07-pre-rulings.md) | `apps/web`, `apps/mobile`, `packages/client-runtime` typecheck 0; Rule C residue; the five re-homed assertions (§5.4); §7.1 row 1's rollup change; the React Compiler sweep at the depth row 2 ruled; `/preview` screenshots of the Loom surfaces (chips, artefact viewer, MDX plan, workstream panel) | Typecheck 0; `vp lint` over `apps/web/src` 0 errors; `reactCompilerCoverage.test.ts` passes (with exemptions only as ruled); unit tests for touched files pass |
| S3 — integrate | §7.1 rows 3–4 [`07-pre-rulings.md`](07-pre-rulings.md), §9 [`09-gate-checklist.md`](09-gate-checklist.md), §12 [`12-tooling.md`](12-tooling.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md); writes [`s3-record.md`](s3-record.md) | Fresh install; Playwright Chromium if row 3 says so; `vp run typecheck` (all packages); `vp check`; full `vp test` for server, shared, contracts, provider-core, provider-pi, client-runtime, web (unit + browser), mobile; audits (`unmarkedsweep.sh --report`, `lostdecls.py`, `whatismissing.sh`); ledger boot on a cockpit-DB copy with timings (row 4); `UPSTREAM_BASE` advanced; §9 filled; clean-overlap list handed to Gate 2 | All green from a fresh install; the only tolerated failure is an environment one recorded as a DL row |
| Gate 2 ×4 — clean-overlap review | §3.2 [`03-sizing.md`](03-sizing.md), §4.2 [`04-orchestration-overlap.md`](04-orchestration-overlap.md), §7.3 [`07-pre-rulings.md`](07-pre-rulings.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md), [`clean-overlap-zones.md`](clean-overlap-zones.md); writes [`clean-overlap-review.md`](clean-overlap-review.md) | 2a server-core + orchestration seams (28 files + the §4.2 table + `storageCleanup.ts`, `threadShell.ts`); 2b server-other + provider packages + persistence (60); 2c web (48) + client-runtime (10); 2d contracts + shared + mobile + desktop + config (26). Doc 29 method: disposition per file | Disposition table per file in `clean-overlap-review.md`; every DEFECT fixed before S4 |
| S4 — agent-run smoke | DL-1001 in [doc 35](../35-cadence-pull-10-v0.0.46-nightly-20261012.md), §7.1 row 1 [`07-pre-rulings.md`](07-pre-rulings.md); writes [`s4-record.md`](s4-record.md) | Pull 10's S4 list (DL-1001) on a seeded dev-verify instance, plus: a child question/approval shows once on the root (row 1's ruling); a Loom child's `consult_thread` and `needs_guidance` still reach the right place and no parent gets a "Delegated task … has a question" message; thread-tabs, artefact viewer and MDX plan annotate after the compiler sweep; a Pi turn resumes after a restart with a stashed steer | Passes |
| Shipper | [`deploy.md`](deploy.md) | `pnpm ship --merge-only` on Carl's approval | PR merged, branch deleted. Deploy note: check the Slack bridge against Effect 4.0.5 before any cockpit promotion (DL-1015's rule) |
