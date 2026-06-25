---
manager_sessions:
  - id: e60766ea-eda2-46fa-9573-bc03cc432a2f
    role: plan
    authored_at: 2026-06-25T01:45:00.071Z
---

# Provider-intent startup reconciliation (durable re-drive of un-executed turns)

**Status:** design / open decisions, for a FUTURE thread. Self-contained.
Independent of the Phase D arc — this is a **provider-execution-layer** durability
gap that D-core and D-notify *inherit*, not something either introduced. It lands
on `main` and benefits normal turns as much as workstream orchestration.

## Why this exists (the gap, precisely)

T3 is event-sourced. Every action splits into two phases:
1. **Durable record** — a command becomes events (`thread.turn-start-requested`,
   …), written to the SQL event store inside a transaction and projected into the
   read model. Bulletproof: rebuilt from the event store on restart.
2. **Side effect** — actually talking to the provider (pi/ACP process). Performed
   by `ProviderCommandReactor`, which subscribes to a **live, in-memory PubSub**
   (`orchestrationEngine.streamDomainEvents` = `Stream.fromPubSub(eventPubSub)`)
   and acts the instant an event is published.

The reactor is an **ephemeral subscriber to a durable log**: no cursor, no
checkpoint, no startup replay. (The engine even exposes `readEvents(fromSequence)`
— the reactor just doesn't use it; verified at
`ProviderCommandReactor.ts` `start()` ~1160 and `OrchestrationEngine.ts` ~352/372.)

**Consequence:** if the server isn't listening at the exact moment an event is
published (it crashed/restarted in that window), the event is still stored
forever, but **the side effect it should have triggered never happens, and nothing
on restart notices.** The durable record of "what should happen" survives; the
tracking of "did we actually do it?" does not.

### Failure examples (same root cause, increasing severity)
- **Normal human turn (recoverable):** you send a message; events commit (message
  is permanent); crash before the reactor consumes → on restart pi is never
  called, no reply ever comes. A human shrugs and resends — *you* are the recovery
  mechanism, which is why this stayed invisible.
- **D-core child promotion (silent):** dispatcher promotes a reviewer
  (`thread.turn.start`); crash before consume → on restart the dispatcher's guard
  sees a pending turn-start and won't re-promote, the reactor won't replay → the
  reviewer never runs, no human watching. A dark stall.
- **D-notify parent wake (silent):** dispatcher injects a wake; crash before
  consume → the parent never wakes. The anti-dark-stall feature has its own
  dark-stall window.

## Scope of what's already mitigated (do not redo)
- D-notify Stage-1 fix-pass made `promoteThread`'s kickoff **atomic** (turn-start +
  `running` in one command) — removes the "status stuck at `planned`" sub-case.
- D-notify Fix A clears an **orphaned pending-turn-start row on provider turn-start
  *failure*** (a failure handler ran). That is NOT this gap: here **no failure
  handler runs at all** (the process died), so nothing emits the clear.

Neither addresses the core: **a committed turn-start whose side effect was never
executed, with no startup re-drive.**

## Goal
On startup (and ideally as a periodic sweep), **detect provider intents that were
durably recorded but never executed, and re-drive them exactly once** — without
double-running a turn the provider actually did receive.

## The hard part: idempotent re-drive
The whole difficulty is distinguishing, on restart, between:
- **(a) never sent** to the provider → must re-drive.
- **(b) sent, but the ack/started-event was lost, or it's genuinely mid-turn** →
  must NOT re-drive (re-sending re-runs the agent and clobbers `activeTurnId` — the
  exact hazard fought in the D-notify wake work; see the pi `sendTurn` no-busy-guard
  finding).

A naive "replay all turn-start-requested with no completion" will double-run case
(b). The design must define a reliable in-flight signal.

## Decisions to resolve in the implementing thread
1. **Detection predicate.** What durable state marks "intent recorded but not
   executed"? Candidate: a thread with a **pending-turn-start projection row**
   (already exists; created on `thread.turn-start-requested`, deleted on
   `session-set` running+turnId) **and** no active/started provider turn and no
   live provider session. Pending-start rows are exactly "requested but never
   reached `turn.started`" — likely the spine of the predicate. Validate this
   covers the no-session sub-case too.
2. **In-flight disambiguation (the load-bearing call).** How to be sure a thread
   is case (a) not (b) before re-driving? Options: rely on the pending-start row +
   provider-session liveness (`ProviderSessionDirectory`/reaper signals); require a
   provider-level idempotency key so a re-sent prompt is deduped by the provider;
   or a "claimed/dispatched" durable marker written *before* the provider call so
   re-drive only happens for unclaimed intents. Decide and justify.
3. **Mechanism: durable consumer cursor vs reconciliation scan.**
   - *Cursor:* give `ProviderCommandReactor` a persisted checkpoint; on restart
     replay `readEvents(fromCursor)` for unprocessed provider intents. General and
     principled, but must be idempotent against (b) and against events already
     acted on pre-crash.
   - *Reconciliation scan:* on startup, query the read model for the detection
     predicate (decision 1) and re-dispatch just those. Smaller, mirrors the
     existing precedents (D-core "startup promote-ready pass", D-notify "startup
     wake reconciliation"). Likely the lighter, safer first cut.
   Recommend the **reconciliation scan** unless the cursor's generality is needed.
4. **Periodic sweep or startup-only?** A crash is the obvious trigger, but a
   transient reactor failure mid-run could also drop an intent. Decide whether a
   periodic reconciliation (like `ProviderSessionReaper`'s sweep) is warranted or
   startup-only suffices.
5. **Interaction with D-core/D-notify startup passes.** Three startup
   reconciliations would then exist (promote-ready, wake, provider-intent). Decide
   ordering/composition so they don't fight (e.g. provider-intent re-drive must run
   such that a re-driven turn-start is then seen consistently by the others).
6. **Failure surfacing.** If an intent can't be re-driven (provider gone, repeated
   failure), surface it (activity + status) rather than silently dropping —
   consistent with the "no dark stalls" principle.

## Out of scope
- The D-notify control-plane semantics (already designed/built).
- Worktree isolation; cross-environment orchestration.

## Acceptance (when done)
- Kill the server in the window between a turn-start committing and the provider
  reactor consuming it; on restart the turn is **re-driven exactly once** and the
  agent actually runs — verified for: a normal user turn, a D-core child
  promotion, and a D-notify parent wake.
- A turn that WAS already in-flight at crash time is **not** double-run on restart
  (no duplicate agent run / no `activeTurnId` clobber).
- `vp check` + `vp run typecheck` + server suite green.

## Appendix: related test-infra debt (tracked here, fix once)
Discovered during D-notify: **there is no supported way to write a NEW
engine-backed Effect integration test in this repo.**
- `@effect/vitest` (`it.live`/`it.effect`/`describe`) does **not register suites**
  under the canonical `@voidzero-dev/vite-plus-test` runner (`vp run -r test` /
  `vp test run`) — it throws "Vitest failed to find the current suite". (A test
  written this way can appear to pass via a different local binary, producing a
  dead test that never runs in CI.)
- The pattern that *does* run — `vite-plus/test` + `ManagedRuntime`/`runPromise`
  (e.g. `OrchestrationEngine.test.ts`) — is blocked for new files by the
  `t3code/no-manual-effect-runtime-in-tests` debt-ratchet lint rule
  (`LEGACY_BASELINE` grandfathers existing files at fixed counts; new files get
  zero tolerance).

Net: new engine round-trips can only be covered by pure-seam unit tests today.
D-notify's deferred-wake/park/idle invariants are therefore covered by runnable
pure-seam tests (`classifyGenerationByReceipts`, `isThreadIdle`,
`selectJoinedGenerations` in `WorkstreamDispatcher.test.ts`) plus typecheck +
review, not an engine round-trip. **Fix once:** either make `@effect/vitest`
collect under `vite-plus-test`, or provide a shared lint-clean engine-test harness
(a sanctioned `ManagedRuntime` wrapper exempt from the ratchet). Until then, new
engine-backed Effect tests are infeasible — relevant to this doc's own acceptance
(the crash-window re-drive tests it calls for will need this harness).

## References
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` — live-only
  subscription (`start()` ~1160); the consumer to make durable.
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` — `readEvents`
  (~352) + `streamDomainEvents` live PubSub (~372).
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` — pending-turn-start
  row lifecycle (created on `turn-start-requested`; deleted on `session-set`
  running, and on `thread.turn-start-failed` per D-notify Fix A).
- `ProviderSessionReaper` / `ProviderSessionDirectory` — liveness signals for the
  in-flight disambiguation.
- Precedents: D-core startup promote-ready pass; D-notify startup wake
  reconciliation (`WorkstreamDispatcher.ts`).
