# Plan: continue mid-turn threads across server restart/deploy

## Problem

After a server restart (deploy), threads whose provider turn was **in flight are
not resumed** — they go idle and their work is silently dropped. We want every
genuinely interrupted turn to resume automatically after the server comes back.

## Diagnosis (corrected after review)

The original hypothesis — that commit `5c4850352` ("delta-based parent notices")
removed a restart re-wake — is **wrong**, and the framing of this as "restoring"
old behaviour is also wrong:

- The pre-`5c4850352` whole-generation wake was **already receipt-deduped across
  restarts** (`5c4850352^:WorkstreamDispatcher.ts:799`, `classifyGenerationByReceipts`),
  exactly like the delta rail that replaced it. Neither re-fires for a generation
  already delivered before the crash.
- Both the old barrier and the new delta rail only ever target an **orchestrator
  parent** about a **newly-terminal child**. Neither ever resumed a thread that
  was simply mid-turn — in particular a **leaf sub-thread** (no children) or a
  **root thread** was never resumed by any dispatcher mechanism.

So there is no removed mechanism to restore. The real situation:

- On restart, in-memory provider sessions are gone (adapters hold sessions in a
  fresh `Map`, e.g. `ClaudeAdapter.ts:1413`), so `providerService.listSessions()`
  is empty → the reconcile's `hasActiveProviderTurn` guard is false.
- `reconcileStartupStaleSessionState` (`apps/server/src/loom/startup.ts:44`) then
  **resets** every stale session (`status:"running"` or `activeTurnId!=null`) to
  `status:"ready", activeTurnId:null`. That was introduced (`914c1e1d4`) to
  un-stick "deaf" orchestrators — but for a thread whose turn was actually
  **running**, the reset **stops** it: nothing ever resumes the interrupted turn.

The fix is therefore a **new, explicit guarantee**, not a restoration: reconcile
must *resume* a genuinely interrupted turn instead of merely clearing it.

Verified capability that makes this feasible:
- `ProviderService.sendTurn` runs with `allowRecovery:true`
  (`ProviderService.ts:675`); an absent in-memory session is recovered from the
  persisted `ProviderSessionDirectory` binding + `resumeCursor`
  (`resolveRoutableSession`/recover, `ProviderService.ts:395-440`, strategy
  `resume-thread`). So a fresh `thread.turn.start` on an interrupted thread
  resumes its persisted provider session **with full prior context**, not a
  cold restart — provided the persisted binding still exists.

## Goal

After a restart, every thread whose provider turn was genuinely in flight resumes
exactly one turn, continuing from its persisted session — for **all** threads
(roots, orchestrators, and leaf sub-threads), with no double-started turns, and
**crash-safe** across repeated restarts (a second crash during recovery must not
lose the continuation).

## Two options (decision required)

Two review rounds converged on a genuine scope/cost decision. Both resume
interrupted turns after a normal restart; they differ only in crash-safety during
the brief per-thread *recovery window* (the interval between the resume
command being accepted and the provider emitting the replacement `turn.started`).

Verified constraint driving this: on a resume `turn.start`,
`ProviderCommandReactor.bindSessionToThread` (`ProviderCommandReactor.ts:645-660`)
rewrites the read-model session with `activeTurnId: null` *before* the resumed
turn starts, and rebuilds the session literal (dropping any session-field
marker). So no session-derived signal (neither `activeTurnId` nor a new
`LoomSessionField`) survives that window — a durable marker must live **outside**
the session to be crash-safe.

- **Option 1 — best-effort (recommended to start).** Reconcile resets each
  interrupted thread to `ready` and dispatches a `requireIdle` resume
  `turn.start`. `requireIdle` makes it double-start-safe against every producer
  (child-delta / yield / gate / liveness), which is the review's must-fix #2.
  Residual risk: a crash *inside* a specific thread's recovery window loses that
  one thread's continuation. This is strictly better than today (today **all**
  interrupted turns are lost); the lossy window is milliseconds wide and only on a
  second crash during the deploy. Small, fork-local (`loom/startup.ts` only), no
  schema, no shared-reactor edits.
- **Option 2 — fully crash-safe.** Add a durable **pending-restart-continuation**
  set (a small projection keyed by threadId, analogous to
  `pendingTurnStartThreadIds`), set by reconcile and cleared only when a
  replacement `turn.started` is observed (in `ProviderRuntimeIngestion`). Reconcile
  re-derives owed continuations from that set on every boot and re-dispatches
  (requireIdle) until it clears — surviving repeated crashes, including inside the
  recovery window. Cost: a new durable projection + a clear-on-`turn.started`
  hook in the shared runtime-ingestion path (not fork-local), plus migration.

**Recommendation:** ship Option 1 first — it delivers the actual user value (turns
continue after a deploy) with minimal, elegant, fork-local code and a strictly
improved failure mode, and defer Option 2 unless the double-crash-in-recovery
case is observed in practice. The reviewer rates Option 1 as crash-incomplete;
that is accurate and accepted as a bounded, documented residual risk, not a
correctness bug in the common path.

The rest of this section describes the shared mechanics; the crash-safety
paragraphs below apply to whichever option is chosen.

## Design

Split the reconcile's per-thread handling by the **runtime-interruption fact**,
which is the sole discriminator (independent of plan lane):

- **Interrupted-mid-turn** — `session.activeTurnId != null` (a turn had actually
  started/was running) **and** the provider is dead (`hasActiveProviderTurn`
  false, already the loop guard) **and** the thread is not parked on a human (no
  pending approvals, no pending user input): **resume** it (new behaviour).
- **Stuck-running-but-no-active-turn** — `status === "running" && activeTurnId ==
  null`: keep the existing reset-to-`ready` (this is the `914c1e1d4`
  "deaf orchestrator" case; a reset, not a resume, is correct — no turn was in
  flight).
- **Pending-turn-start that never started** (`pendingTurnStart && activeTurnId ==
  null`): unchanged — reconcile still clears it (`thread.turn-start.fail`,
  D-notify Fix A). Distinct from the interrupted case precisely because
  `activeTurnId == null` (the turn never reached `turn.started`).

### Resume = a `requireIdle` `thread.turn.start` (control-notice)

For an interrupted thread, first reset its session to idle (`ready`,
`activeTurnId:null`) then dispatch a single `requireIdle` `thread.turn.start`:
- `origin:"control_notice"` message explaining the interruption and telling the
  agent to resume, or to proceed to its normal completion if it had already
  finished (mirrors `buildStallNudgeMessage`'s control-plane framing).
- `requireIdle:true` is the double-start guard (review must-fix #2). It defeats
  **every** competing startup turn-start producer, not just the `requireIdle`
  rails: if a non-idle-gated producer (gate traversal
  `WorkstreamDispatcher.ts:2380-2469`, or a liveness nudge
  `WorkstreamLivenessSweep.ts:478-520`) lands first, our resume defers (thread
  non-idle); if our resume lands first, the thread is busy and the other
  producer's plain turn-start folds in as a steer rather than starting a second
  turn. Either way exactly one turn runs.
- **No** `setInProgress`, **no** `reopen`.
- **Attention is cleared by the resume.** Any non-terminal turn-start clears
  stored attention in the decider (`decider.ts:902-930`) — so we must **not**
  resume a thread that is parked on a human. See the scope predicate: threads
  with raised attention (`needs_guidance`/`error`) or pending approvals/user
  input are excluded from resume and left to the existing reset-to-`ready`
  (their provider callback state does not survive recovery anyway —
  `stalePendingRequestDetail`, `ProviderCommandReactor.ts:180-225`).

### Owed-marker durability (differs by option)

Verified crash hole (review must-fix #1): on the resume, the reactor recovers the
provider session and `bindSessionToThread` emits `thread.session.set` with
`activeTurnId:null` **before** `sendTurn`/`turn.started`
(`ProviderCommandReactor.ts:735-766`, `:590-660`, `:1193-1214`); its
failure handler likewise clears `activeTurnId`. So `activeTurnId` is **not** a
durable owed-marker through the recovery window, and neither is a session-field
marker (the literal is rebuilt).

- **Option 1 (best-effort):** re-derive owed from the pre-recovery session
  (`activeTurnId != null && provider dead && not parked`) at boot. This closes
  the *pre-acceptance* window but NOT the *post-recovery-binding, pre-`turn.started`*
  window: a crash there clears `activeTurnId`, and the next boot sees a
  `ready`/pending-start thread and does not re-derive owed — that one thread
  needs manual restart. Accepted, bounded residual risk.
- **Option 2 (crash-safe):** the durable **pending-restart-continuation** set is
  the owed-marker; it is independent of the session literal, so
  `bindSessionToThread` cannot wipe it, and it is cleared only when a replacement
  `turn.started` is observed in `ProviderRuntimeIngestion`. Re-derive owed from
  that set on every boot.
- **Command id (both options):** boot-scoped (a **random per-boot UUID**, not a
  timestamp and not a deterministic cross-restart receipt id), so a crashed
  attempt is retried on the next boot rather than cross-boot-deduped, and the id
  is disjoint from every dispatcher-rail id namespace. Reconcile runs once per
  boot → at most one attempt per thread per boot (self-limiting; a turn that
  keeps failing retries at most once per deploy, human-visible).

### Robustness details
- **Per-thread error isolation (review must-fix #3):** wrap each thread's
  dispatch so any failure (including `OrchestrationCommandDeferredError`, should
  one arise) is caught per-thread, logged, and does **not** abort reconciliation
  of the remaining threads. Count only accepted continuations.
- **Missing binding / recovery failure:** handled by the reactor's existing
  failure path, which resets the session to `ready`/`error`
  (`ProviderCommandReactor.ts:320-380`). Reconcile does **not** (and cannot —
  recovery is async in the reactor) attempt its own fallback; it just dispatches
  the resume and lets the reactor own the failure transition.
- **Roots included (review recommendation):** parentage is orthogonal to whether
  a turn was interrupted; the same runtime predicate applies to roots, orchest
  parents, and leaf children. A plain human root chat mid-turn is the only mildly
  odd case (a control-notice appears), but resuming a dropped turn beats losing
  it.

## Implementation steps

1. In `reconcileStartupStaleSessionState` (`apps/server/src/loom/startup.ts`),
   inside the per-thread loop and after the `hasActiveProviderTurn` guard, branch
   on the interruption fact:
   - interrupted (`activeTurnId != null`, not parked) → dispatch the resume
     `thread.turn.start` (per-thread `catch`; on recovery/binding failure fall
     back to the reset `session.set`);
   - else keep the current reset/clear behaviour exactly as today.
   Add `Crypto` for the `messageId` and a small pure
   `buildRestartContinueMessage()` helper.
2. Extend the summary log (`startup reconciled stale session lifecycle state`)
   with a `continuationAttempts` count (acceptance is not proof of provider
   recovery/turn-start, so name it for what it measures) for deploy-log
   observability.
3. Keep everything in the fork-owned `loom/startup.ts`; no upstream-file edits.

## Testing

Reuse the existing "startup stale session reconciliation" harness in
`WorkstreamDispatcher.test.ts` (it already stubs engine + `ProviderService`).

1. **Interrupted parent with an already-reported child** (the production case the
   current suite omits): child-reported marker *present* so the delta rail is
   suppressed; assert reconcile still dispatches a `thread.turn.start` resume for
   the interrupted parent (boot-scoped command id, no `setInProgress`/`reopen`).
2. **Leaf worker resumes:** interrupted sub-thread, no children → gets a resume
   turn.
3. **Root thread resumes:** `parentThreadId === null`, interrupted → gets a
   resume turn.
4. **No resume without an active turn:** stuck-running `activeTurnId:null` →
   reset to `ready`, **no** turn.start (preserves `914c1e1d4`).
5. **Pending-start-only unchanged:** `pendingTurnStart && activeTurnId==null` →
   `thread.turn-start.fail`, no resume.
6. **Parked threads skipped:** pending approvals, and pending user input (two
   separate cases), with an active turn → not resumed; document how those
   requests recover after the provider dies.
7. **Terminal lane not auto-excluded:** a `done` thread with an interrupted
   follow-up turn (activeTurnId != null) is resumed; confirm lane untouched
   (attention is expected to clear, per `decider.ts:902-930`).
7a. **Attention-flagged / parked threads excluded:** a thread with raised
   attention (needs_guidance/error) or pending approvals/user input is reset to
   `ready` but NOT resumed (resuming would clear the human flag / hit stale
   provider callback state).
8. **Crash-window / repeated-startup (crash-safety; Option 2):** must include the
   window **after recovered-session binding (`activeTurnId:null`) and before
   `turn.started`** — the specific hole Option 1 leaves open.
   - reconcile → (simulated crash before acceptance) → reconcile again still
     dispatches a resume (session state unchanged, still owed);
   - reconcile → acceptance recorded but provider `turn.started` not observed →
     reconcile again still dispatches a resume (activeTurnId still non-null),
     and does **not** get cross-boot-deduped (distinct boot-scoped ids).
9. **No double-start (real engine):** a `requireIdle` child-delta wake and the
   reconcile resume cannot both start a turn — the child-wake defers while the
   resumed parent is busy, then delivers after completion.
10. **Provider integration:** `sendTurn` on a thread with no in-memory session
    recovers from the persisted binding + `resumeCursor` before running the
    resume turn (and the missing-binding fallback resets to `ready`).
11. **Guard preserved:** the existing "does not reset a thread that still has an
    active provider turn" test stays green (live provider ⇒ no dispatch).
12. Full `WorkstreamDispatcher` suite green; `vp check` / typecheck clean.

## Risks & mitigations

- **Double-start:** impossible — we never dispatch while a provider turn is live
  (`hasActiveProviderTurn` guard); a competing child-delta wake is `requireIdle`
  and defers while the resumed thread is busy.
- **Repeated-restart loss:** closed — continuation is re-derived from durable
  session state on every boot with boot-scoped (non-cross-dedup) ids; nothing is
  cleared until the turn actually completes.
- **Resuming a turn that had just finished** (server died between the last action
  and `turn.completed`): the control-notice tells the agent to proceed to its
  completion step, so it finalises rather than redoing work.
- **Retry of a turn that genuinely crashes the provider on resume:** bounded to
  one attempt per deploy (reconcile is one-shot per boot); human-visible via the
  `continuedTurns` log and the thread's repeated activity. Not an infinite loop.
- **Missing persisted binding:** falls back to reset-to-`ready` (un-stuck, parent
  still wake-able), never a hard failure.
- **No change to the delta/yield/gate/idle rails or their receipts;** the
  `5c4850352` over-firing fix is untouched.
