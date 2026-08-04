---
manager_sessions:
  - id: 95006bd4-74ef-4bba-9710-ac805038e07f
    role: plan
    authored_at: 2026-08-04T04:30:48.830Z
---

# Workstream liveness: stateless rung ladder + derived attention (adopted design)

**Status:** adopted — v2, rewritten after adversarial review rejected v1's condition-registry design.
**Review:** `/home/Carl/.t3/cockpit/userdata/workstream-reports/950f2ef9-dfa2-4969-b63c-238cce2a9943.md` (verdict: reject registry; endorse Alternatives B+C with a hold-contract correction). v1 (registry design) is in git history.
**Evidence:** investigation against production DB; live wedge = child `b147b085-…` / parent `2d3c8532-…`, 26+ h unbriefed with no flag anywhere.

---

## 1. The four defects being fixed (corrected root cause, per review)

1. **Lying observability** — sweep callers ignore whether engine-deduped commands wrote anything. `actionedCount` increments and `workstream.liveness.brief-needed` logs unconditionally on dispatch *success*, and a receipt-deduped no-op is a success (`WorkstreamLivenessSweep.ts:886-902`; engine early-return `OrchestrationEngine.ts:175-182`). One wedged node pins `actionedCount > 0` forever, suppressing the only "all quiet" signal (`:1205`).
2. **Delivery receipt mistaken for condition state** — brief-needed notification (dispatcher wake `WorkstreamDispatcher.ts:3070`, liveness backstop `WorkstreamLivenessSweep.ts:884-905`) fires at most once per episode key `briefNeededSinceMs`, which is derived from stable transitions and therefore **cannot advance while the node just sits there**. Once both receipts are spent, no agent and no human is ever told again.
3. **Contradictory deferral contract** — the system sanctions leaving a node unbriefed ("Leave a node unbriefed only if you intend it not to run yet", `WorkstreamDispatcher.ts:~1106` / brief-needed message) while alarming on exactly that state, and gives the agent no sanctioned transition that exits the state. In the live incident the parent *deliberately* deferred the brief pending user review — correctly — and had no way to say so. The correct move existed: `workstream_set_lane planned` exits the predicate.
4. **§7 erases stored projections** — every turn-start clears ALL stored attention (`decider.ts:1389-1404`), so a backstop flag on a parent is wiped by the next unrelated wake (observed: `fyi-digest` wake erased the live flag 6 minutes after it was raised). All 8 brief-needed escalations ever raised were cleared as turn-start collateral; zero were deliberate dismissals.

Constraint from the operator: a human will never write a brief for a sub-thread. The parent agent is the only realistic actor for brief-needed; human escalation must be late and actionable (prompt the parent / cancel the node).

## 2. Design principles

- **Open/closed condition state = the existing pure predicate** (`isBriefNeeded`, evaluated over the shell snapshot). No new durable state.
- **Delivery state = existing command receipts**, read via `makeReceiptDedupedDelivery` (`receiptDedup.ts`).
- **Re-arming = wall-clock rung arithmetic.** Deterministic across restarts; each rung id is at-most-once; time advancing mints the next id.
- **Human surface = derived attention**, recomputed at the outward read boundary (the `awaiting_input` pattern, `ProjectionSnapshotQuery.ts:546-572`). Nothing stored, so §7 has nothing to erase; self-clears the moment the predicate goes false.
- **Resolution is derived**: predicate false ⇒ condition gone, no rung fires, no attention derived. Legitimate exits: brief attached; `set_lane planned` (deliberate deferral); cancel. A genuine recurrence advances one of the stamps feeding `briefNeededSinceMs` (a brief cannot be unset; every other route out and back in bumps `planLaneSince` / `dependenciesSince` / a dep stamp), so it gets a fresh rung namespace — verified during review.

## 3. Changes

### 3.1 Phase 1 — honest delivery reporting (whole sweep)

- Construct `makeReceiptDedupedDelivery` in `makeWorkstreamLivenessSweep` (backed by `OrchestrationCommandReceiptRepository`, exactly as `WorkstreamDispatcher.ts:1823-1846`).
- **Every deterministic dispatch goes through `deliverOnce` individually** — one `deliverOnce` per command id, never one wrapper around a multi-command helper (review must-fix 5: wrapping `markDead`'s attention+activity pair under the first command's id creates a partial-failure hole where the second write fails but the first receipt blocks the retry forever).
- Log lines and `actionedCount` gate on outcome `"delivered"` only. `already-handled` and `deferred` are silent (or debug-level).
- Applies to all six action helpers: `markDead`, `nudgeStall`, `escalateStall`, `escalateStuckLaunch`, `adviseProgressLoop`, `appendStuckLaunchActivity` (and the brief-needed branch until 3.2 deletes it).

### 3.2 Brief-needed rung ladder (dispatcher rail becomes the only notifier)

- **Marker id:** `server:workstream-brief-needed:<childId>:<sinceMs>:<rung>`. Rung 0 replaces today's un-runged marker (`briefNeededCommandId`, `WorkstreamDispatcher.ts:1071`).
- **Rung schedule (pure function `rungFor(ageMs)`):** rung 0 due immediately (preserve today's immediate wake — do not introduce a delay); rung 1 at ≥ 1 h; rung 2 at ≥ 6 h; rung n≥3 at ≥ (n−2)·24 h — i.e. daily thereafter, indefinitely while the condition holds. Only the **current** (highest due) rung is dispatched — after downtime, skipped rungs are not backfilled.
- **Batching preserved** (`wakeBriefNeededChildren`): one idle-gated wake per parent naming every child owing a rung this pass; wake-before-markers ordering retained; each included child gets its own rung marker after delivery; wake-rate budget charged once per delivered batch, exactly as today. The known wake-before-marker crash window (duplicate wake possible, never a lost one) is retained and documented — same trade the rail already makes.
- **Message contract fix** (`buildBriefNeededMessage`): the notice must name the three sanctioned moves — **(a)** attach the brief now (`workstream_brief`); **(b)** if deliberately deferring, `workstream_set_lane planned` to hold the node (this exits the brief-needed state and stops these notices; release it later); **(c)** cancel it if no longer wanted. Rungs ≥ 1 should also say how long the node has been stalled.
- **Delete the liveness sweep's brief-needed backstop** (`raiseBriefNeededBackstop`, its branch at `:884-905`, `briefNeededBackstopDue`, `briefNeededGraceMs`, and their tests): superseded by rungs (agent) + derived attention (human).

### 3.3 Derived parent attention at 24 h (human surface)

- At the outward shell read boundary, a parent's `attention` unions `needs_guidance` when **any** of its children satisfies `isBriefNeeded ∧ age ≥ 24 h` (age from `briefNeededSinceMs`).
- Graph-aware, so it cannot live in the per-row SQL: compute in the snapshot/shell assembly where `threadsById` exists, following the discipline documented at `ProjectionSnapshotQuery.ts:546-572` — **outward-facing reads only**; the engine's command read model is deliberately not unioned, and internal dispatcher/sweep checks that read stored attention must keep reading stored attention. Respect the same edge posture as `awaiting_input` for terminal/archived threads.
- Persistent through §7 by construction (recomputed, not stored); self-clears on brief/hold/cancel.
- No UI change: existing `needs_guidance` surfacing carries it.

### 3.4 Dead rail: daily wall-clock buckets (latent fix, review must-fix 4)

- `markDead` command ids gain a day bucket: `server:workstream-liveness:error:<threadId>:<dayBucket>` (and the `error-reason` activity id likewise), `dayBucket = floor(now / 86_400_000)`. A still-dead, still-unflagged thread re-raises at most daily instead of never-again.
- **Also re-arm the parent wake:** the dispatcher pins a dead child's wake episode to the constant `"error"` for the child's lifetime (`WorkstreamDispatcher.ts:1554-1555`) — change to `error:<dayBucket>` so the parent re-hears about a still-dead child at most daily. Without this, fixing `markDead` alone still leaves the only realistic actor silent.
- Accepted asymmetry: a flag cleared within the same bucket re-raises only at the next bucket (≤ 24 h delay) — acceptable for a rail with no live victim; tighten only on evidence.

## 4. Testing

- Pure: `rungFor` boundaries (0/1h/6h/24h/48h; exactly-at-threshold), marker-id determinism, day-bucket arithmetic, message contract (three moves present), derived-attention predicate incl. 24 h boundary and terminal-parent edge.
- Behavioural (existing test files): update `WorkstreamDispatcher.test.ts` brief-needed rail tests for rung markers + batching; replace `WorkstreamLivenessSweep.test.ts` `briefNeededBackstopDue` suite with deletion; `deliverOnce` gating — a sweep pass over an already-notified unchanged state yields `actionedCount` 0 and no info logs; markDead re-raise in a new bucket after a cleared flag.
- Gate: `vp check` and `vp run typecheck` must pass.

## 5. Out of scope

- §7 semantics unchanged (derived attention makes it moot for these rails).
- No new UI surface; no registry/table; `failureCounts` and the other sweep maps stay in-memory (restart bias is conservative and correct — review Q2).
- Other rails (stall ladder, stuck-launch, progress-loop) keep their episode keys — they advance with their subjects (safe); they receive only the Phase-1 honest-reporting change.
