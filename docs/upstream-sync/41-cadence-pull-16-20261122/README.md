---
manager_sessions:
  - id: 01a20579-c7b3-729a-b22d-5ba2e0ae4fed
    name: Pull 16 runbook (S0)
    role: plan
    authored_at: 2026-11-22T23:53:03.363Z
---

# 41: Cadence pull 16 (base `3fa57b92a2` → `upstream/main` `a09738fb43`, 2026-11-22)

**Status: S0–S4 done; Gate 1, the S2a/S2b gates, Gate 2 (3 defects fixed and reviewed clean) all clean; `origin/main` caught up at `7e349022a8` (#592, #594); S4 ship-ready on `a638336044` (DL-2402). Final run on `fa5b764c79` (23 Nov): lockfile unchanged, typecheck, check, knip, build and the sweep green; every suite green except the tolerated `AntigravityInstallation` test and 7 of 8,066 web browser tests that fail only in a whole-suite run and pass alone, two of them failing the same way on `main` (follow-up 53). Node 26.13.1 active on the host (DL-2414). Carl's rulings DL-2410 to DL-2415 are recorded; the rest of §8.1 was applied as recommended (`follow-ups.md` row 12). Awaiting Carl's word to ship (`pnpm ship --merge-only`).**

This is the runbook for pull 16, in pull 15's shape (doc 40) with two
structural changes: S1 is one merge resolved by a lead and six lane coders
(§2), and Appendix B is an index plus one file per zone with a resolution
for every conflict hunk.

This page carries the status, the session plan (§9, below, with the files
each session reads) and the contents; every other section is its own file
named by its section number, so §6.4 is in `06-*.md`. The decision log (§11)
is `decision-log.md`, one table that every session appends to: grep it for a
`DL-` number or a path rather than reading it whole. Where a section file
and a later decision-log row disagree, the row wins. Session records are
written by their sessions (`s3-record.md`, `s4-record.md`); Gate 2's review
is `clean-overlap-review.md`.

Carl's words that started it, in full: "Kick off then next upstream pull".
Everything else here is measured from the trial merge, the two trees and
read-only queries of the cockpit database.

**Who reads what first.** Carl: §0 and the table in §8.1. A lane coder: its
row below, §7, then its zone files. A gate reviewer: its row below.

---

## Contents

- [0. Headline](00-headline.md)
- [1. Topology and invariants](01-topology.md)
- [2. Departures from pull 15's shape, and how S1 is cut](02-departures.md)
- [3. Surface sizing, by zone](03-sizing.md)
- [4. Upstream's new agent tools and prompt text](04-agent-tools.md)
- [5. Translation, toolchain, Node and migrations](05-i18n-toolchain.md)
- [6. Other seams, read and recorded](06-seams.md)
- [7. Resolution doctrine: the rules, S1's mechanics, cross-lane contracts, Gate 1's list](07-doctrine.md)
- [8. Pre-rulings: the rows for Carl, the rulings carried, findings](08-pre-rulings.md)
- 9. Sequencing: sessions, order, definition of done (below)
- [10. Gate and audit checklist for the end state](10-gate-checklist.md)
- [11. Decision log (coders append here)](decision-log.md)
- [12. Risks](12-risks.md)
- [13. Tooling notes](13-tooling.md)
- [Appendix A: reproduce the sizing](a-reproduce-sizing.md)
- [Appendix B: file-to-zone partition (193 conflicted paths)](b-conflict-partition.md), and the zone files:
  [B.1 config and docs](b01-config-docs.md) ·
  [B.2 orchestration](b02-orchestration.md) ·
  [B.3 store, shell, search](b03-store-shell-search.md) ·
  [B.4 server entry](b04-server-entry.md) ·
  [B.5 MCP](b05-mcp-tools.md) ·
  [B.6 providers](b06-providers.md) ·
  [B.7 usage](b07-usage.md) ·
  [B.8 VCS, projects, workspace](b08-vcs-project-workspace.md) ·
  [B.9 web chat](b09-web-chat.md) ·
  [B.10 web panels](b10-web-panels.md) ·
  [B.11 web sidebar](b11-web-sidebar.md) ·
  [B.12 contracts and settings](b12-contracts-settings.md) ·
  [B.13 mobile and client](b13-mobile-client.md)
- [Appendix C: silently merged overlap (170 files, plus 2 renamed)](c-silent-overlap.md)
- [Appendix D: where a Loom hunk moves this pull](d-rehoming.md)
- [For deploy](deploy.md)
- [`tools/`](tools/): the measurement scripts
- S3 record, S4 record, clean-overlap review: written by those sessions

## 9. Sequencing: sessions, order, definition of done

Order: S0 → S1 lead opens → S1 lanes 1 to 6 in parallel → S1 lead closes
(the one merge commit) → Gate 1 (two reviewers) → S2a and S2b in parallel →
S3 → Gate 2 (four reviewers) → S4, with a review of Gate 2's fixes in
parallel → shipper → the post-deploy session. Every session reads §1 first
and greps the decision log for its files. Anything a session leaves for after
the merge is a row in [`follow-ups.md`](follow-ups.md), cited from wherever it
was found: what it is in words a reader outside the pull can follow, where it
came from, and what it needs (a check after the deploy, Carl's call, or agent
work). A session that leaves nothing adds no row.

| Session | Reads | Delivers | Definition of done |
| --- | --- | --- | --- |
| S0: substrate (this) | Writes every file here | This runbook; measurement; DL-2000 to DL-2019 | Signed; gate-reviewed |
| S1 lead, opening | §1 [`01-topology.md`](01-topology.md), §2.1 [`02-departures.md`](02-departures.md), §5.4 [`05-i18n-toolchain.md`](05-i18n-toolchain.md), §7 [`07-doctrine.md`](07-doctrine.md), §8 [`08-pre-rulings.md`](08-pre-rulings.md), [`b-conflict-partition.md`](b-conflict-partition.md), [B.1](b01-config-docs.md), §12, §13 | `df -h /` checked (§12); the merge command (§1) in this worktree; the conflict set checked against Appendix B; `pnpm-workspace.yaml` and the four `package.json` files resolved with §5.4's lines; upstream's lockfile; `vp i` until unchanged | The lockfile is stable on a second `vp i`; no marker left in those six files (they stay unstaged until the close, like every other path); `git diff --name-only --diff-filter=U` still lists the 193 paths of Appendix B and no other; a DL row for any difference. Then the lanes start |
| S1 lanes 1 to 6 (parallel; §2.1's table says which zones) | §7 [`07-doctrine.md`](07-doctrine.md) whole, §8 [`08-pre-rulings.md`](08-pre-rulings.md), [`d-rehoming.md`](d-rehoming.md), its zone files, and: lanes 1 and 2 §4 [`04-agent-tools.md`](04-agent-tools.md); lanes 4, 5, 6 §5.1 [`05-i18n-toolchain.md`](05-i18n-toolchain.md); each lane its subsections of §6 [`06-seams.md`](06-seams.md) (lane 1: 6.5, 6.7, 6.8; lane 2: 6.3, 6.4; lane 3: 6.6; lane 4: 6.1, 6.2; lane 5: 6.9, 6.10; lane 6: 6.1, 6.11); Rule T: [pull 13 §5.2](../38-cadence-pull-13-20261025/05-test-prune.md) | Every conflicted path of its zones resolved per its zone file's row; the unmarked files §7.3 assigns to it edited; finished files copied to `.artifacts/pull16-s1/resolved/`; DL rows in `.artifacts/pull16-s1/dl-<lane>.md` | No marker in its paths; `parsesweep.mjs` clean on them; `vp fmt` run on them; the per-file `loom`-line check done for every Rule D file; no git command that writes the index or tree was run; every departure from its zone file is a DL row; the hand-back lists resolved, new and unmarked-edited files and what it leaves for S2 |
| S1 lead, closing | §7.2 [`07-doctrine.md`](07-doctrine.md), the rest of [B.1](b01-config-docs.md), §5.1 (the `AGENTS.md` bullet), §10 `markers`, `rule-d`, `superseded`, `sweep` | The docs and `AGENTS.md`/`README.md` hunks of B.1; the two upstream-deleted paths `git rm`ed; `routeTree.gen.ts` regenerated; everything staged; lanes' DL rows appended; **one merge commit** (`--no-verify`); the trial worktree and `.artifacts/pull16-s1/resolved/` removed; `vp run typecheck` per package observed and recorded | `git diff --check` clean outside `patches/`; 0 markers; `parsesweep.mjs` clean; `dangling.py` 0 outside the known false positives; `unmarkedsweep.sh` gate clean vs `origin/main` evaluated against the new base (DL-921's method); `Migrations.ts` byte-identical; the commit has the two parents of §1; typecheck counts per package in a DL row (not gated) |
| Gate 1 ×2: server, client | §7.1, §7.3, §7.5 [`07-doctrine.md`](07-doctrine.md); §4 (server); §5.1 (client); the zone files of its lanes; S1's rows in the decision log | Read-only review of the merge commit | `clean` / `fixed_inline` / `needs_rework` naming the lane. Must look at §7.5's list and every zone-file row marked for Gate 1 |
| S2a: server track | §4.2, §4.5 [`04-agent-tools.md`](04-agent-tools.md); §5.3, §5.5, §5.6 [`05-i18n-toolchain.md`](05-i18n-toolchain.md); §6.3 to §6.8, §6.14 [`06-seams.md`](06-seams.md); "Left for the integration tracks" in B.1 to B.8; §10 `tools`, `prompt-text`, `pi`, `usage`, `store`, `vcs` | `apps/server`, `packages/*` (server-side), `scripts`, `evals` typecheck 0; **`families.ts` and its test per the §8.1 rulings**; the DL-471 service test, the two `mcpExtensionSource` assertions, the one-label test; `piOneShot.ts` on `resolvePiModelSlug`; 1066's `json((…))`; the pending-migration helper's test; `cliproxyApi.test.ts`'s 12 re-pointed calls and the usage tests on one carry-forward mechanism; the broadcaster and driver tests on the widened mocks; `runtimeLayer.test.ts` against migration 1018; `ProviderRegistry.test.ts`'s fakes; `capabilities.test.ts`; `agentContextBudget.json` re-measured (DL-1654); lint conformance for server and packages | Owned packages typecheck 0 (exit code); `vp lint apps/server packages scripts evals` 0 errors (the `no-untranslated-copy` errors in `packages/client-runtime/src/state/loom/` are S2b's and clear with its exclusion block); the suites §10 names for it pass; a DL row with the tool lists as shipped and the re-measured budget |
| S2b: web and client track (may be split: web; mobile with client-runtime) | §5.1, §5.4 [`05-i18n-toolchain.md`](05-i18n-toolchain.md); §6.1, §6.2, §6.9 to §6.11, §6.14 [`06-seams.md`](06-seams.md); [`d-rehoming.md`](d-rehoming.md); "Left for the integration tracks" in B.9 to B.13; §10 `i18n`, `deps`, `meter`, `markdown`, `panels`, `compiler`, `screens` | `apps/web`, `apps/mobile`, `packages/client-runtime`, `apps/desktop` typecheck 0; **the i18n exclusion block and the wraps** (§5.1) with `vp check` at 0 for the rule; `documentViewer/main.tsx`; the two markdown ports and the `code.tsx` port, then `react-markdown` out of the manifest; the context meter's re-home (under the ruling; last in its list); Loom's hunk in the 1.7 diffs patch; `rightPanelStore` at 17 checked against a saved v16 state; the Loom-only compile breaks of §6.14; `sidebarGoalActions.ts`; mobile `MdxDocumentView` fixes and the re-export; `chatPathScan.test.ts` against upstream's new path regex; **the `/preview` screenshot pass below** | Typecheck 0; `vp lint apps/web/src apps/mobile/src packages/client-runtime apps/desktop` 0 errors; `reactCompilerCoverage.test.ts` passes; the suites §10 names for it pass; `vp run lint:mobile` passes; screenshots attached to its report |
| S3: integrate | §10 [`10-gate-checklist.md`](10-gate-checklist.md), §12 [`12-risks.md`](12-risks.md), §13 [`13-tooling.md`](13-tooling.md), §5.3, §5.5, §6.7, §6.8, Appendix C [`c-silent-overlap.md`](c-silent-overlap.md); writes `s3-record.md` | Disk check; Node 26.13.1 active (under the ruling); fresh install (every `node_modules` deleted; `vp i` until unchanged); `vp run typecheck` (all); `vp check`; `vp run knip:check`; `pnpm build`; full `vp test` for server, shared, contracts, provider-core, provider-pi, client-runtime, web (unit + browser), mobile, `@t3tools/scripts`; audits (`unmarkedsweep.sh --report`, `lostdecls.py`, `whatismissing.sh`); **the ledger boot on a cockpit-database copy under `/mnt/fast/pull16/` with per-migration timings and the checks of §10 `ledger`**, including the previous release booting on the migrated copy; a fresh-home boot; `launcherSeam.test.ts` at protocol 4 and the README paragraph; `UPSTREAM_BASE` advanced; §10 filled; `deploy.md` amended with the measured boot time | All green from a fresh install; the only tolerated failure is an environment one recorded as a DL row; boot-to-listen reported against the 240 s budget; the copy deleted |
| Gate 2 ×4: clean-overlap review | §3.2 [`03-sizing.md`](03-sizing.md), §8.3 [`08-pre-rulings.md`](08-pre-rulings.md), Appendix C [`c-silent-overlap.md`](c-silent-overlap.md) (its table says which zones and which files each of 2a to 2d reads first), the "Silently merged files" lists in the zone files; writes `clean-overlap-review.md` | A disposition per file (doc 29's method) for the 172 silently merged files and the named unmarked files | Disposition table per file; every DEFECT fixed before S4 |
| S4: agent-run smoke (a review of Gate 2's fixes runs in parallel) | §4.5, §6 [`06-seams.md`](06-seams.md), §10; [pull 15's S4 record](../40-cadence-pull-15-20261108/s4-record.md) for the base journeys; writes `s4-record.md` | Pull 15's S4 journeys on a seeded dev-verify instance and on a cockpit copy, plus the journeys below | Passes, or a list of what does not with DL rows; `deploy.md` amended |
| Shipper | [`deploy.md`](deploy.md) | `pnpm ship --merge-only` on Carl's approval | PR merged, branch deleted. The deploy is Carl's, with `deploy.md` |
| Post-deploy (a new thread on main; the orchestrator schedules it when the shipper reports the merge: `schedule_task`, `once` for the next morning, `bindToCurrentThread` false, prompt as in "After the merge" in `../README.md`) | [`follow-ups.md`](follow-ups.md), [`deploy.md`](deploy.md); "After the merge" in [`../README.md`](../README.md) | What `deploy.md` says happens at and after the switch, and the check rows, read back from the live install, read-only; an outcome for every row of `follow-ups.md`; a `post-pull` issue for each open item worth acting on; `recaps/pull-16-post-deploy/recap.mdx` for Carl | Every check has a result or a named owner; every row has an outcome; no open item is recorded only in the runbook, a thread or a task tree; Carl has the document |

### S2b's `/preview` screenshot pass

The harness is `docs/web-component-preview.md`; fixtures are in
`apps/web/src/preview/fixtures.tsx`. One screenshot per fixture, compared by
eye with the same fixture on `origin/main` (the harness runs there too):

- Chat markdown: `wide-table`, `file-chip-table`, `narrow-table`,
  `code-blocks`, `inline-code-file-links`, `prose-and-code-path-links` and
  its `-streaming` twin (paths must stay inert while streaming),
  `thread-mention`, `scanned-path-verification`, `file-chip-states`,
  `skill-token-chips`.
- `user-message` (including `user-wide-table`) and `pending-user-input`.
- MDX documents: "MDX plan document", `mdx-markdown-rendered` (the `code.tsx`
  port), `mdx-mermaid`, `mdx-wide-blocks`, `mdx-scrolling-table`,
  `mdx-card-bleed`, `mdx-diff-words`, "Document author line", "Query
  affordance and pins".
- Review: "Whole-file change view" (`loom-file-change-view`), "Diff word
  highlighting" (solid, under the ruling).
- Workstream: `workstream-graph*`, "Loom goal tasks panel", the consult-card
  fixtures, "Context diagnostics" (`loom-context-viz-*`).

### S4's journeys added this pull

On a seeded dev-verify instance (`docs/dev-site-testing.md`; `vp run
dev:seed`) unless a line says the cockpit copy (a `migrate-dev-db` slice or
S3's copy):

1. **Tools.** A new root's tool list (§10 `tools`); a shipper child watches
   its PR; a scheduled-task fire on a pi root carries one author line.
2. **Sidebar.** Root "Deliver the workstream fixture" reads `4/9 · 1!` on
   first load, once, beside any issue chip; "Plan the migration (needs
   guidance)" shows Loom's pill and stays in the inbox; a root with
   unsettled children reads Waiting; the thread menu's Goal submenu opens by
   mouse and by keyboard (Shift+F10) with its first item selected.
3. **Palette and search** (cockpit copy): an archived hit and a child-report
   hit; an archived root opens from search with one loading state.
4. **Chat.** A file chip, a thread mention, one `ABC-123`-style reference
   link on a project with `.t3code/links.json`, a bare path link; Reply on an
   assistant message sends; the context ring, its spend popover and Compact.
5. **Children.** A Loom child clicked in Thread details opens as a
   right-panel tab with a composer; ⌘-click navigates; a child's blocking
   question shows in the root's banner only.
6. **Right panel.** A layout saved by the current cockpit build (v16) loads:
   closed stays closed, Workstream, Context and Goal tasks tabs present.
7. **Files.** With an HTML artefact, an image and a PDF open, run an agent
   command: the HTML page keeps its scroll, the image and PDF do not reload.
   An MDX plan with annotations and the review count. A document with an
   `<Image>` block in the document viewer of a production build.
8. **Diff.** The change-review scope entries, author chips and the author
   card on a line selection; Cmd+F; changed words solid; **the inline-editing
   journey** (B.10's seven steps: click places the caret without moving the
   view; three typed characters, Enter and Escape do not jump; a comment
   below stays on its text; Edit opens at the same line; Cmd+F while typing).
9. **Pi.** A turn resumes after a restart with a stashed steer; killing pi
   mid-tool gives exactly one resume; a stopped run offers no Resume;
   `/clear`; a title generates through the hub and Settings' text-generation
   picker lists the `cliproxy/*` models; Usage → Limits lists the hub's
   accounts.
10. **Settlement.** A finished Loom root with an open PR stays active and
    one without settles; a child under a settled root settles on the next
    sweep.
11. **Visibility.** Tool calls at Hide all and at Zen: consult cards,
    questions and Loom's control cards still show.
12. **Title.** Regenerate a Loom root's title by the new shortcut and record
    what happens (§8.3).
13. **Mobile** cannot be run by an agent on this host (no iOS, no Android
    emulator); it rests on typecheck, `lint:mobile`, the unit tests and
    Carl's phone after the APK deploy, as in pull 15.
