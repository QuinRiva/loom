## 4. Upstream prunes the event log, and Loom's workstream timeline reads it

### 4.1 What upstream changed (#29806, `550c5fa34b`)

Before this week (pull 13 DL-1300, pull 14 §6.1), `ProjectionMaintenance.compactEventStore`
walked `orchestration_events` in pages and deleted _superseded_ rows: an older
`thread.archived` under a newer one, read-state events, and the V1 events of an
imported legacy thread. Loom's guard (DL-1300) sat inside that loop: a V1 row
whose `event_type` is one of `LOOM_HISTORY_EVENT_TYPES` (`thread.report-set`,
`thread.outcome-recorded`, `thread.attention-raised`, `thread.attention-cleared`,
`thread.route-taken`, `thread.gate-rework-accepted`, `thread.outcome-set`,
`thread.plan-lane-set`; `apps/server/src/loom/projection/LoomHistoryEvents.ts`)
was kept, because `LoomStore.history` folds those rows into the workstream
timeline and nothing else holds them.

Now (`ProjectionMaintenance.ts` at `3fa57b92a2`, 318 lines, every line of the
old loop gone) the service exposes one method, `pruneEventStore`, with two
passes:

1. **`pruneEvents(throughSequence, head)`** deletes every event with
   `sequence <= throughSequence` whose `prunable` is 1, where (l.126–139):
   `prunable = 0` for `application_event_version = 1`, for `thread.created`,
   for `run.updated` with `status = 'running'`, and for the newest row of each
   `(aggregate_kind, stream_id)` stream; **everything else is 1.** Prompt
   anchors that retained `subagent.updated`/`turn-item.updated` rows reference
   through `promptSequence` are collected first and spared. `throughSequence`
   is the mark the previous pass wrote (`EVENT_LOG_PRUNE_MARK` in
   `orchestration_v2_projection_metadata`), once that mark is a day old
   (`RETAINED_EVENT_HISTORY = Duration.days(1)`), capped at the projection
   head; `EVENT_LOG_PRUNED_THROUGH` is published before the deletes so a
   client whose replay cursor is below it resyncs from a snapshot (`ws.ts`,
   `OrchestrationEventStore.prunedThroughSequence`).
2. **`pruneImportedLegacyHistory(head, receiptRowId)`** deletes, **on every
   pass with no day's delay**, every `application_event_version = 1` event of
   a thread whose `orchestration_v2_legacy_imports.transcript_imported_at IS
   NOT NULL`, and the `legacy` command receipts of those threads.

`DatabaseStorage.ts` calls `pruneEventStore` when the `compacted-at` breadcrumb
beside the database says a pass is due (a minute after boot when the file is
absent or older than `COMPACTION_INTERVAL`, 6 h; the cockpit's is two days
stale, so a minute after boot there too, For deploy) and every 6 h after, at the 10 % duty cycle pull 13 recorded;
`t3 doctor compact` (`DatabaseMaintenance.ts`) calls it directly, and no
longer verifies projections around it (`DatabaseProjectionsInvalidError` is
gone, §6.5). `docs/internals/overview.md` now says: "The event log only keeps
what live readers need: about a day of history for reconnect replay and
command-id retries. … projections cannot be rebuilt from the log."

### 4.2 What Loom loses without a change

`LoomStore.history(threadId)` (`apps/server/src/loom/projection/LoomStore.ts`
l.945) is `SELECT … FROM orchestration_events WHERE aggregate_kind = 'thread'
AND stream_id = ? AND event_type IN (LOOM_HISTORY_EVENT_TYPES) ORDER BY
sequence`, over both event versions. Its readers:

- `loom.threadHistory` (`loom/wsMethods.ts` l.261) → `WorkstreamTimeline.tsx`:
  the workstream panel's Timeline tab (`workstreamPresentation.ts` l.680:
  "the sidecar's milestones, then the `loom.threadHistory` events"): each
  outcome with its report path, each flag raised and cleared, each route and
  gate round, each plan-lane change.
- `/retro` (`loom/handoff/retroDraft.ts` l.285): "attention flags ever raised
  on the thread".
- The weekly Loom evals dashboard (the cockpit's "Loom evals: weekly dashboard"
  scheduled task, `scripts/loom-evals/run.sh`): `dashboard.py` l.133–137 reads
  V2 `thread.outcome-recorded` and `thread.outcome-set` rows with windows back
  to 7 Oct, and `gate_escapes.py` l.89 reads every V2 `thread.outcome-recorded`
  as its first-verdict proxy. Both types are in `LOOM_HISTORY_EVENT_TYPES`, so
  the guard covers them; they are not Loom server code and the typecheck would
  never have named them.

On the cockpit at measurement (8 Nov, 23:00 UTC): 1,448,632 events, of which
40,150 are V1 and 1,408,482 V2; **41,855 are Loom history rows: 33,696 V1 and
8,159 V2**. The 33,696 V1 rows are exactly the V1 events left on the 4,340
imported threads (pull 14's compaction already removed the rest), so pass 2
deletes all of them **on the first pass after the first boot** of the merged
tree (a minute in, on S3's copy and on the cockpit alike).
Pass 1 marks the head on that first pass and, 24 h later, deletes every V2
history row older than the mark: 1,407,133 of the 1,408,482 V2 events are
already older than a day, Loom's 8,159 among them. After that the Timeline
tab of every workstream older than a day shows the sidecar's milestones and
nothing else, `/retro` sees no flags, and the rows cannot be recovered except
from a pre-promotion snapshot.

The sidecar projections (`loom_thread_workstream`, goals, consults, the
usage ledger) are written at commit time and are unaffected; so is thread
search, which indexes projections. `ToolOutputImageReclaim.loom.ts` rewrites
image payloads in `turn-item.updated` events and simply finds fewer rows.
`loom-migrate` (`cli/loomMigrate.loom.ts`) copies rows rather than replaying
them (its header says so), so a pruned tree moves with its projections and
whatever events remain; its `verify` compares per-thread event counts between
source and target, which stay equal.

### 4.3 The fix (pre-ruled, §8.2)

Keep upstream's pruning (it is the point of #29806, and the cockpit's
6.7 GB database is the reason it exists) and carry Loom's guard into both
passes, as two marked clauses:

- **Pass 1, the `prunable` CASE** (`pruneEvents`, l.126): one marked `WHEN`
  before the `ELSE 1`:
  `WHEN event.aggregate_kind = 'thread' AND event.event_type IN ${sql.in(LOOM_HISTORY_EVENT_TYPES)} THEN 0 -- loom: workstream history (LoomStore.history) lives only here`.
- **Pass 2, the `imported` expression** (`pruneImportedLegacyHistory`, l.195):
  `AND event.event_type NOT IN ${sql.in(LOOM_HISTORY_EVENT_TYPES)} -- loom: V1 workstream history survives (DL-1300)`
  inside the `EXISTS` conjunction, so a V1 history row of an imported thread
  is never `imported = 1`. The receipt pass needs no change: receipts are not
  read by `history`.
- `sql.in` takes an array (`effect/sql/Statement.ts`: `in(value: ReadonlyArray<unknown>)`),
  so the clauses pass the exported array `LOOM_HISTORY_EVENT_TYPES` as
  `LoomStore.history` does, never Loom's old `loomHistoryEventTypes` `Set`,
  which is dropped with the deleted loop. The import of `HISTORY_EVENT_TYPES as
  LOOM_HISTORY_EVENT_TYPES` stays (hunk 1 of the file is the import union);
  the `LoomHistoryEvents.ts` doc comment's reference to
  `compactEventStore` becomes `pruneEventStore`.
- **This is S1's work**, not S2a's: it is inside a conflicted file S1 resolves
  anyway, and S3's first cockpit-copy boot runs pass 2 a minute in. Gate 1
  reads the two clauses against the SQL above.
- **Two more Loom tests lose a method:** upstream moved `verify` and `rebuild`
  off `ProjectionMaintenanceV2` into `orchestration-v2/testkit/ProjectionReplay.ts`;
  `loom/projection/loomProjection.test.ts` l.656 ("a full projection rebuild
  replays the log over the Loom tables without drift") and
  `persistence/ToolOutputImageReclaim.loom.test.ts` l.123 call `maintenance.rebuild`
  and are re-pointed at `ProjectionReplay.rebuild` in S2a (the first typecheck
  lists both).
- **Tests (S2a):** `ProjectionMaintenance.loom.test.ts` already proves pass 2
  on the old method name (an imported V1 thread keeps its eight history rows
  and loses the rest); it is re-pointed at `pruneEventStore` and gains a
  second case for pass 1: a V2 `thread.outcome-recorded` and a V2
  `thread.route-taken` older than the mark survive a due pass while a
  neighbouring V2 `node.updated` is deleted (the mark is written by a first
  call, the `TestClock` advanced a day, then a second call). Upstream's own
  `ProjectionMaintenance.test.ts` (385 lines, new) stays verbatim.
- **S3 proves it on the cockpit copy:** `SELECT COUNT(*) … WHERE event_type IN
  (…)` before the boot, after the first pass (expect 41,855 unchanged,
  V1 rows intact), and, if S3 can afford it, after a forced second pass with
  the mark backdated by a day in `orchestration_v2_projection_metadata`
  (expect 41,855 again and a large `deletedEventCount`). The pass's
  duration and the UI's responsiveness during it are recorded for the
  deploy notes (pull 14's pass deleted 164k rows in about an hour; this one
  has 1.3 M to do, at 50 rows a page, with a correlated `MAX(sequence)`
  subquery per row; no estimate stands until S3 measures it). S3 also runs
  `bash scripts/loom-evals/run.sh` against the copy after the forced pass and
  compares the dashboard's outcome counts with a run against the live database.

### 4.4 Doctrine consequences (recorded, not asked)

- **Loom's history should become a projection.** Upstream's doctrine is now
  that the log is a day of replay buffer. The guard keeps Loom's rows alive
  but leaves Loom as the one reader of old events, and every future upstream
  change to the prune SQL is a place the guard can fall out. The right end
  state is a `loom_thread_history` sidecar table written at commit time
  (where `loom_thread_workstream` is written), backfilled once from the
  surviving rows by a fork migration, with every reader moved onto it first
  (`LoomStore.history`; `scripts/loom-evals/dashboard.py` and
  `gate_escapes.py`, which read the same two outcome event types for the
  weekly dashboard) and the guard then deleted. It is a Fable plan, not merge work (§8.3); it must
  land **before** any pull that would drop the guard, and it is cheaper now
  than later because the rows to backfill still exist.
- **No future Loom migration may backfill from old events.** 1052, 1054 and
  1066 read `orchestration_events` to build or repair sidecar rows; that
  pattern worked because the log was complete. From the first due pass on the
  cockpit it is not. A fork migration that needs history reads projections or
  the sidecar, or runs before that pass (the deploy notes say when).
- **Replay cursors:** Loom's client-runtime `shell.ts` and `ws.ts` thread
  stream take upstream's `prunedThroughSequence` checks as shipped (the `ws.ts`
  hunk 1 union keeps Loom's `isLoomDomainEvent` filter in front of upstream's
  `threadStreamEventItem`). A Loom client reconnecting with an old cursor gets
  a snapshot, which is what it got before when the gap was too large.
