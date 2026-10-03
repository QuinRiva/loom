---
manager_sessions:
  - id: 9a0bdc69-2841-4b48-b179-a1ad77176809
    name: Pull 8 plan — scope and sequencing (pre-Orchestration-V2 target), revised after review rounds 1–2
    role: plan
    authored_at: 2026-10-03T14:10:59.979Z
---

# 27 — Cadence pull 8 (v0.0.43-nightly.20260920 `c14f6015bf` → v0.0.45+4 `024d49520e`, the last pre-Orchestration-V2 commit)

**Status: PLANNED, not started.** This is the opening section of pull 8's sync
note; the merge sessions append their session records and the decision log
below it. Australian English. Nothing in this document has been executed —
every number comes from a dry-run merge in a scratch worktree that was aborted
and removed.

> **Read §0 first.** The brief asked for a plan to merge upstream's tip
> `f391794a35` (409 commits). The dry run shows that the last 45 of those
> commits replace the orchestration engine loom is built on. This plan
> therefore targets the commit immediately before that rewrite and treats the
> rewrite as a separate project. §0 and §12 carry the evidence and the
> reasoning; §2 records it as a departure from the runbook.

---

## 0. Headline: pull 8 stops at `024d49520e`, one commit before Orchestration V2

Upstream commit `de34391427` ("feat(orchestrator): introduce new orchestrator
(#2829)", 2026-10-02) is a single squash of **1,914 files, +381,846/−204,768**.
It deletes `apps/server/src/orchestration/` (81 upstream files) and replaces it
with `apps/server/src/orchestration-v2/` (527 files); deletes
`packages/contracts/src/orchestration.ts` in favour of `orchestrationV2.ts` /
`orchestrationDispatch.ts` / `orchestrationProject.ts` ("The V1 command and
event unions are gone"); adds migrations `055_OrchestrationV2` and `056`;
snapshots `state.sqlite` into a new `statev2.sqlite` on first launch with a
lazy legacy importer; and bumps `ORCHESTRATION_PROTOCOL_VERSION` from 1 to 2,
with the `/ws` route refusing a mismatched client with HTTP 426. Upstream's own
docs for it are `docs/orchestration-v2/*.md` and
`docs/internals/legacy-orchestration-migration.md`.

Loom's entire fork is built on V1: `decider.loom.ts` and the 25
`LOOM_COMMAND_TYPES`, the workstream dispatcher / fan-in / liveness sweep /
handoff drafter reactors, goals and tasks, the fork columns on
`projection_threads`, 45 fork migrations against V1 projection tables, and the
web/mobile code that reads those shapes. Of loom's 766 fork-only files, **206
import V1 orchestration contracts or `orchestration/` modules**, and 86 live
inside `apps/server/src/orchestration/` itself.

Two dry-run merges from `origin/main` (`131166c11d`) make the shape obvious:

| target                                                 | upstream commits | conflicted files | shape                                                                                                                                 |
| ------------------------------------------------------ | ---------------: | ---------------: | ------------------------------------------------------------------------------------------------------------------------------------- |
| `upstream/main` `f391794a35` (the brief's target)      |              409 |          **348** | 169 content, **91 modify/delete** (loom edited a file V2 deleted), **86 "file location"** (loom's files inside the renamed directory), 2 add/add |
| `024d49520e` (= `de34391427^`, v0.0.45 + 4)            |              364 |           **91** | 90 content, 1 modify/delete; ~180 conflict markers outside the lockfile; 45 of the 90 files carry a single marker                       |

The 364 pre-V2 commits are an ordinary cadence pull — smaller than pull 7's
230 files, and far more additive. The 45 V2 commits are not a merge at all:
they are a re-platforming of loom's engine onto a new orchestration model, and
no three-way merge can do that. Merging the tip would hand the coders 348
conflicts of which the ~180 in `orchestration/`, `contracts/orchestration*.ts`
and the V2 migrations have no textual resolution, only a redesign.

**Decision (pre-ruled, see PR-0 in §6): pull 8 = `024d49520e`.** It banks the
364 commits now, advances `UPSTREAM_BASE`, and leaves the V2 question as a
scoped follow-up with exactly one upstream delta left to evaluate (§12). It is
a useful checkpoint rather than a logical prerequisite for every V2 strategy —
a cherry-pick-only future would not strictly need it — but every path that
keeps tracking upstream passes through it, and the overlap V2 will face (342
loom-touched files inside V2's 2,022) does not shrink by waiting. Confidence: high. Evidence of intent: Carl's addendum
to this brief explicitly licenses "splitting the pull into intermediate
upstream tags to shrink each conflict set"; his pull-7 framing that loom should
"drop my approach and adopt the upstream approach" where upstream is "more
rigorously developed" argues for *evaluating* V2 seriously, not for attempting
it as a conflict-resolution exercise with no design.

Naming: the tag closest to the target is `v0.0.45` (`6c8fed35dd`); the target is
four commits later (`42b5885c90`, `5b31001eac` "prepare v0.0.45", `e0db2a5e58`,
`024d49520e`). `UPSTREAM_BASE` is advanced to `024d49520e`.

---

## 1. Topology and invariants

- Branch `t3code/upstream-sync-20261004`, cut fresh from `origin/main`
  (`131166c11d` at planning time — **re-measure**: many worktrees share this
  clone and `origin/main` moves mid-cycle; compute the overlap of any new
  `origin/main` commits with the conflict list before starting).
- `git -c rerere.enabled=false merge --no-ff --no-commit 024d49520e` (the raw
  hash; there is no tag on it). After the merge commit, `${merge_oid}^2` must
  equal `024d49520e` and `${merge_oid}^1` must equal **the branch tip
  immediately before the merge** — which is `origin/main` plus session 0's
  tooling commit (§13), so record that tip (`pre_merge_oid`) before merging
  rather than comparing against `origin/main`.
- **Every commit on the branch uses `--no-verify`.** The pre-commit hook is
  `vp staged --no-stash` (`.vite-hooks/_/pre-commit`); pull 7 recorded that it
  deletes `MERGE_HEAD` and single-parents the merge. Upstream bumped vite-plus
  0.3 → 1.0 in this range, so do not assume the hook got safer.
- No rebase, no squash, ever, on the sync branch. `pnpm ship` / the shipper
  role merge the PR with `--merge`.
- **Never `git stash`** (one global stash across every worktree).
- `rerere.enabled` is `true` in this clone, and a rerere replay is **not
  detectable after the fact**: the reviewer reproduced on git 2.30.2 that a
  replayed file is left resolved-but-unstaged with `git rerere status` empty.
  So **every merge in this pull — dry runs and the real one — is run with
  rerere disabled for that invocation**: `git -c rerere.enabled=false merge
  --no-ff --no-commit 024d49520e`. Do not change clone-wide config and do not
  `git rerere clear` (other worktrees share the cache). If a merge was ever
  run without the flag, treat every file it touched as unaudited.
- **Record `merge_oid`** (`git rev-parse HEAD` right after the merge commit)
  in the session record. Every later topology check is
  `git rev-parse ${merge_oid}^1 ${merge_oid}^2` — repair commits are
  single-parent and `HEAD^2` on them is meaningless.
- Recovery bundle: if a session must stop with the merge un-committed, copy
  `$(git rev-parse --git-dir)/{index,MERGE_HEAD,HEAD}` to
  `.artifacts/pull8-merge-state-backup/` (pull 7's recipe; restoring those
  files reconstitutes all three conflict stages). With 91 files the intent is
  that **session 1 commits the merge**; the bundle is the fallback.
- Work in **one shared worktree, sequentially**. An in-progress merge cannot
  be split across worktrees.

---

## 2. Departures from the pull-7 runbook

Carl's addendum: the runbook is guidance, not scripture; deviations are to be
stated with what, why, and what it costs if wrong.

| # | departure | why | cost if wrong |
| - | --------- | --- | ------------- |
| D-A | **Target `024d49520e`, not `upstream/main`.** | §0. The V2 rewrite is a project, not a conflict set; the pre-V2 pull is a quarter of the surface and almost entirely additive. | If Carl wants V2 *now*, this pull is still the first step of that path; nothing is wasted. If he wants to stop tracking upstream at V2, the 364 commits are still worth having. The only cost is a second sync note. |
| D-B | **No mechanical auto-resolver pass** (`autoresolve.mjs` / `protected.mjs` stay in the toolbox, unused). Every hunk is read and resolved by hand; `union.py` / `sideresolve.py` are used per-file only after reading. | Pull 7's declaration-level damage, the dropped `case` arms and the five dropped runtime layers all came from the parser-verified resolver choosing a side it had not read. Here 45 of 90 files have one marker and the heaviest non-lockfile file has 17. The resolver's economics do not apply. | Slower by perhaps half a session. No silent drops — which pull 7 spent five sessions finding. |
| D-C | **Resolve and commit the merge in one session** rather than banking across sessions. | Surface is small enough; a committed merge makes typecheck repair commits ordinary. | If session 1 runs out of context, fall back to the recovery bundle exactly as pull 7 did. |
| D-D | **Lint conformance to upstream's new `shadcn/*` rules is a stacked PR inside the pull's stack**, not a blocker on the merge PR. | Upstream added `no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `require-static-classes`, `no-unknown-classes` over all of `apps/web/src`. Loom's 82 fork-only `.tsx` files carry ~290 arbitrary-value classes and ~33 raw colours; the doctrine ("fix or delete, never exempt") stands, but the volume is a session of its own. Carl's pull-7 ruling: the deploy gate is the whole stack, the merge PR is an intermediate checkpoint. | None to doctrine — no exemption is added. If the count is small the coder simply does it in the gate session. |
| D-E | **Decision log lives in this note** (§10), and *every* non-trivial resolution writes a row — not only the ones the mechanical ledger would have recorded. | Carl will not be consulted during the merge; the log is how he reverses decisions afterwards. | Verbosity. Rows are one line each. |
| D-F | **The esbuild path in `parsesweep.mjs` is resolved at run time**, not hard-coded. | The tool imports `/home/Carl/.t3/cockpit/worktrees/loom/t3code-ea251a06/node_modules/.pnpm/esbuild@0.25.12/...`; it only works while that sibling worktree exists. §13 has the one-line fix; verified to parse-sweep this tree. | None. |

Everything else in doc 25's "Method", "Standing reviewer checklist", "Standing
drops", "PiDriver capability parity", "Restart continuation" and "Lint and knip"
sections carries forward unchanged.

---

## 3. Surface sizing, by zone (target `024d49520e`)

Status counts from the dry run: **1,026 modified clean, 267 added, 30 clean
deletions + 1 modify/delete (upstream's deletion set is therefore 31 paths —
derive it with `git diff --name-only --diff-filter=D c14f6015bf 024d49520e`,
never from this count), 15 renamed, 90 UU, 1 UD.** Loom-touched files vs
merge-base: 1,216; upstream pre-V2 touched: 1,429; overlap: **265** — 91
conflicted, **174 merged clean**. Those 174 are where a *semantic* conflict
hides: git saw no overlap, but upstream changed an API or a shape that a
surviving loom hunk consumes. They get an explicit review pass (§9, "clean-
overlap semantic review"), not just the marker sweep.

Marker counts are `<<<<<<<` lines per file from the dry run. The exact
file-to-zone partition (91 rows, one zone each) is in Appendix B. File lists
and the raw merge logs are in `.artifacts/pull8-plan/` (gitignored):
`prev2-conflicts.txt`, `prev2-status.txt`, `prev2-merge.log`,
`prev2-upstream-log.txt`, the reviewer's `review-clean-overlap.txt` (the 174),
plus the tip dry-run for comparison (`full-conflicts.txt`, `full-merge.log`).

| zone | files | markers | heaviest files (markers) | character |
| ---- | ----: | ------: | ------------------------ | --------- |
| **Server core / orchestration** | 19 | ~68 | `server.test.ts` 17 · `ProjectionSnapshotQuery.ts` 12 · `CheckpointDiffQuery.test.ts` 10 · `ws.ts` 5 · `serverRuntimeStartup.test.ts` 4 · `ThreadSettlementReactor.test.ts` 3 · `server.ts` 2 · `OrchestrationEngine.test.ts` 2; `decider`, `projector`, `ThreadSettlementReactor`, `ProviderCommandReactor`, `CheckpointReactor`, `ThreadDeletionReactor`, `serverRuntimeStartup.ts`, `serverSettings.ts` 1 each | 7 of the 19 are tests. Source hunks are both-add (imports, layer lists) or a one-line upstream refactor landing on a loom-marked line. `ProjectionSnapshotQuery` is the only one needing thought (PR-4). |
| **Web — sidebar / navigation / routes** | 13 | ~22 | `Sidebar.tsx` 4 · `__root.tsx` 3 · `Sidebar.logic.test.ts` 3 · `useHandleNewThread.ts` 2 · `NoProjectsHero.tsx` 2; 8 files at 1 | Upstream's "Working section (beta)" and Sidebar.logic additions beside loom's root filter / goal menu / attention surfaces. Both-add. |
| **Web — chat surface** (the historical high-tax zone) | 12 | ~19 | `ChatView.tsx` 4 · `ChatComposer.tsx` 3 · `MessagesTimeline.tsx` 3; 9 files at 1 | **Dramatically smaller than pull 7** because the post-pull-7 stack re-homed the cluster onto upstream's files with marked seams (PRs #196–#209). Every hunk is a marked loom seam vs a small upstream change. |
| **Web — panels / settings / other** | 8 | ~12 | `DiffPanel.tsx` 3 · `FilePreviewPanel.tsx` 3; 6 at 1 | DiffPanel's scope menu became radio groups upstream; loom's By-coder group must be re-homed onto it (PR-9). |
| **Mobile** | 7 | ~20 | `HomeScreen.tsx` 7 · `ThreadNavigationSidebar.tsx` 5 · `usageProviders.ts` 3 · `threadKeyboardShortcuts.ts` 2 | Upstream retired the legacy grouped thread list (v2 list only); loom's hunks straddle both paths. The one modify/delete is `homeListItems.test.ts` (upstream deleted the module). PR-11. |
| **Lockfile / workspace / config** | 6 | 69 + ~13 | `pnpm-lock.yaml` 69 · `third-party-licenses.config.json` 9 · `pnpm-workspace.yaml` 1 · two `package.json` 1 · `cli-external-packages.test.ts` 1 | Regenerate the lockfile from upstream's, never hand-merge. Expo 57 → 58 / RN 0.88 and vite-plus 0.3 → 1.0 are inside it. |
| **Provider / driver SPI** | 6 | ~8 | `ProviderSessionReaper.ts` 2 · `ProviderRegistry.test.ts` 2 · `model-manifest.json` 1 | `ProviderAdapter.ts` is **unchanged** in this range — no new capability fields. Pi-only registry tests: ours (standing). Manifest gained a `compatibility` block (PR-12). |
| **Contracts** | 5 | 6 | `usage.ts` 2; `keybindings.ts`, `model.ts`, `rpc.ts`, `settings.test.ts` 1 | All both-add list unions. The contracts delta for the whole range is +995/−55 across 31 files; `orchestration.ts` merged clean (it gained `autoSettleDisabledAt` + `ThreadAutoSettleSetCommand`). |
| **Server — project / worktree setup** | 4 | ~10 | `ProjectSetupScriptRunner.test.ts` 5 · `ProjectSetupScriptRunner.ts` 3 | Upstream made `completion` optional and closes the idle setup shell on exit 0; loom's 30-minute timeout and `t3code-setup-state.json` breadcrumb sit on the same lines (PR-7). |
| **Server — usage** | 4 | 4 | one marker each | Upstream added Cursor/OpenCode/Antigravity transcript readers beside loom's `parsePiLine` / `piSessionsRoot` lines. Union. |
| **Server — vcs / source control** | 3 | ~3 | `VcsStatusBroadcaster.ts` (84-line upstream add vs nothing) · `GitVcsDriverCore.ts` | Union / adopt upstream's `filterOrFail` shape with loom's stderr-in-detail kept (PR-13). |
| **Shared / client-runtime** | 3 | ~4 | `shell-sync.test.ts` 2 | Trivial. |
| **Persistence** | 1 | 1 | `Sqlite.ts` | Both sides add PRAGMAs; loom renamed `runMigrations` → `runAllMigrations` for the two-lane split. **`Migrations.ts` did not conflict** — upstream appended `054_ProjectionThreadsAutoSettleDisabledAt` inside the array, as doc 22 predicted; loom's one-word `export` divergence survives. `LoomMigrations.ts` untouched. |

### Structural moves (hand re-home items)

Upstream deletions/renames in the range whose loom importers must be checked.
Dry-run grep at `origin/main`: **none of these modules has a loom importer
outside its own file**, so they are mechanical — but the grep must be re-run on
the merged tree because clean-merged loom files can reference them.

- `packages/shared/src/threadEnvMode.ts` **deleted** (t3.json env-mode now resolved inside `resolveProjectSettings`, #12954). `useHandleNewThread.ts` conflict H1/H2 is this.
- `apps/mobile/src/features/home/homeListItems.ts`, `home-list-options.test.ts`, `threads/thread-list-items.tsx`, `threads/threadPresentation.ts`, `threads/use-thread-list-v2-enabled.ts`, `components/useMaterialToolbarHeight.ts` **deleted** (legacy list retired, #13183 / #13203).
- `apps/web/src/components/pullRequest/PullRequestCommentComposer.tsx` deleted; `PullRequestReviewBar.tsx → PullRequestReviewForm.tsx` (#12945).
- `provider/Layers/codexResetCredit.ts → resetCreditCoordinator.ts` (#13118). `server.ts` H1 is this rename landing beside loom's `LoomProviderHealthLive`.
- Mobile favicon caches renamed by job (`projectFaviconRequests.ts`, `projectFaviconDatabaseCache.ts`); `legacy-plan-mode.ts` moved to `state/`.
- Expo 57 patches renamed to 58; `react-native-gesture-handler` 2.32 → 3.2.1, `react-native-reanimated` patch dropped.

No upstream rename touches a loom-owned directory in this range (that is the
V2 commit's doing, §12).

---

## 4. Upstream change digest — what the 364 commits did that matters to loom

Full log: `.artifacts/pull8-plan/prev2-upstream-log.txt`. Grouped by the loom
feature it touches; ⚠ marks items where "adopt upstream, delete loom's
workaround" may bite or a decision is needed (each has a PR-n in §6).

**Threads, sidebar, settlement**
- ⚠ `b33eda1399` **Working section (beta)**: opt-in setting folds working/monitoring threads into a collapsed shelf; a thread "returns to the top" when it finishes, fails or needs an approval/answer; active list ordered by `observedReturnAt` while on. New `sortInboxThreadsByReturn` in `Sidebar.logic.ts`. → PR-8.
- ⚠ `0109670411` **per-thread auto-settle switch** (`autoSettleDisabledAt`, `ThreadAutoSettleSetCommand`, migration 054). Composes with loom's server-side blockers (#199). → PR-5.
- `1d6f23b519`, `3b0a495b0e`, `c216ba4dad`, `b6eefc926a`: settlement/PR sweeps read only threads that can still settle (`unsettledOnly` filter); per-thread settlement no longer rebuilds the whole list; projector stops remapping every thread per event; shell snapshot built without double decode. → PR-4 (PSQ) and PR-3 (projector `updateThread`).
- `5781b5240b`, `6b0a04ade0`, `9a609a4e44` undo settle/snooze/archive/unpin with mod+z and a sidebar notice; `829af7b73a` mod+[ / mod+] history. → keybindings union (PR-14).
- `6b286ae8a2` **start threads without a project** (an environment-level Scratch project — `projectId` stays non-null) and `148e6deea0` new project from a name. `ws.ts` H2/H5 and `rpc.ts` are these. Low loom impact; union.
- `b21c545654` title-search matches sorted by recent activity (loom's semantic `ThreadSearch.loom.ts` sits on top of upstream's search source; `ThreadSearchMatch.tsx` conflict).
- `295d7cba09` queued messages send while the thread is not open (`queuedMessageStore.ts` gains `sendSettings`; loom's `threadReferences` sits beside it).

**Server runtime, persistence, perf**
- `8aa5be2f02` WAL `journal_size_limit`; `d06f0ff104` retry failed statement preparations → `Sqlite.ts` (PR-6).
- `e4eb9977f0` stop replaying old agent alerts on restart; `e0db2a5e58` stop a second server resending Claude turns → `serverRuntimeStartup*` (loom's restart-continuation hunks live in upstream's path, doc 25 "Restart continuation").
- `8872666957`, `574b180902` reaper idle wake-ups / shutdown no longer rewrites stopped session rows → `ProviderSessionReaper.ts` beside loom's retention pruning (PR-13).
- `999161ef84`, `95030dc674`, `10ac2f2ba4`, `18de6bb328`, `5975ec78b7`, `6530de0339` git/GitHub polling cost cuts (`VcsStatusBroadcaster` remote refresh loop, batched GraphQL). Loom's OOM work (PR #274, bounded ingestion) is orthogonal; take upstream's.
- Observability: OTLP per-signal settings, event-loop stall spans, heap snapshot on SIGUSR2, `t3 trace summarize`. Clean merge.
- `568c9bc4d0` Effect language-service sugar sweep (`Effect.succeedSome`, `Effect.asSome`, `filterOrFail`) — the source of several one-line conflicts on loom-marked lines (`ws.ts` H4, `decider.ts`, `GitVcsDriverCore.ts`).

**Providers (multi-provider work; Pi mostly unaffected)**
- `7e65b226e7`, `27bdf1aa14` shared provider sign-in flows, managed ChatGPT auth (`providerSetup.ts` +171). `__root.tsx` gains two coordinators.
- ⚠ `96c4bfa0a2`, `d4cd7d5c33` **compatibility ranges per harness** in `model-manifest.json` + remote checks; `0a04cc50de` one-click provider updates on every machine; `921cb3c8bc` **restart agent session from cmd+k**. → PiDriver parity (PR-12).
- `ca864a25b1` text generation defaults to GPT-6 Luna; `72330e22c0`, `f25a8e4b72` Sonnet 5.5 / Opus 5.5 model entries. Loom's Pi-first text-generation default (PR-1) and `PI_DEFAULT_MODEL` stand.
- `9da066dbe9`, `94f92a7a38` Claude compaction/abort fixes; Grok, OpenCode, Antigravity fixes. Clean merge; not loom's concern (Pi-only registry).

**Usage**
- `e5a46d6c5d` read Cursor/OpenCode/Antigravity history; `adfc9240ea` preserve usage in oversized records; `3dae78f33b`, `10bb59bf06`, `d110f98670` client-version mismatch / newer-variant tolerance; `daafcc4a97`, `3e2370fbbf` usage keyboard navigation + keybinding. `UsageProviderKind` grows; loom's `pi` kind and `parsePiLine` are one-line unions. **Nothing here touches loom's usage-meter redesign** (`plans/usage-meter-redesign`, sidebar meter) — that is client-side loom code on paths upstream did not change in this range. The usage *UI* rework ("cost by token type, speed, model detail" `e8545b293b`) is post-V2 and out of scope.

**Web shell and composer**
- The `#13020`–`#13043` and `#13191`–`#13210` **ui-restyle series** plus new lint: `shadcn/no-restyle`, `no-raw-colors`, `no-arbitrary-values`, `require-static-classes`, `no-unknown-classes` over `apps/web/src/**` (`vite.config.ts` +119, merged clean). → D-D / PR-15.
- `ab70c8943f` sync status no longer flickers (`shownSyncPhase` in `ChatComposer`) — lands on loom's marked `threadSyncPhase` + `threadRef` hunks (PR-10).
- `66129c6fd5` run shell commands from chat in the thread terminal; `8bc9b78f82` terminal links drop a trailing colon (`terminal-links.ts`).
- `55ec55b1fb` open workspace-root links in the file explorer (`rightPanelStore.ts`); `04c15f34b7` chat width setting; `2731929610` composer undo grouping; `0c84b4289c` paste focus; many small composer fixes. Loom's composer is upstream's file with marked seams (post-#204), so these are unions.
- DiffPanel scope menu → radio groups (`d1034d62b2` is post-V2; the pre-V2 change is inside the `#13020`+ series). → PR-9.
- `0141bc2bf5`, `742173a132`, `1262d2f3ab` submodule init policy for new worktrees via t3.json resolver; `b3de243d5e` one t3.json setup action for every OS. → PR-7 and the worktree-setup smoke in §9.

**Mobile**
- Expo SDK 58 / RN 0.88 RC (`8dc07f199c`, `54084ae1e6`), Expo Modules 2.0, widgets via expo-widgets, Live Activity staleness, notification stacking; legacy grouped list retired (`0c91f687de`, `aca3c87cdb`). → PR-11.

**Tooling / repo**
- `35be904f2f` **vite-plus 1.0** (`vp`), `@shadcn/lint` plugin, CI sharding. Loom's `astro>esbuild 0.28.2` and `@types/hast 3.0.5` overrides must be re-validated after `vp i` (PR-16).
- `fd7ee2c30a` (forbid tests in for-loops) is post-V2; not in range.

---

## 5. Per-zone resolution doctrine and the protected-file list

The rule set, in priority order (from doc 05 §4, doc 25 and Carl's pull-7
rulings — "adopt upstream's approach as the baseline and delete loom's
workaround wherever upstream now owns the concern; re-attach only the behaviour
explicitly ruled KEEP; no compatibility shims"):

1. **Upstream wins verbatim** where the fork has no business carrying a delta.
2. **Compose, never pick** where both sides add to a list, a layer set, an
   import block or a struct — these are the overwhelming majority here.
3. **Loom wins, then port upstream's semantic change by hand** where upstream
   refactored a block loom restructured (`ws.ts` shell mapper).
4. **Same concern arrived at twice → upstream's mechanism, loom's requirement
   re-expressed on it** (pull 7's `rightPanelStore`, `ws.ts` buffer, auto-settle precedent).
5. A resolution that drops either side writes a decision-log row (§10).

### Protected — loom must win or be hand-interleaved

| file / area | why | what must survive |
| ----------- | --- | ----------------- |
| `apps/server/src/ws.ts` | 39 `// loom:` markers; #115 fail-loud shell catch-up, eager PubSub attach, brief-needed decoration, `makeShellStreamEventMapper` | `shellLookupRetry` + live `ProjectionRepositoryError` channel; upstream's swallowing `retryShellProjectionRead` / `orElseSucceed` **must not come back** (doc 25 session 2); `loadProjectReferenceLinks`; `overlayProviderExhaustion`; `remoteEditorSshHost` |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` | 25 markers; pull 6 dropped columns here three times | every fork column in every SELECT; `getLeanShellSnapshot` + `getBriefNeededAttentionParentIds`; `mapLeanThreadShellRow` with `backgroundLiveness` / `planProgress` / `pullRequests` / `repositoryIdentity`; run `sqlcolsweep.py` + `aliascheck.py` after |
| `apps/server/src/orchestration/{decider,projector}.ts` + `*.loom.ts` siblings | fork command arms; `updateThread` is **exported** for `projector.loom.ts` | the export; `openBlockingRequests` (loom's narrower predicate, see PR-2) |
| `apps/server/src/orchestration/ThreadSettlementReactor.ts` | server-side sweep is the single auto-settle owner (#199) with loom's blockers | `loomAutoSettleBlockedThreadIds` pre-filter |
| `apps/server/src/server.ts` | runtime composition | `LoomProviderHealthLive`, `LoomMcpHttpLive`, every loom reactor layer (compare against `origin/main` with the structural composition audit) |
| `apps/server/src/provider/Layers/builtInDrivers.ts`, `ProviderRegistry.test.ts` | Pi-only registry (standing) | no Antigravity/Codex/Cursor registration; upstream's non-pi test cases stay deleted |
| `apps/server/src/persistence/LoomMigrations.ts`, `Migrations/1xxx_*` | fork lane | untouched |
| `apps/server/src/persistence/Layers/Sqlite.ts` | two-lane `runAllMigrations` | the call, plus loom's `synchronous=NORMAL` / `cache_size` PRAGMAs |
| `apps/server/src/project/ProjectSetupScriptRunner.ts` | `t3code-setup-state.json` breadcrumb, 30-min timeout | both, re-expressed on upstream's optional `completion` (PR-7) |
| `packages/contracts/src/{model,settings,orchestration}.loom.ts`, `model.ts` `PI_DEFAULT_MODEL` block, `settings.test.ts` Pi-default test | Pi-first defaults | all |
| `apps/web/src/components/{Sidebar,ChatView,DiffPanel,FilePreviewPanel}.tsx`, `chat/{ChatComposer,MessagesTimeline,ComposerCommandMenu}.tsx`, `ChatMarkdown.tsx`, `rightPanelStore.ts`, `routes/__root.tsx` | upstream's files with marked loom seams (post-pull-7 re-home) | every `// loom:` hunk; the By-coder diff scope; `#thread` context references; handoff receipts/toasts; goal/tasks/workstream panels; artefact viewer + MDX renderer; thread tabs strip; `ReferenceLinksProvider`; consult/digest cards (Carl, 2026-09-22: "I implemented the more comprehensive cards for a reason") |
| `apps/web/src/loom/**`, `apps/server/src/orchestration/{Workstream*,Goal*,Handoff*,ThreadSearch.loom,…}`, `apps/mobile/**/*.loom.*` | fork-only | merge clean by construction; verify no deletions in `git diff --diff-filter=D origin/main..HEAD` |

### Upstream wins verbatim

| file / area | note |
| ----------- | ---- |
| `pnpm-lock.yaml` | `git checkout --theirs pnpm-lock.yaml`, union `pnpm-workspace.yaml`, then `vp i` regenerates. Never hand-merge 69 hunks. |
| `apps/server/src/persistence/Migrations.ts`, `Migrations/0xx_*` | byte-identical to `024d49520e` except the recorded `export` on `migrationEntries` (doc 22 §3.2 exception). Already clean. |
| `third-party-licenses.config.json` | upstream's, then re-add loom's entries (`@huggingface/transformers`, `google-auth-library`, pi packages) — JSON has no markers; exempt in `unmarkedsweep.allow` already |
| `vite.config.ts`, `knip.jsonc`, `oxlint-plugin-t3code/**` | upstream's configuration, no fork exemptions (doc 25 "Lint and knip"); the `fmt` ignore for `plans/**` is the one fork line and is in a clean region |
| `apps/web/src/routeTree.gen.ts` | regenerate, never merge |
| `apps/server/src/provider/model-manifest.json` | upstream's structure; see PR-12 for the loom `currentModels` entries |
| `LegacySidebar.tsx` and anything v1-sidebar | standing: loom code touching the v1 sidebar is dropped, not re-homed |
| mobile list/thread screens | upstream's v2-only list (PR-11) |
| all `*.test.ts` where the conflict is fixture drift | tests follow their source; a loom-only test case that pins behaviour loom no longer has is deleted, not faked green (Carl U5: do not preserve loom tests for their own sake) |

---

## 6. Pre-rulings

Format: conflict · options · **ruling** · confidence · evidence. Where the
evidence is thin the ruling is the one cheapest to reverse, and says so.
Coders record the outcome (and any deviation) in the §10 log using these ids.

**PR-0 — Target commit.** Tip `f391794a35` vs pre-V2 `024d49520e` vs stop
tracking upstream. **Ruling: `024d49520e`.** High. §0; Carl's addendum
("splitting the pull into intermediate upstream tags"); the V2 delta needs a
design, not a merge (§12).

**PR-1 — Pi-first defaults vs upstream's model/text-generation defaults**
(`model.ts`, `settings.test.ts`, `client-runtime/operations/projects.ts`,
`ca864a25b1` GPT-6 Luna text generation). Options: adopt upstream's defaults;
keep loom's. **Ruling: keep `PI_DEFAULT_MODEL` and the Pi text-generation
default; adopt every upstream *model entry* and manifest change beside them.**
High. `AGENTS.md` "Pi-first fork"; doc 25 "PiTextGeneration" ("titles,
commits … are real one-shot `pi --print` calls"); pull-7 unmarkedsweep realigned
the "Pi-first text-generation default" test rather than deleting it.

**PR-2 — `decider.ts` snooze guard: `openBlockingRequests` (loom) vs
`openRequests` (upstream) + `yield* new Error` sugar.** Options: upstream's
predicate; loom's. **Ruling: loom's predicate, upstream's syntax.** Medium-high.
Loom narrowed the predicate for the non-modal question card era; check whether
`openBlockingRequests` still differs from `openRequests` now that the question
card is upstream's (#204). If the two functions are now equivalent, delete
loom's and take upstream verbatim — write the row either way.

**PR-3 — `projector.ts` `updateThread` export + upstream's new "copy the array,
don't map" comment/impl (`c216ba4dad`).** **Ruling: keep the `export` (the
`.loom.ts` sibling projector needs it), take upstream's body.** High. Pure
composition; the export is marked.

**PR-4 — `ProjectionSnapshotQuery.ts`: upstream's `unsettledOnly` filter and
`ActiveThreadRowsRequest` vs loom's `role` filter (`RoleFilterInput`) on
`listActiveThreadSessionRows` / `listActiveLatestTurnRows`; upstream's inline
lean-shell mapping (`b6eefc926a`) vs loom's `mapLeanThreadShellRow`.**
**Ruling: compose the request as `{ role, unsettledOnly }` and apply both
predicates in SQL; keep `mapLeanThreadShellRow` (it carries the fork fields)
but adopt upstream's single-decode structure around it; keep both decoders
(`decodeLeanShellSnapshot` is loom's control-plane read).** High on intent,
medium on mechanics. Doc 25 session 2 and session 8 defect 2 (this file lost
columns twice); `sqlcolsweep.py` and `aliascheck.py` are mandatory after.

**PR-5 — Auto-settle: upstream's per-thread `autoSettleDisabledAt` switch
(#11846) + `isAutoSettlementCandidate` vs loom's `loomAutoSettleBlockedThreadIds`
pre-filter.** Options: drop loom's blockers now that upstream has a per-thread
switch; keep both. **Ruling: keep both — the switch is a user opt-out, the
blockers are structural (non-terminal descendants, `yielded`, re-engaged
roots).** High. Carl, pull-7 D7 (blockers on the server, `yielded` added,
`attention` not) and 2026-09-22 ("if I've re-engaged it, then it shouldn't
immediately auto-settle"). Wire upstream's switch into the lean shell row so
loom's sidebar can show it; no second knob.

*The input-shape seam (a clean merge, flagged by the reviewer):* upstream's
new `readSweepSnapshot` (`1d6f23b519`, in `ThreadPullRequestReactor.ts` and
used by the settlement sweep) returns **only unsettled threads** for the
broad sweep and **exactly one thread** for a targeted sweep. Loom's
`loomAutoSettleBlockedThreadIds` (`ThreadSettlementPolicy.ts`) is a graph
pass that needs each candidate's descendants. Ruling: the pre-filter is
**best-effort, not complete**, on both paths. On the broad sweep the
unsettled-only snapshot carries *most* live descendants but not all: a
quiescent non-terminal (e.g. `yielded`) child can be **manually** settled
(`decider.ts` allows manual settlement regardless of plan-state blockers) and
is then excluded by `settled_at` / `settled_override` while its `planLane` is
unchanged — the decider's own descendant walk still sees it and refuses the
parent, and a settled intermediate node likewise breaks the pre-filter's
ancestor walk. On the targeted sweep the one-thread snapshot makes the
pre-filter a no-op. So: keep the pre-filter where the snapshot allows it (it
removes the ordinary case from the dispatch path), and in the reactor treat
`OrchestrationThreadSettleBlockedError` from the decider as an **expected
outcome logged at debug, not WARN, on both sweep paths** (marked hunk); every
other settlement failure keeps its WARN. Do not add a second full-snapshot
read. Verify with `ThreadSettlementReactor.test.ts`: (i) a root with a live
child is not settled by either sweep and produces no warning; (ii) an
unsettled root whose quiescent non-terminal child was **manually settled** is
likewise not auto-settled and produces no warning. Medium-high; the WARN-storm
history is in the policy file's comment (198 warnings in 30 minutes).

**PR-6 — `Sqlite.ts` PRAGMAs and `runMigrations` → `runAllMigrations`.**
**Ruling: union all PRAGMAs (`journal_mode=WAL`, upstream's
`journal_size_limit`, loom's `synchronous=NORMAL`, `cache_size`); the call is
loom's `runAllMigrations`.** High. Doc 22; loom's PRAGMAs were a measured perf
fix on a >2 GB DB.

**PR-7 — `ProjectSetupScriptRunner.ts`: upstream's optional
`completion?` + close-idle-shell-on-exit-0 vs loom's required `completion`,
30-minute timeout and failure fold.** **Ruling: upstream's shape (optional,
closes the idle shell); loom's timeout and the breadcrumb writer re-applied
inside it.** Medium-high. Doc 25 session 5 ("kept loom's implementation —
correct — the breadcrumb is loom's — but dropped upstream's output-line
forwarding"): the breadcrumb is load-bearing for every worktree agent (the
system prompt tells agents to poll it). Verify with the worktree-setup smoke
(§9). Also adopt upstream's submodule-init policy and the t3.json resolver
(`742173a132`) — loom's `bootstrap-worktree` setup script must still run.

**PR-8 — Sidebar: upstream's Working section (beta) + `sortInboxThreadsByReturn`
vs loom's root filter / goal menu / attention / `PendingQuestionWaitAge`.**
**Ruling: adopt upstream's feature as-is (it is opt-in, default off); union
loom's imports and menu splice; make loom's attention flags (`needs_guidance`,
`awaiting_acceptance`, brief-needed) count as "needs you" in upstream's return
predicate as one marked hunk.** High on adopt, medium on the predicate
hunk. Carl's buried-thread problem is to be solved by "auto-settle + collapsed
shelves + drag-to-settle" (pull-7 U3) — this feature is exactly that. Sidebar
ordering stays upstream's comparator (#206).

**PR-9 — `DiffPanel.tsx`: upstream's radio-group scope menu vs loom's By-coder
dropdown group.** **Ruling: upstream's menu; By-coder re-homed as a third radio
group / sub-menu, all hunks marked.** High. Carl's pull-7 addendum ("keep and
repair; mark every hunk") — this is the one orchestration-specific review
affordance he has; #198 already repaired it once.

**PR-10 — `ChatComposer.tsx`: `shownSyncPhase` (anti-flicker) vs loom's
`threadSyncPhase` + `threadRef` for the error text.** **Ruling: upstream's
`shownSyncPhase`; loom's `threadRef` prop re-attached to it.** High. Same
concern twice; loom's addition is a prop, not a mechanism.

**PR-11 — Mobile: upstream retires the legacy grouped list; loom's
`HomeScreen` / `ThreadNavigationSidebar` hunks span both lists plus loom's
search ranking and archived-result rows.** **Ruling: upstream's v2-only list
wholesale (delete loom's v1-path wiring, `threadListV2Enabled` branches and
the `listItems` legacy render); `homeListItems.test.ts` stays deleted; and
loom's thread-search behaviour is preserved **unconditionally** on the
surviving v2 surfaces — server-ranked root hits in server order, archived
shell-less results rendered via `ArchivedSearchResultRow.loom`, sub-thread
excerpts — on the home list, the iPad `ThreadNavigationSidebar` and the
mobile command palette.** High. This is a signed, implemented plan, not a
pull-7 leftover: `plans/thread-content-search/plan.mdx` names the three
mobile consumers and `1fbd74d918` ("feat(mobile): thread search lists rank
root hits in server order, incl. archived roots and sub-thread excerpts")
landed it on the v2 list, which already calls `rankThreadSearchItems`. The
earlier pull-7 "take upstream's redesign, no re-attach" ruling concerned the
mobile *question card*, not search, and does not transfer. Verification
(Session 3 / §9): on the dev instance's mobile build or via the focused
tests, a search returns ranked root hits, an archived root appears with its
pill, and opening the archived result navigates to it. If re-attaching proves
expensive, **record the discovery and stop for a decision** — do not
pre-authorise the loss.

**PR-12 — `model-manifest.json` compatibility ranges and PiDriver parity.**
**Ruling: upstream's manifest structure; union `currentModels` (loom's list
has newer Pi-visible names — keep both sets); add a `pi` entry to
`compatibility` only if the compatibility checker otherwise flags Pi as
unknown/incompatible — otherwise make the checker skip drivers without an
entry (marked).** Medium. Doc 25 "PiDriver capability parity — a standing
check": a no-op is invisible. In the same breath verify cmd+k **Restart
session** (`921cb3c8bc`) works on Pi (stop + `canResumeThread` via session
file) and that **one-click provider update** either works for Pi or is hidden
for it, not broken.

**PR-13 — `ProviderSessionReaper.ts` retention pruning vs upstream's idle
wake-up cut and `liveBindings` logging; `GitVcsDriverCore.ts` `filterOrFail`
vs loom's stderr-in-detail; `VcsStatusBroadcaster.ts` remote-refresh loop.**
**Ruling: upstream's structure in all three, loom's behaviour kept: the
irreversible-class prune (deleted threads only, archived excluded), the
bounded stderr fold into `detail`; log both `prunedCount` and `liveBindings`.**
High. Loom's comments name the invariant; upstream has no equivalent.

**PR-14 — `keybindings.ts`: loom's `notifications.dismissAll` vs upstream's
seven `usage.*` actions (and `mod+w → tab.close`, `mod+alt+…` tab traversal
elsewhere in the file).** **Ruling: union; loom's `mod+w` and tab traversal
stand (pull 7); check upstream's new `mod+[`/`mod+]` and `mod+z` do not
collide with loom's bindings — if they do, upstream's win and loom's move.**
High. Doc 25 keybindings ruling.

**PR-15 — New `shadcn/*` lint over fork web code.** Options: scoped
exemption for `apps/web/src/loom/**`; fix everything before the merge PR;
fix in a stacked PR. **Ruling: fix, in a stacked PR inside this pull's stack
(D-D); zero exemptions; `vp check` must be 0 errors before the stack is
declared done.** High on doctrine (doc 25 "a lint or knip finding on fork
code is fixed or deleted, never exempted"), medium on sizing (≈290 arbitrary
values, 33 raw colours, 17 restyle-candidate files — many arbitrary values will
be `layout`, which the rule allows).

**PR-16 — Lockfile, workspace overrides and toolchain.** **Ruling: upstream's
lockfile; `pnpm-workspace.yaml` = upstream's catalog/overrides + loom's
`@earendil-works/*` pins, pi patch, `astro>esbuild` and `@types/hast`
overrides — then **prove each loom override is still load-bearing by
reverting it** (pull 7's method: 79 errors with, 69 without). vite-plus 1.0
may have moved the esbuild peer; if `astro>esbuild 0.28.2` no longer unifies
the graph, re-pin to whatever version vite-plus-core 1.0 peers.** High.
Doc 25 session 1 and 7.

**PR-17 — Upstream deleted a module loom still imports** (none found in the
dry run; rule for the case). **Ruling: adopt upstream's replacement; never
restore a deleted upstream module to keep a loom import compiling.** High.
Doc 05 §4.3; pull-7 `threadEnvMode` precedent is this range's instance.

**PR-18 — Tests.** **Ruling: fixtures follow source; `loomThreadDefaults` /
`loomThreadShellDefaults` (`orchestration.loom.ts`) absorb any new upstream
thread field once; a loom-only case pinning dropped behaviour is deleted;
upstream cases loom dropped by accident are restored (`markdown-links` /
`externalLauncher` precedent).** High. Carl U5; doc 25 "Unmarked-delta sweep"
test policy.

**PR-19 — Anything that re-introduces a standing drop** (Antigravity driver
registration, `processDomainEvent` / `streamDomainEvents` in
`ProviderRuntimeIngestion`, loom code in `LegacySidebar.tsx`, client-side
`effectiveSettled`, loom's ephemeral reasoning, `title_provenance`,
`AccountUsageRegistry` / `/usage`, loom's Option-1 restart resume).
**Ruling: keep the drop; a merge that brings one back is a resolution
error.** High. Doc 25 "Standing drops", "Restart continuation", post-pull-7
stack table.

**PR-20 — Carl's post-pull-7 live rulings that are not in any doc** (from the
2026-09-22 session; coders treat these as KEEP when a conflict touches them):
consult-thread exchanges and control-plane arrivals render as **cards, not
plain messages**; a **re-engaged settled root does not immediately auto-settle**;
clicking a dispatch/consult card **scrolls to the sub-element**; bare paths in
prose and code fences are **clickable chips rendered inline**; the handoff card
**links to the new thread** once it exists; the sidebar **usage meter** (loom's
redesign) is Carl's primary usage surface and upstream's Limits page is
secondary. Medium-high (his words, paraphrased in `.artifacts/pull8-plan/pull7-rulings.md`
and the session extracts).

---

## 7. Standing rulings carried forward — and which upstream work could overturn them

| ruling (source) | status for pull 8 | watch |
| --------------- | ----------------- | ----- |
| Pi-only driver registry (doc 25 C5) | unchanged | `921cb3c8bc`, `0a04cc50de`, compatibility ranges — parity items, not registry changes |
| `Migrations.ts` byte-identical + `export` exception (doc 22 §3.2) | unchanged; no conflict | V2's `055`/`056` are out of range |
| Auto-settle: server sweep single owner, blockers non-terminal-descendant + `yielded`, not `attention` (D7, #199) | unchanged; compose with #11846 (PR-5) | `1d6f23b519`'s `readSweepSnapshot` narrows the sweep's input (unsettled-only / one thread) — the graph pre-filter becomes best-effort (misses manually-settled non-terminal descendants on the broad sweep, no-op on the targeted one); the decider stays authoritative and its blocked error is logged quietly on both paths — PR-5 |
| Reasoning: upstream's durable rows (D8, #200, doc 26) | unchanged | none in range |
| Titles: upstream's flow wholesale, goal-only fork step (D10c, #207) | unchanged | `2679d279ce`, `a36af0637a` are provider-side |
| Chat surface: upstream's files + marked seams (3A, #196–#209) | unchanged — this is why the zone is small | `shownSyncPhase`, composer suggestion a11y, context-chip `ContextChip` component (`266d70cc4d`) — loom's `#thread` chip must ride it |
| Sidebar ordering: upstream's comparator (U3, #206) | unchanged; Working-section ordering is upstream's too (PR-8) | — |
| Usage: keep the per-thread cost ledger, retire registry/dashboard, poller emits `limits` (D10f, #210) + loom's meter redesign | unchanged | post-V2 usage UI changes are out of range |
| Restart continuation: upstream owns it, two marked hunks (doc 25) | unchanged | `e0db2a5e58`, `e4eb9977f0` land in the same file — re-verify the two hunks after merge |
| Runtime-ingestion `domain` input dropped; bounded ingestion (PR #274) | unchanged | none in range |
| v1 sidebar: loom code dropped not re-homed | unchanged | — |
| Lint/knip: upstream's configs, no fork exemptions | unchanged, now with five more rules (PR-15) | — |
| `WorkspaceOccupancyLease` rename (D10e) | unchanged | — |
| `// loom:` marker convention, unmarkedsweep gate, `UPSTREAM_BASE` advance | unchanged | advance to `024d49520e` |

---

## 8. Sequencing — sessions, order, definition of done

Hard ordering edges: lockfile/workspace → install → contracts → shared/
client-runtime → server → web → mobile for *typecheck*, because `vp run
typecheck` skips downstream packages when one fails. For *resolution*, all 91
files are resolved in session 1 regardless of zone; the edges govern repair
order. Sessions run sequentially in one worktree. Budget: **pull 7 took 8
sessions on 230 files with heavy resolver damage; this one is 91 mostly
single-hunk files — estimate 4 coder sessions + 1 lint session + 1 reviewer
gate, with a 50% contingency to 7.**

**Session 0 (orchestrator, inline, minutes)** — re-fetch both remotes
separately; re-measure `origin/main`; if it moved, diff its new commits against
`.artifacts/pull8-plan/prev2-conflicts.txt` and note any overlap in the brief.
Cut the branch; fix `parsesweep.mjs` / `autoresolve.mjs` per §13 and commit (`--no-verify`); record that tip as `pre_merge_oid`.

**Session 1 — merge and resolve (one coder).**
Record `pre_merge_oid=$(git rev-parse HEAD)`. `git -c rerere.enabled=false
merge --no-ff --no-commit 024d49520e` (the flag is mandatory; do not forget it
on a retry). Resolve in this order: lockfile/workspace (PR-16) →
contracts (PR-1, PR-14) → shared/client-runtime → server core (PR-2–PR-7,
`ws.ts` H4 = ours then apply upstream's `succeedSome`/`asSome` sugar by hand)
→ provider/usage/vcs (PR-12, PR-13) → web (PR-8–PR-10, PR-20) → mobile
(PR-11) → tests (PR-18). After every zone: `parsesweep.mjs` over the zone's
files. Then `git add -A && git commit --no-verify`; record
`merge_oid=$(git rev-parse HEAD)`; verify `${merge_oid}^1 == ${pre_merge_oid}`
and `${merge_oid}^2 == 024d49520e`. Write §10 rows as you go, not at the end.
*DoD:* merge commit exists with correct parents; parse sweep over
`git ls-files '*.ts' '*.tsx'` reports 0 damaged / 0 conflicted; `vp i`
succeeds; `git diff --name-only --diff-filter=D ${pre_merge_oid}..HEAD` ⊆
`git diff --name-only --diff-filter=D c14f6015bf 024d49520e` (31 paths);
§10 has a row for every file that dropped a side.

**Session 2 — typecheck to green (one coder).**
`vp i` first (pull 7 session 5: a `node_modules` older than the merge gave
phantom green). Delete every `tsconfig.tsbuildinfo` before counting.
`vp run typecheck` — must list **all 15 packages**. Work contracts → server →
web → mobile → desktop (`cd apps/desktop && npx tsc --noEmit` if `vp` skips it).
Expect the pull-7 damage classes only where a file had a real conflict: a
duplicated import line, a declaration dropped from a both-add hunk. Run
`lostdecls.py <origin/main-sha> 024d49520e` and adjudicate every "loom lost a
name that still exists upstream" hit. Run `sqlcolsweep.py` and `aliascheck.py`.
*DoD:* 15/15 green from a fresh `vp i`; `lostdecls.py` has no unadjudicated
loom-side loss; `sqlcolsweep.py` 0 problems / 0 unreadable; §10 updated.

**Session 3 — gates and audits (one coder).**
`pnpm build` (web, server, marketing, desktop — `libsecret-1-dev` is
installed since pull 7); `vp check`; targeted tests for every file in the
conflict list plus `server.test.ts`, `ProjectionSnapshotQuery.test.ts`,
`decider.*.test.ts`, `ThreadSettlementReactor.test.ts`; migration smoke on a
`VACUUM INTO` copy (§9); structural composition audit; `unmarkedsweep.sh
--report` with `UPSTREAM_BASE` = `024d49520e`; PiDriver parity checklist
(PR-12); worktree-setup smoke (PR-7); **the clean-overlap semantic review**
(§9 — all 174 files in `review-clean-overlap.txt`, dispositions logged);
**the restart-continuation check** (§9); the mobile search verification
(PR-11); the dev-verify Pi session smoke. Advance `UPSTREAM_BASE`. Write the
session record into this note.
*DoD:* every row in §9 ticked, or — only where §9 marks the row as allowing
it — recorded as a deliberate gap with a §10 row; the branch is pushed; the
merge PR is open (not merged). The clean-overlap review and the
restart-continuation check are **not** gap-eligible.

**Session 4 — lint conformance stacked PR (one coder; may be skipped if
session 3 found `vp check` already 0).** Fix `shadcn/*` findings in fork web
code by picking variants/sizes/tokens, moving feature looks into the feature
component, or deleting dead styling. No allow-list entries for fork files.
*DoD:* `vp check` 0 errors; `knip --include files,dependencies` clean; PR
stacked on the merge PR.

**Session 5 — reviewer gate (reviewer, GPT-6 Astra per Carl's instruction to
the parent).** Re-run every gate from a fresh `vp i`; audit §10 against the
diff; confirm every PR-n outcome; `unmarkedsweep.sh` gate scope; check no
standing drop returned (PR-19); check `${merge_oid}^1`/`^2`. Verdict → parent → Carl
reviews §10 → PRs merge.

If session 1 cannot commit the merge, it banks per §1 and session 2 becomes
"finish resolution, commit"; the budget absorbs one such slip.

---

## 9. Gate and audit checklist for the end state

Tick each in the session record. "Deliberate gap" needs a §10 row.

- [ ] `git rev-parse ${merge_oid}^2` = `024d49520e`; `${merge_oid}^1` = `${pre_merge_oid}` (the branch tip before the merge, i.e. `origin/main` + session 0's tooling commit); no rebase/squash anywhere on the branch
- [ ] `parsesweep.mjs` over all tracked `.ts`/`.tsx`: 0 damaged, 0 conflicted
- [ ] `vp i` from the merged lockfile; **`vp run typecheck` 15/15** with `tsbuildinfo` deleted first
- [ ] `vp check` 0 errors (pre-lint-PR: record the `shadcn/*` count; post: 0)
- [ ] `pnpm build` — web, server, marketing, **desktop** all green
- [ ] `lostdecls.py` adjudicated; `sqlcolsweep.py` 0/0; `aliascheck.py` only its documented inline-struct false positive
- [ ] **Structural composition audit** vs both parents: `server.ts` layer roots, `bin.ts`, `serverRuntimeStartup.ts` phases, `decider.ts` + `decider.loom.ts` arms vs `LOOM_COMMAND_TYPES`, ws/rpc handler maps, `RpcAuthorization` scope map, `routeTree.gen.ts` (regenerated), client-runtime environment-data / config projection arms, contracts struct **fields** (not just names — the auditor only sees top-level declarations), every workspace `package.json` dependency line, package `exports`, stray in-body `export`s (`rg '^\s+export (const|function|let) '`), **module-level import cycles in `packages/contracts`** (`node -e "import('@t3tools/contracts')"` under plain node)
- [ ] **Lost-feature audit**: `git diff --name-only --diff-filter=D ${pre_merge_oid}..HEAD` ⊆ `git diff --name-only --diff-filter=D c14f6015bf 024d49520e` (31 paths); every `// loom:` marker present at `origin/main` in **any of the 265 overlap files** (not only the 91 conflicted) is present at HEAD or has a §10 row
- [ ] **Clean-overlap semantic review** (not gap-eligible): for each of the 174 files in `.artifacts/pull8-plan/review-clean-overlap.txt`, read `git diff c14f6015bf 024d49520e -- <file>` beside the loom hunks in that file at `origin/main`, and for every upstream API/shape change that fork code consumes (new required params, narrowed snapshots such as `readSweepSnapshot`, renamed helpers, changed defaults) decide **kept-compatible / adapted / loom behaviour changed**; log each non-trivial disposition in §10. The marker sweep only proves a marker survived; this proves the behaviour behind it still holds against the loom parent.
- [ ] **Restart continuation** (not gap-eligible; doc 25 "Restart continuation — upstream owns it"): on the isolated dev instance, start a real Pi turn, kill and relaunch the server mid-turn, and prove the **same conversation continues exactly once** (session-file `resumeState` gate; no duplicate turn, no "did not survive a server restart" settlement); the reconnected client catches up without a snapshot gap; and the exclusions hold via the focused recovery tests (`isRecoveryResumable`: attention-flagged, `cancelled` and open-**approval** threads are not continued; an open user-input **question** is not an exclusion — the boot scan cancels the inherited *request* and the *thread* stays eligible for continuation, per doc 25). Evidence: server log lines for `provider-sessions.reconcile` and the thread's activity list before/after.
- [ ] **Mobile search (PR-11)**: ranked root hits in server order, archived root rendered with its pill, opening the archived result navigates — on the home list, iPad sidebar and mobile command palette (focused tests at minimum; `test-t3-mobile` if a simulator is available)
- [ ] `unmarkedsweep.sh --report` clean with `UPSTREAM_BASE` = `024d49520e`; gate scope clean
- [ ] **Migration smoke** on a `VACUUM INTO` copy of `~/.t3/cockpit/userdata/state.sqlite` into a temp `T3CODE_HOME`, built server on a spare `139xx` port (never 13900, never the live DB): upstream `054` applies exactly once in `effect_sql_migrations`; fork lane `loom_sql_migrations` untouched (`1045` still the max); relaunch applies zero; fresh-DB schema equals migrated schema (`sqlite3 .schema` diff). Use the DB-copy safety guard from PR #203.
- [ ] **PiDriver capability-parity diff** (doc 25 table): `ProviderAdapterCapabilities` / optional `ProviderAdapterShape` members at `024d49520e` vs `PiDriver.ts` — expected no new fields; plus the three feature gates of this range: cmd+k Restart session works on Pi; compatibility advisory does not mark Pi unknown/broken; one-click provider update is correct or hidden for Pi
- [ ] **Worktree-setup smoke**: start a thread in a worktree; `t3code-setup-state.json` reaches `ready`; the setup card streams output; the idle shell closes on exit 0
- [ ] **Real Pi session smoke (dev-verify recipe, `docs/dev-site-testing.md`)**: stand up the isolated dev instance, seed with `apps/server/src/dev/seedWorkstream.ts`, open the pairing URL; in the browser: send a turn on a Pi thread and see streamed text + reasoning fold; ask a question via a workstream tool and answer it in the composer panel; spawn one child and see the dispatch card, consult card and roll-up badge; open the Diff tab → By coder; `/handoff`; open an MDX plan in the file preview; check the sidebar usage meter populates; toggle Working section (beta) on and off
- [ ] `docs/upstream-sync/UPSTREAM_BASE` = `024d49520e`; this note has the session records and the completed §10
- [ ] `.repos/` vendored subtrees: Effect catalog is **unchanged** in this range — no re-sync needed (verify `git diff c14f6015bf 024d49520e -- pnpm-workspace.yaml | grep effect` is empty at merge time)
- [ ] PR(s) open against `QuinRiva/loom:main`, `isCrossRepository: false`, **not merged** until Carl reviews §10

---

## 10. Decision log (coders append here)

Rule: **any resolution that drops a side — a hunk, a declaration, a test case,
a dependency line, a field — writes a row**, as does any PR-n whose outcome
differed from the pre-ruling. One line per decision; reasoning in a sentence;
evidence is a doc §, a PR number, a session quote, or "none — default".
Reversibility: `trivial` (re-add a hunk), `local` (one file/feature),
`structural` (contract/schema/migration).

| id | zone / file | what conflicted | ruling | reasoning | evidence | reversibility |
| -- | ----------- | --------------- | ------ | --------- | -------- | ------------- |
| DL-0 | repo | tip `f391794a35` vs `024d49520e` | pre-V2 target | V2 is a re-platform, not a merge (§0, §12) | Carl's addendum; pull-7 framing | structural — pull 9 re-opens it |
| | | | | | | |

The pull-7 "mechanical-resolution ledger" JSON is **not** produced for this
pull (D-B); this table is the ledger.

---

## 11. Risks and recorded failure modes to avoid

1. **The two failed heuristics (doc 25).** (a) Unioning "import-ish" hunks
   splits multi-line import blocks and orphans member lists — 19 files in
   pull 7. (b) "Take upstream where loom's delta is small" dropped the Pi-only
   registry, the handoff drafter, `PI_DEFAULT_MODEL`. Neither is run here;
   union is for complete, balanced statements only, and only after reading.
2. **Declaration-level merge damage in clean regions.** Pull 7 found whole
   declarations, `case` arms and five runtime layers missing from files nobody
   flagged. Mitigation: `lostdecls.py`, the composition audit, and
   `restoredecl.py` for repairs. The auditor sees only top-level names —
   struct **fields** in contracts are the residual blind spot; diff
   `packages/contracts/src/*.ts` against both parents by eye for the 31 files
   upstream touched.
3. **The unmarked-hunk blind spot — and the marked-hunk blind spot.** 174
   overlap files merged clean. `unmarkedsweep.sh` only counts surviving
   markers and skips files now identical to upstream, so it cannot see a lost
   hunk and says nothing about whether the behaviour behind a surviving marker
   still holds when upstream changed the API around it (the `readSweepSnapshot`
   seam in PR-5 is the worked example). The clean-overlap semantic review in §9
   exists for exactly this; the sweep remains the marker gate.
4. **Parse sweep skips conflicted files.** Damage in a conflicted file's clean
   region is invisible until its markers are gone — re-run the sweep per file
   the moment it is resolved.
5. **Phantom-green typecheck.** `node_modules` older than the merge and stale
   `tsconfig.tsbuildinfo` both produced false greens in pull 7. `vp i` and
   delete `tsbuildinfo` before any count that goes in a report.
6. **The pre-commit hook deletes `MERGE_HEAD`.** `--no-verify` on every
   commit; re-check `${merge_oid}^1`/`^2` after each (not `HEAD^2` — repair
   commits are single-parent).
7. **rerere replay.** A replay is undetectable afterwards (`git rerere status` is empty after one); every merge runs with `-c rerere.enabled=false` (§1). A merge run without the flag taints every file it touched.
8. **Lockfile hand-merging.** Never. Upstream's, union the workspace file,
   `vp i`, prove each loom override by reverting it.
9. **Runtime defects typecheck cannot see** (pull 7 session 8 found five:
   SELECT lists narrower than their Result schema, a projector arm that lost
   upstream's fields, an imported-but-never-composed layer, unparseable CSS, a
   contracts import cycle). Mitigation is §9 in full — especially the build,
   the composition audit, `sqlcolsweep.py` and the plain-node contracts import.
10. **Scope creep into V2.** A coder who sees `orchestration-v2` in upstream's
    tree and "helpfully" starts adapting is the single most expensive mistake
    available. The target is `024d49520e`; nothing from `de34391427..` enters
    this branch.
11. **Mobile toolchain.** Expo 58 / RN 0.88 RC; `apps/mobile` must typecheck
    and `vp run lint:mobile` must pass; native builds are out of scope.
12. **`origin/main` moves mid-cycle.** Re-measure overlap before the merge and
    before the ship; fold trivial non-overlapping commits; a hot-file overlap is
    a coder round, not a shipper improvisation (pull-5 lesson).

---

## 12. Orchestration V2 — what it is, what it would cost, and what to do about it

**What upstream did.** One squash, `de34391427`, plus 44 follow-up commits to
`f391794a35`. Per `docs/orchestration-v2/README.md`: app ids primary and
provider ids as refs; runs / execution nodes / provider threads as one graph;
root-run completion as the only turn-completing event; forks and provider
switches as explicit lineage + context-handoff artefacts; capability-driven
features. Per `docs/internals/legacy-orchestration-migration.md`: `state.sqlite`
is snapshotted to `statev2.sqlite` on first launch and only the copy receives V2
migrations; thread shells are imported eagerly and transcripts lazily from the
V1 projection tables; provider sessions, checkpoints, activities, approvals and
plans are **not** migrated; a migrated thread's first continuation starts a
fresh provider session with a 32k-char handoff; protocol version 2 is enforced
on `/ws` (HTTP 426) and in the client's environment descriptor check.
`apps/server/src/orchestration/` is deleted (81 files) and
`orchestration-v2/` is 527 files, 328 of them a replay-backed `testkit`.

**What it does to loom.** Everything in the fork that is not a leaf UI
component sits on V1: `orchestration.loom.ts` extends V1's thread struct and
command/event unions (the file it extends no longer exists upstream);
`decider.loom.ts` / `projector.loom.ts` implement the 25 fork command types
against V1's decider/projector (deleted); the dispatcher, fan-in, liveness,
handoff-drafter, worktree-reaper and exhaustion-resume reactors consume V1
events; 45 fork migrations add columns to V1 projection tables that V2 reads
only as an import source; `WorkstreamDispatcher` spawns children through V1
commands; the MCP workstream tools, goals/tasks persistence and the
`briefNeeded` attention derivation all read V1 shells. 206 fork-only files
import something V2 removed. The tip dry run's 91 modify/delete and 86
file-location conflicts are this.

**What adoption would actually be.** Not a merge: a redesign of the fork's
orchestration onto V2's graph (child threads as `subagent` execution nodes or
as lineage-linked app threads? goals/tasks as V2 entities or a sidecar? which
V2 events replace `thread.message-sent` for the dispatcher?), a data migration
for goals/tasks/workstream fields alongside upstream's importer, PiDriver as a
V2 adapter, and the web/mobile loom surfaces re-pointed at V2 projections —
followed by the ordinary conflict work on the ~340 overlapping files. Weeks,
not sessions; and it needs a plan Carl reviews before code.

**What is in Carl's favour for doing it.** His pull-7 framing — upstream's
engine is "more rigorously developed and tested by better software engineers",
"drop my approach and adopt the upstream approach"; V2 explicitly models
subagents, forks, handoffs and capability gaps, which is loom's whole domain;
staying on V1 means every future upstream pull is V2-shaped and loom's
tracking effectively ends at `024d49520e`. **Against:** he actively uses loom
daily and rejected half-baked deploys; the OOM episode of 2026-09-25 shows how
fragile the engine path is under his load (49 concurrent agents); V2 is one
day old upstream and its 44 follow-ups are already "runs no longer get
stuck"-class fixes.

**Recommended next step (not part of pull 8):** after pull 8 lands, a
researcher/planner thread reads `docs/orchestration-v2/*`, maps every fork
command type, reactor and table to a V2 concept, sizes the three paths —
(a) re-platform onto V2, (b) stay on V1 and cherry-pick non-engine upstream
work going forward, (c) hybrid: adopt V2's persistence/import boundary first —
and brings Carl a decision document. Pull 8 is a prerequisite for all three
and prejudices none.

---

## 13. Tooling notes

- `docs/upstream-sync/pull7-tools/parsesweep.mjs` and `autoresolve.mjs`
  import esbuild by an absolute path into the `t3code-ea251a06` worktree.
  Replace the import with a run-time lookup so the tool works in any worktree
  and survives the vite-plus 1.0 esbuild bump:
  ```js
  import * as NodeFS from "node:fs";
  const esbuildMain = NodeFS.globSync("node_modules/.pnpm/esbuild@*/node_modules/esbuild/lib/main.js").sort().at(-1);
  const esbuild = await import(new URL(esbuildMain, `file://${process.cwd()}/`).href);
  ```
  (Verified on this tree under Node 24: resolves `esbuild@0.28.2` and `transform` is a function. A copy patched with a relative path is at `.artifacts/pull8-plan/parsesweep.mjs` and sweeps this tree: `swept 2 | parse-damaged 0`.) Commit the fix to `pull7-tools/` on the sync branch in session 0, **before** the merge, and record the resulting tip as `pre_merge_oid` — it becomes the merge's first parent (§1). The tools are tracked, so this is one ordinary single-parent commit.
- `sqlcolsweep.py`, `aliascheck.py`, `lostdecls.py`, `restoredecl.py`,
  `unmarkedsweep.sh`, `brief.py`, `hunks.sh`, `hx.py`, `union.py`,
  `sideresolve.py`, `whatismissing.sh` run as-is on this tree (verified:
  `sqlcolsweep.py` → `0 problems; 0 unreadable`; `unmarkedsweep.sh --report`
  → clean vs `c14f6015bf`).
- `git merge-tree --write-tree` is unavailable (git 2.30); size with a
  detached scratch worktree + `git merge --no-commit` + `--abort`, as this plan
  did, and `git worktree remove` it after.
- `pnpm-lock.yaml` conflicts: `git checkout --theirs pnpm-lock.yaml` then `vp i`.

## Appendix A — reproduce the sizing

```sh
git fetch origin && git fetch upstream            # separately
git rev-list --count c14f6015bf..upstream/main    # 409
git rev-list --count c14f6015bf..024d49520e       # 364  (de34391427^)
git worktree add --detach /tmp/pull8-dryrun origin/main
cd /tmp/pull8-dryrun
git -c rerere.enabled=false merge --no-commit --no-ff upstream/main; git diff --name-only --diff-filter=U | wc -l   # 348
git merge --abort
git -c rerere.enabled=false merge --no-commit --no-ff 024d49520e;   git diff --name-only --diff-filter=U | wc -l   # 91
for f in $(git diff --name-only --diff-filter=U); do printf "%4d %s\n" "$(grep -c '^<<<<<<< ' $f)" $f; done | sort -rn
git merge --abort
cd - && git worktree remove --force /tmp/pull8-dryrun
```

## Appendix B — exact file-to-zone partition (91 files, one zone each)

Generated from `.artifacts/pull8-plan/prev2-conflicts.txt`; the zone table in §3 is derived from this list and sums to 91.

| zone | n | files |
| --- | ---: | --- |
| server core/orchestration | 19 | `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts` · `apps/server/src/orchestration/Layers/CheckpointReactor.ts` · `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts` · `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` · `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts` · `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` · `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts` · `apps/server/src/orchestration/ThreadSettlementReactor.test.ts` · `apps/server/src/orchestration/ThreadSettlementReactor.ts` · `apps/server/src/orchestration/decider.ts` · `apps/server/src/orchestration/projector.test.ts` · `apps/server/src/orchestration/projector.ts` · `apps/server/src/server.test.ts` · `apps/server/src/server.ts` · `apps/server/src/serverRuntimeStartup.reconcile.test.ts` · `apps/server/src/serverRuntimeStartup.test.ts` · `apps/server/src/serverRuntimeStartup.ts` · `apps/server/src/serverSettings.ts` · `apps/server/src/ws.ts` |
| web sidebar/nav/routes | 13 | `apps/web/src/components/CommandPalette.logic.ts` · `apps/web/src/components/NoProjectsHero.tsx` · `apps/web/src/components/Sidebar.logic.test.ts` · `apps/web/src/components/Sidebar.logic.ts` · `apps/web/src/components/Sidebar.tsx` · `apps/web/src/components/ThreadNotificationCoordinator.tsx` · `apps/web/src/components/ThreadRouteView.tsx` · `apps/web/src/components/ThreadSearchMatch.tsx` · `apps/web/src/components/ThreadStatusIndicators.tsx` · `apps/web/src/hooks/useHandleNewThread.ts` · `apps/web/src/routes/__root.tsx` · `apps/web/src/routes/_chat.index.tsx` · `apps/web/src/state/threads.ts` |
| web chat surface | 12 | `apps/web/src/components/ChatMarkdown.tsx` · `apps/web/src/components/ChatView.logic.test.ts` · `apps/web/src/components/ChatView.tsx` · `apps/web/src/components/chat/ChatComposer.tsx` · `apps/web/src/components/chat/ComposerCommandMenu.tsx` · `apps/web/src/components/chat/FileTagChip.tsx` · `apps/web/src/components/chat/MessagesTimeline.tsx` · `apps/web/src/components/chat/ModelPickerContent.tsx` · `apps/web/src/components/composerContextPresentation.tsx` · `apps/web/src/components/composerInlineChip.ts` · `apps/web/src/index.css` · `apps/web/src/queuedMessageStore.ts` |
| web panels/settings/other | 8 | `apps/web/src/components/DiffPanel.tsx` · `apps/web/src/components/files/FilePreviewPanel.tsx` · `apps/web/src/components/settings/DiagnosticsSettings.tsx` · `apps/web/src/components/settings/ProviderSettingsPanel.tsx` · `apps/web/src/components/settings/SettingsPanels.tsx` · `apps/web/src/components/usage/usageProviders.ts` · `apps/web/src/rightPanelStore.ts` · `apps/web/src/terminal-links.ts` |
| mobile | 7 | `apps/mobile/src/features/home/HomeScreen.tsx` · `apps/mobile/src/features/home/homeListItems.test.ts` · `apps/mobile/src/features/keyboard/threadKeyboardShortcuts.ts` · `apps/mobile/src/features/threads/ThreadNavigationSidebar.tsx` · `apps/mobile/src/features/threads/thread-list-v2-items.tsx` · `apps/mobile/src/features/threads/threadOrder.ts` · `apps/mobile/src/features/usage/usageProviders.ts` |
| lockfile/workspace/config | 6 | `apps/server/package.json` · `apps/web/package.json` · `pnpm-lock.yaml` · `pnpm-workspace.yaml` · `scripts/lib/cli-external-packages.test.ts` · `third-party-licenses.config.json` |
| provider/driver SPI | 6 | `apps/server/src/provider/Layers/ProviderRegistry.test.ts` · `apps/server/src/provider/Layers/ProviderService.test.ts` · `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts` · `apps/server/src/provider/Layers/ProviderSessionReaper.ts` · `apps/server/src/provider/model-manifest.json` · `apps/server/src/relay/AgentAwarenessRelay.test.ts` |
| contracts | 5 | `packages/contracts/src/keybindings.ts` · `packages/contracts/src/model.ts` · `packages/contracts/src/rpc.ts` · `packages/contracts/src/settings.test.ts` · `packages/contracts/src/usage.ts` |
| server project/worktree setup | 4 | `apps/server/src/process/externalLauncher.test.ts` · `apps/server/src/project/AgentSessionScanner.test.ts` · `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · `apps/server/src/project/ProjectSetupScriptRunner.ts` |
| server usage | 4 | `apps/server/src/usage/UsageService.test.ts` · `apps/server/src/usage/UsageService.ts` · `apps/server/src/usage/usageTranscriptReader.test.ts` · `apps/server/src/usage/usageTranscriptReader.ts` |
| server vcs/source control | 3 | `apps/server/src/sourceControl/GitHubSourceControlProvider.test.ts` · `apps/server/src/vcs/GitVcsDriverCore.ts` · `apps/server/src/vcs/VcsStatusBroadcaster.ts` |
| shared/client-runtime | 3 | `packages/client-runtime/src/operations/projects.ts` · `packages/client-runtime/src/state/shell-sync.test.ts` · `packages/shared/src/usageMerge.test.ts` |
| persistence | 1 | `apps/server/src/persistence/Layers/Sqlite.ts` |

Total: 91 files.

