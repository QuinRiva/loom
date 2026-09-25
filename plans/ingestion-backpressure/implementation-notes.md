# Implementation notes: bounded, backpressured provider-runtime ingestion

Implements `plan.md` §3.1, §3.3, §3.4, §3.5, the dead `domain` path (§3.2), §5 tests, and
§3.7 (added by plan v3 mid-implementation; see Deviations 1). Keyed worker not built.

## Commits (on top of the plan commit; not pushed)

1. `7cae14753c` splitter + reader: `attachStdoutLineReader`, `setPauseAwareTimeout` (RpcProcess).
2. `af505d0803` backpressure: DrainableWorker `capacity`, worker 256, PubSub 256, driver queue 32,
   `wirePiProcess` returns the promise, teardown on `close`.
3. `68b58ecdfa` `raw` stops at the canonical log.
4. `c4deb034fa` dead `domain` input deleted (committed before instrumentation so telemetry only
   handles runtime/diff inputs).
5. `d5fdf5e085` instrumentation + liveness (`diagnostics/ProviderRuntimeIngestionTelemetry.ts`).
6. `5fa765074f` (plan author, not mine): plan v3 + `docs/oom-thread-notes.md`.
7. `176e7c7aca` §3.7 startup reconcile without the full snapshot.

## What was built, per section

- **§3.4 / §3.1 reader.** Byte-level `\n` scan; only complete lines are concatenated and decoded
  (`StringDecoder` gone). Listeners may return a promise; ≥16 unsettled → `pause()`, ≤4 → `resume()`.
  `release()` on child `exit` resumes for good so the tail drains to `end`/`close`.
- **§3.1 deadline.** `setPauseAwareTimeout`: on fire, re-arm if paused now or a pause started since
  it was armed (tracked via `pauseCount`); otherwise reject. Constant unchanged (30 s).
- **§3.1 hops.** As tabled in the plan. `emit`/`emitDelivered` unchanged.
- **§3.3.** `Effect.flatMap(({ raw: _raw, ...published }) => …publish(published))`.
- **§3.5.** One `provider runtime ingestion interval` line, flushed from the worker when a minute is
  due (engine pattern): `enqueued processed queueDepthNow queueDepthMax intakeSuspendedMs
  lagP50/P95/MaxMs processingP50/P95/Max/TotalMs sqlReadWaitMs engineDispatchWaitMs remainderMs
  publishSuspendedMs publishSuspendedForMs lastProgressAgoMs enginePubSubSize`. Runtime performance
  monitor gains `piStdoutPauses piStdoutPausedMs piStdoutPausedNow` (per-interval deltas).
- **§3.1 liveness.** Once-a-minute watchdog fibre; pure `decideIngestionLiveness` returns
  ok/warn/escalate; escalate logs the sample at error and exits the process with code 1.
- **§3.2 deletion.** `processDomainEvent`, the `domain` union member and the engine subscription.
- **§3.7.** New `ProjectionThreadSessionRepository.listWithActiveTurn` (joined to existing thread
  rows, as the snapshot effectively was); per remaining thread,
  `listByThreadId({ activityKinds: ["tool.started","tool.updated","tool.completed"] })` mapped to
  `OrchestrationThreadActivity`; the stuck-activity loop body is untouched.

## Deviations from the plan, and why

1. **§3.7 implemented.** Plan v3 landed while I was implementing and put §3.7 into §7 step 2. I
   consulted the plan's manager (`01a0d715…`, role plan): answer "implement now as a sixth
   commit", confidence **high**. Logged in `.pi/manager/consults.jsonl` (left uncommitted).
2. **Escalation is `process.exit(1)`, not `Effect.die`.** A die in a forked scoped fibre ends only
   that fibre; nothing propagates to `NodeRuntime.runMain`, so the process would not exit. The
   plan's intent (non-zero exit → systemd restart) needs a real exit. SIGTERM was rejected: a
   graceful shutdown can hang on the very wedge being escaped.
3. **Stall measured in consecutive observed checks (5 × 60 s), not wall-clock "5 min since
   progress".** A desktop/laptop waking from sleep with work queued would otherwise exit on the
   first tick. "Progress" = an item started *or* finished, so a quiet spell before a slow item does
   not count against it. Pending work = queue depth > 0, **or** a publish suspended since before
   the previous check (covers a wedged *other* PubSub subscriber, where ingestion sits idle).
4. **The watchdog is a ticker fibre** (the histogram flush stays in the worker, per plan). A wedged
   worker can never flush, so a worker-driven check cannot detect the wedge. The ticker uses the
   Effect clock, so it is inert under `TestClock` (no ingestion test adjusts the clock).
5. **`sqlWaitMs` → `sqlReadWaitMs`.** Charged via a fibre-local `Context.Reference` accumulator in
   `NodeSqliteWorkerClient`'s permit wrapper: async read-lane wait + round trip only. Ingestion's
   own repositories write through the synchronous in-process client; that time is in `remainderMs`.
   This is the split the keyed-worker decision needs (waits overlap, synchronous work does not).
   Engine dispatch is timed by rebinding `orchestrationEngine` in ingestion to a `{ dispatch }`
   wrapper (dispatch is the only method it uses after §3.2).
6. **pi counters: three fields** (`pausedNow` added) because `pausedMsTotal` only grows on resume,
   so a stuck pause would otherwise be invisible.
7. **`publishSuspendedMs`** is wall time with ≥1 publish in flight (union across adapters), plus
   `publishSuspendedForMs` for an ongoing run. Counters live in the telemetry module; ProviderService
   calls `trackRuntimeEventPublish`. Engine PubSub size is registered module-level
   (`registerEngineEventPubSubSize`) to avoid adding a field to `OrchestrationEngineShape` and its
   15 test fakes.
8. **PiDriver `close` handler only deletes its own session entry.** `stop()` resolves on `exit`;
   `close` can land after a replacement session for the same thread registered.
9. **Decision-function test** lives in `diagnostics/ProviderRuntimeIngestionTelemetry.test.ts`, next
   to the function, not in `ProviderService.test.ts`.
10. No running byte length in the splitter: `Buffer.concat` computes it.

## Existing tests changed (genuine behaviour change)

- `PiDriver.userInput.test.ts`, `PiDriver.compaction.test.ts`: fake children emit `close` after
  `exit`, as a real child does, since the driver's teardown now listens on `close`.
- `ProviderService.test.ts` canonical-events test extended to assert `raw` reaches the logger but
  not the published event. New stall test (capacity 2, stalled subscriber → `inFlight` 1, ≥1000 ms
  recorded after unblocking).

## Gates (final run, at `176e7c7aca`)

- `pnpm exec vp check` → exit 0, "Found 0 errors and 912 warnings" (all pre-existing; none in
  touched hunks).
- `pnpm exec vp run typecheck` → exit 0, 0 `error TS`.
- `pnpm exec vp test run apps/server/src/orchestration/Layers apps/server/src/provider packages/shared`
  → default concurrency, loaded host (load avg ~5): 3371 passed, 3 failed — `GrokAdapter.test.ts` ×2,
  `ProviderRegistry.test.ts` "rebuilds the pi instance…". All pass alone (ProviderRegistry test 5/5 runs; GrokAdapter file 46/46) and
  the same command with `--maxWorkers=4` passes **3374/3374**. They spawn real subprocesses under
  tight real-time budgets; GrokAdapter imports none of the changed code.
- Plan §5 gate `pnpm exec vp test run apps/server packages/shared` → 7358 passed, 29 failed: 28 in
  `git/GitManager.test.ts`, `vcs/GitVcsDriver*.test.ts` (fail deterministically alone too; host git
  is 2.30.2, code untouched) + the ProviderRegistry flake.
- `docs/upstream-sync/pull7-tools/unmarkedsweep.sh` → clean.
- Mutation checks: DrainableWorker capacity test fails with the bound removed; startup-reconcile
  test fails with `listWithActiveTurn` inverted.
- Not run: canonical entrypoint against real data / production (plan §6 is post-deploy).

## Look at hardest

- **Liveness exit** (`ProviderRuntimeIngestionTelemetry.ts` `watchLiveness`): a false positive
  restarts the cockpit and every agent. Check the pending/progress definitions against real traffic.
- **`close` teardown**: if a pi tool's grandchild inherits pi's stdout fd and outlives pi, `close`
  (and `session.exited`) waits for it. I believe pi's bash tool pipes its children, not verified.
- **handleMessage promises that await pi RPCs** (retry/reroute paths `PiDriver.ts` ~1409–1560 call
  `session.process.request` inside `handleMessage`). Each holds an in-flight slot while waiting for
  a response on the same stdout. Needs ≥16 such at once to self-deadlock one child (the deadline
  re-arms while paused); I judged it unreachable (one per errored turn). Worth a second opinion.
- **Callers that now suspend on a full driver queue/PubSub**: `sendTurn`/`startSession` emits
  (ProviderCommandReactor waits), ProviderService's own synthetic publishes. No cycle back into the
  ingestion worker that I could find (ingestion only calls `getSession`/`listSessions`).
- Bounded PubSub drops when there are zero subscribers (same as the plan states for startup).
