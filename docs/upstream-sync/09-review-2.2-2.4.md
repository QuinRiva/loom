---
manager_sessions:
  - role: review
    authored_at: 2026-06-30
---

# Review — re-home phases 2.2–2.4 (client-runtime, web state, server core)

_Independent reviewer audit of the cumulative re-home `git diff 777bd20f8..HEAD`
(HEAD = `fdca4d3e5`). Scope: lost-feature audit against the punch-list (doc 08),
correctness of the re-home onto upstream's drifted layout, convention/cleanliness,
and the two judgment calls the server phase flagged. Australian English._

---

## Verdict: **SHIP** — with one tracked must-fix

The re-home is **faithful and substantially complete**. Every load-bearing Pi
capability I could trace is genuinely re-homed, not merely defined: all six runtime
layers are in the live layer graph **and** actually invoked, the workstream/goal
command surface routes end-to-end through `dispatchCommand` → decider, the PiDriver's
deterministic per-thread `--session-id` survives untouched, and account-usage flows
server→client. Both coder build claims **verify exactly**: `packages/client-runtime`
**0 errors**, `apps/server` **0 errors**. The residual red is confined to `apps/web`
(26, Phase 2.5/2.6) and one `apps/desktop` fixture (1, Phase 2.6 tail) — nothing
leaks into the re-homed packages. No backward-compat shims or dual-shape cruft were
introduced.

The single material defect is a **silently dropped fork behaviour on a
carried-upstream file**: the terminal `Manager`'s worktree-local `node_modules/.bin`
PATH prepend was **not** re-homed onto upstream's flattened `terminal/Manager.ts`,
even though doc 08 explicitly lists it. It typechecks, so it slipped the net — exactly
the failure mode this review exists to catch. It is a small, well-scoped fix and does
not block progressing to 2.5/2.6, but it must be picked up (2.6 tail) before the merge
is declared done. Hence SHIP, not RETHINK: the foundation is sound; one catalogued
item was skipped.

---

## Build state — verified, not taken on trust

| Package | Claimed | **Measured** | Notes |
|---|---|---|---|
| `packages/client-runtime` | 0 | **0** ✓ | |
| `apps/server` | 0 | **0** ✓ | |
| `apps/web` | (residual) | **26** | Phase 2.5/2.6 only — composer `@thread` mention kind, `ComposerPromptEditor`, `ChatView.logic`/`Sidebar.logic` test fixtures missing `queuedMessages`/goal fields. Confined to web shell. |
| `apps/desktop` | (not claimed) | **1** | `DesktopClientSettings.test.ts` fixture missing `reasoningDisplay` (consequence of the fork's settings.ts addition). 2.6 tail. |

`vp run typecheck` = 2 of 11 packages failing (`apps/web`, `apps/desktop`) — both
expected and outside the 2.2–2.4 deliverable.

---

## Lost-feature audit (highest priority) — walked item by item

### Six runtime layers — all wired AND invoked ✓
Verified each is in the live layer graph *and* does work at runtime, not just imported:

| Layer | Wired at | Invoked / does work |
|---|---|---|
| `WorkstreamDispatcherLive` | `server.ts:174` (`provideMerge`) | dispatcher engine carried intact |
| `WorkstreamLivenessSweepLive` | `server.ts:298` + **started** `serverRuntimeStartup.ts:350` | `.start()` in reactor scope |
| `ProjectionGoals` | via `OrchestrationProjectionPipelineLive` (`ProjectionPipeline.ts:1969` `provideMerge(ProjectionGoalRepositoryLive)`) → `runtimeLayer.ts` | goal events projected via `upsertGoal` (`ProjectionPipeline.ts:609–670`); projector registered as `projection.goals` |
| `ProjectionThreadHeartbeats` | via `ProviderRuntimeIngestionLive` (`server.ts:170`; repo provided `ProviderRuntimeIngestion.ts:2020`) | `heartbeatRepository.touch(...)` on any runtime activity (`:659`) |
| `ReasoningStreamBusLive` | `server.ts:180` (`provideMerge`) | subscribed in `ws.ts` `subscribeThread` |
| `SubscriptionUsagePollerLive` | `server.ts:299` + **started** `serverRuntimeStartup.ts:351` | `.start()` in reactor scope |

Plus `AccountUsageRegistryLive` (`server.ts:316`) and the MCP HTTP routes
`WorkstreamSpawnHttp`/`GoalTaskHttp`/`GoalHandoffHttp` (`server.ts:382–384`). The
2.4 report's claim that ProjectionGoals/ProjectionThreadHeartbeats ride
carried-through fork paths is **true** — confirmed by tracing the provideMerge chain,
not the report's word. **No missed layer.**

### Workstream/goal RPC surface — registered end-to-end ✓
Commands route through a single `dispatchCommand` RPC carrying an
`OrchestrationCommand` union (not per-method handlers). Verified the union + decider:
- **Workstream axes** are modelled as `thread.*` commands — `thread.plan-lane.set`
  (set-lane), `thread.attention.raise`/`.clear`, `thread.dependencies.set`,
  `thread.report.set` — all present in `contracts/orchestration.ts` **and** handled in
  `decider.ts` (lines 762/906/947/970/1462). Spawn/handoff are the HTTP MCP routes;
  the agent-facing tools live in `provider/Drivers/Pi/{WorkstreamSpawnExtension,GoalTaskExtension}.ts`.
- **Goal/task CRUD** — `goal.create/meta.update/archive/unarchive/delete` and
  `goal.task.create/update/delete` all present in contracts and handled in `decider.ts`.
- `ws.ts` re-registers `heartbeat` (`:986`), the goal-projection event branch
  (`:671` → `goal-upserted`/`goal-removed`), bootstrap `thread.create` goal/workstream
  fields (`:858`), `subscribeThread` reasoning-bus merge (`:1172`), and
  `subscribeServerConfig` account-usage push (`:1795–1824`, full replace-on-emit).
- Client-runtime surface is consistent: `setThreadPlanLane`/`clearThreadAttention`/
  `setThreadDependencies`/`stopThread`/`interruptTurn` wrappers
  (`operations/commands.ts`, `state/threadCommands.ts`).

### PiDriver deterministic `--session-id` — intact ✓
`git diff 6150362cf..HEAD -- PiDriver.ts` is **3 lines, type-only**
(`ServerConfigShape` → `ServerConfig["Service"]`). The create-or-resume logic
(`sessionId: piSessionIdForThread(startInput.threadId)`, `:732`, with the
"survives server restarts" comment) is **untouched**.

### Account-usage / reasoning / goal-task-tree — present ✓
- Account-usage: server emits on the config channel (`ws.ts:1795`) → client projects
  to `accountUsage` (full replace, `state/server.ts:48`) → `usageValueAtom` (`:150`)
  → web `useAccountUsage()`. End-to-end intact.
- Reasoning: `state/threads.ts` carries the `reasoning-delta` branch +
  `reasoningFinalized` dedupe; `ReasoningDisplayMode` (off/collapsed/expanded) in
  contracts settings.
- Goal-task-tree: `goalTaskTree.ts` + `buildGoalTaskTree` referenced by `projector.ts`
  and `ProjectionSnapshotQuery.ts`.

---

## Findings by severity

### BLOCKER — none
No missed layer, no unregistered handler, no wire-shape mismatch between client (2.2)
and server (2.4). The two typecheck claims are real.

### MAJOR

**M1 — Terminal worktree-local `node_modules/.bin` PATH prepend dropped (silent regression).**
The fork added `withLocalNodeModulesBin(spawnEnv, cwd, platform)` to the terminal env
builder (`6150362cf:terminal/Layers/Manager.ts:968`) so an in-app terminal resolves
the **terminal's own worktree binaries (e.g. `vp`) before the server's PATH, which may
point at a different checkout**. Upstream flattened the file to `terminal/Manager.ts`
and the fork edit was **not** re-homed: current `createTerminalSpawnEnv`
(`terminal/Manager.ts:1069–1083`) returns `spawnEnv` directly and no longer even takes
`cwd`. Doc 08 explicitly lists this re-home item; the 2.4 report does **not** mention
it — so it was neither re-homed nor consciously confirmed obsolete. It typechecks,
which is why it slipped.
- **Impact:** in this ~10-worktree shared-clone setup, commands typed in the app
  terminal can hit the **wrong checkout's** `vp`/project binaries. Real but
  feature-degrading, not feature-killing (global binaries still resolve).
- **Fix:** thread `session.cwd` + `platform` into `createTerminalSpawnEnv` and wrap the
  return in `withLocalNodeModulesBin(...)` (still exported from `@t3tools/shared/shell`).
  One-line call + signature change. Track in Phase 2.6.

### MINOR

**m1 — Driver registry left Pi-only; deviates from doc 08's "restore 5 + PiDriver".**
`builtInDrivers.ts` ships `BUILT_IN_DRIVERS = [PiDriver]`. Doc 08 (a)/Z7 asked to
restore upstream's full 5-driver registry **and** add PiDriver ("Pi-first; don't
over-invest re-enabling the others"). The re-home kept the fork's deliberate Pi-only
gutting instead. This is **faithful to the fork** (the pre-merge fork was already
Pi-only), so it is not a *lost fork feature* — but it is an unflagged divergence from
the punch-list's stated target. Recommend the orchestrator **confirm** whether the
non-Pi drivers should return; if Pi-only is intended, note it so future pulls don't
keep re-litigating. Not blocking — Pi works.

**m2 — `apps/desktop` typecheck red (1).** `DesktopClientSettings.test.ts` fixture
lacks the now-required `reasoningDisplay` settings key (a consequence of the fork's
2.1 settings.ts addition). One-line fixture fix; belongs to Phase 2.6 tail. Note this
is a *different* breakage from doc 08(e)'s "drop the out-of-scope desktop edit" item —
that one was about discarding a fork `+1`; this is a required-field gap. Both land in 2.6.

### Assessed and accepted (not findings)

- **previewAutomation widening — sound and necessary.** `PreviewAutomationUnavailableError.capability`
  widened `Schema.Literal("preview")` → `Schema.Literals(["preview","workstream"])`
  (`previewAutomation.ts:611`). Forced: the fork's `McpCapability` gained `"workstream"`
  and `requireCapability` constructs this error with whichever capability was denied;
  `previewAutomation.ts` is a new upstream file so the widening wasn't recoverable from
  history. Minimal (one literal), documented with a clear comment, contracts typecheck.
  Correct call.
- **`withLocalNodeModulesBin` deferral for non-Pi TextGeneration — acceptable, and
  effectively moot.** The fork had it in `textGeneration/{Claude,Codex}TextGeneration.ts`;
  HEAD's TextGeneration family omits it. Because the driver registry is Pi-only (m1),
  those drivers' TextGeneration paths are **dead code at runtime** — the deferral changes
  nothing observable. The *live* session runtimes that matter still carry the helper
  (`PiDriver`, `ClaudeAdapter`, `CodexSessionRuntime`, `AcpSessionRuntime`,
  `workstreamAsk`). `opencodeRuntime.ts` has only a NOTE comment, but OpenCode is
  likewise unregistered. Fine.
- **Effect conventions / cleanliness.** No `backward-compat`/`legacy`/`shim`/dual-shape
  strings introduced in the cumulative diff. CLI `project.ts` took upstream and the
  fork's Pi CLI surface lives in `cli/{goal,orchestrationMutation}.ts` (present, compile)
  — no Pi CLI feature lost.

---

## Top issues to fix (in order)
1. **M1** — re-home the terminal worktree-local `.bin` PATH prepend onto
   `terminal/Manager.ts` (`createTerminalSpawnEnv`). _(Phase 2.6 / tracked)_
2. **m1** — confirm the deliberate Pi-only `BUILT_IN_DRIVERS`; either restore the
   upstream drivers per doc 08 or record Pi-only as the intended final state.
3. **m2** — add `reasoningDisplay` to the desktop settings test fixture. _(Phase 2.6)_

The 26 `apps/web` errors are the Phase 2.5/2.6 worklist and out of scope here.
