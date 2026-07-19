---
manager_sessions:
  - id: b99631c2-2432-4ce0-b23e-d71132f2020b
    role: plan
    authored_at: 2026-07-19T12:00:57.005Z
---

# Eliminating silent shell-event drops in catch-up replay

**Status:** design — revised after review rounds 1–2 (connect-gap-safe snapshot fallback, enforced read limit, deterministic core test, error-preserving live buffering)
**Date:** 2026-07-19
**Scope:** `apps/server/src/ws.ts` (subscribeShell), `packages/client-runtime/src/state/shell.ts`, tests. No wire-contract changes.

## 1. Problem

A client that reconnects with a warm shell cache resumes via
`subscribeShell({ afterSequence })`. The server replays every persisted event
after that sequence through `toShellStreamEvent` (`apps/server/src/ws.ts:601`),
which performs a per-event projection lookup (`getThreadShellById`,
`getGoalShellById`, `getProjectShellById`). **Every lookup branch swallows
failures**:

```ts
Effect.orElseSucceed(() => Option.none())
```

`Option.none()` is indistinguishable from the legitimate "row absent" signal, so
a transient DB failure (the ~830 MB cockpit DB logs `orchestration command
slow` under contention) silently drops that event from the replay. The stream
then *succeeds*, so the round-1 client self-heal (PR #88 — discard cache on
replay **failure**) never fires.

The drop is permanent by construction: the client reducer
(`packages/client-runtime/src/state/shellReducer.ts:16`) skips any event with
`sequence <= snapshotSequence`, and the very next replayed event advances
`snapshotSequence` past the dropped one. The advanced sequence is persisted to
the cache, so every future reconnect resumes from *beyond* the gap. A thread
whose only shell events fell in the gap (e.g. created from another device or
the Slack bridge while this client was offline) stays invisible until the cache
is cleared or the thread is touched again.

**Confirmed instance:** thread `2238e38b-6d72-491d-b85b-caf239a366c2`
("Claude Code work-splitting prompt research"), created 2026-07-19T00:08Z via
the Slack bridge, healthy in `projection_threads`, absent from a reconnecting
Windows client's sidebar. Round-1 fix was live. Nothing errored.

Two aggravating factors, both verified in code:

1. **Unbounded replay window.** The catch-up reads
   `readEvents(afterSequence, Number.MAX_SAFE_INTEGER)`
   (`apps/server/src/ws.ts:1045`). An offline gap of 15k+ events means 15k+
   sequential per-event lookups — `getThreadShellById` alone runs **five**
   queries per event (`ProjectionSnapshotQuery.ts:2872`). This maximises both
   the drop probability under contention and the replay cost (each
   `thread-upserted` carries a *full* `OrchestrationThreadShell`, so N events
   touching the same thread cost N × the shell size — usually more bytes than a
   snapshot that sends each thread once).
2. **The same swallow exists on the live leg.** `liveStream` pipes
   `streamDomainEvents` through the same `toShellStreamEvent`
   (`ws.ts:1020`), so a contention blip during normal operation can also drop a
   live event with identical permanence.

## 2. Root-cause taxonomy: lookup-failed vs row-absent

`Option.none()` carries two meanings today; the fix must separate them.

| Signal | Meaning | Correct handling |
|---|---|---|
| Lookup **succeeds**, returns `Option.none` | Projection row genuinely absent (thread deleted/archived since the event; goal removed) | Keep current behaviour: skip the event (thread branches) or emit `goal-removed` (goal branch). Legitimately silent. |
| Lookup **fails** (`ProjectionRepositoryError`: SQL error, decode error, contention) | We don't know the row's state | Must be **loud**: fail the stream so the client's round-1 self-heal path runs. Never skip. |

The distinction is already present in the Effect type — the projection queries
fail with `ProjectionRepositoryError` and succeed with
`Option<Shell>`. `orElseSucceed` is the only thing collapsing them. Removing it
lets the type system enforce the taxonomy: the error channel *is* lookup-failed;
`Option.none` in the success channel *is* row-absent.

## 3. Decision

Three coordinated, individually small changes. No contract changes — the
existing `OrchestrationShellStreamItem` union (which already includes the
`snapshot` kind) and the existing `OrchestrationGetSnapshotError` cover
everything.

### 3.1 Server: make lookup failures fail the stream (the correctness fix)

In `toShellStreamEvent`, replace each
`Effect.orElseSucceed(() => Option.none())` with a small bounded retry, then
let the error propagate:

```ts
// loom: silent-drop fix — a projection lookup FAILURE must not masquerade as
// row-absent. Retry absorbs transient DB contention; a persistent failure
// fails the stream so the client self-heals via a fresh snapshot.
Effect.retry(Schedule.intersect(Schedule.exponential("25 millis"), Schedule.recurs(2)))
```

- **Catch-up leg** (`ws.ts` afterSequence path): the existing
  `Stream.mapError → OrchestrationGetSnapshotError` already turns the failure
  into the wire error. The client's warm-cache resume sees a failed stream →
  round-1 self-heal → cache discarded → fresh HTTP snapshot. The silent drop
  becomes a loud, self-healing resync.
- **Live leg**: the live stream gains the same error type; map it to
  `OrchestrationGetSnapshotError` on the consuming stream in every flow. The
  error channel must survive end-to-end — §3.2 specifies the buffering shape
  that guarantees this (no fork-into-value-queue). A live-phase persistent
  failure now
  terminates the subscription with an error instead of dropping the event; the
  client recovers per §3.3.
- Retry justification: the observed failure mode is transient contention on a
  busy SQLite DB. Three attempts spanning ~75 ms absorb a lock blip without
  tearing down every connected client's subscription; anything that survives
  three attempts is not a blip and *should* surface. (Single-user cockpit
  server — no thundering-herd concern.)

The goal branch deserves a comment in code: for goals, a *successful* none is
load-bearing (it emits `goal-removed`), which is precisely why a failure must
not be folded into it — folding could otherwise be "upgraded" someday to
fabricate a `goal-removed` for a live goal.

### 3.2 Server: cap the catch-up window (the bounding fix)

In the `subscribeShell` afterSequence path, **first** acquire the live leg
eagerly, **then** sample the projection cursor, then branch:

```
rawLive ← subscribeDomainEvents            (eager PubSub attach; the subscription queue IS the buffer)
snapshotSequence ← projectionSnapshotQuery.getSnapshotSequence()
gap = snapshotSequence - afterSequence
liveLeg = rawLive → toShellStreamEvent → filter Option → mapError(OrchestrationGetSnapshotError)
if (afterSequence > snapshotSequence || gap > SHELL_CATCHUP_MAX_EVENTS)
    → Stream.concat(snapshot item from getShellSnapshot(), liveLeg)
else
    → Stream.concat(replay readEvents(afterSequence, gap) → toShellStreamEvent …, liveLeg)
```

**No intermediate queue.** The stream returned by `subscribeDomainEvents` is
retained *raw* (unmapped) while the cursor/snapshot work runs — the eagerly
attached PubSub subscription buffers events during that window all by itself.
`toShellStreamEvent` is applied lazily, on pull, after the concat's first leg
drains. This matters for §3.1: the mapper is now fallible, and a
fork-into-value-queue shape (today's `Effect.forkScoped(liveStream.pipe(
Stream.runForEach(offer)))`, `ws.ts:1041`) would let a mapper failure kill the
detached producer fibre while the value-only queue just stops — an error
channel amputation that recreates the silent live-event drop §3.1 exists to
kill. Mapping on the consuming stream keeps the failure in the stream's own
error channel, where it terminates the RPC subscription loudly. (If an
implementation ever does need an explicit buffer here, it must carry exits,
not bare items — but the raw-stream shape makes that unnecessary.)

Two ordering rules make this race-free, and both were review findings against
the first draft:

- **Eager live subscription before any cursor/snapshot read.** The ordinary
  no-afterSequence flow builds `Stream.concat(Stream.make(snapshot),
  liveStream)` where `liveStream` is a lazy `Stream.fromPubSub` — it only
  attaches when first pulled, *after* the snapshot element, so an event
  committed between the snapshot query and that first pull is on neither side
  and stays invisible for the connection's lifetime. That is a second silent
  connect-gap, and the capped fallback must not inherit it. The engine already
  exposes `subscribeDomainEvents`
  (`apps/server/src/orchestration/Services/OrchestrationEngine.ts:62`) —
  an effect that attaches the PubSub subscription the moment it runs —
  precisely to close this gap (added by `38289a138`, mirroring the
  thread-detail reasoning-bus pre-subscribe). Both the capped fallback **and
  the existing ordinary snapshot flow** switch to: acquire the raw
  `subscribeDomainEvents` stream first, then read, then concatenate
  snapshot/replay + the mapped live leg (shape above). Overlap is deduped by
  sequence on the client, as today. The existing afterSequence path's
  `Effect.forkScoped(liveStream.pipe(Stream.runForEach(offer)))` has the same
  lazy-attach hazard in miniature (the forked fibre subscribes asynchronously)
  *and* the error-amputation hazard once the mapper is fallible; it moves to
  the same raw-stream shape.
- **The replay reads exactly the sampled interval.** The first draft kept
  `readEvents(afterSequence, Number.MAX_SAFE_INTEGER)`, which makes the cap
  advisory: events committed between the cursor sample and the read extend the
  query beyond 500. Pass `gap` as the read limit — the replay covers precisely
  `(afterSequence, snapshotSequence]` and everything later arrives via the
  already-attached live subscription. Sampling the cursor *after* the live
  attach makes the seam gap-free: an event publishes to the PubSub only after
  its projection update commits (same transaction, `OrchestrationEngine.ts`
  `processEnvelope`), so any event missing from the subscription (committed
  before attach) is ≤ the cursor sampled after attach and therefore inside
  the read interval.

- **`SHELL_CATCHUP_MAX_EVENTS = 500`.** Justification: (a) one event-store read
  page (`READ_PAGE_SIZE = 500` in `OrchestrationEventStore.ts:72`), so a
  permitted replay — now genuinely bounded by `limit = gap` — is always a
  single page; (b) it comfortably covers the
  common resume cases this optimisation exists for — tab refocus, brief network
  blips, laptop sleep of minutes (a busy turn emits a few events per second);
  (c) beyond it, replay is strictly worse than a snapshot on both axes: ≥5
  queries/event vs a fixed set of aggregate queries, and repeated full
  thread-shell payloads vs each thread once. A 15k-event overnight gap — the
  incident habitat — goes straight to snapshot.
- **`afterSequence > snapshotSequence`** (client ahead of server — restored DB
  backup, or projection reset) currently replays nothing and leaves the client
  confidently stale with phantom threads. Falling into the snapshot path fixes
  this adjacent wedge for free.
- **Restart spanning:** not detected separately. A restart long enough to
  matter shows up as a large gap; a quick restart with a small gap replays
  correctly. Keeping one numeric criterion avoids a second detection mechanism.
- The client needs **no change** for this: `applyItems`
  (`shell.ts:135`) has always handled a mid-stream `kind: "snapshot"` item as a
  wholesale replace, and re-persists it. Old clients handle the new server
  behaviour natively.

Note the thread-detail subscription (`subscribeThread`, `ws.ts:1173`) shares
the unbounded read but replays raw events with **no** per-event lookup, so it
has no silent-drop hole; capping it is out of scope.

### 3.3 Client: retry the cold-path subscription (resilience completion)

Round 1 made the *warm* path self-heal (discard cache → cold path). But the
cold path's own subscription (`runShellSyncLeg`, `shell.ts:183`) has no
`retryExpectedFailureAfter`: a now-loud stream failure sets the error banner
and then waits for the next *session change* to resubscribe (the
`subscribe` helper in `rpc/client.ts` only re-invokes on transport loss or
session replacement). With server failures becoming loud, a transient failure
on an established connection would otherwise leave the client parked on the
error banner until the next reconnect.

Change: pass `retryExpectedFailureAfter: "5 seconds"` in the cold-leg
`subscribe` options. Resubscribing reuses the same `afterSequence` (the cold
base's sequence); the replay re-covers the interval and `applyItems` dedupes by
sequence, so the retry is idempotent. The existing `onExpectedFailure` →
`setStreamError` still fires, so the user sees the sync warning during the
retry window rather than nothing.

The warm path deliberately keeps its **no-retry** semantics: its failure
handler falls through to the cold path (fresh snapshot), which is the correct
recovery for a possibly-poisoned cache, and retrying the identical replay was
exactly round 1's wedge.

### What the client sees, case by case

| Scenario | Server behaviour | Client behaviour |
|---|---|---|
| Small gap, healthy DB | Event replay (unchanged) | Events applied (unchanged) |
| Small gap, lookup blip | Retry absorbs it; replay succeeds | Unchanged, no drop |
| Small gap, persistent lookup failure | Stream fails with `OrchestrationGetSnapshotError` | Warm cache discarded → cold HTTP snapshot (round-1 path) |
| Gap > 500 events (the incident) | Live subscription attached, then `snapshot` item + buffered live | Wholesale replace via existing `applyItems` path; missing threads appear |
| Client ahead of server | `snapshot` item + live stream | Phantom state replaced |
| Live-phase persistent failure | Subscription errors | Warm: self-heal; cold: banner + 5 s retry from same base |

## 4. Compatibility

Deploys ship both sides together but tabs stay open across deploys, so the
mixed matrix matters:

- **Old client (round-1 era) + new server:** the two new server behaviours are
  (a) an error where silence used to be — caught by the shipped round-1
  self-heal — and (b) a `snapshot` item on the afterSequence path — handled by
  the shipped `applyItems`/reducer, which has accepted mid-stream snapshots
  since the item union's inception. Fully compatible; old clients get most of
  the benefit.
- **Pre-round-1 client + new server:** a persistent replay failure shows the
  sync-error banner instead of silently wedging; a transient one recovers on
  the next reconnect. Strictly better than the status quo.
- **New client + old server:** the client change is only a retry duration on
  the cold leg — harmless no-op against old server behaviour.

No schema, RPC, or event changes; `OrchestrationSubscribeShellInput` is
untouched.

## 5. Test plan

**Server — `apps/server/src/server.test.ts`** (modelled on the existing
"routes websocket rpc orchestration shell snapshot errors" test at :5760,
using `buildAppUnderTest` layer stubs):

1. **Silent-drop regression (the core test):** stub
   `orchestrationEngine.readEvents` to emit **two** thread events, and
   `projectionSnapshotQuery.getThreadShellById` to fail persistently for the
   first thread and succeed for the second. Take stream elements until the
   first event or error (the subscription is durable — catch-up concatenates
   into the live leg and never completes on its own, so a bare `runCollect`
   would hang; use `Stream.take`/timeout-bounded collection). Today's code
   *succeeds* and yields only the second event — the exact silent omission
   whose sequence advance seals the gap; fixed code must **fail** with
   `OrchestrationGetSnapshotError` before yielding either. This pins "a
   successful stream must not be missing an event", not merely the new error
   path.
2. **Transient absorption:** `getThreadShellById` fails twice then succeeds;
   assert the subscription yields the `thread-upserted` event (retry works,
   no client-visible failure).
3. **Row-absent stays silent:** `getThreadShellById` succeeds with
   `Option.none`; assert the event is skipped without error (taxonomy's other
   half — guards against over-correction).
4. **Gap cap:** stub `getSnapshotSequence` far ahead of `afterSequence`; assert
   the first stream item is `kind: "snapshot"` and `readEvents` is never
   called. Companions: (a) gap ≤ 500 replays, asserting the **limit argument
   passed to `readEvents` equals the sampled gap** (the cap must be enforced at
   the read, not just at the branch); (b) `afterSequence > snapshotSequence`
   also snapshots.
5. **Connect-gap during snapshot load:** publish a domain event while the
   stubbed `getShellSnapshot` is in flight (gate the stub on a deferred);
   assert the event is delivered after the snapshot item rather than lost.
   Run it for both the no-afterSequence flow and the capped fallback — this
   pins the eager `subscribeDomainEvents` ordering. Variant (pins the
   error-preserving buffering shape from §3.2): the buffered event's
   projection lookup fails persistently; after the snapshot gate releases,
   the subscription must **fail** with `OrchestrationGetSnapshotError` —
   not hang, not silently omit the event — proving the live leg's error
   channel survives the buffering window.

**Client — `packages/client-runtime/src/state/shell-sync.test.ts`** (alongside
the round-1 "self-heals to the cold path" test at :384):

6. **Mid-stream snapshot replace:** warm-cache resume where the stubbed
   `subscribeShell` responds to `afterSequence` with a fresh `snapshot` item;
   assert the state and persisted cache are wholesale-replaced (client half of
   §3.2, and a guard that future reducer changes keep this path).
7. **Cold-leg retry:** cold-path subscription fails once with an expected
   failure, then succeeds; advance `TestClock` past 5 s; assert resubscribe
   with the same `afterSequence` and eventual `live` status (client half of
   §3.3).

The end-to-end incident shape (thread created during the gap + one flaky
lookup → thread ultimately visible) is covered compositionally by 1 + the
existing round-1 self-heal test: 1 proves the server turns the drop into the
exact failure that test already proves the client heals from.

Tests 4(a) and 5 rely on observing the `readEvents` limit and the eager
subscription; the `buildAppUnderTest` layer stubs already permit substituting
`orchestrationEngine`, so both are recordable there.

## 6. Rejected alternatives

- **Client belt-and-braces verification** (fetch a fresh snapshot after every
  catch-up and diff counts): pays a full snapshot per reconnect, which defeats
  `afterSequence`'s purpose; and count-comparison can false-negative (a drop
  paired with a legitimate delete). The server-side fix closes the hole at its
  source instead of detecting it downstream.
- **Always snapshot on afterSequence** (drop replay entirely): simplest
  possible fix and closes the hole, but regresses the common tab-refocus case
  the resume path exists for (tiny gaps, zero-byte reconnects). The 500-event
  cap keeps that win.
- **Making every `Option.none` loud:** wrong — row-absent is a legitimate,
  meaningful outcome (goal branch *depends* on it for `goal-removed`).
- **Periodic background resync / resync framework:** disproportionate; this is
  a targeted reliability fix, and a correct-by-construction stream plus
  self-heal makes scheduled reconciliation redundant.

## 7. Implementation notes (fork conventions)

- `toShellStreamEvent` and the `subscribeShell` handler are upstream-owned code
  with existing `// loom:` splices (goal branch). The `orElseSucceed` removals,
  the gap-cap branch, and the switch to eager `subscribeDomainEvents` (a
  fork-added engine facility) are small in-place edits, each tagged `// loom:`
  with a one-line rationale; the retry schedule and `SHELL_CATCHUP_MAX_EVENTS`
  constant live next to the handler. Upstream introduced the swallow pattern in
  #2968 ("Refactor recoverable Effect fallbacks to orElseSucceed") — the loom
  comments should note the deliberate divergence so a future upstream sync
  doesn't "fix" it back.
- `packages/client-runtime/src/state/shell.ts` cold-leg change extends the
  existing round-1 `// loom:` block.
- Related but out of scope: `enrichProjectEvent`'s `orElseSucceed(() => event)`
  (`ws.ts:592`) degrades enrichment rather than dropping events — acceptable;
  and `subscribeThread`'s unbounded replay has no lookup hole (§3.2 note).
