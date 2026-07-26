# 21 — Cadence pull: v0.0.29-nightly.20260719.845 → v0.0.29-nightly.20260725.899

The largest pull yet, and the first with a **migration numbering collision**.
**120 upstream commits, 432 files, 53 conflicted files** on the trial merge.
Headline collisions: a migration re-home (upstream's Sidebar-v2 settled/snoozed
columns land on numbers loom already occupies), Sidebar v2 (a new flat thread
list with a server-backed settled/snoozed lifecycle), and upstream's
`db4b2d8a0` rework of the very shell catch-up seam loom's PR #115 owns. Nine
marker-less semantic breaks only the typecheck/tests caught. Australian English.

## Headline

- **Window:** `53e3c98a5` (v0.0.29-nightly.20260719.845, the previous
  merge-base) → `upstream/main` `5719e8ac4` (v0.0.29-nightly.20260725.899).
  **120 commits, 432 files, 53 conflicted files.**
- Merge commit **`f795ab6a8`**; `HEAD^1 == bc6bbf570` (loom `origin/main`),
  `HEAD^2 == 5719e8ac4` (upstream). No rebase, no squash — upstream is the
  second parent; all conflict resolutions and semantic fixes are in the merge
  commit. This sync note is a **separate docs commit** on top so it can cite the
  final merge hash.
- All three gates green: `vp run typecheck` **0 errors** (15 projects, only
  pre-existing `suggestion` advisories), `pnpm build` **exit 0**, `vp check`
  **0 errors** (23 pre-existing warnings). Targeted suites across every
  conflicted surface pass. **DB-copy migration smoke passed** (see below).
- **9 marker-less semantic merge issues** git could not flag — all surfaced by
  `tsgo` + the conflicted-area tests, each fixed by mirroring loom's canonical
  shape (listed at the end).

## A. ⚠️ Migration numbering collision — resolved by re-homing to 065/066

Upstream added `Migrations/033_ProjectionThreadsSettled.ts` +
`034_ProjectionThreadsSnoozed.ts` (Sidebar v2's settled/snoozed lifecycle
columns on `projection_threads`). **Loom's migration chain already occupies
033–064** (loom's 033 is `ProjectionThreadsGoalSlug`; the chain diverged at 033
and ends at `064_ProjectionThreadPeerMessages`). The cockpit DB migrates in
place, one-way, by NUMBER, so upstream's two files were **re-homed as loom
`065_ProjectionThreadsSettled` + `066_ProjectionThreadsSnoozed`**, registered at
those positions in `Migrations.ts`.

- **Safe to re-home:** both migrations are self-contained, idempotent
  column-adds (`PRAGMA table_info` guard + `ALTER TABLE projection_threads ADD
COLUMN`). They carry **no internal numbering references** and **no ordering
  dependency** on upstream's own 030–032 (they only touch `projection_threads`,
  which exists well before loom's divergence). No code anywhere reads the
  settled/snoozed columns by migration number — the projections
  (`ProjectionThreads.ts`, `ProjectionSnapshotQuery.ts`) read them by column
  name.
- **Proof — DB-copy smoke (the critical gate this cycle):** the built
  `bin.mjs` ran on port 13969 against a _copy_ of the live cockpit
  `state.sqlite` (1.5 GB, ledger at migration 64 before the run) under a
  sandboxed temp `--base-dir`. It logged **"Migrations ran successfully"** with
  exactly `migrations: [ '65_ProjectionThreadsSettled',
'66_ProjectionThreadsSnoozed' ]`. The migrated ledger then lists **65 once and
  66 once** (`MAX(migration_id)=66`, `COUNT(*)=66`, contiguous 1–66), and all
  four columns (`settled_override`, `settled_at`, `snoozed_until`, `snoozed_at`)
  exist on `projection_threads`. `GET /` → **200**; all workstream services
  started (`provider.session.reaper`, `workstream.liveness` — which swept real
  threads and raised `brief-needed`, `exhaustion.resume`, subscription-usage
  poller). No errors/crashes. Process killed, DB copy removed, port confirmed
  free; the live cockpit DB was never touched.

## B. Sidebar v2 (#4026 + follow-ups) — kept loom's sidebar; adopted compatible micro-refactors

Upstream's Sidebar v2 is a flat thread list with a server-backed
settled/snoozed lifecycle, and it **extracted the sidebar chrome** (header/
footer/brand/stage badge) into `./sidebar/SidebarChrome.tsx`. Loom's sidebar is
a different product surface: workstream graph rollups, per-goal thread lists
(`SidebarGoalThreadList`, `useLoomSidebarGoals`), goal CRUD context menus, goal
session creation, and its own chrome carrying loom's account-usage/update pills.

**Resolution — kept loom's sidebar as the base (the brief's explicitly
permitted defensible fallback); adopted upstream's compatible micro-refactors.**
The Sidebar-v2 flat-list rendering was NOT adopted where it collided with loom's
goal-grouped list; loom's inline `SidebarChromeHeader`/`SidebarChromeFooter`
(with `SidebarAccountUsagePill` + `SidebarUpdatePill`) were kept over upstream's
extracted module. Adopted the pure refactors that don't fight loom's model:
upstream's `resolveThreadPr({ threadBranch, gitStatus, hasDedicatedWorktree })`
object signature. `Sidebar.logic.ts` kept loom's `resolveSidebarNewThreadEnvMode`
/ `resolveSidebarNewThreadSeedContext` / the `SidebarNewThreadEnvMode` type.

Because upstream's chrome extraction **stripped the imports** the inline chrome
still needs, the merge left `cn`, `Link`, `SidebarHeader`/`Footer`/`Trigger`,
`SidebarStageBackdrop`, `SidebarProviderUpdatePill`, `APP_STAGE_LABEL`,
`primaryServerConfigAtom`, `resolveSidebarStageBadgeLabel`, `SettingsIcon`, and
the `serverConfigs = useServerConfigs()` binding undefined — all re-added
(marker-less trap #1, caught by tsgo).

**Sidebar v2's own client tests (mobile `threadListV2.test.ts`, web
`Sidebar.logic.test.ts` v2-status block) are kept and pass** — v2 remains
available/typechecking; loom's sidebar is simply the default surface. Open
question for the human: whether to invest in a full Sidebar-v2 re-home (flat
list + settled/snoozed inbox affordances) in a future cycle, or keep loom's
goal/workstream sidebar indefinitely.

## C. `ws.ts` + `db4b2d8a0` catch-up rework — #115 protected; upstream's rework NOT adopted (defensible fallback)

Upstream `db4b2d8a0` ("speed up new-chat propagation and offline catch-up")
reworked the shell catch-up seam that loom's **PR #115 fail-loud silent-drop
fix** owns. Upstream's rework rests on three pillars incompatible with #115:

1. a **swallowing** `retryShellProjectionRead` helper (`Effect.orElseSucceed(()
=> Option.none())`) feeding new `projectUpsertOrRemove`/`threadUpsertOrRemove`
   helpers — the exact `Option.none()` re-collapse #115 removed, which makes a
   _failed_ lookup indistinguishable from a genuinely-absent row and silently
   drops it from catch-up;
2. a different **live source** (`streamDomainEvents` forked into a value queue)
   vs loom's **eager** `subscribeDomainEvents` attach, whose whole purpose is to
   close the connect-gap before the cursor read;
3. a different **catch-up bound** (`latestSequence` + `SHELL_RESUME_MAX_GAP`)
   vs loom's `getSnapshotSequence` + `SHELL_CATCHUP_MAX_EVENTS` + exact-interval
   `readEvents`.

**Resolution — kept loom's `subscribeShell`/`subscribeThread` verbatim and did
NOT adopt upstream's rework** (per the brief's "defensible fallback"). All of
#115's non-negotiable survivors are trivially preserved because loom's exact
code is retained: the fallible `toShellStreamEvent` (no `orElseSucceed`
re-collapse), `shellLookupRetry`, eager `subscribeDomainEvents` attach before
the cursor read, `SHELL_CATCHUP_MAX_EVENTS` bound + client-ahead
(`afterSequence > snapshotSequence`) snapshot fallback, and exact-interval
`readEvents(afterSequence, gap)`. The #4079 `subscribeThread` reasoning re-home
(note 20) is likewise intact.

- I initially built the doctrine-ideal synthesis (adopt upstream's coalescing +
  completion-marker _made fail-loud_ by keeping loom's fallible mapper). It
  typechecks, but its coalescing `groupedWithin(50ms)` window and its live
  source both break loom's #115 test suite (which drives events through
  `subscribeDomainEvents` on a `TestClock` with no window flush), and upstream's
  own tests assume the swallowing helpers. The two test suites are tied to their
  respective impls, so the synthesis could not satisfy both. Given cluster C's
  primary mandate is protecting #115, I reverted to loom's proven seam.
- Consequently the swallowing helpers, the coalescing functions
  (`coalesceShellEvents/Stream/LiveStream/LiveInputs`, `ShellLiveInput`), and
  `SHELL_RESUME_MAX_GAP` were **deleted as unused**. The client `shell.ts` and
  `shell-sync.test.ts` were kept as loom's (`--ours`) to stay a matched pair;
  loom's reducer gained a one-line `synchronized`-variant skip so it stays total
  over the contract union that now carries upstream's completion marker
  (dormant — loom's client never requests it).
- **Three upstream `requestCompletionMarker` tests that auto-merged into
  `server.test.ts`** (marks-synchronized ×2, buffers-fallback-snapshot) were
  removed — they assert the completion-marker/coalescing behaviour loom's seam
  does not implement (marker-less trap; loom's HEAD had zero
  `requestCompletionMarker`). `server.test.ts` now carries loom's full #115 +
  #4079 suite and passes (see tests).
- **Follow-up for the human:** the `perf` value of `db4b2d8a0` (per-aggregate
  burst coalescing) is deferred, not lost — a future cycle can re-home
  coalescing onto loom's fail-loud fallible mapper with a matching test rewrite.

## D. Convergent feature — worktrees-from-origin (`62cf46175`)

Upstream's "worktrees from origin main" overlaps loom's own per-project
`default_start_from_origin` (migration 063) + `resolveNewDraftStartFromOrigin`.
Inspection showed upstream did **not** add its own per-project column — its
change is a settings-driven default flip plus the Claude-1M/gpt-5.6 model
defaults. So the two coexist coherently: **loom's per-project
`projectDefaultStartFromOrigin` survives** (the merged `resolveNewDraftStartFromOrigin`
still takes it; `composerDraftStore` retains the field), unioned with upstream's
`newWorktreesStartFromOrigin` source. Loom's data on prod is untouched — no
column retired.

**Model defaults:** adopted upstream's `DEFAULT_MODEL = "gpt-5.6-sol"`,
`PREFERRED_DEFAULT_CODEX_MODELS`, `DEFAULT_GIT_TEXT_GENERATION_MODEL =
"gpt-5.6-luna"`, and the `AppModelOption.isDefault` field, while **keeping loom's
`PI_DEFAULT_MODEL = "google-vertex-claude/claude-opus-4-8"`** and thinking-level
options. Loom's pi-default selection logic wins everywhere it matters:
`CommandPalette`, `projects.ts`, `ChatView` local-draft fallback, and
`modelSelection.ts` (loom's `!excluded` default-slug step runs before upstream's
`isDefault` step). `useHandleNewThread` kept loom's **seed-not-override** draft
semantics (loom's documented UI-state principle) rather than upstream's
reset-stale-context-on-resurrect, plus loom's goalId re-home; upstream's
`primaryServerSettings` source was adopted where the hook had already converged
on it (loom's per-env `environmentSettings` binding was retired there, a minor
simplification consistent with the merged body).

## E. Orchestration core — union, loom capability preserved

- **`decider.ts` (6 hunks):** unioned loom's fork/title/review-gate helpers with
  upstream's settled-lifecycle helpers (`QUEUED_TURN_START_GRACE_MS`,
  `threadHasQueuedTurnStart`, `hasOpenBlockingRequest`, …). The turn-start case
  now emits **both** upstream's `lifecycleResetEvents` (`thread.unsettled` on a
  settled override, `thread.unsnoozed` on a snooze) **and** loom's
  `trailingEvents` (attention-cleared, atomic `in_progress` kickoff for
  `ready`/`yielded`/reopen, reopen-observability warning), returning
  `[...lifecycleResetEvents, userMessageEvent, turnStartRequestedEvent,
...trailingEvents]`. Loom's exported `withEventBase` survives.
- **`ProviderCommandReactor.ts`:** loom's fork idle-gate (`shouldRefuseForkLaunch`
  - D2 deterministic refusal) kept, then upstream's `pendingTurnStart` "starting"
    session-set appended. Both new session literals gained loom's required
    `queuedMessages` field (marker-less trap #2).
- **`ProviderRuntimeIngestion.ts`:** upstream's task-title enrichment
  (`rememberTaskDescription`/`lookupTaskDescription`/`findTaskTitleInActivities`,
  `runtimeEventToActivities(event, taskTitle)`, now `export`ed) unioned with
  loom's `session.exited` interrupted-activities + `shouldPersistActivity`
  de-dupe filter and loom's `toolLifecycleActivityId` helper.
- **`ProjectionSnapshotQuery.ts` (both shell + detail literals):** the classic
  trap — upstream's thread literals carry the new settled/snoozed fields but
  **drop every loom workstream field**. Resolved by keeping loom's full literal
  (goalId, blockedBy, graphKey, gate/fanin/notify fields, goals-in-snapshot, …)
  and inserting upstream's four settled/snoozed fields; loom's early
  `Option.isNone(threadRow)` guard restored over upstream's tangled variant.
- **`OrchestrationEngine` Services + Layers:** unioned loom's
  `subscribeDomainEvents` (eager connect-gap subscription) with upstream's
  `latestSequence`. Every mock across the server tests (`AgentAwarenessRelay`,
  `serverRuntimeStartup`, `WorkstreamDispatcher` ×18, `server.test`) gained
  `latestSequence` (marker-less trap #3).
- **`server.ts`/`bin.ts`:** unioned loom's `LoomMcpHttpLive` merge + `goalCommand`
  with upstream's `ServerSelfUpdate.layer` + `serviceCommand`.
- **`AgentAwarenessRelay`, `ClaudeAdapter` (`resolveClaudeSdkExecutablePath` +
  loom `hostPlatform`), `CodexSessionRuntime` (loom PATH-prepend + upstream
  `codexSessionAppServerArgs`):** clean unions.

## F. Web-shell rest — unions with loom affordances preserved

- **`ChatView.tsx` (7 hunks):** kept loom's `useRerouteToasts`,
  `useThreadSyncError` trio, `ThreadHydratingState`, handoff/retro helpers, pi
  local-draft default, and per-project start-from-origin; adopted upstream's
  `commandPaletteBus` rename, `resolveLocalCheckoutBranchMismatch`, the
  `getProviderStatusBannerKey`/`shouldShowProviderStatusBanner` banner helpers,
  and the version-mismatch dismiss dep. `ChatView.logic.ts` unioned loom's
  `/handoff`+`/retro` decision helpers with upstream's
  `resolveThreadMetadataUpdateForNextTurn`.
- **`MessagesTimeline.tsx` (4 hunks):** kept loom's origin-label user bubble
  (spawn-card tint) and its `useTimelineAvailableWidthVar` measurement hook —
  folding upstream's minimap hit-strip-width measurement into loom's callback;
  folded upstream's top-fade (`chat-timeline-scroll-fade` + fade header) into
  loom's pagination `listHeader`.
- **`DiffPanel.tsx` (3 hunks):** adopted upstream's `bg-foreground/[0.08]`
  selection-highlight styling consistently (mapped upstream's `selectedTurnId`
  onto loom's `selectedRouteTurnId`); did NOT resurrect the working-tree diff
  `/api/vcs/diff` loom dropped.
- **`ModelPickerContent.tsx`:** kept loom's `SearchableModelList` refactor over
  upstream's inline `TooltipProvider` layout (the shared JSX tail is loom's).
- **`chatThreadActions.ts`:** adopted upstream's no-context-carry direction
  (its dead `buildContextualThreadOptions`/`startNewThreadInProjectFromContext`
  had no callers and its principle matches loom's seed-not-override); kept loom's
  per-project `resolveNewDraftStartFromOrigin` and re-added its test coverage.
- **`FilePreviewPanel.tsx` + `projectFilesQueryState.ts`:** the two 4th-arg
  signature changes (loom `maxBytes`, upstream `enabled`) unioned into
  `useProjectFileQuery(env, cwd, relativePath, maxBytes?, enabled = true)`;
  `useT3ProjectFileScripts` (upstream's positional `enabled` caller) updated to
  the new arg order (marker-less trap #4).
- **`_chat.$environmentId.$threadId.tsx`:** upstream's `renderState` refactor
  auto-merged over loom's `routeThreadExists` definition, leaving it undefined
  though still referenced — restored (marker-less trap #5).
- **`routeTree.gen.ts`:** GENERATED — resolved by regenerating via the build
  (the tanstack router vite plugin), which re-added loom's `/usage`,
  `/settings/worktrees`, `/preview` routes that upstream's `--theirs` lacked.
- **`SettingsPanels`, `GitActionsControl`, `CommandPalette`, `index.css`,
  `docs/README.md`, `AGENTS.md`, contracts ×3:** unions; loom's ship rules,
  workstream/goal contracts, and MDX-plan CSS survive. `GitActionsControl` — the
  early-return guard trap below.

## Marker-less semantic merge issues (caught by tsgo + tests)

1. **`Sidebar.tsx`** — upstream's chrome extraction stripped ~11 imports +
   `serverConfigs` that loom's retained inline chrome / seed logic still use;
   re-added.
2. **`ProviderCommandReactor.ts`** — upstream's `setThreadSession` literals + the
   respond-failed fallback lacked loom's required `session.queuedMessages`; added.
3. **`OrchestrationEngineShape.latestSequence`** — every server-test mock engine
   (incl. `WorkstreamDispatcher.test` ×18) had to gain `latestSequence`.
4. **`projectFilesQueryState` arg order** — unioning `maxBytes`+`enabled`
   re-ordered the positional args; `useT3ProjectFileScripts` updated.
5. **`_chat.$…$….tsx`** — `routeThreadExists` definition lost to upstream's
   `renderState` rewrite; restored.
6. **`GitActionsControl.tsx`** — upstream added `|| activeServerThread` to the
   branch-sync early-return, which narrowed loom's later `if (activeServerThread)`
   worktree guard to `never` (dead code + `worktreePath` on `never`). Reverted to
   loom's early-return so loom's nuanced server-thread branch-sync survives.
7. **Thread-shell / read-model / session fixtures across new upstream test files**
   (`threadSettled`/`threadSnoozed`/`decider.settled`/`decider.snoozed`/
   `threadListV2`/`HandoffDrafterReactor`/`shell-sync` `STUB_THREAD`/
   `ProjectionRepositories`/`ProjectionSnapshotQuery`/`ProjectionPipeline`) —
   upstream literals missing loom's workstream fields / `queuedMessages` /
   `goals`, or loom fixtures missing upstream's settled/snoozed. Each filled to
   the merged contract shape.
8. **`ChatComposer.tsx`** — `connectionStatusText` import kept unused after
   upstream rewrote the placeholder that consumed it; dropped.
9. **`ChatView.tsx`** — `NO_PROVIDER_MODEL_SELECTION` import orphaned after
   keeping loom's pi default; dropped.
10. **`decider.settled.test` fixture `planLane`** — loom's atomic-kickoff
    promotes a `ready` thread to `in_progress` on turn-start, adding a
    `thread.plan-lane-set` upstream's settled test did not expect; set the fixture
    to `in_progress` (its natural state when receiving activity).

## Lockfile + install

`git checkout --theirs pnpm-lock.yaml`, then installed under pnpm **11.10.0**
(corepack), Node **22.23.1** (≥22.16 satisfied; the repo's `engines` now wants
`^24.13.1` — a non-fatal warning, 22.23.1 is the version available under `~/.n`).
Same flow as #18–#20: `--frozen-lockfile` aborted on the expected
`patchedDependencies` config-vs-lockfile mismatch; one `CI=true pnpm install
--no-frozen-lockfile` reconciled loom's patches (the Effect LSP `prepare` patch
ran clean); the following `--frozen-lockfile` install is a no-op (idempotent).

## Gates

- **`vp run typecheck`**: **0 errors** across 15 projects; only pre-existing
  `suggestion` advisories (`WorkstreamFanInReactor`, `decider.ts` fail-yieldable
  hints, a few desktop/test effect-idiom hints).
- **`pnpm build`**: **exit 0** (all targets; routeTree regenerated).
- **`vp check`**: **0 errors**, 23 pre-existing warnings (`react/no-array-index-key`,
  `no-unstable-nested-components`, `no-unsafe-optional-chaining` in tests, a
  `postMessage` origin hint) — none in the resolution surface; `--fix` reflowed
  two files I edited.

## Targeted tests (every resolved surface)

| Suite                                                           | Result     |
| --------------------------------------------------------------- | ---------- |
| `server.test.ts` (ws.ts #115 + #4079 subscribeThread)           | pass       |
| `ProviderRuntimeIngestion.test.ts` (task-title + interrupts)    | pass       |
| `ProviderCommandReactor.test.ts` (fork gate + pendingTurnStart) | pass       |
| `decider.settled.test.ts` / `decider.snoozed.test.ts`           | 21 passed  |
| `ProjectionSnapshotQuery.test.ts` / `ProjectionRepositories`    | pass       |
| `WorkstreamDispatcher.test.ts` / `OrchestrationEngine.test.ts`  | pass       |
| `ProjectionPipeline.test.ts` / `HandoffDrafterReactor.test.ts`  | pass       |
| `serverRuntimeStartup.test.ts` / `AgentAwarenessRelay.test.ts`  | pass       |
| server surfaces batch                                           | 427 passed |
| `shell-sync` / `projects` / `threadSettled` / `threadSnoozed`   | 210 passed |
| `Sidebar.logic` / `ChatView.logic` / `chatThreadActions`        | pass       |
| `MessagesTimeline.test.tsx`                                     | 22 passed  |

## DB-copy migration smoke (the critical gate)

Built `bin.mjs` on port **13969** against a _copy_ of the live cockpit
`state.sqlite` (1.5 GB, ledger at 64) under a sandboxed temp `--base-dir`; the
live cockpit was never touched. **"Migrations ran successfully"** with exactly
`[ '65_ProjectionThreadsSettled', '66_ProjectionThreadsSnoozed' ]`; the migrated
ledger lists **65 once, 66 once** (contiguous 1–66), all four settled/snoozed
columns present. `GET /` → **200**; all workstream services up
(`workstream.liveness` swept real threads). No errors; process killed, copy
removed, port confirmed free.

## Intentional prior drops — NOT "fixed" here

DiffPanel working-tree diff (`/api/vcs/diff`), `pinnedCollapsedThread`, Pi-only
driver registry, deferred read-only Goals/tasks UI, the retired index goal
overview (hero index kept). Left untouched.

## Merge topology

`git merge --no-edit upstream/main` → normal two-parent merge commit
**`f795ab6a8`**; `HEAD^1 == bc6bbf570` (loom), `HEAD^2 == 5719e8ac4` (upstream).
No rebase, no squash, no amend. Once this lands on `loom/main` the merge-base
advances to `5719e8ac4`, keeping the next pull cheap. This sync note is the
separate docs commit on top.
