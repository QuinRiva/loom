# Plan review: bounded, backpressured provider-runtime ingestion

Reviewed against the worktree source at `plans/ingestion-backpressure/plan.md`'s
commit. Effect 4.0.0-rc.115 semantics checked in
`apps/server/node_modules/effect/dist/*.js`. Line numbers are from this worktree.

## Verdict

**APPROVE WITH CHANGES.** The mechanism (bound every hop so the pipe is the buffer)
is right and the chain does propagate. Five things must change in the plan before
implementation: RPC timeouts during a pause fail turns; the bounded pipeline turns a
stuck consumer into a silent global freeze (today's OOM-restart was an accidental
watchdog); two named test/instrumentation hooks do not exist; and the capacity
accounting is structurally wrong, so the numbers derived from it are wrong.

## Blocking issues

### 1. Pausing stdout starves `request()` and fails turns under exactly the load the plan targets

Evidence:
- `apps/server/src/provider/Layers/Pi/RpcProcess.ts:264` `DEFAULT_REQUEST_TIMEOUT_MS = 30_000`; `request()` (`:407-430`) arms a plain `setTimeout` that knows nothing about the stream state. Responses arrive on the same stdout (`:330-341`), so a paused child cannot answer.
- Requests issued to a child that can be mid-burst (and therefore paused): steer/prompt `PiDriver.ts:2648` (`streamingBehavior: "steer"` on a running turn), `set_model` `:1040`, `:1252`, `:1524`, `set_thinking_level` `:1274`, retry re-prompt `:1441`, `:1547`. Every one maps a timeout to `ProviderAdapterRequestError` → `failTurn` (`:1451-1453`, `:1560-1566`) or a failed send. `abort` is a `write` (`:2699`) and is unaffected.
- The plan's own rationale ("a healthy system resumes in well under a second", §3.1) is about the unsaturated case. Under saturation — the incident state, 22 min behind — a child's pause lasts until 24 of its offers drain through a queue shared with 48 other children; that is proportional to global drain rate and is unbounded by design. 30 s will be exceeded.
- pi keeps reading stdin while its stdout is paused (Node child stdout on Linux is async; verified locally: a child wrote 40 MB into its own `writableLength` in 6 ms against a paused parent), so a steer *is* delivered and acted on while T3 reports the send failed.

Change: make the request deadline pause-aware in `RpcProcess.request()` — when the timer fires and stdout is (or has been since the request was issued) paused, re-arm for `timeoutMs` instead of rejecting. ~5 lines; add to §3.1 and to the §5 `RpcProcess.test.ts` list. Do not raise the constant.

### 2. Liveness regression: a stalled consumer now freezes every agent silently, and the watchdog only logs

Evidence:
- Single serial points that can hang: the SQLite worker lane is one semaphore (`apps/server/src/persistence/NodeSqliteWorkerClient.ts:185-186`); the engine is one `Effect.forever` worker (`OrchestrationEngine.ts:732`) and ingestion's `dispatch` awaits its Deferred (`:760-767`). If either wedges, the ingestion worker fills (1024), the PubSub fills, every adapter `runForEach` suspends in `publish`, every driver queue fills, every child pauses. Nothing crashes.
- Today the same wedge grows the heap until V8 aborts and systemd restarts (plan §1). That restart is the only recovery path that exists; the plan removes it and replaces it with a `logError` once a minute.
- The proposed watchdog (a race/timer per `publish`) also costs a timer + fibre per event on the hottest path in the process.

Change: (a) implement stall detection as a *sampled* check in the §3.5 interval logger — record `publishSuspendedSinceMs` (set before `PubSub.publish`, cleared after) and `lastIngestionProgressAtMs`; the interval log reports both. No per-publish timers. (b) Decide the escalation in the plan: after N minutes (suggest 5) with `queueDepthNow > 0` and no progress, exit the process (`Effect.die` → non-zero exit → systemd restart) — this preserves today's de-facto recovery — or, if Carl prefers a freeze over a restart, say so and make the state visible on whatever deployd's health gate polls. Silent freeze is not an option.

### 3. `RpcProcess.test.ts` has no fake-child harness; `createPiRpcProcess` is not injectable

Evidence: `apps/server/src/provider/Layers/Pi/RpcProcess.test.ts:1-93` tests only `buildPiRpcArgs`. `createPiRpcProcess` calls `NodeChildProcess.spawn` directly (`RpcProcess.ts:296`); the only injection seam is one level up (`makePiAdapter`'s `createProcess`, `PiDriver.ts:846`), which bypasses the reader entirely.

Change: §3.4/§5 must specify the seam. Smallest: extract `attachStdoutLineReader(stream: Readable, onLine, { pauseAt, resumeAt })` (the splitter + in-flight/pause controller) as an exported function in `RpcProcess.ts` and test it with a `PassThrough` (`isPaused()` works on it). `createPiRpcProcess` calls it on `child.stdout`. Do not add a `spawn` injection parameter for this.

### 4. §3.5 names a mechanism that does not exist

Evidence: `apps/server/src/diagnostics/RuntimePerformanceMonitor.ts:35-60` logs a fixed object of V8 heap + event-loop fields; it reads no Effect `Metric`. The counters in `observability/Metrics.ts` (e.g. `providerRuntimeEventsTotal`, used at `ProviderService.ts:1263,1356`) are only exported over OTLP when configured (`cli/config.ts:97-109`) and never appear in logs.

Change: drop the `Metric` step. Keep one module-level counter object in `RpcProcess.ts` (`export const piStdoutBackpressure = { pauses: 0, pausedMsTotal: 0 }`, mutated from the pause/resume sites) and read two fields from it inside the monitor's `sample` (`RuntimePerformanceMonitor.ts:35`). Also log `pausedMsTotal` per interval: `lagP95Ms` is stamped from `event.createdAt`, which PiDriver sets *after* parse (`PiDriver.ts:660`), so lag is blind to pause time; end-to-end delay = lag + pause.

### 5. The capacity accounting is structurally wrong; derive the numbers again

Evidence:
- `Stream.fromQueue` and `Stream.fromPubSub` pull with `takeAll` (`effect/dist/Channel.js:826`, `:992`, `:1233`), draining the whole buffer into one chunk and immediately freeing it (`Queue.js` `takeAllUnsafe` → `releaseCapacity` admits waiting offerers). Every hop's effective in-memory bound is **2× its capacity**.
- The driver queue is **per adapter instance**, not per child (`PiDriver.ts:2875`, shared by every session of the instance via `emit` `:865`). "49 × 64" does not exist; it is 64 (+64 chunk) total.
- The heavy object — the parsed pi message — is referenced only through `raw.payload` (`PiDriver.ts:672-678`, `rawPiMessage`) and the tool result via `mergeRawInput` (`:760-764`); `slimPiToolPayloadData` deep-copies with 12 k-char truncation (`:711-716`, `MAX_ACTIVITY_TEXT_CHARS`), so `payload.data` does not share the big strings. After §3.3 drops `raw` at the canonical log, events in the PubSub and worker are small. **The dominant memory term is the per-child in-flight `handleMessage` promises**, each holding one parsed message: 49 × 32 × 156 KB mean ≈ 245 MB, worst case ×23 for 3.6 MB results. The pause threshold — not the queues — is the memory knob, and it counts promises, not bytes.
- Latency: the keyed worker is global-FIFO across keys, so a fresh thread's `turn.started` (idle child → never paused → offered immediately) waits behind the *entire* backlog. Done criterion 3 ("reaches `running` within seconds") is `worker depth ÷ throughput`; 1024 at 35 ev/s is 30 s. Depth beyond what keeps 8 fibres busy only adds lag.
- Concurrency: the SQL lane is serial (`NodeSqliteWorkerClient.ts:185`) and every runtime event does ≥ 1 round trip (`getThreadRuntimeContext`, `ProviderRuntimeIngestion.ts:1995`) plus a serial engine dispatch; > 8 concurrent fibres buys nothing.

Change (numbers, with the reasoning above written into §3.1): pause/resume **8/2** (or 16/4) in-flight per child; driver queue **32**; PubSub **256** (power of two, fine); worker **256**; concurrency **8**. Also note the per-chunk overshoot: pause takes effect after the current 64 KB chunk's lines are dispatched, so the true ceiling is `pauseAt + lines-per-chunk`.

## Non-blocking suggestions

- **§3.2 is the only new machinery and its gain is unquantified.** The serial SQL lane and the serial engine cap throughput; concurrency 8 can only overlap ingestion's main-thread CPU with SQL round trips (≈1.5–2×, not 8×). Either (a) stage it — land §3.1/3.3/3.4/3.5 with a one-line bound on the existing worker (`TxQueue.bounded(capacity)` in `DrainableWorker.ts:52`; `TxQueue.offer` retries while full, `TxQueue.d.ts:433`), measure `processingP95Ms` split into SQL-wait / engine-dispatch-wait / CPU, then add the keyed worker if ingestion itself is the ceiling; or (b) keep it but state the mechanism and bound honestly and add that split to the interval log so §6 can attribute. I lean (a): the ordering surface it opens (see next bullets) is not free.
- **Keyed worker shape**, if kept: per-key drainer forked into the worker's *captured* scope (`enqueue` runs on foreign fibres — `Effect.forkIn(scope)`, not `forkScoped`) + `Semaphore.make(concurrency)` + one `TxRef` total for capacity/drain; delete the key's state when its array empties. Wrap `process` in `Effect.ignoreCause` so a defect ends the item, not the drainer.
- **Ordering audit (Q3) is clean.** All mutable ingestion state is keyed by thread, turn key or message id: `lastHeartbeatWriteMsByThread`, `inFlightToolActivitiesByThread` (`ProviderRuntimeIngestion.ts:1162-1167`), `lastActivityCheckpointMsById` (`${threadId}:${activity.id}`, `:1221`), the `Cache`s keyed by `providerTurnKey`/`segmentStateKey` (`:1256-1300`). The one cross-thread write (`thread.proposed-plan.upsert` to `sourceThreadId`, `:1965-1982`) goes through the engine's serial queue. The diff worker feeds back into the main worker by thread (`:3108`), same as today. Tests that assert cross-thread engine-event order may flake under concurrency; run the full `ProviderRuntimeIngestion*.test.ts` set, not a subset.
- **Delete the `domain` input path.** `processDomainEvent` is `Effect.void` (`:2963`); the subscription (`:3170-3177`) and the union member (`:160-163`) are dead. −15 lines and one less thing the keyed worker must key.
- **Paused tail after exit.** With resume-on-exit, buffered lines are delivered *after* PiDriver's `exit` handler has deleted the session and emitted `session.exited` (`PiDriver.ts:1999-2029`; the listener stays subscribed). Today that race is rare; with a pause it is guaranteed. Prefer `child.once("close")` for the driver teardown (fires after stdio ends) or drop the tail. Say which.
- **`raw` removal**: destructure (`const { raw: _raw, ...published } = event`) rather than `raw: undefined`; the codebase's `...(x ? { raw } : {})` idiom indicates `exactOptionalPropertyTypes`. Note the canonical logger already summarises any event > 64 KB (`EventNdjsonLogger.ts:35`, `:342-375`), so `raw` for large pi messages is not preserved anywhere today either — state that so nobody expects it. The `fits` traversal aborts at the budget, so keeping `raw` on the log path is bounded CPU; fine.
- **Second unbounded fan-out.** The engine's `eventPubSub` is `PubSub.unbounded` (`OrchestrationEngine.ts:191`) with ~12 subscribers including one per WS client (`ws.ts:2497`, `:2676`); a slow remote browser grows that ring on the heap without bound. Not this incident's path (heap profile points at `handleLine → JSON.parse`), so leave it out of scope — but name it in §3.6 and log `PubSub.size(eventPubSub)` in the interval line (one field) so the next OOM is attributable.
- **Percentiles**: reuse the engine's bucket-histogram pattern (`OrchestrationEngine.ts:194-213`, `COMMAND_QUEUE_WAIT_BUCKETS_MS`, log-if-due from the worker rather than a ticker) instead of a ring of samples.
- **Stall test in §5** needs a capacity override: add `runtimeEventCapacity?` to `ProviderServiceLiveOptions`.
- **Emitters outside the in-flight count** (`session.exited` from the exit handler `:2011`, `scheduleTurnRetry` timer `:1471`, askUser broker resolutions) suspend on a full queue but never pause anything. Low volume; fine — note it in the RpcProcess comment so nobody "fixes" it.
- **pi-side cost**: while paused, pi buffers stdout in its own heap without bound (measured above). Pi is mostly waiting on a model so growth is self-limiting, and the memory is now spread across N processes instead of one. State this as the accepted trade in §3.6 rather than only "pi-side output buffering limits".

## Verified claims

- Chain today is unbounded at every hop: `Queue.unbounded` `PiDriver.ts:2875`; `PubSub.unbounded` `ProviderService.ts:504`; `TxQueue.unbounded` `DrainableWorker.ts:52`.
- Hop 1 propagates: `Effect.runForkWith` evaluates the fibre synchronously (`effect/dist/internal/effect.js:2426-2428`), so `Queue.offer` on an open queue with space completes in listener-call order and a full queue suspends the fibre; the `runPromise` promise stays pending until the fibre exits. Returning it from the `wirePiProcess` listener (`PiDriver.ts:1996-1998`) gives RpcProcess a countable in-flight signal. Suspended offers wake FIFO (`Queue.js` `offers` is an insertion-ordered `Set`; `releaseCapacity` iterates it).
- Hop 2/3 propagate: `Queue.bounded` suspends offerers (`Queue.d.ts:405-408`); `PubSub.bounded` uses `BackPressureStrategy.handleSurplus` → `Deferred.await` (`PubSub.js` `BackPressureStrategy`), full = slowest subscriber (`BoundedPubSubArb.isFull`); with zero subscribers `publish` returns `true` and drops (`BoundedPubSubArb.publish`), so startup ordering (ingestion subscribes in `start()` after `forkParked`, `ProviderRuntimeIngestion.ts:3163`; adapters subscribed at `ProviderService.ts:1494`) behaves as today. `Stream.runForEach` adds no buffer; the only buffering is the `takeAll` chunk (issue 5).
- Subscribers of `providerService.streamEvents` in production code are exactly three: `ProviderRuntimeIngestion.ts:3164` (enqueue to worker), `CheckpointReactor.ts:1177` (filter + enqueue to an unbounded `makeDrainableWorker`, `:1160`), `ProviderUsageLimitsIngestion.ts:25` (filter + `applyUsageLimits` → `PubSub.unbounded` publish, `makeManagedServerProvider.ts:137`; `ignoreCause`). None blocks. Tests use `Stream.take`/`runHead` (unsubscribe on completion) or fakes; none publishes > 256 events.
- Adapter refresh is safe: `reconcileInstanceSubscriptions` (`ProviderService.ts:1466-1490`) only forks *publishers*; the old fibre ends when its queue shuts down (`PiDriver.ts:2894-2896` finalizer: `stopAll` then `Queue.shutdown`), and `Queue.shutdown` resumes suspended offers with `false` (`Queue.js` `finalize`), preserving `emitDelivered`'s undelivered semantics (`PiDriver.ts:870`).
- Ingestion never calls a pi RPC (only `providerService.getSession`/`listSessions`, `:1926`, `:3016`), so there is no publish→pause→request cycle that can deadlock; issue 1 is delay, not deadlock.
- `raw` has no reader after the canonical log: no `event.raw`/`.raw.payload` access in `orchestration/`, the three subscribers, `mcp/`, `relay/`, or any test asserting on a *published* event (`ProviderRuntimeIngestion.test.ts:5113` only *supplies* `raw`). `raw` is `Schema.optional` (`packages/contracts/src/providerRuntime.ts:275`).
- Splitter is O(n²) per line as described (`RpcProcess.ts:353-360`, `+=` then `indexOf`/`slice` per chunk). `\n` (0x0A) never occurs inside a multi-byte UTF-8 sequence, so byte-scanning chunks and decoding only complete lines is correct; the `StringDecoder` becomes unnecessary.
- Existing `DrainableWorker` contract (`drain` = empty and idle) is what `ProviderRuntimeIngestion*.test.ts` depend on; the plan's keyed-worker `drain` definition preserves it.
- The engine's `orchestration command queue interval` (`OrchestrationEngine.ts:236`) is the right template for §3.5; it is flushed from the worker, not a ticker.
- Ops note §4 is outside the repo and not reviewed.
