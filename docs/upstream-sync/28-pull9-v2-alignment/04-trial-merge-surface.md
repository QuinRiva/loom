# 04 — Pull 9 trial merge: the mechanical conflict surface

**Status:** research note, trial merge only — nothing was committed or pushed, and the merge was aborted.
Author: researcher thread `96ef74db-3610-48e8-96f2-5d764f440450`, 2026-10-05. Australian English.

**Bottom line.** Merging `upstream/main` onto the pull-8 branch gives **336 conflicted paths**. Only
**155** of them are ordinary textual conflicts (153 both-modified plus 2 add/add, 468 markers, 77
files with a single marker). That part is about pull-7 sized and fits the pull-7 method. The other
**181** are structural: **95 modify/delete** (Loom edited a file upstream deleted) and **86 "file
location"** relocations (Loom's own files in `apps/server/src/orchestration/`, which git moves into
`orchestration-v2/` because it detects a directory rename). No 3-way merge can resolve these.
The orchestration, provider-adapter, projection-persistence and V1-contract areas have to be ported,
**whatever strategy is chosen**: under re-platform, retain or hybrid, the conflict resolution has no
"ours" or "theirs" side that compiles.

Raw captures are in `/tmp/pull9-trial/` (not committed). The useful ones:
`/tmp/pull9-trial/merge-output.txt`, `/tmp/pull9-trial/status-v2.txt`,
`/tmp/pull9-trial/ls-files-u.txt`, `/tmp/pull9-trial/unmerged.txt`,
`/tmp/pull9-trial/conflicts.json` (per-file classification),
`/tmp/pull9-trial/dangling-imports.json`, `/tmp/pull9-trial/both-modified-automerged.json`,
`/tmp/pull9-trial/lostdecls-automerged.txt` and `/tmp/pull9-trial/commit-groups.txt`. The
in-progress merge state (the index with all three stages, `MERGE_HEAD` and `HEAD`) is saved in
`/tmp/pull9-trial/merge-state/` in the same form as pull 7's recovery bundle.

## Topology

| item                                | value                                                                                                                                               |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ours                                | `origin/t3code/upstream-sync-20261004` = `6bf19371e1` (pull 8, PR #323)                                                                             |
| theirs                              | `upstream/main` = `a1d9d72aef` (2026-10-05, "fix(mobile): a message that fails to send now says why…")                                              |
| merge-base                          | `024d49520e` (confirmed; equals `de34391427^`)                                                                                                      |
| upstream commits                    | **155** (no merges). `de34391427` "introduce new orchestrator" alone is 1914 files, +381,846/−204,768. The other 154 are 674 files, +42,687/−12,553 |
| upstream diff vs base               | 2192 files, +419,418/−212,206: 1007 added, 991 modified, 175 deleted, 11 renamed (8 of them `orchestration/` → `orchestration-v2/`)                 |
| Loom diff vs base                   | 1222 files, +233,977/−9,117: 767 added, 453 modified                                                                                                |
| merge command                       | `git -c merge.renameLimit=30000 merge --no-commit --no-ff upstream/main` (git 2.30, recursive). It took 1.8 s and exited 1                          |
| **conflicted**                      | **336**: 153 UU, 95 UD, 86 AU ("file location"), 2 AA. No DU                                                                                        |
| upstream paths that applied cleanly | **1935**. **117** of these are files _both_ sides modified that git merged without conflict                                                         |

For comparison, doc 27 (`docs/upstream-sync/27-cadence-pull-v0.0.45-pre-orchestration-v2.md` on
the pull-8 branch) dry-ran `origin/main` against `upstream/main@f391794a35` before pull 8 and got 348
conflicts (169 content, 91 modify/delete, 86 file location, 2 add/add). So pull 8 removed only the
pre-V2 part of the surface. **The V2 surface is essentially unchanged in size, and the 110 upstream
commits since that dry run (45 → 155 past the base) barely added to it.**

Side effect to know about: `rerere` is enabled repo-wide. The trial recorded preimages in the shared
`rr-cache` but no postimages, so a later real merge will not be auto-resolved from them.

## Conflict table by area × kind

Areas are keyed on the **pull-8-side path**. The 86 relocations and the one upstream-renamed file
therefore count under V1 `orchestration/`, even though git stages them under `orchestration-v2/`.
`loom:` counts lines containing `loom:` in the pull-8 blob. Markers count `<<<<<<<` lines in the
merged worktree file. UD and AU files have no markers by construction: git leaves Loom's whole file in place.

| area                      | both-modified (UU) | modify/delete (UD) | file location (AU) | add/add (AA) |   total | `loom:` lines (pull-8 side) | conflict markers |
| ------------------------- | -----------------: | -----------------: | -----------------: | -----------: | ------: | --------------------------: | ---------------: |
| server/orchestration (V1) |                  1 |                 43 |                 86 |            0 |     130 |                         286 |                2 |
| server/mcp                |                  1 |                  0 |                  0 |            0 |       1 |                           0 |                1 |
| server/provider           |                 12 |                 20 |                  0 |            1 |      33 |                         112 |               30 |
| server/persistence        |                  5 |                 11 |                  0 |            0 |      16 |                          31 |               12 |
| server/other              |                 30 |                  9 |                  0 |            1 |      40 |                         185 |              109 |
| packages/contracts        |                  9 |                  2 |                  0 |            0 |      11 |                          86 |               20 |
| packages/client-runtime   |                 23 |                  5 |                  0 |            0 |      28 |                          44 |               68 |
| packages/shared           |                  5 |                  0 |                  0 |            0 |       5 |                          12 |                5 |
| apps/web                  |                 51 |                  5 |                  0 |            0 |      56 |                         435 |              180 |
| apps/mobile               |                 12 |                  0 |                  0 |            0 |      12 |                          21 |               17 |
| root/config/scripts       |                  4 |                  0 |                  0 |            0 |       4 |                          11 |               24 |
| **total**                 |            **153** |             **95** |             **86** |        **2** | **336** |                    **1223** |          **468** |

Read across, the table says this. Excluding V1 `orchestration/`, the areas carry **206 conflicted
paths, 154 of them textual** — the same order as pull 7's 230. V1 `orchestration/` is **130 paths
with 2 markers**: there is nothing to merge there, only files to move or re-express.

Two of the "both-modified" entries are renames. `apps/server/src/orchestration-v2/PullRequestSyncReactor.test.ts`
is an upstream V1 → V2 rename that git followed. `packages/shared/src/threadSettled.ts` is a
_Loom-side_ rename from `packages/client-runtime/src/state/threadSettled.ts` that git followed
cleanly into a content conflict. No other rename produced a conflict. Of upstream's 8 V1 → V2 renames,
Loom had edited only one.

### Full lists for the strategy-deciding areas

Δ columns are numstat against the base `024d49520e`. On modify/delete rows the upstream Δ is the deletion.

#### `apps/server/src/orchestration/` (V1, deleted upstream) — excluding the 86 relocations

| kind                                                                                                 | path                                                                    | `loom:` | markers | Loom Δ vs base |   upstream Δ vs base |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ------: | ------: | -------------: | -------------------: |
| modify/delete                                                                                        | `apps/server/src/orchestration/ActivityPayloadProjection.ts`            |       2 |       0 |          +8/−1 |              +0/−689 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Errors.ts`                               |       2 |       0 |         +14/−0 |               +0/−93 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/CheckpointReactor.test.ts`        |       7 |       0 |       +121/−49 |             +0/−2283 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/CheckpointReactor.ts`             |       1 |       0 |      +254/−123 |             +0/−1063 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/OrchestrationEngine.test.ts`      |       2 |       0 |      +510/−220 |             +0/−2213 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`           |       6 |       0 |       +358/−17 |              +0/−480 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/OrchestrationReactor.test.ts`     |       1 |       0 |         +48/−1 |              +0/−139 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/OrchestrationReactor.ts`          |       3 |       0 |         +12/−0 |               +0/−49 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProjectionPipeline.test.ts`       |       3 |       0 |     +1521/−785 |             +0/−4872 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`            |      12 |       0 |       +886/−76 |             +0/−2222 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.test.ts`  |       7 |       0 |     +2083/−452 |             +0/−3771 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`       |      31 |       0 |     +2673/−252 |             +0/−3870 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProviderCommandReactor.test.ts`   |      13 |       0 |       +810/−31 |             +0/−4503 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`        |      24 |       0 |       +801/−69 |             +0/−1965 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts` |       4 |       0 |       +567/−36 |             +0/−5234 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts`      |      18 |       0 |       +562/−61 |             +0/−2743 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.test.ts`    |       1 |       0 |       +179/−73 |              +0/−139 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Layers/ThreadDeletionReactor.ts`         |       2 |       0 |        +83/−22 |              +0/−122 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Schemas.ts`                              |       1 |       0 |         +48/−0 |               +0/−74 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Services/OrchestrationEngine.ts`         |       1 |       0 |         +27/−0 |              +0/−117 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`     |       7 |       0 |        +487/−1 |              +0/−315 |
| modify/delete                                                                                        | `apps/server/src/orchestration/Services/ThreadDeletionReactor.ts`       |       2 |       0 |         +18/−5 |               +0/−40 |
| modify/delete                                                                                        | `apps/server/src/orchestration/ThreadPullRequestReactor.test.ts`        |       2 |       0 |        +36/−23 |              +0/−843 |
| modify/delete                                                                                        | `apps/server/src/orchestration/ThreadSettlementPolicy.test.ts`          |       1 |       0 |        +30/−27 |              +0/−313 |
| modify/delete                                                                                        | `apps/server/src/orchestration/ThreadSettlementPolicy.ts`               |       4 |       0 |         +87/−9 |              +0/−137 |
| modify/delete                                                                                        | `apps/server/src/orchestration/ThreadSettlementReactor.test.ts`         |       8 |       0 |       +339/−35 |             +0/−2038 |
| modify/delete                                                                                        | `apps/server/src/orchestration/ThreadSettlementReactor.ts`              |      11 |       0 |        +107/−4 |              +0/−385 |
| modify/delete                                                                                        | `apps/server/src/orchestration/commandInvariants.test.ts`               |       1 |       0 |         +60/−0 |              +0/−227 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.active-order.test.ts`            |       1 |       0 |        +38/−32 |              +0/−201 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.autoSettleSet.test.ts`           |       1 |       0 |          +3/−0 |              +0/−154 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.pinned.test.ts`                  |       1 |       0 |         +31/−0 |              +0/−325 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.pullRequests.test.ts`            |       0 |       0 |          +3/−0 |              +0/−575 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.questionAttachments.test.ts`     |       1 |       0 |         +13/−2 |              +0/−131 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.settled.test.ts`                 |       4 |       0 |       +346/−94 |              +0/−853 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.snoozed.test.ts`                 |       1 |       0 |         +31/−0 |              +0/−287 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.titleRegeneration.test.ts`       |       1 |       0 |         +31/−0 |              +0/−120 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.ts`                              |      36 |       0 |      +989/−349 |             +0/−2226 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.turnDiffComplete.test.ts`        |       0 |       0 |          +3/−0 |              +0/−127 |
| modify/delete                                                                                        | `apps/server/src/orchestration/decider.userInputDismiss.test.ts`        |       2 |       0 |         +19/−8 |              +0/−143 |
| modify/delete                                                                                        | `apps/server/src/orchestration/http.ts`                                 |       1 |       0 |         +18/−7 |              +0/−128 |
| modify/delete                                                                                        | `apps/server/src/orchestration/messageContext.test.ts`                  |       0 |       0 |          +3/−0 |              +0/−165 |
| modify/delete                                                                                        | `apps/server/src/orchestration/projector.test.ts`                       |       1 |       0 |       +430/−81 |             +0/−1240 |
| modify/delete                                                                                        | `apps/server/src/orchestration/projector.ts`                            |      15 |       0 |         +71/−3 |             +0/−1099 |
| both-modified (renamed upstream from `apps/server/src/orchestration/PullRequestSyncReactor.test.ts`) | `apps/server/src/orchestration-v2/PullRequestSyncReactor.test.ts`       |       1 |       2 |        +70/−61 | rename, 78 % similar |

#### `apps/server/src/provider/`

| kind          | path                                                                   | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | ---------------------------------------------------------------------- | ------: | ------: | -------------: | -----------------: |
| add/add       | `apps/server/src/provider/Drivers/PiDriver.ts`                         |      16 |       7 |       +2959/−0 |            +195/−0 |
| modify/delete | `apps/server/src/provider/Layers/AntigravityAdapter.ts`                |       2 |       0 |         +19/−2 |           +0/−1301 |
| modify/delete | `apps/server/src/provider/Layers/ClaudeAdapter.test.ts`                |       1 |       0 |       +113/−42 |           +0/−8446 |
| modify/delete | `apps/server/src/provider/Layers/ClaudeAdapter.ts`                     |       1 |       0 |       +158/−57 |           +0/−5684 |
| modify/delete | `apps/server/src/provider/Layers/CodexAdapter.test.ts`                 |       1 |       0 |        +164/−4 |           +0/−3195 |
| modify/delete | `apps/server/src/provider/Layers/CodexAdapter.ts`                      |       3 |       0 |         +69/−3 |           +0/−2832 |
| modify/delete | `apps/server/src/provider/Layers/CodexSessionRuntime.ts`               |       1 |       0 |        +97/−22 |           +0/−2740 |
| modify/delete | `apps/server/src/provider/Layers/CursorAdapter.ts`                     |       1 |       0 |        +95/−20 |           +0/−1289 |
| modify/delete | `apps/server/src/provider/Layers/GrokAdapter.test.ts`                  |       1 |       0 |        +59/−71 |           +0/−2658 |
| modify/delete | `apps/server/src/provider/Layers/GrokAdapter.ts`                       |       1 |       0 |        +76/−13 |           +0/−2235 |
| modify/delete | `apps/server/src/provider/Layers/OpenCodeAdapter.test.ts`              |       1 |       0 |          +1/−0 |           +0/−8016 |
| modify/delete | `apps/server/src/provider/Layers/OpenCodeAdapter.ts`                   |       2 |       0 |       +122/−43 |           +0/−4059 |
| modify/delete | `apps/server/src/provider/Layers/ProviderAdapterRegistry.test.ts`      |       5 |       0 |          +9/−4 |            +0/−285 |
| modify/delete | `apps/server/src/provider/Layers/ProviderService.test.ts`              |      21 |       0 |       +814/−17 |           +0/−5361 |
| modify/delete | `apps/server/src/provider/Layers/ProviderService.ts`                   |      19 |       0 |       +537/−67 |           +0/−2482 |
| modify/delete | `apps/server/src/provider/Layers/ProviderSessionDirectory.ts`          |       1 |       0 |         +24/−2 |            +0/−210 |
| modify/delete | `apps/server/src/provider/Layers/ProviderSessionReaper.test.ts`        |       1 |       0 |      +515/−368 |            +0/−737 |
| modify/delete | `apps/server/src/provider/Layers/ProviderSessionReaper.ts`             |       5 |       0 |       +173/−23 |            +0/−160 |
| modify/delete | `apps/server/src/provider/Services/ProviderAdapter.ts`                 |       3 |       0 |        +130/−3 |            +0/−158 |
| modify/delete | `apps/server/src/provider/Services/ProviderService.ts`                 |       1 |       0 |         +22/−2 |            +0/−144 |
| modify/delete | `apps/server/src/provider/Services/ProviderSessionDirectory.ts`        |       1 |       0 |         +16/−0 |             +0/−85 |
| both-modified | `apps/server/src/provider/Layers/ClaudeCapabilitiesProbe.test.ts`      |       1 |       2 |        +140/−6 |           +187/−57 |
| both-modified | `apps/server/src/provider/Layers/ClaudeProvider.ts`                    |       4 |       1 |        +528/−2 |             +35/−8 |
| both-modified | `apps/server/src/provider/Layers/CursorProvider.test.ts`               |       1 |       1 |          +1/−0 |         +159/−1120 |
| both-modified | `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.test.ts` |       2 |       2 |         +20/−7 |            +68/−88 |
| both-modified | `apps/server/src/provider/Layers/ProviderRegistry.test.ts`             |       7 |       6 |      +441/−327 |           +259/−28 |
| both-modified | `apps/server/src/provider/Layers/ProviderUsageLimitsIngestion.ts`      |       0 |       1 |          +5/−0 |             +3/−40 |
| both-modified | `apps/server/src/provider/acp/AcpSessionRuntime.ts`                    |       1 |       2 |         +16/−3 |         +1867/−191 |
| both-modified | `apps/server/src/provider/acp/XAiAcpExtension.ts`                      |       0 |       2 |         +10/−2 |         +1371/−340 |
| both-modified | `apps/server/src/provider/builtInDrivers.ts`                           |       1 |       3 |         +4/−21 |              +8/−2 |
| both-modified | `apps/server/src/provider/makeManagedServerProvider.ts`                |       5 |       1 |       +118/−28 |              +3/−3 |
| both-modified | `apps/server/src/provider/opencodeRuntime.ts`                          |       0 |       1 |          +7/−0 |             +23/−8 |
| both-modified | `apps/server/src/provider/providerCompatibility.test.ts`               |       2 |       1 |         +13/−1 |             +80/−5 |

#### `apps/server/src/persistence/`

| kind          | path                                                                   | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | ---------------------------------------------------------------------- | ------: | ------: | -------------: | -----------------: |
| modify/delete | `apps/server/src/persistence/Layers/ProjectionProjects.ts`             |       1 |       0 |         +13/−0 |            +0/−121 |
| modify/delete | `apps/server/src/persistence/Layers/ProjectionRepositories.test.ts`    |       1 |       0 |        +188/−0 |            +0/−695 |
| modify/delete | `apps/server/src/persistence/Layers/ProjectionThreadMessages.ts`       |       7 |       0 |         +34/−1 |            +0/−321 |
| modify/delete | `apps/server/src/persistence/Layers/ProjectionThreadSessions.ts`       |       4 |       0 |         +38/−0 |            +0/−112 |
| modify/delete | `apps/server/src/persistence/Layers/ProjectionThreads.ts`              |       6 |       0 |        +173/−1 |            +0/−195 |
| modify/delete | `apps/server/src/persistence/Layers/ProjectionTurns.ts`                |       1 |       0 |         +47/−0 |            +0/−354 |
| modify/delete | `apps/server/src/persistence/Services/ProjectionProjects.ts`           |       0 |       0 |          +5/−0 |             +0/−70 |
| modify/delete | `apps/server/src/persistence/Services/ProjectionThreadMessages.ts`     |       0 |       0 |          +6/−0 |            +0/−129 |
| modify/delete | `apps/server/src/persistence/Services/ProjectionThreadSessions.ts`     |       1 |       0 |         +12/−0 |             +0/−78 |
| modify/delete | `apps/server/src/persistence/Services/ProjectionThreads.ts`            |       2 |       0 |         +91/−0 |             +0/−94 |
| modify/delete | `apps/server/src/persistence/Services/ProjectionTurns.ts`              |       0 |       0 |          +7/−0 |            +0/−170 |
| both-modified | `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        |       3 |       7 |        +105/−3 |          +449/−266 |
| both-modified | `apps/server/src/persistence/Layers/Sqlite.ts`                         |       3 |       1 |         +17/−4 |              +4/−2 |
| both-modified | `apps/server/src/persistence/Migrations.ts`                            |       1 |       1 |          +3/−1 |             +42/−2 |
| both-modified | `apps/server/src/persistence/Services/OrchestrationCommandReceipts.ts` |       0 |       2 |          +2/−1 |             +8/−11 |
| both-modified | `apps/server/src/persistence/Services/OrchestrationEventStore.ts`      |       1 |       1 |         +23/−0 |            +91/−77 |

#### `apps/server/src/mcp/`

| kind          | path                                          | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | --------------------------------------------- | ------: | ------: | -------------: | -----------------: |
| both-modified | `apps/server/src/mcp/McpInvocationContext.ts` |       0 |       1 |          +1/−1 |              +8/−1 |

#### `packages/contracts/`

| kind          | path                                             | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | ------------------------------------------------ | ------: | ------: | -------------: | -----------------: |
| modify/delete | `packages/contracts/src/orchestration.test.ts`   |       1 |       0 |         +54/−0 |           +0/−1690 |
| modify/delete | `packages/contracts/src/orchestration.ts`        |      32 |       0 |        +246/−5 |           +0/−2441 |
| both-modified | `packages/contracts/src/composerContext.test.ts` |       2 |       3 |         +32/−0 |            +31/−16 |
| both-modified | `packages/contracts/src/composerContext.ts`      |       8 |       2 |         +25/−8 |             +17/−0 |
| both-modified | `packages/contracts/src/index.ts`                |       0 |       1 |          +2/−0 |             +17/−1 |
| both-modified | `packages/contracts/src/keybindings.ts`          |       2 |       1 |         +27/−0 |              +6/−0 |
| both-modified | `packages/contracts/src/model.ts`                |       3 |       3 |         +32/−0 |              +7/−0 |
| both-modified | `packages/contracts/src/providerRuntime.ts`      |       3 |       1 |        +127/−9 |             +8/−39 |
| both-modified | `packages/contracts/src/rpc.ts`                  |      16 |       5 |        +144/−0 |           +329/−55 |
| both-modified | `packages/contracts/src/server.ts`               |       3 |       1 |        +146/−0 |             +61/−0 |
| both-modified | `packages/contracts/src/settings.ts`             |      16 |       3 |        +70/−11 |           +155/−38 |

#### other `apps/server/`

| kind          | path                                                                         | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | ---------------------------------------------------------------------------- | ------: | ------: | -------------: | -----------------: |
| add/add       | `apps/server/src/textGeneration/PiTextGeneration.ts`                         |       1 |       3 |        +127/−0 |            +256/−0 |
| modify/delete | `apps/server/integration/OrchestrationEngineHarness.integration.ts`          |       2 |       0 |         +42/−0 |            +0/−619 |
| modify/delete | `apps/server/integration/TestProviderAdapter.integration.ts`                 |       0 |       0 |         +10/−1 |            +0/−568 |
| modify/delete | `apps/server/integration/orchestrationEngine.integration.test.ts`            |       1 |       0 |         +30/−7 |           +0/−1418 |
| modify/delete | `apps/server/integration/orphanedProviderSessionStartup.integration.test.ts` |       6 |       0 |        +138/−0 |            +0/−487 |
| modify/delete | `apps/server/integration/providerService.integration.test.ts`                |       0 |       0 |          +2/−0 |            +0/−389 |
| modify/delete | `apps/server/src/bin.test.ts`                                                |       0 |       0 |          +3/−0 |            +0/−870 |
| modify/delete | `apps/server/src/server.test.ts`                                             |      20 |       0 |    +1909/−1270 |          +0/−13534 |
| modify/delete | `apps/server/src/serverRuntimeStartup.reconcile.test.ts`                     |       9 |       0 |       +416/−64 |            +0/−991 |
| modify/delete | `apps/server/src/serverRuntimeStartup.worktreeSetup.test.ts`                 |       1 |       0 |        +22/−17 |            +0/−156 |
| both-modified | `apps/server/package.json`                                                   |       0 |       1 |          +4/−1 |             +10/−1 |
| both-modified | `apps/server/src/auth/RpcAuthorization.ts`                                   |       1 |       1 |         +20/−0 |             +52/−9 |
| both-modified | `apps/server/src/bin.ts`                                                     |       0 |       1 |          +2/−0 |            +17/−85 |
| both-modified | `apps/server/src/checkpointing/CheckpointDiffQuery.test.ts`                  |       6 |       5 |        +138/−8 |          +166/−452 |
| both-modified | `apps/server/src/checkpointing/CheckpointDiffQuery.ts`                       |       1 |       2 |         +19/−3 |           +67/−100 |
| both-modified | `apps/server/src/checkpointing/Utils.ts`                                     |       0 |       1 |         +14/−0 |              +1/−1 |
| both-modified | `apps/server/src/cli/config.ts`                                              |       5 |       2 |        +46/−12 |             +14/−1 |
| both-modified | `apps/server/src/cli/project.ts`                                             |       1 |       4 |        +55/−60 |            +34/−33 |
| both-modified | `apps/server/src/cli/server.ts`                                              |       2 |       2 |          +9/−1 |             +39/−5 |
| both-modified | `apps/server/src/git/GitManager.ts`                                          |       2 |       1 |       +239/−63 |            +25/−22 |
| both-modified | `apps/server/src/git/GitWorkflowService.ts`                                  |       1 |       2 |         +92/−0 |             +13/−0 |
| both-modified | `apps/server/src/git/linkCreatedPullRequest.test.ts`                         |       0 |       1 |          +2/−0 |            +66/−29 |
| both-modified | `apps/server/src/project/AgentSessionImporter.test.ts`                       |       4 |       2 |         +22/−0 |         +126/−1195 |
| both-modified | `apps/server/src/project/AgentSessionScanner.test.ts`                        |       1 |       1 |         +3/−24 |             +8/−35 |
| both-modified | `apps/server/src/project/ProjectSetupScriptRunner.test.ts`                   |       2 |       4 |      +219/−225 |           +99/−539 |
| both-modified | `apps/server/src/project/ProjectSetupScriptRunner.ts`                        |       2 |       4 |      +245/−200 |            +36/−21 |
| both-modified | `apps/server/src/relay/AgentAwarenessRelay.test.ts`                          |       4 |       8 |       +111/−19 |          +837/−985 |
| both-modified | `apps/server/src/relay/AgentAwarenessRelay.ts`                               |       2 |       7 |         +14/−6 |           +249/−95 |
| both-modified | `apps/server/src/server.ts`                                                  |      15 |       5 |         +70/−9 |          +157/−104 |
| both-modified | `apps/server/src/serverRuntimeStartup.test.ts`                               |       2 |       6 |      +392/−203 |          +117/−446 |
| both-modified | `apps/server/src/serverRuntimeStartup.ts`                                    |      28 |       8 |       +179/−16 |          +305/−753 |
| both-modified | `apps/server/src/terminal/Manager.test.ts`                                   |       2 |       2 |        +71/−53 |             +81/−6 |
| both-modified | `apps/server/src/terminal/Manager.ts`                                        |       3 |       2 |         +21/−4 |             +59/−7 |
| both-modified | `apps/server/src/textGeneration/CursorTextGeneration.ts`                     |       2 |       1 |         +15/−5 |           +153/−83 |
| both-modified | `apps/server/src/textGeneration/TextGeneration.ts`                           |       6 |       1 |         +47/−1 |              +7/−1 |
| both-modified | `apps/server/src/usage/UsageLimitSources.ts`                                 |       3 |       2 |         +16/−8 |              +2/−2 |
| both-modified | `apps/server/src/vcs/GitVcsDriver.ts`                                        |       1 |       1 |       +113/−11 |             +25/−1 |
| both-modified | `apps/server/src/vcs/GitVcsDriverCore.ts`                                    |       7 |       3 |       +673/−82 |          +382/−155 |
| both-modified | `apps/server/src/vcs/VcsStatusBroadcaster.ts`                                |       3 |       2 |      +327/−193 |             +20/−8 |
| both-modified | `apps/server/src/ws.ts`                                                      |      39 |      24 |      +949/−293 |        +1811/−2121 |

#### `packages/client-runtime/`

| kind          | path                                                            | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | --------------------------------------------------------------- | ------: | ------: | -------------: | -----------------: |
| modify/delete | `packages/client-runtime/src/pendingRequests.ts`                |       1 |       0 |          +4/−1 |            +0/−198 |
| modify/delete | `packages/client-runtime/src/platform/persistence.test.ts`      |       3 |       0 |         +21/−2 |             +0/−55 |
| modify/delete | `packages/client-runtime/src/state/threadReducer.test.ts`       |       2 |       0 |        +129/−2 |           +0/−1711 |
| modify/delete | `packages/client-runtime/src/state/threadReducer.ts`            |       5 |       0 |        +159/−0 |            +0/−875 |
| modify/delete | `packages/client-runtime/src/state/threads-pagination.test.ts`  |       1 |       0 |         +29/−0 |            +0/−664 |
| both-modified | `packages/client-runtime/package.json`                          |       0 |       1 |          +4/−4 |             +71/−3 |
| both-modified | `packages/client-runtime/src/connection/driver.ts`              |       1 |       5 |         +52/−5 |            +149/−9 |
| both-modified | `packages/client-runtime/src/connection/registry.test.ts`       |       1 |       1 |          +1/−0 |           +428/−77 |
| both-modified | `packages/client-runtime/src/operations/commands.ts`            |       6 |       3 |         +91/−0 |          +955/−278 |
| both-modified | `packages/client-runtime/src/operations/projects.ts`            |       1 |       1 |          +6/−1 |             +16/−4 |
| both-modified | `packages/client-runtime/src/remotePerformance.bench.ts`        |       1 |       1 |          +3/−0 |            +30/−58 |
| both-modified | `packages/client-runtime/src/state/entities.test.ts`            |       1 |       6 |        +110/−3 |          +647/−466 |
| both-modified | `packages/client-runtime/src/state/environmentHttpAuth.test.ts` |       1 |       2 |         +18/−1 |           +199/−74 |
| both-modified | `packages/client-runtime/src/state/orchestration.ts`            |       0 |       1 |         +12/−1 |             +39/−7 |
| both-modified | `packages/client-runtime/src/state/server.ts`                   |       3 |       3 |        +56/−23 |           +195/−47 |
| both-modified | `packages/client-runtime/src/state/shell-sync.test.ts`          |       2 |      15 |      +457/−169 |           +576/−74 |
| both-modified | `packages/client-runtime/src/state/shell.test.ts`               |       0 |       1 |          +1/−0 |            +106/−3 |
| both-modified | `packages/client-runtime/src/state/shell.ts`                    |       4 |       7 |      +121/−124 |            +72/−47 |
| both-modified | `packages/client-runtime/src/state/shellReducer.test.ts`        |       1 |       4 |         +66/−2 |          +397/−133 |
| both-modified | `packages/client-runtime/src/state/shellReducer.ts`             |       2 |       1 |         +25/−4 |           +129/−24 |
| both-modified | `packages/client-runtime/src/state/threadCommands.test.ts`      |       0 |       1 |          +4/−0 |           +101/−81 |
| both-modified | `packages/client-runtime/src/state/threadCommands.ts`           |       3 |       9 |         +79/−1 |           +159/−14 |
| both-modified | `packages/client-runtime/src/state/threadDetail.ts`             |       2 |       1 |         +16/−0 |          +155/−125 |
| both-modified | `packages/client-runtime/src/state/threadSnoozed.test.ts`       |       0 |       1 |          +1/−1 |              +1/−5 |
| both-modified | `packages/client-runtime/src/state/threads-atoms.test.ts`       |       0 |       1 |          +3/−0 |          +286/−580 |
| both-modified | `packages/client-runtime/src/state/threads-sync.test.ts`        |       1 |       1 |         +29/−0 |         +1166/−320 |
| both-modified | `packages/client-runtime/src/state/threads.ts`                  |       1 |       1 |         +12/−7 |          +584/−551 |
| both-modified | `packages/client-runtime/src/work-log/userInput.ts`             |       1 |       1 |          +6/−3 |            +1/−151 |

#### `packages/shared/` and root

| kind          | path                                               | `loom:` | markers | Loom Δ vs base | upstream Δ vs base |
| ------------- | -------------------------------------------------- | ------: | ------: | -------------: | -----------------: |
| both-modified | `packages/shared/src/composerContextReferences.ts` |       5 |       1 |         +32/−7 |             +32/−0 |
| both-modified | `packages/shared/src/composerInlineTokens.ts`      |       2 |       1 |         +27/−0 |             +13/−3 |
| both-modified | `packages/shared/src/serverSettings.ts`            |       3 |       1 |         +29/−1 |             +13/−1 |
| both-modified | `packages/shared/src/threadSettled.ts`             |       2 |       1 |          +0/−0 |              +0/−0 |
| both-modified | `packages/shared/src/toolActivity.ts`              |       0 |       1 |          +1/−1 |           +221/−67 |
| both-modified | `infra/relay/scripts/android-push-watch.ts`        |       1 |       2 |         +15/−7 |            +11/−11 |
| both-modified | `pnpm-lock.yaml`                                   |       0 |      20 |     +2109/−227 |         +1251/−153 |
| both-modified | `scripts/dev-runner.test.ts`                       |       8 |       1 |       +153/−12 |            +22/−24 |
| both-modified | `scripts/lib/cli-external-packages.test.ts`        |       2 |       1 |         +21/−5 |              +3/−4 |

#### The 86 relocations (AU, "file location")

Git sees that upstream deleted `apps/server/src/orchestration/` and renamed 8 of its files into
`orchestration-v2/`. It therefore infers a directory rename and stages **every Loom-only file in
the V1 directory at `orchestration-v2/<same path>`**. That is 86 files and 35,040 lines (47 source,
39 test), carrying 43 `loom:` lines; most of them are wholly Loom, so they need no marks. The
largest non-test files, in lines: `Layers/WorkstreamDispatcher.ts` (3677), `decider.loom.ts` (1638),
`Layers/WorkstreamLivenessSweep.ts` (1211), `Layers/WorkstreamFanInReactor.ts` (1026),
`projector.loom.ts` (636), `Layers/WorktreeReaper.ts` (459), `stuckLaunchRecovery.ts` (427),
`userInputSettlement.ts` (343), `Layers/ThreadEmbedder.loom.ts` (332),
`Layers/HandoffDrafterReactor.ts` (331), `workstreamAsk.ts` (329) and `Layers/ExhaustionResumeSweep.ts` (323).
The rest are the goal-task modules (`goalTask*.ts`), the workstream modules (`workstream*.ts`,
`briefNeeded*.ts`, `roleOverlay.ts`, `stallContext.ts`), worktree lifecycle (`worktree*.ts`,
`orphanWorktreeSweep.ts`), thread search embedding (`Layers/embedding/*.loom.ts`) and their
`Services/` tags. The full list is the `AU` rows in `/tmp/pull9-trial/status-v2.txt`.

**This relocation is itself a hazard.** It mixes Loom's V1-shaped engine into V2's directory, so
whoever resolves the merge has to undo it or own it deliberately. And every import _into_ these
modules from outside the directory breaks (see below).

#### `apps/web` and `apps/mobile` — worst ten by markers

`apps/web`: 56 files (51 UU, 5 UD), 180 markers, 435 `loom:` lines. `apps/mobile`: 12 UU, 17 markers.

| path                                                          | markers | `loom:` |   Loom Δ |  upstream Δ |
| ------------------------------------------------------------- | ------: | ------: | -------: | ----------: |
| `apps/web/src/components/DiffPanel.tsx`                       |      22 |      25 | +384/−73 |     +60/−72 |
| `apps/web/src/components/ChatView.tsx`                        |      20 |      58 | +477/−28 | +2840/−1649 |
| `apps/web/src/composerDraftStore.ts`                          |      14 |      54 | +301/−15 |    +313/−16 |
| `apps/web/src/components/Sidebar.tsx`                         |      11 |      23 | +172/−89 |   +625/−357 |
| `apps/web/src/components/chat/ChatComposer.tsx`               |       9 |      48 | +266/−53 |   +628/−129 |
| `apps/web/src/components/Sidebar.logic.ts`                    |       7 |      11 | +162/−42 |   +247/−125 |
| `apps/web/src/components/chat/MessagesTimeline.tsx`           |       7 |      28 |  +107/−8 | +1696/−1264 |
| `apps/web/src/components/Sidebar.logic.test.ts`               |       6 |       2 | +205/−31 |  +660/−1014 |
| `apps/web/src/components/RightPanelTabs.tsx`                  |       5 |      20 |  +73/−17 |      +9/−56 |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts`      |       5 |      10 |   +50/−1 |   +868/−487 |
| `apps/mobile/src/features/home/HomeScreen.tsx` (mobile worst) |       3 |       8 |  +84/−38 |     +62/−98 |

Web modify/delete: `apps/web/src/queuedMessageStore.ts` and `apps/web/src/queuedMessageStore.test.ts`,
`apps/web/src/components/chat/sendQueuedMessage.ts`, `apps/web/src/components/QueuedMessageSender.test.tsx`
and `apps/web/src/components/ChatMarkdown.workspace-images.test.tsx`. Upstream moved queued
messages server-side under V2.

## Loom weight in deleted or rewritten files

| bucket                                                                                                                     | files |         Loom lines (+/− vs base) | `loom:` lines | upstream counterpart to merge into                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------- | ----: | -------------------------------: | ------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| modify/delete, all areas                                                                                                   |    95 |                   +21,870/−5,083 |           428 | none (deleted)                                                                                                                                               |
| … of which V1 `orchestration/`                                                                                             |    43 |                   +14,758/−2,948 |           242 | none                                                                                                                                                         |
| … `provider/` (V1 adapters, `ProviderService`, `ProviderAdapter`, session directory/reaper)                                |    20 |                      +3,213/−763 |            72 | V2 `orchestration-v2/Adapters/*V2.ts`, a different interface                                                                                                 |
| … other server (mostly tests: `server.test.ts` +1909/−1270, `serverRuntimeStartup.reconcile.test.ts`, integration harness) |     9 |                    +2,572/−1,359 |            39 | none                                                                                                                                                         |
| … `persistence/` (V1 projection repositories)                                                                              |    11 |                          +614/−2 |            23 | none; V2 has `orchestration_v2_projection_*`                                                                                                                 |
| … `client-runtime` (`threadReducer.ts`, `pendingRequests.ts`, …)                                                           |     5 |                          +342/−5 |            12 | none                                                                                                                                                         |
| … `contracts/orchestration.ts` and test                                                                                    |     2 |                          +300/−5 |            33 | `orchestrationV2.ts` and others, new shapes                                                                                                                  |
| … `apps/web` (queued messages)                                                                                             |     5 |                           +71/−1 |             7 | none                                                                                                                                                         |
| Loom-only files relocated out of V1 `orchestration/`                                                                       |    86 |                          +35,040 |            43 | none (wholly Loom)                                                                                                                                           |
| `PiDriver.ts` add/add                                                                                                      |     1 | +2,959 (Loom) vs +195 (upstream) |            16 | upstream's own native Pi driver at the same path, a different design (it registers `Layers/PiProvider.ts`, `PiCommands.ts` and V2 `Adapters/PiAdapterV2.ts`) |

In total, **about 57,000 lines of Loom code** sit in files that either no longer exist upstream
(21,870) or are Loom-only engine files built on the deleted engine (35,040). That excludes the
2,959-line `PiDriver.ts`, which collides with upstream's driver. The conflicted files together carry 1,223 `loom:` lines.

**`*.loom.ts` sidecars.** There are 27 on the pull-8 side. **10 live in V1 `orchestration/`** and
are relocated with no upstream counterpart: `decider.loom.ts`, `projector.loom.ts`,
`commandInvariants.loom.ts`, `goalTaskAnchor.loom.ts`, `Layers/ThreadEmbedder.loom.ts`,
`Layers/ThreadSearch.loom.ts` and four `Layers/embedding/*.loom.ts`.
`packages/contracts/src/orchestration.loom.ts` (1,795 lines; Loom's command and event schemas)
is Loom-only, so the merge leaves it untouched. But its only edge back to upstream is `import type { OrchestrationCommand,
OrchestrationEvent } from "./orchestration.ts"`, and that file is deleted upstream. So the sidecar
pattern did its job textually, and the thing it hangs off is gone.

**Dangling imports after the merge.** A relative-import resolver over the merged tree (excluding
`.repos/`, and excluding about 13 asset/`?raw`/`?url` false positives) finds **about 125 files**
whose relative imports no longer resolve:

- 51 modify/delete leftovers.
- 40 relocated Loom files that still import V1 siblings upstream deleted: `decider.ts` (19
  importers), `projector.ts` (17), `Services/OrchestrationEngine.ts` (13),
  `Services/ProjectionSnapshotQuery.ts` (13) and `Errors.ts` (8).
- 25 Loom-only files elsewhere that import the relocated modules by their old path. Examples:
  `apps/server/src/loom/serverLayers.ts`, `apps/server/src/loom/startup.ts`,
  `apps/server/src/mcp/GoalTaskHttp.ts`, `apps/server/src/mcp/WorkstreamSpawnHttp.ts`,
  `apps/server/src/cli/goal.ts`, `apps/server/src/provider/Drivers/PiDriver.ts`,
  `apps/server/src/provider/Drivers/Pi/askUserBroker.ts` and
  `apps/server/src/persistence/Layers/SqliteLanes.ts`.
- 8 both-modified files, including `apps/server/src/ws.ts`, `apps/server/src/server.ts` and
  `apps/server/src/serverRuntimeStartup.ts`.

None of these show up as conflicts.

**Contract names.** Of the 147 exports in base `packages/contracts/src/orchestration.ts`, **82 are
not exported anywhere in upstream's contracts**, matching by name. Adding Loom's 10 additions to
that file gives **92 names gone**. Among them are `OrchestrationThread`, `OrchestrationEvent`,
`OrchestrationCommand`, `OrchestrationReadModel`, `OrchestrationShellSnapshot`,
`ORCHESTRATION_WS_METHODS` and every `Thread*Payload`. **241 pull-8-side files** reference at least one of them:

| area                      | files | Loom-only files among them |
| ------------------------- | ----: | -------------------------: |
| `apps/server`             |   148 |                         58 |
| `packages/client-runtime` |    43 |                          1 |
| `apps/web`                |    23 |                          3 |
| `apps/mobile`             |    14 |                          0 |
| `packages/shared`         |     8 |                          4 |
| `packages/contracts`      |     5 |                          1 |

(Doc 27's earlier count: 206 of Loom's 766 fork-only files import V1 orchestration contracts or modules.)

## Auto-merged drift

Upstream paths that applied without conflict, by directory (A/M/D counts, upstream lines +/−):

| directory                                                                   |   A |   M |   D |  +lines | −lines |
| --------------------------------------------------------------------------- | --: | --: | --: | ------: | -----: |
| `apps/server/src/orchestration-v2`                                          | 521 |   0 |   0 | 215,052 |    317 |
| `apps/server/src/provider`                                                  |  71 |  82 |  23 |  25,441 |  9,772 |
| `apps/web`                                                                  |  87 | 226 |   5 |  25,240 |  6,232 |
| `packages/effect-acp`                                                       |   4 |  14 |   1 |  22,003 |  9,645 |
| `packages/client-runtime`                                                   |  55 |  82 |   2 |  15,708 |  3,812 |
| `apps/mobile`                                                               |  77 | 137 |   1 |  14,541 |  2,487 |
| `apps/server/src/mcp`                                                       |  34 |  11 |   0 |  13,489 |     80 |
| `packages/contracts`                                                        |  27 |  24 |   0 |   8,603 |    114 |
| `apps/server` (non-`src`: integration, scripts)                             |  19 |   8 |   3 |   6,715 |  1,526 |
| `apps/server/src/orchestration` (clean deletes of files Loom never touched) |   0 |   0 |  32 |       0 |  5,395 |
| `apps/server/src/project`                                                   |  11 |   3 |   2 |   4,162 |    533 |
| `apps/server/src/persistence`                                               |  22 |   4 |  11 |   2,565 |  2,015 |
| `docs`                                                                      |  19 |  28 |   0 |   4,269 |    168 |
| `packages/shared`                                                           |  14 |  30 |   0 |   3,380 |    375 |
| `apps/server/src` top-level files                                           |   8 |  17 |   0 |   1,859 |    229 |
| `apps/server/src/textGeneration`                                            |   4 |  13 |   0 |   1,618 |    435 |
| `apps/server/src/scheduledTasks` (new)                                      |   5 |   0 |   0 |   1,534 |      0 |
| `apps/server/src/usage`                                                     |   0 |  18 |   0 |   1,325 |    369 |
| `apps/server/src/pullRequest`                                               |   2 |  19 |   0 |   1,181 |    288 |
| `scripts`                                                                   |   2 |   9 |   0 |   1,121 |    224 |
| everything else (about 30 small directories, 138 files)                     |   — |   — |   — |   6,684 |  1,567 |

**117 files both sides modified auto-merged silently.** By area: `apps/web` 44, `usage` 8,
`apps/mobile` 7, `textGeneration` 7, `packages/shared` 7, root 6, `provider` 6, `contracts` 6,
`client-runtime` 5, and others. The list is `/tmp/pull9-trial/both-modified-automerged.json`.

These touch Loom-rehomed surfaces:

- **Sidebar:** `apps/web/src/components/sidebar/SidebarChrome.tsx` (upstream +64/−31) and
  `apps/web/src/components/ui/sidebar.tsx`. `Sidebar.tsx` and `Sidebar.logic.ts` themselves conflict.
- **Chat surface:** `apps/web/src/components/ChatMarkdown.tsx`. It carries 33 `loom:` lines, Loom
  changed +267/−19 and upstream +184/−57 (mermaid rendering, file-link label changes), and it merged
  **with no conflict**. Also `ContextWindowMeter.tsx` and `chat/providerIconUtils.ts`.
- **Model picker:** `apps/web/src/modelSelection.ts` and its test, and
  `apps/web/src/components/settings/ProviderModelsSection.tsx`. `ModelPickerContent.tsx` and
  `ProviderModelPicker.tsx` conflict.
- **Migrations and DB:** `apps/server/src/config.ts` auto-merged, which **silently switches `dbPath`
  to `statev2.sqlite`**. About 50 tracked Loom files name `state.sqlite`, including
  `apps/server/scripts/loom-ledger-rollback.ts`, `apps/server/scripts/t3-sqlite-state.ts`,
  `apps/server/scripts/migrate-dev-db.ts`, the `AGENTS.md` test-data recipe and the
  `test-t3-app` skill. Also `apps/server/src/persistence/ProviderSessionRuntime.ts` (Loom +45).
- **Dev-runner and ship:** `scripts/dev-runner.test.ts` conflicts. `scripts/lib/cli-external-packages.ts`,
  `vite.config.ts`, `pnpm-workspace.yaml` and `package.json` auto-merged. Upstream did not touch `scripts/ship.ts`.
- **Usage:** 8 `apps/server/src/usage/*` files auto-merged under upstream's usage rework
  (`UsageService.ts` upstream +148/−65, 4 `loom:` lines).

**Declaration-level check** (the `lostdecls.py` approach applied to the 109 auto-merged `.ts`/`.tsx`
files). **8 files lose an exported name from the pull-8 side**, for example:

- `apps/server/src/mcp/McpSessionRegistry.ts` loses `revokeActiveMcpThread` and
  `revokeAllActiveMcpCredentials`, which the deleted `ProviderService.ts` used.
- `apps/web/src/modelSelection.ts` loses `resolvePlanAgentHealPatch` and `withoutPlanAgentSelection`.
- `apps/mobile/src/state/queries.ts` loses `useThreadDetail`.
- `apps/web/src/components/chat/providerIconUtils.ts` loses `PROVIDER_ICON_BY_PROVIDER`, which
  `ProviderInstanceIcon.tsx` still imports.

Each needs adjudicating, as in pull 7. The full list is in `/tmp/pull9-trial/lostdecls-automerged.txt`.

### The 155 commits, grouped

Grouped from subjects plus touched paths; `/tmp/pull9-trial/commit-groups.txt` has them.

| group                                  | commits | notes                                                                                                                                                                                                    |
| -------------------------------------- | ------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V2 orchestration core                  |       1 | `de34391427` (#2829)                                                                                                                                                                                     |
| V2 follow-ups and fixes                |      22 | runs stuck, restarts keep delegated tasks (#15323), PR watch and wake (#15057), settle-on-merge (#15024, #15388, #15604), subagent fixes, steer selection. 32 commits in total touch `orchestration-v2/` |
| Pi, provider and MCP                   |      25 | Claude, Codex, OpenCode, ACP fixes; shared MCP tool presentation (#15475); one-click provider updates; Pi/ACP badge (#14915)                                                                             |
| web and desktop shell                  |      53 | sidebar settle/wake sweep (#14768), command-palette virtualisation, mermaid, tool-call rendering without cards (#15506), model picker sizing (#15152)                                                    |
| client-runtime, relay and environments |      10 | reconnect jitter, multi-route environments (#15467, #15468), relay disconnects                                                                                                                           |
| mobile                                 |      13 | 2.0.0 bump, Working section, dictation, simulator viewer                                                                                                                                                 |
| usage                                  |       6 | cost by token type (#15108), warm scan performance (#15149)                                                                                                                                              |
| misc (tests, lint, CI, dev, release)   |      25 | fixture-file tests, lint rules, `ddcd310282` "docs, dev scripts and CI catch up with orchestration V2"                                                                                                   |

Excluding `de34391427`, **47 commits touch Loom-rehomed web surfaces**: `ChatView` 20,
`MessagesTimeline` 12, `Sidebar*` 11, `DiffPanel` 3, `ChatMarkdown` 3, `ChatComposer` 2,
`RightPanel*` 2, model picker 1, `modelSelection` 1, `composerDraftStore` 1. Separately, 1 touches
dev-runner and 1 touches `persistence/Migrations`.

## Persistence and the V1 → V2 import path

**V2 runs on a new database file.** `apps/server/src/config.ts` sets `dbPath` to
`<stateDir>/statev2.sqlite`. On first boot, `apps/server/src/persistence/initializeV2Database.ts`
takes a read-only `node:sqlite` backup of `state.sqlite` and links it to `statev2.sqlite`. It does
this once and never refreshes. **So every Loom table and column is copied into the V2 database
intact.** Only the copy receives later migrations, and `state.sqlite` stays as a V1 rollback source.

**The importer** is `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` (833 lines),
documented in `docs/internals/legacy-orchestration-migration.md`. It reads only these:

- `projection_threads`, a fixed column list: `thread_id`, `project_id`, `title`,
  `model_selection_json`, `runtime_mode`, `interaction_mode`, `branch`, `worktree_path`, timestamps,
  `archived_at`, `deleted_at`, `settled_*`, `unsettled_at`, `snoozed_*`, `pinned_at`,
  `pin_order_key`, `auto_settle_disabled_at`, `active_order_key`, `linked_pull_request_json` and
  `branch_pull_request_json`.
- `projection_thread_pull_requests`.
- `projection_thread_messages`, filtered to `role IN ('user','assistant')`, imported lazily per
  thread when it is first read or continued.
- `orchestration_events`, only to detect threads that already have a V2 `thread.created` event.

It writes `orchestration_v2_legacy_imports` and V2 events. It does **not** import provider session
identity, checkpoints and diffs, activities and tool calls, approvals or proposed plans. A migrated
thread's first continuation starts a fresh provider session, with a handoff of at most 32,000
characters built from the transcript.

**It reads none of Loom's schema.** Loom's lane (`apps/server/src/persistence/LoomMigrations.ts`,
1001–1045) adds the following, and all of it is ignored:

- **tables:** `projection_goals`, `projection_goal_tasks`, `projection_thread_heartbeats`,
  `projection_usage_ledger`, `projection_thread_consults`, `projection_thread_peer_messages` and the
  thread-search index (1045).
- **`projection_threads` columns:** `goal_id`, `parent_thread_id`, `role`, `purpose`, `blocked_by`,
  `brief`, `report_path`, `spawn_generation`, `cumulative_cost_usd`, `plan_lane`, `attention`,
  `max_tokens`, `used_tokens`, `tool_uses`, `gate_rounds`, `last_outcome`, `pending_rework`,
  `routes`, `fan_in_state`, `isolation`, `diff_additions`, `diff_deletions`,
  `fork_from_thread_id`, `graph_key`, `kickoff_brief_path`, `plan_lane_since`,
  `dependencies_since`, `fanin_since`, `final_commit_sha`, `continues_thread_id`,
  `handoff_destinations`, `anchor_task_id`, `pending_user_input_header` and `pending_user_input_since`.
- **`projection_thread_messages` columns:** `origin`, `control_payload_json` and `reasoning_ms`.
  Loom's `role = 'reasoning'` rows (1038) are excluded by the role filter.
- **other columns:** `projection_thread_sessions.last_error_class`, `projection_usage_ledger.provider_id`.

**What gets lost.** Loom's own V1 event types stay in `orchestration_events` at
`application_event_version = 1`; V2 adds that column (default 1) and filters on 2. So under V2 the
workstream graph, goals, tasks, lanes, gates and heartbeats survive as **inert rows** in the copied
database, and nothing reads them. Loom-originated control messages stored as `role='user'` would be
imported as ordinary user messages.

**Migration numbering does not collide.** Upstream adds `055_OrchestrationV2` (it composes
`Migrations/OrchestrationV2/*`: `orchestration_v2_*` tables, `scheduled_tasks`, the
`application_event_version` column on `orchestration_events`, and `command_type` on
`orchestration_command_receipts`) and `056_RemoveRedundantProjectionIndexes` (drops 4 V1 projection
indexes, one of them on `projection_threads`). Both are in `effect_sql_migrations`. Loom's 1001+ lane
is in its own `loom_sql_migrations` table, so:

- upstream's new divergence warning in `runMigrations` only scans `effect_sql_migrations`;
- `reconcileV2PreviewMigration` only touches ids 53–56 there;
- upstream's own doc now independently recommends the separate-table design Loom already uses.

The lane split pays off. `apps/server/src/persistence/Migrations.ts` still conflicts on one hunk,
but it is trivial: Loom's only divergence (`export const migrationEntries`) was made identically
upstream. `apps/server/src/persistence/Layers/Sqlite.ts` conflicts because Loom's
`runAllMigrations()` meets upstream's `initializeV2Database(dbPath)` and PRAGMA changes. One
caveat: Loom's 1001+ migrations would run against `statev2.sqlite` after the snapshot, so any
retained Loom table keeps working only if the code that reads it survives.

## Mechanical-feasibility assessment

**The textual part fits the pull-7 method.** That is 155 UU/AA files with 468 markers (448 outside
`pnpm-lock.yaml`), half of them single-marker. In size and shape this is pull-7 or pull-8 work:
`ws.ts` (24 markers), `DiffPanel.tsx`, `ChatView.tsx`, `composerDraftStore.ts`,
`serverRuntimeStartup.ts`, `Sidebar.tsx` and `shell-sync.test.ts` are the hard ones, and the pull-7
tooling applies: `hunks.sh`, `sideresolve.py`, `union.py`, `parsesweep.mjs`, `lostdecls.py` and
`aliascheck.py`.

The caveat is that many of these files resolve against the wrong world. `ws.ts`,
`serverRuntimeStartup.ts`, `server.ts`, `client-runtime/src/state/*` and `ChatView.tsx` are where
upstream wired V2 in. A textually clean resolution of them still has to pick one engine.

**The structural part cannot be merged.** The 95 modify/delete files, the 86 relocations, the
`PiDriver.ts` add/add, the 92 vanished contract names (used by 241 files) and about 125
dangling-import files are not a conflict set. Every one of them has the same two outcomes:

- **keep Loom's file**, which brings back the deleted V1 module upstream no longer maintains; or
- **take upstream's deletion**, which drops roughly 57,000 lines of Loom code with nothing to merge it into.

Both choices are valid only as the output of a strategy decision. Git cannot reach either side
mechanically into a tree that compiles. For orchestration, provider adapters, V1 projection
persistence and the V1 contracts, the honest description is **a port, regardless of strategy**:

- **Re-platform:** Loom's engine code is re-expressed against V2.
- **Retain:** the V1 engine is kept alive beside or instead of V2. Then upstream's 32 V2 follow-up
  commits, and every future V2-touching commit, are what conflicts, permanently.
- **Hybrid:** both.

**Against pull 7.** Pull 7 was 230 conflicted files from 1551 commits, almost entirely content
conflicts, and took several sessions (doc 25 records six). Pull 9 is 336 from 155 commits:

- **Textual part:** 155 files, about two-thirds of pull 7.
- **Structural part:** 181 paths plus about 125 non-conflicting dangling-import files and the
  241-file contract-name blast radius. Pull 7 had nothing comparable. The orchestration areas hold
  2 conflict markers across 130 paths, which shows they are not a merge problem at all.

The planner should size pull 9 as a merge (the 155 files) plus a port (the rest). The port's size
depends on the chosen strategy, not on the conflict count.
