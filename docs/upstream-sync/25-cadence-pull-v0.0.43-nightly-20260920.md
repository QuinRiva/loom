# 25 — Cadence pull 7 (v0.0.34-nightly.20260819.1132 → v0.0.43-nightly.20260920.2005+3)

**Status: MERGE IN PROGRESS — banked, NOT committed.** After session 2, 227 of
230 conflicted files are resolved and staged; **3 files still carry conflict
markers** (`apps/web/src/components/Sidebar.tsx`,
`apps/web/src/components/files/FilePreviewPanel.tsx`,
`apps/web/src/rightPanelStore.ts`), so the merge commit cannot be created yet.
Nothing has been pushed. Australian English.

> Read §"Session 2" at the end of this note first — it supersedes the
> §"What remains" list below, which is the session-1 state record.

A full esbuild parse sweep over all 4,125 tracked `.ts`/`.tsx` files reports
**zero parse damage** in the resolved set — the doc-24 union-damage failure mode
is clear as of this bank.

This note is the session-1 state record. The next coder picks up from
§"What remains" — the in-progress merge lives in the shared worktree
`/home/Carl/.t3/cockpit/worktrees/loom/t3code-ea251a06`.

## Topology (to be verified at commit time)

- Branch `t3code/upstream-sync-20260921`, cut from `origin/main` `5c350f7a63`.
- `MERGE_HEAD` = `c14f6015bf` (upstream tip, v0.0.43-nightly.20260920.2005+3).
- Merge-base `36f4314ab`. 1551 upstream commits, loom ahead 782.
- No rebase, no squash. **Every commit on this branch must use `--no-verify`**
  (the pre-commit hook deletes `MERGE_HEAD` and would single-parent the merge),
  and `git rev-parse <merge>^2` must equal `c14f6015bf` after any commit.
- Recovery bundle: `.artifacts/pull7-merge-state-backup/` holds a copy of the
  worktree's git `index` (all three conflict stages), `MERGE_HEAD` and `HEAD`.
  Restoring those two files into `$(git rev-parse --git-dir)` reconstitutes the
  in-progress merge exactly, including `git checkout --ours/--theirs/-m`.

## What is done

### Install and lockfile — green

`pnpm-lock.yaml` was regenerated from upstream's (not hand-merged);
`pnpm-workspace.yaml` unions loom's `@earendil-works/*` 0.86.0 pins and the
`astro>esbuild` 0.28.2 override with upstream's expo 57 / electron / alchemy
entries. `patchedDependencies` takes upstream's renamed patches
(`@clerk/expo@4.6.8`, `@effect/vitest@4.0.0-rc.115`, `@expo/metro-config@57.0.12`)
and keeps loom's `@earendil-works/pi-coding-agent@0.86.0` patch. `pnpm install`
completes cleanly on pnpm 11.10.0 / Node 22.23.1 — **node 24 is not required**
despite upstream's `engines` bump, same as pull 6.

`@effect/platform-bun` was dropped from `apps/server/package.json`: it was a
`catalog:` reference to an entry only loom's workspace file carried, and nothing
in the tree imports it.

### Root `package.json` — loom's scripts survived, two are correctly gone

`ship`, `cockpit`, `cockpit:build`, `dev:seed`, `dev:seed:verify` all present;
upstream's `knip*`, `licenses:sync`, `icons:export:android`,
`dist:gnome-extension` adopted. **`build:contracts` and `connect:announce-ga`
were dropped deliberately** — packages no longer carry `build` scripts and
`scripts/announce-connect-ga.ts` no longer exists upstream, so both were dead.
`prepare` takes upstream's (loom's `clean-tsgo-backups.mjs` is gone).
`apps/web`'s `typecheck` moves `tsgo` → `tsc`, matching every other package.

### Delete conflicts — all resolved

| file                                                      | resolution                                                                                                                                                                                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/pendingUserInput.ts` (+test)                | stay deleted (human-ruled; loom's non-modal question card replaced it)                                                                                                                                                                                        |
| `chat/ComposerPendingUserInputPanel.tsx` (+test)          | stay deleted                                                                                                                                                                                                                                                  |
| `chat/ComposerPrimaryActions.test.tsx`                    | stay deleted                                                                                                                                                                                                                                                  |
| `packages/shared/src/threadSettled.test.ts`               | loom's kept (single-sourced in `@t3tools/shared`)                                                                                                                                                                                                             |
| `apps/server/src/persistence/NodeSqliteClient.ts` (+test) | **loom's kept.** Upstream moved its client to `packages/shared/src/nodeSqliteClient.ts` (#7272) for the desktop cookie-DB readers; loom's worker-backed split (`NodeSqliteConnection` + `NodeSqliteWorkerClient`) is a different concern and both now coexist |
| `apps/server/src/git/Utils.ts`                            | kept with loom's `directoryExists`; upstream's `isGitRepository` moved into `CheckpointStore`                                                                                                                                                                 |
| `chat/ComposerPendingReviewComments.tsx` (+test)          | **restored** — upstream deleted the component but loom's `ChatComposer` still mounts it                                                                                                                                                                       |
| `docs/internals/scripts.md`                               | upstream retired the doc (#9755); loom's 53-line worktree/`--watch-path` section re-homed to **`docs/internals/worktree-development.md`**                                                                                                                     |

### Notable semantic resolutions

- **`threadSettled` repoint.** Upstream grew `client-runtime/state/thread-settled`
  in place; loom single-sources it at `@t3tools/shared/threadSettled` (pull-6
  ruling). All **14** importers were repointed. `packages/shared/src/threadSettled.ts`
  keeps loom's side wholesale; one duplicate `DAY_MS` from upstream's clean hunk
  was removed.
- **Route-view consolidation (real re-home).** Upstream moved both thread routes'
  views into a new `apps/web/src/components/ThreadRouteView.tsx` rendered by the
  `_chat` layout, so `_chat.$environmentId.$threadId.tsx` and
  `_chat.draft.$draftId.tsx` are now `component: () => null`. **Loom's centre-panel
  thread tabs were re-homed into `ThreadRouteView`**: `useThreadTabsSync` (seeded
  from the server target only) and `<ThreadTabsStrip activeRouteRef={…} />` inside
  the `SidebarInset`. `useThreadTabKeyboard` survived untouched in `_chat.tsx`
  (the pull-6 review-round-1 finding did not recur). `_chat.index.tsx` keeps its
  own strip mount.
- **`McpSessionRegistry`** (brief rule 8): upstream now derives issued
  capabilities from `request.capabilities` plus a constant `"pull-requests"`.
  Loom's invariant is preserved by adding `"workstream"` **unconditionally** to
  that set rather than by keeping the old literal. `McpCapability` is now
  `"preview" | "workstream" | "device" | "pull-requests"`.
  **`McpSessionRegistry.test.ts` asserts the old exact set and must be updated**
  to `new Set(["pull-requests", "workstream", "preview"])` — it is a fork test
  and the invariant it guards (workstream always issued) still holds.
- **`previewAutomation.ts`**: upstream split the capability errors into
  `PreviewAutomationUnavailableError` (preview-only literal) and a new generic
  `McpCapabilityUnavailableError`. Loom's widened literal was retired in favour
  of upstream's generic error; **loom's `"workstream"` denial sites must be
  repointed to `McpCapabilityUnavailableError`** (typecheck will find them).
- **`EnvironmentApi`** in `packages/contracts/src/ipc.ts` was defined and never
  consumed; upstream deleted it and the deletion was adopted.
- **`isLegacyCodexModel`** (`CodexProvider.ts` + its test): upstream retired the
  whole `isLegacy` concept and loom had merely inherited it — deletion adopted.
- **`http.ts`**: upstream replaced the asset response with range-capable
  `assetFileResponse` plus a `github-media` branch. Loom's mutable-asset
  revalidation was re-homed onto it as an `Effect.map(setHeader("Cache-Control", …))`.
- **`AcpSessionRuntime.ts`**: loom's worktree-local `node_modules/.bin` PATH
  prepend re-applied onto upstream's new `extendEnv` spawn shape.
- **`builtInDrivers.ts`**: loom's Pi-only registry kept (upstream added an
  Antigravity driver; it is not registered). Intentional fork drop.
- **`storage.ts`**: upstream bumped the thread-snapshot cache schema to 4; loom's
  named `THREAD_SNAPSHOT_CACHE_SCHEMA_VERSION` constant now carries that 4.
- **`oxlint-plugin-t3code/rules/no-manual-effect-runtime-in-tests.ts`**: upstream
  replaced the hardcoded `LEGACY_BASELINE` map with a per-file `maxOccurrences`
  lint option. Upstream's mechanism adopted; **loom's baselines have not yet been
  transcribed into the lint config** — expect this rule to fire on loom's test
  files until they are.
- **`keybindings`**: loom's `mod+w → tab.close` kept over upstream's new
  `mod+w → rightPanel.close`. Loom's tab traversal (`mod+alt+…`) kept.
- **`composer-logic.ts`**: `ComposerTriggerKind` unions loom's `"thread"` with
  upstream's `"pull-request"`; `ComposerSlashCommand` keeps loom's
  `handoff`/`retro`; the segment predicates now take upstream's
  `ComposerPromptSegment` (which already carries loom's `thread` variant after a
  clean merge of `composer-editor-mentions.ts`) and the inline-token conditions
  union `thread` with upstream's `citation`/`context-reference`.

### Chat surface — deferred, per brief rule 1

`ChatView.tsx`, `chat/ChatComposer.tsx`, `ChatMarkdown.tsx`,
`chat/MessagesTimeline.tsx` carry **loom's file wholesale** (`git checkout --ours`).
Hunk-wise "ours" was tried first and produced duplicate declarations
(`projectGroupingSettings`, `interactionMode`, `activeContextWindow`) because
upstream's cleanly-merged hunks re-declare what loom's side already declares —
so the pull-6 precedent (take the file whole) stands. `promptStashStore.ts`,
`ComposerStashBadge.tsx` and `ComposerStashMenu.tsx` remain present-but-unmounted
in loom's tree.

## Method — tooling rebuilt this session (reuse it)

- **Parse-damage sweep**: `.artifacts/parsesweep.mjs`. Doc 24's
  `ts.createSourceFile` sweep **no longer works** — the repo is on TypeScript 7
  (`@typescript/native-preview`), whose package exports no JS compiler API
  (`ts.createSourceFile` is `undefined`). Rebuilt on **esbuild**
  (`node_modules/.pnpm/esbuild@0.25.12/.../lib/main.js`), which parses TS/TSX and
  reports the first syntax error with a line number. Run it over
  `git ls-files '*.ts' '*.tsx'` after every batch — it found 19 damaged files in
  one pass and is the only cheap detector before typecheck.
- **Hunk tools**: `.artifacts/hunks.sh` (full hunks), `.artifacts/brief.py N f…`
  (truncated hunks — the context-cheap viewer), `.artifacts/hx.py` (replace the
  Nth hunk of a file), `.artifacts/sideresolve.py ours|theirs f…`,
  `.artifacts/union.py f…`.
- **Parser-verified auto-resolver**: `.artifacts/autoresolve.mjs` (unprotected
  files, tries union → ours → theirs, keeps the first that parses) and
  `.artifacts/protected.mjs /tmp/pref.json` (same, with a per-file preferred
  order). Both write an audit ledger of every dropped side.

> ⚠️ **Two failed heuristics, recorded so they are not repeated.** (1) Unioning
> hunks whose sides are "import-ish lines" splits multi-line import blocks and
> produces orphaned member lists — 19 files were damaged this way and had to be
> reverted with `git checkout -m`. (2) A blanket "take upstream where loom's
> delta is small" pass silently dropped **real fork features** (the Pi-only
> driver registry, the handoff-drafter reactor, the AppImage env strip, the
> `PI_DEFAULT_MODEL` project default, loom's `thread` composer trigger). Both
> were reverted. Union is safe only for _complete, balanced_ additive statements.

## ⚠️ The mechanical-resolution ledger — MUST be audited

`docs/upstream-sync/25-mechanical-resolution-ledger.json` records, for **113
files**, which side was taken (`union` / `ours` / `theirs`) and the **verbatim
text of every dropped hunk**. These choices were made by a parser-verified
automatic pass, **not by reading each hunk** — they are syntactically valid and
semantically unaudited. The reviewer gate's lost-feature audit and the next
coder's typecheck repair should both work from this file.

Highest-risk entries (loom's side dropped, `"mode": "theirs"`):
`ThreadDetailScreen.tsx`, `CheckpointReactor.test.ts`, `OrchestrationEngine.test.ts`,
`ProviderCommandReactor.test.ts`, `ProviderService.test.ts`,
`GitHubSourceControlProvider.ts`, `VcsStatusBroadcaster.test.ts`, `DiffPanel.tsx`,
`NoActiveThreadState.tsx`, `ComposerCommandMenu.tsx`, `ProviderInstanceCard.tsx`,
`ProviderSettingsPanel.tsx`, `SettingsPanels.tsx`, `session-logic.test.ts`,
`state/entities.ts`, plus the wave-1 fold-ins below.

Wave-1 fold-ins (brief rule 2) were taken as **upstream wholesale** and still
need loom's affordances re-applied by hand:

| file                                                    | what must be re-applied                                                             |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/mobile/src/lib/threadActivity.ts` (+test)         | loom's `@t3tools/shared/userInputAnswers` hoist; consumers adapted to lazy getters  |
| `apps/mobile/src/state/use-selected-thread-requests.ts` | same (still conflicted)                                                             |
| `settings/ProviderModelsSection.tsx`                    | loom's `SearchableModelList` picker over upstream's design tokens                   |
| `chat/ModelPickerContent.tsx`                           | same                                                                                |
| `packages/client-runtime/src/state/shell.ts`            | resolved as `ours` — **upstream's `shouldResubscribeAfterWakeup` still to fold in** |
| `apps/web/src/routeTree.gen.ts`                         | generated file, taken from upstream — **regenerate, do not merge**                  |

## What remains

### 1. Fifteen files still carry conflict markers (143 markers)

Each was tried as whole-ours, whole-theirs and union; none parses as a single
side, so every one needs interleaved hand resolution. Ordered by the brief's
risk ranking, not by size:

| file                                                               | markers | brief rule / note                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------ | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/ws.ts`                                            |      23 | rule 4 — loom's #115 fail-loud shell catch-up, #4079 reasoning re-home and PR-191 burst coalescing must all survive; upstream's swallowing `orElseSucceed` must never return                                                                              |
| `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`  |      31 | rule 6 — **an auto-resolution to `theirs` was reverted deliberately**: pull 6 silently dropped columns here three times. Resolve by hand, then run the alias check (every `SqlSchema` query's alias list vs the widest list for the same `Result` schema) |
| `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`   |      17 | settlement gate; loom's exactly-once seam                                                                                                                                                                                                                 |
| `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts` |      13 | checkpoint cadence + loom's reasoning ingestion                                                                                                                                                                                                           |
| `apps/web/src/components/Sidebar.tsx`                              |      13 | loom's workstream roll-up badge, root filter, `Staged` pill, goal menu, attention status, activity-order sort (doc 23 §I1)                                                                                                                                |
| `apps/web/src/components/files/FilePreviewPanel.tsx`               |      10 | loom's MDX plan renderer path                                                                                                                                                                                                                             |
| `apps/web/src/rightPanelStore.ts`                                  |       7 | loom's `tasks`/`workstream` surfaces + `seedSurfaces` vs upstream's `userActionRevision` / device / attachment surfaces (see `docs/architecture/loom-ui-state-tiers.md`)                                                                                  |
| `apps/mobile/src/state/use-selected-thread-requests.ts`            |       6 | wave-1 fold-in                                                                                                                                                                                                                                            |
| `apps/server/src/provider/Layers/ClaudeAdapter.ts`                 |       6 | loom's `settlement`/`released` pending-user-input seam                                                                                                                                                                                                    |
| `apps/server/src/provider/Layers/ProviderRegistry.test.ts`         |       6 | Pi-only registry: upstream's non-pi cases stay deleted                                                                                                                                                                                                    |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts`           |       5 | chat surface — **an auto-resolution to `theirs` was reverted**; keep loom's side                                                                                                                                                                          |
| `apps/server/src/workspace/WorkspaceFileSystem.ts`                 |       3 | loom's `WorkspaceAbsoluteReadError` + out-of-workspace absolute read                                                                                                                                                                                      |
| `apps/web/src/components/ChatView.logic.ts`                        |       1 | one 149-vs-366-line hunk: loom's `/handoff` intercept copy vs upstream's `agentControlledBrowserCloseConfirmation` — both are additive, interleave them                                                                                                   |
| `apps/web/src/markdown-links.ts`                                   |       1 | loom's Windows-path normalisation vs upstream's extracted `inlineCodeFilePathCandidate`                                                                                                                                                                   |
| `apps/mobile/src/features/threads/PendingUserInputCard.tsx`        |       1 | deferred ledger (mobile question card) — keep loom's, adapt to upstream's `cardCoverage` props                                                                                                                                                            |

### 2. Then, in order

1. `git add -A && git commit --no-verify` the merge; **verify `git rev-parse HEAD^2` == `c14f6015bf`** and `HEAD^1` == `5c350f7a63`.
2. `vp run typecheck` — must report **all 15 packages checked**; it skips
   downstream packages when one fails, so a lower count is a lower bound. Save
   the per-package error list to `docs/upstream-sync/25-remaining-typecheck-errors.txt`.
3. Work the ledger above while repairing typecheck — most mechanical choices
   will surface there.
4. `pnpm build`, then `vp check`.
5. Migration smoke test on a `VACUUM INTO` copy of `~/.t3/cockpit/userdata/state.sqlite`
   into a temp `T3CODE_HOME`, built server on a spare `139xx` port (never 13900):
   the 13 new upstream migrations `041`–`053` apply exactly once in the upstream
   lane, fork lane `1001+` untouched, relaunch idempotent, fresh-DB schema
   identical. `Migrations.ts` and `LoomMigrations.ts` did **not** conflict, as
   doc 22 §10.5 predicted.
6. Test triage vs doc 24's known pre-existing failures (GitManager PR fixtures,
   7 web chat-surface tests).
7. Finish this note: verified topology hashes, the audited ledger outcome, the
   updated deferred ledger, migration smoke result, test triage.

### 3. One latent damage class to watch during typecheck

An early import-union heuristic (since abandoned, see the method note) left a
**broken import block** in `packages/contracts/src/orchestration.ts` — an
orphaned member list with no `import {` — that was only caught by the parse
sweep at the very end of the session and repaired. It parsed as a _different_
error than it looked like. The same pass touched 85 files; every one of them now
parses, but **duplicate import specifiers parse fine and only typecheck will
find them**. Expect a cluster of "duplicate identifier" / "already declared"
errors in the first typecheck run and treat them as merge fallout, not design.

## Resolved this session beyond the mechanical pass

`packages/contracts/src/orchestration.ts` (8 hunks) was resolved by hand and is
the unblocking file for downstream packages: upstream's `ProviderRequestKind`
superset (`mcp-elicitation`, `permission`) and `ProviderApprovalOption` adopted;
**loom's narrowed `ProviderUserInputAnswers`** (`string | string[]`, which fixed
mobile silently truncating a multi-select answer) kept over upstream's
`Schema.Unknown`; loom's `origin`/`controlPayload` message fields, internal and
scaffold command members, and `OrchestrationGetThreadActivitiesError` all
retained alongside upstream's pull-request link payloads, `ThreadAutoSettleCommand`
and user-input attachments. `Schema.TaggedErrorClass` → `Schema.TaggedError`
throughout, matching upstream's renamed base.

## Open questions — escalated, not guessed

1. **`no-manual-effect-runtime-in-tests` baselines.** Upstream's new per-file
   `maxOccurrences` option replaces the in-rule map. Loom's fork test files need
   entries in the lint config, or the rule fires on them. Mechanical, but it is a
   policy surface — confirm loom wants to carry the same debt list.
2. **`ProviderInstanceCard` / `ProviderSettingsPanel` / `SettingsPanels`** were
   auto-resolved to upstream with loom hunks dropped (recorded in the ledger).
   Whether those loom hunks are live product or pull-6 leftovers has not been
   determined and needs the lost-feature audit.

   **Resolved for `SettingsPanels`:** the lost-feature audit confirmed its two dropped auto-open Settings hunks were live product, and the mount plus changed-label spread are restored.

   **Also restored in `SettingsPanels`:** the merge dropped upstream's `<LegacyFeaturesSection />` mount from the General panel, so the plan-mode / context-window-indicator / legacy-sidebar switches were unreachable; the mount is back where upstream has it, and `contextWindowMeterEnabled` now defaults **on** for loom (upstream's non-legacy replacement, the "Resume with less context" banner, is `claudeAgent`-only, so on a Pi-only fork the meter is the sole context-usage display and the only route to Compact).

---

## Session 2 — 12 of the 15 hand-resolutions landed; 3 web files remain

Session 2 hand-resolved **12 of the 15** files session 1 banked, including the
two riskiest (`ws.ts`, `ProjectionSnapshotQuery.ts` — 54 of the 143 markers).
The full esbuild parse sweep over all **18,511** tracked `.ts`/`.tsx` paths
reports **zero parse damage**; the only remaining findings are the 3 files that
still carry markers. Nothing has been committed, nothing pushed. The recovery
bundle at `.artifacts/pull7-merge-state-backup/` was **refreshed** after the
last resolution, so it now reconstitutes the session-2 state (12 files staged,
3 files with all three conflict stages intact).

### The three files that remain (hand-interleaving only)

`autoresolve`-style whole-side variants were re-tried on all three with a
preferred order of union → ours → theirs: **all nine variants fail to parse**
(recorded by `docs/upstream-sync/pull7-tools/protected.mjs`). They cannot be
resolved mechanically.

| file                                                 | markers | shape of the conflict                                                                                                                                                                                                                               |
| ---------------------------------------------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/components/Sidebar.tsx`                |      13 | loom's Sidebar v2 re-home (doc 23 §I1: workstream roll-up badge, root filter, `Staged` pill, goal menu, attention status, activity-order sort) vs upstream's sidebar changes                                                                        |
| `apps/web/src/components/files/FilePreviewPanel.tsx` |      10 | loom's MDX plan renderer + `openInEditorPath` vs upstream's delimited-table preview (`DelimitedTablePreview`, `tableDelimiter`, `renderTable`) and its switch from `openInEditorPath` to `absolutePath` + `workspaceRoot`                           |
| `apps/web/src/rightPanelStore.ts`                    |       7 | loom's `tasks`/`workstream` surfaces + `seedSurfaces` (durable one-shot auto-open, plan W1) vs upstream's `userActionRevisionByThreadKey` / `automaticUpdate` vs `userAction` write policy, `openDevice`, `openAttachment`, `pull-requests` surface |

`rightPanelStore.ts` is the load-bearing one: the clean-merged text around the
markers already calls `userAction(...)`, `automaticUpdate(...)` and
`attachmentSurface(...)`, so a whole-`ours` resolution does not even compile.
Upstream's `userActionRevision` machinery and loom's seed-not-override policy
(`docs/architecture/loom-ui-state-tiers.md`) are **the same concern arrived at
twice** — the right resolution is to adopt upstream's automatic-vs-user write
split and re-express `seedSurfaces` as an automatic update on top of it, not to
keep two parallel mechanisms.

### What was decided in each of the 12 resolutions

#### `apps/server/src/ws.ts` (23 markers)

The largest single decision of the pull. Upstream has **converged on loom's
connect-gap fix with a better mechanism** (a scope-bound live buffer plus
`LiveStreamBudget` back-pressure and per-aggregate coalescing), so upstream's
shape was adopted and loom's three invariants re-homed onto it:

- **#115 fail-loud is preserved and now documented against upstream's newer
  shape.** Upstream replaced its old swallowing `orElseSucceed` with
  `retryShellProjectionRead`, which no longer _collapses_ failed-lookup with
  absent-row (the outer/inner `Option` split) but still **drops** the stream
  item on failure. Loom keeps `shellLookupRetry` + a live
  `ProjectionRepositoryError` channel so the client self-heals with a fresh
  snapshot. The module comment was rewritten to name upstream's new function so
  the next pull cannot re-collapse it by accident.
- **Upstream's `thread-removed`-on-successful-`none` IS adopted** — it is what
  makes coalescing correct (a burst can collapse a `thread.deleted` behind a
  later refetchable event for the same thread). This is the load-bearing
  distinction from the paragraph above: a _successful_ `none` means the row is
  genuinely gone; a _failed_ lookup stays in the error channel.
- **Eager PubSub attach kept.** Upstream forks `streamDomainEvents` (lazy —
  subscribes whenever the fibre first pulls, which is not ordered against the
  enclosing generator). Loom's `subscribeDomainEvents` is yielded _before_ the
  snapshot read, which is the only thing that actually closes the connect-gap.
  Both `subscribeShell` and `subscribeThread` use it.
- **Brief-needed decoration re-homed** into a per-subscription
  `makeShellStreamEventMapper` that now also owns the coalescers
  (`coalesceShellStream`, `coalesceShellLiveInputs`) because the mapper is
  per-subscription. `briefNeededAttention.invalidate` moved **out** of the
  removal branch and **into** `coalesceShellEvents`, checked over the _whole_
  batch rather than the survivors — coalescing can otherwise drop a removal
  behind a later event for the same aggregate and strand a parent's derived flag.
- **`shellResumeCompletionMarker` flipped `false` → `true`.** Loom advertised
  `false` only because its shell leg had nowhere to queue the marker without an
  ordering hazard; upstream's buffer removes that constraint. The comment
  explaining the old `false` was replaced with one explaining the flip.
- **PR #191 thread coalescing**: loom's `coalesceThreadStream` was retired in
  favour of upstream's `makeThreadLiveEventCoalescer`, which is a **superset**
  (same 50 ms / 512 window, plus `LiveStreamBudget` accounting and
  `tool.updated` supersession by stable tool-call id). ⚠️ The transfer-budget
  test that PR #191 exists to satisfy has **not been re-run** — see "open items".
- **#4079 reasoning re-home preserved** by extending `ThreadLiveInput` in
  `apps/server/src/orchestration/ThreadLiveEventCoalescer.ts` with a
  `reasoning-delta` variant that is never coalesced and closes the current
  tool-update window (ordering-safe). The reasoning subscription is forked into
  the same coalescer, so deltas still ride the connect-gap buffer.
- Upstream's `canReplayPersistedRange` (gap cap **and** an 8 MiB serialized
  payload budget) replaces loom's `SHELL_CATCHUP_MAX_EVENTS`; client-ahead-of-
  server is still handled (`replayGap < 0` → snapshot). The thread path takes
  upstream's `getThreadReplayStats` / `readThreadEvents`, which is loom's own
  "bound by rows RETURNED for this thread, not rows scanned" fix arrived at
  independently, plus `hasCreateEvent` handling for recreated threads.
- **Bootstrap worktree path: upstream's `WorktreeSetupTracker` adopted, loom's
  `worktreeProvisioner.provisionWorktree`/`runSetup` calls dropped from
  `ws.ts`.** ~400 lines of upstream's staged-progress/cancellation machinery had
  already clean-merged _around_ the conflicts, and upstream's inline path does
  everything loom's provisioner did for this caller (createWorktree with
  progress → `thread.meta.update` with branch/worktreePath → setup script) while
  adding live stage progress and cancellation. **The `t3code-setup-state.json`
  breadcrumb is unaffected** — it is written inside
  `apps/server/src/project/ProjectSetupScriptRunner.ts`, which upstream's path
  calls too, and `startFromOrigin` is honoured by upstream's `remoteExists` +
  `fetchRemote` branch. Loom's `WorktreeProvisioner` remains the provisioning
  tail for the workstream dispatcher's promotion path
  (`provisionIsolatedChild` / `ensureIsolatedChildProvisioned`), which is the
  fork-critical caller. ⚠️ `WorktreeProvisioner.runSetup` now has **no caller**
  and should be deleted or re-wired — see "open items".
- `loadServerConfig` takes upstream's `(options: { usageLimitsCommand })`
  signature and new fields (`otlpLogs*`, `fileManagerReveal*`,
  `reasoningMessages`) with loom's `overlayProviderExhaustion` and
  `remoteEditorSshHost` re-applied.
- The archive/settle teardown keeps **loom's** subtree-cascade parking logic
  (the `thread.settle` half and the narrow lineage query that avoids
  `getShellSnapshot`'s per-workspace `git` shell-outs) and gains upstream's
  three new calls: `cleanupFailedUploadedAttachments` on dispatch error,
  `recordClientCommandAnalytics`, and
  `ProjectCloneTracker.discardCloneForDeletedProject`.
- The config subscription's `providerStatuses` now folds **three** inputs —
  provider registry changes, loom's exhaustion marks, and upstream's usage-limit
  sources — through loom's `Stream.scan` seed, with upstream's
  `changesWith(JSON.stringify)` dedupe against the snapshot the client already
  holds.

#### `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (31 markers)

Upstream's pull-request-links-on-the-shell feature was adopted end to end
(`ProjectionThreadPullRequestDbRowSchema`, `mapPullRequestRow`,
`groupPullRequestRowsByThread`, `mapThreadPullRequests`,
`listActiveThreadPullRequestRows`, `listThreadPullRequestRowsByThread`) and
threaded through loom's `mapLeanThreadShellRow`, which gained optional
`pullRequests` / `repositoryIdentity` inputs plus `branchPullRequest` and
`titleState`. `getShellSnapshot` grew the PR read at position 4 of its
`Effect.all` and its destructure/`pullRequestsByThread` were updated to match.
`getCommandReadModel` takes upstream's **narrowed** identity resolution
(only projects with linked threads get a `git` shell-out) verbatim.
`getLeanShellSnapshot` — the control-plane read — deliberately carries **no**
pull-request read.

All four `title_provenance AS "titleProvenance"` / `title_state_json AS
"titleState"` alias conflicts were resolved as **both columns**, and the row
schema carries both fields: loom's §4 title provenance and upstream's
`ThreadTitleState` coexist. Upstream's `THREAD_DETAIL_ACTIVITY_LIMIT`-bounded
activity reads (`listThreadActivityIdsByThread`, `listThreadActivityRowsByIds`,
`listThreadActivityRowsByThreadAndKinds`, `getUserInputActivityRow`,
`listActivityRowsByKind`, `getThreadRuntimeContextRow`,
`getTurnStartMessageRow`) were kept **alongside** loom's cursor-paged
`listThreadActivityRowsBeforeSequence` /
`listUnsequencedThreadActivityRowsBeforeActivity`, each with its own SELECT list.

⚠️ **The doc-24 alias structural check has NOT been run** on the resolved file —
see "open items". It is the single highest-value verification left, because pull
6 dropped columns here three times.

#### The other ten

| file                                         | resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProviderCommandReactor.ts` (17)             | Upstream's **context-compaction** feature adopted whole (`compactingThreadIds`, `turnsAfterCompaction`, `restoreCompaction`, `stoppingThreadIds`, the compaction-aware session stop). Loom's Fix-A `clearPendingTurnStartForFailedTurn` folded into upstream's `handleCompactionFailure` so a failed compaction cannot leave the thread permanently non-idle. Loom's §1/§4 emergent-goal + title-provenance interpretation is kept as the **single** first-turn title source: upstream's `maybeGenerateThreadTitleForFirstTurn` was dropped rather than run alongside it (two title writers would race), and upstream's second model call for the worktree branch name was not folded in because loom renames the branch from the derived title inside `startThreadInterpretation` (its definition did not survive the merge anyway). Loom's worktree-isolation re-provision chokepoint, kickoff-brief recovery, role overlays / ship-policy / relocation system-prompt composition, and settle-before-liveness on interrupt and stop all kept; upstream's `ensureThreadWorktree`, `dispatchFromClient` origin plumbing, `projectComposerContextForProvider`, `refreshWorkspaceSnapshot` tap and `attachmentsByQuestionId` folded in. |
| `ProviderRuntimeIngestion.ts` (13)           | Upstream's per-project `resolveResponseStreamingMode` + paced `appendBufferedAssistantText(id, delta, mode, nowMs)` adopted (loom's `enableLegacyTokenStreaming` branch is superseded), as is `resolveThreadRuntimeContext` (loom's `resolveThreadShell` no longer exists) and the `content.delta` stream-kind filter. Loom's account-usage registry feed, liveness heartbeat, usage-ledger rows, interrupted-tool activities, `shouldPersistActivity` de-dupe and the narrow first-terminal-wins `catchIf` all kept. Loom's transient reasoning bus was renamed `liveReasoningDelta` so it coexists with upstream's new **durable** reasoning deltas rather than shadowing them, and its live-streaming gate now reads `resolveResponseStreamingMode(...) === "token"`.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ClaudeAdapter.ts` (6)                       | Upstream's richer rate-limit mapping (`claudeRateLimitEventToUpdate`, scoped limit names, the parked-window warning) and `stopSessions` adopted; upstream's `onUserDialog` / `supportedDialogKinds: ["resume_return"]` folded in. Loom's settlement-deferred pending-user-input dismissal, best-effort replacement-stop cleanup, the `releasedForCall` promise-boundary release, and `getSession` kept. The worktree `node_modules/.bin` PATH prepend now wraps **inside** upstream's `McpProviderSession.withAgentDeviceEnvironment`. A broken import block in a clean-merged region (a leftover of session 1's abandoned import heuristic) was repaired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `WorkspaceFileSystem.ts` (3)                 | Both helpers kept: upstream's `resolveReadTarget` (absolute paths read in place, no root check) and loom's shared `readTextFromRealPath`, with loom's `WorkspaceAbsoluteReadError` / absolute-directory listing intact. `Schema.TaggedErrorClass` → `Schema.TaggedError` applied file-wide, matching the contracts rename.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `ProviderRegistry.test.ts` (6)               | All six taken as **ours**: the Pi-first registry ships pi only, so upstream's codex re-probe and cursor-defaults cases stay deleted. One orphaned upstream fragment in a clean region was removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ChatView.logic.ts` (1)                      | Union — loom's `/handoff` intercept copy and upstream's `agentControlledBrowserCloseConfirmation` are both additive. A mangled import block and a missing closing brace, both in clean-merged regions, were repaired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `markdown-links.ts` (1)                      | Loom's Windows drive/UNC normalisation and extensionless-with-`:line` fallback kept, then the normalised span handed to upstream's extracted `inlineCodeFilePathCandidate` + three-arg `resolveMarkdownFileLinkMeta`. A duplicate `MARKDOWN_LINK_HREF_PATTERN` / `extractMarkdownLinkHrefs` pair (clean-region merge damage; upstream's newer `<...>`-aware pattern survives) was removed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `chat/MessagesTimeline.logic.ts` (5)         | **Ours**, per the chat-surface decision. Loom's spawn/consult card grouping and `/handoff` receipt splicing kept; upstream's worktree-setup card, queued-message rows and `deriveMessagesTimelineRowsWithState` streaming-row reuse are **not** folded in (`MessagesTimeline.tsx` itself is loom's file wholesale, so nothing consumes them).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `mobile/PendingUserInputCard.tsx` (1)        | **Theirs** — see "open items"; this diverges from the session-1 table's "keep loom's, adapt to `cardCoverage`".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `mobile/use-selected-thread-requests.ts` (6) | **Theirs** (wave 1), loom's `@t3tools/shared/userInputAnswers` hoist **not yet re-applied** — see "open items".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### A latent damage class session 1 under-reported

Session 1 recorded that the abandoned import-union heuristic had been reverted.
It was reverted in _unconflicted_ files, but **the clean-merged regions of
conflicted files still carried the damage**, because the parse sweep skips a
file that contains `<<<<<<<`. Three of the twelve files resolved this session
(`ClaudeAdapter.ts`, `ChatView.logic.ts`, `markdown-links.ts`) had a broken
import block, a duplicated declaration pair, or a missing closing brace in text
that was never in a conflict hunk. **Expect the same in the last three files**:
re-run `parsesweep.mjs` on each the moment its markers are gone, before trusting
anything else about it.

### Open items for the next session, in priority order

1. **Resolve the three web files** (above). `rightPanelStore.ts` first — it
   blocks the other two conceptually and does not compile as either side.
2. **Commit the merge**: `git add -A && git commit --no-verify`, then verify
   `git rev-parse HEAD^1` == `5c350f7a63` and `HEAD^2` == `c14f6015bf`.
   Every later commit on the branch is also `--no-verify`; never rebase.
3. **Run the doc-24 alias structural check** on
   `ProjectionSnapshotQuery.ts`: for every `SqlSchema` query, compare its alias
   list against the widest list for the same `Result` schema. Pull 6 dropped
   columns here three times and typecheck cannot see it.
4. **`vp run typecheck`** — must list all 15 packages. Known repairs already
   identified and _not_ done:
   - `McpSessionRegistry.test.ts` still asserts the old exact capability set;
     change it to a `has("workstream")` check (the invariant holds; session 1
     added `"workstream"` unconditionally to upstream's derived set).
   - `WorktreeProvisioner.runSetup` has no caller after the `ws.ts` bootstrap
     re-home — delete it (and its `RunSetupInput`) or re-wire it.
   - `enrichProjectEvent` / `enrichOrchestrationEvents` in `ws.ts` are **dead in
     loom `HEAD` too** (defined, never called) — a pre-existing condition, not
     merge fallout, but the upstream restructure makes it newly obvious. Decide
     whether loom's project `repositoryIdentity` enrichment on the wire was
     meant to be live.
   - `canReplaceThreadTitle` / `DEFAULT_THREAD_TITLE` in
     `ProviderCommandReactor.ts` may now be unused imports.
   - `claudeRateLimitWindow` in `ClaudeAdapter.ts` may now be unused.
   - Loom's `thread.title.generate.complete` dispatch passes `title` +
     `titleProvenance`; upstream's command may now require `expectedTitle` /
     `expectedVersion` / `needsRefinement`. If so, thread loom's provenance
     through upstream's CAS fields rather than widening the schema.
   - Open question 1 (unchanged): add loom's fork test files to upstream's
     `no-manual-effect-runtime-in-tests` `maxOccurrences` lint option rather
     than weakening the rule.
5. **`pnpm build`, then `vp check`.**
6. **Migration smoke on a `VACUUM INTO` copy** of
   `~/.t3/cockpit/userdata/state.sqlite` into a temp `T3CODE_HOME`, built server
   on a spare `139xx` port (never 13900): upstream migrations 041–053 apply
   exactly once, fork lane `1001+` untouched, relaunch idempotent, fresh-DB
   schema identical. Not started.
7. **Re-run the PR #191 transfer-budget test** (21 msgs/turn). Loom's
   `coalesceThreadStream` was replaced by upstream's
   `makeThreadLiveEventCoalescer`; the budget should still hold (same window and
   chunk size, plus tool-update supersession) but it is unverified, and the
   `reasoning-delta` variant added to the coalescer changes when a tool-update
   window is flushed.
8. **Mobile wave 1 — two deliberate deferrals, both taken as upstream
   wholesale this session and both needing loom's side re-applied:**
   - `use-selected-thread-requests.ts`: loom's
     `@t3tools/shared/userInputAnswers` hoist (shared draft store, thread-scoped
     eviction) was replaced by upstream's local
     `userInputDraftsByRequestKeyAtom`. Re-apply the hoist on top of upstream's
     attachment-aware draft shape.
   - `PendingUserInputCard.tsx`: **this departs from the session-1 table**,
     which said "keep loom's, adapt to upstream's `cardCoverage` props".
     Upstream redesigned the card wholesale (collapse/slide animation, coverage
     measurement, question attachments) and its parent passes the new props, so
     loom's card would not have compiled. Taking upstream's costs loom's
     **option previews** (`option.preview` + the preview pane) and its
     **multi-select** affordance (`question.multiSelect`, the "Select one or
     more options." hint, `selectedUserInputOptionLabels`). Both are live loom
     product on the mobile question card and must be re-applied onto upstream's
     card.
9. **The 113-file mechanical ledger audit
   (`docs/upstream-sync/25-mechanical-resolution-ledger.json`) has NOT been
   started.** It remains the single largest lost-feature risk in this pull, and
   open question 2 (`ProviderInstanceCard` / `ProviderSettingsPanel` /
   `SettingsPanels`) sits inside it.

---

## Session 3 — merge COMMITTED; 11 of 15 packages typecheck; mobile + server remain

**The merge is committed.** The three remaining web files were hand-resolved,
the merge commit was created with the correct two-parent topology, and repair
commits followed. Nothing has been pushed.

### Topology (verified)

| ref                                              | hash         |
| ------------------------------------------------ | ------------ |
| merge commit                                     | `116eff1261` |
| `HEAD^1` (loom `origin/main`)                    | `5c350f7a63` |
| `HEAD^2` (upstream tip v0.0.43-nightly.20260920) | `c14f6015bf` |

Branch `t3code/upstream-sync-20260921`. Every commit used `--no-verify`; `^2`
was re-verified after each. No rebase, no squash.

### The three web resolutions

**`apps/web/src/rightPanelStore.ts`** — upstream's `userActionRevision`
write-policy split was adopted whole, and loom's `seedSurfaces` was
**re-expressed as an `automaticUpdate`** rather than kept as a second
mechanism: seeding now cannot advance the user-action revision, so it can never
masquerade as a panel choice the user made. Loom's `tasks` / `workstream` /
`dir` / `artifact` surfaces, `openFileAbsolute` / `openFilesAt` /
`openDirectoryAbsolute` / `openArtifact` and the `filesSurface` reveal fields
all survive alongside upstream's `openDevice` / `renameDevice` /
`openAttachment` / `pull-requests`. Upstream's Windows/trailing-slash path
normalisation was folded into loom's `upsertFileSurface`; `RIGHT_PANEL_KINDS`
takes upstream's un-exported form (no consumer outside the module);
`updatePullRequestTabStatus` was dropped with upstream (its only consumer is
gone). The `plan` surface stays dropped, as intended.

**`apps/web/src/components/Sidebar.tsx`** — upstream's marker-driven list
assembly (`sidebarListItems`, `SidebarDragBoundary` / `SidebarSectionHeader` /
`SidebarSectionPlaceholder`, one unified `DndContext`, `optimisticDrop`,
`applySidebarThreadDrop`) replaces loom's older pinned-only Dnd block wholesale;
loom's `graphRollup` prop was re-homed onto upstream's `renderThreadRowInner`.
Every one of loom's 21 `// loom:` markers in the file is accounted for.

Three semantic decisions inside it:

1. **`changeRequestSnapshot` plumbing retired.** Upstream deleted the whole
   client-side `threadChangeRequestSnapshotsAtom` machinery because the PR now
   rides the thread shell (`thread.pullRequests`). Loom's auto-settle-on-merge
   therefore reads the request from the shell through a new
   `threadChangeRequest(thread)` in `Sidebar.logic.ts` (loom's branch guard
   kept), and the per-row write-back prop pair is gone. Same concern arrived at
   twice; upstream's side is strictly better-sourced.
2. **Loom's client-side auto-settle branch KEPT.** Upstream retired its own
   client-side `effectiveSettled` partition (it auto-settles server-side now),
   but loom's branch carries the **workstream blocker** — a root with
   non-terminal descendants must not settle — which the server does not know.
   ⚠️ Whether upstream's server-side `ThreadAutoSettleCommand` can now settle a
   loom root behind that blocker's back is **an open question for the reviewer
   gate** (see open items).
3. **The active-order collision was resolved by composition, not by choosing.**
   Upstream made the active block user-arrangeable (`activeOrderKey`, drag
   placement gated on `threadActiveReorder`, which loom's server advertises);
   loom sorts the active block by activity (doc 23 §I1, marked PROVISIONAL).
   Keeping loom's sort as-is would have made a dragged row snap back the moment
   the optimistic hold cleared, and emptying `activeReorderableKeys` would have
   killed pinned→active and settled→active drops too (`planSidebarThreadDrop`
   returns `{kind:"none"}` for the whole active target). So
   `sortActiveThreadsByActivityForSidebar` is now **upstream's comparator with
   loom's activity anchor for unarranged rows**: never drag and the block is
   pure activity order; drag once and that placement sticks.

**`apps/web/src/components/files/FilePreviewPanel.tsx`** — upstream's preview
rework adopted (media/PDF/HTML/`DelimitedTablePreview`, directory handling,
attachments, `ReadOnlySourcePreview`, `FileMarkdownPreview`'s relative-image
base dir, the `FileSurfaceAction` toolbar). **Loom's `absolutePath` prop was
dropped**: upstream converged on the same concept as `isHostFile`
(`isAbsolutePath(relativePath)`, with `resolveReadTarget` reading an absolute
path in place server-side), and loom's file surfaces already mirror the
absolute path into `relativePath`, so the separate prop and the separate
`useProjectAbsoluteFileQuery` read were a second mechanism for one thing. The
one caller line in `ChatView.tsx` was removed. Loom's MDX plan renderer, its
8 MiB `MDX_PREVIEW_MAX_BYTES` budget (correctly threaded as the _fifth_
argument — upstream's 4-arg call would have passed a boolean as `maxBytes`),
the still-truncated-MDX guard and the artefact-viewer button all survive.

### The real finding of this session: declaration-level merge damage

Session 2 warned that clean-merged regions of conflicted files carried import
damage. It is broader than that: **the mechanical pass and the clean merge also
dropped whole top-level declarations from files nobody flagged.** Found and
repaired so far:

| file                                              | what was lost                                                                                                                                                                                                                                                                                                                                    | whose    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `apps/web/src/components/Sidebar.logic.ts`        | `reduceSidebarProjectScopeMenuState` + its two types                                                                                                                                                                                                                                                                                             | upstream |
| `apps/web/src/components/Sidebar.logic.ts`        | `shouldNavigateAfterProjectRemoval` (still called by `Sidebar.tsx`)                                                                                                                                                                                                                                                                              | loom     |
| `packages/contracts/src/server.ts`                | the whole environment-themes block (`EnvironmentThemeColor`, `EnvironmentThemeId`, `environmentThemeFields`, `EnvironmentThemeFile`, `EnvironmentTheme`, `environmentThemeFileHasColors`) **and** `ServerConfigStream{EnvironmentThemesUpdated,UsageLimitSourcesUpdated}Event` with their payloads — while every server/client consumer survived | upstream |
| `packages/contracts/src/settings.ts`              | 9 client/server settings fields (`notificationMode`, `inAppNotificationsEnabled`, `diffColorScheme`, `loadBalancing{Enabled,Weights}`, `appearanceContrast`, `panelAnimationDurationMs`, `storageCleanup`, `worktreeCleanup`) across four structs                                                                                                | upstream |
| `packages/client-runtime/src/state/server.ts`     | `projectServerWelcome` (loom) and `refreshUsageRates` (upstream)                                                                                                                                                                                                                                                                                 | both     |
| `apps/web/src/components/NoActiveThreadState.tsx` | `NoActiveThreadState` itself — the resolver took `theirs` and dropped a hunk spanning loom's `ThreadHydratingState` tail and upstream's function head                                                                                                                                                                                            | upstream |

A structural auditor for exactly this is now at
`docs/upstream-sync/pull7-tools/lostdecls.py` (compare top-level exported
declaration names in every merged file against BOTH parents). Run:

```
python3 docs/upstream-sync/pull7-tools/lostdecls.py 5c350f7a63 c14f6015bf
```

Its current in-tree verdict: **336 files lost some export; 7 lost an UPSTREAM
export** (the rest are upstream deletions of code loom merely inherited, which
is correct), and **exactly one name that loom lost still exists upstream**
(`NoActiveThreadState`, now repaired). Of the remaining 6 upstream-only losses,
`ProjectionEventReplayStats`, `ProjectSetupScriptOutputLine`,
`ProviderCompaction`, `VcsAutoPullPolicy`/`autoPullPolicyLayer`,
`MessagesTimelineRowsProjection`/`deriveMessagesTimelineRowsWithState` and
`importPastedComposerText` are **not yet adjudicated** — the timeline pair is
expected (the chat-surface decision), the others are not.

⚠️ **The auditor only sees top-level declarations.** The `settings.ts` and
`server.ts` losses above were _fields inside structs_ and did not show up.
Field-level drops in contracts are the residual risk, and typecheck only finds
them where a consumer exists.

### The doc-24 alias structural check: CLEAN

`docs/upstream-sync/pull7-tools/aliascheck.py` (rebuilt this session; it parses
the SELECT list at paren depth 0 rather than splitting on commas) over
`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`:

```
43 Result schemas, 78 queries, 1 narrower than widest
```

The single hit is a **false positive**: two unrelated inline `Schema.Struct`
results group by literal text. Every named `Result` schema — including
`ProjectionThreadDbRowSchema` (4 queries) and
`ProjectionThreadActivityDbRowSchema` (7 queries) — selects an identical alias
set across all of its queries. **No dropped columns.** This was the pull-6
failure mode three times over and it did not recur.

### Gate status

`vp run typecheck`: **11 of 15 packages green** — contracts, shared,
client-runtime, effect-acp, effect-codex-app-server, oxlint-plugin-t3code, ssh,
tailscale, scripts, marketing, **apps/web**.

| package        |  errors | shape                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------- | ------: | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/mobile`  |     140 | 114 are the wave-1 deferrals (`threadActivity.test.ts` 46, `PendingUserInputCard.tsx` 40, `use-selected-thread-requests.ts` 28); the rest are merge damage (`FileMarkdownPreview.tsx` duplicate import block, `MarkdownBlock.tsx` missing `../lib/useThemeColor`, `responseStreamingMode` settings drift, `ThreadFeedActivity` lazy-getter vs upstream's eager `fullDetail`/`copyText`) |
| `apps/server`  |    2044 | 998 are Effect diagnostics (`TS377030` unknown-in-R, `TS377004` missing service) that likely cascade from a handful of layer wirings; 76 `TS2300` duplicate identifiers and 167 `TS2304` cannot-find-name are the same import-union/dropped-declaration damage as above, across ~40 files                                                                                               |
| `apps/desktop` | not run | `vp` skips it while server fails; run `cd apps/desktop && npx tsc --noEmit`                                                                                                                                                                                                                                                                                                             |

Full inventory (per file, per error code, plus the duplicate-identifier and
cannot-find-name lists that localise the merge damage):
`docs/upstream-sync/25-remaining-typecheck-errors.txt`, with the raw server log
at `docs/upstream-sync/25-server-typecheck-raw.txt`.

`pnpm build`, `vp check`, the migration smoke on a DB copy, the PR #191
transfer-budget re-run and the 113-file ledger audit are **all not started** —
they sit behind a green typecheck.

### What the next session should do, in order

1. **`apps/server` (2044) and `apps/mobile` (140), then `apps/desktop`.** Work
   the `TS2300`/`TS2304` lists in
   `docs/upstream-sync/25-remaining-typecheck-errors.txt` first: they are
   mechanical (a duplicated import line, or a declaration to restore from
   `git show c14f6015bf:<path>` / `5c350f7a63:<path>`) and they are what the
   Effect diagnostics are most likely cascading from. Re-count after.
2. **Mobile wave 1** (note open item 8, task `a4b1ddfa`): re-apply loom's
   `@t3tools/shared/userInputAnswers` hoist onto upstream's attachment-aware
   draft shape in `use-selected-thread-requests.ts`, and loom's **option
   previews** + **multi-select** onto upstream's redesigned
   `PendingUserInputCard`. `threadActivity`'s lazy getters
   (`canExpand`/`getFullDetail`/`getCopyText`) should be adapted to upstream's
   eager `fullDetail`/`copyText` — the merge already took upstream's module.
3. **Re-run `lostdecls.py`** after the repairs and adjudicate the 6 unresolved
   upstream-only losses listed above.
4. Then the untouched gates: `pnpm build`, `vp check`, migration smoke
   (041–053 on a `VACUUM INTO` copy, fork lane `1001+` untouched, spare `139xx`
   port, never 13900), PR #191 transfer budget, and the **113-file ledger
   audit**, which remains the largest lost-feature risk and now has a second
   reason to be done: the mechanical resolver demonstrably dropped whole
   declarations, not just hunks.

### Open questions — escalated, not guessed

1. **Auto-settle now has two owners.** Loom keeps its client-side
   `effectiveSettled` partition (it carries the workstream
   `hasNonTerminalDescendant` blocker); upstream added a server-side
   `ThreadAutoSettleCommand`. If the server settles a loom root that has live
   sub-threads, the blocker is bypassed and the root vanishes from the inbox
   while its children work. Needs a decision: teach the server the blocker,
   disable the server-side sweep for loom, or accept it.
2. **Active-block ordering** was resolved by composition (above) rather than by
   picking a side. It is a visible behaviour change either way and doc 23 §I1
   should be updated once a human has looked at it.
3. Open question 1 from session 1 is unchanged: loom's fork test files still
   need entries in upstream's `no-manual-effect-runtime-in-tests`
   `maxOccurrences` lint option rather than the rule being weakened.

## Session 4 — apps/desktop green, every apps/server SOURCE file green; 740 test errors remain

`apps/server` went **2044 → 740 errors, and all 740 are in test/integration
files**: every non-test source file in the package now typechecks. `apps/mobile`
went 140 → 73. **`apps/desktop` is green** (it had exactly one error once the
server compiled). 13 of 15 packages are fully green.

Refreshed inventory: `docs/upstream-sync/25-remaining-typecheck-errors.txt`,
raw log `docs/upstream-sync/25-server-typecheck-raw.txt`.

### The damage, by class

**(a) Import-union damage.** Duplicate import blocks in ~14 files
(`cli/project.ts`, `ProviderCommandReactor`, `projector`,
`ProjectionThreadMessages`, `ProjectionThreads`, `ProjectSetupScriptRunner`,
`serverRuntimeStartup`, `GitVcsDriver`, `ws.ts`, `server.test.ts`,
`FileMarkdownPreview.tsx`, `use-selected-thread-requests.ts`, …). Mechanical:
merge the two blocks, keep the union.

**(b) Dropped whole declarations — by far the biggest class.** The mechanical
pass deleted entire declarations, whole `case` arms, interface members and
object-literal entries while leaving every reference intact. Repaired:

| file                                                                   | what was lost                                                                                                                                                                                                                                                                        | whose    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `apps/server/src/orchestration/decider.ts`                             | `nowIso`, `isScriptRunCommand`, `threadPullRequestLinksEqual`, `findPullRequestLink`, **and the whole `thread.pull-request.link` / `.unlink` / `thread.message.user.append` case arms**                                                                                              | upstream |
| `apps/server/src/provider/Layers/ProviderService.ts`                   | a 370-line block: `fileSystem`, `pathService`, the compaction registry (`pendingCompactions`, `timedOutNativeCompactions`, `settleCompaction`) and the entire turn-analytics subsystem (`turnAnalytics` … `recordTurnCompletedAnalytics`)                                            | upstream |
| `apps/server/src/provider/Layers/CodexAdapter.ts`                      | 230 lines of MCP tool-presentation helpers (`asUnknownRecord` … `mcpToolPresentation`)                                                                                                                                                                                               | upstream |
| `apps/server/src/persistence/Layers/OrchestrationEventStore.ts`        | the aggregate-replay request/result schemas, `readAggregateEventRows`, `readAggregateReplayStats`, `getAggregateReplayStats`                                                                                                                                                         | upstream |
| `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`          | `readThreadEvents`, `getThreadReplayStats`, `userInputActivity`, `isOrchestrationCommandInvariantError`, the `dispatch` `options` parameter                                                                                                                                          | both     |
| `apps/server/src/vcs/VcsStatusBroadcaster.ts`                          | `VcsAutoPullPolicy` + `autoPullPolicyLayer`, and `refreshPullRequestStatus`                                                                                                                                                                                                          | upstream |
| `apps/server/src/git/GitManager.ts`                                    | `branchPullRequest` (the **interface member**, not the impl), `resolveRemoteRepositoryContext`, `resolvePrLookupRepositoryIdentity`, `targetRemoteUrlKey`                                                                                                                            | upstream |
| `apps/server/src/provider/Services/ProviderAdapter.ts`                 | `ProviderCompaction` + the `promptlessTurnContinuation` / `supportsConversationRollback` capability fields                                                                                                                                                                           | upstream |
| `apps/server/src/persistence/Services/Projection{Projects,Threads}.ts` | `DeleteProjectionProjectInput`, `DeleteProjectionThreadInput`, `ListProjectionThreadsByProjectInput`                                                                                                                                                                                 | loom     |
| `apps/server/src/orchestration/Services/ProjectionSnapshotQuery.ts`    | `ProjectionEventReplayStats`                                                                                                                                                                                                                                                         | upstream |
| `apps/server/src/textGeneration/TextGeneration.ts`                     | `TextGenerationShape`, `ThreadTitleGenerationResult.needsRefinement`                                                                                                                                                                                                                 | both     |
| `apps/server/src/provider/makeManagedServerProvider.ts`                | `withUsageLimits`                                                                                                                                                                                                                                                                    | upstream |
| `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`           | `shouldRefreshThreadShellSummary`                                                                                                                                                                                                                                                    | upstream |
| `apps/server/src/server.ts`                                            | **five layers dropped from the runtime composition**: `PullRequestServiceLive`, `GitHubCli.layer`, `DeviceLayerLive`, `ModelManifest.layer`, `CodexResetCredit.layer`, plus `ThreadSettlementReactor` / `PullRequestSyncReactor` / `ThreadPullRequestReactor` from the reactor layer | upstream |
| `apps/server/src/serverRuntimeStartup.ts`                              | `resolveAutoBootstrapWelcomeTargets` was spliced from BOTH versions into a body that referenced variables from neither; rewritten on upstream's structure with loom's pi default and loom's idempotent re-resolve                                                                    | both     |
| `apps/mobile/src/lib/threadActivity.ts`                                | the `ThreadFeedActivity` interface still declared loom's eager `fullDetail`/`copyText` while the producer already emitted upstream's lazy `canExpand`/`getFullDetail`/`getCopyText` — one interface edit cleared 50 errors                                                           | upstream |

**(c) Marker-less semantic conflicts.** Resolved below.

### Semantic resolutions

**Reasoning is loom's ephemeral v2, on the server too.** Upstream's
`thread.message.reasoning.complete` was re-added to `orchestration.ts` next to
loom's re-homed one in `orchestration.loom.ts` — **two structs with the same tag
in one union, which cannot coexist**, and upstream's `.delta` sibling came with
it. Loom's variant is the registered `LOOM_COMMAND_TYPES` member, is decided by
`decider.loom.ts`, and is what the merged web actually paints (`ReasoningBlock`
reads `message.reasoningText`), so upstream's pair is re-dropped and the
matching durable dispatch sites in `ProviderRuntimeIngestion` (the buffered
reasoning-delta block, the `item.completed` reasoning snapshot, and four
`role: "reasoning"` segment finalisations) are removed. Loom's ReasoningStreamBus

- `finalizeReasoningForMessage` remains the single mechanism.
  ⚠️ Cost: upstream's whole-block _snapshot_ fallback (a provider that reports one
  reasoning block without streaming it) has no loom equivalent and is gone. The
  inert `"reasoning"` member of `OrchestrationMessageRole` now has no producer.

**`account.rate-limits.updated` carries both shapes, both optional.** Loom's
`windows`/`planType` rollup (consumed by `ProviderRuntimeIngestion` →
`AccountUsageRegistry`) and upstream's normalised `limits` (consumed by
`ProviderUsageLimitsIngestion`) are BOTH live, with different emitters (Codex
vs Claude) and no adapter able to derive both from one native notification.
Making either required broke the other's emitter, so both are optional and each
consumer skips an event that lacks its field.

**`enableLegacyTokenStreaming` → `responseStreamingMode`.** Upstream's rename
adopted: the rest of the tree (including `resolveResponseStreamingMode`) had
already moved, only the `ServerSettings` struct still held the old key.

**`WorkspaceLease.ts` → `WorkspaceOccupancyLease.ts` (fork file moved).**
Upstream added `workspaceLease.ts` — a 23-line per-cwd mutex — which collides
with loom's `WorkspaceLease.ts` process-occupancy service on a case-insensitive
filesystem (TS1149). They are different mechanisms with different semantics
(fail-fast exclusive vs queueing mutex), so folding one onto the other would
change behaviour. **Upstream's path is kept byte-identical and the fork's file
moved** — 15 one-line import edits once, so future pulls stay mechanical.

**Other side-picks.** `ProviderCommandReactor`'s branch rename keeps loom's
single-model-call derivation (upstream's separate `generateBranchName` body had
been grafted onto loom's signature); `thread.title.generate.complete` reverts to
loom's `thread.meta.update` + `titleProvenance`; the in-file OpenCode shared
server is deleted (upstream's `OpenCodeServerOwner` subsumes it, same 30s idle
TTL); `Sqlite.ts`'s bun client loader is deleted (the package is not installed
and upstream converged on `@t3tools/shared/nodeSqliteClient`);
`sidebarAutoSettle{AfterDays,OnMerge}` move client→server with upstream;
mobile's `MarkdownBlock` moves from loom's per-variable `useThemeColor` (which
upstream retired) to one `useUniwindTheme()` palette read.

**`server.test.ts`'s 554 errors were one root cause.** The merged `appLayer`
pipe had 23 arguments; `.pipe` tops out at 20. Split into two chained pipes
(positionally identical) → 554 became 194, and the duplicate-import fix took it
to 365.

### Auto-settle: open question 1 is RESOLVED (teach the server)

The orchestrator chose _teach the server sweep the blocker_, and it landed as a
~20-line local change in `apps/server/src/orchestration/decider.ts`'s
`thread.auto-settle` arm: the command read model already holds the thread graph,
so the arm reuses loom's own `collectLiveSubtreeIds` + shared `isTerminalLane`
and returns `OrchestrationThreadSettleBlockedError` when any non-deleted,
non-archived descendant sits in a lane other than `done`/`cancelled`. It mirrors
`workstreamAutoSettleBlocked`'s third clause, and — exactly as on the client — an
EXPLICIT `thread.settle` still outranks it. No switch, no disabled sweep.

### lostdecls.py adjudication

Of the 6 unadjudicated upstream-only losses, 3 are now **repaired** (they were
real): `ProjectionEventReplayStats`, `ProjectSetupScriptOutputLine`'s sibling
`ProjectSetupScriptRunnerResultStarted.async`, and `ProviderCompaction`.
`VcsAutoPullPolicy`/`autoPullPolicyLayer` was also real and is restored.
`MessagesTimelineRowsProjection`/`deriveMessagesTimelineRowsWithState` remains
an **intentional** drop (the chat-surface decision). `importPastedComposerText`
is still unadjudicated — it produced no typecheck error, so it is either
genuinely unused or reachable only from a path no consumer types.

### Gate status

| package                      |                                                                                                                                              errors |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------: |
| the 11 green after session 3 |                                                                                                                                                   0 |
| `apps/desktop`               |                                                                                                                                               **0** |
| `apps/server`                |                                                                                                             740 — **all in test/integration files** |
| `apps/mobile`                | 73 — `PendingUserInputCard.tsx` (40) + `use-selected-thread-requests.ts` (28) are the wave-1 deferrals, the other 5 are one-line test fixture drift |

`pnpm build`, `vp check`, the migration smoke and the PR #191 transfer budget
are **not started** — they sit behind a green `vp run typecheck`.

## Session 5 — two latent runtime defects found; `apps/web` is NOT green and never was

**Outcome: `bank_and_handoff`.** Five commits on `t3code/upstream-sync-20260921`
(`5ce61df3c2` … `82e587a7fc`), tree clean, nothing pushed, every commit
`--no-verify`, `116eff1261^2` = `c14f6015bf` re-verified after each.

Brief items **1 (apps/server tests) partially** and the mechanical share of the
web surface are done. Items **2, 3, 4, 5, 6, 7, 8** are NOT started — item 3
(green typecheck) is the gate for all of them, and the distance to it is roughly
three times what the brief assumed. See "The scope correction" below.

### The two defects that matter more than the error counts

Both are invisible to `tsc` and to a green test run, and both were introduced by
the merge itself — neither parent has them.

**1. A circular value import between two `packages/contracts` modules — the
server could not boot.**

    orchestration.ts  --value-->  providerRuntime.ts   (loom's edge, for UserInputResolvedOutcome)
    providerRuntime.ts --value-->  orchestration.ts    (upstream's edge, for ProviderApprovalOption)

Each parent had exactly ONE of these edges. The merge has both, so whichever
module ESM evaluated second saw an uninitialised binding:

    ReferenceError: Cannot access 'ProviderApprovalOption' before initialization
      at packages/contracts/src/providerRuntime.ts:562

Reproduced by importing `@t3tools/contracts` from plain node. `tsc` cannot see
it (types are erased and the cycle is legal to the type checker), and it would
have surfaced as a hard boot failure in the item-7 migration smoke.

**Resolution:** loom's two leaf literals (`RuntimeErrorClass`,
`UserInputResolvedOutcome` + `DEFAULT_USER_INPUT_RESOLVED_OUTCOME`) moved OUT of
`providerRuntime.ts` and into `orchestration.loom.ts`, which depends only on
`baseSchemas.ts`. `providerRuntime.ts` re-exports both, so their public import
path is unchanged, and it keeps upstream's import direction untouched — future
pulls stay mechanical. Verified: `@t3tools/contracts` now imports and decodes an
`OrchestrationThread` under plain node.

**2. `apps/web` lost the `lexical` dependency, and `node_modules` predated the
merge.**

`apps/web/package.json` lost the bare `"lexical": "^0.41.0"` line in the merge
(it kept `@lexical/react`, which does not provide it). Separately,
`node_modules` in this worktree was installed at **Sep 21 01:32**, an hour
BEFORE the merge commit `116eff1261` (**02:47**) — so no session since the merge
had the post-merge dependency tree. Dependency restored, `vp i` run; that alone
removed 87 errors (the whole of `ComposerPromptEditor.tsx`).

**Anyone re-measuring typecheck must run `vp i` first.**

### The scope correction — `apps/web` was never green

Sessions 3 and 4 both recorded `apps/web` as green; the remaining-errors file
listed only mobile and server. It is not green, and this is **not** a session-5
regression: stashing session 5's edits and re-running gives **851 errors at
session 4's HEAD `b84b466aeb`**.

Current, after session 5's work and `vp i`:

| package                          | errors  | note                                    |
| -------------------------------- | ------- | --------------------------------------- |
| 11 packages incl. `apps/desktop` | **0**   | unchanged, still green                  |
| `apps/web`                       | **635** | was 851; mostly SOURCE files, not tests |
| `apps/server`                    | **176** | was 740; all test/integration files     |
| `apps/mobile`                    | **63**  | untouched this session                  |

`apps/web` is the bigger half of the remaining work and is qualitatively worse
than the server's: the server's residue is test doubles, whereas web's is
concentrated in shipped components — `ProviderSetupSection.tsx` (75),
`MessagesTimeline.logic.ts` (33), `MessagesTimeline.tsx` (30), `ChatView.tsx`
(28), `ChatComposer.tsx` (24).

### The chat-surface side-pick — flagged, NOT relitigated

Session 2 decided "chat surface: keep loom's side + fold wave 1". The ledger
records the opposite for several of those files, and HEAD matches:

| file                                                         | ledger mode  | HEAD vs upstream | HEAD vs loom    |
| ------------------------------------------------------------ | ------------ | ---------------- | --------------- |
| `apps/web/src/components/chat/MessagesTimeline.logic.ts`     | `theirs`     | 299 diff lines   | 1059 diff lines |
| `apps/web/src/components/ChatView.logic.ts`                  | **`FAILED`** | 212 diff lines   | 915 diff lines  |
| `apps/web/src/components/chat/ComposerCommandMenu.tsx`       | `theirs`     | —                | —               |
| `apps/web/src/components/settings/SettingsPanels.tsx`        | `theirs`     | —                | —               |
| `apps/web/src/components/settings/ProviderSettingsPanel.tsx` | `theirs`     | —                | —               |

HEAD sits far closer to upstream than to loom on both of the big two, and
`ChatView.logic.ts`'s resolution is recorded as having **failed outright**. That
is consistent with the error cluster in those exact files.

This is a decision-level discrepancy, not a code bug, so session 5 did not act
on it. **The parent must decide** whether the chat surface is meant to be
upstream's (in which case the remaining web errors are ordinary reconciliation)
or loom's (in which case a large part of `apps/web` needs re-resolving from
loom's side, and fixing the current errors one by one is wasted work).
Everything else in web should wait on that answer.

### What was actually repaired

**`apps/server/src/server.test.ts`: 365 → 0.** One root cause, exactly as the
brief predicted, but it was dropped hunks rather than fixture drift: the merge
deleted five `Layer.mock` entries from the test harness — `EnvironmentTheme`,
`UsageLimitSources`, `ThreadDeletionReactor`, `PullRequestSyncReactor`,
`AnalyticsService` — the test-side mirror of the five runtime layers session 4
restored into `server.ts`. Restored, plus upstream's `readThreadEvents` /
`getThreadReplayStats` engine defaults.

Then four tests that the merge had **spliced from two different parents** — the
header of one test welded onto the body of another. The giveaway in each was a
self-contradiction, e.g. `cleans up created bootstrap threads` asserted
`thread.delete` IS dispatched and then, twenty lines later, that it never is:

- `bootstraps first-send worktree turns …` — upstream's body restored, with
  loom's gated `completion` and its `setup-script.completed` assertion folded
  back on top (loom's `WorktreeProvisioner` is fork-only and appends that
  activity; upstream has no such reactor).
- `does not misattribute setup activity dispatch failures …` — upstream's body,
  and upstream's whole `it.effect.each` async/sync/cancel block restored (it had
  been deleted entirely, leaving its body attached to the previous test).
- `cleans up created bootstrap threads …`, `subscribeServerConfig republishes …`,
  `ignores invalid client telemetry …` — upstream tails restored.
- `buffers thread events published while the initial snapshot loads` — **loom's**
  version restored, because loom's ws.ts thread path attaches eagerly via
  `subscribeDomainEvents`, which is what HEAD's `ws.ts` does.

**`ProviderService.test.ts`: 99 → 0.** `makeFakeCodexAdapter` had upstream's
signature `(provider, supportsConversationRollback?)` on top of a body using
loom's `options` object; loom's pi/grok fake adapters, `piSessionFile`,
`WorkspaceLeaseTestLive` and the shutdown-binding `before` read had all been
dropped. Signatures unioned, declarations restored,
`WorkspaceLease` → `WorkspaceOccupancyLease` import re-homed.

**A dead upstream feature restored.** `ProjectSetupScriptRunner.ts` kept loom's
implementation (correct — the `t3code-setup-state.json` breadcrumb is loom's),
but dropped upstream's `observeCompletion.onOutputLine` forwarding. The field
was still declared and `ws.ts:1396` still passes it to feed
`worktreeSetupTracker.appendTail`, so **the worktree setup card's live output
tail silently never populated**. Upstream's line-splitting, control-character
stripping and length caps re-homed onto loom's terminal subscription.

**Bulk fixture/mechanical work.** Duplicated import blocks merged in 7 server
and 21 web files (a generic deduper handled `import {X}` / `import type {X}`
pairs for the same module). Loom's fork fields added to the test fixtures that
had drifted: `queuedMessages` (25 sites), `defaultStartFromOrigin` (10),
`goals` (5). Upstream's stale `ReviewCommentContext` interface dropped in favour
of loom's schema-derived type.

### Gate status

| gate                              | state                                                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `vp run typecheck`                | **RED** — web 635, server 176, mobile 63; 11 packages green                                                    |
| `pnpm build`                      | not attempted (gated on typecheck)                                                                             |
| `vp check`                        | not attempted (gated on typecheck)                                                                             |
| PR #191 WS transfer budget        | not attempted                                                                                                  |
| migrations 041–053 smoke          | not attempted                                                                                                  |
| targeted test run                 | not attempted                                                                                                  |
| composition audit vs both parents | **not done** — but see the two defects above, both found by the same lens                                      |
| ledger audit (269 dropped hunks)  | partial — `server.test.ts` (20), `ProviderService.test.ts` (11), `ProjectSetupScriptRunner.ts` (8) adjudicated |
| `importPastedComposerText`        | still unadjudicated                                                                                            |

### What the next session should do, in order

1. **Get the parent's answer on the chat-surface side-pick.** Everything in
   `apps/web` is downstream of it. Do not start web reconciliation before it.
2. `apps/server` 176 → 0. Almost entirely one mechanical move: whole-shape
   `Layer.succeed(<Service>, {...})` doubles → `Layer.mock(<Service>)({...})`.
   The missing members split cleanly by parent — `removeIfStopped` is loom's,
   `readStreamEvents` / `getSession` are upstream's.
3. `apps/mobile` 63 → 0 per session 4's guidance (unchanged).
4. Then, and only then, brief items 3–8.
5. The structural composition audit (brief item 4) is still owed and is the
   highest-value remaining check. Session 5's two defects are both proof that it
   finds things typecheck cannot: **extend its lens to include module-level
   import cycles and `package.json` dependency lines**, neither of which session
   4's declaration-level sweep looked at.

### Open questions for the human

1. **Chat surface: upstream's or loom's?** Session 2 decided loom's; the merge
   took upstream's for `MessagesTimeline.logic.ts` and others, and
   `ChatView.logic.ts`'s resolution is recorded `FAILED`. This changes the size
   and the nature of the remaining web work substantially.
2. Sessions 3 and 4 reported a gate (`apps/web` typecheck) as green when it was
   not, most likely because the worktree's `node_modules` predated the merge.
   Worth deciding whether the reviewer gate should require a recorded `vp i` +
   full `vp run -r typecheck` transcript rather than a per-package claim.

## Session 6 — the chat-surface cluster is on loom's parent; `apps/web` 635 → 117

The orchestrator resolved session 5's escalation: **the whole chat-surface
cluster comes from loom's parent**, not just the four components sessions 1–2
picked `--ours`. That was implemented, and it is the reason the count moved:
restoring the loom-side logic modules removed **218 errors in one commit**, and
the four big test files (`MessagesTimeline.logic.test` 101,
`MessagesTimeline.test` 61, `ChatMarkdown.test` 17, `ChatView.logic.test`) went
straight to zero — they were failing because loom's components were being
checked against upstream's logic.

Seven commits, `a04a73b564` … tree clean, nothing pushed, every commit
`--no-verify`, no rebase, `116eff1261^2` = `c14f6015bf` re-verified after each.

### What the re-home actually restored

`git show 5c350f7a63:<path>` for `ChatView.logic.ts`,
`chat/MessagesTimeline.logic.ts`, `chat/ComposerCommandMenu.tsx` and their four
test companions, then the minimum v0.0.43 adaptation:

| adaptation                                                     | why                                                                                       |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `isImageAttachment()` instead of `attachment.type === "image"` | upstream's attachment union has an open member, so a literal comparison no longer narrows |
| `pullRequests: []` in `buildLocalDraftThread`                  | new required `EnvironmentThread` field                                                    |
| `TimelineDurationMessage.role` widened with `"reasoning"`      | loom's ephemeral reasoning v2 rows                                                        |
| `dismissible: payload.responseMode === "message"`              | new required `PendingUserInput` field                                                     |
| `workEntryDisplayIndicatesToolFailure` at the render site      | upstream's fix: a rendered row must not read the user's own command as error output       |

Six **loom-only modules the merge deleted outright** were restored because the
kept components import them: `chat/changedFilesPresentation.ts`,
`chat/userMessageTerminalContexts.ts`, `chat/ComposerPreviewAnnotationCards.tsx`,
`chat/modelPickerModelHighlights.ts`, `providerSkillPresentation.ts`, and
loom's collapsible `chat/ChangedFilesTree.tsx` (upstream's per-file context-menu
handler folded onto it). The full list of **46 loom-only `apps/web/src` files the
merge deleted** is at
`docs/upstream-sync/25-session6-loom-only-web-files-deleted.txt`; the rest are
either upstream's deliberate dead-code deletions (`ui/card.tsx` et al, upstream
#9129) or test files. **That list is not fully adjudicated** — it is a
lost-feature checklist for the reviewer gate.

`lib/{terminalContext,elementContext,previewAnnotation}.ts` were **unioned**:
loom's trailing-block context API (which the kept components call) alongside
upstream's new reference-based API (which `composerContextRecords.ts` /
`ComposerPromptEditor.tsx` call). Neither side was dropped.

### Two features the merge made unreachable, now restored

**1. The whole Pi-first provider setup surface.** `ProviderSetupSection.tsx`'s
75 errors — the single biggest file cluster in `apps/web` — were **one** cause:
the merge deleted **nine provider auth/install entries** (`providerAuthState`,
`startProviderAuth`, `completeProviderAuth`, `cancelProviderAuth`,
`logoutProviderAuth`, `providerInstallState`, `startProviderInstall`,
`cancelProviderInstall`, `removeProviderInstallation`) from
`packages/client-runtime/src/state/server.ts`'s environment-data object. Every
consumer survived. Restored; 75 → 0. `hostResources` was missing from the same
object (the load-balancing hook could not read host load) and is also restored.

**2. `workspaceMutationId`.** Upstream added a workspace-mutation refresh key so
git status and the file preview refresh when the agent changes the tree; loom's
`ChatView.tsx` lost the memo, the `useWorkspaceMutationRefresh` call and both
prop hand-offs. Restored.

Also restored: `ContextWindowMeter`'s **Compact context button** (upstream's
block was deleted from the render while its props survived); loom's
`/settings/worktrees` route (`routeTree.gen.ts` kept only the import, so the
route was unreachable); loom's client-side `sidebarAutoSettle*` settings (the
merge kept only upstream's identically-named **ServerSettings** keys); loom's
`changeRequest` input to `useThreadActionMenu` (the chat header's settle state
had silently degraded to `settledOverride` only).

### Decisions taken (not silent drops)

**Element contexts in the composer are gone, deliberately.** Loom's
`addElementContext` slice had **no production caller in either parent** —
upstream migrated element picks into preview annotations, and HEAD's draft
decoder already performs that migration (`elementContextToPreviewAnnotation`).
Removing the residual `elementContexts` wiring from `ChatView`, `ChatComposer`
and the store is the clean deletion, not a lost feature. `ComposerPendingElementContexts.tsx` deleted with it.

**`reviewCommentContext` stays loom's discriminated union** (`line` |
`mdx-anchor`). Upstream's new context-record layer assumed the flat shape; it
was narrowed to the `line` variant rather than flattening loom's union.

**`auto-settle` now has two same-named settings** — loom's client-side
`ClientSettings.sidebarAutoSettle*` and upstream's server-side
`ServerSettings.sidebarAutoSettle*`. Session 4's decision ("teach the server the
blocker, no switch, no disabled sweep") keeps both rules, so both settings are
kept. They can disagree if a user edits one. **A wart worth a human's eye.**

### ⚠️ Two things the parent must decide

**1. Upstream's ChatMarkdown grew six capabilities loom's kept version does not
have.** `imageBaseDir`, `headingLevelOffset`, `environmentId`,
`extraRemarkPlugins`, `githubMedia`, `pullRequestPanelRef` — consumed by
`FileMarkdownPreview` (images in a previewed markdown file resolve relative to
its directory), `ProposedPlanCard` (heading offsetting) and
`PullRequestMarkdown` (GitHub media + remark plugins). To make the tree compile
the **call sites now omit them**, which degrades those three merged surfaces.
This is a real capability gap, not cosmetics, and it needs an explicit choice:
fold the six into loom's ChatMarkdown, or accept the degradation. Task
`c75b1bb5`.

**2. Upstream's Device panel and thread pull-request surfaces are merged but
unwired.** `RightPanelTabs` (upstream's) requires `onAddDevice` /
`deviceAvailable` / `onAddPullRequests` / `pullRequestsAvailable`; loom's
`ChatView` has no `addDeviceSurface` (it needs `useDeviceState` and the device
onboarding dialog) and no pull-requests surface. They are wired to `noop` +
`false` **explicitly**, so the cards render unavailable rather than faking the
feature. Same class as pull 6's unmounted Agents panel. Task `2cfc0a7d`.

### Gate status

| gate                                            | state                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `vp run typecheck`                              | **RED** — web 117, server 176, mobile 63; 11 packages green (re-verified after the contracts/client-runtime edits) |
| `pnpm build`                                    | not attempted (gated on typecheck)                                                                                 |
| `vp check`                                      | not attempted                                                                                                      |
| composition audit vs both parents               | **not done**                                                                                                       |
| migration smoke, PR #191 budget, targeted tests | not attempted                                                                                                      |

### New tool

`docs/upstream-sync/pull7-tools/restoredecl.py <rev> <path> <name>...` — pulls a
named top-level declaration (with its leading comment) out of a merge parent and
appends it to the working file, skipping names already declared. It over-extracts
on multi-line `new Set([...])` initialisers; eyeball what it appends.

### What the next session should do, in order

1. **Finish `apps/web` (117).** Source first (68); the three biggest test
   clusters are one root cause each (see
   `docs/upstream-sync/25-remaining-typecheck-errors.txt`).
2. `apps/server` 176 → 0 (`Layer.mock`, per session 5).
3. `apps/mobile` 63 → 0 (per session 4).
4. Then the untouched gates: build, `vp check`, the composition audit, the
   migration smoke, PR #191's transfer budget, and the targeted test run.

---

## Session 7 — `apps/web` 117 → **0**; `apps/server` 176 → 26

19 commits (`592cb380a8` … `6025e1660a`), tree clean, **nothing pushed**, every
commit `--no-verify`, no rebase, `116eff1261^2` = `c14f6015bf` re-verified after
each. `vp i` first.

`vp run typecheck` now reports **13 of 15 packages green**; only `apps/server`
(26) and `apps/mobile` (63, untouched) remain. Per-file inventory refreshed in
`docs/upstream-sync/25-remaining-typecheck-errors.txt`.

### Five loom features the merge had silently broken (not "test drift")

Each of these compiled only because the _caller_ had been deleted along with the
declaration, or degraded silently. They are the real value of this session.

1. **The provider "show only selected models" curation surface.** Loom's
   `selectedModels` / `showOnlySelectedModels` allow-list is persisted in
   `packages/contracts/src/settings.loom.ts`, written by
   `ProviderSettingsPanel`'s `updateProviderModelPreferences`, and _read_ by
   `modelSelection.ts` and the model picker — but the merge took upstream's
   settings render, which has no toggle and no bulk select. A user who had ever
   enabled it could not see the setting, edit the list, or turn it off: a
   one-way door. Restored the toggle and the bulk Select/Deselect buttons on
   upstream's list model, threaded the four props through
   `ProviderInstanceCard` → `ProviderSettingsPanel`, and introduced
   `pickerHiddenSet` so the row switches, group headings and counts describe
   whichever curation mode is active instead of always describing upstream's
   deny-list.
2. **Terminal-context composer chips.** `lib/terminalContext.ts` still writes
   `\uFFFC` placeholders and the Lexical editor still renders
   `ComposerTerminalContextNode`, but the merge took upstream's one-argument
   `splitPromptIntoComposerSegments`, which has no `terminal-context` variant.
   Chips would have rendered as invisible placeholder codepoints. Restored the
   variant and the two-argument signature, and taught `composer-logic.ts`'s two
   cursor mappings and `composer-list-continuation.ts` to count a chip as one
   codepoint in both coordinate spaces.
3. **`moveComposerPromptAndImages`.** Deleted from `composerDraftStore`, its
   only caller (`useHandleNewThread`, the draft-changes-project path) survived.
   Rewritten against HEAD's draft shape (`files`, `ensureInlineContextReferences`)
   rather than restored verbatim.
4. **The Sidebar's quantised settle clock.** `const now = nowMinute…` was
   dropped while `nowMinute` stayed in the memo's dependency list, and the row's
   `autoSettleOnMerge` prop was dropped while its consumer stayed. Restored both
   (prop-drilled deliberately — one subscription in the list, not one per row).
5. **`setProjectDraftThreadId` had lost `environmentSelection` and
   `loadBalancedEnvironmentId`** from its options type while still forwarding
   them to `setLogicalProjectDraftThreadId`.

Also repaired: two stray `export` keywords inside function bodies
(`contextWindow.ts`, `providerInstances.ts` — mechanical-resolution damage that
`rg '^\s+export (const|function|let) '` finds repo-wide); a **duplicated
`EventRouter` mount** (loom's unguarded one survived beside upstream's
inside `FirstRunGate`, whose comment explicitly requires it to be gated); a
duplicated `NoProjectsHero` (the shared component gained a `header` slot so the
index route keeps loom's thread-tabs strip without a 30-line copy).

### A dependency-resolution bug the merge introduced

`@types/hast` resolved to **two versions at once**. Upstream never sees this —
its `apps/web` has no MDX chain — but loom's `@mdx-js/mdx` / `remark-mdx` pull
`3.0.5` in beside the `3.0.4` that `hast-util-to-html` / `-to-jsx-runtime`
resolve, and `@types/hast` is a structurally module-augmented type, so two
copies mean two incompatible `Element`s. Upstream's `HighlightedCodeLines.tsx`
(byte-identical here) could not compile. Fixed with a one-line
`"@types/hast": 3.0.5` override in `pnpm-workspace.yaml`, in the same spirit as
loom's existing `astro>esbuild` pin, and **verified by reverting it** (79 errors
with, 69 without → the override is load-bearing, not cargo-culted).

> **Trap for the next session:** `apps/web` and `apps/server` are
> `composite: true`, and a stale `tsconfig.tsbuildinfo` makes `tsc` re-report
> cached errors against paths that no longer exist. Delete it before trusting a
> count; this cost real time above.

### One deliberate, documented divergence from the migration doctrine

`apps/server/src/persistence/Migrations.ts` is **no longer byte-identical** to
upstream: `migrationEntries` is `export`ed (plus a two-line comment saying why).
Doc 22 §3.2 asks for byte-identity, and the merge had correctly reverted loom's
divergence — but `LoomMigrations.test.ts`, the guard that proves the two-lane
split is schema-equivalent to the pre-split single ledger, replays the
_historical interleaved order_ and therefore needs upstream's migration
**bodies**. `migrationManifest` exposes only `[id, name]`, and
`runMigrations({ toMigrationInclusive })` cannot express
"upstream 1–32, then fork 1001–1032 renumbered to 33–64, then upstream 33/34 as
65/66". Loom's parent `5c350f7a63` already carried exactly this one-word
divergence, so this is a _restored_ fork state, not a new one. The practical
conflict surface stays nil: upstream appends _inside_ the array, never on the
declaration line. **Flagged for the reviewer** — if byte-identity is to be
absolute, the alternative is to move the equivalence guard's fixture into
`LoomMigrations.ts` and accept duplicating 34 migration bodies.

### Two test files/cases deleted rather than faked green

- `apps/web/src/components/ChatMarkdown.workspace-images.test.tsx` — tests
  upstream's asset-URL workspace-image pipeline (`ChatMarkdownAssetImage`,
  signed URLs, aspect-ratio reservation). Loom's merged `ChatMarkdown` has **no
  image handling at all** (`grep` for `img`/`assetUrls`/`aspect-ratio` finds
  nothing), so the whole file targets an unadopted component. It belongs with
  the deferred ChatMarkdown re-home (task `c75b1bb5`) and should come back with
  it.
- Two `composer-logic.test.ts` cases calling `carryDisplacedCustomAnswerIntoPrompt`
  from the deleted web-local `pendingUserInput.ts`. Loom replaced that module
  with the shared `@t3tools/shared/userInputAnswers`, which has no equivalent
  (loom's PendingQuestionCard does not displace custom answers into the prompt).

### Two upstream capabilities accepted as degraded (both tracked)

- `ThreadRouteView` no longer passes upstream's `threadSyncPhase` to `ChatView`:
  loom's kept `ChatView` has no consumer for it and wiring one is chat-surface
  work (wave 2). Same class as the ChatMarkdown decision the orchestrator made.
- Upstream's "Previous question" navigation in `ComposerPrimaryActions` (its
  `pendingAction` prop) does not exist on loom's kept component; the dangling
  `onPreviousPendingQuestion` destructure was removed. Covered by the standing
  session-2 decision that the chat cluster comes from loom's parent.

### Two structural test-suite improvements worth keeping

- **`apps/server/src/orchestration/deciderTestThread.ts`** (new): one shared
  `loomThreadFixtureDefaults` / `loomThreadShellFixtureDefaults` block for the
  ~27 fork workstream fields every thread fixture needs. Twelve test files
  previously pasted that block by hand, which is precisely why one upstream
  field (`goals`, `defaultStartFromOrigin`, `pullRequests`) broke a dozen files
  at once. Future pulls now touch one file.
- **`Layer.mock(Tag)({partial})` instead of `Effect.provideService(Tag, {whole})`**
  for service doubles (applied across the `serverRuntimeStartup` suites).
  `Layer.mock` fills unimplemented members with defects, so a member upstream
  adds next pull no longer breaks every double that never calls it.
- `ThreadDeletionReactor.test.ts` adopted upstream's `drainThrough(sequence)`
  fence, which let the poll-until-count loop (and its apologetic comment) go —
  in line with AGENTS.md's "wait on receipts, never on sleeps or polling".

### Open question for the human

`Migrations.ts` byte-identity vs the two-lane equivalence guard (above). The
session-6 open items (two `sidebarAutoSettle*` settings; the 46 deleted
loom-only web files) are unchanged and still want a decision.

### Brief items: done / not done

- **Item 1 (`apps/web` 117 → 0) — DONE.**
- **Item 2 (`apps/server` 176 → 0) — PARTIAL: 176 → 26.** All remaining are in
  test/integration files; the recurring classes are solved and documented, the
  26 are a genuine long tail of one-offs.
- **Item 3 (`apps/mobile` 63 → 0) — NOT STARTED.**
- **Items 4–10 — NOT STARTED:** the green-typecheck commit, the structural
  composition audit, `pnpm build` + `vp check`, PR #191's transfer budget, the
  migration smoke on a DB copy, and the targeted test run.

## Session 8 — every gate green: typecheck (15/15), `vp check` (0 errors), build (minus a host prerequisite), migration smoke

Commits `e2d54f0b1d` … `9132eb93a8` on `t3code/upstream-sync-20260921`, all
`--no-verify`, no rebase, `116eff1261^2` re-verified as `c14f6015bf` after each.
Nothing pushed.

| gate                             | result                                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `vp run typecheck`               | **green, all 15 packages** (server 26 → 0, mobile 63 → 0, relay 3 → 0)                                                  |
| `vp check`                       | **0 errors** (969 warnings, the standing baseline)                                                                      |
| `pnpm build`                     | web, server, marketing ✓ — `apps/desktop` fails on a MISSING HOST PACKAGE (`libsecret-1-dev`), not on merge state       |
| Migration smoke (4.2 GB DB copy) | **clean**: 041–053 applied exactly once, fork lane `1001+` untouched, relaunch applies zero, fresh-DB schema equivalent |
| PR #191 transfer budget          | still cannot produce a number (below)                                                                                   |

### Five runtime defects the gates caught that typecheck could not

1. **`getTurnStartMessage` could never decode.** Upstream's new query is
   byte-identical to its own, but it decodes into _loom's_ wider message row
   schema, so the SELECT was missing `origin`, `control_payload_json` and the
   three `reasoning_*` columns. Every turn start failed with a
   `PersistenceDecodeError`, the provider command reactor stopped processing the
   event, and no turn ever quiesced — the integration harness simply timed out.
2. **`getShellSnapshot`'s thread query omitted `unsettled_at`**, failing every
   shell-snapshot decode the same way.
   → Both are one class, and there is now a sweep for it:
   **`docs/upstream-sync/pull7-tools/sqlcolsweep.py`** (a SELECT that omits a
   column its `Result` schema requires). Run it every pull; it is clean at HEAD.
3. **The projector's `thread.meta-updated` arm took loom's side wholesale** and
   lost upstream's `activeOrderKey`, `titleState` and `branchPullRequest`. The
   decider still emits `activeOrderKey`, so **the manual active-list reorder was
   a silent no-op**; `decider.active-order.test.ts` proves it again (8/8).
4. **`ProviderUsageLimitsIngestionLive` was imported but never composed** —
   found by the structural composition audit. Usage bars would have waited for
   the next status probe instead of following live rate-limit telemetry.
5. **`apps/web/src/index.css` did not parse.** The mechanical resolution left an
   unterminated `:hover` rule and an unbalanced `@starting-style` block, and
   separately dropped loom's whole `.chat-composer-glass-*` material while
   `ChatView` still applies those classes (the composer would have lost its
   glass). CSS never typechecks — only `pnpm build` sees this.

### Structural composition audit (owed since session 4) — table

Every entry present in either parent but absent from HEAD was accounted for:

| surface                                                       | verdict                                                                                                                                                                                                                                      |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts` layer roots                                       | **1 real loss, fixed** (`ProviderUsageLimitsIngestionLive`); the other 14 names are all still composed                                                                                                                                       |
| `bin.ts`, `serverRuntimeStartup.ts`                           | complete                                                                                                                                                                                                                                     |
| `decider.ts` + `decider.loom.ts` arms vs `LOOM_COMMAND_TYPES` | complete — all 25 fork command types have arms; upstream's three "missing" arms are `reasoning.complete`/`user-input.dismiss` (in `decider.loom.ts`) and `reasoning.delta` (deliberately removed from contracts by loom's reasoning re-home) |
| ws/rpc handler maps, `RpcAuthorization` scope map             | complete                                                                                                                                                                                                                                     |
| `routeTree.gen.ts`                                            | 2 loom routes absent = upstream's own deletion (#11794 replaced the connect callback with Clerk's device grant); no loom feature lost                                                                                                        |
| `client-runtime` environment-data / config projection         | complete — it moved to `state/serverConfigProjection.ts` with all arms plus two new upstream ones                                                                                                                                            |
| contracts structs                                             | 6 field/struct deltas, **all upstream deletions** adopted deliberately (`AuthPairingLink.credential`, `ScopedThreadSessionRef`, two desktop IPC schemas, `enableLegacyTokenStreaming` → `responseStreamingMode`)                             |
| every workspace `package.json` dependency line                | no loom dependency lost: each loom-only line absent from HEAD has zero importers in HEAD's source (`.repos/*` deltas are vendored-reference syncs)                                                                                           |
| package `exports`                                             | one absent (`client-runtime/state/thread-settled`) — the documented pull-6 single-sourcing ruling                                                                                                                                            |
| stray in-body `export`s                                       | none                                                                                                                                                                                                                                         |

### Decisions implemented from session 7's list

- `Migrations.ts` keeps the one-word `export` on `migrationEntries`; **doc 22
  §3.2 now records that exception** and why (`LoomMigrations.test.ts` replays the
  historical interleave and needs the bodies). `Migrations/` is otherwise
  byte-identical to `c14f6015bf`.
- Mobile question card: **upstream's redesign**, restored byte-identical from
  `c14f6015bf` — the merged file was an interleaving of both sides. The caller
  needed no change (it was already upstream's); the _dead_ loom props
  (`activePendingUserInputCount`, `dismissingUserInputId`) were removed from the
  `ThreadDetailScreen` → `ThreadRouteScreen` chain. `use-selected-thread-requests.ts`
  and `lib/scopedEntities.ts` likewise restored to upstream's side.
  **Note for the reviewer:** session 7's ledger recorded the ownership of these
  props BACKWARDS (`maxHeight`/`collapsed`/`onToggleCollapsed`/`onStopThread` are
  upstream's, not loom's). Loom's accepted losses here are its option previews,
  multi-select, pending-count line and dismiss spinner (`a4b1ddfa`), plus its
  persisted/evicting draft store (`state/user-input-drafts.ts` is now unused on
  mobile — it is label-keyed, while upstream's card is option-_value_-keyed).
- `@types/hast` override and the two deleted test files: accepted, unchanged.

### New shared default block

`loomThreadDefaults` / `loomThreadShellDefaults` now live in
`packages/contracts/src/orchestration.loom.ts`, beside the schema that adds the
fields; `apps/server/src/orchestration/deciderTestThread.ts` re-exports them
under the fixture names the decider tests already use, and mobile's optimistic
thread shell spreads the same block. One edit per future fork field.

### Still open after this session

- **PR #191's WS transfer budget still has no number.** Defect 1 above was
  blocking it entirely; with that fixed the scenario now runs and fails later,
  on `10 !== 20` messages — the replayed turns persist user messages but not
  assistant ones. Nothing was re-baselined (`7f1902b3`).
- `ProjectionSnapshotQuery.test.ts`: 22 of 58 fail on _fixture_ decode (nested
  `MissingKey`), dormant since the merge because the file did not typecheck
  until this session (`987cc80f`).
- The merged projector has no `thread.pull-request-linked` arm and none of
  upstream's `pullRequestsPatch`/`legacyLinkToPullRequests` machinery — a
  deliberate-looking "kept loom's projector" outcome that needs adjudicating
  (`67922fd8`).
- `apps/desktop` build needs `libsecret-1-dev` on this host (`a7885190`).

## Unmarked-delta sweep

The By-coder diff scope (`88995da42b`) carried **zero `// loom:` markers**. Pull
7 therefore took upstream's `DiffPanel.tsx` and restored only the two dropped
hunks needed to compile; the third — the coder arms of `reviewSectionTitle` and
`selectedCheckpointRange` — stayed dropped, and "By coder → All turns" rendered
an empty diff for a month. Nothing in the pull could have caught it: an unmarked
fork hunk is invisible to the lost-feature audit, to the structural composition
audit, and to typecheck. The surviving `latestCoderTurnCount`, computed and
unused, was the only trace.

`docs/upstream-sync/pull7-tools/unmarkedsweep.sh` makes that class visible. It
joins `git diff --numstat <base>` against a marker count per file, skipping
files absent at the base (loom-only) and the exemptions in
`docs/upstream-sync/unmarkedsweep.allow`. The base is read from
`docs/upstream-sync/UPSTREAM_BASE` — **each cadence pull updates that file to
the new upstream tip** as part of the merge, the same way the sync note is
written.

Two scopes, deliberately different:

- **gate** (no flag) — only the files the current branch changes vs
  `origin/main`. Exits non-zero on any upstream-owned file gaining ≥ 15 changed
  lines with zero markers. Wired into `scripts/ship.ts` beside `vp check` and
  `vp run typecheck`, so `pnpm ship` refuses to push an unmarked fork hunk.
- **audit** (`--report`) — the whole fork delta vs the base; always exits 0.

The gate is branch-scoped **because the accumulated backlog is far too large to
block on**: the first whole-fork run found **161 files** with a non-trivial
unmarked delta — 87 non-test (≈8,700 changed lines) and 74 test (≈14,200). A
repo-wide blocking gate would fail every ship on day one and be switched off
within a day, which is worse than no gate. Retiring the backlog was its own
stack item (below); the gate stops it growing.

Backlog retired (2026-09-22). The whole-fork audit is **clean**: every
upstream-owned file with a non-trivial fork delta now carries at least one
`// loom:` marker, or is exempt in `docs/upstream-sync/unmarkedsweep.allow` with
its reason. 137 files were touched across seven commits, one per package.

| package                                   | files | src | test | notable (b) reverts                                                               |
| ----------------------------------------- | ----: | --: | ---: | --------------------------------------------------------------------------------- |
| root (`scripts/`, `infra/`, `docs/user/`) |     6 |   5 |    1 | dead `T3CODE_HOME` block; licence unicode escape; a swallowed upstream paragraph  |
| `apps/mobile`                             |     6 |   1 |    5 | an import shuffle                                                                 |
| `packages/contracts`                      |     6 |   5 |    1 | duplicate `WsServerSignalProcessRpc` registration; stray `export` on 6 RPC consts |
| `packages/shared`                         |     9 |   4 |    5 | five dropped `applyServerSettingsPatch` arms                                      |
| `packages/client-runtime`                 |    12 |   6 |    6 | —                                                                                 |
| `apps/web`                                |    25 |  14 |   11 | four upstream `markdown-links` describes restored                                 |
| `apps/server`                             |    73 |  35 |   38 | eleven upstream `externalLauncher` editor cases restored                          |

Classification followed the three rules the backlog item set: (a) loom product
gets a marker naming the feature, (b) a hunk that differs from upstream with no
loom purpose is reverted to upstream's text, (c) test files follow their source.
In practice nearly everything was (a) — the fork's thread shape alone forces a
fixture change in ~30 test files. The (b) column above is the interesting part,
because each entry is behaviour the merge silently changed:

- **`applyServerSettingsPatch` (`packages/shared`)** — the pull-7 resolution
  replaced upstream's replacement arms for `projectSettingsOverrides`,
  `defaultModelSelection`, `defaultProjectScripts`, `usageLimitSources` and
  `usagePriceOverrides` with loom's `workstreamModelPresets`/`Profiles`/
  `providerFailover` arms. The five patch keys were still destructured out of
  the merge object, so those settings patches were being **dropped**. Restored
  alongside loom's arms.
- **`scripts/dev-runner.ts`** — upstream's `T3CODE_HOME` block was laid back on
  top of loom's port-scoped dev home, making the feature unreachable (and
  leaving 8 red cases). The dead block is gone, the feature is live again, and
  the `HOST` cases now assert loom's IPv4-loopback default: 80/80 pass.
- **`packages/contracts/src/rpc.ts`** — `WsServerSignalProcessRpc` was
  registered twice in `WsRpcGroup`; six upstream RPC consts had gained an
  `export` nothing imports. Loom's own new RPC consts are module-private for the
  same reason.
- **Dropped upstream tests** — `markdown-links.test.ts` (4 describes) and
  `externalLauncher.test.ts` (11 editor discovery/launch cases) had lost
  coverage of functions the fork does not change. Restored; both files green.

Three files are exempt rather than marked, all in
`docs/upstream-sync/unmarkedsweep.allow`: `third-party-licenses.config.json` and
`packages/shared/package.json` (JSON has no comment syntax; the delta is
licence notices and subpath exports for loom-only modules) and
`apps/web/src/routeTree.gen.ts` (generated — a marker would be erased on the
next regeneration).

Residue, deliberately left: the audit's second list — **marked but thin** (a
file over 200 changed lines carrying fewer than three markers) — still names ~29
files. That list is advisory, not a failure: each of those files is marked, and
placing a marker on every one of their hunks is the re-home's job, not the
sweep's. The gate (branch-scoped, no flag) keeps both lists from growing.

Test-file policy, decided once rather than file by file: **tests are in scope
and are marked like source.** No loom-only test file needed deleting — every hit
was an upstream test file carrying loom additions or loom's thread-shape
fixtures. Where an upstream case pinned behaviour loom deliberately changed
(the Pi-first text-generation default, the dev-runner `HOST` default) the case
was realigned and marked, not deleted.

### A related blind spot in `sqlcolsweep.py` — FIXED

`sqlcolsweep.py` reports "0 problems" against the exact tree whose
`getShellSnapshot()` failed at runtime on real data. `ProjectionThreadDbRowSchema`
is `ProjectionThread.mapFields(…)`; the tool resolves through `mapFields` to the
**base** struct, where `titleState` is `Schema.optional`, so it never learns that
the override made it required. Any query whose Result schema it cannot parse is
also skipped silently (`if fields is None: continue`) and counted as fine. The
tool needs to honour `mapFields` overrides and to report unresolved schemas as
_unchecked_ rather than clean.

**Fixed.** The sweep now resolves `mapFields` chains (`Struct.assign` /
`omit` / `pick` / `evolve`) against the declaration corpus and applies the
overrides, expands a nested row struct (`session: row`) into the columns its
fields name, and prints an `UNPARSED` line with a non-zero exit for any schema
it cannot read — an unreadable schema is a problem, never a pass. Its SELECT
parsing was rewritten alongside (scalar subqueries, `--` comments, single-line
`SELECT col`, a trailing column with no comma), because the stricter rules are
only usable without those false positives. It takes an optional file argument,
which is how its own regressions are tested:

| tree          | expected                           | actual                                                                  |
| ------------- | ---------------------------------- | ----------------------------------------------------------------------- |
| HEAD          | clean                              | `0 problems; 0 unreadable`, exit 0                                      |
| `2130f1187c^` | flags `listActiveThreadRows`       | `SELECT omits ['linkedPullRequest', 'branchPullRequest', 'titleState']` |
| `b276cb4c16^` | flags `getThreadRuntimeContextRow` | `SELECT omits ['lastErrorClass']`                                       |

(`activeOrderKey`, the fourth column that commit restored, is `Schema.optional`
in the row schema and is correctly not flagged.) `aliascheck.py` still reports
one entry — `Schema.Struct @ 2946: missing ['text']` — which is its documented
inline-struct collision (it groups inline results by literal text), not a
finding; `sqlcolsweep.py` now parses inline structs properly and covers that
class.

### Standing reviewer checklist — addition

Alongside the lost-feature audit, the structural composition audit and the
migration-lane check, every cadence pull and every stack PR now also runs
`docs/upstream-sync/pull7-tools/unmarkedsweep.sh` (gate scope; `--report` at
pulls) and confirms `docs/upstream-sync/UPSTREAM_BASE` was advanced to the new
upstream tip. A reviewer who sees a loom hunk with no `// loom:` marker treats
it as a defect in the change under review, not a pre-existing condition:
unmarked is how features get silently dropped.

Added after pull 7: the **PiDriver capability-parity diff** (see "Post-pull-7
stack" below). Loom ships one adapter, so an upstream capability `PiDriver` does
not implement is a feature that no-ops with no error and no log.

---

# Post-pull-7 stack

Pull 7 merged as PR #195 but is **not a deploy point**: `main` carries a stacked
series of follow-up PRs that finish the re-home, and the whole stack deploys as
one. The human's rule throughout: adopt upstream's approach as the baseline and
delete loom's workaround wherever upstream now owns the concern; re-attach only
the behaviour explicitly ruled KEEP; no compatibility shims.

## PRs

| PR   | What it did                                                                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| #195 | The merge itself (`c14f6015bf`), sync note 25                                                                                                                      |
| #196 | Chat re-home slice 1 — `ChatMarkdown` on upstream's, loom's chips/viewer re-attached                                                                               |
| #197 | Upstream's PR-projection arms; `last_error_class` restored                                                                                                         |
| #198 | Diff tab "By coder" scope repaired and marked                                                                                                                      |
| #199 | Auto-settle: the server sweep is the single owner; loom's client rule deleted                                                                                      |
| #200 | Reasoning: upstream's durable rows adopted, loom's ephemeral v2 deleted (doc 26)                                                                                   |
| #201 | PiDriver compaction (pi's `compact` RPC) and conversation rollback                                                                                                 |
| #202 | Child/staged-root provisioning through `WorktreeSetupTracker`                                                                                                      |
| #203 | DB-copy smoke safety guard; `sqlcolsweep.py` overrides; dev-verify recipe                                                                                          |
| #204 | Chat re-home slice 2 — composer closure; loom's question card deleted end to end                                                                                   |
| #205 | Chat re-home slice 3 — timeline on upstream's, 15 marked hunks                                                                                                     |
| #206 | Sidebar ordering: upstream's comparator; loom's activity anchor deleted                                                                                            |
| #207 | Titles: upstream's flow wholesale; `title_provenance` dropped (migration 1039)                                                                                     |
| #208 | Startup phases restored; welded server tests realigned; dead projections deleted                                                                                   |
| #209 | Chat re-home slice 4 — `ChatView` on upstream's with loom at 33 marked seams                                                                                       |
| #210 | Usage: `AccountUsageRegistry` and `/usage` retired onto upstream's Limits page; the poller emits per-account limits; `PiDriver` requests the workstream capability |
| #211 | Stage-4 cleanups — decider first-message dedupe, artefact-chip context menu, bare-filename chips, deep-link residue retired                                        |

Later stack PRs (lint-and-doctrine, and whatever stage 4 still owes) append to
this table. `docs/upstream-sync/UPSTREAM_BASE` records the upstream commit the fork's
merge-base sits at (`c14f6015bf` for pull 7); the ship gate
(`pull7-tools/unmarkedsweep.sh`) diffs against it, so a pull is not finished
until that file is advanced to the new upstream tip.

## Standing drops — three entries struck

The "intentional loom drops" list was inherited unchanged across pulls, which is
how a stale entry survives. Three are now void:

- **DiffPanel working-tree diff** — struck. Upstream defaults its panel to the
  working tree (#12139) with a file tree (#9330); the pull took upstream's
  `DiffPanel` and loom has what the original fork wanted. The old
  `GET /api/vcs/diff` route is already gone from the tree.
- **`pinnedCollapsedThread`** — struck. Doc 23 §D restored it and voided the
  entry; the list re-listed it anyway. HEAD carries upstream's
  `LegacySidebar.tsx` **byte-identical**, feature included.
- **Plan sidebar** — reworded, not a loom drop. Upstream deleted its own
  provider `PlanSidebar` in #5558 ("plans stop hijacking the UI"). Loom's MDX
  plans (`plans/<slug>/plan.mdx` in the file preview, the `mdx-visual-plan` /
  `mdx-visual-recap` skills, the review blocks) are a different product surface,
  unrelated to and unaffected by that deletion. There is nothing to restore.

**The v1 sidebar.** `apps/web/src/components/LegacySidebar.tsx` is byte-identical
to upstream and carries no `// loom:` hunk; the only fork code near it
(`useThreadTabKeyboard` in `routes/_chat.tsx`) is tab-strip keyboard wiring, not
sidebar code. Standing rule: **loom code touching the v1 sidebar is dropped, not
re-homed** — v2 owns loom's navigation (doc 23), and upstream's `sidebar-v2-only`
branch deletes v1 outright. Anything a future merge lands inside `LegacySidebar.tsx`
is a resolution error.

## PiDriver capability parity — a standing check

Upstream declares per-adapter capabilities on `ProviderAdapter` and its features
key off them. Loom ships **one** adapter, so every capability upstream adds is a
feature that silently no-ops on Pi until `PiDriver` implements it — and a no-op
is invisible: no error, no log, just a button that never appears or a recovery
that never runs. Pull 7 produced three of these at once (compaction, rollback,
restart continuation).

**Every pull runs this diff**: the fields of `ProviderAdapterCapabilities` and
the optional members of `ProviderAdapterShape` in
[`apps/server/src/provider/Services/ProviderAdapter.ts`](../../apps/server/src/provider/Services/ProviderAdapter.ts),
against [`apps/server/src/provider/Drivers/PiDriver.ts`](../../apps/server/src/provider/Drivers/PiDriver.ts).
A capability Pi cannot serve is recorded here as a deliberate gap; anything else
is a lost feature.

| Capability / member                               | PiDriver after this stack                                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionModelSwitch`                              | ✓ `in-session` — pi switches model on a live session                                                                                      |
| `emitsExitOnStop`                                 | ✓ `true` — `stopSession` awaits `process.stop()`, the child `exit` emits `session.exited`                                                 |
| `resumeState`                                     | ✓ `session-file` — pi owns a deterministic per-thread `.jsonl`; **no resume cursor exists**                                               |
| `canResumeThread`                                 | ✓ probes the session file, which is what lets recovery restart into the same conversation                                                 |
| `promptlessTurnContinuation`                      | ✗ deliberate — Pi is continued with an explicit prompt; upstream's fallback branch covers it                                              |
| `supportsConversationRollback` / `rollbackThread` | ✓ PR #201 — "Edit from here" works on Pi                                                                                                  |
| `compaction`                                      | ✓ PR #201 — native, pi's `compact` RPC                                                                                                    |
| `respondToUserInput`                              | ✓ native ask-user dialogs, dismissible without a provider round trip                                                                      |
| attachments                                       | ✓ image blocks only (`PI_NATIVE_IMAGE_MIMES`); other types are passed as paths                                                            |
| reasoning                                         | ✓ PR #200 — upstream's durable reasoning rows (doc 26)                                                                                    |
| usage limits                                      | ✓ PR #210 — the poller emits upstream's per-account limits shape, so Pi reaches the Limits page; loom's registry and `/usage` are retired |
| skills                                            | ✓ via pi's `get_commands`                                                                                                                 |
| `uploadFeedback`                                  | ✗ not implemented — upstream's thread-feedback upload is refused for Pi                                                                   |
| text generation                                   | ✓ titles, commits, change-request content and branch names are real one-shot `pi --print` calls (`PiTextGeneration.ts`); stubs deleted    |

**Text generation was the fourth such no-op.** Upstream's title flow ran end to
end on Pi and could still only echo the prompt, because every per-operation
method on `PiDriver` was a deterministic stub (`titleFromText`, `branchFromText`,
`"Update from pi"`) while only the fork's `generateStructured` reached a model.
All of them now run the shared prompt through
[`PiTextGeneration.ts`](../../apps/server/src/textGeneration/PiTextGeneration.ts),
and a failed call fails the operation instead of inventing a placeholder, so
upstream's retry runs and upstream's own fallback (keep the seed title, skip the
branch rename) decides what the user sees.

**The trap this catches, concretely.** Upstream's restart continuation (#9167)
gates on `binding.resumeCursor != null`. Pi never produces a cursor, so the
feature was dead for the entire fork _and_ actively harmful: its reconcile phase
settled every interrupted thread as "Provider session did not survive a server
restart" before loom's own resume could see it. The fix is in upstream's file,
marked: resume state may be a `session-file` driver's on-disk session. **Read the
gate, not just the capability list** — `resumeState` was declared correctly and
the feature was still dead.

## Restart continuation — upstream owns it

Upstream's #9167 (`reconcileProviderSessions`, phase `provider-sessions.reconcile`)
is the single mechanism. Loom's Option-1 resume in
[`apps/server/src/loom/startup.ts`](../../apps/server/src/loom/startup.ts) is
deleted, its tests with it, and `plans/2026-07-16-restart-turn-continuation.md`
is a one-line superseded note. **Two** marked hunks carry the fork's requirements
into upstream's path: resume state may be a session-file session (above); and a
thread is not continued while it is flagged for attention, `cancelled`, or parked
on an open approval whose consumer died with the process — `isRecoveryResumable`
owns that rule for every caller, so this site derives the approval flag from the
read model's activities rather than passing a literal. An open _question_ is not
an exclusion: the fork's later startup scan cancels every boot-inherited
user-input request. What remains in `loom/startup.ts` is the fork's other boot
repairs — stuck-launch recovery, stale pending-turn-start clearing, the
open-user-input scan, and the reset of sessions upstream declined to continue.
Loom defaults `continueThreadsAfterServerUpdate` on because its deployctl/systemd
path does not write upstream's self-updater continuation marker; users can still
disable it in Settings.

**Not carried over: the queued-steer rescue.** Loom's deleted arm folded the
steers a human typed during the interrupted turn into its resume message. That
could never have worked, in either implementation: `queuedMessages` is ephemeral
live state with no column behind it, and `mapSessionRow` hydrates every DB-backed
session with an empty queue, so at boot the list is always `[]`. Rescuing those
messages needs the queue persisted — a real gap, tracked as its own task, not a
line in the continuation prompt.

## Lint and knip — upstream's configuration, no fork exemptions

Both of session 1's open questions are closed. The lint configuration in
`vite.config.ts` is upstream's verbatim: no raised `maxOccurrences` ceilings, no
fork entry in the `no-mobile-uniwind-theme-escape-hatches` allow-list, no
relaxed `react/no-unstable-nested-components`. `knip.jsonc`,
`scripts/knip-schemas.ts` and the `knip*` scripts were already byte-identical.
The one remaining fork line is a `fmt` ignore for `plans/**` (MDX deliverables
the formatter rewrites — the same class as upstream's `.macroscope/ignore.md`).

Doctrine: **a lint or knip finding on fork _code_ is fixed or deleted, never
exempted.** A ceiling entry or an ignore list for a fork source file is a
review-stopping defect. The `plans/**` line is not one of those, and the
distinction is worth keeping straight: it is a _formatter_ ignore for fork
_content_ — `vp fmt` over a single plan rewrites ~400 lines, re-wrapping prose
inside MDX component children and reflowing component attributes, i.e. damaging
a deliverable. No lint rule is silenced for any fork source file. What that cost in practice: three loom test files moved
onto the harness runtime upstream already exposes, one loom mobile component
deleted (it rendered the file preview twice), three unused loom modules deleted,
four unused dependencies dropped, and `Pi/Cli.ts` restructured so knip can see
the bundled pi package rather than needing an `ignoreDependencies` entry.

Gates: `vp check` 0 errors; `knip --include files,dependencies` clean.
`knip --exports` reports **231 unused fork exports** (loom's workstream server
modules, `apps/web/src/loom/*`, the MDX-plan block registry, loom RPCs in
`contracts/src/rpc.ts`) — upstream's own habit is to keep such symbols
module-private, so the backlog is real, but it is a mechanical pass of its own
and several of the MDX-plan entries are reached by name through the registry, so
it is tracked, not swept blind. `knip:production` is noisy for upstream files
too (dev scripts and integration fixtures are not production entries); it is an
exploratory command, not a gate.
