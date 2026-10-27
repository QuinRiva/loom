---
manager_sessions:
  - id: c448c079-8edc-4f36-9275-f296adf72c58
    role: plan
    authored_at: 2026-06-26T10:26:54.379Z
---

# Plan 11 — Orchestration `error→done` recovery wake + PiDriver tool-args hygiene

Two independent server-side fixes in the orchestration control plane, found while
shipping the liveness false-positive fixes (PR #19).

## Bug 1 (primary): an `error → done` recovery never re-notifies the parent

### Confirmed mechanism

- `selectJoinedGenerations` (`packages/shared/src/workstreamGraph.ts`) fires a
  generation as "joined" once **every** child `isTerminalStatus` — and `error`
  is terminal. The generation wake (`wakeCommandId(parent, generation)`, keyed
  only by parent+generation) is therefore delivered once at the error and its
  receipt makes every later pass `already-woken`.
- The per-child rail (`wakeIdleAndErroredChildren` / `classifyChildWake`) **does**
  reliably wake the parent when a child goes `error` (episode `"error"`, command
  id `childWakeCommandId(child, "error")`), independent of siblings. Its receipt
  is the durable proof "we told the parent this child errored".
- When the child later flips `error → done`: `classifyChildWake` returns `null`
  for a `done` child, the generation barrier is still `already-woken`, so the
  parent is **never** re-notified. Its view is frozen on the stale error verdict.

### Dependent release — already correct, will lock with a test

`areDependenciesSatisfied` gates on `dep.status === "done"` (not "is terminal"),
so an `error` dep keeps a dependent gated and the `error → done` transition emits
a `thread.status-set` event → dispatcher worker pass → `promoteReadyThreads`
releases the dependent. No code change needed here; add a regression test
asserting `error` gates and `done` releases.

### Fix: a per-child **recovery** wake (folded into the existing per-child rail)

Extend `wakeIdleAndErroredChildren` (NOT a third pass — that would re-fetch the
snapshot a third time per pass and duplicate the deliver/defer/rate-guard
scaffolding). Add a `done`-child branch to its loop:

- For each child currently `done` with a parent, command id
  `childWakeCommandId(child, "recovered")`.
- Fire **only if** the durable error-wake receipt
  (`childWakeCommandId(child, "error")`) exists — checked via
  `hasAcceptedReceipt` (the **durable receipt only**, NOT `handledChildWakes`,
  which the park path poisons by adding the command id without writing the
  receipt) — i.e. we actually told the parent it errored — and the recovery wake
  has not already been delivered. A `done` child with no error receipt never
  errored (error precedes done) → record it handled so the receipt is not
  re-read every pass.
- Deliver via the shared `deliverChildWake` (same per-parent rate budget / park
  escalation), dedup via the shared `handledChildWakes` set + receipt store. The
  loop already runs in `runPassSafely` on every event-driven and scheduled pass;
  startup reconciliation covers restart-mid-flight.
- Extend `ChildWakeKind` with `"recovered"` and branch `buildChildWakeMessage`:
  lead = "previously hit `error` … has since reached `done` … superseded, treat
  as completed successfully"; tail notes dependents were already released by the
  `done` transition (no manual resolution needed), unlike the error/idle tail.

Scope recovery to `done` only (the unambiguous "succeeded" + dependent-releasing
state); `error → review`/`blocked` stay "awaiting" and are out of scope.

### User-visible contract pinned

1. When a child that the parent was told `error`ed later reaches `done`, the
   parent is re-notified that it recovered/succeeded (the recovery wake fires
   once per child). Note: a child that errored *while siblings still ran* and
   then the whole generation reaches `done` may be surfaced both per-child
   (recovery) and in its generation-join summary — benign and arguably useful;
   there is no cheap stateless way to separate that from the genuine freeze.
2. `blockedBy` dependents release when their dependency reaches `done`, including
   after a prior `error`.

### Known limitations (intentional for v1)

- Re-dispatch-then-re-error (`error→done→error→done`) is **not** re-surfaced: the
  recovery and error episodes are both one-shot per child, matching the existing
  constant `"error"` episode (a re-errored child is already not re-notified
  today). Out of scope.
- The recovery *trigger* is scoped to a prior `error`. The underlying freeze (the
  generation-barrier wake being one-shot) also exists for a generation that
  joined with a child in `review`/`blocked` that later flips to `done`. That is
  lower-frequency than the `error→done` PR #19 motivator and is left as a known
  limitation, not addressed here.

### Tests

- `workstreamDependencies.test.ts` / dispatcher `selectThreadsToDispatch`:
  `error` dep gates, `done` releases (locks contract 2).
- `WorkstreamDispatcher.test.ts`: `buildChildWakeMessage("recovered", …)` shape;
  full-layer (`TestClock`) test — a `done` child **with** a prior error-wake
  receipt yields exactly one recovery wake to the parent and is idempotent
  thereafter; a `done` child **without** a prior error receipt yields none.

## Bug 2 (secondary): PiDriver `toolArgs` stash leaks on aborted turns

`ActivePiSession.toolArgs` is populated on `tool_execution_start/update` and
cleared on `tool_execution_end`. A tool call that never emits `end` (abort/
interrupt/never-completing tool) leaks its entry until session GC.

### Fix

Clear `session.toolArgs` at the `agent_end` case (the T3 turn boundary, which an
abort also reaches). All of a turn's tool calls are scoped within that turn, so
clearing the whole map at turn end is correct and minimal.

### Correctness confirmed

`toolCallId`s are unique per invocation; a later call's `tool_execution_end`
reads only its own id, so a stale entry can never be mis-merged into a later
call. This is pure memory hygiene, no correctness impact. (No test — trivial,
turn-boundary cleanup; AGENTS.md: tests optional/rare.)

## Verification

`vp run typecheck` and `vp check` green; `vp test` passes incl. new cases. Ship
via the AGENTS.md PR flow only after user approval.
