# 20 — Cadence pull: v0.0.29-nightly.20260712.791 → v0.0.29-nightly.20260719.845

Fifth steady-state pull, and the first medium-sized one since the initial sync.
Unlike #17–#19 (each a handful of near-isolated commits), this window is a broad
web/server sweep: **70 upstream commits, 352 files, ~17.7k insertions**, with
**18 conflicted files** on the trial merge. Most conflicts were true unions;
three needed genuine re-engineering onto upstream's new shapes (ws.ts snapshot
buffering, the decider workspace-root invariant, the awareness-relay
message-sent semantics), and four marker-less semantic breaks only the
typecheck/tests caught. Australian English.

## Headline

- **Window:** `c1ec1915f` (v0.0.29-nightly.20260712.791, the previous
  merge-base) → `upstream/main` `53e3c98a5` (v0.0.29-nightly.20260719.845).
  **70 commits, 352 files, +17.7k/−1.7k**, web/server-dominated (~8 mobile
  commits).
- **18 conflicted files**, resolved per the clusters below.
- **4 marker-less semantic merge issues** git could not flag — surfaced by
  `tsgo` and the conflicted-area tests, each fixed by mirroring loom's canonical
  pattern.
- **No migrations** in the window. Confirmed: the delta's
  `apps/server/scripts/t3-sqlite-state.{ts,test.ts}` are a CLI query/exec test
  harness, **not** runtime migrations; loom's migrations dir is untouched (max
  is still `060`), so no numbering collision with upstream.
- All three gates green (typecheck **0 errors** across 15 projects, `pnpm build`
  **exit 0**, `vp check` **0 errors**, 21 pre-existing warnings). Targeted tests
  around every resolved surface pass. Live boot smoke on a DB copy passed. Merge
  commit **`48a3f2cd1`**, `HEAD^2 == 53e3c98a5`, both parents intact.
- **Resolved (was an open question):** upstream's #4055 index-route hero landing
  vs loom's goal overview (see below) — option 3 chosen, upstream adopted, not silently
  dropped.

## Per-cluster resolutions

### A. `apps/server/src/ws.ts` — reasoning re-homed onto upstream's connect-gap buffer (3 hunks)

Upstream #4079 ("Fix dropped events during initial thread snapshot") rebuilt
`subscribeThread` to attach live delivery via a single `Queue.unbounded`
(`liveBuffer` → `bufferedLiveStream`) **before** reading replay/snapshot state,
so a domain event published mid-fetch buffers and drains after the snapshot
element. This is the same connect-gap class loom solved for transient reasoning
deltas with a separate `Stream.merge(liveStream, reasoningStream)`.

**Resolution — adopt upstream's shape and migrate loom's reasoning stream onto
it (doctrine: re-engineer Pi capability onto upstream's new shape).**
`OrchestrationThreadStreamItem` already carries the `reasoning-delta` kind (via
loom's `LoomThreadStreamItemMembers`), so the reasoning stream can ride the same
queue. The reasoning-bus subscription is still acquired **before** the snapshot
fetch (`ReasoningStreamBus.subscribe` is scoped for exactly this), then BOTH the
domain `liveStream` and the reasoning stream are `Effect.forkScoped` into the one
`liveBuffer`. Both the `afterSequence` resume path and the snapshot path now just
concat `bufferedLiveStream`, dropping loom's two separate merges and the
afterSequence path's private inner buffer.

Equivalence proven against the three invariants: **(a) no chunks lost mid-fetch**
— the subscription is registered on the main fiber before the snapshot read, so
items published during the fetch sit in the subscription queue and are drained by
the fork; **(b) chunks drain after the snapshot element** — `Stream.concat(snapshot,
bufferedLiveStream)`; **(c) subscription lives for the stream's scope** —
`forkScoped` + scoped `subscribe` are both bound to `observeRpcStreamEffect`'s
stream scope. Validated by `apps/server/src/server.test.ts` (104 tests, 29
subscribeThread/reasoning/snapshot assertions) and `ProviderRuntimeIngestion.test.ts`
(42, the reasoning producer) — all green.

### B. `apps/server/src/orchestration/decider.ts` — convergent workspace-root invariant

Upstream #? "Prevent duplicate project workspace roots" added
`requireActiveProjectWorkspaceRootAbsent(…, exceptProjectId)` — the same
at-most-one-active-project-per-workspace_root invariant loom added as
`requireActiveWorkspaceRootAvailable`. Upstream's helper is **strictly superior**:
it normalises paths (`normalizeProjectPathForComparison`) before comparison and
adds `exceptProjectId` for project-update self-exclusion; loom's did raw string
equality and had no self-exclusion.

**Resolution — adopt upstream's helper wholesale, delete loom's.** Loom's helper
had exactly one call site (the `project.create` case); upstream's is already
wired into both `project.create` and the new `project.meta.update` path
(auto-merged), passing `exceptProjectId: command.projectId`. Loom's helper
definition (`commandInvariants.loom.ts`) and its import were removed. Loom's
explanatory comment about the DB-level structural backstop was preserved on the
`project.create` case — **and its migration reference corrected from "049" to
"050"**: the partial unique index `uq_projection_projects_active_workspace_root`
is migration `050_ProjectionProjectsUniqueActiveWorkspaceRoot`, not `049`
(which is `ProjectionThreadDiffMetrics`). Loom's own test
`decider.projectWorkspaceRoot.test.ts` still passes against upstream's helper
(same "already exists for workspace root" message; soft-deleted re-create still
allowed).

### C. `apps/server/src/relay/AgentAwarenessRelay.ts` — union of cases **plus** an upstream semantics change

The additive part was a clean union: loom's `thread.message-reasoning` case and
upstream's `thread.turn-start-requested` case, both returning `false`, both
comments kept. **But upstream also changed `thread.message-sent`** from loom's
`return !event.payload.streaming` to grouping it with `thread.turn-start-requested`
→ `return false` — a deliberate fix so a message-sent snapshot (which still
carries the previous turn's terminal state) can't queue a spurious "Done" alert
before the provider's authoritative running state arrives. This was NOT flagged in
the cluster brief; it surfaced as a test failure
(`AgentAwarenessRelay.test.ts` expected message-sent → `false`).

**Resolution — adopt upstream's message-sent semantics** (doctrine: upstream
changed this area to fix a real bug loom also wants; provider-lifecycle events
still publish the authoritative running state, so loom's cross-thread awareness
is unaffected). `thread.message-sent` + `thread.turn-start-requested` now share
upstream's comment and `return false`; `thread.message-reasoning` keeps its own
comment and `return false`. `AgentAwarenessRelay.test.ts` green (11 tests).

### D. Web-shell cluster — unions, with the hero-landing deferred

- **`ChatMarkdown.tsx`** — upstream extracted rehype plugins into
  `CHAT_MARKDOWN_REHYPE_PLUGINS`; loom's PR #79 clickable-file-links plugin
  (`rehypeChatFilePaths`, deferred until streaming completes) is layered on top:
  `isStreaming ? CHAT_MARKDOWN_REHYPE_PLUGINS : [...CHAT_MARKDOWN_REHYPE_PLUGINS,
rehypeChatFilePaths]`. (The sanitize schema's loom `file`/`thread` href
  protocols auto-merged intact.)
- **`ChatView.tsx`** — kept loom's guarded `useThread/useThreadShell/
useThreadSyncError(routeKind === "server" ? … : null)` trio (downstream
  `isServerThread = serverThread !== null` depends on it) over upstream's
  unconditional `useThread`; unioned loom's timeline pagination props
  (`hasMoreOlder/loadingOlder/onLoadOlder`) with upstream's `hideEmptyPlaceholder`.
- **`MessagesTimeline.tsx`** — unioned the new props + destructure defaults;
  merged the empty-state guard so loom's fetch-aware condition
  (`… && !hasMoreOlder && !loadingOlder`, keeping the "Load older history" header
  reachable) wraps upstream's `if (hideEmptyPlaceholder) return null`.
- **`SettingsPanels.tsx`** — unioned loom's `reasoningDisplay` and upstream's
  `enableProviderUpdateChecks` settings across all three spots (summary list, dep
  array, restore-defaults).
- **`DiagnosticsSettings.tsx`** — took loom's (empty) side: loom had already
  refactored `DiagnosticsLastChecked`/`DiagnosticsRefreshButton`/`formatBytes`
  into the shared `./settingsLayout` module and imports them, so adopting
  upstream's newly-added **local** copies would have duplicated the bindings.
  Loom's shared versions are behaviourally equivalent (upstream's only adds a
  minor "Checked unavailable" invalid-state label).
- **`useHandleNewThread.ts`** — unioned loom's `contextMode` option and
  upstream's `replace` option (both consumed in the body).
- **`state/shell.ts`** — unioned imports and both atoms: loom's `goalsAtom`
  (goals ride the shell snapshot) and upstream's `allEnvironmentShellsBootstrapped
Atom` (#4055).
- **`_chat.index.tsx`** — see the resolved decision below (upstream's draft-hero
  landing adopted; loom's goal overview retired as deferred product scope).

### E. Mechanical

- **`AGENTS.md`** — kept loom's Task Completion Requirements + fork-specific
  shipping rules. Upstream rewrote its completion bullets to "keep verification
  focused; do not run repo-wide `vp check`/`typecheck`/`test` locally — CI owns
  the full suite." That directly **contradicts** loom's fork workflow (loom runs
  these as local gates — this very sync did), so upstream's replacement was not
  adopted. Loom's rules survive per brief.
- **`terminal/Manager.ts`** — composed both transforms: upstream's
  `stripAppImageRuntimeEnv` (#1699) then loom's `withLocalNodeModulesBin`:
  `withLocalNodeModulesBin(stripAppImageRuntimeEnv(spawnEnv), cwd, platform)`.
- **`scripts/dev-runner.ts`** (3 hunks) — kept loom's port-scoped `T3CODE_HOME:
resolvedHome` (the multi-worktree dev-instance isolation) and **deleted the
  upstream `if (configuredBaseDir …)` block that auto-merged in cleanly** but
  would have destroyed that isolation (a marker-less semantic trap); kept loom's
  IPv4-loopback `HOST` binding (VS Code Remote SSH) while adopting upstream's
  `--browser`-flag NO_BROWSER logic; kept loom's port-scan `busySuffix` log while
  adopting upstream's `baseDir` fallback const. Upstream's `--no-browser` →
  `--browser` dev-runner CLI rename was adopted wholesale (the server's own
  `--no-browser`/`T3CODE_NO_BROWSER` is unaffected — separate flag).
- **`ProviderRegistry.test.ts`** — took loom's (empty) side: upstream added a
  registry-level test asserting 5 providers (`claudeAgent/codex/cursor/grok/
opencode`), incompatible with loom's **pi-only driver registry** (an
  intentional prior drop; `getProviders` returns `["pi"]`). Loom already replaced
  the sibling "lists all six legacy providers" test for the same reason.
- **`packages/shared/package.json`** — unioned loom's `./accountUsage` and
  upstream's `./projectFavicon` exports.
- **`pnpm-lock.yaml`** — see below.

## Marker-less semantic merge issues (caught by tsgo + tests)

1. **`scripts/dev-runner.ts`** — upstream's `if (configuredBaseDir …) { … } else
{ delete output.T3CODE_HOME }` block auto-merged as clean text but would have
   overridden loom's port-scoped `T3CODE_HOME: resolvedHome`. Deleted to preserve
   loom's per-port dev isolation. (Also required renaming stray `noBrowser` →
   `browser` in `dev-runner.test.ts` after upstream's flag rename, and restoring
   loom's default-home port-scoping coverage: upstream's replacement test asserted
   `T3CODE_HOME === undefined`, which contradicts loom's always-set behaviour — it
   is now `"port-scopes the default home and disables browser auto-open"`,
   re-adding the `node:os` import.)
2. **`packages/client-runtime/src/state/threads-sync.test.ts`** — an
   `ACTIVE_THREAD.session` fixture was missing loom's required
   `queuedMessages: { steering: [], followUp: [] }` field (TS2741). Added.
3. **`apps/web/src/components/composerInlineTokenPaste.ts`** — upstream's
   mention-paste code called `token.value` on a boolean-filtered
   `ComposerInlineToken[]` (TS2339). Loom's union adds a `thread` variant with no
   `value`, so the filter was made a proper type-guard narrowing to the `mention`
   arm — the same class as #19's `T3ComposerEditor` thread-token fix.
4. **`apps/server/src/relay/AgentAwarenessRelay.ts`** — the message-sent
   semantics change (cluster C above); the auto-merged test encoded upstream's
   expectation while the merged code kept loom's `!streaming`, until reconciled.

## Lockfile + install

`pnpm-lock.yaml`: took upstream's (`git checkout --theirs`), then installed under
pnpm **11.10.0** (corepack). Same flow as #18/#19:

- First `--frozen-lockfile` aborted on the expected `patchedDependencies`
  config-vs-lockfile mismatch (loom's patches live in `pnpm-workspace.yaml`,
  which upstream's lockfile lacks).
- One `CI=true pnpm install --no-frozen-lockfile` reconciled loom's patched
  dependencies into upstream's tree (the Effect LSP `prepare` patch ran clean).
- Idempotence confirmed: the following `--frozen-lockfile` install is a no-op and
  leaves `pnpm-lock.yaml` unchanged.

## Gates

- **`vp run typecheck`**: **0 errors** across all 15 projects. Only pre-existing
  `suggestion` advisories remain (`WorkstreamFanInReactor`, `discovery.ts`,
  a few `apps/desktop`/test effect-idiom hints) — non-blocking.
- **`pnpm build`**: **exit 0**, all 5 targets.
- **`vp check`**: **0 errors**, 21 warnings — all pre-existing
  (`react/no-array-index-key` in loom's `ComposerQueuedMessages.tsx`,
  `react/no-unstable-nested-components`, `no-unsafe-optional-chaining` in
  `decider.reviewGate.test.ts`, a `postMessage` origin hint), none in the
  resolution surface. `--fix` reflowed one fallthrough comment in
  `AgentAwarenessRelay.ts`.

## Targeted tests (every resolved surface)

| Suite                                          | Result     |
| ---------------------------------------------- | ---------- |
| `server.test.ts` (ws.ts subscribeThread)       | 104 passed |
| `ProviderRuntimeIngestion.test.ts` (reasoning) | 42 passed  |
| `AgentAwarenessRelay.test.ts` (relay)          | 11 passed  |
| `decider.projectWorkspaceRoot.test.ts`         | 2 passed   |
| `ProviderRegistry.test.ts` (pi-only)           | 35 passed  |
| `terminal/Manager.test.ts` (AppImage+bin)      | 50 passed  |
| `ProjectionSnapshotQuery.test.ts` (#3829)      | 15 passed  |
| `threads-sync.test.ts` (client subscribe)      | 10 passed  |
| `scripts/dev-runner.test.ts`                   | 34 passed  |

The `ProjectionSnapshotQuery` workspace-root suite passed (no shape change from
upstream #3829). `Manager.test.ts` needed its two new upstream AppImage tests
updated to account for loom's `withLocalNodeModulesBin` PATH prepend (the strip
still verified via `not.toContain(appDir)` + `endsWith` of the real entries).

## Live smoke test

Built `apps/server/dist/bin.mjs` launched on spare port **13963** against a
_copy_ of `~/.t3/cockpit/userdata/state.sqlite` (1.1 GB + WAL/SHM), with
`T3CODE_HOME`/`--base-dir` sandboxed to a temp dir; the live cockpit on its
default port was never touched. Booted clean: **"Migrations ran successfully"**
with **`migrations: []`** (consistent with zero migration files in the window);
`GET /` → **200**; all workstream services started (provider-session reaper,
`workstream.liveness` — swept 372 real threads from the copy, exhaustion-resume,
subscription-usage poller). No errors/crashes. Process killed, DB copy removed,
port confirmed free.

## Resolved — hero landing adopted, goal overview retired (`_chat.index.tsx`)

Upstream #4055 replaces the index route with `IndexDraftLanding`, which
auto-launches a draft thread for the most recently active project (falling back
to an add-project hero). Loom's index route had rendered the **goal overview**
(goal cards + task trees), with `NoActiveThreadState` when there are no goals.
These are mutually exclusive top-level behaviours for the same route.

The merge initially resolved this file to loom's side and flagged it as an open
question. **The human has now decided: option 3 — adopt upstream's draft-hero
landing wholesale and retire loom's goal-overview surface as deferred product
scope.** `_chat.index.tsx` is now upstream's version verbatim (its
`HostedStaticOnboardingState` was already byte-identical to loom's, so loom
branding — `APP_DISPLAY_NAME`, `hasCloudPublicConfig`,
`COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS` — is preserved), plus a one-line comment
marking the goal overview as deferred so a future reader knows it was intentional.

**Rationale:** goals in loom are not directly navigable — only threads are
selectable in the sidebar, and the goal overview was reachable only by clicking
the "T3 Code" wordmark → `/`. Rendering a goal + task tree with no associated,
selectable thread was a meaningless/broken screen. Upstream's index instead
auto-opens a draft thread ("type to start") for the most-recent project, which
matches how the app is actually driven.

Goal _infrastructure_ is untouched — `goalState`, `TaskTree`, `countGoalTasks`,
`useGoals` remain in use elsewhere (sidebar goal CRUD, `GoalTasksPanel`, the
editable goal header, loom sidebar goal list). Only the index-route overview
_surface_ was removed. A dedicated Goals nav is future product scope.

## Merge topology

`git merge --no-edit upstream/main` produced a normal two-parent merge commit;
all conflict resolutions, the lockfile reconciliation, and the semantic fixes
were committed together as the merge commit (no post-merge amend needed — nothing
was committed before the resolutions were staged). No rebase, no squash, no
flatten. `HEAD^1 == 228513737` (loom `origin/main`), `HEAD^2 == 53e3c98a5`
(upstream). Merge commit **`48a3f2cd1`**. Once this merges into `loom/main` the
merge-base advances to `53e3c98a5`, keeping the next pull cheap. This sync note is
a separate docs commit on top so it can cite the final merge hash.

## Intentional prior drops — NOT "fixed" here

DiffPanel working-tree diff (`/api/vcs/diff`), `pinnedCollapsedThread`, Pi-only
driver registry (upstream's new multi-provider registry test dropped for this
reason), deferred read-only Goals/tasks UI. Left untouched.
