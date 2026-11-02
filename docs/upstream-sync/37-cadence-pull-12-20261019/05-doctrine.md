## 5. Upstream change digest and per-zone resolution doctrine

Doctrine §4.3 (`05-strategy.md`): where upstream now expresses the same
functionality, upstream's mechanism is the baseline and Loom's variant is
deleted. Otherwise upstream wins verbatim and Loom's seam is re-applied behind
`// loom:`.

### 5.1 Three mechanical rules that cover 55 of the 178 markers

- **Rule A — comment-adjacent (51 markers).** Upstream's side is empty; Loom's
  side is a `// loom:` hunk, a Loom comment, or both, next to a comment
  upstream's #19559 deleted. Keep Loom's side, drop upstream's empty side.
  Do not restore upstream's deleted comment. Where Loom's side is only a
  narration comment with no `loom:` marker and no code (e.g. the `DrainableWorker.ts`
  module header, `IdAllocator.ts` line 269, `cli/project.ts` line 2), take
  upstream's deletion.
- **Rule B — upstream-only insertion (4 markers).** Loom's side is empty: take
  upstream's (`cli/project.ts` ×3, `ProviderRegistry.test.ts` ×1).
- **Rule C — React Compiler unwrapping around a Loom hunk.** Upstream turned a
  `useCallback`/`useMemo` into a plain function or a `useStableCallback`, or
  extracted a hook (`useProactivePanels`, `RightPanelSurfaceContent`,
  `useStableRows`), and Loom's hunk was inside the old wrapper or its deps
  array. Take upstream's shape; re-insert Loom's lines inside the new shape;
  drop Loom's deps-array entries (there is no array). If Loom's hunk was a
  gate on the extracted hook's behaviour (ChatView's `previewAnnotating`
  guard on proactive panels), pass it through the hook's input (`enabled:
  … && !previewAnnotating`) with one marked line rather than re-inlining the
  hook.

### 5.2 Server zones

| Area / file | Upstream change | Resolution |
| --- | --- | --- |
| `orchestration-v2/Orchestrator.ts` (2), `ProjectionStore.ts` (1), `RestartContinuation.ts` (1), `runtimeLayer.ts` (1), `ProviderSessionManager.ts` (1), `PullRequestWatchReactor.ts` (1), `ThreadLaunchService.ts` (3), `ThreadSettlementService.ts` (3), `contracts/orchestrationV2.ts` (2) | §4 | Rule A / import unions; `ThreadLaunchService.ts` → upstream verbatim (DL-973 retired); `ThreadSettlementService.ts` → union; `RestartContinuation.ts` → upstream's `CommandPolicy.ts` import plus Loom's `withStashedSteer` import; `runtimeLayer.ts` → union (`GitVcsDriver` + Loom's two) |
| `server.ts` (2), `ws.ts` (1), `serverRuntimeStartup.test.ts` (1), `McpSessionRegistry.ts` (1) | Comment prune | Rule A |
| `cli/server.ts` (1) | Desktop launcher-loss race (`awaitLauncherLoss`) | Union: Loom's `refuseWhenHomeIsLive: true` option on `resolveServerConfig`, then upstream's `run`/`raceFirst` body |
| `cli/project.ts` (3) | `withProjectCliSessionToken` | Rule B ×3 — take upstream's; then §4.3's `t3 project` check decides whether Loom's DL-1102 resolver (in the auto-merged region) is deleted |
| `persistence/Sqlite.ts` (1) | #21122: no planner statistics — `PRAGMA optimize` removed, `sqlite_stat1` cleared on open, `ANALYZE sqlite_schema` to reload; `INDEXED BY` in the two queries that need it | Keep Loom's two-ledger `runAllMigrations()` + `catchTags` (DL-148) in place of `runMigrations()`; take upstream's stats block verbatim; Loom's 128 MB `cache_size` stays. §7.1 row 4 covers the cockpit-DB check |
| `vcs/GitVcsDriverCore.ts` (5), `vcs/VcsStatusBroadcaster.ts` (1), `VcsStatusBroadcaster.test.ts` (1) | Remote refresh under `withRemoteWriteLock` with failure reconciliation (local status re-read after a failed pull/post-pull read); `refuseOptionLikeRefName` guards; `args.push("--", input.path)`; `resolveRemoteBaseRef` for the configured base branch | Loom's repository batch (`remoteStatuses`, DL-99/DL-1010 shape) is hand-interleaved onto upstream's new per-cwd body: the batch keeps its per-entry auto-pull and divergence re-read, and gains upstream's failure reconciliation per entry. Both foreign-home guards stay beside upstream's option-like-ref guards (union). The `topology` parameter and detached-fetch comment (Loom) stay. Tests: union (Loom's foreign-home case + upstream's `it.effect.each` table). **Gate 1 look** |
| `workspace/WorkspaceFileSystem.ts` (2), `checkpointing/CheckpointStore.ts` (2), `relay/AgentAwarenessRelay.ts` (1), `terminal/Manager.test.ts` (1) | Comment prune | Rule A |
| `provider/builtInDrivers.ts` (2) | Upstream adds `AcpRegistryDriver`; env union | Registry stays `[PiDriver]`, `BuiltInDriversEnv = PiDriverEnv` (standing Pi-only ruling); keep the other drivers imported for their usage readers as today; add `AcpRegistryDriver` to the dormant imports only if its usage reader is listed in `BUILT_IN_USAGE_DRIVERS` (check) |
| `provider/ProviderRegistry.test.ts` (2), `provider/ClaudeProvider.ts` (1) | #21042 probe failures recover; `ClaudeCapabilitiesProbe` exported | Test: Rule B + Loom's retired-codex/pi-disabled cases as DL-916. `ClaudeProvider.ts`: keep Loom's `spawnClaudeCapabilitiesProbeProcess` block (upstream never had it) and **mark it** — it is a Loom addition without a `// loom:` line today (Gate 2b asks whether it is dead under the Pi-only registry) |
| `packages/provider-pi/src/server/adapter.ts` (1), `textGeneration.ts` (1), `settings.ts` (1) | Comment prune; `disableExtensions: true` upstream | Rule A; `textGeneration.ts` keeps Loom's `disableExtensions: false` (cliproxy models come from an extension; pre-ruling since pull 9) |
| `packages/provider-core/src/server/managedProvider.ts` (1), `IdAllocator.ts` (1), `usageLimits.ts` (1) | Comment prune only (checked: `managedProvider.ts` has no upstream code change since the base) | Rule A — Loom's fold-based `updateUsageLimits` and retraction stay |
| `contracts/settings.ts` (2) | `sidebarAutoSettleKeepPullRequests` added beside `autoResumeLimitedThreads` | Loom's defaults stay (`contextWindowMeterEnabled: true`, `autoResumeLimitedThreads: true` — standing pre-rulings); take upstream's new field |
| `contracts/rpc.ts` (1) | `WsOrchestrationV2SubscribeCommandOutputRpc` added to the group | Union with `...LoomWsRpcs` |
| `contracts/*` other 6, `shared/*` 2, `client-runtime/connection/driver.ts` (2) | Comment prune; `driver.ts` imports `sendsTokenInClear`, `usableRoutes` | Rule A; `driver.ts` import union (Loom's `makeEnvironmentHttpApiClient` + upstream's two) |
| `pnpm-workspace.yaml` (2), `pnpm-lock.yaml` (14), `apps/server/package.json` (1), `apps/web/package.json` (2), `scripts/*.test.ts` (2) | Effect 4.0.4 → **4.0.5** (`@effect/vitest` patch follows); React **19.3.0** shared from the catalog; Clerk bumps; Expo 58 patch set trimmed/re-cut; new `@expo/ui`, `@expo/fingerprint` patches; `use-sync-external-store` dep; `undici` in the CLI external list; `apps/server` dev script simplified | Catalog: upstream's versions + Loom's `@earendil-works/pi-coding-agent: 1.3.0` line (PR #404; upstream does not depend on it). Patches: upstream's list + Loom's pi patch line. Lockfile: `git checkout --theirs pnpm-lock.yaml`, then `vp i` — never hand-merge. `apps/web/package.json`: upstream's `test` script (`--project unit --project browser`) + Loom's `lint:plan`; deps union (`zod` + `use-sync-external-store`). `apps/server` dev script: upstream's. `cli-external-packages.test.ts`: Loom's `@huggingface/transformers` + upstream's `undici` |

### 5.3 Web zones — the React Compiler sweep

Upstream's web shell now compiles under the React Compiler with no manual
memoisation, enforced three ways at `07d38b8d17`:

- `vite.config.ts` (root): for `apps/web/src/**/*.{ts,tsx}` the compiler's
  bailout rules are errors (`react/hooks`, `react/refs`, `react/purity`,
  `react/immutability`, `react/set-state-in-effect`, `react/set-state-in-render`,
  `react/static-components`, `react/unsupported-syntax`,
  `react/preserve-manual-memoization`, `react/memo-dependencies`,
  `react/exhaustive-effect-dependencies`) and **`t3code/no-manual-memo: error`**
  (`oxlint-plugin-t3code/rules/no-manual-memo.ts`: bans `useCallback`,
  `useMemo`, `React.useMemo/useCallback` and the `"use memo"`/`"use no memo"`
  directives; `memo()` is not banned). Mobile gets the same with
  `allowMemoHooks: true` while it ratchets.
- `t3code/no-hookless-use-function: error` for web and mobile: a `use*`
  function that calls no hook is a plain function the compiler skips.
- `apps/web/src/reactCompilerCoverage.test.ts`: transforms **every**
  non-test `.ts/.tsx` under `apps/web/src` with `oxc-transform-react`'s
  compiler and asserts zero diagnostics. Loom's 151 added web files are in
  that set.

Upstream's own tree has 0 `useMemo`/`useCallback` under `apps/web/src`. Loom's
tree after the merge will have ~113 in 47 fork-only files (top: `mdx-plan/annotation/MdxPlanAnnotationLayer.tsx` 12,
`loom/verifiedFileChips.tsx` 11, `loom/useThreadTabsSync.ts` 10,
`WorkstreamPanel.tsx` 6, `loom/ThreadTabsStrip.tsx` 5, `chat/SearchableModelList.tsx` 5,
`loom/workstreamState.ts` 4, `WorkstreamGraph.tsx` 4, `files/AbsoluteDirectoryPanel.tsx` 4,
`mdx-plan/blocks/*` ~10) plus whatever Loom hunks inside shared files still
wrap. `vp check` fails on each, and the coverage test fails on any Loom file
the compiler bails out of (ref mutation during render, `try/finally` in a
component, etc. — unknown until run).

**S1's rule for the shared files (Rule C, §5.1)** — the 10 `ChatView.tsx`,
7 `Sidebar.tsx`, 6 `ChatComposer.tsx`, 6 `MessagesTimeline.tsx`, 4 `ChatMarkdown.tsx`,
4 `ProviderModelsSection.tsx`, 2 `OpenInPicker.tsx`, 2 `ProviderSettingsPanel.tsx`,
2 `DiffPanel.tsx`, 1 `CommandPalette.tsx`, 1 `AnnotatableCodeView.tsx`,
1 `PullRequestCodeTab.tsx`, 1 `editorPreferences.ts`, 1 `NoProjectsHero.tsx`,
1 `ComposerPendingUserInputPanel.tsx`, 1 `AdaptiveWorkspaceLayout.tsx` (mobile),
1 `use-thread-composer-state.ts` (mobile) markers: upstream's shape, Loom's lines
inside it, no `useMemo`/`useCallback` re-introduced in a web file. Specific
re-homings S1 must do rather than defer:

- `ChatView.tsx` hunk 7 (lines ~7998): upstream extracted the right-panel
  surface switch into `components/chat/RightPanelSurfaceContent.tsx` (#20421).
  Loom's four arms (`tasks` → `GoalTasksPanel`, `workstream` →
  `WorkstreamPanel`, `artifact` → `ArtifactViewPanel`, `dir` →
  `AbsoluteDirectoryPanel`) and their lazy imports (hunk 1) move into that
  component behind `// loom:`; `ChatView.tsx` keeps only `addTasksSurface`
  (hunk 3) and `loomSurfaceActions` (hunk 2) as plain values.
- `ChatView.tsx` hunks 4–5: `hooks/useProactivePanels.ts` replaces the inline
  effect; Loom's `previewAnnotating` gate goes into its `enabled` argument.
- `ChatView.tsx` hunks 6, 8: upstream moved pending approvals and questions
  out of ChatView (#20161); Loom's 3d-4 "reply in chat instead" ref and the
  staged cards (DT-31) stay where their host now is — if the host moved, the
  hunk moves with it.
- `MessagesTimeline.tsx` hunk 2: upstream's `useStableRows(rawRows, …)`;
  Loom's `useLoomTimelineRows` splice happens before `useStableRows`, on the
  raw rows.
- `ChatMarkdown.tsx` hunks 1–3: upstream rewrote inline-code path links for
  the compiler (#20715, #20852, #20818 "find reveal refs stay cached without
  use memo"). Loom's verified-chip pipeline (`verifyChipTarget`, the `.html`
  artefact route, prose/fenced path scanning, `useReferenceLinkRules`) is
  re-applied onto upstream's new shape without `useMemo`. This is the largest
  single web re-apply (≈320 Loom lines); Gate 1 reads it.
- `Sidebar.tsx` hunk 6 (116 vs 24): upstream reworked inbox/search filtering
  (`searchableThreads`, `settledVisibleCount`); Loom's "a flagged thread stays
  in the inbox" predicate is re-applied as one condition.
- `rightPanelStore.ts` (5): Loom's singleton surfaces (`tasks`, `workstream`,
  `dir`, `artifact`), storage version 15 over upstream's 14 (bump to 16 if
  upstream's 14 changed the shape since Loom's 15 was cut — read the migrator),
  `navigateFolder` (upstream, #15045) union.
- `PreviewView.tsx` (3): upstream added `pickActiveRef`/`isMountedRef` and a
  cancel-on-unmount effect; Loom's per-tab pick (`endPreviewPick`) and
  "no cancel on unmount" rule (its test is UD #3, §5.4) stay — Loom's rule
  wins over upstream's unmount cancel (Loom's annotation survives a panel
  switch; Carl-visible, standing from PR #370/pull 10).
- `entities.ts` (1): upstream's `shellParentThreadId(forkedFrom|lineage)` +
  Loom's thread-detail sync error surface — union.
- `MarkdownThreadLink.tsx` (2): upstream renders a router `<Link>`; Loom's
  `ThreadMention` (live state first) stays as the inner presentation.

**S2b's sweep over Loom-only files** is the work Carl sizes in §7.1 row 2.
Under the recommended answer: remove every `useMemo`/`useCallback` in the 47
files (plain values and functions; `useStableCallback` from
`apps/web/src/hooks/` where identity must hold across renders for an effect
or a child's memo), run `vp lint` over `apps/web/src/loom`, `mdx-plan`,
`WorkstreamPanel`, `GoalTasksPanel`, `ArtifactViewPanel`, `AbsoluteDirectoryPanel`,
and run `reactCompilerCoverage.test.ts`; each bailout is fixed at source. A
bailout that cannot be fixed without redesigning the component (the
`mdx-plan/blocks/canvas.tsx` spatial canvas and `MdxPlanAnnotationLayer.tsx`
are the likely cases) is exempted per file — a marked `files:` override in
`vite.config.ts` and an exclusion in the coverage test — with a DL row naming
the bailout, never a `"use no memo"` directive (the lint bans it).

### 5.4 The five modify/delete conflicts (zone D)

Upstream deleted these tests when it moved them into the browser project; git
reports Loom's edit against the deletion. Resolution: **take the deletion**,
then re-home each Loom assertion into the file upstream now has, as a marked
block, in S2b:

| Loom-edited test (deleted upstream) | Loom's assertion | Goes to |
| --- | --- | --- |
| `components/ChatMarkdown.test.tsx` | "loom scanned path links" — a prose path is clickable in place; a quoted path stays plain | `ChatMarkdown.logic.test.ts` (node) if the scanner is testable without a DOM, else `ChatMarkdown.browser.test.tsx` |
| `components/KeybindingsConfigWarning.test.tsx` | a `vi.mock` of `../state/server` (`primaryServerConfigAtom`) for the zed-ssh host read | `KeybindingsConfigWarning.browser.test.tsx` — check whether the mock is still needed under the browser harness; drop it if not |
| `components/preview/PreviewView.test.tsx` | "keeps an in-progress annotation when the view unmounts and remounts" (+ `pickActive` fixture plumbing) | `PreviewView.browser.test.tsx` |
| `components/pullRequest/PullRequestDetailPanel.test.tsx` | review comments carry `kind: "line"` in the fixture | `PullRequestDetailPanel.browser.test.tsx` fixture |
| `components/settings/ProviderSettingsPanel.environment.test.tsx` | pi counted among enabled-by-default drivers (DL-84); Codex fixture opened explicitly because Pi is the global default; allow-list fields in the preferences fixture | `ProviderSettingsPanel.environment.browser.test.tsx` and `ProviderSettingsPanel.logic.test.ts` |

`apps/web/src/test/reactElementTree.ts` and `reactHookHarness.ts` are gone
upstream (replaced by the browser harness). Fourteen Loom-tree tests still
import them; all fourteen are upstream files upstream also deleted or moved, so
the merge removes them. No Loom-only test and nothing in `apps/web/src/preview/`
imports the old helpers (checked).

### 5.5 Mobile, desktop, marketing, new upstream directories

Take verbatim: `apps/mobile/src/components/ui` (39 new files), the Expo 58
patch set, `apps/desktop/src/preview`, `scripts/npm-launcher` (+ its build
scripts and tests), `.github/actions/*`, `packages/source-control-github/schema`
and the 18 new files under its `src/server`, `apps/web/src/components/terminal`
(one hook, `useThreadTerminalActions.ts`). Mobile's five conflicts are Loom
additions beside upstream edits (Rule A or union); `usageProviders.ts` keeps
`pi` first (DL-918 precedent — check for a duplicate key after the merge).

### 5.6 Silently merged files that lost a Loom-side export

`automerged.py` flags three; all are upstream renames whose Loom-touched
consumers upstream also updated, so S1 only confirms typecheck is clean there:
`process/externalLauncher.ts` (`buildFileExplorerRevealPowerShellSource`),
`pullRequest/pullRequestList.logic.ts` (`parsePullRequestQuery`, consumer
`routes/_chat.pull-requests.tsx`), `session-logic.ts`
(`inferCheckpointTurnCountByRunId`, consumer `hooks/useTurnDiffSummaries.ts`).
