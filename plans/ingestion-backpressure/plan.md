---
manager_sessions:
  - id: 01a0d715-409a-77dc-b837-09f9016a9b10
    role: plan
    authored_at: 2026-09-25T08:04:25.369Z
---

# Cockpit OOM: bounded, backpressured provider-runtime ingestion

Australian English. Branch `t3code/ingestion-backpressure`, worktree
`/home/Carl/loom-worktrees/ingestion-backpressure`. Authored by Carl's pi session
`01a0d715-409a-77dc-b837-09f9016a9b10` (the authoritative agent for this incident;
loom thread `dc3604a6` has been told to stand down to read-only research).

## 1. The problem, in one paragraph

Every pi agent's RPC stdout is parsed into `ProviderRuntimeEvent`s and pushed through
an **unbounded** chain — `PiDriver` `Queue.unbounded` → `ProviderService`
`PubSub.unbounded` → `ProviderRuntimeIngestion` `makeDrainableWorker` (one serial fibre
over an unbounded `TxQueue`). When arrival outruns that single fibre, the backlog is
held on the V8 heap (parsed pi messages incl. `raw` payloads and 150 KB–3.6 MB tool
results), the heap grows ~80 MB/min, GC eats a third of the main thread, the fibre gets
even less CPU, and the process dies at the 4.5 GB default ceiling roughly every 17–40
minutes. systemd restarts it, `ExecStartPre` kills every agent, they all relaunch at
once, and it repeats. Pull 7 was the trigger (reasoning and paced assistant text now go
through the engine: message events per turn went 8 → 28–65), but the mechanism is older
and will be crossed again by the next fan-out. Fix the mechanism.

### Evidence (all from production on 2026-09-25, see the incident session)

- V8 `FATAL ERROR: … heap out of memory` at 15:21:41, 15:38:51, 16:19:19; earlier
  22–24 Sep once/day. All on post-pull-7 builds; pre-pull-7 build `5c350f7` carried
  57,855 engine events/537 turns in a day at a flat 2.0 GB heap.
- Sampling heap profile (2 min window, live objects): ~172 MB of 391 MB from
  `createPiRpcProcess` → `handleLine` → `JSON.parse` — queued pi messages.
- `orchestration_events`: `provider:pi-event-*` commands being written at wall-clock
  06:06Z carried `occurred_at` 05:44Z — the ingestion fibre 22 min behind and losing
  ~2 s per wall-clock second. Result: 24/25 active threads showed `session.status =
  starting` for the whole of their turn.
- CPU profile (30 s, main thread): 31 % GC, 23 % blocked inside the synchronous
  `spawn()` syscall (fork of a 7 GB RSS process; `git add -A`/`gh pr list` storms),
  19 % in the `stdoutBuffer += chunk; indexOf; slice` line splitter, remainder Effect
  runtime + schema decoding. Idle: 1.5 s.
- Tool results this afternoon: 4,249 in ~1 h across 80 sessions, **avg 156 KB**, max
  3.6 MB, each a single JSON line on pi's stdout.

## 2. Objective and done criteria

**Objective.** The cockpit's memory must be bounded independently of how many agents
are running or how fast they emit. Slow ingestion must show up as *slower agents*
(pipe backpressure), never as an OOM. Secondary: raise ingestion throughput so the
projection lag stays in seconds.

**Done means, measured on production after deploy, under ≥ 30 concurrent pi agents:**

1. No V8 OOM for 24 h, and live heap after Mark-Compact stays < 3.5 GB (with the
   8 GB ceiling, that is headroom — the point is the curve is flat, not that the
   ceiling is high).
2. The new `provider runtime ingestion interval` log line shows queue depth bounded at
   the configured capacity and **lag p95 < 30 s** in steady state; when the pipeline
   *is* saturated, `stdoutPaused` counters are non-zero (backpressure engaged) and the
   heap still does not grow.
3. Threads no longer sit in `session.status = starting` for whole turns: a fresh turn
   reaches `running` within seconds (verify with `projection_thread_sessions`).
4. `vp check`, `vp run typecheck` and the server test suite pass; the new unit tests
   (§5) pass.

## 3. Design — five changes now, one staged; smallest model that makes the behaviour unsurprising

### 3.1 End-to-end backpressure to the pi child's stdout (the root-cause fix)

Make every hop bounded so that when ingestion is slow, the *pipe* is the buffer and the
pi child (which writes to a non-blocking pipe and buffers in its own process) slows
down — N processes each holding their own backlog instead of one holding all of them.

| Hop | File | Today | Change |
|---|---|---|---|
| pi stdout reader | `apps/server/src/provider/Layers/Pi/RpcProcess.ts` | listeners are `(msg) => void`; stdout never paused; splitter O(n²) | Extract an exported `attachStdoutLineReader(stream, onLine, { pauseAt, resumeAt })` that owns the splitter (§3.4) **and** the in-flight controller: listeners may return `void \| Promise<void>`; count unsettled promises; `stream.pause()` at ≥ **16**, `stream.resume()` at ≤ **4** (hysteresis). Resume on child exit so `end` fires. `createPiRpcProcess` calls it on `child.stdout`; tests call it on a `PassThrough`. |
| RPC request deadline | same file, `request()` | plain 30 s `setTimeout` | Pause-aware: when the timer fires and stdout is paused (or has been paused since the request was issued), re-arm for `timeoutMs` instead of rejecting. Do **not** raise the constant. Reason: steer/`set_model`/retry re-prompt requests all map a timeout to `failTurn`, and under saturation a pause lasts as long as the global drain takes. |
| driver queue | `apps/server/src/provider/Drivers/PiDriver.ts` | `Queue.unbounded` per **instance** (`events`, shared by all sessions of the instance); `wirePiProcess` discards the `runPromise` | `Queue.bounded(32)`; `wirePiProcess` **returns** the `handleMessage` promise so the reader can count it. `emit`/`emitDelivered` unchanged (`Queue.offer` on a full bounded queue suspends — that is the backpressure; `Queue.shutdown` resumes offerers with `false`, preserving `emitDelivered`). Move the driver teardown that emits `session.exited` from `child.once("exit")` to `child.once("close")` so a paused tail is delivered before the session is deleted. |
| fan-out | `apps/server/src/provider/Layers/ProviderService.ts` | `PubSub.unbounded` | `PubSub.bounded({ capacity: 256 })` (backpressure strategy: `publish` suspends when the slowest subscriber's buffer is full; with zero subscribers it drops, as today at startup). Add `runtimeEventCapacity?` to the live options so the stall test can shrink it. |
| ingestion intake | `packages/shared/src/DrainableWorker.ts` + `ProviderRuntimeIngestion.ts` | `makeDrainableWorker` over `TxQueue.unbounded` | `makeDrainableWorker(process, { capacity })` — `TxQueue.bounded(capacity)`; `TxQueue.offer` retries while full so `enqueue` suspends. Ingestion passes **256**. Existing callers keep unbounded behaviour by default. |

Chain, hop by hop: `enqueue` suspends → the `Stream.runForEach(providerService.streamEvents)`
fibre suspends → PubSub fills → `publish` suspends → `ProviderService`'s per-adapter
`runForEach` suspends → driver queue fills → `handleMessage`'s `Queue.offer` suspends →
its promise stays pending → in-flight count crosses 16 → stdout paused → pi buffers.

**Memory accounting (corrected).** `Stream.fromQueue`/`fromPubSub` pull with `takeAll`,
so each hop's effective bound is 2× its capacity. After §3.3 the events in the PubSub and
worker are small (tool payloads are deep-copied and truncated to 12 k chars by
`slimPiToolPayloadData`; the big parsed message is referenced only via `raw`). The
dominant term is therefore the **per-child in-flight `handleMessage` promises**, each
holding one parsed message: 49 × 16 × 156 KB ≈ 120 MB mean, worst case × 23 for 3.6 MB
results. The pause threshold is the memory knob; the queues are latency knobs. Pause
takes effect after the current 64 KB chunk's lines have been dispatched, so the true
ceiling is `pauseAt + lines-per-chunk`. Emitters outside the in-flight count
(`session.exited` from the exit handler, `scheduleTurnRetry`, askUser resolutions) suspend
on a full queue but pause nothing — low volume, leave a comment, do not "fix".

**Liveness (must be handled — a bounded pipeline turns a wedge into a silent freeze).**
The SQLite worker lane is one semaphore and the engine is one serial worker; if either
wedges, every hop fills and every child pauses, and nothing crashes. Today that wedge
grows the heap until V8 aborts and systemd restarts — the only recovery path that exists,
and this change removes it. Replace it deliberately: the §3.5 interval sampler records
`publishSuspendedSinceMs` (set before `PubSub.publish`, cleared after) and
`lastIngestionProgressAtMs`; when `queueDepthNow > 0` and there has been **no ingestion
progress for 5 minutes**, log an error with the sample and `Effect.die` so the process
exits non-zero and systemd restarts it (same outcome as today's OOM, minutes earlier,
with a legible log line). No per-publish timers or races on the hot path.

**pi-side cost (accepted trade).** While paused, pi buffers its stdout in its own heap
without bound (verified: a child wrote 40 MB into `writableLength` in 6 ms against a
paused parent). pi is mostly waiting on a model, so growth is self-limiting, and the
memory is spread across N processes instead of one.

### 3.2 Per-thread concurrent ingestion — STAGED, not in this change

The review established that the SQL lane and the engine dispatch are both serial, so a
keyed worker can only overlap ingestion CPU with SQL round trips (≈1.5–2×, not 8×), while
opening an ordering surface across ~3,000 lines of stateful ingestion code. Pre-pull-7 the
same serial worker carried 57 k events/day at a flat heap, so the serial worker is not
the root cause — the unbounded backlog and the GC spiral are. This change therefore
keeps the single worker (bounded, §3.1) and adds the measurement that decides the
follow-up: the interval log (§3.5) splits `processing` time into SQL-wait,
engine-dispatch-wait and the remainder. If ingestion CPU is the ceiling after deploy,
the keyed worker (`makeKeyedDrainableWorker`, per-key FIFO, global concurrency 8, same
`drain` contract) is the next PR — the ordering audit for it is already done (all
mutable ingestion state is keyed by thread / turn key / message id; the one cross-thread
write goes through the engine's serial queue).

Also delete the dead `domain` input path in `ProviderRuntimeIngestion`
(`processDomainEvent` is `Effect.void`; the subscription and the union member are unused).

### 3.3 Stop carrying `raw` past the canonical log

`ProviderService.publishRuntimeEvent` writes the canonical event log *before*
publishing. Nothing downstream reads `event.raw` (audited: no `.raw` reader in
`orchestration/` or the subscribers). Publish `const { raw: _raw, ...published } = event`
(destructure — the codebase uses `exactOptionalPropertyTypes`; `raw` is `Schema.optional`
in the contract). Note the canonical logger already summarises any event > 64 KB, so
`raw` for large pi messages is not preserved anywhere today either. This halves the per-event footprint of every
queued delta and removes a second reference to each parsed pi message. Fix any test
that asserted `raw` on a published event by asserting on the canonical logger instead.

### 3.4 Fix the O(n²) line splitter

Inside `attachStdoutLineReader` (§3.1): keep an array of `Buffer` chunks and a running
length; scan each incoming chunk for `\n` (`Buffer.indexOf`; 0x0A never occurs inside a
multi-byte UTF-8 sequence, so byte scanning is safe and the `StringDecoder` goes), and
only `Buffer.concat` + `toString("utf8")` the pieces that form a complete line. Multi-MB
tool-result lines then cost O(n), not O(n²). Keep the `\r` trim and the ignore-non-JSON
behaviour.

### 3.5 Instrumentation (so the done criteria are measurable)

Reuse the engine's pattern (`OrchestrationEngine.ts` `orchestration command queue interval`:
bucket histograms, flushed from the worker when a minute is due — no ticker fibre) for a
`provider runtime ingestion interval` log line from the ingestion layer: `enqueued`,
`processed`, `queueDepthNow`, `queueDepthMax`, `intakeSuspendedMs` (time `enqueue` spent
blocked), `lagP50Ms/P95/Max` (now − `event.createdAt` at processing start — note
`createdAt` is stamped after parse, so lag is blind to pause time; end-to-end delay =
lag + pause), `processingP50Ms/P95/Max` split into `sqlWaitMs`, `engineDispatchWaitMs`
and remainder, `publishSuspendedMs` (from `ProviderService`), `lastProgressAgoMs`, and
`enginePubSubSize` (`PubSub.size` of the engine's unbounded `eventPubSub` — the next
fan-out to watch, one field). No new tables or endpoints.

pi-side counters: `export const piStdoutBackpressure = { pauses: 0, pausedMsTotal: 0 }`
as a module-level object in `RpcProcess.ts`, mutated at the pause/resume sites, and read
as two fields inside `diagnostics/RuntimePerformanceMonitor.ts`'s existing `sample`
(that monitor logs a fixed object of V8/event-loop fields; it does not read Effect
`Metric`s, and the OTLP metrics never reach the logs — so no `Metric` step).

### 3.7 Stop loading the whole projection at boot (the ~2.3 GB baseline)

Finding from loom thread `dc3604a6`'s read-only heap research (`docs/oom-thread-notes.md`):
the main isolate sits at 2.1–2.3 GB live 30 s after boot with **zero agents**, and that
baseline scales with activity + message volume (0.4 GB on a copy trimmed to 1/20). The
allocation is `ProviderRuntimeIngestion.reconcileInterruptedToolActivitiesOnStartup`
calling `projectionSnapshotQuery.getSnapshot()` — every thread's activities (458 k rows,
970 MB of `payload_json`), messages (210 k) and checkpoints — to find in-progress tool
activities on the few threads that have `session.activeTurnId` set and no live runtime
session. The rows are then pinned by Effect rc.115 `Cache` entries that keep their
lookup fiber (and its `cache.stackFrame`/`cache.span`) after exit; we cannot fix the
library, so do not allocate the rows.

Change: rewrite the reconcile to (1) list only sessions with an active turn — add a
small `listWithActiveTurn` query to the thread-sessions repository
(`WHERE active_turn_id IS NOT NULL`), (2) skip those with a live runtime session, and
(3) for each remaining thread call `ProjectionThreadActivityRepository.listByThreadId`
and apply the existing stuck-activity logic unchanged. Same behaviour, no full snapshot,
no boot-time 1 GB JSON decode. Delete the `getSnapshot` import if it becomes unused.
Existing tests for the startup reconcile must pass unchanged in intent.

Related but out of scope (report to Carl): the sqlite **worker** isolate went from
15 MB (effect beta.103, pre-pull-7) to 2.3–2.4 GB (rc.115) because `SqliteWorker`'s
`prepareCache` entries retain their lookup fiber → span → `exit.args` holding the first
result-row array of each cached statement. It adds to RSS (and to fork cost) but is not
the OOM isolate.

### 3.6 Out of scope (deliberately)

- The spawn storm (23 % of main thread in `fork`) — owned by
  `plans/cockpit-performance-remediation/plan.mdx`; this change lowers its cost
  indirectly by keeping RSS small.
- Reducing engine command volume for reasoning (pull-7 behaviour change) — a UX
  decision for Carl, not needed once the pipeline is bounded.
- The usage-ledger `attempt to write a readonly database` bug — separate, loom thread
  `a0f8eb9a` is writing it up.
- pi-side output buffering limits (see the accepted trade in §3.1).
- The engine's `eventPubSub` is also `PubSub.unbounded` with ~12 subscribers including
  one per WS client; a slow remote browser grows that ring without bound. Not this
  incident's path (the heap profile points at `handleLine → JSON.parse`); §3.5 logs its
  size so the next OOM is attributable.
- The keyed worker (§3.2) — follow-up PR, decided on the §3.5 data.

## 4. Ops changes (outside the repo — already applied, keep)

`~/.config/systemd/user/loom-cockpit.service` `ExecStart` now carries
`--max-old-space-size=8192` (backup `…service.bak-20260925`, `daemon-reload` done;
takes effect at the next restart, which the deploy performs). This is headroom, not the
fix; with 62 GB RAM and a bounded pipeline it is safe. Note the installed unit already
differs from `loom-slack-bridge/deploy/loom-cockpit.release-store.service`
(`--trace-gc --inspect`), so the template is not authoritative — do not "fix" that here.

## 5. Tests (focused; this is core-pipeline code, so they earn their keep)

- `packages/shared/src/DrainableWorker.test.ts` (new or extended): with `capacity`,
  `enqueue` blocks at capacity and unblocks as items finish; `drain` still waits for
  in-flight; default stays unbounded.
- `RpcProcess.test.ts` (today only tests `buildPiRpcArgs`; `createPiRpcProcess` is not
  injectable — test the extracted `attachStdoutLineReader` on a `PassThrough`): a line
  split across many chunks; multiple lines per chunk; `\r\n`; a > 1 MB line; multi-byte
  UTF-8 split across chunks; pause when ≥ 16 listener promises are open (`isPaused()`),
  resume at ≤ 4; end-of-stream flushes the tail; the pause-aware `request()` deadline
  re-arms while paused and still rejects when not paused.
- `ProviderService` test (existing file): published events carry no `raw`; the canonical
  logger still receives it; with `runtimeEventCapacity: 2` and a subscriber that stops
  consuming, `publishSuspendedMs` becomes non-zero in the sample (do not test the 5-min
  die in unit tests — make the threshold injectable and test the decision function).
- `ProviderRuntimeIngestion*.test.ts` — run the **full** set; the `drain` contract is
  unchanged so they should pass unchanged.

Gate: `vp check` and `vp run typecheck` at the repo root, then
`pnpm exec vp test run apps/server packages/shared`.

## 6. Verification on real data (the canonical entrypoint)

Unit tests are necessary, not sufficient. After `pnpm ship` merges and
`~/loom-slack-bridge/deploy/deployctl deploy main` promotes (health gates + 5 min soak
+ auto-rollback are built into deployd):

1. `journalctl --user -u loom-cockpit -f | grep -E "ingestion interval|performance interval|Mark-Compact"`
   for ≥ 2 h: heap after Mark-Compact flat; lag p95 < 30 s; queue depth < capacity or
   pauses > 0.
2. `sqlite3 -readonly ~/.t3/cockpit/userdata/state.sqlite "select status, count(*) from projection_thread_sessions where updated_at > datetime('now','-10 minutes') group by 1"` — `running` should dominate while agents work.
3. Send a message to a live thread and confirm the reply projects within seconds.

If any of these fail: `deployctl rollback` (previous release `20260925-020235-9ad7082`
is still installed) and report.

## 7. Sequence

1. Plan review (Fable 5.1 reviewer) → amend.
2. Implement (Opus 5.5 coder) §3.1, 3.3, 3.4, 3.5 + the `domain`-path deletion + §5
   tests in this worktree; commit in logical pieces (`splitter+reader`, `backpressure`,
   `raw`, `instrumentation`, `dead domain path`), then §3.7 (`startup reconcile`).
3. Implementation review (Fable 5.1 reviewer): correctness of the backpressure chain,
   the bounded-PubSub hazard audit, ordering guarantees, test adequacy.
4. Gate → `pnpm ship -m "…"` (loom's merge authority is `agent`) → `deployctl deploy main`.
5. Verify (§6) → Slack Carl via the heartbeat thread.

## 8. Changelog

- v2 (after plan review `review-plan.md`, Fable 5.1): pause-aware RPC deadline; liveness
  escalation (5-min no-progress → die) instead of a per-publish watchdog; extracted,
  testable `attachStdoutLineReader`; instrumentation rewired to the engine's histogram
  pattern and the performance monitor's `sample` (no `Metric`); capacities re-derived
  (16/4 in-flight per child, driver 32 per instance, PubSub 256, worker 256); keyed
  worker staged to a follow-up; `close`-based driver teardown; `raw` destructured;
  dead `domain` path deleted; engine `eventPubSub` size logged.
- v3: §3.7 added from the loom thread's heap research (boot-time `getSnapshot()` is the
  2.3 GB baseline); sqlite-worker retention noted as out of scope.
