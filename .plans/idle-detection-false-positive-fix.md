---
manager_sessions:
  - id: b6619fe7-74e7-4b18-b97a-b6efe199590a
    role: plan
    authored_at: 2026-06-26T03:55:07.683Z
---

# Plan: fix the idle-detection false positive behind the stale "N running" badge

## Origin / what this is really about

The reported symptom was a stale sidebar badge ("●●● N — Workstream · N running")
that kept claiming workers were running after an orchestrator's sub-threads were
all done. Investigation reframed the bug **away** from the frontend:

- The frontend liveness predicates in `apps/web/src/lib/workstreamGraph.ts`
  (`isActiveWorker` / `isLive`) are **conceptually correct** and must NOT be
  changed to defer to terminal workflow status. "Running" (a turn is in flight)
  and "done" (the task is complete) are **orthogonal axes**: a `done` reviewer
  the user re-engages in chat genuinely has a live turn and *should* show as
  running. The originally-proposed "terminal statuses never count as live" fix
  is rejected — it would hide real activity.
- The display faithfully reflects its input signal. The defect is in the
  **signal**: a sub-thread that is *genuinely still running a turn* is being
  classified **idle**, which (a) drives the dispatcher's "forgot to finish"
  wake and (b) leads the orchestrator to prematurely mark threads `done`,
  after which the badge/board disagree with reality.

Evidence (from session `6d4a88d9`): multiple sub-threads kept **writing files
and committing after** an idle/quiesce trigger fired. The owning session's own
explanation ("a real freeze whose verdict merely lagged") was explicitly flagged
by the user as **not correct** — the threads were never dead; the idle classifier
fired against an in-flight turn. This is a **false positive in idle detection**.

> Note the prior "liveness fix" PR #12 (`WorkstreamLivenessSweep` loop-detector
> signature) is a *different* bug on the `error` rail and does **not** address
> this. This plan targets the **idle** rail.

## The code path in scope

The idle gate is a single shared predicate:

`apps/server/src/orchestration/threadIdle.ts` — `isThreadIdle`:

    idle ≝ !pendingTurnStartThreadIds.has(id)          // no requested-but-unstarted turn
           && session?.status !== "running"            // projected session not running
           && (session === null || session.activeTurnId === null)   // no active turn

Consumers:
- `Layers/WorkstreamDispatcher.ts` `classifyChildWake` (~L205-224): emits an
  `"idle"` wake when a child is `planned|running`, its **projected** session is
  `ready|stopped`, and `isThreadIdle` holds.
- `Layers/OrchestrationEngine.ts` (~L183-188): same gate for dispatcher-injected
  wakes ("a wake may only land on an idle parent").

The signal feeding the gate:
- `session.status` / `activeTurnId` are projected from `thread.session-set`
  events in `Layers/ProjectionPipeline.ts` (the `"thread.session-set"` case,
  ~L1291+). "Leaving the running status is the turn-end signal."
- Provider runtime status → orchestration status mapping in
  `Layers/ProviderCommandReactor.ts` `mapProviderSessionStatusToOrchestrationStatus`:
  `running→running`, `ready→ready`, `closed→stopped`, `connecting→starting`,
  `error→error`.
- `pendingTurnStartThreadIds` = threads with a `projection_turns` row where
  `turn_id IS NULL` (`Layers/ProjectionSnapshotQuery.ts` `listPendingTurnStartRows`).
  Inserted on turn-start-request, cleared on `turn.started` /
  `thread.turn-start-failed`.

For the false idle to fire, **all three** clauses must be true while a thread is
still doing work: no pending-turn-start row, projected `session.status` is
`ready`/`stopped` (not `running`), and `activeTurnId` is null.

### The structural seam (unifying root-cause statement)

The mid-turn **stall** detector in `WorkstreamLivenessSweep` is *graced*: it only
computes a verdict while `activeTurnId !== null` and applies a startup /
no-progress window. The instant `activeTurnId` flips to `null`, ownership passes
to the **idle** wake — which has **zero corroboration window** and fires on the
very next dispatcher pass (the same `thread.session-set` that nulled
`activeTurnId` triggers that pass). So any event that legitimately nulls
`activeTurnId` while the thread still has work to do produces an instant false
"forgot to finish" wake. The fix is to give the idle wake the **same
activity-freshness grace** the stall detector already has.

### The closed set of idle-eligible emitters (no open-ended search needed)

The only `thread.session-set` emitters that produce `(status ∉ {running},
activeTurnId === null)` *and* land in `classifyChildWake`'s idle-eligible
`{ready, stopped}` band are:

1. **`turn.completed`** for the active turn (`ProviderRuntimeIngestion.ts`
   ~L1444 nulls `activeTurnId`, ~L1450-1456 sets `status="ready"` when not
   failed). **Leading suspect.**
2. **`session.exited`** (~L1444 null, ~L1453 `"stopped"`, plus
   `clearTurnStateForSession` ~L1828).
3. Reactor **`bindSessionToThread`** on a mid-turn session *restart*
   (`activeTurnId: null`, fresh status; only the `ready` mapping is
   idle-eligible) — runtime-mode/cwd/model/provider-selection change.
4. Reactor **`processSessionStopRequested`** (`status:"stopped"`,
   `activeTurnId:null`) — an explicit stop.

Everything else is already defended: `session.state.changed` **preserves**
`activeTurnId`, so status→`ready` alone can never trip the gate;
`session.started`/`thread.started` keep `running` while `activeTurnId !== null`;
`runtime.error` routes to the `error` rail. **The most likely real cause given
the symptom** ("sub-threads kept writing files/committing *after* the trigger")
is #1 — a `turn.completed` (latest turn genuinely settled) immediately followed
by continued / next-turn autonomous work, i.e. a **between-turns idle window** in
a multi-turn child. `session.exited` (#2) is *unlikely*: a gone process cannot
keep writing files.

## Phase 1 — Confirm the emitter (cheap; not a blocker for the fix)

The culprit event set is **closed and small** (the four idle-eligible emitters
above), so no open-ended instrumented hunt is needed. Confirmation is a log /
event-store query, not a fresh nondeterministic repro:

1. From `6d4a88d9`'s event store, confirm which of `turn.completed` /
   `session.exited` preceded the false idle wake, and whether a `turn.started`
   *followed* the wake (which would prove the thread re-armed work after being
   declared idle — the between-turns signature).
2. Record the finding in this doc.

**Crucially, the Phase 2 fix does not depend on this confirmation.** The
activity-freshness grace below prevents the false wake regardless of *which*
event nulled `activeTurnId`, because it adds the missing corroboration step the
idle rail lacks. Phase 1 is for the incident record and to rule out a
second distinct mechanism, not a gate on shipping. If access to the event store
is unavailable, proceed on the code-based conclusion and note it.

## Phase 2 — Give the idle wake an activity-freshness grace (the primary fix)

The idle wake fires the instant `activeTurnId` becomes null, with zero
corroboration — unlike the graced stall detector. The fix is to require
**activity quiescence** before classifying "forgot to finish":

- Gate the `"idle"` branch of `classifyChildWake` (or its caller in
  `wakeIdleAndErroredChildren`) on `now - maxCreatedAt > graceWindowMs`, where
  `maxCreatedAt` is the child's latest activity timestamp. The dispatcher
  **already fetches** `getActivityFreshnessByThreadId(child.id)` for the episode
  key, and that row already carries `maxCreatedAt`
  (`ProjectionSnapshotQuery.ts` ~L1176/1192) — **no new query**. A child whose
  latest turn just completed but is still emitting tool/assistant activity
  inside the grace window is therefore not declared idle.
- **Required new machinery — a scheduled re-pass.** The dispatcher is
  event-driven (passes fire on `thread.created`/`status-set`/`dependencies-set`/
  `session-set`). If a child goes genuinely quiet and *no further event arrives*
  during the grace, nothing re-runs the pass to fire the now-confirmed wake. Add
  a scheduled re-pass / tick so a legitimately idle child is still nudged once
  the window elapses. This is the only non-trivial part of the fix — do not
  undersell it.
- **Tune the window against the stall detector's no-progress window**
  (`phase-d-liveness` ~L222) so there is no dead zone where neither the stall
  rail (`activeTurnId !== null`) nor the idle rail (`activeTurnId === null`)
  fires.

Dedup is unaffected: the episode key re-arms on `maxSequence`; a grace only
delays *onset*, it does not change the one-wake-per-episode invariant
(`phase-d-liveness` ~L290-296).

Preserve the existing legitimate behaviors the gate guards:
- a freshly-promoted child mid-kickoff (pending-turn-start window) is not idle;
- a turn-start-failed parent is released (Fix A in ProjectionPipeline);
- terminal `done|blocked|review` children are not treated as "forgot to finish".

### Rejected / qualified alternatives (do NOT implement these as the fix)

- **Align with `isLatestTurnSettled` — does NOT fix the observed symptom.** In
  the between-turns / premature-`turn.completed` case the latest turn *is*
  genuinely settled (`startedAt && completedAt && status !== "running"`), so this
  corroboration returns "settled" and the false wake still fires. It guards only
  against transient/lagging status, a case the code already largely defends.
- **Hold `activeTurnId` set past the turn-end / disconnect — invariant
  conflict.** `ProjectionPipeline.ts` ~L1291-1320 treats "session leaves
  `running` / `activeTurnId` null" as the **authoritative turn-end** and settles
  turn rows + durations off it; `clearTurnStateForSession` (~L1828) and the
  error-rail failure counter (`WorkstreamLivenessSweep` ~L242, keyed on
  `activeTurnId !== null && unbound`) also depend on it. Holding `activeTurnId`
  live would break turn-duration settlement and could strand a dead session as
  perpetually active. Do not pursue without explicit reconciliation with the
  user.

## Phase 3 — Optional follow-ups

- Verify the parent wake-message guidance encourages *investigation*
  (`workstream_read_thread`/`workstream_ask_thread`) before marking a child
  `done`/`error`, so the wake never directly causes premature done-marking.
- Consider whether the same grace should also apply to the `OrchestrationEngine`
  idle gate for dispatcher-injected wakes (consistency).

## Explicitly out of scope / coordination

- **No change to `workstreamGraph.ts` liveness predicates.** Restate this in the
  PR description so a reviewer/bot doesn't "fix" the wrong layer.
- **Stale `session.status === "running"` cleanup** (a session left at running
  after work truly ends) is being handled in a separate thread/PR per the user.
  This plan touches the same projected fields, so coordinate to avoid conflicts;
  if Phase 1 shows the two bugs share a root event, fold the discussion back to
  the user before splitting the fix.
- Read `.plans/phase-d-liveness-design.md` and `.plans/phase-d-notify-*-design.md`
  first — they define the invariants this gate is built on; the fix must not
  violate them.

## Tests & verification (bar for done)

The grace-window fix is **deterministically unit-testable** — it does not depend
on a flaky end-to-end repro for the core guarantee:

- **Decisive table test** (mirror existing dispatcher tests): feed the dispatcher
  a child whose latest turn is `completed` (status `ready`, `activeTurnId` null)
  with `maxCreatedAt` *younger* than the grace window → assert **no** `"idle"`
  wake; then age `maxCreatedAt` *past* the window → assert it fires **exactly
  once**. This converts the "non-deterministic timing bug" into a deterministic
  assertion.
- Extend `threadIdle` / `classifyChildWake` coverage for the preserved
  behaviors (pending-turn-start window, terminal children excluded).
- Add/extend a test for the **scheduled re-pass**: a child that goes quiet with
  no subsequent event still gets its single idle wake after the window elapses.
- `vp run typecheck` and `vp check` green; `vp test` passes incl. new cases.
- Canonical confirmation (not the primary guarantee): reproduce the original
  scenario end-to-end (spawn a long-running multi-turn sub-thread) and confirm
  no false `"idle"` wake and no stale "N running" badge.
- Ship via the AGENTS.md PR flow only after user approval; leave uncommitted for
  review otherwise.
