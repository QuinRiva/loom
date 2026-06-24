# Phase D: dispatcher — enforce dependencies + liveness + (optional) completion judge

**Status:** plan for a FUTURE thread (to be picked up after the workstream feature
is merged to `main`). Self-contained so a fresh session can run it.

## Why this exists (current state recap)
The workstream feature today (Phases 1/A/B/C1/C2 + the status-self-report fixes):
- Sub-threads have explicit `status` (planned/running/blocked/review/done) and
  `blockedBy: ThreadId[]` edges.
- Status is driven by **cooperative self-report** (the child agent calls
  `workstream_set_status`, now prompted to mark itself done/review/blocked) plus
  spawn auto-setting `running`.
- **`blockedBy` is DISPLAY-ONLY.** `getEffectiveColumn` shows a thread as
  `blocked` when a dependency isn't `done`, but nothing *acts* on it.
- **`workstream_spawn` immediately does `thread.create` + `thread.turn.start`** —
  so a "dependent" sub-thread (e.g. a reviewer that waits on a coder) actually
  **runs immediately at spawn, in parallel**, regardless of its dependencies.

So "coder runs first, reviewer unblocks when the coder is done" is currently
**cosmetic**. Phase D makes it real, and adds the liveness/robustness a real
control plane needs. This is the piece that turns workstreams from
"visualised state" into "orchestrated execution" (the Hermes-kanban model).

## Goal
A server-side **dispatcher** that owns sub-thread execution lifecycle:
1. **Dependency-gated execution** — a sub-thread with unmet `blockedBy` does NOT
   start its turn; the dispatcher starts it only once every dependency is `done`.
2. **Liveness** — heartbeats + stale detection so a crashed/stalled sub-thread
   doesn't block its dependents forever.
3. **(Optional) completion judge** — robustness beyond cooperative self-report.

## Core design

### Execution gating (the heart of it)
- **Change spawn**: `workstream_spawn` should still `thread.create` immediately
  (so the card appears on the board), but **only auto-start the turn when the new
  thread has NO unmet dependencies.** A dependent child is created `planned` and
  left un-started.
- **Dispatcher reactor**: a server component that reacts to `thread.status-set`
  (and `thread.dependencies-set`, `thread.created`) events. On each, it
  re-evaluates every sub-thread whose `blockedBy` are now all `done` and
  **promotes** it — dispatches its `thread.turn.start` (the deferred kick-off) and
  sets `running`. Idempotent; serialized through the existing OrchestrationEngine
  queue so there's no double-start race. (Mirrors Hermes' "promote ready" pass.)
- **Suggested state refinement**: add a `ready` state (deps satisfied, not yet
  started) distinct from `planned` (has unmet deps) and `running` — matches
  Hermes' todo→ready→running and makes the board legible. Decide in-thread.

### Liveness (steal from Hermes)
- **Heartbeats / stale detection**: reuse provider-session liveness (see
  `ProviderSessionReaper`) to detect a sub-thread whose session died or stalled
  (no progress for N). On stale: mark `blocked` (with reason) or `error` and
  surface it — so a dead coder doesn't pin a reviewer at `blocked` forever.
- **Circuit breaker**: a consecutive-failure cap per sub-thread (Hermes
  `consecutive_failures`/`max_retries`) so a repeatedly-crashing child isn't
  retried infinitely; trip → `blocked`/`error` + surface to the orchestrator/human.
- **Failure propagation**: decide what happens to dependents when a dependency
  ends in `error`/blocked rather than `done` — cascade-block, or surface to the
  orchestrator to decide. (Recommend surface, don't silently cascade.)

### Completion authority (optional, decide in-thread)
- Today completion = cooperative self-report (the child marks itself `done`). This
  is the Hermes default and is fine for trusted agents. For robustness, optionally
  add a **judge** (Hermes `goal_mode`/Ralph loop): an auxiliary LLM check that the
  child's output actually satisfies its `purpose` before the dispatcher accepts
  `done` and releases dependents. Could also gate via a `TaskCompleted`-style hook.
  Likely a follow-on even within Phase D.

## Decisions to resolve in the implementing thread
1. Gate at **turn-start** (create immediately, defer the kick-off) vs at
   **spawn-time** (don't create until ready). Recommend turn-start gating (card
   visible as planned/blocked while waiting).
2. Add a `ready` status, or reuse `planned`? (Recommend add `ready`.)
3. Where the dispatcher lives — a new reactor beside `ProviderCommandReactor`,
   reacting to status/deps/turn events.
4. Heartbeat source + stale threshold; reuse vs extend `ProviderSessionReaper`.
5. Completion: cooperative-only, judge-gated, or both.
6. Failure/cascade semantics when a dependency doesn't reach `done`.
7. Concurrency cap on simultaneously-running sub-threads (Hermes per-profile cap)
   — ties to Carl's stated preference to *expose* agent count rather than hard-cap;
   reconcile here.

## Out of scope
- Worktree isolation per sub-thread (separate concern; Carl decided current
  shared-worktree behaviour is acceptable for now).
- Cross-project / cross-environment orchestration.

## References
- Hermes Kanban dispatcher ("reclaim stale, promote ready, spawn"), worker-lane
  contract, `goal_mode` judge, `TaskCompleted` hook, heartbeat/circuit-breaker —
  see `.plans/workflow-subagent-sessions-research.md` §9.
- Existing T3 building blocks: `OrchestrationEngine` (serialized dispatch),
  `ProviderCommandReactor` (reacts to thread events → starts sessions),
  `ProviderSessionReaper` (session liveness), the `thread.status-set` /
  `thread.dependencies-set` events (C1), `WorkstreamSpawnHttp` (spawn path to gate).

## Acceptance (when Phase D is done)
- Spawning a coder + a reviewer-that-waits-on-it results in: coder runs first;
  reviewer stays un-started (`blocked`/`planned`) until the coder reaches `done`;
  then the dispatcher auto-starts the reviewer. Verified with a live run, not just
  a unit test.
- A killed/stalled coder is detected (heartbeat) and surfaced instead of pinning
  the reviewer forever.
- `vp check` + typecheck + server suite green.
