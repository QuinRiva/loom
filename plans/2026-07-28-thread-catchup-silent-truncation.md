---
manager_sessions:
  - id: 435e50df-ea8d-4b83-80a3-42ce437524e4
    role: plan
    authored_at: 2026-07-28T23:29:56.560Z
---

# Cross-client thread staleness: eliminating silent catch-up truncation

**Status:** implemented — all four steps landed on `t3code/thread-catchup-truncation-fix` (see §10 for the as-built record)
**Date:** 2026-07-28
**Scope:** `apps/server/src/persistence/` (event store + reader lane), `apps/server/src/ws.ts` (subscribeThread), `apps/web/src/connection/storage.ts` (thread-cache schema), tests. No wire-contract changes.

> **Revision note.** Round 1 confirmed the primary diagnosis but rejected three design
> choices and found one additional bug. Material changes: the required-`limit`
> contract (former §3.1a) is **withdrawn** in favour of opaque delegation; a
> **thread-cache schema bump** is added for rollout recovery; the completion marker
> is now a **re-home of upstream's same-queue implementation** rather than a fresh
> design; the false "exact equivalence" claim is corrected; and a newly found
> **connect-gap on the thread path** is folded in. Superseded reasoning is marked
> where it was load-bearing, so the revision history stays legible.

## 1. Problem

Work done on one machine is invisible on another until the browser's IndexedDB
cache is deleted and the page hard-refreshed. The thread renders last night's
content, confidently, with no error and no loading state.

### 1.1 The mechanism

A client with a warm thread cache resumes via `subscribeThread({ afterSequence })`
rather than re-downloading the snapshot. The handler at `apps/server/src/ws.ts:1445`
deliberately requests an unbounded read, and its comment states exactly why:

> *"Read the full range after the cursor (not the store's default page-bounded
> limit): the range is normally tiny (a fresh HTTP snapshot sequence) and the
> per-thread filter runs after reading, so a global cap could otherwise omit
> this thread's events."*

```ts
orchestrationEngine.readEvents(afterSequence, Number.MAX_SAFE_INTEGER)
```

The loom fork's reader-lane wrapper at
`apps/server/src/persistence/Layers/SqliteLanes.ts:44-47` **silently discards the
second argument**:

```ts
readEvents: (fromSequenceExclusive) =>
  readerEventStore.readFromSequence(fromSequenceExclusive),   // limit dropped
```

`readFromSequence` then applies its own
`DEFAULT_READ_FROM_SEQUENCE_LIMIT = 1_000`
(`apps/server/src/persistence/Layers/OrchestrationEventStore.ts:71,217`).

This wrapper is what production runs: `apps/server/src/server.ts:311` substitutes
`OrchestrationLayerOnSqlReadClient` for upstream's engine layer.

### 1.2 Why the cap is catastrophic rather than merely conservative

The cap applies to the **global** event stream, but the per-thread filter
(`isThisThreadDetailEvent`, `ws.ts:1381`) runs *after* the read. The client asks
for "every event for this thread after sequence N" and receives "this thread's
events within the next 1,000 events *across all threads*".

Measured against the live cockpit DB (`~/.t3/cockpit/userdata/state.sqlite`,
346,778 events, max sequence 503,941), simulating a cursor cached ~24h earlier
for the thread in the bug report (`561ff3fa-…`):

| Quantity | Value |
|---|---|
| Thread events genuinely after the cursor | **148** |
| Thread events within the 1,000-global-event window | **0** |
| Delivered to the client | **0** |

Across all threads with activity in the preceding two days, **83 of 100 would go
stale identically**. On a busy machine 1,000 global events elapse in minutes, so
the window almost never contains the events being resumed for.

### 1.3 Why it is silent, and why it persists

The truncated stream **succeeds**. There is no error, so the client's self-heal
never fires.

Two distinct persistence modes follow, and round 1 corrected the original
plan's account of them. The mechanism is *not* "a truncated prefix advances the
cursor past its own omissions" — a truncated read returns an ordered prefix, so
it cannot by itself skip past events it did not deliver:

- **Stuck (the reported case).** Zero of the thread's events fall in the window,
  so nothing is delivered, the cursor never moves, and every reconnect repeats
  the identical empty window. Permanently stale until the cache is cleared.
- **Poisoned (the harder case).** The catch-up leg is followed by the buffered
  **live** leg (`ws.ts:1445-1463`). A later live event for the thread carries a
  sequence beyond the omitted history; the client accepts it and advances
  `lastSequence` (`threads.ts:235-239`), then persists it (`threads.ts:151-157`).
  The omitted middle is now unreachable by *any* future resume.

The poisoned mode is why a server-side fix alone is insufficient — see §3.5.
Only a cold cache recovers, which is exactly what the user discovered by
deleting the DB: that drops `afterSequence` and forces a full HTTP snapshot.

### 1.4 The shell path already solved this

`subscribeShell` (`ws.ts:1303-1347`) samples the projection cursor, computes
`gap`, and serves a **fresh snapshot** when `gap > SHELL_CATCHUP_MAX_EVENTS (500)`
or when the client is ahead of the server. Its comment names this very scenario:

> *"A large overnight gap — the incident habitat — snapshots."*

That hardening (`e96c98662`, plan `plans/2026-07-19-shell-catchup-silent-drop.md`)
was applied to the shell path only. The thread path never received it. This is
precisely why the symptom presents as *"the sidebar looks right but the thread
content is stale"*.

### 1.5 A second, latent instance of the same defect

The dropped-limit wrapper corrupts **every** `readEvents` caller, not just the
thread path:

- `ws.ts:1234` (`replayEvents` RPC) — explicitly clamps to
  `Number.MAX_SAFE_INTEGER`, silently capped to 1,000.
- `ws.ts:1335` (shell catch-up) — passes `limit = gap`, where `gap ≤ 500`, so it
  is *accidentally* correct today. It is one constant change away from breaking:
  raising `SHELL_CATCHUP_MAX_EVENTS` above 1,000 would silently re-break the shell
  path with no failing test.

Separately, `ProjectionPipeline.bootstrapProjector`
(`ProjectionPipeline.ts:2334`) calls `readFromSequence(lastAppliedSequence)` with
no limit, taking the same 1,000-event default. A projector more than 1,000 events
behind at startup silently stops short and records the truncated cursor. This is
latent (`bootstrap` normally has little to catch up on) but is the same class of
bug in a place where the consequence is a corrupt projection.

### 1.5a A third defect: the thread path has its own connect-gap

Found in round 1, independent of the truncation and independently capable of
losing content.

The shell path uses the fork-added eager primitive
`yield* orchestrationEngine.subscribeDomainEvents` (`ws.ts:1269`), which
**establishes the PubSub subscription as an invariant before** any cursor or
snapshot read. Its comment explains that a lazy attach leaves "a silent gap for
events committed between the snapshot query and the first pull".

The thread path still uses the lazy `orchestrationEngine.streamDomainEvents`
(`ws.ts:1386`) forked into a queue. Forking a lazy `Stream` does not guarantee
the subscription is live before the snapshot/catch-up read proceeds, so the
thread path retains precisely the connect-gap the shell path was hardened
against. The surrounding comments claim gap-freedom that the primitive does not
actually provide.

### 1.6 Contributing factor: a completion marker that never arrives

The server advertises `threadResumeCompletionMarker: true` and
`shellResumeCompletionMarker: true` (`ws.ts:904-905`), and the thread client
trusts it: on seeing the flag it sets `awaitingCompletion = true` and holds status
at `synchronizing` until a `kind: "synchronized"` item arrives (`threads.ts:281`,
`threads.ts:193`).

**No server code path ever emits `kind: "synchronized"`.** The only occurrence in
the repository is a test fixture
(`packages/client-runtime/src/state/threads-sync.test.ts:299`).

**Provenance (established in round 1).** This is a lost fork re-home, not a
feature that was never built. Upstream `8e3467fe6` implemented the marker for
*both* thread and shell paths, and it is an ancestor of HEAD. The fork's
upstream-rehome commit `777bd20f8` ("merge: upstream v0.0.28 (skeleton — fork
features pending re-home)") dropped the server-side emission while retaining the
advertised flags and the entire client-side machinery. Verified: `git show
777bd20f8:apps/server/src/ws.ts` contains zero occurrences.

Crucially, upstream's implementation offers the marker **into the same
`liveBuffer` queue** as the live events, so FIFO ordering guarantees anything
buffered during the snapshot/replay is emitted *before* the marker. That ordering
property is the whole point, and it is why §3.4 must be a re-home rather than a
fresh design (a naive `Stream.concat` of the marker before `bufferedLiveStream`
would let the marker overtake already-buffered events).

Consequences:

- A resuming thread never reaches `live` via the marker. It only leaves
  `synchronizing` when an unrelated live event arrives, or via the connection
  phase transitions.
- `useThreadDetail` maps `synchronizing → isPending` (`apps/web/src/state/queries.ts:62`),
  so the pending flag is unreliable.
- Critically for this bug: the one signal that could have distinguished
  "caught up" from "returned nothing" is absent.

The shell client sidesteps this by never requesting the marker and explicitly
skipping the variant (`shell.ts:140-145`), so the server flag is a false promise
on both paths.

### 1.7 Root-cause summary

| # | Defect | Severity |
|---|---|---|
| A | Reader lane drops the `limit` argument | **Cause of the reported bug** |
| B | Thread catch-up has no gap cap / snapshot fallback | Cause of unboundedness once A is fixed |
| C | Thread catch-up scans the global stream to find one thread's events | Design flaw enabling A and B |
| D | `synchronized` marker advertised but never emitted (lost re-home) | Removes the detection signal |
| E | Projector bootstrap silently truncates at 1,000 | Latent, same class |
| F | Thread path uses a lazy live attach, retaining a connect-gap | Independent content loss (found in round 1) |
| G | Already-poisoned client caches cannot self-heal | Blocks rollout recovery (found in round 1) |

A, B, C, E and F are server-side. G is client-side and is the reason a
server-only fix would leave a subset of users still broken after the release.

## 2. Design principles

The quick fix is one line in `SqliteLanes.ts`. That is rejected as the *solution*
because it leaves C, D, E, F and G intact, and leaves the thread path reading an
unbounded global range on every resume. The design below targets the class of
defect, guided by:

1. **Make the correct thing structural, not vigilant.** Code that is correct only
   while every wrapper remembers to forward an argument will break at the next
   wrapper. Prefer a shape where forgetting is impossible — pursued here by
   removing the hand-copied signature, not by hardening an upstream contract
   (see §3.1, where the first draft's stricter-type approach was withdrawn).
2. **Never let truncation be silent.** A succeeding stream must mean "complete".
3. **Read what you need.** A per-thread resume should read that thread's events,
   not filter them out of the global stream.
4. **Bound the work, and be honest when the bound is hit.** Match the shell
   path's proven snapshot-fallback shape.
5. **Spend divergence budget carefully.** `SqliteLanes.ts` is fork-only (absent
   from `upstream/main`) and `ws.ts` is heavily forked. This bug was *caused* by a
   fork-local wrapper drifting from an upstream contract, so prefer changes that
   *reduce* divergence — restoring lost upstream behaviour and its tests — over
   changes that add more.
6. **Fix the user's problem, not just the server's.** A server-side repair that
   leaves already-damaged client caches stale has not delivered the outcome asked
   for (§3.5).

## 3. Proposed solution

### 3.1 Change 1 — stop the wrapper from dropping arguments (defects A, E)

> **Revised.** The first draft proposed making `limit` a *required* parameter so
> the omission became a compile error. Both reviews rejected this, and the
> design review's reasoning is decisive, so it is withdrawn. Recorded here
> because it was the plan's headline claim.
>
> The fatal objection: making the *store* parameter required does not yield the
> advertised four-call-site change, because the **engine** deliberately exposes
> its own optional limit (`Services/OrchestrationEngine.ts:36-39`) and forwards
> it (`Layers/OrchestrationEngine.ts:441-442`). A required store parameter makes
> that forwarding pass `number | undefined` into a required slot, so the engine
> signature must change too — propagating into many production and test-harness
> callers, and creating permanent divergence from an **upstream-owned** contract.
> The fork-local defect is the hand-written decorator, not upstream's optional
> default; hardening upstream's API to compensate for a fork wrapper is the wrong
> place to spend divergence budget — especially in a fork whose sync burden
> caused this bug in the first place.

**Adopted: opaque delegation.** The wrapper's only purpose is to re-route reads
to the reader connection. It should therefore forward **opaquely**, so it cannot
drop this argument — or any argument added later:

```ts
readEvents: readerEventStore.readFromSequence,
```

This is smaller than the current code, carries zero upstream divergence, and
generalises: the failure mode was a hand-copied signature drifting from the
interface it wraps, and opaque delegation removes the hand-copying entirely.
Apply the same treatment to any sibling method in the lane wrapper that
re-declares a signature rather than forwarding it.

Separately, fix the callers that genuinely need completeness by stating their
bound explicitly rather than inheriting the 1,000 default:

| Caller | Bound | Why |
|---|---|---|
| `ProjectionPipeline.bootstrapProjector` (`:2334`) | `Number.MAX_SAFE_INTEGER` | Fixes defect E — a projector >1,000 events behind currently truncates and records a false cursor |
| `OrchestrationEngine` dispatch reconcile (`:149`) | `Number.MAX_SAFE_INTEGER` | Must observe every persisted event |
| `ws.ts` `replayEvents` (`:1234`) | `Number.MAX_SAFE_INTEGER` | Matches its existing clamp, which is currently a lie |
| `ws.ts` shell catch-up (`:1335`) | `gap` (unchanged) | Already correct; now actually honoured |

The stricter contract still has a home — just a fork-owned one: the **new
per-stream method in §3.2 takes a required limit**, since it is ours to define
and has no upstream counterpart to diverge from.

### 3.2 Change 2 — read the thread's own stream (defect C)

This is the structural fix, and it removes the global-scan/filter shape that made
defect A so damaging.

`orchestration_events` already carries `stream_id` and, critically, already has
the exact index required:

```
idx_orch_events_stream_sequence ON orchestration_events(aggregate_kind, stream_id, sequence)
```

Add a per-stream read to the event store, with a **required** limit (fork-owned
API, so the stricter contract costs no upstream divergence):

```ts
readonly readStreamFromSequence: (input: {
  readonly aggregateKind: string;
  readonly streamId: string;
  readonly sequenceExclusive: number;
  readonly limit: number;          // required
}) => Stream.Stream<OrchestrationEvent, OrchestrationEventStoreError>;
```

`subscribeThread`'s catch-up then reads only the thread's own events.

**Equivalence — corrected.** The first draft claimed the per-stream read was
"exactly equivalent" to today's global-read-then-filter. That was **wrong**, and
both reviews caught it. The verified fact is only the *forward* direction: every
event type in `isThreadDetailEvent` (`ws.ts:274-302`) lives on the thread's own
stream (`aggregate_kind='thread'`, `stream_id = threadId`). The converse is
false — a thread stream also carries many **non-detail** types. Measured on the
live DB: `thread.turn-start-requested` (4,598), `thread.plan-lane-set` (2,640),
`thread.meta-updated` (2,140), `thread.report-set` (1,409), `thread.created`
(1,327), `thread.outcome-recorded` (1,304), and more.

Two consequences the implementation must respect:

1. **`isThreadDetailEvent` must be retained** as a filter on the per-stream read
   (or expressed as an explicit `event_type IN (...)` predicate). Dropping it
   would start emitting events the client reducer treats as `unchanged` but
   which still advance `lastSequence` — harmless for correctness, wasteful on the
   wire, and a needless behaviour change.
2. **The cap's unit must be stated precisely.** It counts **detail** events — the
   things actually sent — not all rows on the stream. Otherwise a thread with
   heavy lifecycle churn could trip the snapshot fallback despite few real
   updates.

So the correct claim is narrower than the draft's: the per-stream read plus the
retained predicate produces **the same filtered output** as today, while reading
vastly less. That is what §4.4 pins.

**Verified cost.** `EXPLAIN QUERY PLAN` reports
`SEARCH ... USING COVERING INDEX idx_orch_events_stream_sequence`, and the
worst-case query in §1.2 completes in ~15 ms against the 346k-event production
DB. This is strictly cheaper than today's global scan.

This changes the meaning of the limit from "global events scanned" to "this
thread's events returned", which is the quantity the caller actually cares
about — and makes the cap in §3.3 meaningful rather than arbitrary.

### 3.3 Change 3 — cap the thread catch-up with a snapshot fallback (defect B)

Mirror the shell path's proven shape (`ws.ts:1303-1347`), which already has test
coverage to copy (`server.test.ts:6034`, `:6074`).

**Prerequisite — fix the connect-gap first (defect F).** Before any of the
following is sound, the thread path must switch its durable leg from the lazy
`orchestrationEngine.streamDomainEvents` (`ws.ts:1386`) to the eager
`yield* orchestrationEngine.subscribeDomainEvents`, as the shell path already
does (`ws.ts:1269`). The gap-free-seam argument below **depends** on the
subscription being established as an invariant before the cursor is sampled; with
a lazy attach the argument does not hold, and the reasoning in the surrounding
comments is currently unearned.

In `subscribeThread`, when `afterSequence` is supplied:

1. Sample the projection cursor via `projectionSnapshotQuery.getSnapshotSequence()`
   **after** the eager live attach, so the catch-up/live seam stays gap-free (the
   same ordering argument the shell path documents — now actually valid, given the
   prerequisite above).
2. If `afterSequence > snapshotSequence` — the client is ahead of the server
   (restored DB backup, projection reset) — serve a fresh snapshot. This is a
   real failure mode for this user: the DB has `.pre-loom` and `.pre-lanesplit`
   backups, and a restore currently leaves the client confidently stale.
3. Read the thread's own events with an explicit cap, `THREAD_CATCHUP_MAX_EVENTS`.
4. If the count reaches the cap, **discard the replay and serve a fresh
   snapshot** instead of emitting a truncated prefix. Truncation must never be
   presented as a complete resume.

Detecting (4) requires knowing whether the cap was hit. Cleanest approach: read
`cap + 1` events; if `cap + 1` come back, fall back to the snapshot. This keeps
the store contract simple and needs no truncation flag on the stream.

Proposed `THREAD_CATCHUP_MAX_EVENTS = 500`, matching `SHELL_CATCHUP_MAX_EVENTS`.
Note this counts *this thread's detail* events, so it is far more generous in
practice than the shell's global 500 — the observed incident in §1.2 needed 148
(an observed figure, not a proven worst case). Threads exceeding it are precisely
the long-running ones where a snapshot is cheaper than an event tail.

Precise semantics, so the boundary is unambiguous: **replay up to and including
500 detail events; serve a snapshot only when a 501st exists.**

The client already applies a mid-stream snapshot as a wholesale replace
(`threads.ts:196-203`), so no client change is required for the fallback.

### 3.4 Change 4 — re-home the completion marker from upstream (defect D)

The server must stop advertising a capability it does not implement. **Adopted:
emit the marker** — but as a *re-home of upstream's existing implementation*,
not as a fresh design. Two corrections to the first draft, both from review:

**It is a restoration, not a feature.** Upstream `8e3467fe6` already implemented
this for both thread and shell paths and is an ancestor of HEAD; the fork's
rehome commit `777bd20f8` dropped the server emission while keeping the
advertised flags and all client machinery (§1.6). The task is to re-home that
behaviour onto loom's modified streams and **retain upstream's server tests**,
which is materially stronger prevention than a fresh implementation.

**The ordering matters, and the draft got it wrong.** The first draft said "emit
after the catch-up leg and before the live leg", which a naive `Stream.concat`
would implement — and which is **incorrect**: the marker would overtake events
already sitting in `liveBuffer` from the snapshot/replay window, so the client
would be told "synchronised" before those events were applied. Upstream avoids
this by offering the marker **into the same `liveBuffer` queue**, letting FIFO
ordering place it strictly after everything buffered during catch-up:

```ts
// upstream 8e3467fe6 — marker rides the SAME queue as the live events
const afterCatchUp =
  input.requestCompletionMarker === true
    ? Stream.concat(
        Stream.fromEffect(
          Queue.offer(liveBuffer, { kind: "synchronized" as const }),
        ).pipe(Stream.drain),
        bufferedLiveStream,
      )
    : bufferedLiveStream;
return Stream.concat(catchUpStream, afterCatchUp);
```

Apply to **both** the thread and shell paths, since both flags are advertised.
Gate on `requestCompletionMarker` so clients that never ask are unaffected.

**One claim withdrawn.** The first draft justified the marker partly as
truncation detection. It is not: a marker only says the server crossed its own
catch-up/live boundary, and a silently-truncating server would emit it just as
happily. The marker's value is contract honesty and a working `isPending`
(`queries.ts:62`) — real, but not a safety net. Truncation is prevented by §3.1–3.3.

### 3.5 Change 5 — recover already-poisoned thread caches (defect G)

> **Added in review.** The first draft explicitly asserted that existing caches
> are "correct, merely stale" and would self-heal, and put cache changes out of
> scope. Per §1.3 that is true of the *stuck* mode but **false of the poisoned
> mode**: once a live event has advanced and persisted `lastSequence` past
> omitted history, no server-side fix can recover those events, because the
> client will never ask for them again.

Without this, a subset of affected clients stays stale after the fix ships — and
the user would have to clear IndexedDB by hand a second time, which is precisely
the outcome they asked us to eliminate.

**Adopted: bump the stored *thread snapshot* schema version only** — the literal
`2` in `StoredThreadSnapshot` (`apps/web/src/connection/storage.ts:52-61`) becomes
`3`. Old entries then fail to decode, which the existing code already treats as a
cold cache (`threads.ts:61-71` logs and falls back), so every affected client
takes one full HTTP snapshot on next open and is correct thereafter.

Deliberately **not** bumping `DATABASE_VERSION` (currently `4`): that would
needlessly discard the shell, server-config and VCS-refs caches too. The
thread-entry version is the precise blast radius. This mechanism already exists
for exactly this purpose — the v1→v2 comment in `storage.ts:50-53` documents the
same trick — so this is using the designed path, not inventing one.

Ship this in the **same release** as §3.1–3.3; a server fix without it is
incomplete for the poisoned cohort.

### 3.6 Explicitly out of scope

- Bumping `DATABASE_VERSION` / discarding non-thread caches (see §3.5 for why the
  narrower thread-entry bump is correct).
- Any wire-contract change. All schema pieces used here already exist.
- The shell path's catch-up logic, which is already correct (its marker emission
  is in scope per §3.4).
- Client-side reducer changes.
- A generic "subscription framework" unifying the shell and thread handlers. Both
  reviews independently warned against this: the paths differ materially (the
  shell maps a global stream through fallible projection lookups; the thread
  filters one aggregate and merges an ephemeral reasoning bus). §6 unifies the
  load-bearing *invariants* instead, which is where the recurrence risk lives.

## 4. Validation

Layered so each defect has a test that fails before the change and passes after.

### 4.1 Regression test for the dropped limit (defect A)

In `apps/server/src/persistence/Layers/SqliteLanes.test.ts` — currently
`engine.readEvents(0)` only, which cannot catch this.

Assert the reader-lane engine honours an explicit limit: append > 1,000 events,
read with `limit = MAX_SAFE_INTEGER`, assert all are returned. **This test fails
against the current code.** It is the durable guard for §3.1, since opaque
delegation is enforced by this test rather than by the type system.

### 4.2 The reported scenario, end-to-end (defects A + C)

The highest-value test, expressed in the user's terms: *a thread updated while
this client was away, with heavy unrelated global traffic in between, must be
fully caught up on resume.*

> **Ordering corrected — the draft's version was a false positive.** The first
> draft appended thread T's events *before* the 1,000 unrelated ones. Under
> current code those events sit at the front of the window and are delivered, so
> **the test would have passed before the fix** and proved nothing. The unrelated
> traffic must come first, so T's events are pushed beyond the cap. Caught in
> review; worth recording, because a regression test that passes against the
> unfixed code is worse than no test.

In `apps/server/src/server.test.ts`:
1. Create thread T; note its snapshot sequence as the resume cursor.
2. Append > 1,000 events across *other* threads. ← **must precede step 3**
3. Append several detail events to T.
4. `subscribeThread({ threadId: T, afterSequence })`.
5. Assert every event from (3) is received.

Verify it fails against unfixed code (receives zero) before accepting it. This is
the test that would have caught the bug and the one that matters most.

### 4.3 Cap and fallback (defect B)

Mirroring `server.test.ts:6034` and `:6074`:
- Gap over the cap ⇒ exactly one `snapshot` item, replay not attempted.
- Client ahead of server (`afterSequence > snapshotSequence`) ⇒ snapshot.
- Gap within the cap ⇒ replay, with the expected limit passed to the store.

### 4.4 Per-stream filtered equivalence (defect C)

Assert the per-stream read **plus the retained `isThreadDetailEvent` predicate**
returns the same events as today's global-read-then-filter, for a thread with
interleaved unrelated traffic *and* interleaved non-detail events on its own
stream (per the §3.2 correction). Pins the narrower, true equivalence claim.

Lowest business value of the set — first candidate to drop if test volume becomes
a concern.

### 4.5 Connect-gap seam (defect F)

A deferred-gated test: hold the snapshot/cursor read open, publish a thread event
during that window, release, and assert the event is delivered. This is the test
that distinguishes the eager `subscribeDomainEvents` attach from the lazy
`streamDomainEvents` fork, and it fails against the current thread path.

### 4.6 Completion marker ordering (defect D)

The ordering property is the substance here, so test it directly:

- Marker requested ⇒ exactly one `synchronized`, emitted **after** every event
  buffered during the catch-up window — not merely somewhere after the replay leg.
  This is what distinguishes the same-queue re-home from the naive `concat` the
  draft proposed.
- Marker not requested ⇒ none emitted.
- Client-side (`threads-sync.test.ts`, fixture already present): thread reaches
  `live` on the marker.
- Retain upstream `8e3467fe6`'s server tests rather than writing fresh ones, so a
  future rehome that drops the emission fails loudly.

### 4.7 Poisoned-cache cold reload (defect G)

Assert a stored thread entry at the old schema version fails to decode and takes
the cold HTTP-snapshot path, leaving other stores (shell, server-config,
vcs-refs) intact. This is the rollout-recovery guarantee — without it the fix
silently under-delivers for the poisoned cohort.

### 4.8 Projector bootstrap (defect E)

Bootstrap a projector more than 1,000 events behind; assert it applies all of
them and records the true cursor.

### 4.9 Manual verification

The definitive check is the original report: make a change on machine A, open the
thread on machine B **without** clearing IndexedDB, confirm the content appears.
Also confirm against a warm cache deliberately aged past the cap, to exercise the
snapshot fallback rather than the replay path.

### 4.10 Reproducibility of the measurements

Round 1 noted the §1.2 figures were sampled from a live, still-growing DB at
different moments, and that "83 of 100" is not re-derivable from the document as
written. Before implementation, pin the analysis to **one stated cutoff sequence
with the exact SQL inline**, so the numbers can be reproduced. The conclusion is
unaffected — both reviews independently reproduced the core result (zero target
events delivered) — but the evidence should be checkable rather than trusted.

## 5. Risks and mitigations

| Risk | Assessment | Mitigation |
|---|---|---|
| Opaque delegation changes reader-lane routing semantics | Low — the wrapper's only purpose is re-routing reads; delegation preserves it exactly | §4.1 plus the existing lane test |
| Per-stream read changes which events reach the client | Low, now that `isThreadDetailEvent` is explicitly retained (§3.2) | §4.4 pins the filtered equivalence |
| Snapshot fallback fires more often than expected | Low — cap counts this thread's *detail* events; observed incident was 148/500 | Tunable constant; snapshot is correct either way, only cost varies |
| Marker emitted before buffered events are applied | **Was a real risk in the draft**; removed by using upstream's same-queue offer (§3.4) | §4.6 tests ordering, not just presence |
| Thread-cache bump discards more than intended | Low — scoped to the thread store's entry version, not `DATABASE_VERSION` | §4.7 asserts other stores survive |
| Poisoned caches missed if §3.5 ships separately | Moderate — this is the one change with a release-coupling requirement | Ship §3.5 in the same release as §3.1–3.3 |
| Merge conflicts with upstream on `ws.ts` | Moderate — `ws.ts` is heavily forked already | `// loom:` markers; §3.4 *reduces* divergence by restoring upstream behaviour and its tests |
| Zero upstream-contract divergence added | — | Achieved by withdrawing the required-`limit` proposal (§3.1) |

## 6. Preventing recurrence

The deeper defect is not any single bug but that **the shell and thread paths
drifted**: the shell was hardened in July 2026 and the thread path silently kept
the old shape (defects B and F are both "the shell fixed this, the thread didn't").

Both reviews rejected a generic subscription framework as abstraction for its own
sake — the handlers differ materially (§3.6). The durable answer is to make the
five **load-bearing invariants** identical on both paths, so a future fix cannot
land on only one:

1. Reader-lane wrappers delegate opaquely, never re-declare signatures (§3.1).
2. The durable live leg uses the eager `subscribeDomainEvents` attach (§3.3).
3. Cursor ahead of server ⇒ snapshot (§3.3).
4. Bounded replay, never a silent truncated prefix (§3.3).
5. The completion marker rides the same live queue (§3.4).

`// loom:` markers are documentation, not enforcement. The real protection is
retaining **upstream's own tests** where we re-home upstream behaviour (§4.6):
those fail loudly on the next rehome that drops an implementation, which is
exactly how defect D escaped.

## 7. Sequencing

1. **Stop the bleeding.** Opaque lane delegation (§3.1) + explicit bounds for
   projector bootstrap, dispatch reconcile, and `replayEvents`, with tests 4.1 and
   4.8. Independently shippable as an emergency fix. Framed honestly: this
   prevents *new* damage and fixes the stuck cohort; it does **not** by itself
   recover poisoned caches.
2. **Durable thread catch-up.** Eager attach (defect F) + per-stream read (§3.2) +
   501-probe snapshot fallback (§3.3), with tests 4.2–4.5. Ship together — the
   gap-free-seam argument depends on the eager attach.
3. **Rollout recovery.** Thread-cache schema bump (§3.5) with test 4.7. **Same
   release as 1–2.**
4. **Upstream parity.** Re-home the same-queue completion markers for both paths
   (§3.4) with test 4.6. Separate, reviewable commit.

## 8. Resolved questions (round 1)

All four open questions from the first draft were reviewed; both reviewers agreed
on every one, and the plan above adopts their recommendations.

1. **Required `limit` vs opaque delegation** → **opaque delegation**. The required
   parameter cannot be contained to the store: the engine forwards an optional
   limit, so the change propagates into an upstream-owned contract and its test
   doubles. The fork-local decorator was the defect; fix it there. The stricter
   contract goes on the fork-owned per-stream API instead. (§3.1)
2. **`THREAD_CATCHUP_MAX_EVENTS = 500`** → **accept**, with precise semantics:
   replay up to 500 detail events, snapshot only when a 501st exists. Correctness
   does not depend on the value. 148 is the observed incident, not a proven worst
   case. (§3.3)
3. **Emit vs withdraw the marker** → **emit**, by re-homing upstream `8e3467fe6`'s
   same-queue implementation. The contract and client already exist; withdrawing
   is more churn and leaves `isPending` broken. But it is *not* truncation
   detection. (§3.4)
4. **`cap + 1` probe vs an explicit truncation signal** → **`cap + 1`**.
   Truncation policy belongs to this handler, not the store contract; collect at
   most 501 per-thread events. Avoids new generic surface. (§3.3)

## 9. Round-1 review record

Two independent reviews (correctness; design durability). Both confirmed the
primary diagnosis and both judged the draft *not implementation-ready*. Findings
adopted:

| Finding | Disposition |
|---|---|
| Required-`limit` contract is the wrong trade (engine forwards optional; upstream divergence) | **Adopted** — §3.1 rewritten to opaque delegation |
| Poisoned caches cannot self-heal; server-only fix under-delivers | **Adopted** — new §3.5 + test 4.7 |
| Marker must ride the same queue (upstream `8e3467fe6`), not `concat` before live | **Adopted** — §3.4 rewritten as a re-home |
| Thread path retains a connect-gap (lazy `streamDomainEvents`) | **Adopted** — new defect F, §3.3 prerequisite + test 4.5 |
| "Exact equivalence" for the per-stream read is false | **Adopted** — §3.2 corrected; predicate retained; cap unit defined |
| §4.2 regression test ordered backwards — would pass unfixed | **Adopted** — ordering corrected and called out |
| Cache-poisoning narrative mis-stated the mechanism | **Adopted** — §1.3 rewritten as stuck vs poisoned |
| §3.1 promised a discriminated result but showed a plain stream | **Adopted** — contradiction removed; `cap + 1` only |
| Live events don't clear `awaitingCompletion` | **Adopted** — §1.6 corrected |
| Measurements not reproducible from one cutoff | **Adopted** — §4.10 |
| Don't build a generic subscription framework | **Adopted** — §3.6 excludes it; §6 unifies invariants instead |

No findings contested. The two reviews disagreed only on the *mechanism* of cache
staleness (whether a truncated prefix can advance the cursor past its own
omissions); resolved in §1.3 by separating the stuck and poisoned modes — the
correctness reviewer is right that a prefix alone cannot, the design reviewer is
right that the subsequent live leg can, and only the latter needs §3.5.

Review artefacts:
- `/home/Carl/.t3/cockpit/userdata/workstream-reports/9b46773a-ed2e-4f88-816f-e12f493e7354.md`
- `/home/Carl/.t3/cockpit/userdata/workstream-reports/1e190f0a-442a-45e4-96c3-d33484b59eff.md`
- `/home/Carl/.t3/cockpit/worktrees/loom/t3code-d0e78679/recaps/thread-catchup-plan-review/recap.mdx`

## 10. As-built record

All four steps implemented. `vp check` clean (0 errors) and `vp run typecheck`
clean across all 15 packages.

### Deviations from the plan

**§3.4 — the shell marker is withdrawn rather than implemented.** The plan said to
re-home the marker on *both* paths since both flags were advertised. Implementing
it on the shell path proved unsafe: loom's shell leg deliberately maps
`toShellStreamEvent` on the **consuming** stream and never forks into a value-only
buffer, so that a mapper failure keeps its error channel (loom's own silent-drop
fix, `ws.ts:1276-1280`). Upstream's same-queue trick requires exactly the buffer
that invariant forbids. Since **no client requests the shell marker** (verified:
the only `requestCompletionMarker` caller is `threads.ts:323`), the honest fix is
to stop advertising it — `shellResumeCompletionMarker: false` — rather than
restructure a load-bearing invariant for no consumer. The thread marker, which
*does* have a client, is implemented as specified.

**Test-double maintenance.** Adding `readStreamEvents`/`readStreamFromSequence` to
the engine and store shapes required updating 25 `satisfies`-checked test doubles
across five files. Mechanical, and precisely the compile-time enumeration the
withdrawn §3.1a proposal claimed as its benefit — obtained here for a fork-owned
API, at no upstream-divergence cost.

### Every regression test verified against the unfixed code

Each guard was confirmed to **fail before** the corresponding fix, per §4.2's
lesson that a test passing against the bug is worse than no test:

| Test | Verified failure mode without the fix |
|---|---|
| Lane forwards an explicit limit (§4.1) | `expected 1000 to equal 1001` |
| Incident scenario (§4.2) | Hangs — **zero** thread events delivered |
| Thread connect-gap seam (§4.5) | Hangs — event lands on neither leg |
| Marker ordering (§4.6) | `['event:11', 'synchronized', …]` — marker overtakes the buffered event, exactly the hazard §3.4 predicted |
| Poisoned-cache retirement (§4.7) | v2 entry decodes successfully (no retirement) |
| Projector bootstrap (§4.8) | `expected 1000 to equal 1001` |

### Pre-existing failures (not caused by this work)

`src/keybindings.test.ts` and `src/orchestration/projector.test.ts` (a
`notifySendLog` projection field) fail identically on a clean tree with these
changes stashed. Untouched here; worth a separate look.

### Still outstanding

- **§4.9 manual verification** — the definitive check is the user's own: change a
  thread on machine A, open it on machine B *without* clearing IndexedDB.
- **§4.10** — pin the §1.2 measurements to a single stated cutoff with inline SQL.
