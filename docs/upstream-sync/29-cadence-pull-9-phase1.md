---
manager_sessions:
  - id: 83266288-08b6-4ca2-a984-c8e3068f1584
    name: Pull 9 Phase 1 runbook — mechanical merge of upstream/main 1a3f7ad508, upstream wins on structure
    role: plan
    authored_at: 2026-10-05T13:43:51.139Z
---

# 29 — Cadence pull 9, Phase 1 (`024d49520e` → `upstream/main` `1a3f7ad508`): the mechanical merge, upstream wins on structure

**Status: PLAN — gated by a reviewer against `plans/upstream-pull9-strategy/plan.mdx` before any coder starts.**
This is the runbook for **Phase 1 only** of the strategy Carl signed
(`plans/upstream-pull9-strategy/plan.mdx`, revision 3): take `upstream/main`
as the base, let upstream win on structure, remove Loom's V1-welded surfaces
from the build, and record where every one of them went. Phases 2–4 (the
sidecar contract, the decider arm, the MCP toolkit, the control plane, the
driver economics, the web re-hang, the data import, the Phase 4 deletions, the
cut-over, deploying) are **out of scope** and §12 says so again. Phase 1
changes the behaviour of nothing upstream shipped.

> **Read this first.** Phase 1 is a merge (151 both-modified files, 2 add/add,
> 466 markers — pull-7 shaped) **plus a structural operation that no merge
> resolves** (95 modify/delete, 86 directory-rename relocations, ~121 files
> with dangling imports, 92 vanished contract names). The structural half is
> mechanical but large; it gets its own session (§8). The one rule that
> decides every structural row: _Phase 1 ports nothing._ A Loom module that
> no longer compiles under V2 is moved out of the build whole (quarantine) or
> deleted with upstream's deletion; an upstream-shared file loses the Loom
> hunk that reads a removed name, behind a `// loom:` marker; every such act
> is a ledger row (§5.3, Appendix C) naming the phase that re-hangs it. Never
> a stub, never a component that lies about state.

Doctrine that governs every hunk: `docs/upstream-sync/05-strategy.md` §4.3 —
_Carl decides functionality; where upstream now expresses the same
functionality, upstream's mechanism is the baseline and Loom's variant is
deleted, however much work it represented._ Pull 8's rulings
(`recaps/pull8-decisions/recap.mdx`, DL-72–DL-79) carry forward. Doc 27 is
the previous runbook; this document follows its shape, and the decision log
continues its numbering from **DL-80**.

---

## 0. Headline: what Phase 1 delivers, in numbers

| item                                                                   | value                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ours                                                                   | this branch's tip at merge time (`pre_merge_oid`, recorded in §8 S0); the planning measurement was taken at `f1b4cf81a9`                                                                                                                                                |
| theirs                                                                 | `upstream/main` = `1a3f7ad508` ("perf(prs): share concurrent github routing metadata probes (#15853)", 2026-10-05)                                                                                                                                                      |
| merge-base                                                             | `024d49520e` (= `de34391427^`, pull 8's target; unchanged since doc 04)                                                                                                                                                                                                 |
| upstream commits past the base                                         | **165** (155 at the trial of doc 04 + 10)                                                                                                                                                                                                                               |
| conflicted paths (re-measured here, §3)                                | **334**: 151 UU · 95 UD · 86 AU · 2 AA (doc 04: 336 — the two `UU` that vanished are `apps/web/src/components/ui/command.tsx` and `packages/client-runtime/src/operations/projects.ts`, both settled by pull 8's review reversals)                                      |
| conflict markers                                                       | **466** (doc 04: 468); 74 files carry a single marker                                                                                                                                                                                                                   |
| both-modified files auto-merged silently                               | **116** (doc 04: 117); **8** lost an exported name from our side — the same 8 (§7)                                                                                                                                                                                      |
| files with a dangling relative import after the merge                  | **121** (51 modify/delete leftovers · 43 relocated Loom files · 18 Loom-only files elsewhere · 7 both-modified · 1 upstream-renamed test · `PiDriver.ts`); doc 04's "about 125" minus the `?raw`/`?url` false positives and `verifyBranchScoping.ts` (deleted by DL-76) |
| contract names exported by our `orchestration.ts` and nowhere upstream | **92** (unchanged)                                                                                                                                                                                                                                                      |
| Loom code that leaves the build in Phase 1                             | ≈ 57,000 lines: 35,040 quarantined engine lines, 21,870 Loom lines in files upstream deleted, plus `PiDriver.ts` (2,959) and `orchestration.loom.ts` (1,795)                                                                                                            |
| `config.ts`                                                            | auto-merged to `dbPath = <stateDir>/statev2.sqlite` — **accepted**; never boot this branch against a live home (§11)                                                                                                                                                    |

**What Phase 1 leaves behind.** A branch where `vp run typecheck` and
`vp check` are green with the quarantine excluded; the merge commit's second
parent is `1a3f7ad508`; upstream's V2 engine and Pi V2 adapter run Loom's
non-orchestration surfaces (migrations lane, usage meter, composer references,
keybindings, MDX renderer, thread tabs, Pi-first settings, dev-runner and ship
breadcrumbs); every Loom orchestration surface is either in
`quarantine/` (diffable, never compiled) or named in the detach ledger with the
phase that re-hangs it; and a boot smoke on a copy of the live database has
created `statev2.sqlite`, completed one Pi turn through upstream's adapter,
and resumed it after a restart.

---

## 1. Topology and invariants

- Branch: cut fresh from the branch that carries the signed strategy and this
  document (the planner's branch, which the orchestrator merges or rebases
  onto `origin/main` first — `origin/main` is `8368a63b16` + #325 + #326; if
  it has moved further, S0 re-measures the overlap of the new commits with
  Appendix B before cutting).
- The merge: `git -c rerere.enabled=false -c merge.renameLimit=30000 merge
--no-ff --no-commit upstream/main` after `git fetch upstream main`, with
  `upstream/main` verified to be `1a3f7ad508` (if upstream moved, stop and
  re-run `docs/upstream-sync/pull9-tools/remeasure.sh` first — the strategy
  pins this tip and the hunk inventory was written against it). **The
  `renameLimit` is mandatory**: without it git does not detect the
  `orchestration/` → `orchestration-v2/` directory rename, the 86 Loom files
  are left in place as plain additions instead of AU relocations, and
  Appendix B stops matching the index.
- **`rerere.enabled=false` on every merge invocation**, dry run or real. The
  shared `rr-cache` holds unresolved preimages from the trials; a replay is
  undetectable afterwards (doc 27 §1). Do not change clone-wide config, do not
  `git rerere clear`. After the merge, `git rerere status` must print nothing;
  if a merge was ever run without the flag, every file it touched is unaudited.
- **Every commit on the branch uses `--no-verify`.** The pre-commit hook
  (`vp staged --no-stash`) deletes `MERGE_HEAD` and single-parents the merge.
- Record `pre_merge_oid=$(git rev-parse HEAD)` before the merge and
  `merge_oid=$(git rev-parse HEAD)` right after the merge commit. The topology
  check is always `git rev-parse ${merge_oid}^1 ${merge_oid}^2` ==
  `${pre_merge_oid} 1a3f7ad508`; `HEAD^2` on a later repair commit is
  meaningless.
- No rebase, no squash, no amend, ever, on the sync branch.
- **Never `git stash`** (one global stash across every worktree). Bank with
  the recovery bundle instead: copy `$(git rev-parse --git-dir)/{index,MERGE_HEAD,HEAD}`
  to `.artifacts/pull9-merge-state-backup/` whenever a session ends with the
  merge uncommitted (restoring those files reconstitutes all three stages).
- `pnpm-lock.yaml` is taken from upstream (`git checkout --theirs
pnpm-lock.yaml`) and regenerated by `vp i`; never hand-merged.
- `apps/server/src/persistence/Migrations.ts` ends **byte-identical to
  upstream's** (doc 22's one-word `export` exception included only if
  `LoomMigrations.test.ts` still needs it — §6 PR-6).
- Every retained Loom hunk in an upstream-shared file carries a `// loom:`
  marker; `unmarkedsweep.sh` enforces it at ship time and `--report` audits
  it in S4.
- Work in **one shared worktree, sequentially**. The in-progress merge state
  persists on disk between sessions; the bundle above is the backup.
- Before any install, typecheck, build or test: `cat "$(git rev-parse
--git-dir)/t3code-setup-state.json"` must say `ready`.
- The `quarantine/` directory (§5.1) is never compiled, linted, formatted or
  tested; S4 proves it (§9).

---

## 2. Departures from the pull-8 runbook

| #   | departure                                                                                                                                                                                  | why                                                                                                                                                                                                                                                                       | cost if wrong                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| D-A | **A structural session (S1) precedes the textual resolution and is banked uncommitted**; the merge is committed at the end of S2. Pull 8 resolved and committed in one session.            | 181 structural paths plus ~70 detach-seed files are mechanical but large; mixing them with 466 textual markers in one context window is how hunks get dropped silently. The merge state lives in the shared worktree between sessions; the recovery bundle is the backup. | One more session; a banked merge that a stray `git merge --abort` could lose — the bundle restores it.      |
| D-B | **No mechanical auto-resolver** (`autoresolve.mjs`/`protected.mjs` unused), as in pull 8. `sideresolve.py theirs` is allowed on whole files only where §5/§6 pre-rule "upstream verbatim". | Pull 7's silent drops; pull 8's three "clean region is wrong" surprises.                                                                                                                                                                                                  | Slower.                                                                                                     |
| D-C | **Quarantine instead of deletion** for every Loom file that no longer compiles and has a phase-2/3 future (§5.1). Pull 8 deleted orphans.                                                  | The strategy says "undone, not owned … diffable during the port, deleted in phase 4".                                                                                                                                                                                     | Repo carries ~40k dead lines for the life of the integration branch; one `git rm -r quarantine` in phase 4. |
| D-D | **Lint conformance is not a separate stacked PR.** Loom's fork-only web files were brought to 0 `shadcn/*` errors in pull 8 S4; most of them are detached here.                            | Nothing new to conform. If S4 finds residual findings in surviving files they are fixed in S4.                                                                                                                                                                            | None to doctrine.                                                                                           |
| D-E | **The gate includes a V2 boot smoke on a copy of the live database** (§9, §8 S4), as the strategy's Phase 1 gate requires; pull 8's migration smoke only loaded the sidebar.               | `config.ts` switched the database file; `initializeV2Database` copies once; a Pi turn through upstream's adapter is the only proof the registry/adapter swap worked.                                                                                                      | A session of its own if it fails — which is the point.                                                      |
| D-F | **Two sanctioned exceptions to "Phase 1 ports nothing"**: the foreign-home guard's boot detection and provider-launch refusal (DL-81, §5.4), and nothing else.                             | The guard is the safety property of the very smoke D-E runs; its V1 seams are deleted.                                                                                                                                                                                    | One marked hunk in V2's session-open path that future pulls conflict on.                                    |
| D-G | **Two new tiny tools** in `docs/upstream-sync/pull9-tools/` (`classify.py`, `automerged.py`, `dangling.py`, `zones.py`, `remeasure.sh`) beside the pull-7 set.                             | The structural half has no markers; the pull-7 tools only see markers.                                                                                                                                                                                                    | None.                                                                                                       |

Everything else in doc 27 §1–§2, doc 25's "Method", "Standing reviewer
checklist", "Standing drops", "Lint and knip" sections carries forward.

---

## 3. Re-measured surface, by zone

Measured on this branch at `f1b4cf81a9` against `upstream/main` `1a3f7ad508`
with `docs/upstream-sync/pull9-tools/remeasure.sh` (Appendix A). Raw captures
are in `.artifacts/pull9-remeasure/` (gitignored; S0 regenerates them). The
exact file-to-zone partition is Appendix B (generated by `zones.py`, one zone
per path, sums to 334).

| zone                             |       n | markers | `loom:` lines | character                                                                                                                                                                                                                   |
| -------------------------------- | ------: | ------: | ------------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q — quarantine (relocated)**   |      86 |       0 |            43 | Loom's V1-engine files git staged under `orchestration-v2/`; moved out whole (§5.1)                                                                                                                                         |
| **D — upstream's deletion wins** |      95 |       0 |           429 | V1 engine, V1 adapters, V1 projections, V1 contracts, `threadReducer`, queued-message web files, V1 tests; Loom's hunks in them are the ledger's first 95 rows (Appendix C)                                                 |
| **AA — add/add**                 |       2 |      10 |            17 | `PiDriver.ts` (Loom's 2,959 → quarantine; upstream's 195 wins) and `textGeneration/PiTextGeneration.ts` (upstream's wins; Loom's → quarantine)                                                                              |
| T-lock/config                    |       7 |      29 |            11 | lockfile (21), three `package.json`, dev-runner test, relay script                                                                                                                                                          |
| T-contracts                      |       9 |      20 |            53 | `index.ts` barrel, `rpc.ts`, `settings.ts` (duplicate `PiSettings`, §7), `model.ts`, `providerRuntime.ts`, `server.ts`, composer context, keybindings                                                                       |
| T-shared                         |       5 |       5 |            12 | composer references/tokens, `serverSettings.ts`, `threadSettled.ts` (Loom-side rename), `toolActivity.ts`                                                                                                                   |
| T-client-runtime                 |      21 |      66 |            31 | `state/*` where V2 shapes win: shell, shellReducer, threadCommands, threadDetail, commands, server, driver, and their tests                                                                                                 |
| T-server-core                    |      10 |      55 |            94 | `ws.ts` (24), `serverRuntimeStartup.ts` (8), `server.ts` (5), `bin.ts`, `cli/*`, `RpcAuthorization.ts`                                                                                                                      |
| T-server-persistence             |       5 |      12 |             8 | `Sqlite.ts`, `Migrations.ts`, event store + receipts                                                                                                                                                                        |
| T-server-provider/mcp            |      13 |      24 |            24 | `builtInDrivers.ts`, `McpInvocationContext.ts`, provider tests and ACP files                                                                                                                                                |
| T-server-other                   |      20 |      50 |            67 | checkpointing, git, vcs, terminal, textGeneration, usage, project setup, relay                                                                                                                                              |
| T-web-chat                       |      18 |      85 |           255 | `ChatView.tsx` (20), `composerDraftStore.ts` (14), `ChatComposer.tsx` (9), `MessagesTimeline*` (12), pending-input panel, pickers                                                                                           |
| T-web-sidebar                    |      11 |      40 |            69 | `Sidebar.tsx` (11), `Sidebar.logic*` (13), notification coordinator, route view, palette                                                                                                                                    |
| T-web-panels/other               |      20 |      53 |           103 | `DiffPanel.tsx` (22), `RightPanelTabs.tsx` (5), `diffPanelStore`, `index.css`, settings panels, stores                                                                                                                      |
| T-mobile                         |      12 |      17 |            21 | fixture defaults, search ranking, pending-input card                                                                                                                                                                        |
| **total conflicted**             | **334** | **466** |     **1,237** |                                                                                                                                                                                                                             |
| X — detach seed (not conflicted) |      71 |       — |             — | Loom-only files (Q) and upstream-shared files (H) the merge leaves importing a deleted module, a removed contract name, or reading a Loom thread/shell field; typecheck in S3 is the authority, this list is the head start |

**Delta from doc 04.** Two fewer UU (above), one fewer auto-merged
(`autocomplete.tsx` and `operations/projects.test.ts` left the set,
`pullRequestList.logic.ts` from `7ffa2184a7` joined it), markers 468 → 466
(`ProjectSetupScriptRunner.ts` 4 → 2 after DL-73, `apps/web/package.json`
1 → 2, lockfile 20 → 21). The structural counts (95/86/2) are identical. The
ten new upstream commits (§4) add no conflicted path; two of them
(`06e627448b`, `37de6cbde6`) touch files the strategy's hunk inventory names,
which is why the inventory is re-read, not assumed, when phase 2 starts.

---

## 4. Upstream change digest — the ten commits since the trial, and what matters

`a1d9d72aef..1a3f7ad508`, newest first. None conflicts; all auto-merge.

- `1a3f7ad508` perf(prs): shared GitHub routing probes — `apps/server/src/pullRequest/*`; clean.
- `7ffa2184a7` fix(prs): queued fast actions, drag-to-close batches — `apps/web/src/components/pullRequest/pullRequestList.logic.ts` is a new auto-merged both-modified file (Loom touched it in #325); **review by eye** in S3 (§7).
- `7812230572` fix(server): subagents no longer inherit parent PR links — `orchestration-v2/`; the strategy cites it (Area A: why Loom fields never go on `AppThread`). No Phase 1 action.
- `cf3e714b0f` fix(server): Stop ends a Codex command after settle — Codex adapter; n/a (Pi-only registry).
- `250e052f44` fix(mobile): Uniwind upgrade, local patch removed — `pnpm-workspace.yaml` `patchedDependencies` loses a mobile patch; take upstream's workspace file and re-add only Loom's `@earendil-works/pi-coding-agent@0.99.2` patch line (PR-16 below).
- `2a778f7a6e` feat(web): shell commands syntax-highlighted in the timeline — `MessagesTimeline*`; lands beside Loom's consult/handoff hunks (PR-10).
- `c408737628` fix(desktop): V2 imports stashed prompts and drafts from the V1 profile — desktop only; clean.
- `06e627448b` feat(server): T3 MCP tools take explicit thread and project targets — reshapes `mcp/McpSessionRegistry.ts`, `McpInvocationContext.ts`, `threadAccess.ts`. `McpInvocationContext.ts` is the one `mcp/` conflict (PR-13). The strategy's Area B hunks are phase 3a; **Phase 1 adds no `workstream` capability** (PR-13).
- `37de6cbde6` refactor(server): one keyed lock that releases idle keys — `orchestration-v2/` + `threadDispatch`; the strategy's concurrency-model row cites the keyed executor. No Phase 1 action.
- `1beb0355d0` fix(server): queue background notifications during active tools — `message.dispatch` notification handling; relevant to the phase-2 `start_if_idle` hunk, not to Phase 1.

The 155 earlier commits are digested in doc 04 ("The 155 commits, grouped").
What Phase 1 takes from them wholesale: V2 (`de34391427`) and its 32
orchestration follow-ups; the Pi V2 adapter and `PiProvider`/`PiCommands`; the
sidebar settle/wake sweep; mobile 2.0; the usage rework; the shared MCP tool
presentation; vite-plus/lint catch-up.

---

## 5. Structural zones — doctrine, mechanics, ledger

### 5.1 Quarantine: `quarantine/` at the repository root

**Location.** `quarantine/<original repo path>`, e.g.
`quarantine/apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts`,
`quarantine/apps/server/src/provider/Drivers/PiDriver.ts`,
`quarantine/packages/contracts/src/orchestration.loom.ts`,
`quarantine/apps/web/src/components/WorkstreamPanel.tsx`. The path under
`quarantine/` is the pull-8-side path (for the 86 relocations that is the
`orchestration/` path, **not** the `orchestration-v2/` path git staged), so
"where did X go" is a prefix, `git log --follow` works, and the phase-2/3
port diffs `quarantine/<old>` against `apps/server/src/loom/<new>` with
`git diff --no-index`. One directory for every package (server, contracts,
shared, web, client-runtime, mobile): one exclusion mechanism to prove.

**Why root-level and not under `apps/server/src/`.** Every package typechecks
with its own `tsc --noEmit` over an explicit `include` list
(`apps/server/tsconfig.json`: `src`, `vite.config.ts`, `scripts`,
`integration`, `../../scripts/lib`; `packages/contracts`: `src`; `apps/web`:
`src`, `vite`, `test`, …). A directory outside every package needs **no
tsconfig edit at all** — a directory under `src/` would need an `exclude`
hunk in an upstream-owned JSON file per package. There is no root
`tsconfig.json`. `pnpm-workspace.yaml` packages are `apps/*`, `infra/*`,
`packages/*`, `scripts`, `oxlint-plugin-t3code`; `quarantine/` is not a
workspace package and has no `package.json`.

**Exclusion mechanics — three list entries, all in the root
`vite.config.ts` (upstream-owned; each entry is one marked line):**

| tool                                                                                                                                                                                                    | config                | entry to add                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| `vp test` / `vp run -r test` (vitest; packages run `vp test run --config ../../vite.config.ts --dir .` or in their own dir — a root-level `vp test` would otherwise discover `quarantine/**/*.test.ts`) | `test.exclude`        | `"**/quarantine/**", // loom: pull-9 quarantine, never tested` |
| `vp lint` / `vp check` (oxlint with the `eslint`/`oxc`/`react`/`unicorn`/`typescript` plugins, `oxlint-plugin-t3code` and `@shadcn/lint`; `lint.options.typeCheck` is `false`)                          | `lint.ignorePatterns` | `"quarantine/**", // loom: pull-9 quarantine, never linted`    |
| `vp fmt` / `vp check`                                                                                                                                                                                   | `fmt.ignorePatterns`  | `"quarantine/**", // loom: pull-9 quarantine, never formatted` |

Nothing else sees it: `tsc` (no `include`), `knip` (its `workspaces` map
names only the real workspaces; the root project glob is top-level files),
`unmarkedsweep.sh` (paths absent at the upstream base are exempt
automatically; the gate scope compares against `merge-base origin/main HEAD`
where `quarantine/` does not exist), `lostdecls.py` (`--diff-filter=M`; the
quarantine paths are additions), `pnpm ship` (runs `vp check`, `vp run
typecheck`, `unmarkedsweep.sh`). `parsesweep.mjs` walks `git ls-files '*.ts'
'*.tsx'` and **will** parse the quarantine — harmless (whole Loom files
parse) and a free sanity check that nothing was truncated by a move.

**Proof in S4 (§9):** `rg -l . quarantine | wc -l` > 0; `vp run typecheck`
green; `vp check` green; `vp test run --config vite.config.ts quarantine`
reports no test files; `grep -rn quarantine $(git ls-files 'tsconfig*.json'
'*/tsconfig*.json')` is empty (no tsconfig names it); the three
`vite.config.ts` entries are present and marked.

**Move recipe (S1).** An AU path is an unmerged index entry and `git mv`
refuses it ("fatal: conflicted"); resolve it as ours first, then move:

```sh
# relocated Loom file (AU): git staged it at orchestration-v2/<p>; it goes to quarantine under its ORIGINAL path
p=Layers/WorkstreamDispatcher.ts
git add  "apps/server/src/orchestration-v2/$p"            # resolves the AU entry as ours
mkdir -p "quarantine/apps/server/src/orchestration/$(dirname "$p")"
git mv   "apps/server/src/orchestration-v2/$p" "quarantine/apps/server/src/orchestration/$p"

# add/add (PiDriver.ts): keep ours in quarantine, take upstream's at the path
git add apps/server/src/provider/Drivers/PiDriver.ts
mkdir -p quarantine/apps/server/src/provider/Drivers
git mv apps/server/src/provider/Drivers/PiDriver.ts quarantine/apps/server/src/provider/Drivers/PiDriver.ts
git checkout upstream/main -- apps/server/src/provider/Drivers/PiDriver.ts

# Loom-only file that no longer compiles (detach seed Q rows, §5.3): plain move
mkdir -p quarantine/packages/contracts/src
git mv packages/contracts/src/orchestration.loom.ts quarantine/packages/contracts/src/orchestration.loom.ts
```

Verified on this tree during the re-measurement (the `git add` then `git mv`
sequence works on an AU entry; `git mv` alone does not).

**What goes to quarantine in Phase 1** (the full list is Appendix B's Q rows
plus Appendix B's X-detach Q rows as confirmed by S3 typecheck):

1. The **86 relocated files** — all of them, including the four
   `*.loom.ts` siblings that go with the engine (`decider.loom.ts`,
   `projector.loom.ts`, `commandInvariants.loom.ts`, `goalTaskAnchor.loom.ts`)
   and the thread-search stack (`Layers/ThreadEmbedder.loom.ts`,
   `Layers/ThreadSearch.loom.ts`, `Layers/embedding/*.loom.ts`) — **ruled
   quarantine, not "keep compiling"** (DL-82): they depend only on sqlite and
   settings and _would_ compile, but their data seam is the V1 projection
   tables (`projection_threads`, `projection_thread_messages`,
   `projection_turns`, `projection_goals` — the FTS triggers of migration
   1045), which are inert copies under V2; a wired search would answer from a
   frozen index that never sees a V2 thread, which is the "silent failure"
   class the strategy designs against. Upstream's own
   `orchestration-v2/ThreadSearch.ts` (lexical, over V2 projections) is the
   baseline in the interim. Migration 1045 stays in the ledger; its triggers
   on dead tables are harmless.
2. Loom's **`apps/server/src/provider/Drivers/PiDriver.ts`** (AA) and the Pi
   support files only it (and quarantined code) use:
   `provider/Drivers/Pi/{askUserBroker,providerToolDefs,providerToolExtension,searchGuardExtension}.ts`
   and tests, `provider/Drivers/PiDriver.*.test.ts`,
   `provider/Drivers/piTurnRetryPolicy.ts` + test,
   `provider/Layers/Pi/{Cli,OneShotCompletion,RpcProcess,SessionIdSanitiser}.ts`
   - tests and `PiCwdOverride.contract.test.ts`, `provider/cacheRetention.loom.ts`
   - test. Exception: `provider/Layers/Pi/RpcProcess.ts` is also imported by
     `diagnostics/ProviderRuntimeIngestionTelemetry.ts` and
     `diagnostics/RuntimePerformanceMonitor.ts` — if those two still compile
     without it (S3 decides) they lose the import behind a marker; otherwise
     they are Loom-only diagnostics and go too. Loom's `textGeneration/PiTextGeneration.ts`
     (AA, imports `OneShotCompletion`) goes; upstream's wins at the path.
3. **`packages/contracts/src/orchestration.loom.ts`** (1,795 lines) — its
   only edge to upstream is `import type { OrchestrationCommand,
OrchestrationEvent } from "./orchestration.ts"`, which is deleted, and
   phase 2 replaces it with `orchestrationV2.loom.ts` on a collapsed plan
   axis, so none of its enums survives as-is. Quarantined, not excluded
   in place: `packages/contracts/tsconfig.json` includes `src` and an
   `exclude` there would be an upstream-file hunk for one file; and every
   consumer of its 79 names (Appendix B X rows) is detached anyway.
   `packages/contracts/src/index.ts` keeps upstream's barrel; the two Loom
   `export *` lines go (PR-2).
4. **Loom-only server modules that import the engine or its contracts** (the
   X-detach Q rows): `loom/{serverLayers,startup,wsMethods,handoffDraft,retroDraft}.ts`
   - tests, `mcp/{WorkstreamSpawnHttp,GoalTaskHttp,GoalHandoffHttp,ThreadForkHttp,UserInputHttp}.ts`
   - tests (and `mcp/workstreamRender.ts`, `mcp/httpScope.ts`, `mcp/toolPaths.ts` if
     they lose every importer), `cli/{goal,orchestrationMutation}.ts`,
     `dev/{seedWorkstream,verifySeed,threadSearchEval.loom}.ts`,
     `persistence/Layers/SqliteLanes.ts` (**split first**: its usage-ledger
     reader and `SqliteRead.ts` read lane survive if `loom/serverLayers.ts`'s
     surviving half still needs them — see §5.4 — the V1 engine/pipeline/
     snapshot-query and embedder wiring go), `project/WorktreeProvisioner.ts` +
     test, `project/worktreeSetupRecord.loom.ts`, `loom/pendingSteering.ts`
     (if orphaned), `workspace/foreignHomeGuard.loom.test.ts` (the test imports
     quarantined `worktreeRemoval.ts`; the guard module itself **stays**, §5.4).
5. **Loom web, shared and client-runtime modules that read Loom thread/shell/
   message fields or removed contract names** (X rows, Q): the workstream
   board/graph/timeline/quick-facts/active-strip, `lib/workstreamPresentation.ts`,
   `lib/workstreamRollup.ts`, `lib/forkJoinLayout.ts`, `loom/{ControlDigestCard,ControlDigestRow,controlMessages,GoalThreadsSection,TaskThreadChips,contextCost,goalThreadChain,handoffReceipts.logic,rootThreads,sidebarGoalActions,useGoalPanelActions,useLoomThreadExtensions}.*`,
   `components/chat/{ForkedFromBadge,StagedBriefPreviewCard,StagedKickoffCard}.tsx`,
   `components/{GoalTasksPanel,WorkstreamTimeline,…}.tsx`, `Sidebar.logic.loom.ts`,
   `threadRouteLineage.ts`, `hooks/useForkThread.ts`, `lib/threadMention.ts`
   (or the one `planLane` label read dropped behind a marker — coder's call
   under the §5.3 rule), `packages/shared/src/{workstreamGraph,workstreamDependencies,workstreamIsolation}.ts`
   - tests (pure libs the strategy keeps "with logic intact" — they move back
     untouched in phase 2 once the sidecar types exist),
     `packages/client-runtime/src/state/threadFixtureDefaults.ts`, and whatever
     else S3's typecheck adds. Each one is a ledger row (phase 3d for web, 2 for
     shared libs).

**What does not go to quarantine.** Anything that compiles under V2 and is
not an orchestration surface stays in place even if its importers vanished
(an orphan is a ledger row of kind _orphaned_, not a move) — the live tree
removes only what the build forces out. Marked Loom hunks in upstream-shared
files that still compile stay too (e.g. `GitWorkflowService.ts`'s fan-in
primitives, `GitVcsDriverCore.ts`'s merge arm, `checkpointing/*` baseline
refs with their fallback) — phase 3b/4 decides their fate with the isolation
question; carrying ~300 marked dead lines is cheaper and safer than judging
each one here.

### 5.2 Upstream's deletion wins: the 95 modify/delete files

`git rm` every UD path. **Nothing from a UD file is restored to keep an import
compiling** (doc 27 PR-17 stands). Loom's hunks in them are not lost silently:
Appendix C's first block lists, per file group, what functionality Loom had
there and which phase re-expresses it, derived from doc 02's inventory. The
`git show <pre_merge_oid>:<path>` of any of them is the port's source.

### 5.3 Detach: the rule, the seed list, the ledger

**Rule.** After the structural moves, S3 runs `vp i` and `vp run typecheck`.
Every error traces to one of: (a) a Loom-only module importing a deleted
module or removed name or reading a removed field → **quarantine the module
whole** (never patch it to compile against V2 — that is phase 2/3 work);
(b) an upstream-shared file whose Loom hunk does the same → **drop the hunk
behind a `// loom:` marker** that names the ledger row (`// loom: detached
in pull 9, ledger DT-nn`), taking the smallest honest cut: the import and
the render/call site go together; a component that would be left rendering
a Loom panel with nothing to read is removed from the render tree, not
stubbed; (c) a genuine merge defect → fix it and log a DL row. The _only_
permitted "renders nothing" is an upstream-shared component whose Loom
branch becomes unreachable because the data it keyed on no longer exists
(e.g. an optional-chained Loom field) — and even then prefer deleting the
branch.

**Seed list.** Appendix B's X-detach rows (71 files: 62 Q, 9 H) were found
by three static passes (dangling relative imports; imports of the 92 removed
contract names or of `orchestration.loom.ts`'s 79 names; reads of a
distinctive Loom thread/shell/message field — `.planLane`, `.attention`,
`.blockedBy`, `.spawnGeneration`, `.reportPath`, `.goalId`, `.anchorTaskId`,
`.kickoffBriefPath`, `.fanInState`, `.gateRounds`, `.cumulativeCostUsd`,
`.pendingUserInputHeader`, `.controlPayload`, …). It is a head start, not the
authority; `parentThreadId` in particular also exists on V2's lineage, so
`client-runtime/src/state/threadRelationships.ts` may well compile.

**Ledger format and location.** The detach ledger is **Appendix C of this
document** (one file, so the reviewer and Carl scan one place), with rows
`DT-nn` in this shape:

| id  | path | what it rendered or served | V1 names/fields it depended on | how detached | re-hang phase |
| --- | ---- | -------------------------- | ------------------------------ | ------------ | ------------- |

`how detached` ∈ `quarantined` · `deleted with upstream` · `import dropped`
· `hunk dropped` · `renders nothing` · `orphaned (compiles, no importer)`.
`re-hang phase` ∈ `2` (substrate/contract/persistence) · `3a` (tools) ·
`3b` (control plane) · `3c` (driver economics) · `3d` (web/mobile) · `4`
(delete) · `isolation-option` (only if Carl carries isolation). S1 writes the
rows for the moves it makes; S3 completes the table as typecheck drives it;
§9 requires every dangling import and every quarantined path to have a row.

### 5.4 Non-orchestration surfaces that survive — and the ones Phase 1 must detach anyway

**Survive on upstream's mechanism (the pull-8 rulings and the strategy's
verdicts), re-verified in S3/S4:**

- Migrations lane split: `LoomMigrations.ts` 1001+ untouched; `Migrations.ts`
  byte-identical (PR-6); `Sqlite.ts` with `runAllMigrations` beside
  upstream's `initializeV2Database` (PR-5).
- `PiSettings`: upstream's block with Loom's two marked hunks (`enabled`
  default `true`; the bundled-pi `binaryPath` description) — §7 (DL-84).
- Pi-only driver registry (`builtInDrivers.ts`, PR-12); upstream's
  `PiDriver.ts` registers `PiAdapterV2` + `PiProvider`; the global `pi` on
  `PATH` (0.99.2 on this host) is what it resolves (DL-83).
- `PI_DEFAULT_MODEL` block in `model.ts` and the Pi-first auto-bootstrap
  selection in `serverRuntimeStartup.ts` (PR-1 carried, DL-85); the phase-2
  "Pi default" sentinel check is recorded, not pre-empted.
- Ship script, dev-runner, setup-script runner with the DL-73 breadcrumb
  hunks (`ProjectSetupScriptRunner.ts` + `.loom.ts`, PR-8).
- Session reaper: V1's reaper and DL-74's prune are deleted upstream (UD);
  nothing to carry in Phase 1 — the strategy's phase-2 check ("does V2 ever
  remove a deleted thread's binding") is the follow-up (Appendix C row).
- Workstream web surfaces on upstream's theme tokens (DL-79): the tokens
  survive by construction (Loom's `@theme` block is gone); the surfaces
  themselves are detached (below).
- Sidebar v2 chrome: upstream's wholesale; Loom's attachments that read Loom
  fields are detached (below), the archived-search toggle and subscription
  meter stay.
- MDX plan/recap renderer (`components/files/mdx-plan/`, 46 files): untouched;
  S3 confirms it references no removed name (the static pass found none).
- Composer context references (`#thread`), inline tokens, `ContextChip`
  chips, `threadReferences` on drafts (`composerDraftStore.ts`,
  `ChatComposer.tsx`, `packages/shared/src/composer*`, `contracts/composerContext.ts`) — PR-9.
- Keybindings unions (PR-3); settings hunks (`settings.loom.ts`, `serverSettings.ts` presets).
- Thread tabs strip, `SubscriptionMeter` (reads upstream's usage limits),
  `UsageLimitSources.ts` cliproxy accounts hunk, `providerExhaustionOverlay`
  on the providers snapshot, `ProviderHealthRegistry` and
  `SubscriptionUsagePoller` (provider-layer, non-engine) — survive **if**
  `loom/serverLayers.ts` is split rather than quarantined whole: its
  `LoomProviderRuntimeLive` (poller + health registry) and `LoomProviderHealthLive`
  halves have no engine dependency and keep their `server.ts` splice lines;
  `LoomReactorsLive`, `LoomRuntimeCoreLive` (provisioner), `LoomMcpHttpLive`,
  the worktree lock/lease layers and the embedder go. The coder splits the file
  in place (a Loom-only file, no marker needed), logs the row.
- `cli/config.ts` worktree-home rule, `cli/server.ts` `claimServerHome`,
  `workspace/serverHomeGuard.loom.ts`, `remoteEditorSshHost`,
  `loadProjectReferenceLinks` (`ws.ts` H18/H19), terminal process
  registration, `GitManager` PR-epoch cache, `VcsStatusBroadcaster` per-repo
  poller, `GitVcsDriver --no-verify` doc — all non-orchestration `ws.ts`/
  server hunks: keep, marked (PR-14).
- **Foreign-home guard — re-seamed (DL-81, the one sanctioned port).**
  `workspace/foreignHomeGuard.loom.ts` stays; its call sites in
  `GitVcsDriverCore.ts`, `CheckpointStore.ts` and `ProjectSetupScriptRunner.ts`
  survive as marked hunks; the boot-time detection (today a Loom hunk in
  `serverRuntimeStartup.ts` reading `getReferencedWorktreePaths` from the
  deleted snapshot query) is re-expressed as a Loom-only query over the
  copied `projection_threads.worktree_path` **and**
  `orchestration_v2_projection_threads` (whatever upstream names the column —
  S3 reads the migration), called from one marked line in
  `serverRuntimeStartup.ts`; and the lost `ProviderService` refusal becomes
  one marked refusal hunk where V2 opens provider sessions
  (`ProviderSessionManager`, folded into the hunk inventory's existing
  "ProviderSessionManager (open session)" row). If the refusal needs more
  than one choke point under V2, **stop and escalate** (the consult's
  stated boundary) rather than spread hunks.

**Non-orchestration surfaces Phase 1 has to detach because they are welded
to V1 — the list to escalate if any of it surprises Carl:**

1. **Thread search (semantic + embeddings + archived hits)** — welded to V1
   _tables_ (above). Upstream's lexical V2 search answers meanwhile; web/
   mobile ranking code that compiles against upstream's `threadSearch.ts`
   contract stays and simply never sees an archived hit; `ThreadSearchSettings.loom.tsx`
   goes. Re-seam: phase 2 (index on `orchestration_v2_projection_*` +
   `loom_goals`), phase 3d (surfaces). [DL-82]
2. **Per-thread cost / usage ledger views** — `projection_usage_ledger` has
   no writer once `ProviderRuntimeIngestion` is deleted (its V2 writer is
   phase 3c's `costUsd` hunk); the reader (`SqliteLanes` half, `state/server.ts`
   top-spend RPC, web `TopThreadSpend`, `threadSpend`, cost chips via
   `contextCost.ts`, the Usage page Cost tab) would show frozen numbers.
   Detached; phase 3c. The **sidebar usage meter is not in this list** — it
   reads upstream's usage limits and survives.
3. **`/handoff` and `/retro` composer intercepts** (fork drafters:
   `ws.ts` H21, `loom/{handoffDraft,retroDraft}.ts`, `HandoffDrafterReactor`,
   web `composerIntercepts.ts`, handoff receipt rows/toasts) — dispatch V1
   `thread.create` with `forkFromThreadId`; phase 3b/F (V2 `thread.fork`).
4. **Diff panel "By coder" scope** — reads children's `parentThreadId`/
   `planLane`/diff counts (`DiffPanel.tsx` H4–H11, H20; `diffPanelStore.ts`);
   Carl's one orchestration review affordance (pull 7 "keep and repair").
   Dropped behind markers; phase 3d.
5. **Pending-question header/age** on the sidebar, mobile list card and
   notification title (`pendingUserInputHeader/Since`,
   `loom/pendingUserInput.tsx`, mobile `thread-list-v2-items.tsx`,
   `ThreadNotificationCoordinator.tsx` H1) — derived from V2's
   `pendingRuntimeRequest` in phase 2/3d (Area I).
6. **`ask_user_question` panel additions** ("reply in chat instead",
   markdown body with file chips, digit select — `ChatView.tsx` H13,
   `ComposerPendingUserInputPanel.tsx` 22 markers) — they hang off V1
   user-input shapes; V2's `RuntimeRequest` panel is the baseline. Dropped
   where they do not compile; phase 3a/I. The MDX `QuestionForm`/`ReviewChoice`
   answer path is web-only and stays.
7. **Sidebar: attention-outranks-state, root-only inbox filter, sub-thread
   rollup badge, goal menu entries, "Needs Attention" ordering**
   (`Sidebar.tsx` H6/H7/H9/H10/H11, `Sidebar.logic.ts` H3–H7). Under V2 the
   root-only filter is upstream's own `filterSidebarV2VisibleThreads`
   (subagent lineage) — accept; the rest is phase 3d.
8. **Control-plane cards and consult rows** in the timeline
   (`MessagesTimeline*` consult/handoff hunks, `ControlDigestCard`) — read
   `controlPayload`/consult activity fields; phase 3d.
9. **Worktrees maintenance settings panel** (`WorktreesSettings.tsx`,
   `removeWorkstreamWorktree`/`workstreamWorktree*` RPCs in
   `loom/wsMethods.ts`, `state/server.ts` H3) — isolation machinery; ledger
   phase `isolation-option` (phase 4 delete if Carl retires isolation).
10. **`t3 goal …` CLI** and `apps/server/src/dev/seedWorkstream.ts` (so the
    dev-verify recipe's seeding step is unavailable in Phase 1 — the smoke
    uses a database copy instead, §8 S4) — phase 3a/E and 3d.
11. **AgentAwarenessRelay plan-lane/attention metadata** (relay hunks) — V2
    shapes win; phase 3b.
12. **Restart-recovery policy** (`serverRuntimeStartup.ts` H5's 575-line
    block: not-continued set, kickoff re-delivery, stale-session
    reconciliation, user-input settlement scan, stuck-launch repair;
    `loom/startup.ts`) — the strategy's phase 2/3b recovery module; **upstream's
    V2 recovery runs in Phase 1 with `continueThreadsAfterServerUpdate` at
    upstream's default (`false`)**; the Loom settings-default flip is phase 2.
13. **Emergent goal / structured text generation** (`TextGeneration.ts`
    Loom op, Loom's `PiTextGeneration.generateStructured`) — phase 3b/E.
14. **Per-stream event-store catch-up** (`OrchestrationEventStore.ts` H4–H6,
    `ws.ts` H24 fail-loud catch-up, client-runtime `shell.ts` H7 / `threads.ts`
    gap-cap guards) — "same concern twice": V2 has `streamStoredEventsFrom`
    and its own shell sync; upstream's wins unless S3 shows V2's client sync
    lacks the no-data/gap guard (PR-11 asks the coder to check and log).
15. **`packages/shared/src/threadSettled.ts`** (Loom's rename out of
    client-runtime so the V1 decider could share settle rules) — the server
    consumer is deleted; upstream's `client-runtime/src/state/threadSettled.ts`
    location wins and the three importers are repointed (PR-4); phase 2 may
    move it back when `ThreadSettlementService` gets Loom's blockers.
16. **Post-completion relocation / `--cwd` resume and the `PiCwdOverride`
    contract test** — pi patch 0001 is unused by upstream's adapter; the test
    is quarantined with the driver; phase 2 extends the patch to RPC
    `switch_session` (Area L).

---

## 6. Pre-rulings for the textual zones

Format (doc 27 §6): conflict · options · **ruling** · confidence · evidence.
Coders log each outcome and every deviation in §10 under these ids. Where a
file is named in both §5 and here, §5 decides the structural part and the
PR-n the textual residue.

**PR-1 — Pi-first defaults** (`contracts/model.ts` H2 `[PI_DRIVER_KIND]:
PI_DEFAULT_MODEL` vs upstream's `"default"` sentinel; `serverRuntimeStartup.ts`
H1/H3/H4 Pi-first auto-bootstrap vs upstream's codex bootstrap; `model.ts`
H1/H3 ACP registry kind additions). **Ruling: keep Loom's `PI_DEFAULT_MODEL`
in the driver-default map and the Pi-first bootstrap selection, both marked;
union upstream's ACP registry entries.** Medium. Pull 8 PR-1 and DL-72 (only
the project-level stamp was deleted); the strategy defers the "Pi default"
sentinel check to phase 2 and this is the cheapest-to-reverse interim. If
S4's smoke shows upstream's `PiProvider` catalogue refuses Loom's model id
(it lists what `pi` knows), take upstream's `"default"` and log it — the
sentinel reads pi's own `settings.json`, which on this host already names
Carl's model. [DL-85]

**PR-2 — `contracts/index.ts` barrel and `rpc.ts`.** Ours exports
`./orchestration.ts` + `./orchestration.loom.ts` and the V1 ws RPCs (thread
activities, lifecycle, Loom dispatch); upstream exports `orchestrationV2`,
`orchestrationDispatch`, `orchestrationProject`, `applicationEvent`,
`orchestratorMcp`, `threadMetadataMcp`, … and the V2 RPC set. **Ruling:
upstream verbatim for both files; Loom's RPC declarations (`getThreadActivities`,
`getThreadLifecycle`, workstream worktree, thread spend, heartbeat keepalive)
go with `loom/wsMethods.ts` (DT rows, phase 3a/3d). `providerRuntime.ts` H1:
upstream's import of `ProviderApprovalOption` from `./providerPolicy.ts`;
Loom's `RuntimeErrorClass`/`UserInputResolvedOutcome` re-exports go with
`orchestration.loom.ts` (their consumers — `askUserBroker`, `userInputOutcome.ts`
— are detached).** High. Strategy FileTree ("replaces `orchestration.loom.ts`"),
Area B (REST routes retired). `packages/shared/src/userInputOutcome.ts` and
`openRequests.ts`: quarantine if they lose their types; `userInputQuestions.ts`
stays if it compiles (the MDX answer path may use it).

**PR-3 — `keybindings.ts`, `composerContext*.ts`, `server.ts` (contracts),
`settings.ts` H1–H3 markers, `shared/composer*`, `toolActivity.ts`.**
**Ruling: union; where upstream now has the identical line (the three
`settings.ts` marker-only hunks), take upstream's unmarked line.** High. Doc
27 PR-14/PR-18; `settings.ts` body is §7 (DL-84).

**PR-4 — `packages/shared/src/threadSettled.ts`** (Loom-side rename from
`client-runtime/src/state/threadSettled.ts`, content conflict with upstream's
edits to the original). **Ruling: upstream's location and content; delete
the shared copy; repoint `Sidebar.tsx` H1, mobile `ThreadArrangementSheet.tsx`,
`client-runtime/state/threadCommands.ts` H1, `threadSnoozed.test.ts` to
`@t3tools/client-runtime/state/threadSettled` (or wherever upstream's V2
exports `effectiveSnoozed`/`canSnooze`/`threadWokeAt`).** Medium-high. The
rename's reason (a server decider sharing the rules) is deleted; "same concern
twice → upstream's mechanism". §5.4 item 15.

**PR-5 — `persistence/Layers/Sqlite.ts`.** Upstream's `setup` (PRAGMAs incl.
`journal_size_limit`, `runMigrations`) and `layerConfig` (`initializeV2Database(dbPath)`
before `makeSqlitePersistenceLive`). **Ruling: upstream's structure; the
migration call is Loom's `runAllMigrations` (marked); Loom's
`synchronous=NORMAL` and `cache_size` PRAGMAs stay (marked); `initializeV2Database`
runs exactly where upstream put it.** High. Doc 27 PR-6/DL; Area K
(hunk inventory row "runAllMigrations beside initializeV2Database"). Verify in
S4's smoke that the Loom lane runs on `statev2.sqlite` after the copy
(`loom_sql_migrations` max still 1045, in the **new** file).

**PR-6 — `persistence/Migrations.ts`.** Only Loom's `export` on
`migrationEntries` + its comment. **Ruling: byte-identical to upstream
unless `LoomMigrations.test.ts` still imports `migrationEntries` — if it does,
keep the one-word export (doc 22 §3.2) and nothing else; if the test can
read upstream's entries another way, prefer byte-identity.** High.

**PR-7 — `OrchestrationEventStore.ts` (Layers + Services, 8 markers),
`OrchestrationCommandReceipts.ts`.** Loom's per-aggregate replay
(`readStreamFromSequence`), `GoalId` in the receipt aggregate union, V1 event
types. **Ruling: upstream verbatim; DT rows for the catch-up read (phase 2 —
V2's `streamStoredEventsFrom` is the replacement) and the goal aggregate
(gone for good: Area E chose plain tables).** High.

**PR-8 — `project/ProjectSetupScriptRunner.ts` + test (2 + 4 markers).**
DL-73's shape is in place; the residue is upstream's `refuseForeignHomeSideEffect`
import neighbour and the "every run is observed" comment hunk. **Ruling:
union; the breadcrumb, 30-minute timeout, foreign-home refusal and pnpm
rewrite hunks all survive marked; tests follow (DL-73's test layout).**
High. Verify with the worktree-setup smoke (§9).

**PR-9 — Composer: `composerDraftStore.ts` (14), `ChatComposer.tsx` (9),
`ChatView.tsx` H6–H10, `composerContextPresentation.tsx`, `ComposerCommandMenu.tsx`,
`lib/composerContextRecords.ts`, `composer-logic.ts`, `contextPresentationRegistry.ts`.**
Loom's `#thread` references and `$skill` queued expansion beside upstream's
V2 composer (server-side queued messages, `message.dispatch`). **Ruling:
upstream's mechanism for sending and queuing (the queued-message web files
are UD — gone); Loom's `threadReferences` draft field, chip, menu section and
persistence re-attached as marked hunks wherever upstream's new send path
builds the message; `skillNames` at send (DL-26) likewise. If upstream's
V2 send path has no slot for `threadReferences`, do not invent one — drop
the send-side hunk behind a marker, keep the draft/chip side, log a DT row
(phase 3d) and say so in the report.** Medium-high. Doc 27 PR-20 (chips are
Carl's), DL-24/DL-26; strategy Area J ("composer context/inline tokens"
survive).

**PR-10 — Timeline and chat view: `MessagesTimeline.tsx` (7),
`MessagesTimeline.logic.ts` (5), `ChatView.tsx` H1–H5, H11–H20, `ChatHeader.tsx`,
`session-logic.ts`, `types.ts`, `state/entities.ts`.** **Ruling: V2's
`turnItems`/`OrchestrationV2ThreadShell` world wins everywhere a hunk reads
V1 `OrchestrationThread`/`LatestTurn`/`ThreadActivity`/`Session` shapes;
Loom hunks that are pure presentation and read nothing removed stay marked
(the `chat-user-bubble` overflow fix H7, the table-bleed row H5, the
`ReferenceLinksProvider` wrap H1/H15, `remoteEditorSshHost`); Loom hunks that
mount the four fork-only right-panel surfaces (H14), lineage navigation (H16),
handoff receipts (H17), `tasksAvailable` (H19/H20), staged-root gate (H3),
`/handoff`+`/retro` intercepts (H4), the fork chat extensions (H5), the
"only a server thread still on the default title" rule (H11) are dropped
behind markers with DT rows (phase 3d); the consult/handoff rows in the
logic file likewise; `2a778f7a6e`'s shell-command highlighting is taken.**
High on direction, medium on the per-hunk sort — read every hunk; `ChatView.tsx`
H18 (134 vs 204 lines) is the one to do with diff3 and a scratch editor.
`ChatMarkdown.tsx` auto-merged — §7.

**PR-11 — `client-runtime/src/state/*` (shell, shellReducer, threadCommands,
threadDetail, commands, server, driver, threads; 66 markers).** **Ruling: V2
shapes win. `goals` on the shell snapshot, goal/workstream commands, Loom
thread-detail field merging, batched `thread-upserted` frames, top-spend and
workstream-worktree RPCs: dropped with DT rows (phase 2/3a/3d). Keep marked:
`connection/driver.ts` H4 (blocked-on-sign-in classification — not
orchestration). Open hunks (coder decides, doctrine question: _does V2's shell
sync already guard this?_): `shell.ts` H7 self-heal of a poisoned warm cache,
`threads.ts` H1 no-data guard before the cursor, `shellReducer.ts` H1 batching
— keep only if V2's sync demonstrably lacks the guard (read upstream's
`shell.ts`/`threads.ts` around the hunk and cite the line in the DL row);
otherwise upstream's.** High on shapes, medium on the three guards. Tests:
PR-18 rule — Loom fixtures (`loomThreadDefaults`, `goals: []`) go with the
fields.

**PR-12 — Provider zone: `builtInDrivers.ts` (3), `makeManagedServerProvider.ts`,
`ProviderRegistry.test.ts` (6), `ProviderInstanceRegistryLive.test.ts`,
`providerCompatibility.test.ts`, `ClaudeProvider.ts`, ACP files,
`ProviderUsageLimitsIngestion.ts`, `opencodeRuntime.ts`.** **Ruling: Pi-only
registry stands (`BUILT_IN_DRIVERS = [PiDriver]`, `BuiltInDriversEnv =
PiDriverEnv`, marked) with upstream's `PiDriver` (which now needs
`PiAdapterV2DriverEnv` etc. — take upstream's env union _restricted to Pi_);
upstream's non-Pi test cases stay deleted (doc 25 C5); everything else in the
zone upstream's, Loom's marked lines re-applied only where they still name a
live thing (`makeManagedServerProvider` H1's 5 `loom:` lines: read them —
failover plumbing goes with DL-77's slice to phase 3c if it no longer
compiles).** High. `apps/server/package.json`: union (Loom's
`@earendil-works/pi-coding-agent: 0.99.2` line stays; DL-83).

**PR-13 — `mcp/McpInvocationContext.ts`.** Ours adds `"workstream"` to a
literal union; upstream (`06e627448b`) has `ALL_MCP_CAPABILITIES` with
`orchestration`/`worktree`. **Ruling: upstream verbatim; no `workstream`
capability in Phase 1 (nothing issues or checks it once the REST routes are
detached); phase 3a adds it with the toolkit.** High. Strategy Area B.

**PR-14 — `ws.ts` (24), `server.ts` (5), `serverRuntimeStartup.ts` (8) +
tests, `bin.ts`, `RpcAuthorization.ts`, `cli/*`.** **Ruling: the V2 world
wins on structure — upstream's imports, service acquisitions,
`ThreadManagementService`/`ThreadLaunchService` intake, `ORCHESTRATION_V2_WS_METHODS`
handlers, V2 runtime layer composition (`server.ts` H3/H4), V2 recovery
(`serverRuntimeStartup.ts` H5 → upstream's zero lines; H7 upstream's
project auto-pull/recovery block). Loom survivors, each one marked:
`remoteEditorSshHost` (H18), `referenceLinks` (H19), `claimServerHome`
(`cli/server.ts`), the worktree-home rule (`cli/config.ts`), the foreign-home
boot line (DL-81, re-expressed), `LoomProviderHealthLive` + the surviving half
of `loom/serverLayers.ts` (`server.ts` H1/H3/H4 splice lines, trimmed),
pretty-printed startup cause (H8), `projectSetupScriptCompatibilityDetail`
(H11) if its caller survives. Loom departures, each a DT row: workstream ws
methods (H20, `loom/wsMethods.ts`), `/handoff`+`/retro` (H21), thread
activities/lifecycle RPCs (H22), brief-needed decoration and goal shell-stream
mapping (H23), fail-loud catch-up (H24), bootstrap-thread worktree
provisioning (H16/H17 — upstream's `ThreadLaunchService` is the mechanism
the strategy adopts for roots), `startLoomSweeps` and `LoomMcpHttpLive`
(H7, `server.ts` H5), Loom `RpcAuthorization` scopes, `goal` CLI
registration in `bin.ts`, `cli/project.ts` H4 snapshot-query use.** High.
Strategy FileTree, Area A/B/C; doc 04 ("a textually clean resolution of them
still has to pick one engine").

**PR-15 — `relay/AgentAwarenessRelay.ts` + test (15 markers).** **Ruling:
upstream's V2 relay (it now silences subagent threads itself — Area A
"accept"); Loom's lean-shell read and plan-lane/attention metadata hunks go
(DT row, phase 3b).** High.

**PR-16 — Lockfile, workspace, toolchain.** **Ruling: `git checkout --theirs
pnpm-lock.yaml`; `pnpm-workspace.yaml` auto-merged — verify it carries
upstream's catalog/overrides _and_ Loom's `@earendil-works/*` pins, the pi
patch line and the `astro>esbuild`/`@types/hast` overrides (prove each Loom
override load-bearing by reverting it, pull 7's method, in S3); then `vp i`.
`apps/web/package.json` (2), `packages/client-runtime/package.json` (1):
union; upstream's version wins on a shared dependency.** High. Doc 27 PR-16,
DL-1–3.

**PR-17 — Upstream deleted a module a surviving Loom file imports.**
**Ruling: never restore it; adopt upstream's replacement or detach the
importer (§5.3).** High. Doc 27 PR-17.

**PR-18 — Tests.** **Ruling: fixtures follow source; a Loom-only case that
pins a detached behaviour is deleted with it (not faked green); upstream
cases Loom dropped by accident are restored; `loomThreadDefaults`/
`loomThreadShellDefaults` spreads go with the fields; the quarantine carries
the engine's tests with it.** High. Carl U5; doc 27 PR-18.

**PR-19 — Anything that re-introduces a standing drop** (Antigravity/Codex/
Cursor registration, `processDomainEvent` in ingestion, v1-sidebar code,
client-side `effectiveSettled`, `title_provenance`, `AccountUsageRegistry`,
Loom's Option-1 restart resume) **or that ports a V1 Loom module onto V2
"while I'm here"**. **Ruling: a resolution error; revert it.** High. Doc 27
PR-19; strategy phase plan.

**PR-20 — Mobile (12 files, 17 markers).** **Ruling: V2 shapes (fixtures,
`threadActivity.ts`, `pending-thread-creation.ts`, `use-thread-selection.ts`
Loom fields, `ThreadDetailScreen` pending-input answers) upstream's; the
search-ranking hunks in `HomeScreen.tsx`/`ThreadNavigationSidebar.tsx`
(PR-11 of pull 8, a signed plan) stay marked **if they compile against
upstream's `threadSearch.ts` contract** — they then render nothing for
archived hits until phase 2/3d, which is honest; `thread-list-v2-items.tsx`'s
pending-input header read is dropped (H row).** High. §5.4 items 1 and 5.

**PR-21 — `DiffPanel.tsx` (22), `diffPanelStore.ts`, `RightPanelTabs.tsx`,
`rightPanelStore.ts`, `FilePreviewPanel.tsx`, `SettingsPanels.tsx`,
`CommandPalette.tsx`, `__root.tsx`, `index.css`.** **Ruling: upstream's radio
scope menu and tabs; the By-coder arm (H4–H11, H20) dropped behind markers
(DT, phase 3d); the "Goal tasks" / "Workstream" / "Graph" / "Agents" tabs and
their `tasksAvailable`/`agentsAvailable` props dropped (DT, phase 3d); the
artefact viewer / MDX preview seams in `FilePreviewPanel.tsx` and
`rightPanelStore.ts` stay marked; `SettingsPanels.tsx`'s Loom panels stay
where they compile (thread-search settings go, worktrees settings go — DT);
`index.css` H1 (648 Loom lines vs 38 upstream): keep upstream's 38 and the
Loom tail **minus** the rules whose components are quarantined (the fork-only
UI block is self-describing; delete what nothing renders, keep the rest,
marked).** High on direction, medium on `index.css` pruning (log what was cut).

**PR-22 — `checkpointing/*`, `git/*`, `vcs/*`, `terminal/*`, `usage/*`,
`textGeneration/*`, `project/AgentSession*.test.ts`.** **Ruling: union;
Loom's start-of-turn baseline-ref preference (with its fallback) stays
marked (the V1 `CheckpointReactor` writer is deleted — the read falls back,
honestly); fan-in git primitives and the `GitVcsDriverCore` merge arm stay
marked as orphans (DT _orphaned_, `isolation-option`); `TextGeneration.ts`
Loom structured op goes with the emergent goal (DT, 3b); `UsageLimitSources.ts`
cliproxy hunk stays; `AgentSessionImporter.test.ts` H1 (721 vs 38 lines — a
V1 harness) upstream's.** High.

---

## 7. Silently auto-merged files

116 files both sides modified merged without a marker. Three of them need
pre-rulings; the rest get the clean-overlap review in S4 (§9) exactly as pull
8 did (doc 27 §9, "clean-overlap semantic review": for each file, read
upstream's diff beside Loom's hunks and classify kept-compatible / adapted /
behaviour-changed; `.artifacts/pull9-remeasure/both-modified-automerged.txt`
is the list).

**The 8 that lost an exported name** (`automerged.py`, identical to doc
04's list) — each pre-ruled **drop, upstream wins**, with the reason:

| file                                                | lost name(s)                                             | ruling                                                                                                                                                                    |
| --------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/mcp/McpSessionRegistry.ts`         | `revokeActiveMcpThread`, `revokeAllActiveMcpCredentials` | drop — only the deleted V1 `ProviderService.ts` called them; V2's `ProviderSessionManager` owns credential lifetime. Phase 3a re-reads this file for the capability hunk. |
| `apps/web/src/modelSelection.ts`                    | `resolvePlanAgentHealPatch`, `withoutPlanAgentSelection` | drop — no importer on the merged tree.                                                                                                                                    |
| `apps/mobile/src/state/queries.ts`                  | `useThreadDetail`, `ThreadDetailView`                    | drop — upstream moved `useThreadDetail` to `state/use-thread-detail.ts` (own definition); nothing imports the type.                                                       |
| `apps/web/src/state/queries.ts`                     | `ThreadDetailView`                                       | drop — no importer.                                                                                                                                                       |
| `apps/web/src/components/chat/providerIconUtils.ts` | `PROVIDER_ICON_BY_PROVIDER`                              | drop — upstream's `ProviderInstanceIcon.tsx` carries its own local map; Loom's `excluded` glyph note (line 26) is the one marked line to keep.                            |
| `apps/web/src/lib/utils.ts`                         | `randomHex`                                              | drop — no web importer (mobile and shared have their own).                                                                                                                |
| `apps/server/src/usage/UsageService.ts`             | `layerTest` (Loom's empty-summary test layer)            | drop — no importer.                                                                                                                                                       |
| `apps/server/src/usage/usageTranscripts.ts`         | `addTotals`                                              | drop — no importer.                                                                                                                                                       |

**`packages/contracts/src/settings.ts` — a duplicate `PiSettings` block.**
The three markers are on `// loom:` comment lines; the _bodies_ did not
conflict: Loom's `PiSettings` (line ≈752: `enabled` default `true`, bundled-pi
description, `customModels: Array(String)`) and upstream's `PiSettings`
(≈886: `enabled` default `false`, `launchArgs`, `customModels: Array(CustomModelSetting)`)
are **both present** in the merged file. Typecheck catches the duplicate;
**pre-ruled: delete Loom's block; in upstream's block, two marked hunks —
`enabled` default `true` (Pi-first) and the bundled-pi `binaryPath`
description; take `launchArgs` and object `customModels` as upstream has
them** (the string→object migration is phase 2; Carl's live `settings.json`
has no `pi` block today, so the smoke copy decodes). [DL-84]

**`apps/server/src/config.ts`** auto-merged to `statev2.sqlite` with
upstream's `ServerConfig` service unchanged in shape (`export class
ServerConfig`); both `import { ServerConfig }` and `import * as ServerConfig`
resolve. Accepted (§11 item 1).

**`apps/web/src/components/ChatMarkdown.tsx`** (33 `loom:` lines; Loom
+267/−19, upstream +184/−57 mermaid and file-link labels; merged clean) —
**review by eye in S3**: open the file, confirm every Loom hunk (file chips
inline in prose and fences, `thread://` links, artefact chips) is intact and
sits inside upstream's new mermaid/label structure, and render the preview
harness fixture (`docs/web-component-preview.md`) once. Likewise
`pullRequestList.logic.ts` (new to the set from `7ffa2184a7`).

---

## 8. Sequencing — sessions, order, definition of done

Repair order for typecheck: lockfile/workspace → install → contracts →
shared → client-runtime → server → web → mobile → desktop. Resolution order
inside the merge follows the zones. Sessions run sequentially in one
worktree. **Budget: 4 coder sessions + 1 reviewer gate; contingency to 6.**

**S0 — orchestrator, inline, minutes.** `git fetch origin && git fetch
upstream main` separately; confirm `upstream/main` = `1a3f7ad508` (else
re-measure); if `origin/main` moved past the planner's base, diff its new
commits against Appendix B and note overlaps in the S1 brief. Cut the branch;
commit `docs/upstream-sync/pull9-tools/` and this document (already on the
planner's branch) with `--no-verify`; run `remeasure.sh` once so
`.artifacts/pull9-remeasure/` exists for S1; record
`pre_merge_oid=$(git rev-parse HEAD)` in the S1 brief.

**S1 — structural session: merge, quarantine, deletions, detach seeds;
server-side textual zones; BANK (uncommitted).** `git -c rerere.enabled=false
-c merge.renameLimit=30000 merge --no-ff --no-commit upstream/main`; confirm
`git diff --name-only --diff-filter=U | wc -l` = 334 and the AU/UD/AA split
of Appendix B (if not, stop: upstream or ours moved). Then, in order:
(1) add the three `vite.config.ts` exclusion lines (§5.1); (2) `git rm` the
95 UD paths (`git diff --name-only --diff-filter=U` ∩ Appendix B D rows);
(3) quarantine the 86 AU paths with the §5.1 recipe under their _original_
paths; (4) the two AA files; (5) quarantine `orchestration.loom.ts`, the Pi
support files and the Appendix B X-detach **Q** rows that §5.1 items 4–5
name (the obvious engine importers — leave anything doubtful to S3's
typecheck); split `loom/serverLayers.ts` (§5.4); (6) lockfile/workspace
(PR-16) → contracts (PR-1–3) → shared (PR-4) → persistence (PR-5–7) →
provider/mcp (PR-12–13) → server core (PR-14, incl. the DL-81 re-seam of the
foreign-home boot line) → server other (PR-8, PR-15, PR-22). After every zone:
`parsesweep.mjs` over the zone's files. Write §10 rows and Appendix C rows as
you go. **End of S1:** the index still has the web, mobile and client-runtime
UU paths unresolved; everything else resolved and staged; copy
`$(git rev-parse --git-dir)/{index,MERGE_HEAD,HEAD}` to
`.artifacts/pull9-merge-state-backup/`; write the S1 record (per-zone, surprises,
what S2 looks at first) and the S1 §10 / Appendix C rows to
`.artifacts/pull9-s1/record.md` (gitignored) — **not into this document yet**:
any tracked edit made now would be swept into the merge commit by S2's
`git add -A`, and a commit now would _be_ the merge. S2 folds the record in
after the merge commit.
_DoD:_ `git ls-files -u | awk '{print $4}' | sort -u` lists only
client-runtime, web and mobile paths; `quarantine/` holds every Q row of
Appendix B at its original path; no UD path remains; `rg -l '<<<<<<<' $(git
diff --name-only --diff-filter=M)` is empty outside the remaining UU set;
Appendix C has a row for every path moved or removed.

**S2 — textual session: client-runtime, web, mobile; COMMIT the merge.**
Re-verify the merge state is intact (`git rev-parse MERGE_HEAD` =
`1a3f7ad508`; `git ls-files -u` matches S1's hand-off; else restore the
bundle). Resolve client-runtime (PR-11) → web chat (PR-9, PR-10) → web
sidebar (PR-21 and §5.4 item 7) → web panels (PR-21) → mobile (PR-20) →
tests (PR-18), quarantining the X-detach web/shared/client-runtime Q rows
and dropping H-row hunks as the files are opened. `parsesweep.mjs` after each
zone; `rg -l '<<<<<<<\|>>>>>>>'` over all tracked files = none. Then
`git add -A && git commit --no-verify -m "merge: upstream/main 1a3f7ad508 (pull 9, phase 1 — upstream wins on structure)"`;
`merge_oid=$(git rev-parse HEAD)`; verify `${merge_oid}^1 == ${pre_merge_oid}`
and `${merge_oid}^2 == 1a3f7ad508`; `git rerere status` empty. Then fold `.artifacts/pull9-s1/record.md` and the
S2 record into this document (S1/S2 sections, §10, Appendix C) and commit
them as a single-parent follow-up (`--no-verify`).
_DoD:_ merge commit exists with the right parents; parse sweep 0 damaged /
0 conflicted over `git ls-files '*.ts' '*.tsx'`; `git diff --name-only
--diff-filter=D ${pre_merge_oid}..HEAD` ⊆ upstream's deletion set
(`git diff --name-only --diff-filter=D 024d49520e 1a3f7ad508`, 176 paths)
∪ the paths Appendix C records as _deleted with upstream_ or _quarantined_
(a quarantine move shows as rename, not deletion, under `-M`; check with
`git diff -M --name-status`); §10 has a row for every file that dropped a side.

**S3 — fresh install, typecheck to green, detach ledger completed.**
`vp i` (lockfile from upstream; expect a second `vp i` to settle it as in
pull 8); delete every `tsconfig.tsbuildinfo`; `vp run typecheck` must list
every package (15 in pull 8; count them). Work contracts → shared →
client-runtime → server → web → mobile → desktop. Apply the §5.3 rule to
every error: quarantine whole / drop hunk behind marker / fix defect — never
port. Expect: the `PiSettings` duplicate (§7); `loomThreadDefaults` spreads
in tests; `threadSettled` imports (PR-4); `SqliteLanes` split; the DL-81
re-seam compiling against V2's projection table names (read
`Migrations/OrchestrationV2/*` for the column); Loom modules the static pass
missed. Run `lostdecls.py ${pre_merge_oid} 1a3f7ad508` and adjudicate every
hit (the 8 pre-ruled in §7 plus whatever the resolution produced);
`aliascheck.py`; `sqlcolsweep.py` (Loom's surviving SQL: usage ledger
reader if kept, foreign-home query); `dangling.py .artifacts/pull9-remeasure
--exclude quarantine/` → **0 files**; the `ChatMarkdown.tsx` and
`pullRequestList.logic.ts` eye reviews (§7); PR-16's override-revert proof.
_DoD:_ typecheck green for every package from a fresh install;
`dangling.py` 0 outside quarantine; every quarantined path and every dropped
hunk has an Appendix C row; `lostdecls.py` has no unadjudicated loss;
`sqlcolsweep.py` 0/0; §10 updated.

**S4 — gates, audits, boot smoke; `UPSTREAM_BASE` advanced; PR opened.**
`vp check` (fmt + lint; 0 errors — fix residual `shadcn/*` findings in
surviving fork files, no allow-list entries); `pnpm build` (web, server,
marketing, desktop); `vp test` for every package touched by the conflict
list plus `apps/server` (expect V1-shaped Loom tests to have gone with their
modules — a failing _upstream_ test is a merge defect); `unmarkedsweep.sh
--report` with `UPSTREAM_BASE` = `1a3f7ad508` (advance the file) and the gate
scope; the quarantine-exclusion proof (§5.1); the structural composition audit
(`server.ts` layer roots vs **upstream's** — Loom adds only the surviving
provider-health/usage-poller layers and the foreign-home boot line; `bin.ts`;
`ws.ts` handler map = upstream's V2 set; contracts barrel; every workspace
`package.json` dependency line; plain-node `import('@t3tools/contracts')`);
the lost-feature audit (every `// loom:` marker at `pre_merge_oid` in any
of the ~450 overlap files is at HEAD, in quarantine, or in an Appendix C/§10
row); the clean-overlap semantic review of the 116 auto-merged files (§7);
the **boot smoke** below; `docs/upstream-sync/UPSTREAM_BASE` = `1a3f7ad508`;
the S3/S4 records into this document; push; open the merge PR against
`QuinRiva/loom:main`, **not merged**.

_Boot smoke (D-E) — the recipe._ In this worktree, with its own T3 home,
never against a live home:

```sh
# 1. snapshot the LIVE database — it is the cockpit home, not ~/.t3/userdata (whose state.sqlite is 0 bytes)
mkdir -p .t3/userdata && rm -f .t3/userdata/state*.sqlite*
# eta: 5m — 6 GB VACUUM INTO
bun -e "new (require('bun:sqlite').Database)(process.env.HOME + '/.t3/cockpit/userdata/state.sqlite', { readonly: true }).run(\"VACUUM INTO '.t3/userdata/state.sqlite'\")"
cp ~/.t3/cockpit/userdata/settings.json .t3/userdata/   # only if the Pi provider needs a setting; secrets only if pi auth needs them (pi uses ~/.pi/agent/auth.json — usually not)
ls -la .t3/userdata/            # state.sqlite present, NO statev2.sqlite yet
# 2. build and boot headless on a spare port; capture the PID
pnpm build
PORT=139xx   # free; never 13900
T3CODE_NO_BROWSER=1 node apps/server/dist/bin.js serve --base-dir "$PWD/.t3" --port "$PORT" --headless > .artifacts/pull9-s4/smoke-boot.log 2>&1 &
SMOKE_PID=$!
```

Evidence to collect, in order: the startup log names the worktree home rule
and the **foreign-home guard engaged** line (DL-81 — the copy records the
cockpit's worktree paths); `initializeV2Database` created `statev2.sqlite`
next to `state.sqlite` (size ≈ the copy); `effect_sql_migrations` max = 056
and `loom_sql_migrations` max = 1045 **in `statev2.sqlite`** (`sqlite3
.t3/userdata/statev2.sqlite "select max(version) from …"`); `state.sqlite`
untouched (mtime); the legacy importer's `orchestration_v2_legacy_imports`
rows exist; relaunch applies zero migrations and does **not** re-copy. Then,
through the pairing URL in the log (the dev-verify recipe's browser path —
upstream's CLI has no thread-create/send command, `seedWorkstream.ts` is V1
and quarantined, so a browser is the one honest way; the orchestrator
authorises it in the S4 brief): Settings → Providers shows Pi enabled
(PiSettings default `true`) with the resolved binary and version
(`pi --version` = 0.99.2 from `PATH`, DL-83); create a **new** project on a
scratch directory under the worktree (never an existing cockpit project —
the guard refuses, and that is the second line of defence, not the plan);
create a Pi thread; send one turn ("run `echo hello` and tell me the
output") and watch it stream and settle (`agent_settled`); **restart the
server** (kill `$SMOKE_PID` only, relaunch the same command) and confirm the
thread resumes — a second message continues the same pi session (V2's
`nativeThreadRef` resume; with `continueThreadsAfterServerUpdate` at
upstream's default no automatic continuation is expected); **rollback** one
turn from the timeline (upstream's non-destructive `fork(entryId)`) and
confirm the transcript reads as expected. Screens and server logs under
`.artifacts/pull9-s4/`. Kill only `$SMOKE_PID` (and the pi child it owns, by
the PID in its log); never `pkill -f`.

_DoD:_ every §9 row ticked, or — only where §9 allows it — a deliberate gap
with a §10 row; `UPSTREAM_BASE` advanced; PR open, not merged.

**S5 — reviewer gate.** Re-run every §9 gate from a fresh `vp i`; audit §10
and Appendix C against the diff; confirm every PR-n outcome and DL-80–85;
check no standing drop returned (PR-19) and nothing was ported (PR-19 second
half: `git diff ${merge_oid}..HEAD -- apps/server/src/orchestration-v2/`
contains only the DL-81 hunk and nothing Loom-named); topology; quarantine
exclusion proof. Verdict → parent → Carl reviews §10 and the escalation list
in §5.4 → PR merges (shipping policy: AGENT-OK after approval).

If S1 cannot finish the server-side zones, S2 absorbs them; if S2 cannot
commit, it banks and S3 becomes "finish and commit"; the budget absorbs one
slip.

---

## 9. Gate and audit checklist for the end state

Tick each in the session record. "Deliberate gap" needs a §10 row; rows
marked **(not gap-eligible)** cannot be gapped.

- [ ] `git rev-parse ${merge_oid}^2` = `1a3f7ad508`; `${merge_oid}^1` = `${pre_merge_oid}`; one merge commit on the branch; no rebase/squash/amend; `git rerere status` empty after the merge
- [ ] `parsesweep.mjs` over all tracked `.ts`/`.tsx` (quarantine included): 0 damaged, 0 conflicted; `rg -l '^<<<<<<< |^>>>>>>> '` over tracked files: none
- [ ] `vp i` from upstream's lockfile; every `*.tsbuildinfo` deleted; **`vp run typecheck` green for every package** (count them; record the count)
- [ ] `vp check` 0 errors (fmt + lint), no new allow-list entries
- [ ] `pnpm build` — web, server, marketing, desktop green
- [ ] **Quarantine excluded, provably** (not gap-eligible): `vite.config.ts` carries the three marked entries; no `tsconfig*.json` names `quarantine`; `vp test run --config vite.config.ts quarantine` finds no tests; `quarantine/` is non-empty and every path in it is an Appendix B Q row or an Appendix C _quarantined_ row at its original path
- [ ] **Detach ledger complete** (not gap-eligible): `dangling.py --exclude quarantine/` reports 0 files; every Appendix B X row is resolved by an Appendix C row or by "compiles as-is" in §10; every `// loom: detached … DT-nn` marker in the tree has its row
- [ ] `lostdecls.py ${pre_merge_oid} 1a3f7ad508` adjudicated (the 8 of §7 plus any new); `aliascheck.py` only its documented false positive; `sqlcolsweep.py` 0/0
- [ ] `Migrations.ts` byte-identical to `git show 1a3f7ad508:apps/server/src/persistence/Migrations.ts` (or differs only by the PR-6 `export`, recorded); `LoomMigrations.ts` untouched; `UPSTREAM_BASE` = `1a3f7ad508`
- [ ] `unmarkedsweep.sh --report` clean vs `1a3f7ad508`; gate scope clean
- [ ] **Nothing ported** (not gap-eligible): `git diff ${merge_oid}..HEAD --stat -- apps/server/src/orchestration-v2/` shows only the DL-81 refusal hunk (if it landed there) and zero Loom-named files; no file in `apps/server/src/loom/` imports `orchestration-v2/`; no `orchestrationV2.loom.ts` exists
- [ ] **Structural composition audit** vs upstream: `server.ts` layer roots = upstream's + the surviving Loom provider layers + nothing else; `ws.ts` RPC handler map = upstream's V2 map; `bin.ts` subcommands = upstream's; contracts barrel = upstream's; every workspace `package.json` dependency line; plain-node `import('@t3tools/contracts')`
- [ ] **Lost-feature audit**: every `// loom:` marker present at `pre_merge_oid` in any overlap file is present at HEAD, in `quarantine/`, or in an Appendix C / §10 row; `git diff --name-only --diff-filter=D ${pre_merge_oid}..HEAD` ⊆ upstream's 176 deletions ∪ Appendix C _deleted with upstream_ / PR-4
- [ ] **Clean-overlap semantic review** (not gap-eligible): all 116 auto-merged both-modified files classified in `29-clean-overlap-review.md` (doc 27's format); `ChatMarkdown.tsx` and `pullRequestList.logic.ts` eyeballed
- [ ] **Boot smoke on a copy of the live database** (not gap-eligible; §8 S4): foreign-home guard engaged; `statev2.sqlite` created once from `state.sqlite`; both migration ledgers at their maxima in the new file; relaunch idempotent; a new project + Pi thread; one turn completes through `PiAdapterV2` with `pi` 0.99.2 from `PATH`; resume after restart continues the same session; rollback works; `state.sqlite` unmodified; only captured PIDs killed
- [ ] **Worktree-setup smoke** (DL-73 survives): a thread created in a worktree from the smoke instance writes `t3code-setup-state.json` → `ready`; the idle shell closes on exit 0
- [ ] `vp test` for touched packages: upstream's suites green; Loom suites that moved to quarantine are not run; no Loom test faked green
- [ ] `docs/upstream-sync/UPSTREAM_BASE` = `1a3f7ad508`; this note has the S1–S4 records, the completed §10 and Appendix C
- [ ] `.repos/` vendored subtrees: check `git diff 024d49520e 1a3f7ad508 -- pnpm-workspace.yaml | grep effect` — resync `.repos/effect-smol` only if the Effect catalogue moved
- [ ] PR open against `QuinRiva/loom:main`, not merged until Carl reviews §10 and the §5.4 escalation list

---

## 10. Decision log (coders append here)

Rule (doc 27 §10): **any resolution that drops a side — a hunk, a
declaration, a test case, a dependency line, a field — writes a row**, as
does any PR-n whose outcome differed. One line per decision; reasoning in a
sentence; evidence is a doc §, a PR number, a consult, or "none — default".
Reversibility: `trivial` · `local` · `structural`. Ids continue doc 27's
numbering. Detach rows live in Appendix C (`DT-nn`); a DL row references the
DT row when the two coincide.

| id    | zone / file                                                                                                                                                                          | what conflicted                                                                                                                                                     | ruling                                                                                                                                                                                                                                                                                                                                       | reasoning                                                                                                                                                                                                                           | evidence                                                                                                            | reversibility                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| DL-80 | repo / quarantine                                                                                                                                                                    | where the ~40k lines of undone-not-owned Loom code live and how they are excluded                                                                                   | `quarantine/<original path>` at the repo root; excluded by three marked list entries in root `vite.config.ts` (`test.exclude`, `lint.ignorePatterns`, `fmt.ignorePatterns`); no tsconfig touched because no package `include` reaches it                                                                                                     | one mechanism for six packages; zero upstream JSON hunks; `git mv` keeps history; `--no-index` diffs during the port                                                                                                                | §5.1; verified move recipe on an AU entry                                                                           | structural (phase 4 deletes the directory)                                                          |
| DL-81 | server / `workspace/foreignHomeGuard.loom.ts`, `serverRuntimeStartup.ts`, V2 `ProviderSessionManager`                                                                                | the guard's boot detection and provider-launch refusal lose their V1 seams (`ProjectionSnapshotQuery.getReferencedWorktreePaths`, `ProviderService`)                | **sanctioned exception to "ports nothing"**: Loom-only boot query over copied `projection_threads.worktree_path` + `orchestration_v2_projection_threads`, one marked line in `serverRuntimeStartup.ts`; one marked refusal hunk at V2 session open; added to the hunk inventory (folds into the "ProviderSessionManager (open session)" row) | the smoke boots on a copy of the live database that records the cockpit's worktree paths; the guard exists for that recipe and has saved the live checkouts twice; mechanism over discipline for a silent-failure class             | consult_manager (strategy author, **medium** confidence): option 1; escalate if more than one choke point is needed | local                                                                                               |
| DL-82 | server / thread search stack (`ThreadSearch.loom.ts`, `ThreadEmbedder.loom.ts`, `embedding/*.loom.ts`, `persistence/threadSearchIndex.loom.ts`, web `ThreadSearchSettings.loom.tsx`) | compiles under V2 (sqlite + settings only) but indexes the inert V1 projection tables via migration 1045's triggers                                                 | quarantined; ws search = upstream's `orchestration-v2/ThreadSearch.ts`; migration 1045 stays (harmless on dead tables); DT rows → phase 2 (index re-pointed at V2 projections + `loom_goals`), 3d (surfaces, archived hits)                                                                                                                  | a frozen index that never sees a V2 thread is the "inert table" silent-failure class; upstream's lexical search is the interim baseline                                                                                             | consult_manager (strategy author, **medium**): option 1; Area K/J                                                   | local                                                                                               |
| DL-83 | provider / pi binary and pin                                                                                                                                                         | upstream resolves `pi` from `PATH` (min 0.80.5, fixtures on 1.0.0); Loom pins and patches `@earendil-works/pi-coding-agent@0.99.2` for its own (quarantined) driver | Phase 1 runs upstream's adapter on the host's `PATH` pi (0.99.2 here — it already emits `agent_settled`, `switch_session`, `fork`); the `package.json` pin and `patchedDependencies` line stay untouched (unused, harmless); the bump to 1.0.2 and patch regeneration are phase 2 (Area L, decided)                                          | no behaviour change to anything upstream shipped; the patches matter only for `--cwd` resume and auth atomicity, neither exercised by the Phase 1 gate; never click "update pi" in the smoke (it would overwrite the global binary) | doc 03 §"Pins"; §8 S4                                                                                               | trivial                                                                                             |
| DL-84 | contracts / `settings.ts` `PiSettings`                                                                                                                                               | both blocks present after the auto-merge (Loom's ≈752, upstream's ≈886)                                                                                             | upstream's block; Loom's deleted; two marked hunks: `enabled` default `true`, bundled-pi `binaryPath` description; `launchArgs` and object `customModels` adopted                                                                                                                                                                            | strategy "PiSettings collisions" row; typecheck forces the choice anyway                                                                                                                                                            | §7                                                                                                                  | trivial (string→object `customModels` migration is phase 2; no `pi` block in Carl's settings today) |
| DL-85 | contracts / `model.ts` driver default; `serverRuntimeStartup.ts` bootstrap                                                                                                           | Loom `PI_DEFAULT_MODEL` vs upstream's `"default"` sentinel                                                                                                          | Loom's kept, marked (PR-1); phase 2 runs the Area H check                                                                                                                                                                                                                                                                                    | cheapest to reverse; the sentinel check is scheduled, not pre-empted                                                                                                                                                                | strategy Area H                                                                                                     | trivial                                                                                             |

---

## 11. Risks and recorded failure modes to avoid

1. **The `config.ts` repoint.** `dbPath` is now `statev2.sqlite`; `initializeV2Database`
   copies `state.sqlite` **once** and never again. Never boot this branch
   against `~/.t3/cockpit/userdata` or `~/.t3/userdata` (the cockpit home is
   the live one — `~/.t3/userdata/state.sqlite` is 0 bytes); always
   `--base-dir "$PWD/.t3"` on a `VACUUM INTO` copy; if a smoke must be
   repeated from scratch, delete the worktree's `statev2.sqlite` first or V2
   silently resumes from the stale first snapshot (strategy risk 9).
2. **rerere preimages.** The shared cache holds this merge's preimages without
   postimages; nothing auto-resolves — and a merge run without
   `-c rerere.enabled=false` would record postimages that the _next_ worktree's
   merge replays undetectably. Every invocation carries the flag.
3. **The 116 auto-merged files, eight with a lost export** (§7). `lostdecls.py`
   is the check; the duplicate `PiSettings` is the worked example of a clean
   region that is wrong; pull 8's three "clean region" surprises (DL-7, DL-10,
   DL-17) are the class.
4. **The pre-commit hook deletes `MERGE_HEAD`.** `--no-verify` on every commit;
   re-check `${merge_oid}^1`/`^2` after each.
5. **`renameLimit` forgotten.** Without `-c merge.renameLimit=30000` the 86
   relocations become plain adds in place and Appendix B no longer matches —
   abort and re-run with the flag.
6. **A banked merge lost between S1 and S2.** `git merge --abort`, `git
checkout .` or a stray `git stash` in the shared worktree destroys S1's
   work; the recovery bundle (§1) is the only restore. S1 writes it before
   ending; S2 verifies `MERGE_HEAD` first.
7. **"While I'm here" porting.** A coder who adapts a quarantined module to
   V2, writes `orchestrationV2.loom.ts`, or adds a Loom field to `AppThread`
   is making the single most expensive mistake available: it bypasses the
   phase-2 design (sidecar record, per-thread locking) and will be reverted.
   §9 "Nothing ported" is the gate.
8. **Stubbing instead of detaching.** A component that renders a Loom panel
   over data that no longer exists, a `?? null` that makes a lane read "work",
   a goal tab that shows an empty tree: each one lies about state. The rule
   is §5.3; the reviewer rejects stubs.
9. **Phantom-green typecheck.** `node_modules` older than the merge and stale
   `tsbuildinfo` (pull 7); `vp i` and delete `tsbuildinfo` before any count
   that goes in a record.
10. **Lockfile hand-merging.** Never. Upstream's, then `vp i`, then prove each
    Loom override by reverting it.
11. **The two failed heuristics** (doc 25): unioning import-ish hunks splits
    import blocks; "take upstream where Loom's delta is small" dropped the
    Pi-only registry and `PI_DEFAULT_MODEL` once. Union only complete,
    balanced statements, after reading.
12. **The smoke killing by pattern or touching a cockpit project.** Kill only
    `$SMOKE_PID` and the pi PID from its log; create a new project in a
    scratch directory; the foreign-home guard (DL-81) is the second line, not
    the first.
13. **Upstream moves mid-cycle.** `upstream/main` is pinned at `1a3f7ad508`
    for Phase 1; `origin/main` is re-measured in S0 and before the ship.
14. **The dev-verify seeding step is gone** (`seedWorkstream.ts` quarantined);
    a coder following `docs/dev-site-testing.md` verbatim will stall at step 1.
    Phase 1's smoke uses the database copy; the recipe is updated in phase 3d.

---

## 12. Out of scope — and said again so it is not re-litigated by a coder

Phases 2–4 in their entirety: `orchestrationV2.loom.ts` and the Loom sidecar
record; the decider guard arm and `Orchestrator.loom.ts`; the two
dispatch/receipt-core hunks; the recovery policy module and the
`continueThreadsAfterServerUpdate` default flip; Loom migrations creating
`loom_*` tables; the Loom projector and shell join; the Pi V2 hunks
(bundled pi, open-session fields → argv, `costUsd`, `quota_exhausted`, patch
0001 → RPC `switch_session`, the pi 1.0.2 bump); the MCP toolkit and the
`mcp__t3-code__` name sweep; the dispatcher, liveness, exhaustion resume,
fan-in/isolation decision; driver economics; the web re-hang; the data
importer and the pi-session binding; the Phase 4 deletions (including
`quarantine/`), the ~50 `state.sqlite` references, cut-over, deploying.
No PR beyond the merge PR. Phase 1 does not change the behaviour of anything
upstream shipped; it removes Loom's V1-welded surfaces from the build and
records where they went.

---

## 13. Tooling notes

`docs/upstream-sync/pull7-tools/` runs as-is (doc 27 §13's esbuild lookup
fix is in). New in `docs/upstream-sync/pull9-tools/`:

- `remeasure.sh [out]` — the trial merge in this worktree with rerere off and
  `renameLimit` set; captures `status-v2.txt`, `ls-files-u.txt`,
  `unmerged.txt`, both name-status lists; runs the three classifiers and
  `zones.py`; aborts. Requires a clean worktree.
- `classify.py <out>` — every conflicted path → `conflicts.json` (kind, origin
  path for relocations, area, `loom:` count, our line count, markers).
- `automerged.py <out>` — the both-modified files that auto-merged and which
  lost an exported name from our side (the pre-commit form of `lostdecls.py`).
- `dangling.py <out> [--exclude prefix]` — files whose relative imports do
  not resolve on the merged tree; the S3 gate runs it with
  `--exclude quarantine/` and expects 0.
- `zones.py <out>` — Appendix B from the capture: one zone per conflicted
  path plus the X-detach seed list (Q/H hints). It also reads
  `loom-field-readers.json` and `removed-name-users.json` when present; the
  one-off scripts that produced those during planning are inlined in the
  planner's session (field names from `LoomThreadFields`/`LoomThreadShellFields`/
  `LoomMessageFields`/`LoomShellSnapshotFields` in `orchestration.loom.ts`;
  names = exports of our `orchestration.ts` absent from every upstream
  contract file) — regenerate only if the seed list looks stale.

Pull-7 tools the sessions lean on: `hunks.sh`/`brief.py` to read hunks,
`hx.py` to resolve by hunk, `union.py`/`sideresolve.py` per file after
reading, `parsesweep.mjs` after every zone, `lostdecls.py`, `aliascheck.py`,
`sqlcolsweep.py`, `whatismissing.sh` when a surviving file references a name
nobody declares, `unmarkedsweep.sh` (`--report` audit; gate scope at ship).

---

## Appendix A — reproduce the sizing

```sh
git fetch upstream main && git rev-parse upstream/main        # 1a3f7ad508
git merge-base HEAD upstream/main                              # 024d49520e
git rev-list --count 024d49520e..upstream/main                 # 165
docs/upstream-sync/pull9-tools/remeasure.sh                    # ~1 min; prints the counts, aborts the merge
cat .artifacts/pull9-remeasure/zones.md                        # Appendix B
```

## Appendix B — exact file-to-zone partition (334 conflicted paths, one zone each; 71 detach seeds)

Generated by `zones.py` from the re-measurement at `f1b4cf81a9` × `1a3f7ad508`.
`Nm` = conflict markers, `NL` = `loom:` lines in our blob, lines = our line
count. For Q rows the quarantine destination is `quarantine/<was-path>`.

| zone                           |       n | markers | `loom:` lines |
| ------------------------------ | ------: | ------: | ------------: |
| AA-add/add                     |       2 |      10 |            17 |
| D-upstream-deletion            |      95 |       0 |           429 |
| Q-relocated                    |      86 |       0 |            43 |
| T-client-runtime               |      21 |      66 |            31 |
| T-contracts                    |       9 |      20 |            53 |
| T-lock/config                  |       7 |      29 |            11 |
| T-mobile                       |      12 |      17 |            21 |
| T-server-core                  |      10 |      55 |            94 |
| T-server-other                 |      20 |      50 |            67 |
| T-server-persistence           |       5 |      12 |             8 |
| T-server-provider/mcp          |      13 |      24 |            24 |
| T-shared                       |       5 |       5 |            12 |
| T-web-chat                     |      18 |      85 |           255 |
| T-web-panels/other             |      20 |      53 |           103 |
| T-web-sidebar                  |      11 |      40 |            69 |
| **total conflicted**           | **334** | **466** |      **1237** |
| X-detach seed (not conflicted) |      71 |       — |             — |

### AA-add/add (2)

- `apps/server/src/provider/Drivers/PiDriver.ts` · 7m · 16L · 2959 lines
- `apps/server/src/textGeneration/PiTextGeneration.ts` · 3m · 1L · 127 lines

### D-upstream-deletion (95)

- `apps/server/integration/OrchestrationEngineHarness.integration.ts` · 0m · 2L · 661 lines
- `apps/server/integration/TestProviderAdapter.integration.ts` · 0m · 0L · 577 lines
- `apps/server/integration/orchestrationEngine.integration.test.ts` · 0m · 1L · 1441 lines
- `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts` · 0m · 6L · 625 lines
- `apps/server/integration/providerService.integration.test.ts` · 0m · 0L · 391 lines
- `apps/server/src/bin.test.ts` · 0m · 0L · 873 lines
- `apps/server/src/orchestration/ActivityPayloadProjection.ts` · 0m · 2L · 696 lines
- `apps/server/src/orchestration/Errors.ts` · 0m · 2L · 107 lines
- `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts` · 0m · 7L · 2355 lines
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` · 0m · 1L · 1194 lines
- `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts` · 0m · 2L · 2502 lines
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` · 0m · 6L · 821 lines
- `apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts` · 0m · 1L · 186 lines
- `apps/server/src/orchestration/Layers/OrchestrationReactor.ts` · 0m · 3L · 61 lines
- `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts` · 0m · 3L · 5608 lines
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` · 0m · 12L · 3032 lines
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts` · 0m · 7L · 5402 lines
- `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` · 0m · 30L · 6265 lines
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` · 0m · 13L · 5282 lines
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` · 0m · 24L · 2697 lines
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` · 0m · 4L · 5765 lines
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` · 0m · 18L · 3244 lines
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts` · 0m · 1L · 245 lines
- `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts` · 0m · 2L · 183 lines
- `apps/server/src/orchestration/Schemas.ts` · 0m · 1L · 122 lines
- `apps/server/src/orchestration/Services/OrchestrationEngine.ts` · 0m · 1L · 144 lines
- `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts` · 0m · 6L · 784 lines
- `apps/server/src/orchestration/Services/ThreadDeletionReactor.ts` · 0m · 2L · 53 lines
- `apps/server/src/orchestration/ThreadPullRequestReactor.test.ts` · 0m · 2L · 856 lines
- `apps/server/src/orchestration/ThreadSettlementPolicy.test.ts` · 0m · 1L · 316 lines
- `apps/server/src/orchestration/ThreadSettlementPolicy.ts` · 0m · 4L · 215 lines
- `apps/server/src/orchestration/ThreadSettlementReactor.test.ts` · 0m · 8L · 2342 lines
- `apps/server/src/orchestration/ThreadSettlementReactor.ts` · 0m · 11L · 488 lines
- `apps/server/src/orchestration/commandInvariants.test.ts` · 0m · 1L · 287 lines
- `apps/server/src/orchestration/decider.active-order.test.ts` · 0m · 1L · 207 lines
- `apps/server/src/orchestration/decider.autoSettleSet.test.ts` · 0m · 1L · 157 lines
- `apps/server/src/orchestration/decider.pinned.test.ts` · 0m · 1L · 356 lines
- `apps/server/src/orchestration/decider.pullRequests.test.ts` · 0m · 0L · 578 lines
- `apps/server/src/orchestration/decider.questionAttachments.test.ts` · 0m · 1L · 142 lines
- `apps/server/src/orchestration/decider.settled.test.ts` · 0m · 4L · 1105 lines
- `apps/server/src/orchestration/decider.snoozed.test.ts` · 0m · 1L · 318 lines
- `apps/server/src/orchestration/decider.titleRegeneration.test.ts` · 0m · 1L · 151 lines
- `apps/server/src/orchestration/decider.ts` · 0m · 36L · 2866 lines
- `apps/server/src/orchestration/decider.turnDiffComplete.test.ts` · 0m · 0L · 130 lines
- `apps/server/src/orchestration/decider.userInputDismiss.test.ts` · 0m · 2L · 154 lines
- `apps/server/src/orchestration/http.ts` · 0m · 1L · 139 lines
- `apps/server/src/orchestration/messageContext.test.ts` · 0m · 0L · 168 lines
- `apps/server/src/orchestration/projector.test.ts` · 0m · 2L · 1590 lines
- `apps/server/src/orchestration/projector.ts` · 0m · 15L · 1167 lines
- `apps/server/src/persistence/Layers/ProjectionProjects.ts` · 0m · 1L · 134 lines
- `apps/server/src/persistence/Layers/ProjectionRepositories.test.ts` · 0m · 1L · 883 lines
- `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts` · 0m · 7L · 354 lines
- `apps/server/src/persistence/Layers/ProjectionThreadSessions.ts` · 0m · 4L · 150 lines
- `apps/server/src/persistence/Layers/ProjectionThreads.ts` · 0m · 6L · 367 lines
- `apps/server/src/persistence/Layers/ProjectionTurns.ts` · 0m · 1L · 401 lines
- `apps/server/src/persistence/Services/ProjectionProjects.ts` · 0m · 0L · 75 lines
- `apps/server/src/persistence/Services/ProjectionThreadMessages.ts` · 0m · 0L · 135 lines
- `apps/server/src/persistence/Services/ProjectionThreadSessions.ts` · 0m · 1L · 90 lines
- `apps/server/src/persistence/Services/ProjectionThreads.ts` · 0m · 2L · 185 lines
- `apps/server/src/persistence/Services/ProjectionTurns.ts` · 0m · 0L · 177 lines
- `apps/server/src/provider/Layers/AntigravityAdapter.ts` · 0m · 2L · 1318 lines
- `apps/server/src/provider/Layers/ClaudeAdapter.test.ts` · 0m · 1L · 8517 lines
- `apps/server/src/provider/Layers/ClaudeAdapter.ts` · 0m · 1L · 5785 lines
- `apps/server/src/provider/Layers/CodexAdapter.test.ts` · 0m · 1L · 3355 lines
- `apps/server/src/provider/Layers/CodexAdapter.ts` · 0m · 3L · 2898 lines
- `apps/server/src/provider/Layers/CodexSessionRuntime.ts` · 0m · 1L · 2815 lines
- `apps/server/src/provider/Layers/CursorAdapter.ts` · 0m · 1L · 1364 lines
- `apps/server/src/provider/Layers/GrokAdapter.test.ts` · 0m · 1L · 2646 lines
- `apps/server/src/provider/Layers/GrokAdapter.ts` · 0m · 1L · 2298 lines
- `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts` · 0m · 1L · 8017 lines
- `apps/server/src/provider/Layers/OpenCodeAdapter.ts` · 0m · 2L · 4138 lines
- `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts` · 0m · 5L · 290 lines
- `apps/server/src/provider/Layers/ProviderService.test.ts` · 0m · 21L · 6158 lines
- `apps/server/src/provider/Layers/ProviderService.ts` · 0m · 19L · 2952 lines
- `apps/server/src/provider/Layers/ProviderSessionDirectory.ts` · 0m · 3L · 236 lines
- `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts` · 0m · 1L · 825 lines
- `apps/server/src/provider/Layers/ProviderSessionReaper.ts` · 0m · 3L · 272 lines
- `apps/server/src/provider/Services/ProviderAdapter.ts` · 0m · 3L · 285 lines
- `apps/server/src/provider/Services/ProviderService.ts` · 0m · 1L · 164 lines
- `apps/server/src/provider/Services/ProviderSessionDirectory.ts` · 0m · 1L · 97 lines
- `apps/server/src/server.test.ts` · 0m · 22L · 14490 lines
- `apps/server/src/serverRuntimeStartup.reconcile.test.ts` · 0m · 9L · 1343 lines
- `apps/server/src/serverRuntimeStartup.worktreeSetup.test.ts` · 0m · 1L · 161 lines
- `apps/web/src/components/ChatMarkdown.workspace-images.test.tsx` · 0m · 1L · 484 lines
- `apps/web/src/components/QueuedMessageSender.test.tsx` · 0m · 1L · 253 lines
- `apps/web/src/components/chat/sendQueuedMessage.ts` · 0m · 2L · 215 lines
- `apps/web/src/queuedMessageStore.test.ts` · 0m · 1L · 195 lines
- `apps/web/src/queuedMessageStore.ts` · 0m · 2L · 272 lines
- `packages/client-runtime/src/pendingRequests.ts` · 0m · 1L · 201 lines
- `packages/client-runtime/src/platform/persistence.test.ts` · 0m · 3L · 74 lines
- `packages/client-runtime/src/state/threadReducer.test.ts` · 0m · 2L · 1838 lines
- `packages/client-runtime/src/state/threadReducer.ts` · 0m · 5L · 1034 lines
- `packages/client-runtime/src/state/threads-pagination.test.ts` · 0m · 1L · 693 lines
- `packages/contracts/src/orchestration.test.ts` · 0m · 1L · 1744 lines
- `packages/contracts/src/orchestration.ts` · 0m · 32L · 2682 lines

### Q-relocated (86)

- `apps/server/src/orchestration-v2/Layers/ExhaustionResumeSweep.forkFrom.test.ts` · 0m · 2L · 69 lines ← was `apps/server/src/orchestration/Layers/ExhaustionResumeSweep.forkFrom.test.ts`
- `apps/server/src/orchestration-v2/Layers/ExhaustionResumeSweep.ts` · 0m · 6L · 323 lines ← was `apps/server/src/orchestration/Layers/ExhaustionResumeSweep.ts`
- `apps/server/src/orchestration-v2/Layers/HandoffDrafterReactor.test.ts` · 0m · 0L · 550 lines ← was `apps/server/src/orchestration/Layers/HandoffDrafterReactor.test.ts`
- `apps/server/src/orchestration-v2/Layers/HandoffDrafterReactor.ts` · 0m · 0L · 331 lines ← was `apps/server/src/orchestration/Layers/HandoffDrafterReactor.ts`
- `apps/server/src/orchestration-v2/Layers/ProjectionPipeline.goalTasks.test.ts` · 0m · 0L · 227 lines ← was `apps/server/src/orchestration/Layers/ProjectionPipeline.goalTasks.test.ts`
- `apps/server/src/orchestration-v2/Layers/ProviderCommandReactor.engagement.test.ts` · 0m · 0L · 157 lines ← was `apps/server/src/orchestration/Layers/ProviderCommandReactor.engagement.test.ts`
- `apps/server/src/orchestration-v2/Layers/ThreadEmbedder.loom.ts` · 0m · 0L · 332 lines ← was `apps/server/src/orchestration/Layers/ThreadEmbedder.loom.ts`
- `apps/server/src/orchestration-v2/Layers/ThreadSearch.loom.test.ts` · 0m · 0L · 274 lines ← was `apps/server/src/orchestration/Layers/ThreadSearch.loom.test.ts`
- `apps/server/src/orchestration-v2/Layers/ThreadSearch.loom.ts` · 0m · 0L · 276 lines ← was `apps/server/src/orchestration/Layers/ThreadSearch.loom.ts`
- `apps/server/src/orchestration-v2/Layers/WorkstreamDispatcher.test.ts` · 0m · 2L · 8296 lines ← was `apps/server/src/orchestration/Layers/WorkstreamDispatcher.test.ts`
- `apps/server/src/orchestration-v2/Layers/WorkstreamDispatcher.ts` · 0m · 7L · 3677 lines ← was `apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts`
- `apps/server/src/orchestration-v2/Layers/WorkstreamFanInReactor.test.ts` · 0m · 7L · 1463 lines ← was `apps/server/src/orchestration/Layers/WorkstreamFanInReactor.test.ts`
- `apps/server/src/orchestration-v2/Layers/WorkstreamFanInReactor.ts` · 0m · 6L · 1026 lines ← was `apps/server/src/orchestration/Layers/WorkstreamFanInReactor.ts`
- `apps/server/src/orchestration-v2/Layers/WorkstreamLivenessSweep.test.ts` · 0m · 0L · 1237 lines ← was `apps/server/src/orchestration/Layers/WorkstreamLivenessSweep.test.ts`
- `apps/server/src/orchestration-v2/Layers/WorkstreamLivenessSweep.ts` · 0m · 0L · 1211 lines ← was `apps/server/src/orchestration/Layers/WorkstreamLivenessSweep.ts`
- `apps/server/src/orchestration-v2/Layers/WorktreeReaper.test.ts` · 0m · 0L · 446 lines ← was `apps/server/src/orchestration/Layers/WorktreeReaper.test.ts`
- `apps/server/src/orchestration-v2/Layers/WorktreeReaper.ts` · 0m · 0L · 459 lines ← was `apps/server/src/orchestration/Layers/WorktreeReaper.ts`
- `apps/server/src/orchestration-v2/Layers/embedding/EmbeddingProvider.loom.ts` · 0m · 0L · 30 lines ← was `apps/server/src/orchestration/Layers/embedding/EmbeddingProvider.loom.ts`
- `apps/server/src/orchestration-v2/Layers/embedding/local.loom.ts` · 0m · 0L · 55 lines ← was `apps/server/src/orchestration/Layers/embedding/local.loom.ts`
- `apps/server/src/orchestration-v2/Layers/embedding/openaiCompatible.loom.ts` · 0m · 0L · 39 lines ← was `apps/server/src/orchestration/Layers/embedding/openaiCompatible.loom.ts`
- `apps/server/src/orchestration-v2/Layers/embedding/vertex.loom.ts` · 0m · 0L · 85 lines ← was `apps/server/src/orchestration/Layers/embedding/vertex.loom.ts`
- `apps/server/src/orchestration-v2/Services/ExhaustionResumeSweep.ts` · 0m · 0L · 21 lines ← was `apps/server/src/orchestration/Services/ExhaustionResumeSweep.ts`
- `apps/server/src/orchestration-v2/Services/HandoffDrafterReactor.ts` · 0m · 0L · 36 lines ← was `apps/server/src/orchestration/Services/HandoffDrafterReactor.ts`
- `apps/server/src/orchestration-v2/Services/WorkstreamDispatcher.ts` · 0m · 0L · 41 lines ← was `apps/server/src/orchestration/Services/WorkstreamDispatcher.ts`
- `apps/server/src/orchestration-v2/Services/WorkstreamFanInReactor.ts` · 0m · 0L · 24 lines ← was `apps/server/src/orchestration/Services/WorkstreamFanInReactor.ts`
- `apps/server/src/orchestration-v2/Services/WorkstreamLivenessSweep.ts` · 0m · 0L · 20 lines ← was `apps/server/src/orchestration/Services/WorkstreamLivenessSweep.ts`
- `apps/server/src/orchestration-v2/Services/WorktreeReaper.ts` · 0m · 0L · 33 lines ← was `apps/server/src/orchestration/Services/WorktreeReaper.ts`
- `apps/server/src/orchestration-v2/WorkstreamWorktreeStatus.ts` · 0m · 3L · 249 lines ← was `apps/server/src/orchestration/WorkstreamWorktreeStatus.ts`
- `apps/server/src/orchestration-v2/briefNeeded.ts` · 0m · 0L · 205 lines ← was `apps/server/src/orchestration/briefNeeded.ts`
- `apps/server/src/orchestration-v2/briefNeededOutwardAttention.ts` · 0m · 0L · 154 lines ← was `apps/server/src/orchestration/briefNeededOutwardAttention.ts`
- `apps/server/src/orchestration-v2/commandInvariants.loom.ts` · 0m · 0L · 212 lines ← was `apps/server/src/orchestration/commandInvariants.loom.ts`
- `apps/server/src/orchestration-v2/decider.attentionTerminal.test.ts` · 0m · 0L · 143 lines ← was `apps/server/src/orchestration/decider.attentionTerminal.test.ts`
- `apps/server/src/orchestration-v2/decider.cancelCascade.test.ts` · 0m · 0L · 254 lines ← was `apps/server/src/orchestration/decider.cancelCascade.test.ts`
- `apps/server/src/orchestration-v2/decider.dependencies.test.ts` · 0m · 0L · 413 lines ← was `apps/server/src/orchestration/decider.dependencies.test.ts`
- `apps/server/src/orchestration-v2/decider.errorGuard.test.ts` · 0m · 0L · 151 lines ← was `apps/server/src/orchestration/decider.errorGuard.test.ts`
- `apps/server/src/orchestration-v2/decider.goalCascade.test.ts` · 0m · 0L · 291 lines ← was `apps/server/src/orchestration/decider.goalCascade.test.ts`
- `apps/server/src/orchestration-v2/decider.goalTasksRewrite.test.ts` · 0m · 0L · 315 lines ← was `apps/server/src/orchestration/decider.goalTasksRewrite.test.ts`
- `apps/server/src/orchestration-v2/decider.handoffRecord.test.ts` · 0m · 0L · 95 lines ← was `apps/server/src/orchestration/decider.handoffRecord.test.ts`
- `apps/server/src/orchestration-v2/decider.isolation.test.ts` · 0m · 1L · 322 lines ← was `apps/server/src/orchestration/decider.isolation.test.ts`
- `apps/server/src/orchestration-v2/decider.loom.ts` · 0m · 0L · 1638 lines ← was `apps/server/src/orchestration/decider.loom.ts`
- `apps/server/src/orchestration-v2/decider.noOpGuards.test.ts` · 0m · 0L · 282 lines ← was `apps/server/src/orchestration/decider.noOpGuards.test.ts`
- `apps/server/src/orchestration-v2/decider.peerMessage.test.ts` · 0m · 0L · 211 lines ← was `apps/server/src/orchestration/decider.peerMessage.test.ts`
- `apps/server/src/orchestration-v2/decider.projectWorkspaceRoot.test.ts` · 0m · 0L · 85 lines ← was `apps/server/src/orchestration/decider.projectWorkspaceRoot.test.ts`
- `apps/server/src/orchestration-v2/decider.reviewGate.test.ts` · 0m · 0L · 780 lines ← was `apps/server/src/orchestration/decider.reviewGate.test.ts`
- `apps/server/src/orchestration-v2/decider.scaffold.test.ts` · 0m · 0L · 299 lines ← was `apps/server/src/orchestration/decider.scaffold.test.ts`
- `apps/server/src/orchestration-v2/decider.userInputRespond.test.ts` · 0m · 0L · 159 lines ← was `apps/server/src/orchestration/decider.userInputRespond.test.ts`
- `apps/server/src/orchestration-v2/decider.userInputSupersede.test.ts` · 0m · 0L · 233 lines ← was `apps/server/src/orchestration/decider.userInputSupersede.test.ts`
- `apps/server/src/orchestration-v2/decider.workSubmit.test.ts` · 0m · 0L · 394 lines ← was `apps/server/src/orchestration/decider.workSubmit.test.ts`
- `apps/server/src/orchestration-v2/deciderTestThread.ts` · 0m · 0L · 30 lines ← was `apps/server/src/orchestration/deciderTestThread.ts`
- `apps/server/src/orchestration-v2/goalTaskAnchor.loom.test.ts` · 0m · 0L · 252 lines ← was `apps/server/src/orchestration/goalTaskAnchor.loom.test.ts`
- `apps/server/src/orchestration-v2/goalTaskAnchor.loom.ts` · 0m · 0L · 145 lines ← was `apps/server/src/orchestration/goalTaskAnchor.loom.ts`
- `apps/server/src/orchestration-v2/goalTaskCommands.ts` · 0m · 0L · 103 lines ← was `apps/server/src/orchestration/goalTaskCommands.ts`
- `apps/server/src/orchestration-v2/goalTaskMarkdown.test.ts` · 0m · 0L · 246 lines ← was `apps/server/src/orchestration/goalTaskMarkdown.test.ts`
- `apps/server/src/orchestration-v2/goalTaskMarkdown.ts` · 0m · 0L · 217 lines ← was `apps/server/src/orchestration/goalTaskMarkdown.ts`
- `apps/server/src/orchestration-v2/goalTaskRender.ts` · 0m · 0L · 204 lines ← was `apps/server/src/orchestration/goalTaskRender.ts`
- `apps/server/src/orchestration-v2/goalTaskTree.ts` · 0m · 0L · 93 lines ← was `apps/server/src/orchestration/goalTaskTree.ts`
- `apps/server/src/orchestration-v2/orphanWorktreeSweep.ts` · 0m · 0L · 54 lines ← was `apps/server/src/orchestration/orphanWorktreeSweep.ts`
- `apps/server/src/orchestration-v2/projector.loom.ts` · 0m · 0L · 636 lines ← was `apps/server/src/orchestration/projector.loom.ts`
- `apps/server/src/orchestration-v2/receiptDedup.test.ts` · 0m · 0L · 207 lines ← was `apps/server/src/orchestration/receiptDedup.test.ts`
- `apps/server/src/orchestration-v2/receiptDedup.ts` · 0m · 0L · 235 lines ← was `apps/server/src/orchestration/receiptDedup.ts`
- `apps/server/src/orchestration-v2/roleOverlay.test.ts` · 0m · 0L · 334 lines ← was `apps/server/src/orchestration/roleOverlay.test.ts`
- `apps/server/src/orchestration-v2/roleOverlay.ts` · 0m · 0L · 242 lines ← was `apps/server/src/orchestration/roleOverlay.ts`
- `apps/server/src/orchestration-v2/stallContext.test.ts` · 0m · 0L · 69 lines ← was `apps/server/src/orchestration/stallContext.test.ts`
- `apps/server/src/orchestration-v2/stallContext.ts` · 0m · 0L · 120 lines ← was `apps/server/src/orchestration/stallContext.ts`
- `apps/server/src/orchestration-v2/stuckLaunchRecovery.test.ts` · 0m · 0L · 529 lines ← was `apps/server/src/orchestration/stuckLaunchRecovery.test.ts`
- `apps/server/src/orchestration-v2/stuckLaunchRecovery.ts` · 0m · 1L · 427 lines ← was `apps/server/src/orchestration/stuckLaunchRecovery.ts`
- `apps/server/src/orchestration-v2/threadIdle.ts` · 0m · 0L · 63 lines ← was `apps/server/src/orchestration/threadIdle.ts`
- `apps/server/src/orchestration-v2/threadResolve.test.ts` · 0m · 0L · 134 lines ← was `apps/server/src/orchestration/threadResolve.test.ts`
- `apps/server/src/orchestration-v2/threadResolve.ts` · 0m · 0L · 108 lines ← was `apps/server/src/orchestration/threadResolve.ts`
- `apps/server/src/orchestration-v2/userInputSettlement.test.ts` · 0m · 0L · 664 lines ← was `apps/server/src/orchestration/userInputSettlement.test.ts`
- `apps/server/src/orchestration-v2/userInputSettlement.ts` · 0m · 0L · 343 lines ← was `apps/server/src/orchestration/userInputSettlement.ts`
- `apps/server/src/orchestration-v2/workstreamAsk.test.ts` · 0m · 0L · 195 lines ← was `apps/server/src/orchestration/workstreamAsk.test.ts`
- `apps/server/src/orchestration-v2/workstreamAsk.ts` · 0m · 0L · 329 lines ← was `apps/server/src/orchestration/workstreamAsk.ts`
- `apps/server/src/orchestration-v2/workstreamBrief.test.ts` · 0m · 0L · 47 lines ← was `apps/server/src/orchestration/workstreamBrief.test.ts`
- `apps/server/src/orchestration-v2/workstreamBrief.ts` · 0m · 0L · 68 lines ← was `apps/server/src/orchestration/workstreamBrief.ts`
- `apps/server/src/orchestration-v2/workstreamChildPrompt.test.ts` · 0m · 2L · 71 lines ← was `apps/server/src/orchestration/workstreamChildPrompt.test.ts`
- `apps/server/src/orchestration-v2/workstreamChildPrompt.ts` · 0m · 1L · 60 lines ← was `apps/server/src/orchestration/workstreamChildPrompt.ts`
- `apps/server/src/orchestration-v2/workstreamLaunchIdentity.test.ts` · 0m · 1L · 221 lines ← was `apps/server/src/orchestration/workstreamLaunchIdentity.test.ts`
- `apps/server/src/orchestration-v2/workstreamLaunchIdentity.ts` · 0m · 0L · 209 lines ← was `apps/server/src/orchestration/workstreamLaunchIdentity.ts`
- `apps/server/src/orchestration-v2/workstreamPromptDebug.ts` · 0m · 0L · 99 lines ← was `apps/server/src/orchestration/workstreamPromptDebug.ts`
- `apps/server/src/orchestration-v2/workstreamReport.test.ts` · 0m · 1L · 35 lines ← was `apps/server/src/orchestration/workstreamReport.test.ts`
- `apps/server/src/orchestration-v2/workstreamReport.ts` · 0m · 2L · 88 lines ← was `apps/server/src/orchestration/workstreamReport.ts`
- `apps/server/src/orchestration-v2/worktreeClassification.test.ts` · 0m · 0L · 188 lines ← was `apps/server/src/orchestration/worktreeClassification.test.ts`
- `apps/server/src/orchestration-v2/worktreeClassification.ts` · 0m · 0L · 209 lines ← was `apps/server/src/orchestration/worktreeClassification.ts`
- `apps/server/src/orchestration-v2/worktreeRemoval.ts` · 0m · 1L · 82 lines ← was `apps/server/src/orchestration/worktreeRemoval.ts`
- `apps/server/src/orchestration-v2/worktreeRemovalDeferral.ts` · 0m · 0L · 61 lines ← was `apps/server/src/orchestration/worktreeRemovalDeferral.ts`

### T-client-runtime (21)

- `packages/client-runtime/src/connection/driver.ts` · 5m · 1L · 112 lines
- `packages/client-runtime/src/connection/registry.test.ts` · 1m · 1L · 1546 lines
- `packages/client-runtime/src/operations/commands.ts` · 3m · 6L · 481 lines
- `packages/client-runtime/src/remotePerformance.bench.ts` · 1m · 1L · 166 lines
- `packages/client-runtime/src/state/entities.test.ts` · 6m · 1L · 660 lines
- `packages/client-runtime/src/state/environmentHttpAuth.test.ts` · 2m · 1L · 562 lines
- `packages/client-runtime/src/state/orchestration.ts` · 1m · 0L · 48 lines
- `packages/client-runtime/src/state/server.ts` · 3m · 3L · 1190 lines
- `packages/client-runtime/src/state/shell-sync.test.ts` · 15m · 2L · 742 lines
- `packages/client-runtime/src/state/shell.test.ts` · 1m · 0L · 132 lines
- `packages/client-runtime/src/state/shell.ts` · 7m · 4L · 425 lines
- `packages/client-runtime/src/state/shellReducer.test.ts` · 4m · 1L · 250 lines
- `packages/client-runtime/src/state/shellReducer.ts` · 1m · 2L · 67 lines
- `packages/client-runtime/src/state/threadCommands.test.ts` · 1m · 0L · 361 lines
- `packages/client-runtime/src/state/threadCommands.ts` · 9m · 3L · 420 lines
- `packages/client-runtime/src/state/threadDetail.ts` · 1m · 2L · 185 lines
- `packages/client-runtime/src/state/threadSnoozed.test.ts` · 1m · 0L · 373 lines
- `packages/client-runtime/src/state/threads-atoms.test.ts` · 1m · 0L · 897 lines
- `packages/client-runtime/src/state/threads-sync.test.ts` · 1m · 1L · 1098 lines
- `packages/client-runtime/src/state/threads.ts` · 1m · 1L · 981 lines
- `packages/client-runtime/src/work-log/userInput.ts` · 1m · 1L · 197 lines

### T-contracts (9)

- `packages/contracts/src/composerContext.test.ts` · 3m · 2L · 288 lines
- `packages/contracts/src/composerContext.ts` · 2m · 8L · 298 lines
- `packages/contracts/src/index.ts` · 1m · 0L · 48 lines
- `packages/contracts/src/keybindings.ts` · 1m · 2L · 239 lines
- `packages/contracts/src/model.ts` · 3m · 3L · 257 lines
- `packages/contracts/src/providerRuntime.ts` · 1m · 3L · 1353 lines
- `packages/contracts/src/rpc.ts` · 5m · 16L · 1747 lines
- `packages/contracts/src/server.ts` · 1m · 3L · 1056 lines
- `packages/contracts/src/settings.ts` · 3m · 16L · 1749 lines

### T-lock/config (7)

- `apps/server/package.json` · 1m · 0L · 62 lines
- `apps/web/package.json` · 2m · 0L · 92 lines
- `infra/relay/scripts/android-push-watch.ts` · 2m · 1L · 236 lines
- `packages/client-runtime/package.json` · 1m · 0L · 328 lines
- `pnpm-lock.yaml` · 21m · 0L · 23435 lines
- `scripts/dev-runner.test.ts` · 1m · 8L · 1494 lines
- `scripts/lib/cli-external-packages.test.ts` · 1m · 2L · 356 lines

### T-mobile (12)

- `apps/mobile/src/connection/environment-cache-store.test.ts` · 2m · 0L · 223 lines
- `apps/mobile/src/features/archive/archivedThreadList.test.ts` · 1m · 2L · 183 lines
- `apps/mobile/src/features/home/HomeScreen.tsx` · 3m · 8L · 1099 lines
- `apps/mobile/src/features/home/homeThreadList.test.ts` · 2m · 1L · 324 lines
- `apps/mobile/src/features/threads/ThreadArrangementSheet.tsx` · 1m · 0L · 564 lines
- `apps/mobile/src/features/threads/ThreadDetailScreen.tsx` · 1m · 1L · 1119 lines
- `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` · 1m · 6L · 1180 lines
- `apps/mobile/src/features/threads/threadListV2.test.ts` · 1m · 1L · 2048 lines
- `apps/mobile/src/lib/threadActivity.test.ts` · 1m · 1L · 3780 lines
- `apps/mobile/src/lib/threadActivity.ts` · 1m · 0L · 2505 lines
- `apps/mobile/src/state/pending-thread-creation.ts` · 2m · 0L · 170 lines
- `apps/mobile/src/state/use-thread-selection.ts` · 1m · 1L · 239 lines

### T-server-core (10)

- `apps/server/src/auth/RpcAuthorization.ts` · 1m · 1L · 216 lines
- `apps/server/src/bin.ts` · 1m · 0L · 97 lines
- `apps/server/src/cli/config.ts` · 2m · 5L · 583 lines
- `apps/server/src/cli/project.ts` · 4m · 1L · 569 lines
- `apps/server/src/cli/server.ts` · 2m · 2L · 44 lines
- `apps/server/src/orchestration-v2/PullRequestSyncReactor.test.ts` · 2m · 1L · 979 lines
- `apps/server/src/server.ts` · 5m · 15L · 1053 lines
- `apps/server/src/serverRuntimeStartup.test.ts` · 6m · 2L · 710 lines
- `apps/server/src/serverRuntimeStartup.ts` · 8m · 28L · 1298 lines
- `apps/server/src/ws.ts` · 24m · 39L · 4852 lines

### T-server-other (20)

- `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts` · 5m · 6L · 606 lines
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 2m · 1L · 308 lines
- `apps/server/src/checkpointing/Utils.ts` · 1m · 0L · 42 lines
- `apps/server/src/git/GitManager.ts` · 1m · 2L · 3038 lines
- `apps/server/src/git/GitWorkflowService.ts` · 2m · 1L · 478 lines
- `apps/server/src/git/linkCreatedPullRequest.test.ts` · 1m · 0L · 232 lines
- `apps/server/src/project/AgentSessionImporter.test.ts` · 2m · 4L · 1238 lines
- `apps/server/src/project/AgentSessionScanner.test.ts` · 1m · 1L · 3202 lines
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 4m · 7L · 806 lines
- `apps/server/src/project/ProjectSetupScriptRunner.ts` · 2m · 12L · 494 lines
- `apps/server/src/relay/AgentAwarenessRelay.test.ts` · 8m · 4L · 1181 lines
- `apps/server/src/relay/AgentAwarenessRelay.ts` · 7m · 2L · 702 lines
- `apps/server/src/terminal/Manager.test.ts` · 2m · 2L · 2744 lines
- `apps/server/src/terminal/Manager.ts` · 2m · 3L · 3151 lines
- `apps/server/src/textGeneration/CursorTextGeneration.ts` · 1m · 2L · 280 lines
- `apps/server/src/textGeneration/TextGeneration.ts` · 1m · 6L · 218 lines
- `apps/server/src/usage/UsageLimitSources.ts` · 2m · 3L · 193 lines
- `apps/server/src/vcs/GitVcsDriver.ts` · 1m · 1L · 1337 lines
- `apps/server/src/vcs/GitVcsDriverCore.ts` · 3m · 7L · 4303 lines
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` · 2m · 3L · 872 lines

### T-server-persistence (5)

- `apps/server/src/persistence/Layers/OrchestrationEventStore.ts` · 7m · 3L · 531 lines
- `apps/server/src/persistence/Layers/Sqlite.ts` · 1m · 3L · 70 lines
- `apps/server/src/persistence/Migrations.ts` · 1m · 1L · 179 lines
- `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` · 2m · 0L · 72 lines
- `apps/server/src/persistence/Services/OrchestrationEventStore.ts` · 1m · 1L · 135 lines

### T-server-provider/mcp (13)

- `apps/server/src/mcp/McpInvocationContext.ts` · 1m · 0L · 57 lines
- `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts` · 2m · 1L · 359 lines
- `apps/server/src/provider/Layers/ClaudeProvider.ts` · 1m · 4L · 1174 lines
- `apps/server/src/provider/Layers/CursorProvider.test.ts` · 1m · 1L · 1214 lines
- `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts` · 2m · 2L · 814 lines
- `apps/server/src/provider/Layers/ProviderRegistry.test.ts` · 6m · 7L · 3256 lines
- `apps/server/src/provider/Layers/ProviderUsageLimitsIngestion.ts` · 1m · 0L · 49 lines
- `apps/server/src/provider/acp/AcpSessionRuntime.ts` · 2m · 1L · 1367 lines
- `apps/server/src/provider/acp/XAiAcpExtension.ts` · 2m · 0L · 690 lines
- `apps/server/src/provider/builtInDrivers.ts` · 3m · 1L · 39 lines
- `apps/server/src/provider/makeManagedServerProvider.ts` · 1m · 5L · 385 lines
- `apps/server/src/provider/opencodeRuntime.ts` · 1m · 0L · 1103 lines
- `apps/server/src/provider/providerCompatibility.test.ts` · 1m · 2L · 333 lines

### T-shared (5)

- `packages/shared/src/composerContextReferences.ts` · 1m · 5L · 316 lines
- `packages/shared/src/composerInlineTokens.ts` · 1m · 2L · 170 lines
- `packages/shared/src/serverSettings.ts` · 1m · 3L · 459 lines
- `packages/shared/src/threadSettled.ts` · 1m · 2L · 343 lines
- `packages/shared/src/toolActivity.ts` · 1m · 0L · 294 lines

### T-web-chat (18)

- `apps/web/src/components/ChatView.logic.test.ts` · 4m · 5L · 2437 lines
- `apps/web/src/components/ChatView.logic.ts` · 1m · 2L · 1395 lines
- `apps/web/src/components/ChatView.tsx` · 20m · 58L · 10870 lines
- `apps/web/src/components/chat/ChatComposer.tsx` · 9m · 48L · 7299 lines
- `apps/web/src/components/chat/ChatHeader.tsx` · 4m · 4L · 561 lines
- `apps/web/src/components/chat/ComposerCommandMenu.tsx` · 2m · 5L · 299 lines
- `apps/web/src/components/chat/ComposerPendingUserInputPanel.tsx` · 2m · 22L · 355 lines
- `apps/web/src/components/chat/MessagesTimeline.logic.test.ts` · 3m · 2L · 3900 lines
- `apps/web/src/components/chat/MessagesTimeline.logic.ts` · 5m · 10L · 1745 lines
- `apps/web/src/components/chat/MessagesTimeline.tsx` · 7m · 28L · 5111 lines
- `apps/web/src/components/chat/ModelPickerContent.tsx` · 1m · 2L · 1131 lines
- `apps/web/src/components/chat/OpenInPicker.tsx` · 1m · 1L · 406 lines
- `apps/web/src/components/chat/ProviderModelPicker.tsx` · 1m · 2L · 321 lines
- `apps/web/src/components/composerContextPresentation.tsx` · 4m · 5L · 452 lines
- `apps/web/src/composerDraftStore.ts` · 14m · 54L · 4589 lines
- `apps/web/src/session-logic.test.ts` · 1m · 1L · 2519 lines
- `apps/web/src/session-logic.ts` · 5m · 5L · 1807 lines
- `apps/web/src/types.ts` · 1m · 1L · 104 lines

### T-web-panels/other (20)

- `apps/web/src/components/DiffPanel.tsx` · 22m · 25L · 1516 lines
- `apps/web/src/components/RightPanelTabs.test.tsx` · 2m · 0L · 334 lines
- `apps/web/src/components/RightPanelTabs.tsx` · 5m · 20L · 1515 lines
- `apps/web/src/components/contextPresentationRegistry.ts` · 1m · 1L · 132 lines
- `apps/web/src/components/files/FilePreviewPanel.tsx` · 1m · 9L · 1504 lines
- `apps/web/src/components/settings/ProviderSettingsPanel.environment.test.tsx` · 1m · 2L · 418 lines
- `apps/web/src/components/settings/SettingsPanels.tsx` · 1m · 8L · 3596 lines
- `apps/web/src/components/settings/providerDriverMeta.ts` · 1m · 0L · 113 lines
- `apps/web/src/components/usage/usageProviders.ts` · 1m · 1L · 71 lines
- `apps/web/src/composer-logic.ts` · 1m · 5L · 322 lines
- `apps/web/src/connection/storage.ts` · 2m · 2L · 815 lines
- `apps/web/src/diffPanelStore.ts` · 4m · 6L · 201 lines
- `apps/web/src/hooks/useThreadActions.ts` · 1m · 1L · 941 lines
- `apps/web/src/index.css` · 1m · 8L · 3019 lines
- `apps/web/src/lib/composerContextRecords.ts` · 1m · 8L · 546 lines
- `apps/web/src/rightPanelStore.ts` · 3m · 3L · 1128 lines
- `apps/web/src/state/entities.ts` · 1m · 2L · 294 lines
- `apps/web/src/state/shell.test.ts` · 1m · 0L · 137 lines
- `apps/web/src/state/threads.test.ts` · 2m · 1L · 202 lines
- `apps/web/src/state/threads.ts` · 1m · 1L · 135 lines

### T-web-sidebar (11)

- `apps/web/src/components/CommandPalette.tsx` · 3m · 9L · 3536 lines
- `apps/web/src/components/Sidebar.logic.test.ts` · 6m · 2L · 2802 lines
- `apps/web/src/components/Sidebar.logic.ts` · 7m · 11L · 1434 lines
- `apps/web/src/components/Sidebar.tsx` · 11m · 23L · 5244 lines
- `apps/web/src/components/ThreadNotificationCoordinator.test.tsx` · 1m · 1L · 264 lines
- `apps/web/src/components/ThreadNotificationCoordinator.tsx` · 1m · 4L · 236 lines
- `apps/web/src/components/ThreadRouteView.tsx` · 3m · 4L · 241 lines
- `apps/web/src/components/ThreadStatusIndicators.tsx` · 3m · 1L · 848 lines
- `apps/web/src/hooks/useHandleNewThread.ts` · 1m · 11L · 515 lines
- `apps/web/src/routes/__root.tsx` · 2m · 2L · 654 lines
- `apps/web/src/routes/_chat.pull-requests.tsx` · 2m · 1L · 2602 lines

### X-detach seed list (71) — Q = Loom-only (quarantine whole), H = upstream-shared (drop hunk behind `// loom:`)

- H `apps/mobile/src/features/threads/thread-list-v2-items.tsx` — Loom field: pendingUserInputHeader, pendingUserInputSince
- Q `apps/server/src/cli/goal.ts` — V1 import: goalTaskCommands.ts, goalTaskMarkdown.ts, goalTaskRender.ts; V1 name: ClientOrchestrationCommand, OrchestrationReadModel
- Q `apps/server/src/cli/orchestrationMutation.ts` — V1 import: runtimeLayer.ts; V1 name: ClientOrchestrationCommand, OrchestrationReadModel
- Q `apps/server/src/dev/seedWorkstream.ts` — V1 import: runtimeLayer.ts; V1 name: OrchestrationCheckpointFile
- Q `apps/server/src/dev/threadSearchEval.loom.ts` — V1 import: ThreadEmbedder.loom.ts, ThreadSearch.loom.ts
- Q `apps/server/src/dev/verifySeed.ts` — V1 import: runtimeLayer.ts
- Q `apps/server/src/loom/handoffDraft.test.ts` — V1 import: workstreamLaunchIdentity.ts; V1 name: OrchestrationThread
- Q `apps/server/src/loom/handoffDraft.ts` — V1 import: workstreamLaunchIdentity.ts; V1 name: OrchestrationCommand, OrchestrationThread
- Q `apps/server/src/loom/retroDraft.test.ts` — V1 name: OrchestrationThread
- Q `apps/server/src/loom/retroDraft.ts` — V1 name: OrchestrationCommand, OrchestrationThread
- Q `apps/server/src/loom/serverLayers.ts` — V1 import: ExhaustionResumeSweep.ts, HandoffDrafterReactor.ts, WorkstreamDispatcher.ts
- Q `apps/server/src/loom/startup.ts` — V1 import: ExhaustionResumeSweep.ts, WorkstreamLivenessSweep.ts, stuckLaunchRecovery.ts
- Q `apps/server/src/loom/wsMethods.ts` — V1 import: WorkstreamWorktreeStatus.ts
- Q `apps/server/src/mcp/GoalHandoffHttp.ts` — V1 import: goalTaskCommands.ts; V1 name: OrchestrationCommand
- Q `apps/server/src/mcp/GoalTaskHttp.ts` — V1 import: goalTaskAnchor.loom.ts, goalTaskCommands.ts, goalTaskMarkdown.ts; V1 name: OrchestrationCommand
- Q `apps/server/src/mcp/ThreadForkHttp.ts` — V1 name: OrchestrationCommand
- Q `apps/server/src/mcp/WorkstreamSpawnHttp.test.ts` — V1 name: OrchestrationCommand, OrchestrationThreadShell
- Q `apps/server/src/mcp/WorkstreamSpawnHttp.ts` — V1 import: goalTaskAnchor.loom.ts, goalTaskTree.ts, threadIdle.ts; V1 name: OrchestrationCommand, OrchestrationThreadShell
- H `apps/server/src/mcp/toolkits/pullRequests/handlers.test.ts` — V1 import: deciderTestThread.ts; V1 name: OrchestrationCommand
- Q `apps/server/src/persistence/Layers/SqliteLanes.ts` — V1 import: ThreadEmbedder.loom.ts, ThreadBackgroundLiveness.ts, ThreadPlanProgress.ts
- H `apps/server/src/persistence/ProviderSessionRuntime.ts` — V1 name: ProviderSessionRuntimeStatus
- Q `apps/server/src/project/WorktreeProvisioner.test.ts` — V1 name: OrchestrationCommand
- Q `apps/server/src/project/WorktreeProvisioner.ts` — V1 name: OrchestrationCommand
- Q `apps/server/src/project/worktreeSetupRecord.loom.ts` — V1 name: OrchestrationCommand
- Q `apps/server/src/provider/Drivers/Pi/askUserBroker.ts` — V1 import: userInputSettlement.ts
- Q `apps/server/src/provider/Drivers/Pi/providerToolDefs.ts` — V1 import: goalTaskMarkdown.ts
- Q `apps/server/src/provider/Drivers/PiDriver.forkFrom.test.ts` — V1 import: workstreamLaunchIdentity.ts
- Q `apps/server/src/workspace/foreignHomeGuard.loom.test.ts` — V1 import: worktreeRemoval.ts
- H `apps/web/src/components/CommandPalette.logic.test.ts` — Loom field: goalId
- Q `apps/web/src/components/Sidebar.logic.loom.ts` — Loom field: goalId, parentThreadId, planLane
- H `apps/web/src/components/ThreadStatusIndicators.test.ts` — V1 name: OrchestrationThreadShell
- Q `apps/web/src/components/WorkstreamActiveStrip.tsx` — Loom field: cumulativeCostUsd, lastActivityPreview
- Q `apps/web/src/components/WorkstreamGraph.tsx` — Loom field: blockedBy, forkFromThreadId, gateRounds, lastOutcome
- Q `apps/web/src/components/WorkstreamPanel.tsx` — Loom field: blockedBy, cumulativeCostUsd, diffAdditions, diffDeletions
- Q `apps/web/src/components/WorkstreamQuickFacts.tsx` — Loom field: cumulativeCostUsd, forkFromThreadId, gateRounds, lastActivityPreview
- Q `apps/web/src/components/WorkstreamTimeline.tsx` — V1 name: OrchestrationEvent; Loom field: promptDebugPath, reportPath
- Q `apps/web/src/components/chat/ForkedFromBadge.tsx` — Loom field: forkFromThreadId
- Q `apps/web/src/components/chat/StagedBriefPreviewCard.tsx` — Loom field: kickoffBriefPath
- Q `apps/web/src/components/chat/StagedKickoffCard.tsx` — Loom field: parentThreadId
- Q `apps/web/src/hooks/useForkThread.ts` — Loom field: goalId
- Q `apps/web/src/lib/forkJoinLayout.test.ts` — Loom field: blockedBy, consults, parentThreadId, spawnGeneration
- Q `apps/web/src/lib/forkJoinLayout.ts` — Loom field: blockedBy, consults, parentThreadId, spawnGeneration
- Q `apps/web/src/lib/threadMention.ts` — Loom field: planLane
- H `apps/web/src/lib/threadSort.test.ts` — Loom field: goalId
- Q `apps/web/src/lib/workstreamPresentation.test.ts` — V1 name: OrchestrationEvent; Loom field: reportPath
- Q `apps/web/src/lib/workstreamPresentation.ts` — V1 name: OrchestrationEvent; Loom field: blockedBy, fanInState, gateRounds, kickoffBriefPath
- Q `apps/web/src/lib/workstreamRollup.test.ts` — Loom field: blockedBy, planLane
- Q `apps/web/src/lib/workstreamRollup.ts` — Loom field: parentThreadId, planLane
- Q `apps/web/src/loom/ControlDigestCard.tsx` — Loom field: reportPath
- Q `apps/web/src/loom/ControlDigestRow.tsx` — Loom field: controlPayload
- Q `apps/web/src/loom/GoalThreadsSection.tsx` — Loom field: goalId, planLane
- Q `apps/web/src/loom/TaskThreadChips.tsx` — Loom field: anchorTaskId, goalId, planLane
- Q `apps/web/src/loom/contextCost.ts` — Loom field: cumulativeCostUsd
- Q `apps/web/src/loom/controlMessages.ts` — Loom field: controlPayload
- Q `apps/web/src/loom/goalThreadChain.ts` — Loom field: continuesThreadId
- Q `apps/web/src/loom/handoffReceipts.logic.ts` — Loom field: handoffDestinations
- Q `apps/web/src/loom/rootThreads.ts` — Loom field: parentThreadId
- Q `apps/web/src/loom/sidebarGoalActions.ts` — Loom field: goalId
- Q `apps/web/src/loom/useGoalPanelActions.ts` — Loom field: goalId
- Q `apps/web/src/loom/useLoomThreadExtensions.ts` — Loom field: goalId, parentThreadId
- Q `apps/web/src/threadRouteLineage.ts` — Loom field: parentThreadId
- H `apps/web/src/worktreeCleanup.test.ts` — Loom field: goalId
- Q `packages/client-runtime/src/state/threadFixtureDefaults.ts` — V1 name: OrchestrationThreadShell
- H `packages/client-runtime/src/state/threadRelationships.test.ts` — Loom field: parentThreadId
- H `packages/client-runtime/src/state/threadRelationships.ts` — Loom field: parentThreadId
- Q `packages/shared/src/threadSettled.test.ts` — V1 name: OrchestrationThreadShell
- Q `packages/shared/src/workstreamDependencies.test.ts` — Loom field: blockedBy, fanInState, parentThreadId, planLane
- Q `packages/shared/src/workstreamDependencies.ts` — V1 name: OrchestrationThread, OrchestrationThreadShell; Loom field: blockedBy, fanInState, parentThreadId, planLane
- Q `packages/shared/src/workstreamGraph.test.ts` — Loom field: graphKey, parentThreadId, planLane, spawnGeneration
- Q `packages/shared/src/workstreamGraph.ts` — V1 name: OrchestrationThread, OrchestrationThreadShell; Loom field: blockedBy, cumulativeCostUsd, fanInState, forkFromThreadId
- Q `packages/shared/src/workstreamIsolation.ts` — Loom field: fanInState, planLane

## Appendix C — the detach ledger

Every Loom surface Phase 1 removes from the build, with what it did, what it
depended on, how it left, and the phase that re-hangs it. **S1 and S3 append
rows here**; §9 requires the table to be complete. Rows `DT-1`–`DT-20` are
the 95 modify/delete files grouped by module (the Loom hunks in them, from
doc 02's inventory, so nothing is lost silently); rows from `DT-21` are the
quarantine and hunk-drop rows the sessions write (the seed list in Appendix B
X is the starting point). `how` ∈ quarantined · deleted with upstream ·
import dropped · hunk dropped · renders nothing · orphaned. `phase` ∈ 2 · 3a ·
3b · 3c · 3d · 4 · isolation-option.

| id    | path(s)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | what it rendered or served (Loom's part)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | V1 names / fields it depended on                                                 | how                                                                                                        | phase                                                                                                                                                           |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DT-1  | `apps/server/src/orchestration/decider.ts` (36 `loom:`), `decider.*.test.ts` (10 files), `commandInvariants.test.ts`, `messageContext.test.ts`                                                                                                                                                                                                                                                                                                                                                                                | the delegation guard arm into `decider.loom.ts`; in-place hunks: `project.create/delete` goal cascade, `thread.create` workstream validation + `titleState: manual`, archive/unarchive subtree + goal cascade, `thread.settle/auto-settle` blockers, sole-thread rename → goal, `thread.turn.start` (atomic kickoff `setInProgress`, first-turn dependency gate, §7 clear-all attention, sticky terminal, `reopen`, supersede-open-question, started-dependents warning), `thread.turn.interrupt` human-stop → `needs_guidance`, `openBlockingRequests` snooze predicate | V1 decider, `OrchestrationCommand/Event` unions                                  | deleted with upstream                                                                                      | 2 (hunk inventory: decide switch guard arm, `message.dispatch`, `run.interrupt`, archive/unarchive/delete, auto-settle, metadata rename, `project` deletion)    |
| DT-2  | `orchestration/projector.ts` (15), `projector.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | projector delegation guard into `projector.loom.ts`; `updateThread` export; Loom event folding                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | V1 projector                                                                     | deleted with upstream                                                                                      | 2 (Loom projector into `loom_*` tables)                                                                                                                         |
| DT-3  | `orchestration/Layers/OrchestrationEngine.ts` (6) + test, `Services/OrchestrationEngine.ts`, `Errors.ts`, `Schemas.ts`, `http.ts`                                                                                                                                                                                                                                                                                                                                                                                             | `requireIdle` defer-not-reject gate, notify-target liveness check, no-event-success accepted receipt, eager `subscribeDomainEvents`, `readStreamEvents` replay; Loom error classes; payload re-exports                                                                                                                                                                                                                                                                                                                                                                   | engine boundary                                                                  | deleted with upstream                                                                                      | 2 (the two dispatch/receipt-core hunks: deferral without receipt, zero-event acceptance)                                                                        |
| DT-4  | `Layers/ProjectionPipeline.ts` (12) + tests, `Layers/ProjectionSnapshotQuery.ts` (30) + test, `Services/ProjectionSnapshotQuery.ts` (6)                                                                                                                                                                                                                                                                                                                                                                                       | ~35 Loom columns projected; ~20 read methods (`getLeanShellSnapshot`, `getPendingTurnStartThreadIds`, `getActivityFreshnessByThreadId`, `getInFlightToolByThreadId`, `getThreadProgressSignal`, `listPendingPeerMessages`, `getArchivedFannedInWorktreeChildren`, `getReferencedWorktreePaths`, `getBriefNeededAttentionParentIds`, `getLiveSubtreeSessionLiveness`, `getGoalById`, `getThreadLifecycle`, `getThreadObligations`, …); derived attention at the read boundary                                                                                             | V1 projections                                                                   | deleted with upstream (`getReferencedWorktreePaths` re-expressed under DL-81)                              | 2 (sidecar projector + shell join), 3b (control-plane reads)                                                                                                    |
| DT-5  | `Layers/ProviderCommandReactor.ts` (24) + tests, `Layers/ProviderRuntimeIngestion.ts` (18) + test                                                                                                                                                                                                                                                                                                                                                                                                                             | session-start composition (`appendSystemPrompt`, skills, tools, `forkFromThreadId`, identity, cache retention, relocation clause, goal prompt injection, emergent goal, stored model selection, fork-idle gate); ingestion: liveness heartbeat, pending-steer stash, usage ledger, cost/context metrics, user-input settlement on exit                                                                                                                                                                                                                                   | V1 reactors                                                                      | deleted with upstream                                                                                      | 2 (`ProviderSessionManager` composition hook, Pi V2 hunks), 3b (heartbeat, emergent goal), 3c (usage ledger)                                                    |
| DT-6  | `Layers/CheckpointReactor.ts` (1) + test, `Layers/ThreadDeletionReactor.ts` (2) + test, `Services/ThreadDeletionReactor.ts`, `ThreadPullRequestReactor.test.ts`, `PullRequestSyncReactor.test.ts` (renamed, UU)                                                                                                                                                                                                                                                                                                               | start-of-turn baseline refs (`baseline/<n>`), revert refused with another live occupant; subtree delete cascade                                                                                                                                                                                                                                                                                                                                                                                                                                                          | V1 reactors                                                                      | deleted with upstream (the `CheckpointDiffQuery`/`Utils` read side survives with fallback, PR-22)          | 2 (`checkpoint.captured` consumer), A                                                                                                                           |
| DT-7  | `ThreadSettlementPolicy.ts` (4) + test, `ThreadSettlementReactor.ts` (11) + test                                                                                                                                                                                                                                                                                                                                                                                                                                              | auto-settle blockers (`yielded`, live descendants), finished-root settles, human send unsettles, PR-5 debug-log on blocked                                                                                                                                                                                                                                                                                                                                                                                                                                               | V1 settlement                                                                    | deleted with upstream                                                                                      | 2 (`thread.auto-settle` + `ThreadSettlementService` hunks, settle-on-merge)                                                                                     |
| DT-8  | `ActivityPayloadProjection.ts` (2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | consult tool fields survive activity projection so the consult card renders                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | V1 activity projection                                                           | deleted with upstream                                                                                      | 3d (turn-item hunk)                                                                                                                                             |
| DT-9  | `provider/Layers/ProviderService.ts` (19) + test, `Services/ProviderService.ts`, `Services/ProviderAdapter.ts` (3), `ProviderAdapterRegistry.test.ts` (5)                                                                                                                                                                                                                                                                                                                                                                     | `workstream` MCP capability union, launch claims, worktree lease around launches, foreign-home refusal on launch, failover/exhaustion plumbing, session-file resume state                                                                                                                                                                                                                                                                                                                                                                                                | V1 provider SPI                                                                  | deleted with upstream (refusal re-expressed under DL-81)                                                   | 2 (adapter hunks), 3a (capability), 3c (failover)                                                                                                               |
| DT-10 | `provider/Layers/ProviderSessionReaper.ts` (3) + test, `ProviderSessionDirectory.ts` (3), `Services/ProviderSessionDirectory.ts`                                                                                                                                                                                                                                                                                                                                                                                              | DL-74: live-only read + one-statement prune of stopped bindings of deleted threads; session-file awareness                                                                                                                                                                                                                                                                                                                                                                                                                                                               | V1 session table                                                                 | deleted with upstream                                                                                      | 2 (strategy: check whether V2 ever removes a deleted thread's binding; if not, the prune returns as a Loom sweep on the V2 table)                               |
| DT-11 | `provider/Layers/{Antigravity,Claude,Codex,Cursor,Grok,OpenCode}Adapter.ts`, `CodexSessionRuntime.ts` + tests                                                                                                                                                                                                                                                                                                                                                                                                                 | one-to-three-line Loom hunks (capability fields, error class) in adapters Loom never registers                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | V1 adapter SPI                                                                   | deleted with upstream                                                                                      | 4 (nothing to re-hang: Pi-only registry)                                                                                                                        |
| DT-12 | `persistence/Layers/Projection{Threads,ThreadMessages,ThreadSessions,Turns,Projects}.ts` + `Services/*`, `ProjectionRepositories.test.ts`                                                                                                                                                                                                                                                                                                                                                                                     | Loom columns in V1 projection repositories (`origin`, `control_payload_json`, `reasoning_ms`, `last_error_class`, the ~35 thread columns)                                                                                                                                                                                                                                                                                                                                                                                                                                | V1 tables                                                                        | deleted with upstream (the tables themselves survive inert in `statev2.sqlite`; migrations 1001–1045 stay) | 2 (`loom_*` sidecar tables), 4 (importer reads the inert copies)                                                                                                |
| DT-13 | `packages/contracts/src/orchestration.ts` (32) + test                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 24 Loom command types, 25 event types, `goal` aggregate kind, 39 thread/shell fields, 3 message fields, 2 shell-stream members spliced in; `loomThreadDefaults`                                                                                                                                                                                                                                                                                                                                                                                                          | V1 unions                                                                        | deleted with upstream; `orchestration.loom.ts` quarantined (DT-21)                                         | 2 (`orchestrationV2.loom.ts`)                                                                                                                                   |
| DT-14 | `packages/client-runtime/src/state/threadReducer.ts` (5) + test, `threads-pagination.test.ts`, `pendingRequests.ts` (1), `platform/persistence.test.ts`                                                                                                                                                                                                                                                                                                                                                                       | folding Loom thread fields and goal shell-stream events into client state; pending-request wording                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | V1 shell shapes                                                                  | deleted with upstream                                                                                      | 3d                                                                                                                                                              |
| DT-15 | `apps/web/src/queuedMessageStore.ts` (2) + test, `components/chat/sendQueuedMessage.ts` (2), `QueuedMessageSender.test.tsx`, `ChatMarkdown.workspace-images.test.tsx`                                                                                                                                                                                                                                                                                                                                                         | `threadReferences` and `skillNames` on queued sends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | V1 client-side queue (V2 queues server-side)                                     | deleted with upstream (PR-9 re-attaches the draft/chip side on V2's send path if it has a slot)            | 3d                                                                                                                                                              |
| DT-16 | `apps/server/src/server.test.ts` (22), `serverRuntimeStartup.reconcile.test.ts` (9), `serverRuntimeStartup.worktreeSetup.test.ts`, `bin.test.ts`, `integration/*` (5)                                                                                                                                                                                                                                                                                                                                                         | tests of the V1 server composition, restart reconciliation (not-continued set, kickoff re-delivery), worktree setup, engine harness                                                                                                                                                                                                                                                                                                                                                                                                                                      | V1 harnesses                                                                     | deleted with upstream                                                                                      | 2/3b (recovery policy tests are rewritten on V2's `ProviderRuntimeRecoveryService`)                                                                             |
| DT-17 | _(reserved)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                  |                                                                                                            |                                                                                                                                                                 |
| DT-18 | _(reserved)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                  |                                                                                                            |                                                                                                                                                                 |
| DT-19 | _(reserved)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                  |                                                                                                            |                                                                                                                                                                 |
| DT-20 | _(reserved)_                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |                                                                                  |                                                                                                            |                                                                                                                                                                 |
| DT-21 | `packages/contracts/src/orchestration.loom.ts` (1,795)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | the Loom contract sidecar (commands, events, lane/attention/route enums, `ControlPayload`, `LoomThread*Fields`, defaults)                                                                                                                                                                                                                                                                                                                                                                                                                                                | `./orchestration.ts`                                                             | quarantined                                                                                                | 2                                                                                                                                                               |
| DT-22 | `apps/server/src/orchestration/**` (86 relocated, Appendix B Q rows)                                                                                                                                                                                                                                                                                                                                                                                                                                                          | the V1-shaped engine: dispatcher, fan-in, liveness, reaper, exhaustion resume, handoff drafter, stuck-launch recovery, user-input settlement, goal-task libs, role overlays, child prompt, brief/report files, launch identity, consult (`workstreamAsk`), thread resolve, stall context, worktree classification/removal, receipt dedup, thread search + embeddings, the `*.loom.ts` decider/projector/invariants/anchor siblings and all their tests                                                                                                                   | V1 engine, snapshot query, event types                                           | quarantined                                                                                                | 3b (control plane), 3a (tools' libs), 2 (goal/anchor libs → plain tables), 3c (exhaustion), DL-82 (search → 2/3d), isolation-option (fan-in, reaper, worktree*) |
| DT-23 | `apps/server/src/provider/Drivers/PiDriver.ts` (2,959) + `PiDriver.*.test.ts`, `Drivers/Pi/*`, `Layers/Pi/*`, `piTurnRetryPolicy.ts`, `cacheRetention.loom.ts`, Loom's `textGeneration/PiTextGeneration.ts`                                                                                                                                                                                                                                                                                                                   | Loom's V1 Pi driver: work-model addendum, tool extension + search guard, `T3_*` env, deterministic session id, `--session --cwd` resume, native fork + identity replay, ask broker, failover/exhaustion/retry ladder, cost on usage, bundled patched pi, `PiCwdOverride` contract test, one-shot structured generation                                                                                                                                                                                                                                                   | V1 adapter SPI, `userInputSettlement`, `workstreamLaunchIdentity`                | quarantined (upstream's `PiDriver.ts` + `PiAdapterV2` win)                                                 | 2 (adapter hunks, patch 0001 → `switch_session`), 3a (extension), 3c (economics), 3b (emergent goal)                                                            |
| DT-24 | `apps/server/src/loom/{serverLayers,startup,wsMethods,handoffDraft,retroDraft,pendingSteering}.ts` + tests                                                                                                                                                                                                                                                                                                                                                                                                                    | Loom reactor/sweep wiring, startup reconciliation, ws method factory, `/handoff` + `/retro` drafters, steer stash                                                                                                                                                                                                                                                                                                                                                                                                                                                        | V1 engine services                                                               | quarantined (the provider-health / usage-poller half of `serverLayers.ts` survives in place)               | 3b, 2 (steer stash on the continuation), F                                                                                                                      |
| DT-25 | `apps/server/src/mcp/{WorkstreamSpawnHttp,GoalTaskHttp,GoalHandoffHttp,ThreadForkHttp,UserInputHttp,workstreamRender,httpScope,toolPaths}.ts` + tests                                                                                                                                                                                                                                                                                                                                                                         | the 23 REST `/provider-tools/*` routes: spawn/scaffold/brief/lane/attention/release/stop/prompt/deps/submit/list/consult/notify/title/fork/goal tools/handoff/continue/ask                                                                                                                                                                                                                                                                                                                                                                                               | V1 engine dispatch + snapshot reads                                              | quarantined (retired per Area B; the handlers are the toolkit's source)                                    | 3a                                                                                                                                                              |
| DT-26 | `apps/server/src/cli/{goal,orchestrationMutation}.ts`; `bin.ts` `goal` registration                                                                                                                                                                                                                                                                                                                                                                                                                                           | `t3 goal …`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | V1 commands                                                                      | quarantined; hunk dropped                                                                                  | 3a/E                                                                                                                                                            |
| DT-27 | `apps/server/src/dev/{seedWorkstream,verifySeed,threadSearchEval.loom}.ts`; `docs/dev-site-testing.md` step 1                                                                                                                                                                                                                                                                                                                                                                                                                 | dev seeding of a workstream; search eval                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | V1 commands/search                                                               | quarantined (recipe step unavailable in Phase 1)                                                           | 3d                                                                                                                                                              |
| DT-28 | `apps/server/src/project/WorktreeProvisioner.ts` + test, `worktreeSetupRecord.loom.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                        | per-child worktree provisioning, branch naming, snapshot commit, breadcrumb wait (DL-73's caller)                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | V1 `thread.meta.update`                                                          | quarantined (the runner + breadcrumb survive)                                                              | 3b (`goal_handoff` root via `ThreadLaunchService`), isolation-option                                                                                            |
| DT-29 | `apps/server/src/persistence/Layers/SqliteLanes.ts` (engine half)                                                                                                                                                                                                                                                                                                                                                                                                                                                             | read lane for V1 projection + embedder wiring                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | V1 engine/pipeline                                                               | quarantined half; usage-ledger reader half kept only if a live consumer remains (DT-30)                    | 2                                                                                                                                                               |
| DT-30 | usage ledger views: `state/server.ts` top-spend RPC, web `TopThreadSpend`, `state/threadSpend.ts`, `loom/contextCost.ts`, Usage page Cost tab                                                                                                                                                                                                                                                                                                                                                                                 | per-thread cost/context chips and the cost tab                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `projection_usage_ledger` (no writer under V2), `cumulativeCostUsd`              | hunk dropped / quarantined                                                                                 | 3c                                                                                                                                                              |
| DT-31 | `apps/web/src/components/Workstream{Panel,Graph,Timeline,QuickFacts,ActiveStrip}.tsx`, `lib/{workstreamPresentation,workstreamRollup,forkJoinLayout}.ts` + tests, `GoalTasksPanel.tsx`, `loom/{GoalThreadsSection,TaskThreadChips,goalThreadChain,useGoalPanelActions,sidebarGoalActions,useLoomThreadExtensions,rootThreads}.*`, `Sidebar.logic.loom.ts`, `threadRouteLineage.ts`, `ThreadLineageBreadcrumb.tsx`, `chat/{StagedCard,StagedBriefPreviewCard,StagedKickoffCard,ForkedFromBadge}.tsx`, `hooks/useForkThread.ts` | board, graph, timeline, rollups, active strip, goal panel, lineage, staged cards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `LoomThreadShellFields`, `orchestration.loom.ts` enums, `OrchestrationEvent`     | quarantined                                                                                                | 3d                                                                                                                                                              |
| DT-32 | `apps/web/src/loom/{ControlDigestCard,ControlDigestRow,controlMessages,ConsultCardRow,HandoffReceiptRow,handoffReceipts.logic,composerIntercepts}.*`, `MessagesTimeline*` consult/handoff hunks, `ChatView.tsx` H4/H17                                                                                                                                                                                                                                                                                                        | control-plane digest/yield/gate cards, consult rows, handoff receipts/toasts, `/handoff` + `/retro` intercepts                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `controlPayload`, consult activity fields, `handoffDestinations`, V1 fork-create | quarantined / hunk dropped                                                                                 | 3d, 3b/F                                                                                                                                                        |
| DT-33 | `DiffPanel.tsx` By-coder arm, `diffPanelStore.ts` coder scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | per-child diff scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | children's `parentThreadId`/`planLane`/diff counts                               | hunk dropped                                                                                               | 3d                                                                                                                                                              |
| DT-34 | `RightPanelTabs.tsx` Loom tabs/props, `ChatView.tsx` H14/H19/H20                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Goal tasks / Workstream / Graph / Agents tabs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Loom panels                                                                      | hunk dropped                                                                                               | 3d                                                                                                                                                              |
| DT-35 | `Sidebar.tsx` H6/H7/H9/H10/H11, `Sidebar.logic.ts` H3–H7, `ThreadNotificationCoordinator.tsx` H1, `loom/pendingUserInput.tsx`, mobile `thread-list-v2-items.tsx`                                                                                                                                                                                                                                                                                                                                                              | attention-outranks-state, sub-thread rollup badge, goal menu entries, "Needs Attention" ordering, pending-question header/age                                                                                                                                                                                                                                                                                                                                                                                                                                            | `attention`, `planLane`, `pendingUserInputHeader/Since`, `goalId`                | hunk dropped (root-only inbox filter: upstream's subagent filter — accepted)                               | 3d, 2/I                                                                                                                                                         |
| DT-36 | `ChatView.tsx` H13, `ComposerPendingUserInputPanel.tsx` Loom hunks, `client-runtime/work-log/userInput.ts`, `packages/shared/src/{userInputOutcome,openRequests}.ts`                                                                                                                                                                                                                                                                                                                                                          | "reply in chat instead", markdown question body, settled-by-reply wording, dismissed/superseded outcomes                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | V1 user-input activities, `UserInputResolvedOutcome`                             | hunk dropped / quarantined                                                                                 | 3a/I                                                                                                                                                            |
| DT-37 | `packages/shared/src/{workstreamGraph,workstreamDependencies,workstreamIsolation}.ts` + tests, `packages/shared/src/notify.ts`, `consultActivity.loom.ts`                                                                                                                                                                                                                                                                                                                                                                     | pure routing/dependency/isolation/notify libs (logic to move back untouched)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `OrchestrationThread(Shell)`, lane/route enums                                   | quarantined                                                                                                | 2 (retype on the sidecar), 3b                                                                                                                                   |
| DT-38 | `client-runtime/src/state/*` Loom hunks: `goals` on the shell, goal/workstream commands, thread-detail field merge, batched `thread-upserted`, top-spend/worktree RPCs; `threadFixtureDefaults.ts`                                                                                                                                                                                                                                                                                                                            | client state for goals and workstream fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | V1 shell/stream shapes                                                           | hunk dropped / quarantined                                                                                 | 3d (and 3a for commands)                                                                                                                                        |
| DT-39 | `ws.ts` H20–H24, `RpcAuthorization.ts`, `contracts/rpc.ts` Loom RPCs                                                                                                                                                                                                                                                                                                                                                                                                                                                          | workstream ws methods, thread activities/lifecycle RPCs, goal shell-stream mapping, brief-needed decoration, fail-loud catch-up, heartbeat keepalive                                                                                                                                                                                                                                                                                                                                                                                                                     | V1 engine/snapshot query, `ORCHESTRATION_WS_METHODS`                             | hunk dropped                                                                                               | 3a (tools), 3d (shell items), 2 (catch-up: V2 `streamStoredEventsFrom`)                                                                                         |
| DT-40 | `serverRuntimeStartup.ts` H5 (575 lines), H7 Loom sweeps                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | restart-recovery policy (not-continued set, kickoff re-delivery, stale-session reconciliation, settlement scan, stuck-launch repair), Loom sweeps start                                                                                                                                                                                                                                                                                                                                                                                                                  | V1 sessions/turns, Loom services                                                 | hunk dropped                                                                                               | 2 (recovery policy module; `continueThreadsAfterServerUpdate` default), 3b                                                                                      |
| DT-41 | `relay/AgentAwarenessRelay.ts` Loom hunks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | plan lane + attention as relay metadata; lean-shell read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `OrchestrationThreadLeanShell`                                                   | hunk dropped                                                                                               | 3b                                                                                                                                                              |
| DT-42 | `components/settings/WorktreesSettings.tsx`, `loom/wsMethods.ts` worktree RPCs, `state/server.ts` H3                                                                                                                                                                                                                                                                                                                                                                                                                          | worktrees maintenance panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `WorkstreamWorktreeStatus`                                                       | quarantined / hunk dropped                                                                                 | isolation-option                                                                                                                                                |
| DT-43 | `components/settings/ThreadSearchSettings.loom.tsx`, web `loom/threadSearch.ts` archived-hit rendering, mobile search ranking (kept if it compiles)                                                                                                                                                                                                                                                                                                                                                                           | semantic search settings; archived-hit rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | server search producer (DL-82)                                                   | quarantined / renders nothing                                                                              | 2, 3d                                                                                                                                                           |
| DT-44 | `textGeneration/TextGeneration.ts` Loom structured op, `TextGenerationPrompts.ts` goal prompt                                                                                                                                                                                                                                                                                                                                                                                                                                 | emergent-goal generation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | V1 provider command reactor                                                      | hunk dropped                                                                                               | 3b/E                                                                                                                                                            |
| DT-45 | `git/GitWorkflowService.ts` fan-in primitives, `vcs/GitVcsDriverCore.ts` fan-in merge arm, `git/WorktreeMutationLock.ts`, `workspace/WorkspaceOccupancyLease.ts`                                                                                                                                                                                                                                                                                                                                                              | fan-in git primitives, worktree mutation lock, occupancy lease                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | (compile; consumers quarantined)                                                 | orphaned                                                                                                   | isolation-option (else 4)                                                                                                                                       |
| DT-46 | `apps/server/src/orchestration/stuckLaunchRecovery.ts`, `userInputSettlement.ts` (in DT-22)                                                                                                                                                                                                                                                                                                                                                                                                                                   | stuck-launch CAS repair; three-layer user-input settlement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | V1 session CAS command                                                           | quarantined                                                                                                | 2 (verify-before-delete per Area C; settlement deleted once the `respond` hunk exists)                                                                          |
| DT-47 | `packages/shared/src/threadSettled.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | settle rules shared with the V1 decider                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | V1 decider consumer                                                              | deleted (upstream's `client-runtime/state/threadSettled.ts` location wins, PR-4)                           | 2 (if `ThreadSettlementService` wants it shared again)                                                                                                          |
| DT-48 | provider session reaper prune (DL-74)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | deleted threads do not accrete binding rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | V1 bindings table                                                                | deleted with upstream (DT-10)                                                                              | 2 (conditional, hunk inventory row)                                                                                                                             |

_(S1/S3 append from DT-49.)_
