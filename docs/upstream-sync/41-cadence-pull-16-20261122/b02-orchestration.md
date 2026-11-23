## Appendix B.2: orchestrator, settlement, deletion, runtime layer (10 files, 27 markers, 118 `loom:` lines) · lane 1 server core

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "Opening a Loom child from inside a thread"; "D2" (children settle with their parent) is carried in §8.2.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/server/src/orchestration-v2/EffectWorker.ts` · 1m · 2L · [1/3c]
- `apps/server/src/orchestration-v2/Orchestrator.ts` · 13m · 61L · [1/1c] [3/3c] [1/1c] [11/14c] [20/14c] [1/3c] [3/1c] [3/2c] [15/8c] [2/1c] [2/1c] [1/4c] [2/1c]
- `apps/server/src/orchestration-v2/RestartContinuation.ts` · 1m · 3L · [5/4c]
- `apps/server/src/orchestration-v2/ThreadDeletion.test.ts` · 1m · 1L · [1/1c]
- `apps/server/src/orchestration-v2/ThreadDeletion.ts` · 1m · 2L · [2/2c]
- `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` · 1m · 6L · [1/1c]
- `apps/server/src/orchestration-v2/ThreadSettlementService.ts` · 5m · 18L · [2/1c] [16/1c] [9/4c] [4/14c] [1/1c]
- `apps/server/src/orchestration-v2/http.ts` · 1m · 2L · [2/1c]
- `apps/server/src/orchestration-v2/legacy/LegacyV1ThreadImporter.ts` · 1m · 17L · [1/3c]
- `apps/server/src/orchestration-v2/runtimeLayer.ts` · 2m · 6L · [1/1c] [2/1c]

### Per-hunk doctrine

#### `apps/server/src/orchestration-v2/Orchestrator.ts` (13 markers, one row per hunk)

All 84 `loom` lines of Loom's blob are present in the trial file (checked whitespace-normalised). The pull 15 rulings still stand:

- DL-1805: the snooze guard has no Loom call; the remaining `hasBlockingPendingRequest` sites at trial lines 660, 4897, 7282, 7309, 7381 and 14510 are unchanged in meaning.
- DL-1812: the `freshContext` grouping is re-expressed in hunks 6 and 7.
- The `loom?` command field: `command.loom?.origin` sits in hunk 7.

| # | Trial line | Shape | Upstream side (PR) | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 16 | [1/1c] | `threadIssueKeysEqual` import (#19270, issues) | `hasBlockingPendingRequest, isOpenQuestion` import (open questions) | U | One `@t3tools/contracts` import with all three names, `// loom: open questions` kept. Both Loom names are still used: `hasBlockingPendingRequest` at 7 sites, `isOpenQuestion` at 4739 and 13408. | no |
| 2 | 1492 | [3/3c] | `!input.hasNativeHistory &&` (#22155 `75c7fb28af`, imported ACP sessions show native history); the call site passes `nativeThreadRef !== null` | `!input.hasStrongNativeRef // loom: Phase 4 D8`; the call site passes `strength === "strong"` | **Superseded** | Take upstream's 3 lines. Delete Loom's `hasStrongNativeRef?` field (trial line 1488) and its silently merged call-site line 8624. Upstream skips the handoff for any native ref, strong or weak, which covers D8. Needs a DL row. | **yes** |
| 3 | 1708 | [1/1c] | `const messageIntake = yield* KeyedLock.make<ThreadId>()` (#24442) | `const loomStore = yield* LoomStoreV2` (sidecar reads) | U | Keep both lines. | no |
| 4 | 7370 | [11/14c] | idle-compaction busy check `if (command.idleCompaction === "beforeCacheExpires" && …)` (#33863) | Loom's sidecar read, `loomStampContinueLaunch`, `loomFields`, and the rule 0 veto `if` (DL-194, DL-195) | U | The two sides are separate `if` blocks that share the following body (`emit thread.metadata-updated; return;`). Write Loom's 6 setup lines and its rule 0 `if` with its own copy of the body, then upstream's idle-compaction `if` with the merged body. Order: Loom's first, so `command` is stamped before any read. | **yes** (body duplication) |
| 5 | 7547 | [20/14c] | `let modelSelection`, `parseGoalCommand`/`goalDriverFor`, `resolveMessageDispatch(projection, command)` (#40316: slash commands queue instead of steering), `steer_active \|\| restart_active` | Loom's `start_if_idle` FYI-tier block (deferral site 1) | **D** | Take upstream's 14 lines. Insert Loom's 12-line `start_if_idle` block (comment plus `if`) after `let dispatchMode = …;` and before upstream's `if (… steer_active \|\| restart_active)`. `resolveMessageDispatch` passes `start_if_idle` through (`CommandPolicy.ts:105`; it only rewrites `steer_active`). | **yes** |
| 6 | 7827 | [1/3c] | `!isSlashCommand(command) &&` (#40316) | the opening `((` of the steered-tier union (DL-1812) | D (with 7) | See hunk 7. | yes |
| 7 | 7838 | [3/1c] | `: noticeKind === "delegated_task" \|\| commandNotice)` (#33268) | `\|\| (command.loom?.origin !== undefined && dispatchMode.type === "queue_after_active"))` (steered tier, DL-1463) | D | Hunks 6 and 7 together become `!freshContext && !isSlashCommand(command) && ((delegatedCompletion !== undefined ? … : noticeKind === "delegated_task" \|\| commandNotice) \|\| (command.loom?.origin !== undefined && dispatchMode.type === "queue_after_active"))`. Loom control notices are `background_task`, never `commandNotice` (`controlMessage.ts:53`). | **yes** |
| 8 | 7860 | [3/2c] | `(!commandNotice \|\| providerThread.goal?.status === "active") &&` (#33268) | `!projection.runs.some((run) => isPromotableLoomQueuedRun(run, projection.messages))` (DL-663) | U | Upstream's line, then the shared `isNativeMaintenanceCommand` line, then Loom's comment and DL-663 clause. | no |
| 9 | 7882 | [15/8c] | `const notification = command.manualContinuationOfRunId === undefined ? command.notification : {…"Resumed thread"}` (#36526) | `loomTurnStartRules({...})` (rules 1 to 5) | U | Keep both blocks: Loom's first, then upstream's `notification` const. Neither reads the other's output. | no |
| 10 | 8345 | [2/1c] | `...(notification === undefined ? {} : { notification })` (#36526) | the old `command.notification` spread and `loom: loomFields, // loom: carry site` | U | Take upstream's spread and keep Loom's `loom: loomFields` line. | no |
| 11 | 8778 | [2/1c] | same as 10 | same as 10 | U | Same as 10. | no |
| 12 | 9119 | [1/4c] | `hasNativeTurnBoundary: …` and `sourceRunStatus: sourceRun.status` (#29239) | `sourceRunStatus: sourceRun?.status ?? "completed", // loom: run-less = idle` | D | Take upstream's `hasNativeTurnBoundary` (3 lines) and keep **Loom's** `sourceRunStatus` line. Trap: Loom's silently merged guard (`pendingForkTransfer === undefined \|\| sideChatWithoutSource \|\| sourceProviderThread === undefined`, trial 9103) lets `sourceRun` be null here, while upstream's guard excluded null. Upstream's `sourceRun.status` would not typecheck. `sourceProviderTurnId` is in scope (trial 9018). | **yes** |
| 13 | 9607 | [2/1c] | same as 10 | same as 10 | U | Same as 10. All three carry sites sit inside `dispatchMessage` (from trial line 7196), where both `notification` (7899) and `loomFields` (7377) are in scope. | no |

#### `apps/server/src/orchestration-v2/ThreadSettlementService.ts` (5 markers)

Loom's side is Loom's settlement view: `loomSettleBlockers` (awaiting its orchestrator, or an unfinished sub-thread, blocks settling) and #527 (`71c25058b9`; a finished root settles at its outcome time once its PR is known not to be open). Loom's 9 non-conflicted lines (240, 244 to 249, 387, 463, 514, 604) merged silently into code whose meaning did not change.

| # | Shape | Upstream side (PR) | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [2/1c] | `QUIET_AFTER_MS, QUIET_SYNC_INTERVAL_MS` import (#34953) | `LoomStore` and `loomSettleBlockers` imports | U | All three imports. | no |
| 2 | [16/1c] | `const activityAtMs = threadActivityAtMs(thread);` (#36371; same formula as Loom's inline copy) | #527's 9-line `loomFinishedRootAt` early return, plus the old inline activity formula | D | Keep Loom's #527 block, then upstream's one-line `threadActivityAtMs(thread)`. Drop Loom's copy of the old inline formula. | yes |
| 3 | [9/4c] | candidates gain `(automaticSettlementEnabled \|\| thread.lineage.relationshipToParent === "subagent") &&` (#19665) | `loomSettlement = yield* loomSettleBlockers(...)` and the `blocker == null` filter | U | `loomSettlement` as Loom wrote it, then `candidates = threads.filter(t => (automaticSettlementEnabled \|\| subagent) && isAutoSettlementCandidate(t, nowMs) && loomSettlement.get(t.id)?.blocker == null)`. Consequence: #527's settlement of finished roots now also needs auto-settle configured. The cockpit has `sidebarAutoSettleAfterDays: 5`, so nothing changes there. | **yes** |
| 4 | [4/14c] | `settleThread` gains the subagent fast path (#19665 plus #39835 `hasActiveSubprocess`) | `settleThread`'s `pullRequest: … \| undefined` signature (lookup pending) | D | Loom's 4-line signature, then upstream's 12-line subagent body unchanged. | yes |
| 5 | [1/1c] | `if (thread.lineage.relationshipToParent === "subagent") return settleThread(thread, null);` (#19665) | `const pending = awaitsLookup(thread) ? undefined : null; // loom:` | U | Upstream's line first, then Loom's. | no |

**#38926 against #527.** Upstream's rule applies to any thread whose agent called `watch_pull_request` with `until: "merged"`. It puts that thread in **Working** (pending background work, `awaited: true`) until the PR merges or closes. A watched thread was already never a settlement candidate. Loom's #527 applies to every finished Loom **root** with an open linked or branch PR, whether or not anything watches it. It keeps the root unsettled; it does not mark it working. So the two rules cover different threads under different conditions, and neither supersedes the other. Together, a root that watches `until: "merged"` shows as Working until the merge, and a finished root with an unwatched open PR stays in active work, not Working.

#### `apps/server/src/orchestration-v2/ThreadSettlementService.test.ts` (1 marker)

[1/1c]: upstream adds `readonly projections?: ProjectionStore.ProjectionStoreV2Shape` to the test options (#19665); Loom adds `loomWorkstreams?`. Rule T plus U: keep both fields. Loom's cases (trial lines 877 and 1472 onward) are about roots, and #19665's clause does not touch them. Gate 1: no.

#### Other files

| File | Shape | Upstream (PR) | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `runtimeLayer.ts` hunk 1 | [1/1c] | `Layer.merge(IdAllocator.layer, layerWorkspaceFoldersProvided)` (#35925, multi-repository projects) | `LoomStore.layer` for CheckpointService (P3-17) | U | `Layer.mergeAll(IdAllocator.layer, layerWorkspaceFoldersProvided, LoomStore.layer)`, Loom comment kept. | no |
| `runtimeLayer.ts` hunk 2 | [2/1c] | `ProviderInstallationGate.layer` (#31186) | `LoomSessionComposerLive`, `LoomStore.layer` (Gate 2a D1) | U | All three. | no |
| `EffectWorker.ts` | [1/3c] | `linkedSender` spread on the follow-up dispatch (#34721) | `loom` spread (carry on follow-up) | U | Both spreads. | no |
| `RestartContinuation.ts` | [5/4c] | `restartCancelledBackgroundWorkNote(note.work, input.cause)` (#40170, provider runtime exit) | `const text = yield* withStashedSteer(input.threadId, input.sourceRunId,` (DL-690) | U | Upstream's 3-line `noteText`, then Loom's comment and `withStashedSteer(` opening. The rest of the call, including DL-1708's `continuationFailedBeforePrompt` argument, is already merged below. Upstream flipped `restartStopRequested`'s predicate to `relationshipToParent !== "subagent" \|\| … \|\| taskId === undefined → false`. It needs a task id, and Loom children have none, so it is inert for them. | no |
| `ThreadDeletion.ts` | [2/2c] | `// An errored session can still own a reusable live runtime.` / `if (session.status === "stopped") continue;` (#34199) | DL-74 comment: the detached event unbinds every session; the detach effect is only for a live process | **D, and the trap is outside the marker** | Keep Loom's comment (the event for every session) and drop upstream's early `continue`. Then **edit the silently merged Loom line ~202** from `if (session.status === "stopped" \|\| session.status === "error") continue; // loom: DL-74` to `if (session.status === "stopped") continue; // loom: DL-74`, so errored sessions get upstream's detach effect. Keeping that line as merged undoes #34199. | **yes** |
| `ThreadDeletion.test.ts` | [1/1c] | expects `["stopped"]` left bound | expects `[]` (DL-74) | T | Keep Loom's `[]`. The effects assertion below (running and error detached) is upstream's and matches the resolution above. | no |
| `http.ts` | [2/1c] | `projectIdentities: projectIdentitiesDigest(projects)` (#35071) | `...(yield* loomSnapshotGoals(snapshot))` (seam 15) | U | `{ ...snapshot, projects, projectIdentities: projectIdentitiesDigest(projects), ...(yield* loomSnapshotGoals(snapshot)) }`, Loom comment kept. | no |
| `legacy/LegacyV1ThreadImporter.ts` | [1/3c] | `messageEvents(message, importedAt)` (#30823, malformed V1 timestamps) | `batch.flatMap((entry) => entry.events())` (T3 consult interleave, DL-610) | D, **trap outside the marker** | Keep Loom's `entry.events()` line. **Edit the silently merged line 787** `events: () => messageEvents(message),` to `messageEvents(message, importedAt)`; `importedAt` is in scope (line 743). Line 637 already reads `messageEvents(message, now)`. The other 16 `loom` lines merged cleanly. | **yes** |

### Silently merged files Gate 2 reads in this zone

- **`apps/server/src/orchestration-v2/ProjectionStore.ts` `getSettlementCandidates`** (conflicted file, owned by store-shell; this region merged silently). It carries #19665's new clause:

  ```
  AND (relationshipToParent IS NOT 'subagent' OR NOT EXISTS (SELECT 1 FROM … parent WHERE parent.thread_id = $.lineage.parentThreadId AND parent.deleted_at IS NULL AND parent.archivedAt IS NULL AND parent.settledOverride IS NOT 'settled'))
  ```

  This is the one new query in range that selects Loom children and acts on them (D2). It sits beside Loom's `loom.blocking` line. Gate 2 should read it together with `ThreadSettlementService.ts` hunks 3 to 5.
- **`Orchestrator.ts` trial line 8624** (`hasStrongNativeRef:` at the call site) is deleted with hunk 2. **Trial 7282** (Loom's `hasBlockingPendingRequest` in the `manualContinuationOfRunId` guard) is unchanged in meaning. **Trial 4514** (DL-305, a Loom child may watch its PR) is intact, but see the next item.
- **`apps/server/src/pullRequest/PullRequestWatchService.ts:120`** (new upstream file, #33389/#38926) holds `if (watching && thread.lineage.relationshipToParent === "subagent") return yield* new PullRequestWatchFromSubagentError();` with no Loom exemption. Loom's DL-471 line `thread.workstream === undefined` sits in the conflicted `mcp/toolkits/pullRequests/handlers.ts` hunk (trial 348 to 354, owned by mcp-tools), in code upstream replaced with `watches.setWatching(...)`. **Re-home it to `PullRequestWatchService.ts:120`** as `&& thread.workstream === undefined // loom: DL-471`. `engine.getThreadShell` there returns the Loom-joined shell (`joinLoomThreadShell`, trial `Orchestrator.ts:17554`), so `workstream` is available. Lost silently, a Loom shipper child can no longer watch its own PR.
- `ThreadDeletion.ts` line ~202 and `LegacyV1ThreadImporter.ts:787`: see §3.
- `runtimeLayer.test.ts` (5 `loom` lines, upstream +7,666/−2,302): Loom's five "one active project per root (1018)" adjustments survive. Upstream's new tests add 15 more `seedProject` calls (34 in trial, 19 at HEAD). Any that seed two active projects at one root fail under Loom migration 1018 (DL-176). Integration work.
- `ThreadManagementService.ts`, `ProviderTurnControlService.ts`, `ProviderEventIngestor.ts`, `AgentAwarenessRelay.ts`: 1 to 3 Loom lines each, all still in functions that do what they assume (spawn hydrates the parent; `loom` carry on steer; tool-image store; Loom events skip awareness). No action.
- `ProjectionMaintenance.ts`, `OrchestrationEventStore.ts` and `ThreadSearch.loom.ts`: neither side changed the first two since the base, and they hold no `loom` lines at HEAD. Pull 15's guard clauses are no longer in `ProjectionMaintenance.ts`. `ThreadSearch.loom.ts` is Loom-only and untouched; its callers in `ThreadSearch.ts` are conflicted and belong to another owner. Nothing to check here.

### Left for the integration tracks (S2)

- Typecheck will flag: `sourceRun.status` if hunk 12 takes upstream's side; `messageEvents(message)` arity at `LegacyV1ThreadImporter.ts:787`; the leftover `hasStrongNativeRef` field or argument if only one of the two is removed.
- Tests: `ThreadDeletion.test.ts` (resolution above); `ThreadSettlementService.test.ts` harness union; `runtimeLayer.test.ts` new `seedProject` calls against migration 1018 (count with the command in §9); `Orchestrator` dispatch tests for `start_if_idle` against #40316's `resolveMessageDispatch`.
- Lint: hunk 1 may trip duplicate-import rules if left as two `@t3tools/contracts` lines.
- Live check for D1 (web): open a parent, click a Loom child in thread details. It should open as a right-panel tab with a composer; ⌘-click should navigate.
