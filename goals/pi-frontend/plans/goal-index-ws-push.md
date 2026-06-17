---
manager_sessions:
  - id: 019ed371-250b-7ea4-9ba1-05227655e18e
    role: plan
    authored_at: 2026-06-17T03:04:11.868Z
---

# Plan — Goal-index freshness via server file-watch → WS push

## Why
Goal-index freshness in the UI is currently **HTTP polling** (`useQuery({ refetchInterval: 5_000 })`)
with a **duplicated polling owner** (`Sidebar.tsx` declares its own inline `useQuery(["goals"])`
instead of using the shared hook). Diagnosis (see session) concluded this was *path of least
resistance*, not a deliberate design: there is no constraint forcing polling, and this same server
already runs a mature `fs.watch → debounce → PubSub → streamChanges → WS subscribe` pipeline for
three other config surfaces (`serverSettings`, `keybindings`, provider statuses) that goals can ride.

This plan replaces polling with **server-side file-watch on goal packages + a WebSocket push stream**,
eliminating the HTTP poll and the duplicate query owner. Aligns with the project's "Performance first"
priority.

## Reference patterns to mirror (do not invent new machinery)
- **Watcher → PubSub → streamChanges**: `apps/server/src/serverSettings.ts:480-575`
  (`startWatcher` = `fs.watch(dir).pipe(Stream.filter, Stream.debounce(100ms))`,
  `Stream.runForEach(... ).pipe(Effect.forkIn(watcherScope))`, and the `streamChanges` getter
  `Stream.fromPubSub(changesPubSub)`). `keybindings.ts` is the twin.
- **Standalone WS subscription**: `apps/server/src/ws.ts:1547-1561` (`subscribeServerLifecycle`) —
  cleanest template: emit a snapshot, then concat live updates. (`subscribeServerConfig` at
  `:1496-1546` shows the merge-many-sources variant; we want the standalone one.)
- **Contract shapes**: `packages/contracts/src/server.ts:485-536`
  (`ServerLifecycleStreamEvent` union) and `packages/contracts/src/rpc.ts:647-652`
  (`WsSubscribeServerLifecycleRpc`).
- **Client transport + consumption**: `packages/client-runtime/src/wsRpcClient.ts:162-163,362-372`
  (`subscribeLifecycle`) and `apps/web/src/rpc/serverState.ts:175-205` (`startServerStateSync`
  wiring the subscription).

## Wire contract (PIN THIS — get it exactly right)
The watcher republishes the **whole** goal index on every change, so one event shape covers both the
initial snapshot and live updates. Add to `packages/contracts/src/server.ts`:

- `GoalTaskProgress` — `Schema.Struct({ done: NonNegativeInt, total: NonNegativeInt })`.
- `GoalTaskNode` — recursive: `{ text: string, done: boolean, children: ReadonlyArray<self> }`
  (use `Schema.suspend` for the recursion, mirroring any existing recursive schema in the repo).
- `GoalIndexEntry` — `{ projectId: ProjectId, slug, title, goalParagraph, worktreePath, branch,
  packagePath, tasks: Array<GoalTaskNode>, progress: GoalTaskProgress }`. Must match the TS interface
  in `apps/server/src/goal/GoalsService.ts:34-43`.
- `GoalIndexStreamEvent` — single struct (not a union): `{ version: Schema.Literal(1),
  type: Schema.Literal("goals"), goals: Schema.Array(GoalIndexEntry) }`.

Add to `packages/contracts/src/rpc.ts`:
- `WS_METHODS.subscribeGoals: "subscribeGoals"` (near `:222-224`).
- `WsSubscribeGoalsRpc = Rpc.make(WS_METHODS.subscribeGoals, { payload: Schema.Struct({}),
  success: GoalIndexStreamEvent, error: <reuse EnvironmentAuthorizationError>, stream: true })`.
- Register `WsSubscribeGoalsRpc` in `WsRpcGroup`.

## Server changes
1. **`apps/server/src/goal/GoalsService.ts`** — extend `GoalsServiceShape`:
   - Add `start: Effect.Effect<void, ...>` and `streamChanges: Stream.Stream<ReadonlyArray<GoalIndexEntry>>`.
   - Add a `changesPubSub` (PubSub of `ReadonlyArray<GoalIndexEntry>`) and a `watcherScope`.
   - `rescan()` already refreshes the cache; have the watcher path call rescan then publish the
     result to `changesPubSub`.
   - **Watcher target (the one real wrinkle — use judgment, keep it simple):** goal packages live at
     `<worktree>/goals/<slug>/goal.md`, and worktrees are dynamic. Recommended: on `start`, enumerate
     every worktree across all projects (reuse the same `git worktree list` mechanism
     `discoverGoals`/`GoalPackage.ts` already uses), and for each ensure-then-watch its `goals/`
     subtree (recursive over that *small* subtree only — never the whole repo / never `node_modules`).
     Debounce 100ms → `rescan()` → publish. Handle a missing `goals/` dir gracefully (skip or watch
     lazily; do not crash). After `POST /api/goals` creates a new goal, refresh the watch set.
     **Document as a known limitation:** worktrees created entirely outside this server mid-run won't
     be auto-watched until restart — acceptable for a personal single-user tool. Do not over-engineer
     a dynamic worktree-discovery loop to chase this edge.
   - Mirror `serverSettings.ts` `start`/`watcherScope`/forkIn structure; do not roll a bespoke pattern.
2. **`apps/server/src/server.ts`** — `GoalsServiceLive` is already in `ProviderRuntimeLayerLive`
   (`:285`). No layer change needed beyond what GoalsService internally requires.
3. **`apps/server/src/serverRuntimeStartup.ts:316-330`** — add a `goals.start` startup phase that
   forks `goalsService.start` (mirror the `settings.start` phase exactly, including the
   `Effect.catch`/`Effect.forkScoped` + `runStartupPhase` wrapper).
4. **`apps/server/src/ws.ts`** — add `[WS_METHODS.subscribeGoals]` handler modeled on
   `subscribeServerLifecycle` (`:1547`): emit `{ version:1, type:"goals", goals: <rescan or list> }`
   as the snapshot, then concat `goalsService.streamChanges.pipe(Stream.map(goals => ({version:1,
   type:"goals", goals})))`. Add the scope-map entry near `:202` using the existing read scope used by
   `subscribeServerConfig` (`AuthOrchestrationReadScope`).
5. **`apps/server/src/goal/http.ts:42-46`** — `GET /api/goals` now reads from the warm cache
   (`goalsService.list()`) instead of `rescan()` on every request, since the watcher keeps the cache
   fresh. Keep `POST /api/goals` rescanning after a write (`:97`).

## Client changes
6. **`packages/client-runtime/src/wsRpcClient.ts`** — add `subscribeGoals` stream method mirroring
   `subscribeLifecycle` (`:162-163` type decl, `:362-372` impl).
7. **`apps/web/src/rpc/serverState.ts`** — in `startServerStateSync` (`:175`), add a
   `client.subscribeGoals((event) => { queryClient.setQueryData(["goals"], event.goals); })`
   subscription so a **single owner** pushes WS updates into the React Query cache. (Thread the app's
   `QueryClient` in if not already available here; otherwise expose a tiny setter the root wires up.)
   Where the subscription is established is flexible — the constraint is **exactly one** subscriber.
8. **`apps/web/src/goals/goalIndex.tsx:36-39`** — `useGoalIndex()` drops `refetchInterval`; keep
   `queryFn: fetchGoalIndex` as the initial/fallback fetch with `staleTime: Infinity`. WS updates via
   `setQueryData` keep it live. `fetchGoalIndex` and `GoalIndexEntry`/`TaskTree` stay.
9. **`apps/web/src/components/Sidebar.tsx:3125-3129`** — delete the duplicated inline
   `useQuery(["goals"], …)` and call the shared `useGoalIndex()` hook (collapses the duplicate owner).
   Verify the other consumers (`_chat.index.tsx`, `ChatHeader.tsx`, `GoalTasksPanel.tsx`) still work
   unchanged — they share the `["goals"]` key so they get WS-fed data for free.

## Out of scope / explicit non-goals
- No multi-process / serverless / remote-fs handling — single Node server, local worktrees only.
- No diffing on the server: the watcher republishes the full (cheap, synchronous) index; clients
  replace wholesale. Do not build incremental goal-level patches.
- No backward-compat shim for the old polling path: delete `refetchInterval` and the duplicate query;
  do not keep both mechanisms running.

## Verification (required before "done")
- `vp check` passes.
- `vp run typecheck` passes.
- Manual/dogfood: edit a `goals/<slug>/goal.md` task checkbox on disk and confirm the UI updates
  within ~debounce latency **without** any 5s HTTP `/api/goals` poll in the network tab (only the WS
  stream + the single initial fetch). Confirm only one `["goals"]` query owner remains.
- Document any assumptions/limitations hit (esp. the dynamic-worktree watch wrinkle) in the summary.
