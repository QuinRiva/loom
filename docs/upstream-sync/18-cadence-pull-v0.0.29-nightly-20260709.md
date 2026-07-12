# 18 — Cadence pull: v0.0.29-nightly.20260705.729 → v0.0.29-nightly.20260709

Third steady-state pull, and the first with real semantic conflicts in
Pi-critical files. The window carried upstream's #3719 thread/shell
snapshot-over-HTTP re-architecture, the #3822 worktree-metadata convergence, a
pnpm 10 → 11 toolchain bump, and Clerk/T3-Connect churn. Australian English.

## Headline

- **Window:** `600972084` (v0.0.29-nightly.20260705.729, the previous
  merge-base) → `upstream/main` `f61fa9499` (v0.0.29-nightly.20260709).
  **26 upstream commits, ~221 files.**
- **16 conflicted files** resolved: 2 real semantic re-homes (#3719 sync flow,
  #3822 worktree binding), the ProjectionSnapshotQuery union, the mobile
  cache/codec convergence, the lockfile, and a spray of both-sides test
  fixtures.
- **4 semantic (marker-less) merge issues** git could not flag, all surfaced by
  `pnpm typecheck` / vitest and fixed (below).
- **pnpm 10.24 → 11.10**: lockfile regenerated under pnpm 11; idempotent.
- All three gates green (typecheck 0 errors, build exit 0, `vp check` 0 errors).
  Affected/reconstructed test suites pass. Live boot smoke test on a DB copy
  passed. Merge commit `10fe9f994`, `HEAD^2 == f61fa9499`, both parents intact.

## The #3719 snapshot-sync re-home (the real work)

Upstream `482d56233` re-architected shell/thread sync: the client now
establishes a **base snapshot** (warm cache, else an HTTP fetch off the socket)
and resumes the live stream via `afterSequence`, instead of receiving a
socket-embedded snapshot inside the stream. Loom had customised this exact path.
Decisions:

- **`packages/client-runtime/src/state/shell.ts`** — adopted upstream's
  base-snapshot + `afterSequence` establishment wholesale, and **re-applied
  loom's burst-coalescing** (`Stream.groupedWithin(64, "20 millis")` +
  the batched `applyItems`) to the **live-stream leg** of it. The base snapshot
  is now applied via `applyItems([{ kind: "snapshot", … }])`; the live
  subscription is grouped-then-applied so a command cascade still renders once.
  Kept, not dropped: the coalescing is orthogonal to how the base is
  established.
- **`apps/server/src/ws.ts` (`subscribeThread`)** — adopted upstream's new
  two-branch shape (`afterSequence` catch-up-replay-with-live-buffer, else
  `getThreadDetailSnapshot` fallback) and **layered loom's transient
  reasoning-bus stream onto both branches**. Upstream has no reasoning-bus
  concept, so dropping its shape wholesale would have silently deleted Pi's
  live "Thinking…" streaming. The bus is subscribed _before_ the snapshot/
  catch-up so mid-fetch reasoning chunks buffer and drain onto the snapshot —
  loom's connect-gap guarantee, preserved. Verified the guarantee survives:
  `observeRpcStreamEffect` runs the effect inside `Stream.unwrap` (the stream's
  scope), so the bus subscription lives for the stream's lifetime exactly as
  loom's old `Stream.unwrap(Effect.gen(…))` wrapper ensured.
  - Loom's durable-event pre-subscribe was **not** re-added to the fallback
    branch: upstream's `afterSequence` branch already forks the live PubSub into
    a buffer _before_ draining the catch-up replay (structurally the same
    connect-gap fix), and that branch is the primary path for first-view of an
    actively-streaming thread now. The socket-embedded-snapshot fallback matches
    upstream's own risk posture.
  - Switched the fallback read to upstream's `getThreadDetailSnapshot` (its
    single-transaction detail+sequence read — same dedup-boundary guarantee
    loom's `getThreadDetailSnapshotById` documents). Loom's method is retained
    (see below) because other loom code still calls it.
- **`ProjectionSnapshotQuery` Services + Layers** — **union**: kept ALL loom
  workstream projections (`getThreadDetailSnapshotById`, `getThreadActivitiesPage`,
  `getPendingTurnStartThreadIds`, `getActivityFreshnessByThreadId`,
  `getInFlightToolByThreadId`, `getRecentToolActivityByThreadId`,
  `getThreadProgressSignal`) **and** added upstream's new `getThreadDetailSnapshot`
  to both the interface and the layer's return object.
- **`packages/client-runtime/src/state/shell-sync.test.ts`** — git had tangled
  loom's cascade-coalescing regression test with upstream's new warm-cache
  `afterSequence` test (they share boilerplate). Reconstructed **both** as
  complete tests. Loom's was conformed to the merged contracts: it now provides
  a `ShellSnapshotLoader` (returning `none`, i.e. cold-cache → socket fallback,
  which is the leg it exercises), a `prepared: Some(PREPARED)` supervisor, and
  the four new `EnvironmentCacheStore` methods
  (`loadServerConfig`/`saveServerConfig`/`loadVcsRefs`/`saveVcsRefs`).
- **Mobile cache/codec (`connection/storage.ts`, `connection/catalog-store.ts`)**
  — took **upstream's shape**. Upstream relocated the whole `EnvironmentCacheStore`
  implementation out of `storage.ts` into a dedicated, SQLite-backed
  `connection/environment-cache-store.ts` (wired in `persistence/layer.ts`),
  which fully supersedes loom's old file-based inline cache (verified it covers
  `loadThread`/`saveThread`/`removeThread`). `storage.ts` now matches upstream
  byte-for-byte; `catalog-store.ts` dropped loom's duplicate `decodeUnknownResult`
  codec pair + `Effect.fromResult`/`JSON.parse` wrappers in favour of upstream's
  direct effectful JSON-string codecs.

## The #3822 worktree-binding convergence (both sides fixed the same bug)

Upstream `3201e00ad` "Preserve worktree metadata during branch sync" addresses
the same stale-binding erasure loom had fixed independently.

- **`apps/web/src/components/GitActionsControl.tsx`** — adopted upstream's
  `resolveThreadBranchMetadataPatch(branch, expectedBranch)` helper **wholesale**
  and dropped loom's manual `worktreePath` omission + comment. Read the helper
  first: it returns only `{ branch, expectedBranch }` and never emits
  `worktreePath`, so it inherently preserves a server-provisioned binding — the
  same protection loom achieved by omission.
- **`apps/server/src/orchestration/decider.ts` (`thread.meta.update`)** — kept
  **both** loom additions layered onto upstream's reworked case: (a) the
  goal-in-project validation for `command.goalId` (Pi-critical — upstream has no
  goals concept), and (b) the binding-clear warning. Retained the warning atop
  upstream's `expectedBranch` guard: it is log-only and still surfaces any
  _other_ client clearing a live binding, even though the client-side patch
  helper no longer echoes `worktreePath`. Upstream's `expectedBranch` stale-branch
  guard was adopted (it feeds the `branch` value used in the emitted payload).

## The 4 semantic (marker-less) merge issues

Git auto-merged the text cleanly; only typecheck/tests surfaced these.

1. **`packages/client-runtime/src/state/server.ts` (source!)** — upstream added
   server-config caching (`loadServerConfig` → `Option.map(cachedConfig, …)`),
   a construction site that predates loom's `accountUsage` field on
   `ServerConfigProjection`. The clean auto-merge produced a projection literal
   missing `accountUsage`. Re-homed loom's field: cache-restored projections
   start with `accountUsage: []` (empty until the first live usage event).
2. **`packages/client-runtime/src/state/server.test.ts`** — same field; added
   `accountUsage: []` to the two `resolveServerConfigValue` fixtures.
3. **`packages/shared/src/agentAwareness.test.ts`** — a `session` fixture was
   missing the `queuedMessages` field its sibling fixtures carry; added
   `queuedMessages: { steering: [], followUp: [] }`.
4. **`packages/client-runtime/src/state/shell-sync.test.ts`** — upstream's
   warm-cache `cachedSnapshot` literal lacked loom's required `goals` field on
   `OrchestrationShellSnapshot`; added `goals: []`.

## One pre-existing test realigned (not merge-caused)

`apps/server/src/serverRuntimeStartup.test.ts` — "uses the canonical Codex
default…" asserted `codex`/`DEFAULT_MODEL`, but loom's source
(`getAutoBootstrapDefaultModelSelection`) was switched to `pi`/`PI_DEFAULT_MODEL`
(`google-vertex-claude/claude-opus-4-8`) in the earlier "fork-aware architecture
campaign" and the assertion went stale. **Verified pre-existing on `origin/main`**
(the source, test, and cockpit schema are all byte-identical to pre-merge).
Opportunistically realigned the assertion to loom's intentional default rather
than leave a red test the reviewer would inherit.

## Lockfile + pnpm 11

`pnpm-lock.yaml`: took upstream's (`git checkout --theirs`), then `pnpm install`
under pnpm **11.10.0** (corepack honoured the root `packageManager` bump). Two
install-flow notes for next time:

- pnpm 11 aborts a modules purge without a TTY → run with `CI=true`.
- The first install needed `--no-frozen-lockfile` once (a `patchedDependencies`
  config-vs-lockfile mismatch from the bump); subsequent installs are frozen and
  a no-op. Idempotence confirmed: two consecutive installs leave `pnpm-lock.yaml`
  byte-identical (same md5).

Native builds (`node-pty`) and the desktop/electron/Clerk postinstalls all ran
clean; no ad-hoc `allowBuilds` flags were needed.

## Gates

- **`pnpm typecheck`** (recursive, `vp run -r --concurrency-limit 2`): **0
  errors**. Only pre-existing `suggestion` advisories remain
  (`WorkstreamFanInReactor`, a couple of test-file effect-idiom hints) — non-blocking.
- **`pnpm build`**: exit 0, all 5 targets.
- **`vp check`**: **0 errors**, 28 warnings — all in upstream/pre-existing code
  (e.g. `no-array-index-key` in the new `ComposerQueuedMessages.tsx`,
  `no-useless-concat`/`no-useless-spread` in mdx-plan), none in fork-critical
  resolutions.
- **Targeted tests** (the conflict/re-home surface): `shell-sync.test.ts` +
  client-runtime `server.test.ts` (8/8), full `packages/client-runtime` (291/291),
  `packages/shared` agentAwareness (6/6), `apps/server` `serverRuntimeStartup` /
  `server` / `OrchestrationEngine` / `ProviderSessionReaper` /
  `ProjectSetupScriptRunner` / `CheckpointDiffQuery` all pass.
- **Full `apps/server` suite:** 1857 passed, **6 pre-existing failures** in 4
  files (`ProviderRegistry` real Codex/cursor probes ×3, `GitManager` commit-hook
  rejection, `ProjectionSnapshotQuery` workspace-root dedup DB-constraint,
  `cli/project` message derivation). **Verified pre-existing:** an
  `origin/main` worktree with the same node_modules reproduces the identical
  6 failures — they are environmental (external binaries, git hooks) / a sandbox
  DB-constraint artefact, not merge regressions. None of the 4 files were touched
  by this merge.

## Live smoke test

Built `apps/server/dist/bin.mjs` launched on spare port **13959** against a
_copy_ of `~/.t3/cockpit/userdata/state.sqlite` (`T3CODE_HOME` sandboxed; the
live cockpit on the default port was never touched). Booted clean, **"Migrations
ran successfully"** through `53_ProviderSessionRuntimeLastSeenIndex` (no new
migrations in the window — consistent with the delta's only migrations being
`infra/relay` Postgres; `50_ProjectionProjectsUniqueActiveWorkspaceRoot` is a
pre-existing loom migration, which also explains the workspace-root dedup test's
constraint failure). `GET /` → **200**; the #3719 `shellSnapshot`/`threadSnapshot`
HTTP routes are wired in `orchestration/http.ts`. Workstream-liveness,
session-reaper, exhaustion-resume, and the usage poller all started; no crash.
Process killed, DB copy removed.

## Merge topology

`git merge --no-edit upstream/main` produced a normal two-parent merge commit;
conflict + semantic fixes were folded into it via `--amend` (both parents
preserved). No rebase, no squash, no flatten. `HEAD^1 == 7ad54681d` (loom
`origin/main`), `HEAD^2 == f61fa9499` (upstream). Merge commit `10fe9f994`. Once
this merges into `loom/main` the merge-base advances to `f61fa9499`, keeping the
next pull cheap. The sync note is a separate docs commit on top so it can cite
the final merge hash.

## Intentional prior drops — NOT "fixed" here

DiffPanel working-tree diff (`/api/vcs/diff` deleted), `pinnedCollapsedThread`,
Pi-only driver registry, deferred read-only Goals/tasks UI. Left untouched.
