## Appendix B.8: VCS, projects, checkpoints, workspace, dev-runner (23 files, 53 markers, 152 `loom:` lines) · lane 3 VCS and projects

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "Multi-repository projects".

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/server/scripts/migrate-dev-db.ts` · 4m · 23L · [0/41B] [17/6c] [23/56c] [9/9c]
- `apps/server/src/assets/AssetAccess.test.ts` · 4m · 6L · [23/22c] [1/1c] [1/1c] [1/1c]
- `apps/server/src/assets/AssetAccess.ts` · 4m · 6L · [10/4c] [1/1c] [2/3c] [1/1c]
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts` · 2m · 3L · [2/3c] [73/13c]
- `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` · 1m · 4L · [1/3c]
- `apps/server/src/orchestration-v2/CheckpointService.test.ts` · 1m · 2L · [3/1c]
- `apps/server/src/orchestration-v2/CheckpointService.ts` · 1m · 10L · [1/6c]
- `apps/server/src/process/externalLauncher.ts` · 1m · 2L · [5/10c]
- `apps/server/src/project/ProjectService.test.ts` · 2m · 7L · [43/89c] [2/1A]
- `apps/server/src/project/ProjectService.ts` · 1m · 11L · [18/41c]
- `apps/server/src/project/ProjectSetupScriptRunner.test.ts` · 1m · 2L · [2/2c]
- `apps/server/src/project/RepositoryIdentityResolver.test.ts` · 1m · 2L · [26/32c]
- `apps/server/src/vcs/GitVcsDriver.ts` · 6m · 2L · [2/1c] [3/5c] [5/8c] [4/4c] [4/27c] [6/15c]
- `apps/server/src/vcs/GitVcsDriverCore.test.ts` · 3m · 3L · [115/1c] [2/64c] [16/39c]
- `apps/server/src/vcs/GitVcsDriverCore.ts` · 6m · 11L · [9/14c] [0/36B] [7/20c] [16/14c] [6/10c] [1/2c]
- `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` · 2m · 5L · [2/1c] [128/41c]
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` · 7m · 14L · [1/2c] [3/4c] [14/56c] [0/32B] [174/55c] [30/6c] [0/84B]
- `apps/server/src/workspace/WorkspaceFileSystem.test.ts` · 1m · 3L · [14/23c]
- `apps/server/src/workspace/WorkspaceFileSystem.ts` · 1m · 6L · [10/9c]
- `apps/server/src/workspace/WorkspaceSearchIndex.ts` · 1m · 4L · [2/2c]
- `packages/client-runtime/src/state/projectCommands.ts` · 1m · 2L · [34/1c]
- `scripts/dev-runner.test.ts` · 1m · 10L · [9/10c]
- `scripts/dev-runner.ts` · 1m · 14L · [0/10B]

### Per-hunk doctrine

Rules are from pull 15 §7.1. "G1" = the Gate 1 reviewer must read it.

#### `apps/server/src/vcs/GitVcsDriver.ts` (6 hunks)

| Hunk | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @44 | 2/1c | #23715 `quoteGitPatchPath` import | `GIT_LOCK_RETRY` import (still used by hunk 6) | U | Keep both imports. If hunk 2 is dropped (see below), shorten the comment to "git lock retry, batched remote status". | no |
| 2 @198 | 3/5c | #40282 `stage.unverified` | `noVerify` option | U, or drop | `noVerify` has **no caller** in Loom HEAD or the trial: its only caller was removed by `37b8b7630b` "delete runtime-dead Loom code". Recommend taking upstream's side and dropping `noVerify` with core hunk 5. If kept, union. | yes |
| 3 @358 | 5/8c | #39915 `AwaitStatusFetch` | `GitRemoteStatusBatchInput` (DL-1614 batch) | U | Keep both. | no |
| 4 @394 | 4/4c | #40556 `readLocalStatusRefSnapshot`, #29155 `readRefSnapshot` | `statusDetailsRemoteBatch` | U | Keep all three members. | no |
| 5 @1263 | 4/27c | #23715 private object dir for checkpoint packs | Comment explaining the throwaway index | U | Upstream's block first, then Loom's 4-line comment directly above `const commitEnv`; it still describes `GIT_INDEX_FILE`. | no |
| 6 @2536 | 6/15c | #30829 recurse `deleteCheckpointRefs` into submodules | One atomic `update-ref --stdin` with `GIT_LOCK_RETRY` | D | Replace upstream's per-ref `Effect.forEach` with Loom's transaction, then keep upstream's submodule loop after it. A `delete` of a missing ref inside `--stdin` exits 0 (tested in section 9), so submodules without the refs do not fail the transaction. Loom's 3-line comment above already merged. | yes |

No hunk here is kind `o`. Every hunk in both `GitVcsDriver*.ts` files is `c` except core hunk 2 (`B`).

#### `apps/server/src/vcs/GitVcsDriverCore.ts` (6 hunks)

Background: Loom (`215434f09d`, DL-1614) **deleted** upstream's `defaultBranchCache` keyed by `gitCommonDir`. It replaced it with one keyed by `StatusDefaultBranchCacheKey{gitCommonDir, remoteName}` and **deleted the `STATUS_DEFAULT_BRANCH_CACHE_TTL` constant**. Upstream then moved its cache and made it resolve the primary remote's default (#28815: origin, else the first remote when there is no origin). That is the same rule Loom's batch applies (`primaryRemoteName = origin ?? first`), so Loom's re-keying is **Superseded**.

| Hunk | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @258 | 9/14c | #33310 `rawChangeType` | `parseUpstreamTrack` (batch) | U | Keep both functions. | no |
| 2 @1889 | 0/36B | #38451 `resolveReviewRepository`; #28815 moves `defaultBranchCache` | none: Loom deleted the old cache | B (a Loom deletion against an upstream move) | **Take upstream's whole insertion**, then undo Loom's re-keying everywhere: restore `const STATUS_DEFAULT_BRANCH_CACHE_TTL = Duration.minutes(5);` (the trial references it at line 1922, but Loom's silent deletion removed its definition), delete `class StatusDefaultBranchCacheKey` (trial 193), delete Loom's `readDefaultBranchName` and second `const defaultBranchCache` (trial 2150 to 2175; **the trial has two `defaultBranchCache` declarations**), restore upstream's `Cache.invalidate(defaultBranchCache, cacheKey)` (trial 1959 to 1963), and in `readStatusDetailsRemoteBatch` use `Cache.get(defaultBranchCache, input.gitCommonDir)` with no `primaryRemoteName` guard (trial 2951). | yes |
| 3 @2181 | 7/20c | #36268 `rev-parse --verify --symbolic-full-name` and `gitDirArgs` | `resolveDefaultBranchName` through Loom's keyed cache | Superseded | Take upstream's side. | yes |
| 4 @3191 | 16/14c | #40277 skips the default-branch lookup when there is no remote; #28815 primary remote | Loom's keyed `Cache.get` with origin | Superseded | Take upstream's side. | yes |
| 5 @3902 | 6/10c | #28912/#33115 `--pathspec-from-file` for partial commits | `--no-verify` push | drop (recommended) or U | Dead, as in `GitVcsDriver.ts` hunk 2: take upstream's. If kept, **Loom's `args.push("--no-verify")` must come before upstream's `if (partialCommitPaths) args.push("--only", ...onlyPathspecArgs)`**, because `onlyPathspecArgs` starts with `--` and anything after it is a pathspec. | yes |
| 6 @7414 | 1/2c | #40556/#29155 new members | `statusDetailsRemoteBatch` | U | Keep all three. | no |

#### `apps/server/src/vcs/VcsStatusBroadcaster.ts` (7 hunks)

Loom replaced upstream's per-folder remote poller with one poller per repository that batches all its worktrees (DL-1614; DL-1814 in pull 15). Upstream's changes in range: #40556 (head watchers refresh branch pickers after an outside `git switch`), #29155/#40093 (skip the local re-read when no ref moved), #40385/#40452 (`refsDigest` lets the client keep its branch list), #40450 (turn end reads upstream divergence once), #35631 (bounded status cache), and #33845 (the fetch interval class moved to `VcsAutomaticFetchInterval.ts`). Loom already honours the zero-interval rule.

| Hunk | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @41 | 1/2c | #33845 moved `VcsAutomaticFetchInterval`; `GitVcsDriver` type import | foreign-home guard import (DL-191) | U | Keep all three imports. | no |
| 2 @171 | 3/4c | #40556 `ActiveHeadWatcher` | `RemoteStatusSubscriber` | U | Two interfaces, **each with its own closing brace**: the shared `}` after the markers closes only one. | no |
| 3 @351 | 14/56c | #35631 `activeRemoteReads` counting in `withRemoteWriteLock`, eviction helpers; #40556 `headWatchersRef`; #40450 `upstreamReads` | `withRemoteWriteLocks` (sorted multi-lock), `pollersRef`, `repositoryKeyByCwdRef` | D | Take upstream's block whole (its `withRemoteWriteLock` body and all new state). Append Loom's `withRemoteWriteLocks` after it and keep `repositoryKeyByCwdRef`. Keep **one** `pollersRef`. Loom's multi-lock composes `withRemoteWriteLock`, so batch entries count as active reads and are not evicted mid-batch. | yes |
| 4 @610 | 0/32B | #40450 `refreshLocalStatus` updates divergence and stores `upstreamReads` | Loom's own `refreshLocalStatus` sits later (trial 739): it wakes the repository poller on a branch change | D | **Duplicate declaration.** Keep upstream's body here and add Loom's branch-change wake to it: read `previousRefName` before `refreshLocalStatusCore`, and if `local.refName !== previousRefName`, `Queue.offer` the poller's `wake`. Delete Loom's copy at trial 739. Mark the added lines `// loom:` (DL-1614). | yes |
| 5 @776 | 174/55c | #29155/#40093 `refreshRemoteStatus(cwd, {refsAtLocalRead})`; new `refreshRemoteAndLocalTotals` | `refreshRepositoryRemoteStatus` body, `clearInitialPending`, `logRefreshFailure`, the repository-keyed `makeRemoteRefreshLoop` | D (keep both halves) | Keep Loom's four functions whole. **Also keep upstream's `refreshRemoteStatus`**, re-creating its header from upstream lines 682 to 690: upstream's silently merged `reconcileCheckedOutRef` (#40556, trial 1399) calls `refreshRemoteStatus(cwd, { refreshUpstream: false })`, which Loom does not define. Keep upstream's `refreshRemoteAndLocalTotals`, but when `repositoryKeyByCwdRef` has the cwd, run `refreshRepositoryRemoteStatus(repositoryKey, [cwd], { refreshUpstream, policyCwds: [policyCwd] })` in place of its read, auto-pull and update steps. Then return `{ status: mergeGitStatusParts(getStatusParts(cwd)), refs: refsBeforeLocalRead === null ? null : readLocalStatusRefSnapshot(cwd) }`. Trap: git merged upstream's `refsAtLocalRead` option line into **Loom's** `refreshRepositoryRemoteStatus` header (trial 773). Delete it there: Loom's body does not use it. | yes |
| 6 @1031 | 30/6c | #29155/#40385 `refreshStatus` returns `withRefsDigest` from `refreshRemoteAndLocalTotals` | Loom's no-poller and batch branches | D | Take upstream's side. Loom's branching now lives in `refreshRemoteAndLocalTotals` (hunk 5), which also serves upstream's `refreshAfterCheckout`. Loom's `refreshStatus` without a digest would make every client refresh reload the branch list. | yes |
| 7 @1112 | 0/84B | #29155/#40093 per-folder `makeRemoteRefreshLoop` | none: Loom replaced it with the repository loop | B (a Loom deletion against an upstream edit) | **Drop upstream's side.** It is a second `makeRemoteRefreshLoop` with a different signature; `retainRemotePoller` (trial 1230) calls Loom's. The skip-local-re-read-when-refs-unchanged idea (#40093) is not ported into the batch; that is a follow-up (section 8). | yes |

#### `apps/server/src/assets/AssetAccess.ts` (4 hunks)

| Hunk | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @614 | 10/4c | #39736 `WorkspacePreviewRevisions.revision` keeps unchanged previews from reloading | Loom's stat-tuple `fileRevision` for the same purpose | Superseded | Take upstream's. | no |
| 2 @708 | 1/1c | same | same line plus a loom comment | Superseded | Take upstream's. | no |
| 3 @1162 | 2/3c | #39491 a link must still point at a previewable file | `mutable: true` (revalidating Cache-Control; the consumer is `http.ts:468`, owned by `remote-auth-deploy`) | U | `exactWorkspaceFile && isWorkspacePreviewEntryPath(exactWorkspaceFile) ? { kind: "file", path: exactWorkspaceFile, mutable: true }`. | no |
| 4 @1192 | 1/1c | #37950 `renderIntent: "file-preview"` | `mutable: true` | U | `{ kind: "file", path: workspaceFile, renderIntent: "file-preview", mutable: true }`. Upstream still sends `private, max-age=3600` for workspace files, so Loom's `mutable` is not superseded. | no |

#### `apps/server/src/assets/AssetAccess.test.ts` (4 hunks)

| Hunk | Shape | Upstream | Loom | Rule | Resolution |
| --- | --- | --- | --- | --- | --- |
| 1 @229 | 23/22c | #36680 theme background test | test for tool images stored as attachment files | T | Keep both tests. |
| 2 @1212 | 1/1c | `renderIntent: "file-preview"` | `mutable: true` | T | Both keys, matching what hunks 3 and 4 of the source return for that path. |
| 3 @1221 | 1/1c | same | same | T | Both keys. |
| 4 @1250 | 1/1c | same | same (marked) | T | Both keys, keep the marker. |

#### `apps/server/scripts/migrate-dev-db.ts` (4 hunks)

| Hunk | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 @74 | 0/41B | #23191 new `MigrateDevDbLegacySourceError`; the region also re-adds `MigrateDevDbServerRunningError` and `MigrateDevDbDestinationBusyError` | Loom moved those two into `threadTreeSlice.loom.ts` as `ThreadTreeServerRunningError`/`ThreadTreeDatabaseBusyError` (`d7d7f4a538`) | B (part Loom deletion) | Take **only** `MigrateDevDbLegacySourceError`. Drop the other two classes: nothing in the merged file constructs them, and Loom's test asserts `ThreadTreeServerRunningError`. | yes |
| 2 @182 | 17/6c | #23191 comment on the legacy guard | `rootIsCopied` (`--root`), `copySourceSlice(sourcePath, input)`, `readSliceSchema` | D | Keep Loom's code; take upstream's 3-line comment in place of Loom's 1-line one. | no |
| 3 @214 | 23/56c | Inline schema read and foreign-key cascade (Loom already has both in `readSliceSchema`), plus the #23191 legacy-thread guard | Loom's select-first slice | D | Keep Loom's block and drop upstream's schema and cascade code. **Add upstream's legacy-thread guard** (`if (tables.some(t => t.name === "projection_threads")) { …count… if (legacyThreads > 0) return yield* new MigrateDevDbLegacySourceError(...) }`) using Loom's `tables`/`filtered`. On the live cockpit database the guard counts **0** of 4,340 legacy rows (section 9), so it will not block Loom's dev seed. | yes |
| 4 @588 | 9/9c | Map only `SqlError` to a phase error, so the legacy error surfaces | Loom provides `ProjectionStore` and uses `wrapPhase` | D | Keep Loom's `Effect.provide(ProjectionStore.layer…)` and console line. Replace `wrapPhase("snapshot", sourcePath)` with upstream's `Effect.catchTags({ SqlError: … MigrateDevDbPhaseError … })`. `wrapPhase` maps every error and would bury `MigrateDevDbLegacySourceError`, which upstream's test (trial `migrate-dev-db.test.ts:385`) asserts by tag. | yes |

Also do, in a file outside the conflict list: add `"task_folders"` to `PER_INSTANCE_TABLES` in `apps/server/src/persistence/threadTreeSlice.loom.ts` (section 4). Tables 104 and 105 do not break the seed: Loom copies by schema, so `tracked_folders_json` and `task_folders` come along. That copy is the problem the one-line change fixes.

#### The other 16 files

| File | Hunks | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/server/src/checkpointing/CheckpointDiffQuery.ts` | [2/3c] | #35925 imports `nestedScopePaths` and `ProjectionCheckpointContext` | `loomBaselineRef` import | U | Keep all three imports. | no |
| same | [73/13c] | #35925 factored the per-scope patch into `patchBetween(...)` and `withRepositories(diff)` | P3-17/DT-50: a one-run diff starts at the Loom baseline when it exists | D | Take upstream's shape. Before `const excludePaths`, insert Loom's `loomBaseline`/`diffFromRef` computation (the `hasCheckpointRef` check) and pass `fromCheckpointRef: diffFromRef, // loom:` into `patchBetween`. Loom's numstat, import-filter, batching and truncation code is now inside `patchBetween`; drop it. | yes |
| `apps/server/src/orchestration-v2/CheckpointService.ts` | [1/6c] | #35925 adds `WorkspaceFolders`, `FileSystem`, `Path` to the layer type | `LoomStoreV2` | U | Upstream's union plus `\| LoomStoreV2 // loom:`. See section 4 for the silently merged body. | no |
| `apps/server/src/orchestration-v2/CheckpointService.test.ts` | [3/1c] | `layerNoTrackedFolders` | `LoomStore` mock | T | Keep both layers. | no |
| `apps/server/src/orchestration-v2/CheckpointCaptureService.test.ts` | [1/3c] | #18379/#29196 test imports | `LoomStore` import | T | Keep all imports. | no |
| `apps/server/src/process/externalLauncher.ts` | [5/10c] | #37201 Zed: a `file:line` path that collides with a real file keeps its literal spelling | `clientLaunch` editors refuse on the server | U | Loom's `if ("clientLaunch" in editorDef) { … }` **with its own closing brace**, then upstream's `target`/`position` block. | no |
| `apps/server/src/project/ProjectService.ts` | [18/41c] | #35925 `commit(command, updater)` revalidates `trackedFolders` under the lock | Writes `autoPull` to the project settings override | D | Take upstream's `} as const;` and `yield* commit(command, …)`. Then Loom's `if (input.autoPull !== undefined) { … updateSettings … }` block. Then upstream's `if (workspaceRoot !== previousRoot \|\| input.faviconPath !== undefined)`. Loom's `// loom: autoPull is routed to settings` line in the merged command object stays. | yes |
| `apps/server/src/project/ProjectService.test.ts` | [43/89c] | #35925 tracked-folder tests | autoPull routing test | T | Keep both. | no |
| same | [2/1A] | Upstream comment on the same `waitForProject` wait | Loom comment only | Superseded | Take upstream's comment; upstream does the same wait. | no |
| `apps/server/src/project/ProjectSetupScriptRunner.test.ts` | [2/2c] | Imports `NodeServices` and `assert` | Same `NodeServices` import, marked | theirs | Take upstream's two lines. | no |
| `apps/server/src/project/RepositoryIdentityResolver.test.ts` | [26/32c] | Nested-root `each` test | Memoisation test (upstream's resolver still runs `rev-parse --show-toplevel` through `ProcessRunner`, so it compiles) | T | Keep both. | no |
| `apps/server/src/workspace/WorkspaceFileSystem.ts` | [10/9c] | #36545 binary and invalid-UTF-8 files are refused, so a save cannot corrupt them | Per-request read cap (`maxBytes`, for the larger `.mdx` plan budget) | D | Take upstream's side. **Trap:** upstream's `const truncated = stat.size > PROJECT_READ_FILE_MAX_BYTES;` merged silently just above the markers (trial 621). Change that line to `stat.size > maxBytes; // loom: per-request read cap`. Keeping Loom's side would declare `truncated` twice and lose the cap. | yes |
| `apps/server/src/workspace/WorkspaceFileSystem.test.ts` | [14/23c] | WSL drive-path test | Unreadable file reads as null (chat chips) | T | Keep both. | no |
| `apps/server/src/workspace/WorkspaceSearchIndex.ts` | [2/2c] | #36273: `execute` now returns a Promise and uses fff's `*Async` methods, so a lock held by the watcher cannot freeze the server | `"glob"` operation (chat file-chip `locateFiles`) | U + E | `operation: "directorySearch" \| "fileSearch" \| "glob" \| "grep" \| "mixedSearch"` with `execute: () => Promise<Result<A>>`. Loom's `finder.glob` is synchronous, and upstream's fff patch adds no `globAsync`, so wrap it as `() => Promise.resolve(finder.glob(...))` (trial 1428). That compiles but **keeps the server-freeze risk on the file-chip path**; see section 8. | yes |
| `packages/client-runtime/src/state/projectCommands.ts` | [34/1c] | #36664 hoisted `readFile` (now with an optimistic-file `onAnswer`) | Inline `readFile` plus `readAbsoluteFile`, `listAbsoluteDirectory`, `locateFiles` | D | Take upstream's `readFile,` shorthand; upstream's hoisted one keeps `fileMetadata.seedAfterRead`. Keep Loom's three entries and their `// loom:` comments. | no |
| `scripts/dev-runner.ts` | [0/10B] | #38807: an explicit `~/.t3` home is dropped so dev never writes the live `~/.t3/userdata` | Port-scoped home (DL-1500), already set in `output` above | D (small) | Drop upstream's 10 lines: they redeclare `const path` and would unset Loom's `T3CODE_HOME`. Non-desktop dev is already safe, because `<base>/dev-instances/<port>` is never a live userdata. **Port the guard to desktop mode**, where Loom passes `resolvedBaseDir` through: `isDesktopMode && resolvedBaseDir === path.join(HomeDirectory, ".t3") ? delete T3CODE_HOME : …`, marked `// loom:`. | no |
| `scripts/dev-runner.test.ts` | [9/10c] | Two new `~/.t3` → `undefined` assertions | Port-scoped expectations | T | Keep Loom's seven assertions. Rewrite upstream's two as `scoped("/home/dev/.t3")` (non-desktop), or as `undefined` only if the test runs desktop mode after the port above. | no |

#### The two VCS test files (rows added in S0 assembly; Rule T, pull 13 §5.2)

| File | Hunks | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/server/src/vcs/GitVcsDriverCore.test.ts` | h1 [115/1c] | The opening line of upstream's new test "reports status on unborn HEAD without failing or dropping its upstream" | Loom's 115-line test "batches tracked, untracked, and detached branch remote status" (the repository batch, DL-1614) | T | Both: Loom's test whole, then upstream's `it.effect("reports status on unborn HEAD…` line, whose body follows the marker. | no |
| same | h2 [2/64c], h3 [16/39c] | Upstream rewrote "pushes with upstream setup and skips when already up to date" as `it.effect.each([false, true])` (64 lines) and changed the body of the test that follows it | Loom's test "uses the existing tracking ref when the worktree base fetch fails" (comment, title line and 16-line body) | T | The two hunks interleave the openings and bodies of two different tests, so do not resolve them line by line. Read both stages (`git show :2:<path>` and `:3:<path>`) from line 9,870 on: take upstream's `it.effect.each` test whole and upstream's version of the test that follows it, then insert Loom's marked test whole after them. Drop the old "pushes with upstream setup…" title line that trails Loom's side of h2. `parsesweep.mjs` must pass on the file. | no |
| `apps/server/src/vcs/VcsStatusBroadcaster.test.ts` | h1 [2/1c] | `localStatus: (_input, options) =>` | `resolveRemoteStatusRepository: () => Effect.succeed(null),` in the shared mock | U | Loom's `resolveRemoteStatusRepository` line (marked), then upstream's `localStatus: (_input, options) =>`. | no |
| same | h2 [128/41c] | New test "publishes a checkout's branch before returning, ahead of the remote read" | Loom's batch tests ("polls all subscribed worktrees from one repository batch" and its siblings, DL-1614) | T | Both: Loom's 128 lines, then upstream's 41. S2a adds `readLocalStatusRefSnapshot`, `readRefSnapshot` and `upstreamDivergence` to each `Layer.mock(GitWorkflowService)` in Loom's tests, which upstream's `refreshStatus` and `refreshLocalStatus` now call. | no |

### Silently merged files Gate 2 reads in this zone

- **`apps/server/src/orchestration-v2/CheckpointService.ts`** (conflicted at one line, but the body merged silently, +699 upstream lines). Loom's P3-17 baseline capture (trial 505 to 517) landed in upstream's renamed `captureScopeBaseline`, **before** upstream's "skip after repeated capture timeouts" check (#29196, trial 531) and outside `captureWorkspaceCheckpoint`'s timeout handling. It also passes no `excludePaths`. On a slow repository, a Loom thread therefore still pays a timed-out capture on every turn start, which is the delay #29196 and #40411 removed. Fix: move Loom's block after the timeout check and pass `...(input.excludePaths === undefined ? {} : { excludePaths: input.excludePaths })`. The diff-side Loom lines (trial 762 to 792) are intact and correct.
- **`apps/server/src/checkpointing/CheckpointStore.ts`**: #35925 adds `captureHeadCheckpoint`, which writes a checkpoint ref, **without Loom's foreign-home guard**. Loom guards `captureCheckpoint`, `restoreCheckpoint` and `deleteCheckpointRefs`. Add `yield* refuseForeignHomeCwd("CheckpointStore.captureHeadCheckpoint", input.cwd); // loom:`. Without it, a server on a copied database can write refs into another home's checkout. All 9 `loom` lines survived.
- **`apps/server/src/persistence/threadTreeSlice.loom.ts`** (Loom-only, not overlapped, but changed in meaning): `task_folders` (migration 105) holds absolute task-folder paths on this machine. Copied into a dev home, a dev server's `TaskFolders.remove` would run `fileSystem.remove(taskFolder.root, { recursive: true })`. That path bypasses the foreign-home guard (it is `fs`, not `GitVcsDriver`). Add `"task_folders"` to `PER_INSTANCE_TABLES`; this covers `migrate-dev-db` and `t3 loom-migrate`. The cockpit has no task folders today, so the risk is latent.
- `apps/server/src/vcs/VcsStatusBroadcaster.ts` silent parts: `reconcileCheckedOutRef` (trial 1395) calls `refreshRemoteStatus`; `refreshAfterCheckout` and `refreshPullRequestStatus` use `refreshRemoteAndLocalTotals` and `upstreamReads`. Covered by hunks 4 and 5 above; read with them.
- `apps/server/src/vcs/GitVcsDriverCore.ts` silent parts: the `STATUS_DEFAULT_BRANCH_CACHE_TTL` constant is gone and is still referenced; `StatusDefaultBranchCacheKey` (trial 193) and Loom's invalidate (trial 1959) need reverting; covered under hunk 2. Loom's `resolveGitCommonDir` runs `rev-parse` plus `realpath` and replaces upstream's cached `resolveRepositoryPaths`. That predates this pull and is kept.
- `apps/server/src/git/GitManager.ts`, `GitWorkflowService.ts`, `ProjectSetupScriptRunner.ts`, `WorkspaceEntries.ts`, `migrate-dev-db.test.ts`, `CheckpointDiffQuery.test.ts`, `externalLauncher.test.ts`, `ProjectService.deletion.test.ts`: `loom` line counts are identical in HEAD and the trial (6, 2, 17, 5, 2, 1, 1, 3). The batch plumbing (`remoteStatuses`, `resolveRemoteStatusRepository`, `statusDetailsRemoteBatch`) is present in the trial. Spot-check only.
- `scripts/dev-runner.ts` silent parts: all 16 `loom` lines survive verbatim, covering port derivation, `--no-seed`/`T3CODE_DEV_SEED`, the `$T3CODE_HOME` seed source, the port-scoped home, the IPv4 `HOST` default and the busy-port fallback. Upstream's #36019 now ignores an ambient `T3CODE_PORT`/`T3CODE_HOST` outright. That makes the ambient half of Loom's `resolveRequestedPort` dead (it still covers a busy explicit `--port`). Its comment at trial ~700 overstates its scope, so trim it in a follow-up. `--share` (#35534, #35542) merged cleanly.

### Left for the integration tracks (S2)

- **Typecheck will catch:** two `defaultBranchCache`, the missing `STATUS_DEFAULT_BRANCH_CACHE_TTL`, two `refreshLocalStatus`, two `makeRemoteRefreshLoop`, two `pollersRef`, the missing `refreshRemoteStatus`, two `truncated` (`WorkspaceFileSystem.ts`), `finder.glob` returning a non-Promise, two `MigrateDevDbServerRunningError` (only if kept).
- **Tests to re-point:** Loom's broadcaster tests (`VcsStatusBroadcaster.test.ts` hunk 2, 128 lines) use `Layer.mock(GitWorkflowService)` without `readLocalStatusRefSnapshot`, `readRefSnapshot` or `upstreamDivergence`, which upstream's `refreshStatus` and `refreshLocalStatus` now call. Add them to the mocks: `rg -n 'Layer.mock\(GitWorkflowService' apps/server/src/vcs/VcsStatusBroadcaster.test.ts`. `GitVcsDriverCore.test.ts` hunk 3: upstream rewrote "pushes with upstream setup…" as `it.effect.each([false, true])`, so drop the old title line that trails Loom's side. `migrate-dev-db.test.ts:385` expects `MigrateDevDbLegacySourceError` to pass through (hunk 4 fix). `dev-runner.test.ts` as above.
- **Lint and knip:** if `noVerify` is dropped, check nothing imports it (none does). After `AssetAccess` hunk 1 takes upstream's revision, check `openMediaFile` is still used.
- **Unmarked Loom lines** the ship gate's sweep would flag if touched: `remoteName`, `remoteUrl` and `originRemoteUrl` on `GitRemoteStatusDetails` (`GitVcsDriver.ts` trial 126 to 128, unmarked since pull 14).
