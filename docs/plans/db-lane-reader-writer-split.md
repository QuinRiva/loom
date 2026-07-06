---
manager_sessions:
  - id: 9eb90884-ecb2-4f0e-970b-926ad1ae06bb
    role: plan
    authored_at: 2026-07-06T03:56:02.394Z
---

# DB lane: reader/writer split, zero cross-process writers, CLI routing

**Status:** proposed — human review required before implementation.
**Scope:** the structural fix for `orchestration.dispatchCommand` stalls (>15 s observed client-side) in the loom server's SQLite lane.
**Companion work:** Wave 1 slow-request telemetry for orchestration RPCs (separate coder thread) supplies the queue-wait vs processing-time split this plan's verification relies on.

---

## 1. Problem

Clients observe `orchestration.dispatchCommand` RPCs stalling for more than 15 seconds, several in a row, to threads that are otherwise healthy. The forensic timeline found no server-side evidence (no slow-request logging existed) and zero SQLite lock errors; the code audit located the mechanism. This plan is the "fix #5 (structural)" the audit called for.

### 1.1 Mechanism — four layers that compound

1. **Global serial command worker.** `OrchestrationEngine` drains one unbounded queue with a single fiber: every command for every thread, goal and project is processed strictly one at a time. Any slow `processEnvelope` at the head of the queue delays every queued command behind it.

2. **Each command is a full SQLite transaction.** `processEnvelope` runs a receipt read, then `sql.withTransaction(...)`: append event(s), run the projection pipeline's writes, upsert the command receipt. With SQLite's default `synchronous = FULL`, every commit also pays an fsync.

3. **One connection, one permit.** The whole server shares one `SqlClient` backed by one worker thread holding one `DatabaseSync` connection, guarded by `Semaphore.make(1)` (`NodeSqliteWorkerClient.ts`). A transaction holds the permit for its entire duration. Every other DB operation in the server — snapshot reads for the web UI and MCP tools, event replays on WS reconnect, auth-session verification, usage-ledger inserts, heartbeat touches — queues behind it.

4. **Cross-process writers on the same file.** The DB file is WAL with `busy_timeout = 5000`. Separate short-lived `t3` CLI processes open the same file. SQLite allows one writer at a time _across processes_, so when a CLI process holds the write lock, a server transaction blocks for up to 5 s **while still holding the single in-process permit** — freezing all server DB access for the window. Overlapping contention compounds: 3 × 5 s ≈ the observed >15 s stalls.

Layer 4 is the amplifier: without it, a transaction is single-digit milliseconds; with it, a transaction can be three orders of magnitude slower while everything queues behind it.

### 1.2 Corrected picture of the cross-process writers (new findings)

The incident reports assumed "workstream mutations triggered by pi children" run as CLI processes. Verified against the code, that premise needs three corrections — and the corrections _sharpen_ the fix rather than weakening it:

- **Pi children never open the DB.** All pi-child workstream/goal tooling (`workstream_spawn`, `goal_task_*`, etc.) is implemented as pi extensions that `fetch()` the running server's HTTP endpoints (`WorkstreamSpawnExtension.ts`, `GoalTaskExtension.ts` → `McpHttpServer`/`WorkstreamSpawnHttp`/`GoalTaskHttp`). Those mutations dispatch in-process on the server. The cross-process writer population is exactly the **human/script-facing CLI**: `t3 goal`, `t3 project` (via `cli/orchestrationMutation.ts`).

- **Even the CLI's "live" path opens the DB file.** `runOrchestrationMutation` prefers a running server and dispatches over HTTP — but to authenticate it calls `EnvironmentAuth.issueSession(...)`/`revokeSession(...)`, and `EnvironmentAuth.runtimeLayer` is built on `SqlitePersistenceLayer`. So **every** CLI invocation, live or offline, opens the DB file, runs the full pragma + migration setup, INSERTs an auth-session row, and later DELETEs/updates it. Cross-process write contention exists on every `t3 goal`/`t3 project` run today, not just in fallback.

- **The offline fallback is a self-amplifying failure mode.** `tryResolveLiveExecutionMode` probes the server with a **1-second** timeout on a full orchestration-snapshot fetch. A server that is merely _busy_ (the very condition under investigation) fails the probe; the CLI then (a) **deletes the persisted server runtime state**, so subsequent CLI runs don't even try the live path until the server restarts, and (b) falls back to **offline mode, booting a complete in-process orchestration engine** against the live DB file — migrations, projection bootstrap, command dispatch, all as a second writer process. A busy server thus recruits additional writer processes that make it busier. This loop must die.

### 1.3 Write/read frequency inventory (what actually flows through the lane)

Verified against the code; frequencies marked _(assumed)_ will be confirmed by the Wave 1 telemetry before any tuning-stage work relies on them.

**Writes through the command worker (each = one transaction):**

| Source                     | Command types                                                                                                                                                                                                                             | Frequency                                                                                                                                                                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider runtime ingestion | `thread.message.assistant.delta` / `.complete`, `thread.message.reasoning.complete`, `thread.activity.append`, `thread.turn.diff.complete`, `thread.session.set`, `thread.proposed-plan.upsert`, `thread.meta.update` (14 dispatch sites) | Per item lifecycle, **not** per token: assistant text deltas are buffered in memory and flushed once per message/segment. Order of a few commands per second at burst with ~8 active children _(assumed)_ |
| Web UI / MCP HTTP tools    | user-initiated commands (turn start, workstream mutations, goal tasks…)                                                                                                                                                                   | Human-scale, bursty                                                                                                                                                                                       |
| CLI (live path via HTTP)   | goal/project mutations                                                                                                                                                                                                                    | Rare, human-scale                                                                                                                                                                                         |

**Writes outside the command worker (single statements on the shared permit):**

| Source                                    | Statement                                               | Frequency                                                                                 |
| ----------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Usage ledger (`ProviderRuntimeIngestion`) | one `INSERT OR IGNORE` per `thread.token-usage.updated` | ~1 per assistant message per thread (pi emits usage on message completion, not per delta) |
| Thread heartbeats                         | one upsert per thread                                   | already debounced to ≥3 s per thread                                                      |
| Auth sessions                             | insert/update/delete                                    | per WS connect, per CLI run, per MCP session                                              |
| Provider session runtime                  | resume-cursor upserts                                   | per session lifecycle event _(assumed)_                                                   |

**Reads (all currently queue behind write transactions on the single permit):**

| Source                                                                                          | Shape                                                                                                       |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `ProjectionSnapshotQuery.getSnapshot` / `getShellSnapshot` / `getArchivedShellSnapshot`         | dozens of SELECTs assembling the full read model — WS connect, CLI probe, MCP `workstream_list`, goal tools |
| `OrchestrationEventStore.readFromSequence`                                                      | paged event replay (500/page) — WS reconnect catch-up                                                       |
| Thread detail / checkpoint / diff-context / activity queries                                    | per-view reads from web UI and MCP tools                                                                    |
| Auth-session `getById`                                                                          | one indexed read per authenticated HTTP request                                                             |
| Command worker's own reads (receipt `getByCommandId`, idle-gate `getPendingTurnStartThreadIds`) | small, serial with the writes                                                                               |

**Key inference:** the audit's "coalesce high-frequency token-usage writes" concern is largely already handled — deltas are buffered, heartbeats debounced, ledger inserts are per-message. The dominant contributors to permit-hold time are (a) cross-process lock waits (up to 5 s each), (b) big snapshot/replay reads serialised behind write transactions, and (c) per-commit fsync (`synchronous = FULL` under WAL). Those are the three things this plan removes.

---

## 2. Hard constraints

- **Upstream-divergence budget.** This repo is a fork of `pingdotgg/t3code` syncing frequently (merge-base ~2 days old). Verified file status as of merge-base `600972084`:

  | File                                                                                                          | Status        | Current divergence                                         |
  | ------------------------------------------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------- |
  | `persistence/NodeSqliteWorkerClient.ts`, `SqliteWorker.ts`, `NodeSqliteConnection.ts`                         | **fork-only** | free to reshape                                            |
  | `cli/orchestrationMutation.ts`, `cli/goal.ts`                                                                 | **fork-only** | free to reshape                                            |
  | `mcp/*` (pi-child HTTP tools), `persistence/Layers/ProjectionUsageLedger.ts`, `ProjectionThreadHeartbeats.ts` | **fork-only** | —                                                          |
  | `persistence/Layers/Sqlite.ts`                                                                                | shared        | +18/−2                                                     |
  | `orchestration/Services/OrchestrationEngine.ts`                                                               | shared        | +18/−0                                                     |
  | `orchestration/Layers/OrchestrationEngine.ts`                                                                 | shared        | +52/−2                                                     |
  | `orchestration/runtimeLayer.ts`, `cli/project.ts`, `auth/EnvironmentAuth.ts`, `auth/SessionStore.ts`          | shared        | **zero diff** — every line added here is new merge surface |
  | `orchestration/Layers/ProjectionSnapshotQuery.ts`                                                             | shared        | +1150/−216 (already a merge hotspot)                       |
  | `orchestration/Layers/ProviderRuntimeIngestion.ts`                                                            | shared        | +376/−11                                                   |
  | `server.ts`                                                                                                   | shared        | +52/−9                                                     |

  Design consequence: put all new machinery in **fork-only files**; touch shared files only with small, mechanical, cleanly-separable hunks.

- **Effect 4 beta idioms** (`.repos/effect-smol/LLMS.md`): services via `Context.Service`/`Context.Tag`, layers composed with `Layer.provide`, `Effect.fn` for named functions, resources scoped via `Scope`.

- **Prototype rules:** no backward-compatibility shims, no dual-shape coexistence. Migrations are clean cuts.

- **Event-sourcing semantics must hold:** per-stream event ordering, exactly-once command receipts, projection consistency. Nothing in this plan touches the serialised decide→append→project→receipt transaction; the changes are about what _else_ shares its lane.

---

## 3. Design

Three structural moves plus one pragma. In dependency order:

### D1 — Writer-lane hygiene: `synchronous = NORMAL` (one line, big effect)

Under WAL, SQLite's default `synchronous = FULL` fsyncs the WAL on **every commit**. Every orchestration command therefore pays a disk flush on a host whose I/O is already contended by ~8 pi processes and git subprocesses. `synchronous = NORMAL` is the documented recommended pairing with WAL: commits become fsync-free (the WAL is synced at checkpoint boundaries), with the durability trade-off that an OS crash/power loss can lose the most recent commits — **never** corrupting the database. For a local orchestration DB whose worst-case loss is the last moments of thread bookkeeping, this trade is clearly right.

- Change: add `PRAGMA synchronous = NORMAL;` to the `setup` layer in `persistence/Layers/Sqlite.ts`.
- Upstream cost: +1 line in a shared file, inside the fork's existing `setup` hunk (which already carries `busy_timeout`). Genuinely upstreamable — this is a general improvement, not fork-specific.

### D2 — Reader lane: a second connection for reads (WAL's whole point)

WAL exists so readers never block on the writer and vice versa. Today we forfeit that by funnelling every read through the same connection/permit as writes.

**Topology.**

- **Writer (unchanged):** the existing `NodeSqliteWorkerClient` — one worker thread, one connection, one semaphore, `transactionAcquirer` holding the permit for the transaction's duration. Remains the default `SqlClient.SqlClient`. Migrations, pragmas, the command worker's transactions, and all mutating repositories stay here.
- **Reader (new):** a second sqlite worker (same fork-only worker code, new config flag) opening the **same file** with its own connection and prepared-statement cache, configured read-only. Exposed as a distinct service tag in a new fork-only file:

  ```ts
  // apps/server/src/persistence/Layers/SqliteRead.ts (fork-only, sketch)
  export class SqlReadClient extends Context.Tag<SqlReadClient, SqlClient.SqlClient>()(
    "t3/persistence/SqlReadClient",
  ) {}
  export const layer = (config) => Layer.effect(SqlReadClient, makeReadClient(config));
  ```

- **Read-only enforcement:** open the reader read-write but execute `PRAGMA query_only = ON;` in the worker on startup. (`readOnly: true` on `DatabaseSync` also works, but a read-only connection cannot create the WAL `-shm`/`-wal` sidecars, creating a boot-order dependency on the writer; `query_only` avoids the race entirely while guaranteeing no accidental writes — any write attempt fails with `SQLITE_READONLY`.) The reader also sets a small `busy_timeout` (writes never originate here, but WAL checkpoint edges can briefly lock).
- **~~No transactions on the reader~~ Read-only transactions on the reader.** _Superseded during implementation (plan-author consult, round 1 of the Stage 2 review):_ the original wording claimed multi-statement snapshot assembly tolerated commits landing between statements, but the snapshot methods that return assembled state plus a `snapshotSequence` do rely on a consistent multi-statement view — tearing there would pair state from one commit with a sequence number from another. As built, the reader client keeps the same semaphore/transaction-acquirer discipline as the writer, and `PRAGMA query_only = ON` guarantees those transactions are read-only WAL snapshots that can never become writer-lane work. Statement-level reads outside transactions behave as originally described.
- **No semaphore on the reader.** Plain statements on a single worker with `concurrency: 1` are already serialised FIFO by the RPC protocol; there is no transaction state to protect. If read throughput ever warrants it, `RpcClient.makeProtocolWorker` already supports pool sizing — that is a config change later, not a design change now.

**Routing — by layer provision, not by code edits.** Consumers yield `SqlClient.SqlClient` from context; we route chosen read-only consumers to the reader by wrapping their layers at the composition root, e.g.:

```ts
const readerAsSqlClient = Layer.effect(SqlClient.SqlClient, SqlReadClient.asEffect());
const SnapshotQueryOnReader = OrchestrationProjectionSnapshotQueryLive.pipe(
  Layer.provide(readerAsSqlClient),
);
```

Routed to the reader (all verified to be pure-read services):

1. **`ProjectionSnapshotQuery`** — the big one: full/shell snapshot assembly, thread details, checkpoint/diff context. Serves WS connects, MCP tools, HTTP snapshot. Also serves the command worker's small pre-transaction reads (idle gate, boot-time read model) — see the invariant below.
2. **Event replay** — `OrchestrationEngine.readEvents` (WS reconnect catch-up). The event store serves both the transactional `append` (writer) and paged replay reads; rather than adding dual-client awareness to the shared store layer, the engine keeps its writer-backed store and the composition root builds a **second, reader-backed store instance** provided only to the WS replay path.
3. **Usage-dashboard queries** (fork-only) — reader.

Stays on the writer: everything mutating (all projection repositories as used by the pipeline, receipts, event append, auth sessions — `EnvironmentAuth` mixes reads and writes in one service and its per-request `getById` is a µs-scale indexed read; not worth splitting a zero-diff shared file for).

**Correctness invariants** (stated so review can check them):

- _Reader-routed services must never run inside a writer transaction._ True today: the projection pipeline (which runs inside `processEnvelope`'s transaction) uses the repository services, not `ProjectionSnapshotQuery`; the snapshot query's uses inside the command worker (idle gate, boot) run **outside** the transaction.
- _Read-your-writes across the lanes._ The command worker is serial: command N's reads begin only after command N−1's transaction committed, and a new WAL read snapshot sees every committed transaction. Client-facing flows (dispatch acknowledged → snapshot fetched) likewise read after commit. No flow reads its own uncommitted state across lanes.
- _Per-connection pragmas are per-connection._ The reader worker applies its own `query_only`/`busy_timeout`; `journal_mode = WAL` is a property of the file and needs no re-application.

**Upstream cost:** new fork-only files (`SqliteRead.ts` layer + a `queryOnly` flag in the fork-only worker config/entry) plus a handful of mechanical lines at the composition root. The composition roots are `orchestration/runtimeLayer.ts` (shared, currently zero-diff) and `server.ts` (shared, +52/−9): prefer concentrating the wiring in a **fork-only composition module** (e.g. `persistence/Layers/SqliteLanes.ts` exporting the wrapped layers) so the shared files gain only 1–3 import/use lines each.

### D3 — Zero cross-process file access: route the CLI through the server properly

The candidate transports in the brief (WS/RPC, unix socket, local HTTP) resolve trivially: **the CLI already uses the server's HTTP API for the live path**. Nothing new to invent — the work is closing the two holes that keep the CLI opening the DB file anyway.

**D3.1 — Pre-provisioned CLI token (kills the live path's DB access).**

Today the CLI mints itself an admin session by _writing the sessions table directly_ — that is the trust model made concrete: filesystem access to the state dir ≡ admin. Keep the trust model, move the minting to the server:

- At startup (and on a rotation schedule if desired), the server issues a long-lived administrative session labelled `t3 cli (local)` **in-process** and writes the bearer token to a `0600` file in the existing secrets directory (`stateDir/secrets/cli-token`, using the `ServerSecretStore` file conventions already present).
- The CLI live path reads origin from the runtime-state file (as today) and the token from the secrets file — **no DB open, no session insert/revoke, no migrations**. On 401 (stale token after a restart+expiry) it reports "server restarted — token stale" rather than silently degrading.
- Security delta: none. Reading `stateDir/secrets` already yields the session-signing secret, which is strictly more powerful than a bearer token.
- Removed: `withCliSessionToken`'s issue/revoke round-trips and the `EnvironmentAuth.runtimeLayer`(→`SqlitePersistenceLayer`) dependency from the live path. Fork-only `orchestrationMutation.ts` shrinks.

**D3.2 — Fix the live/offline decision (kills the self-amplifying fallback).**

Replace the 1 s snapshot-fetch probe with discrimination the failure mode can't fool:

- **Liveness = the runtime-state PID.** The runtime-state file already records the server's `pid`. `process.kill(pid, 0)` distinguishes "server process exists" from "server dead" without any I/O the server's busyness can delay.
- **Server alive → live mode, always.** Use a generous HTTP timeout (~30 s) for the actual mutation. A busy server means the CLI _waits_; it never falls back to direct file access, and it **never deletes the runtime state**. (Deleting runtime state on a timeout is the poison that blinds every subsequent CLI run; only the server itself should manage that file's lifecycle.)
- **Server dead (stale PID or no state file) → offline mode**, unchanged in capability: boot the in-process engine against the file. This is a real case worth keeping — inspecting or mutating goals/projects with the server down — and with the server dead there is no contention to cause.
- The probe snapshot fetch disappears; the live path fetches the snapshot once, as part of the mutation flow it already has.

**D3.3 — End-state file-access matrix.**

| Process           | Opens DB file?                                                                       |
| ----------------- | ------------------------------------------------------------------------------------ |
| Server            | yes — writer + reader connections (both in-server)                                   |
| Pi children       | no (unchanged — HTTP)                                                                |
| CLI, server alive | **no** for orchestration-mutation paths (`t3 goal`/`t3 project`) (was: yes, always)¹ |
| CLI, server dead  | yes — sole process, no contention                                                    |

¹ Scope annotation (post-review, ratified by plan author): `t3 auth` and `t3 connect` were not analysed in this plan and may still open the DB file while the server runs. They are rare, human-initiated setup commands — not workflow-frequency traffic — so they cannot reproduce the compounding contention behind the >15 s stalls. Extending the token/HTTP treatment to them is a natural follow-on, to be designed only if they are ever observed contending.

With this, `busy_timeout` stops being load-bearing for normal operation (retained as belt-and-braces for the server-dead-CLI → server-starts overlap window), and the 5 s × N amplification path is gone entirely.

**Upstream cost:** fork-only `orchestrationMutation.ts` rewrite (net _deletion_); token provisioning is a small fork-only startup module invoked from `server.ts` (+2–3 shared lines). `EnvironmentAuth`/`SessionStore` (zero-diff shared) are **not touched** — the token is an ordinary DB-backed session, just issued by the server instead of by a second writer process.

### D4 — Write coalescing: mostly already done; one small optional batch

Per the §1.3 inventory, the feared high-frequency write paths are already debounced/buffered, and each remaining write is a sub-millisecond single statement. After D1–D3 remove lock-waits, fsyncs and read head-of-line blocking, the residual writes are noise. Two small items, neither load-bearing:

- **Heartbeat batching (optional):** replace N per-thread debounced upserts with one periodic flush (a single multi-row upsert every ~3 s) in fork-only `ProviderRuntimeIngestion` state + fork-only heartbeat repository. Do only if Stage-4 telemetry still shows writer-lane pressure; otherwise cut.
- **Usage ledger:** leave as-is. One insert per assistant message does not justify batching machinery.

This deliberately **cuts the audit's "coalesce token-usage writes" recommendation to near-zero scope** — the premise (per-delta write frequency) did not survive contact with the code.

### D5 — Command-worker partitioning: **cut** (decided, not deferred by default)

Question 4 asked whether the globally-serial command worker remains a bottleneck once 1–3 land. Answer: **no, at realistic load — partitioning is cut from this plan.**

- **Transaction-duration estimate.** A command transaction is: receipt read + in-memory decide + BEGIN + (per event: 1 append INSERT + a handful of projection statements) + receipt upsert + COMMIT. Statements are single-row, indexed, on a worker thread; each worker round-trip is ~50–300 µs. A typical 10–20-statement transaction is **low single-digit milliseconds** once D1 removes the per-commit fsync and D3 removes 5 s lock waits. At the observed burst rates (a few commands/second across ~8 threads), worker utilisation sits well under 10%; queueing theory gives negligible queue-wait at that utilisation even with 10× bursts.
- **Structural argument.** The decider consumes a **global** in-memory read model (`commandReadModel`), updated transactionally per command. Per-aggregate lanes would require either partitioning that read model (cross-aggregate commands and invariants break) or cross-lane synchronisation on it (re-serialising what we just parallelised). The cost/benefit is upside-down while transactions are milliseconds.
- **Revisit trigger (appendix criteria).** The Wave 1 telemetry splits queue-wait from processing time per command. If after Stages 1–3 land, p95 **queue-wait** exceeds ~250 ms during normal multi-agent operation while per-command **processing** stays in the low milliseconds, reopen partitioning with that evidence (and assess it as an upstream PR then — upstream shares the same serial worker). Until that trigger fires, no work.

---

## 4. Stages

Each stage lands independently, leaves the system fully working, and is verifiable on its own.

| #   | Stage                                       | Contents                                                                                                                                                        | Files touched (upstream cost)                                                                                                     | Verification                                                                                                                                                                                            |
| --- | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Writer-lane pragma**                      | `PRAGMA synchronous = NORMAL`                                                                                                                                   | `Layers/Sqlite.ts` **+1 line** in the existing fork hunk (upstreamable)                                                           | `vp check`/typecheck; telemetry: per-command processing time drops under write bursts                                                                                                                   |
| 2   | **CLI: zero file access when server alive** | D3.1 token pre-provisioning + D3.2 PID-based liveness, no state-clearing on timeout, 30 s mutation timeout; live path loses its Sqlite layer dependency         | fork-only: `orchestrationMutation.ts` (net smaller), new startup module; shared: `server.ts` +2–3 lines                           | `t3 goal`/`t3 project` against a live server never opens the DB (assert via `lsof`/strace in a manual check); busy-server CLI run waits instead of falling offline; server-dead run still works offline |
| 3   | **Reader lane**                             | D2: `SqliteRead` layer + `queryOnly` worker flag; route `ProjectionSnapshotQuery`, WS event replay, usage-dashboard reads via fork-only lane-composition module | fork-only: `SqliteRead.ts`, `SqliteLanes.ts`, worker-config flag; shared: `runtimeLayer.ts`/`server.ts` 1–3 mechanical lines each | dispatch p95 unaffected by concurrent snapshot/replay hammering (load check below); snapshot reads no longer appear in writer-lane slow spans                                                           |
| 4   | **Measure, then trim**                      | Read Wave-1 telemetry under real multi-agent load; decide heartbeat batching (D4) and confirm partitioning stays cut (D5)                                       | none unless triggered                                                                                                             | see §5 acceptance criteria                                                                                                                                                                              |

Stage order rationale: 1 is free and immediate; 2 removes the amplifier (the actual >15 s mechanism) and is independent of 3; 3 removes the head-of-line read blocking that remains after 2. 2 and 3 are parallelisable across coders — they share no files.

## 5. Verification and acceptance criteria

Instrumentation: the Wave 1 slow-request telemetry (queue-wait vs processing split per `dispatchCommand`) plus existing `orchestrationCommandAckDuration`/`orchestrationCommandDuration` metrics.

**Load check (repeatable, no new harness):** with the server under normal multi-agent load (≥6 active pi children), run in parallel for 60 s: (a) a loop dispatching workstream mutations via MCP HTTP, (b) a loop fetching full snapshots + forcing WS reconnect replays, (c) a loop of `t3 goal task add`/`done` CLI invocations.

Acceptance:

1. p95 `dispatchCommand` end-to-end < 500 ms; **zero** dispatches > 5 s during the load check (today: multiple > 15 s under comparable conditions).
2. Zero DB file opens by CLI processes while the server is alive (spot-check `lsof` during (c)).
3. No CLI run deletes the runtime-state file while the server process exists.
4. Per-command **processing** time p95 in low single-digit ms; **queue-wait** p95 < 250 ms (else the D5 revisit trigger fires — that is a finding, not a failure of this plan).
5. `vp check` and `vp run typecheck` pass at every stage boundary.

## 6. Risks

| Risk                                                                                               | Mitigation                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reader sees slightly stale state vs in-memory read model during snapshot assembly                  | No weaker than today: reads already interleave with commits on the shared connection. Statement-level WAL snapshots are the same consistency class.                                                            |
| A future service routed to the reader attempts a write                                             | `query_only = ON` fails fast with `SQLITE_READONLY` at the exact statement — loud, not silent. Reader `transactionAcquirer` dies with a defect.                                                                |
| WAL checkpoint starvation with a long-lived reader                                                 | Readers are statement-scoped (no long read transactions), so checkpoints proceed; default auto-checkpoint retained. If WAL growth is observed, add `PRAGMA wal_autocheckpoint` tuning — writer-side, one line. |
| `synchronous = NORMAL` durability trade                                                            | Acceptable by decision: OS-crash loses at most the last commits, never corrupts. Orchestration state is reconstructible bookkeeping, not a system of record for anything irreplaceable.                        |
| Stale CLI token after server secret rotation / long downtime                                       | CLI fails closed with a clear message; server rewrites the token file on every boot.                                                                                                                           |
| Upstream drifts the files we add mechanical lines to (`runtimeLayer.ts`, `server.ts`, `Sqlite.ts`) | All logic lives in fork-only modules; the shared-file hunks are 1–3 line imports/uses, cheap to re-apply on any sync conflict. Stage 1's pragma is a candidate upstream PR.                                    |
| Fork-only files deleted/reshaped by upstream sqlite work                                           | `NodeSqliteWorkerClient` et al. are already fork-only divergence tracked by the sync process; this plan adds no _new_ class of divergence there.                                                               |

## 7. Appendix: D5 revisit criteria (command-worker partitioning)

Reopen only if **all** hold after Stages 1–3:

- p95 queue-wait > 250 ms (or p99 > 1 s) during normal operation, sustained, per Wave 1 telemetry;
- per-command processing time is simultaneously low (single-digit ms) — i.e. the queue itself, not slow transactions, is the bottleneck;
- the load is organic (real multi-agent operation), not a synthetic hammer.

If reopened: partition by aggregate (`commandToAggregateRef` already computes the key), one lane per aggregate id with per-lane FIFO, receipts unchanged (they are keyed by commandId, not order), and the global read model replaced by per-aggregate read models plus a cross-aggregate invariant protocol — which is the expensive part, and why this stays cut until evidence demands it. Assess as an upstream PR at that point; upstream has the identical serial worker.
