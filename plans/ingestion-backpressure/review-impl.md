# Implementation review: bounded, backpressured provider-runtime ingestion

Reviewed `git diff 2f3212bf6c..HEAD` (7 commits) against plan v3, `review-plan.md`
and `implementation-notes.md`. Effect 4.0.0-rc.115 semantics checked in
`apps/server/node_modules/effect/dist/*.js`. Line numbers are from this worktree at
`26af30b44b`. Two claims were checked empirically (a throwaway test on the reader; a
paused-parent child write test); neither left files in the tree.

## Verdict

**APPROVE WITH FIXES.** The chain propagates end to end and every hop is bounded; the
memory mechanism is correct. Two things must change before ship: the in-flight count in
the reader is inflated by promises that have already completed, so every ≥16-line
chunk pauses the child (polluting the counters the §6 verification relies on and
disabling the RPC deadline on busy children); and the liveness watchdog cannot see a
wedge that lands on the adapter fibre before `publish` — the exact "silent freeze"
review-plan issue 2 said was not an option.

## Blocking issues

### 1. Every chunk with ≥ 16 lines pauses the child, regardless of downstream state

Evidence:
- `RpcProcess.ts:335-349` `dispatch` counts a listener return as in flight the moment
  it is a `Promise`, and only decrements in `pending.then(settle, settle)` (`:341`) —
  a microtask. `PiDriver.ts:2002-2004` returns `Effect.runPromise(...)`, which is a
  Promise for *every* message, including `Effect.void` cases (`turn_start`, `turn_end`,
  `compaction_start`) and a `Queue.offer` that succeeded synchronously
  (`runForkWith` evaluates the fibre inline, `internal/effect.js:2426-2428`; the promise
  still settles asynchronously).
- The `data` handler (`:352-362`) dispatches all lines of a chunk synchronously, so no
  `settle` runs until the loop ends. With an idle pipeline, the 16th line of any chunk
  hits `inFlight >= pauseAt` (`:342`) and calls `stream.pause()`. Reproduced: a 20-line
  chunk with `() => Promise.resolve()` as the listener → `reader.isPaused() === true`
  synchronously after `write`, `pauses === 1`.
- A 64 KB pipe read of pi `message_update` deltas (~100–300 B each) is hundreds of
  lines; under any load the reader is paused-and-resumed on most chunks.

Consequences: (a) `piStdoutBackpressure.pauses` (`:284`) and `pausedNow` are
meaningless — done criterion 2 ("`stdoutPaused` counters non-zero ⇒ backpressure
engaged") reads true on a healthy system; (b) `setPauseAwareTimeout` (`:385-403`)
re-arms whenever `pauseCount()` changed since it was armed (`:394`), so on any child
producing a ≥16-line chunk per 30 s window a lost RPC response never times out;
(c) a `pause()`/`resume()` (nextTick `flow`) pair per chunk.

Fix — count only handling that actually suspended. The fibre exposes this directly
(`Fiber.d.ts:78` `pollUnsafe`, `:76` `addObserver`; `addObserver` on an exited fibre
calls back synchronously, `internal/effect.js:389-392`):

```ts
// PiDriver.ts wirePiProcess
active.unsubscribe = process.subscribe((message) => {
  const fiber = Effect.runFork(handleMessage(active, message));
  // Only a fibre that suspended (full `events` queue, pi RPC round trip) holds an
  // in-flight slot; a synchronously finished one must not, or every ≥16-line
  // chunk would pause the child.
  return fiber.pollUnsafe() === undefined
    ? new Promise<void>((resolve) => fiber.addObserver(() => resolve()))
    : undefined;
});
```

`runFork` is already used for fire-and-forget in this tree (`ClaudeAdapter.ts:4583`);
rc.115 has no unhandled-fibre reporter, so the old `.catch(() => undefined)` swallow is
preserved. Add the test that was missing anyway (§9 below): with `Queue.bounded(1)`
injected as `events`, the listener returns `undefined` for a `turn_start`, a pending
Promise once the queue is full, and that Promise resolves after `Queue.take`.

### 2. The watchdog is blind to a wedge upstream of `publish`

Evidence:
- `decideIngestionLiveness` (`ProviderRuntimeIngestionTelemetry.ts:157-160`) treats
  work as pending only if `queueDepth > 0` or a runtime-event *publish* has been
  suspended since before the previous check. Both signals are downstream of
  `ProviderService.processRuntimeEvent`.
- That per-adapter fibre does SQL *before* it publishes: `session.exited` →
  `reconcileExitedSession` (`ProviderService.ts:1342-1370`, `:1423`) →
  `releaseWorkspaceHoldOnExit` + `directory.upsert`. Production has one pi instance,
  so one adapter fibre carries every child (`ProviderService.ts:1499-1506`).
- If the SQL lane (`NodeSqliteWorkerClient.ts:186`, one permit — the wedge the plan
  names) hangs while that fibre is in `reconcileExitedSession`, the driver queue fills
  (`PiDriver.ts:2888`, 32), every child pauses, nothing reaches the PubSub, and the
  ingestion queue — empty in steady state — stays empty. `queueDepth = 0`,
  `publishSuspendedSinceMs = undefined` → `ok` forever. Silent freeze, no restart;
  today the unbounded driver queue would have grown to the OOM restart.

Fix — use the symptom that is common to every wedge downstream of the reader: a child
whose stdout has been paused across two consecutive checks with no ingestion progress.
After issue 1, pauses are real. ~12 lines:

```ts
// RpcProcess.ts
export const piStdoutBackpressure = {
  pauses: 0, pausedMsTotal: 0,
  /** Active pauses → when they began; size is "paused now". */
  pausedSince: new Map<object, number>(),
};
// in attachStdoutLineReader: const key = {};
//   pause:  piStdoutBackpressure.pausedSince.set(key, pausedAtMs)
//   resume: piStdoutBackpressure.pausedSince.delete(key)
// RuntimePerformanceMonitor: piStdoutPausedNow: piStdoutBackpressure.pausedSince.size

// ProviderRuntimeIngestionTelemetry.ts watchLiveness
const stdoutPausedSinceMs = Math.min(...piStdoutBackpressure.pausedSince.values()); // Infinity when none
const decision = decideIngestionLiveness({
  ...,
  blockedSinceMs: Math.min(publishSuspendedSinceMs ?? Infinity, stdoutPausedSinceMs), // Infinity → not pending
  ...
});
```

and in `decideIngestionLiveness` replace `publishSuspendedSinceMs` with
`blockedSinceMs` (pending iff finite and `<= previousCheckAtMs`). No false positive:
a child paused for two checks means ≥ 16 handling fibres suspended for ≥ 60 s; with
ingestion making no progress that is a wedge by definition (the only non-queue
suspensions inside `handleMessage` — `rerouteAndReprompt`'s RPC + 2 s sleep,
`relaunchWithRewrittenHistory` — hold one slot each). Extend the decision test.

## Non-blocking

1. **Pause-aware deadline can wait forever.** `setPauseAwareTimeout` (`RpcProcess.ts:385`)
   re-arms without limit; under sustained saturation a child that never answers (pi
   wedged internally but its pipe still paused) leaves `sendTurn`/`set_model` pending
   until the child exits. Plan said do not raise the constant; a cap on re-arms (e.g.
   10 → ~5 min, matching the watchdog) keeps the intent and bounds the wait. Optional.
2. **`close` teardown has no fallback.** `PiDriver.ts:2005` runs teardown only on
   `close`, which waits for every holder of pi's stdout fd. Verified pi's tool spawns
   pipe their children (`pi-coding-agent/dist/bundle/chunks/chunk-OJP47DM6.js:1152`
   `spawn4(shellConfig.shell, …, {detached, stdio:[…,"pipe","pipe"]})`, `:1485` MCP
   `stdio:["pipe","pipe","pipe"]`); `stdio:"inherit"` occurs only in the TUI editor
   (`:1305`) and self-update (`:1536`, `:1609`) paths. Extensions are unverified. If a
   grandchild ever inherits fd 1, an *unplanned* crash leaves `sessions` holding a dead
   entry and `session.exited` unsent until the grandchild dies (`stopSession` is
   unaffected — it resolves on `exit`). Cheap belt-and-braces: run the teardown once on
   `close` **or** `exit` + a few seconds, whichever first.
3. **`session.exited` straggler after re-registration** (deviation 8). The
   `sessions.get(...) === active` guard (`:2011`) is right, but the emit still goes out
   after a replacement launched. Pre-existing (the emit was already in a floating async
   block), window now wider by exit→close. `ProviderService` guards the lease with
   `endedLaunches` generations (`:650-700`), but `reconcileExitedSession` still writes
   `status: "stopped"` for the thread unguarded (`:1349-1357`). Not new; note it in the
   ProviderService comment that cites `PiDriver.ts:1850-1853`.
4. **`publishSuspendedMs` is in-flight wall time, not suspended time**
   (`ProviderRuntimeIngestionTelemetry.ts:73-93`). Accurate in practice because a
   non-suspending publish completes inside one synchronous fibre run; document or rename
   so the §6 reader does not over-read it.
5. **Tests missing for the two hops that are only wired, not tested**: `wirePiProcess`
   returning a pending promise on a full `events` queue (a revert to
   `void Effect.runPromise(...)` passes the suite today), and `Queue.bounded(32)` in
   `PiDriver.make` (a revert to `unbounded` passes). Also no test that lines arriving
   between `exit` and `close` reach the queue before `session.exited` — the reason for
   the `close` change. The first is covered by the fix-1 test; add the third if cheap
   (`fake.process.child.emit("exit")`, deliver a message via the captured listener,
   then `emit("close")`, assert order in `events`).
6. **Domain-path deletion removes upstream-owned lines.** Upstream still carries
   `processDomainEvent` and the `streamDomainEvents` subscription
   (`upstream/main:…/ProviderRuntimeIngestion.ts:2620, 2664, 2718`). A 3-way merge keeps
   the deletion unless upstream edits inside it, in which case it conflicts visibly.
   Fine, but record it in the upstream-sync ledger so the next pull does not "restore" it.
7. **`[...listeners].flatMap` + `Promise.all` per message** (`RpcProcess.ts:508-512`):
   two array allocations and a `Promise.all` per line for a set that has one member.
   A plain loop returning the single promise is smaller; trivial either way.
8. **`registerEngineEventPubSubSize` is a module global** (`:96-99`): last engine
   constructed wins. Harmless in production (one engine), meaningless under tests that
   build several. Acceptable given the stated reason (15 fakes).
9. **Five-minute single item.** The only ingestion step that can legitimately block
   for minutes is `engine.dispatch` behind the engine's unbounded `commandQueue`
   (`OrchestrationEngine.ts:192`, `:762-770`); at 5 min of queue wait the engine is
   wedged for practical purposes, so the exit is the right call. No git or network on
   the lifecycle worker (`recordProviderDiff` `:2977-3010` is SQL + dispatch;
   `isGitRepository` runs on the diff worker `:3135`).

## Verified

- **Hop 1 (reader → driver).** `attachStdoutLineReader` pauses at 16 unsettled, resumes
  at ≤ 4 (`RpcProcess.ts:331-349`), `release()` on `exit` (`:535`) resumes for good so
  `end`/`close` fire; pause takes effect after the current chunk (Node `flow()` stops
  on `flowing=false`), so the ceiling is `pauseAt + lines-per-chunk` as documented.
  `Promise.all` settles on first rejection but the PiDriver listener never rejects.
  Splitter is O(n) per line (`:352-362`; only complete lines are concatenated); `\r`
  trim, blank skip and non-JSON ignore preserved (`:336-337`, `:521-527`). pi's stdout
  writes are asynchronous on Linux (re-measured: 40 000 × 1 KB lines in 13 ms against a
  paused parent, `writableLength` 40.8 MB), so a paused child keeps reading stdin —
  `abort` (a `write`) still lands.
- **Hop 2 (driver queue).** `Queue.bounded(32)` per instance (`PiDriver.ts:2888`);
  `offer` on a full `suspend`-strategy queue suspends (`Queue.js:369-380`);
  `shutdown` resumes suspended offers with `false` (`Queue.js:837-855`), so
  `emitDelivered` (`:964`) keeps its undelivered semantics on instance rebuild.
  No fire-and-forget fork inside `handleMessage` (`runPromise`/`runFork` sites are
  `:1471` retry timer, `:2003`, `:2018-2020` close teardown, `:2511`/`:2522` askUser).
- **Hop 3 (fan-out).** `PubSub.bounded({capacity})` uses `BackPressureStrategy`
  (`PubSub.js:97-100`); `Stream.fromQueue`/`fromPubSub` pull with `takeAll`, so each
  hop's in-memory bound is 2× capacity as the plan states. Subscribers in production
  are exactly three (`ProviderRuntimeIngestion.ts:3193`, `CheckpointReactor.ts:1177`
  filter + unbounded worker, `ProviderUsageLimitsIngestion.ts:25`); none blocks.
- **Hop 4 (worker).** `TxQueue.bounded` `offer` retries while full
  (`TxQueue.js:298-324`); `enqueue` wraps offer + counter in one `Effect.tx`
  (`DrainableWorker.ts:78-82`) so a retry re-runs both. `drain` contract unchanged.
- **No cycle.** Ingestion calls only `providerService.getSession`/`listSessions`;
  `engine.dispatch` completes its Deferred after persist + `eventPubSub` publish
  (`OrchestrationEngine.ts:574-589`, unbounded), reactors run on their own workers;
  `ProviderCommandReactor → sendTurn → emit` can suspend on a full driver queue but
  nothing upstream of it waits on it. `publishRuntimeEvent` is called only from the
  adapter fibre and compaction routing (`ProviderService.ts:1258-1288`, `:1436-1447`).
- **Self-deadlock (Q2a).** Only `rerouteAndReprompt` awaits a pi RPC inside
  `handleMessage` (`PiDriver.ts:1524`, `:1547`, via `agent_end` `:1930`); one per
  child per errored turn. At 15 pending offers + this one, the pause clears when the
  offers drain (FIFO across children, `Queue.js` `offers` insertion order), the count
  drops to ≤ 4, the response line is delivered. `relaunchWithRewrittenHistory` (`:1517`)
  stops the old child, whose `exit` releases its reader. No cycle, delay only.
- **Liveness mechanics (beyond issue 2).** Consecutive-check counting (`:157-166`)
  survives host sleep and long GC stalls (a late timer is one check). `watchLiveness`
  is a real-clock `Effect.sleep` (`:319`), inert under `TestClock`; no ingestion test
  adjusts the clock. `process.exit(1)` is acceptable here: the unit is
  `Restart=always` with agents in `loom-agents.slice` stopped by `ExecStartPre`
  (`loom-cockpit.release-store.service:55,63`), so the outcome matches the OOM abort;
  deployd's soak probes the port and rolls back on a drop (`deployctl.ts:639-654`);
  `Logger.consolePretty` writes synchronously to a Linux pipe, so the error line lands.
  Startup: reconcile runs before the fork (`:3184-3191`), zero-subscriber publish drops
  as before.
- **§3.7.** Old loop visited every thread row with a session and a non-null
  `activeTurnId` (`getSnapshot` did not filter archived/deleted threads,
  `ProjectionSnapshotQuery.ts:1153`, `:4137-4204`); `listWithActiveTurn`'s
  `INNER JOIN projection_threads … WHERE active_turn_id IS NOT NULL`
  (`ProjectionThreadSessions.ts:83-99`) is the same set. The stuck logic reads only
  `tool.started`/`tool.updated`/`tool.completed` (`:1208-1212`, `:3051-3065`), so the
  kind filter is exact; `listByThreadId` ordering (`ProjectionThreadActivities.ts:119-124`)
  matches the snapshot's `sequence, created_at, activity_id` (NULL sequence first in
  both). Field mapping equals `mapThreadActivityRow` (`:914-926`). `getSnapshot()` has no
  server caller left outside `dev/` seeds. Existing reconcile test
  (`ProviderRuntimeIngestion.test.ts:4836`) runs through the real repositories.
- **§3.3.** No `.raw` reader after the canonical log in `orchestration/`, `mcp/`,
  `ws.ts` or the three subscribers; destructure used (`ProviderService.ts:1225`);
  test asserts logger receives `raw` and the published event lacks it
  (`ProviderService.test.ts:1900-1905`).
- **Hot path cost.** Per event: 2–4 `Clock` reads, one `Date.parse`, a ≤17-bucket
  `findIndex`, one `provideService` (overlay chain, O(1) — `Context.js:373-387`), one
  spread copy for `raw` removal. Per SQL statement on every fibre: one `withFiber` +
  `getRef` (`NodeSqliteWorkerClient.ts:189-190`). Nothing O(n) per event.
- **Upstream friction.** `RpcProcess.ts`, `PiDriver.ts`, `NodeSqliteWorkerClient.ts`,
  `RuntimePerformanceMonitor.ts`, the telemetry module are loom-only. Upstream files
  touched carry `// loom:` on every added hunk; `ProviderService.ts` and
  `OrchestrationEngine.ts` changes are one-line replacements/additions. `unmarkedsweep`
  reported clean.
- **Tests.** Reader tests exercise split lines, >1 MB, split UTF-8, `\r\n`, tail flush,
  16/4 hysteresis with real `isPaused()`; deadline re-arm and plain timeout;
  `DrainableWorker` capacity test fails without the bound (confirmed by the coder's
  mutation); PubSub stall test asserts `inFlight === 1` (unbounded would give 0);
  decision-function tests cover the threshold and the publish-since edge. Changed
  existing tests (`PiDriver.userInput.test.ts`, `PiDriver.compaction.test.ts` emit
  `close` after `exit`) mirror the real child and are justified.
- **OOM recurrence.** Remaining unbounded buffers are named and small-item:
  CheckpointReactor's worker, the diff worker, `ProviderUsageLimitsIngestion`'s PubSub,
  the engine `eventPubSub` (logged as `enginePubSubSize`). pi-side buffering is the
  accepted trade. No new machinery beyond the plan except the watchdog ticker fibre,
  which is justified (a wedged worker cannot flush its own check).

## Re-review of the fix pass

Reviewed `git diff 26af30b44b..0a1583de2f -- . ':!plans' ':!docs'` (8 commits). Line
numbers from the fix-pass tree. The new test file was run, then run again with the
listener reverted to `runPromise(...).catch(...)` (fails: `expected Promise{…} to be
undefined`); tree restored.

**Verdict: APPROVE.**

### 1. In-flight = handling that suspended — correct

- `PiDriver.ts:2011-2016`: `Effect.runFork` → `pollUnsafe() === undefined` ? promise from
  `addObserver` : `undefined`.
- rc.115 `internal/effect.js:2426-2429`: `runForkWith` constructs the fibre and calls
  `fiber.evaluate(effect)` inline; `evaluate` (`:430-448`) runs `runLoop` and sets
  `this._exit = exit` synchronously unless the loop returned `Yield`. `pollUnsafe`
  (`:427-429`) returns `_exit`. So a `Queue.offer` that lands synchronously
  (`Queue.js:369-382`: append + `exitTrue` when not full) yields a non-undefined
  `pollUnsafe()` at the call site; a full-queue offer goes through
  `offerRemainingSingle` (`:382`), which suspends → `Yield` → `_exit` undefined.
- `addObserver` on a not-yet-exited fibre queues the callback (`:393-397`) and `evaluate`
  runs observers on exit (`:454-459`); the sync-callback branch (`:389-392`) is only
  reachable if the fibre exited between `pollUnsafe` and `addObserver`, which cannot
  happen on one thread. No `unhandled`/orphan reporter exists in `internal/effect.js`
  (grep), so a failure exit is still swallowed exactly as before — the observer ignores
  the exit and nothing else reads it.
- Only distortion: a cooperative yield. `Scheduler.js:121-122` yields when
  `currentOpCount >= MaxOpsBeforeYield` (2048, `:206-209`), per fibre (reset per
  `runLoop`, `effect.js:466`). A `handleMessage` run over 2048 ops would return a
  promise that settles on the next `setImmediate`. A delta handler is tens of ops; not a
  concern.
- Test `PiDriver.backpressure.test.ts:101-125` with `Queue.bounded(1)`: `turn_start`,
  `message_start`, first delta → `undefined`; second delta → Promise, still pending a
  macrotask later; resolves after `Queue.take`. Fails on the old listener at the first
  assertion (confirmed).
- `RpcProcess.ts:520-526`: plain loop, returns the single promise (non-blocking 7 done).

### 2. `blockedSinceMs` — correct, no false-positive path found

- `ProviderRuntimeIngestionTelemetry.ts:327-336`: `min(inFlight > 0 ? sinceMs : Infinity,
  min(...pausedSince.values()))`. `Math.min()` of an empty spread is `Infinity`, and
  `decideIngestionLiveness` (`:159-165`) treats pending as
  `queueDepth > 0 || blockedSinceMs <= previousCheckAtMs`; `Infinity` never satisfies it.
- Progress overrides: `stalledChecks` only increments when
  `lastProgressAtMs <= previousCheckAtMs` (`:161-162`), so a long-paused stream with
  ingestion progressing resets to 0 — covered by the new test case
  (`…Telemetry.test.ts:66-74`).
- Map hygiene (`RpcProcess.ts`): `pause` sets `pausedSince.set(stream, pausedAtMs)`
  (`:356`) only when `!paused && !released` (`:351`); `resume` deletes (`:336`) and is
  the single path out of `paused`; `release()` (`:374-377`) sets `released` then calls
  `resume()`, so an entry cannot outlive the pause; `release` runs on the child's `exit`
  (`:549`), registered at creation — before the driver's own `exit` listener. A child that
  never spawns never emits `data`, so never pauses. One reader per stream, so keying by
  `stream` (rather than the suggested fresh object) is equivalent.
- After fix 1, a pause means ≥16 suspended handling fibres on one child; the only
  non-queue suspensions inside `handleMessage` hold one slot each (prior review, Q2a),
  so "paused across two checks with no ingestion progress" is a wedge downstream of the
  reader. `pausedSince` uses `Date.now()` while the check uses `Clock.currentTimeMillis`
  — identical under the live clock, and `watchLiveness` is real-clock only.
- `piStdoutPausedNow`/`piStdoutPausedForMs` on the warn/escalate line (`:339-345`) make
  an upstream-of-publish wedge legible in the log, as intended.

### 3. Re-arm cap, exit + 5 s fallback, rename — no regression, no double run

- `RpcProcess.ts:399-411`: `rearms++ < maxRearms && (isPaused || pauseCount changed)`
  re-arms; the 11th fire falls through to `onTimeout`. Cancel still clears the current
  timer. Test `RpcProcess.test.ts:206-214` (cap 3, permanently paused: fires at 4×).
- `PiDriver.ts:2017-2058`: single `teardown` guarded by `tornDown`; `close` (`:2055`)
  and the `exit`-armed 5 s timer (`:2056-2058`) both call it; `teardown` clears the
  timer first (`:2020`). Orders: close→timer (timer cleared), timer→close (`tornDown`),
  close-before-exit (`tornDown`, timer no-ops). The `replacedProcesses` early return
  (`:2021`) precedes `tornDown = true`, but both paths return without side effects, and
  `replacedProcesses.add(previous)` (`:2084`) happens before `previous.stop()`, so a
  relaunched child's fallback timer is inert. The `sessions.get(...) === active` guard
  (`:2026-2027`) is kept. Fallback teardown while a dead child's tail is still draining
  can emit a few events after `session.exited` — identical to pre-change `exit`
  behaviour and only on the grandchild-holds-fd path.
- Exit→close ordering test `PiDriver.backpressure.test.ts:129-143` asserts
  `content.delta` then `session.exited`.
- Rename: no stale `suspendedMsTotal`/`publishSuspended*`/`pausedNow` references in
  `apps/` or `packages/` (rg). `plan.md` still says `publishSuspendedMs`; the notes flag
  it for the §6 reader. Fine.

Tests: `PiDriver.backpressure.test.ts`, `RpcProcess.test.ts`,
`ProviderRuntimeIngestionTelemetry.test.ts` → 21 passed. Coder's gate run at
`06281d82e5` (check, typecheck, server+shared suites, unmarkedsweep) accepted as
reported.
