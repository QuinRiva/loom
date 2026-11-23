## Appendix B.3: projection store, shell stream, search, persistence (11 files, 32 markers, 91 `loom:` lines) · lane 1 server core

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** No decision labels.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/server/src/orchestration-v2/ProjectionStore.ts` · 10m · 36L · [2/1c] [1/1c] [2/2c] [2/20c] [7/8c] [12/7c] [13/78c] [4/1c] [9/17c] [3/63c]
- `apps/server/src/orchestration-v2/ShellStream.test.ts` · 2m · 2L · [2/2c] [1/5c]
- `apps/server/src/orchestration-v2/ShellStream.ts` · 5m · 10L · [6/1c] [2/2c] [3/2c] [1/1c] [1/1c]
- `apps/server/src/orchestration-v2/ThreadSearch.test.ts` · 2m · 7L · [3/1c] [1/197c]
- `apps/server/src/orchestration-v2/ThreadSearch.ts` · 3m · 5L · [7/5c] [3/2c] [3/2c]
- `apps/server/src/persistence/DatabaseMaintenance.ts` · 1m · 2L · [1/1c]
- `apps/server/src/persistence/Sqlite.ts` · 2m · 4L · [5/4c] [39/19c]
- `apps/server/src/storageCleanup.ts` · 1m · 1L · [2/1c]
- `packages/client-runtime/src/state/assets.test.ts` · 1m · 1L · [1/0o]
- `packages/client-runtime/src/state/shell.ts` · 3m · 14L · [4/1c] [18/2c] [6/2c]
- `packages/client-runtime/src/state/shellReducer.ts` · 2m · 9L · [7/1c] [5/1c]

### Per-hunk doctrine

#### 3.1 `apps/server/src/orchestration-v2/ProjectionStore.ts` (10 markers, one row per hunk)

All 47 `loom`-bearing lines of `HEAD`'s version are present in the trial file (inside markers or merged); the 30 or so outside markers (open-question SQL, `pending_question_header`, `open_questions_json`, the `isLoomDomainEvent` guard in `applyToProjection`, three `decodeMessageRows` call sites, `threadShellFromProjection`/`shellFromState` arms) merged at the right anchors. Upstream added no new `decodeRows(decodeMessagePayload…)` call sites and no new pending-runtime-request read that feeds the shell without Loom's `$.loom.blocking` clause (the only new `status = 'pending'` reads are 5257, pending `user_message` items, and 9745, the `may_be_live` list, which matched `HEAD` without the clause already).

| # | Shape | Upstream change | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [2/1c] @2 | #36233 thread visit stores only read state (`applyOrchestrationV2ThreadVisit`) | `isOpenQuestion` import (open questions) | U | `import { applyOrchestrationV2ThreadVisit, pendingGuestMessageCount } from "@t3tools/contracts";` then Loom's `import { isOpenQuestion } … // loom: open questions`. | no |
| 2 | [1/1c] @114 | #39325 delegated-task finalisation (`DELEGATED_TASK_MESSAGE_CONDITION`) | `threadToolOutputImageAttachmentIds` import (tool output images) | U | Both imports. | no |
| 3 | [2/2c] @531 | #34870 `hasRemoteTasks` on `ActiveShellIndexEntry` (linked-environment tasks stay under their parent) | `workstream?: { keep; goalId }` (DL-1650) | U | Both fields; upstream's `readonly hasRemoteTasks: boolean;` first, Loom's doc line and field after. | no |
| 4 | [2/20c] @2567 | #24422/#34573 timeline index cache invalidation; #38544 batched provider commits flush a deferred thread `updated_at` before a thread-rewriting event | `yield* applyLoomProjectionEvent(sql, event);` at the top of `apply` (sidecar tables in the commit transaction) | U | Upstream's 20 lines first, then Loom's comment and call immediately before `switch (event.type)`. Order is safe either way (`applyLoomProjectionEvent` reads only `project_id` and lineage from the thread row, `loomProjection.ts:286-297`), after keeps upstream's "deferred bump lands first" invariant for every reader. Loom events still invalidate the timeline cache harmlessly (they carry `threadId`). | yes (placement) |
| 5 | [7/8c] @6985 | #32255 forks of forks keep their deleted source's files: renders query aliased `item.` and bounded by `runOrdinalBetween` inside new `runAttachmentIds(threadId, from, through)` | `OR payload_json LIKE '%"attachmentId"%') -- loom: tool output images` | D | Upstream's query plus Loom's clause: `AND (item.payload_json LIKE '%htmlRender%' OR item.payload_json LIKE ${…MCP_APP_OUTPUT_KEY…} OR item.payload_json LIKE '%preview_recording_stop%' OR item.payload_json LIKE '%"attachmentId"%') -- loom: tool output images` then `AND ${runOrdinalBetween("item.run_id", from, through)}`. | yes |
| 6 | [12/7c] @7013 | same #32255: guest-files query moved out of this `Effect.all` into `getThreadAttachmentIds` | Loom's side is upstream's old guest-files query plus Loom's `rows`→`renders` refactor | D (trap) | Take upstream's side. Keeping Loom's side re-adds the guest-files query that upstream now runs in `getThreadAttachmentIds`. | yes |
| 7 | [13/78c] @7040 | same #32255: `runAttachmentIds` return, `unshownRunAttachmentIds`, fork-aware `getThreadAttachmentIds` (with `new Set` dedupe and guest files) | `...threadToolOutputImageAttachmentIds(threadId, renders), // loom: tool output images` in the old return | D | Take upstream's 78 lines; in `runAttachmentIds` map `renders` once (`const mapped = renders.map(row => { const item = parseEncodedPayload(row.payload_json); return { toolName: …, output: item.output }; })`), pass it to `threadHtmlRenderAttachmentIds(threadId, mapped)` and add `...threadToolOutputImageAttachmentIds(threadId, mapped), // loom: tool output images` to the returned array. Loom's ids then take part in upstream's fork retention (an improvement: a live fork keeps a deleted source's tool images). | yes |
| 8 | [4/1c] @9714 | #34870 `has_remote_tasks` row field | `loom_row`, `loom_keep`, `loom_goal_id` (DL-1650) | U | `readonly has_remote_tasks: number;` then Loom's comment and three fields. | no |
| 9 | [9/17c] @9765 | #37966 active shell index read without parsing thread payloads (098 covering index; `indexedField`), plus #34870 `has_remote_tasks` | Loom's side carries `HEAD`'s old `OR EXISTS (json_each(t.payload_json,'$.pullRequests')…)` plus the three Loom columns | D (trap) | Upstream's 17 lines, then Loom's 4: see SQL below. Do not keep Loom's `OR EXISTS` (it parses every active payload, the cost 098 removes). The `LEFT JOIN loom_thread_workstream w … -- loom: DL-1650` line already merged below the marker; keep it. | yes |
| 10 | [3/63c] @9813 | #34870 `hasRemoteTasks: row.has_remote_tasks === 1` and #36434 new `listActiveThreads` (thread list builds metadata only for its page) | `...(row.loom_row === 1 ? { workstream: … } : {})` (DL-1650) | U | In the `listActiveShellIndex` row map: `hasRemoteTasks: …,` then Loom's spread; then upstream's `listActiveThreads` function whole. `listActiveThreads` feeds `ThreadManagementService.listProjectThreads` (an MCP/agent list), carries no Loom fields: the `mcp-tools` owner says whether a Loom tool relied on the old shell-backed list. | no |

Resolved SQL for hunk 9 (the tail of `listActiveShellIndex`):

```sql
            OR CASE WHEN ${indexedField("$.pullRequests[0]", "json_type")} IS NOT NULL
              THEN EXISTS (
                SELECT 1 FROM json_each(t.payload_json, '$.pullRequests') link
                WHERE json_type(link.value, '$.watch') IS NOT NULL
              )
              ELSE 0 END
          ) AS may_be_live,
          t.thread_id IN (
            SELECT subagent.thread_id FROM orchestration_v2_projection_subagents subagent
            WHERE subagent.origin = 'app_owned'
              AND subagent.child_thread_id IS NULL
              AND json_type(subagent.payload_json, '$.remoteChild') = 'object'
          ) AS has_remote_tasks,
          -- loom: a stored flag or no outcome yet; keepsLoomChildInColdShell decides on the shell.
          w.thread_id IS NOT NULL AS loom_row,
          (json_array_length(w.attention) > 0 OR w.outcome IS NULL) AS loom_keep,
          w.goal_id AS loom_goal_id
        FROM orchestration_v2_projection_threads t
        LEFT JOIN loom_thread_workstream w ON w.thread_id = t.thread_id -- loom: DL-1650
        WHERE t.deleted_at IS NULL
          AND t.archived_at IS NULL
        ORDER BY t.updated_at ASC, t.thread_id ASC
```

Index/count-backed reads and Loom's clauses: upstream split the per-thread shell read so item counts come from `selectShellItemCounts` (102) and `selectShellRunItemCounts` (085) instead of the main SQL; Loom has no clause in item counting. Loom's three pending-request clauses (`pending_request_payload_json`, `pending_question_header`, `open_questions_json`) stay in `selectShellThreadRows`' one-row-per-thread SQL (trial lines 8645-8705), which every shell path still runs (`readShellSnapshot`, the fork-source walk, the live-status list). The in-memory path (`threadShellFromProjection`) keeps Loom's `!isOpenQuestion` filter. Loom's `INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx` hints remain valid: no upstream migration 077-108 drops or renames that index (`rg -i 'drop index'` over them finds only 078, 083, 092, 107, none Loom uses).

#### 3.2 `apps/server/src/orchestration-v2/ShellStream.ts` (5 markers) and its test (`ShellStream.test.ts` / `ThreadSearch.test.ts`, 2 markers)

Upstream (#35071, #34870, #33585) added the resume helpers (`canResumeShellFrom`, `loadShellUnlessResumable`, `projectIdentitiesDigest`, `resumeIdentityRoots`), `remoteTaskParentIds` in the trim facts, and an early `turnItemCanChangeUserWait` publish. The trims themselves (25 newest settled, per-project counts, idle-subagent omission) are unchanged, so Loom's keep clauses slot in as unions. All 10 Loom lines are in the trial file; `roots` (264) and `inLiveGoal` (296) merged silently at the right place.

| # | Shape | Upstream | Loom | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [6/1c] @37 | #35071 `import type * as OrchestrationEventStore` | `loomShellJoin.ts` imports (DL-1404, DL-1650) | U | Both. | no |
| 2 | [2/2c] @269 | #34870 `facts.remoteTaskParentIds.has(thread.id)` | `keepsLoomChildInColdShell(thread, roots)` (DL-1404) | U | `isLiveSubagentShell(thread) \|\| keepsLoomChildInColdShell(thread, roots) \|\| // loom: DL-1404` / `facts.subagentParentIds.has(thread.id) \|\|` / `facts.remoteTaskParentIds.has(thread.id),` | no |
| 3 | [3/2c] @303 | same | flagged Loom root and live goal's root stay | U | `keepsLoomChildInColdShell(thread, new Map()) \|\| // loom…` / `inLiveGoal(thread) \|\| // loom…` / `ancestorIds.has(thread.id) \|\|` / `facts.remoteTaskParentIds.has(thread.id),` | no |
| 4 | [1/1c] @405 | `entry.hasRemoteTasks \|\|` | `keepsLoomEntry(entry) \|\| // loom: DL-1650` | U | Both lines, upstream's first. | no |
| 5 | [1/1c] @429 | same | same | U | Both lines. | no |
| T1 | [2/2c] @49 | test helper's third argument becomes an item type string (`payload: { type: itemType }`) for the new `turnItemCanChangeUserWait` loop | helper takes a payload object, default `runningTool` | T | Keep Loom's helper (`payload: object = runningTool`); rewrite upstream's new loop call as `stored("child", "turn-item.updated", { ...runningTool, type: itemType })`. Upstream's shape crashes Loom's `isLoomStepBoundary` (`DateTime.toEpochMillis(undefined)` when `startedAt` is absent) for any `turn-item.updated` that reaches it. | yes |
| T2 | [1/5c] @236 | reformatted `event` with `payload: { type: "command_execution" }` | `payload: runningTool` | T | Upstream's multi-line layout with Loom's `payload: runningTool`. | no |

Cold-shell payload: the thread shell gained three optional fields (`issues`, `latestRunBackgroundWake`, `lastTitleRegeneration`), the HTTP snapshot gained `projectIdentities`, and the stream gained `snapshot-required` and the HTTP `{ resumable: true }` answer. Paging (`getOlderSettledThreads`) and the trimmed-shell rules are unchanged. Loom's `workstream` fields ride the same shell rows; Loom goals ride the HTTP snapshot (`orchestration-v2/http.ts:98`, owned by `orchestration-delegation`) and the socket's `loom: true` tail.

Pull 15's 2.6 s first trimmed shell read (474 threads, 2.83 MB): upstream's changes should lower it (no finished-tool-call walks, item counts from count tables, covering index for the index read, the read on a reader worker with the writer on its own worker). Loom's join is not the cost: on the live cockpit the index read over 5,269 active threads takes 22 ms without the join and 26 ms with it (§9), and the plan is a primary-key lookup per row. Loom's real contribution is the keep set (651 rows have `loom_keep` before `keepsLoomEntryInColdShell` refines it) and its two per-thread subqueries, which touch turn items only for threads with a pending request. S3 should time: (1) the first trimmed HTTP shell read after boot (ms, bytes, thread count) against 2.6 s / 2.83 MB / 474; (2) `EXPLAIN QUERY PLAN` of `listActiveShellIndex` on the migrated copy, expecting `orchestration_v2_projection_threads_active_shell_idx` (covering) for `t` and the autoindex for `w`; (3) a reconnect with fresh cached rows answering `{"resumable":true}`, then a goal edit made while disconnected (see §8).

#### 3.3 `apps/server/src/orchestration-v2/ThreadSearch.ts` (3) and its test (`ShellStream.test.ts` / `ThreadSearch.test.ts`, 2 markers)

Loom serves search from `ThreadSearch.loom.ts` (`server.ts:696` provides it as upstream's `ThreadSearch` service); from upstream's `ThreadSearch.ts` Loom uses only `searchOlderSettled` and the compiled module. Upstream's changes (#22553 quote text via 081 `search_text`, #36632 accent folding, #36832 smart apostrophes, #29874 rolled-back and cancelled-queued turns hidden, #28992 `archived_at` column) all sit in `searchMessages`/`messageHitsQuery`, which no Loom surface calls.

| File / # | Shape | Upstream | Loom | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `.ts` 1 | [7/5c] @219 | comment rewrite, `export const messageHitsQuery` | not exported (knip: its only importer was the EXPLAIN test dropped with 1065) | U | Upstream's four comment lines, then Loom's `// loom: not exported…` and `const messageHitsQuery = (`. No test in the merged file imports it. | no |
| `.ts` 2 | [3/2c] @261 | `${messageSearchText(sql)} AS text` | `eligible.title, eligible.updated_at AS "updatedAt" -- loom` | U | `${messageSearchText(sql)} AS text,` / `messages.created_at AS "messageCreatedAt",` / Loom's line. | no |
| `.ts` 3 | [3/2c] @284 | same (index path) | same | U | Same. | no |
| test 1 | [3/1c] @626 | test renamed and widened to rolled-back turns (#29874) | Loom's note for the dropped apostrophe-folding test | T | Loom's note line, then upstream's renamed `it.effect` and body. | no |
| test 2 | [1/197c] @792 | `it.effect.each([true,false])` Cyrillic/accent short-word test over 069's index | Loom's note for dropped scripts/no-index tests | T | Keep Loom's note, drop upstream's block, as pull 15 did (DL-1821). Its `indexed: false` arm runs `DROP TRIGGER orchestration_v2_message_search_insert` without `IF EXISTS` (trial lines 819-822, 863-865), which throws on Loom's harness where 1065 already dropped them. | no |

Schema check against the cockpit (read-only): `effect_sql_migrations` max 80, `loom_sql_migrations` max 1072; no `orchestration_v2_message_search` table, only `loom_thread_search*`; `orchestration_v2_projection_threads.archived_at` exists and agrees with `payload.archivedAt` on all 7,626 rows. Upstream's search code reads `orchestration_v2_message_search` only when `sqlite_master` lists it (`ThreadSearch.ts:558`); `recreateMessageSearchTriggers` and `rebuildMessageSearch` return early when it is absent, so 081 adds `search_text` and backfills citation messages without recreating the dropped triggers. 081's backfill updates only `search_text`, which Loom's `loom_ts_messages_au` trigger (`UPDATE OF payload_json, streaming`) does not watch. No upstream migration 081-108 renumbers a table Loom's index keys by rowid (only `ADD COLUMN`s).

Is "Loom keeps its own index" still the cheaper end state? Yes. From the code and the cockpit:

| Capability | Loom (`ThreadSearch.loom.ts`, `threadSearchIndex.loom.ts`) | Upstream (`ThreadSearch.ts`) |
| --- | --- | --- |
| What is searched | titles, purposes, kick-off briefs, user messages, last assistant message per run, reports, goals, tasks (8 kinds, 69,471 documents) | user and assistant messages; titles and PRs scored client-side |
| Which threads | every live thread, archived included unless asked; 6,518 of the 7,531 live cockpit threads are Loom sub-threads | active, non-archived, non-subagent, non-side-chat only (about 650 roots on the cockpit) |
| Result unit | the root, with the sub-thread that matched named (`matchedThreadId`) | the thread that holds the message |
| Ranking | BM25 with kind weights, plus RRF with Vertex embeddings over 1,009 roots (falls back to lexical when the embedder is down) | trigram substring hits, newest first, JS word-start ranking |
| Agent scope | `scope: "all"` reaches sub-threads and tasks | none (upstream's `t3_thread_search` is withheld from Loom roles) |
| Upstream-only | substring matches inside a word, quote text without percent-encoding (081), rolled-back turns hidden | |

Taking upstream's would lose archived roots, every sub-thread and report, goals, tasks and the semantic half; it would also bring back the trigram index's write cost that 1065 removed. Recommendation: keep the ruling. Two cheap borrowings are follow-ups (§8), not merge work.

#### 3.4 `packages/client-runtime/src/state/shell.ts` (3) and `shellReducer.ts` (2)

#35071 restructured the subscription: an early HTTP load while the socket opens (`useEarlyLoad`/`awaitEarlyLoad`), `resumeFrom` on the HTTP route (`loadOverHttp` returns `resumable`, `snapshot` or `failed`), and a socket resume with `httpSnapshotFallback`/`knownProjectIdentities` that can answer `snapshot-required`. HTTP snapshots still enter through `applyLocked([{ kind: "snapshot" … }])` (`applyHttpSnapshot`), so Loom's `clearLoomCacheState` still fires on every authoritative snapshot. All 14 Loom lines are in the trial file. Both web and mobile run this same state (`makeEnvironmentShellState`); Loom consumers of the shape: web `apps/web/src/state/threads.ts` (`loomEnvironmentSnapshotAtom`, read by `LoomRollupBadge.tsx`, `sideThreadRowAtoms.ts`, `HandoffToastCoordinator.tsx`, `ThreadStart.tsx`, `loomTimelineRows.ts`) and mobile `threadListV2.ts`, `WorkstreamBadge.loom.tsx`, `useDocumentAuthor.loom.ts` via `@t3tools/client-runtime/state/loom/*`. The brief placed `loomEnvironmentSnapshotAtom` in client-runtime; it lives in web's `state/threads.ts`, outside this area, and its input shape does not change.

| File / # | Shape | Upstream | Loom | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `shell.ts` 1 | [4/1c] @40 | `subscriptionRetryDelay` import (#35071 defect backoff) | three `./loom/*` / `shellGoals.loom.ts` imports | U | Loom's three imports and `import { subscribeDynamicWithSession, subscriptionRetryDelay } from "../rpc/client.ts";`. | no |
| `shell.ts` 2 | [18/2c] @380 | `snapshot-required` sets `snapshotRequired` and continues | consult, cache, cache-clear and goal arms before the delta split | U | Loom's four arms (the goal arm keeps its own `continue; }`), then `if (item.kind === "snapshot-required") { snapshotRequired = true; continue; }`. | yes (brace count) |
| `shell.ts` 3 | [6/2c] @739 | resume decision now `Option.isNone(current.snapshot) \|\| !(resumingHeldRows \|\| loaded?.kind === "snapshot")` (`canResume` is gone) | `loom: true as const` on the fresh-subscribe input | D | `if (Option.isNone(current.snapshot) \|\| !(resumingHeldRows \|\| loaded?.kind === "snapshot")) { return { ...omission, loom: true as const, // loom: goal items and snapshot goals (seam 15)` / `requestCompletionMarker: true as const }; }`. The second `loom: true` (resume input, line 752) already merged. | yes |
| `shellReducer.ts` 1 | [7/1c] @141 | `event: ShellStreamEvent` | `Exclude<…>` widened by consult/cache kinds | Superseded + D | `event: ShellStreamEvent \| LoomGoalShellStreamItem, // loom: goal items apply ungated` and keep Loom's `if (isLoomGoalShellStreamItem(event)) return applyLoomGoalItem(snapshot, event);`. `shellGoals.loom.test.ts:22-35` calls `applyShellStreamEvent` with goal items, so the goal kind must stay in the parameter. | no |
| `shellReducer.ts` 2 | [5/1c] @238 | `ShellStreamEvent = Extract<OrchestrationV2ShellStreamItem, { readonly sequence: number }>` | four excluded kinds plus `LoomGoalShellStreamItem` | Superseded | Take upstream's `Extract`: Loom's consult, cache and goal items carry no `sequence` (`orchestrationV2.loom.ts:474-749`), so `Extract` already drops them. Loom's `LoomGoalShellStreamItem` import stays for hunk 1. | no |

#### 3.5 `Sqlite.ts`, `DatabaseMaintenance.ts`, `storageCleanup.ts`, `assets.test.ts`

| File / # | Shape | Upstream | Loom | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `Sqlite.ts` 1 | [5/4c] @8 | `SqlError` import; `hasPendingMigrations, runMigrations` | `MigrationError` import; `runAllMigrations` from `LoomMigrations.ts` | U | All four: upstream's imports plus Loom's two marked lines. | no |
| `Sqlite.ts` 2 | [39/19c] @26 | `ServerOwnsDatabaseError`, damaged-database error, `runMigrationsAsOwner` (CLI migrates only under the server ownership lock), `makeLayerSetup(migrate)`, `writerWorker: true` replacing `checkpointWorker` (#35728) | `cache_size = -131072` with its comment; `runAllMigrations().pipe(catchTags LoomLedgerReconciliationError → MigrationError)` (DL-148) | D | Take upstream's block. Re-apply: (a) Loom's two comment lines and `yield* sql\`PRAGMA cache_size = -131072;\`` after `checkpoint_fullfsync` inside `makeLayerSetup`; (b) a marked `const runForkAwareMigrations = () => runAllMigrations().pipe(Effect.catchTags({ LoomLedgerReconciliationError: … }))` used in `layerSetup = makeLayerSetup(runForkAwareMigrations())` and in both `runMigrations()` calls inside `runMigrationsAsOwner`; (c) `hasPendingMigrations()` reads only `effect_sql_migrations`, so a CLI run with a pending Loom migration (1073+) skips the ownership lock: OR in a marked Loom check (max id in `loom_sql_migrations` below the highest `loomMigrationEntries` id). With the writer on a worker, `cache_size` now applies to the writer worker's connection; reader-worker connections never had it. | yes |
| `DatabaseMaintenance.ts` 1 | [1/1c] @255 | `onStep("checkpoint")` progress step (#32941) | `yield* rebuildThreadSearchIndex; // loom: doc 38 §4.4` after VACUUM | U | `rebuildMessageSearch(sql);` / Loom's line / `onStep("checkpoint");`. Required: VACUUM renumbers the rowids Loom's index keys on, and #32941 now runs `compact` from Settings' Reclaim at server exit. | yes |
| `storageCleanup.ts` 1 | [2/1c] @743 | `isNonRepositoryGitStderr(result.stderr)` (#33423; phrases include "gitfile does not point to a valid repository", `GitVcsDriverCore.ts:659-667`) | Loom's regex for the same git 2.56 wording | Superseded | Take upstream's line, drop Loom's two. | no |
| `assets.test.ts` 1 | [1/0o] @5 | upstream also imports `AssetWorkspaceAssetNotFoundError` (merged below) | `AssetWorkspaceAssetInspectionError` import for Loom's not-found test (still at trial line 202) | ours | Keep Loom's line. Not an upstream deletion: the class still exists upstream (`contracts/src/assets.ts:221`). | no |

`storageCleanup.ts` deletion roots (upstream): managed worktree directories, `~/.t3/scratch` "No project" folders (#36369, new), `browserArtifactsDir`, `logsDir`. It deletes nothing under `userdata/` (no attachments, tool-output images, workstream reports or briefs). Upstream widened which worktrees count as removable (detached clean worktrees whose commits are on a branch #34967, renamed branches #34984, dangling gitlinks #40119); every rule needs `storageCleanup.*AfterDays` set, and the cockpit's `settings.json` has no `storageCleanup` key (all off). The worktree owner (`multirepo-vcs`) should confirm the settle/archive gates still read Loom's settled state.

### Silently merged files Gate 2 reads in this zone

| File | Why | Found |
| --- | --- | --- |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` | Loom's `toolOutputImageStore.persist(stripUnservedToolOutputImageBytes(…))` wrap at ingest | Present (trial 44, 259, 616); still the only `stripUnservedToolOutputImageBytes` call site, now inside upstream's `boundFileChangeForStorage(…)`. |
| `apps/server/src/persistence/DatabaseMaintenance.test.ts` | Loom's note replacing the 069-index drift check; upstream's new step-order assertion | Present (226); upstream's assertion `["prune-events","vacuum","rebuild-search","checkpoint"]` (265) holds because Loom's rebuild is not a step. |
| `packages/client-runtime/src/state/threadSearch.test.ts` | Loom's widened match fields beside #38155's `failed` | Present (84, 179); `failed` fields merged (67, 110, 118). |
| `packages/client-runtime/src/state/orchestrationV2Projection.ts` | client-side `isLoomDomainEvent` guard | Present (21, 297). |
| `apps/server/src/orchestration-v2/ProjectionControlReads.test.ts` | Loom swaps the corrupt message row for a corrupt plan (decodeMessageRows skips messages) | Present (234). |
| `packages/client-runtime/src/state/threadRequests.ts` | Loom's `blocking` field (open questions) | Present (100, 272). `lostdecls` reports `pendingRuntimeRequestIds` lost: that is upstream's own function, deleted by upstream with its only caller (#23617); no Loom code uses it. False positive. |

Not Loom-touched, so nothing to read: `ProjectionMaintenance.ts` (Loom removed its prune guard in `2e76814b9e` when history moved to `loom_thread_history`; zero Loom delta), `OrchestrationEventStore.ts`, `DatabaseStorage.ts`, `attachmentStore.ts`, `WireProjection.ts`, `toolOutputImageBytes.ts` (unchanged upstream too).

`ToolOutputImageReclaim.loom.ts` against 095: upstream neither inlines, truncates nor relocates tool-output images. 095 adds a write-time flag `inline_work_output` (`htmlRender`, MCP app, `viewedImagePath`, `sentMessage`, delegate/send-to-user tools) replacing a read-time `LIKE`; Loom never extended that predicate, and the reclaim's `UPDATE … SET payload_json` changes none of those markers, so the flag stays right. The count tables (085/102) are trigger-maintained on insert and `UPDATE OF thread_id, run_id`, which the reclaim does not touch. The reclaim stays sound.

### Left for the integration tracks (S2)

- Typecheck: `ProjectionStore.ts` hunks 5-7 (`renders` mapping inside `runAttachmentIds`), `shellReducer.ts` parameter union, `Sqlite.ts` (`runAllMigrations` threaded through `makeLayerSetup`/`runMigrationsAsOwner`; `MigrationError` still imported).
- Tests: `ShellStream.test.ts` upstream's `turnItemCanChangeUserWait` loop rewritten to Loom's payload helper; `ThreadSearch.test.ts` upstream's 197-line block dropped; `shellGoals.loom.test.ts` must still compile against the widened `applyShellStreamEvent`; `ShellStream.loom.test.ts` (DL-1453) unchanged. Upstream's `ProjectionStore.test.ts` and `ShellStream.test.ts` new cases (resume helpers, `hasRemoteTasks`) run as they are.
- Lint/knip: `messageHitsQuery` stays unexported.
- S3: the timings in §3.2.
