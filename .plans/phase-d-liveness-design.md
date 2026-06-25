---
manager_sessions:
  - id: e60766ea-eda2-46fa-9573-bc03cc432a2f
    role: plan
    authored_at: 2026-06-25T05:33:05.828Z
---

# Phase D-liveness: detecting dead / stalled / stuck sub-threads

**Status:** design, ready to implement in stages. Self-contained for a fresh
thread (the authoring thread's context is exhausted). Builds on:
- `.plans/phase-d-core-dispatcher-design.md` (merged) — dependency-gated execution.
- `.plans/phase-d-notify-design.md` (merged) — upward completion propagation
  (parent auto-wake). **D-liveness reuses its parent-wake to surface failures.**
- `.plans/provider-intent-startup-reconciliation-design.md` (separate, deferred)
  — crash-recovery of un-executed turns; **related sweep substrate** (see below).
- `.plans/phase-d-dispatcher.md` — the original Phase D vision (liveness was always
  the deferred third pillar).

This is the **third and largest pillar of Phase D**: D-core made dependencies
*gate*, D-notify made completion *propagate up*, D-liveness makes the control
plane *notice when an agent is dead, stalled, or spinning* instead of letting it
silently pin its dependents/parent forever.

---

## Why this exists (deferred from every prior doc)
Completion today is **cooperative self-report** (a child calls
`workstream_set_status done/blocked/review`). Nothing handles the cases where the
agent **can't or doesn't** report:
- **Dead session** — the provider process died without emitting `session.exited`,
  so the read-model `session.status` is stuck `running` with `activeTurnId` set.
- **Mid-turn stall** — the agent is alive-but-wedged inside an open turn (API
  returning, no progress). Invisible today: `ProviderSessionReaper` unconditionally
  **skips active-turn sessions**.
- **Stuck loop** — the agent keeps acting but makes no progress (re-reading the
  same file, retrying a failing call). D-notify's interim **rate-based
  park-and-escalate** is a stub for exactly this.
- **Finished-but-didn't-signal** — the agent completed but never called
  `set_status done`, so it erroneously blocks its parent/dependents forever.

## Signal reality (codebase recon — cite when implementing)
All on `main` post-merge. **These facts are load-bearing; verify before coding.**
- **Status is fully server-writable.** Writers of `thread.status.set`: cooperative
  `workstream_set_status` (`apps/server/src/mcp/WorkstreamSpawnHttp.ts` ~231);
  server `running` atomic with kickoff (`decider.ts` ~793, `command.setRunning`);
  server `blocked` on park (`WorkstreamDispatcher.ts` ~395). **No path sets
  `error` on a dead thread, but nothing structural prevents a sweep from doing so.**
- **`lastSeenAt` is NOT a mid-turn heartbeat.** `ProviderSessionDirectory.lastSeenAt`
  (~139) is set only inside `upsert`, whose callers are session-lifecycle/turn-START
  (`ProviderService.ts` upsert sites ~255/683/853/1033). `processRuntimeEvent` does
  **not** upsert — so `lastSeenAt` does not advance during a long active turn.
- **The reaper gap.** `ProviderSessionReaper.ts` (~62–69) sweeps every 5 min, stops
  sessions idle >30 min, but **skips any session with `activeTurnId != null`** — so
  a stalled mid-turn agent is never reaped.
- **Mid-turn activity IS derivable.** Every tool/task/token event during a turn is
  persisted as a `ProjectionThreadActivity` row with `createdAt` + `sequence`
  (`ProjectionThreadActivities.ts` ~23, written by `ProjectionPipeline.ts` ~1173).
  A per-turn "last activity at" = `max(createdAt)` over the thread's activity rows
  for the active turn. (Assistant/reasoning *deltas* stream transiently and do NOT
  create rows — the reliable freshest signal is tool/task/token-usage rows.) There
  is **no** dedicated "latest activity" query today (only `listByThreadId`).
- **Turn-end ≡ `session.activeTurnId === null`** (set when `turn.completed`/
  `session.exited` → `thread.session.set`, `ProviderRuntimeIngestion.ts` ~1496).
  Turn elapsed time from `ProjectionTurn` (`startedAt`/`completedAt`,
  `ProjectionTurns.ts` ~42).
- **Investigator stats are derivable but not pre-aggregated** — tool-call count &
  recent history, token usage, elapsed time all live in the activity + turn
  projections as raw rows, queryable via `listByThreadId`.
- **"Forgot to finish" is detectable** from the read model: `session.activeTurnId
  === null` AND `session.status ∈ {ready, stopped}` AND thread `status ∈ {planned,
  running}` (terminal = `done`; treat `review`/`blocked` as awaiting-human, not
  forgot).
- **Model the new sweep on `ProviderSessionReaper`** — it already wires
  `ProjectionSnapshotQuery` + `ProviderSessionDirectory`, the two data sources a
  liveness sweep needs.

## Architecture: a three-layer liveness stack (from external research)
Production systems (Temporal, Hermes, LangGraph, AutoGPT, K8s probes) converge on:
1. **Cheap deterministic signals, always-on** — loop/repetition detection, a
   no-progress (activity-derived heartbeat) window, hard caps (wall-clock / tokens
   / iterations). These fire **first** and gate the expensive layer.
2. **An expensive LLM investigator, invoked only when a cheap signal trips** —
   disambiguates slow-real-work vs stuck-loop vs finished-quiet (selective
   invocation, not per-turn polling — cited ~30% token saving).
3. **Completion authority outside the doing agent** + per-task **circuit breakers**
   that fail fast and **surface to the parent** (don't silently cascade).

Two framing principles that should govern the design:
- **Liveness vs readiness (K8s):** "broken → restart/escalate" (a crash/stall) is a
  different intervention from "waiting → don't route, don't kill" (blocked on
  deps/human). This is the conceptual basis for a distinct `error` status.
- **Heartbeat = actual work activity, not a side timer.** Hermes' documented
  footgun was reading a board field instead of runtime activity, falsely reclaiming
  busy long workers. Our activity-derived signal avoids this by construction.
- **Counters can't separate slow-work from spinning.** The single biggest
  reliability lever (per research) is making any judge read **work-product deltas**
  (git diff, test/build exit codes) and **tool-call args+results**, not just
  counts/names.

## Resolved decisions
1. **Add a distinct `error` status** (server-set), NOT reuse `blocked`+reason.
   Rationale: liveness (error → restart/escalate) ≠ readiness (blocked → wait).
   Different interventions warrant different states. Contract + board change.
2. **Two-stage delivery** (below): Stage 1 deterministic (no LLM); Stage 2 LLM.
3. **Investigator inputs** must include tool-call **args + results** and
   **work-product deltas** + **since-last-progress** deltas, not just totals.
4. **Completion authority is a separate cold-context judge** gated by a
   deterministic artifact check; it **preserves output** and distinguishes
   finished-quiet from stuck-quiet.
5. **Failure propagation: surface, don't cascade** — reuse D-notify's parent-wake.

---

## Stage 1 — deterministic detection + `error` status + circuit breaker (NO LLM)
Delivers "no more dark stalls" with zero LLM cost. All detection is a periodic
server sweep over the read model, modelled on `ProviderSessionReaper`.

### 1a. `error` status (contract + projection + board)
- Add `error` to `ThreadStatus` (`packages/contracts/src/orchestration.ts`).
- Server-set via `thread.status.set` from the liveness sweep (same path the
  dispatcher already uses for `running`/`blocked`). The status payload should carry
  a **reason** (reuse/extend the existing activity-append for the human-readable
  detail; do not bloat the status event).
- Update the web board `getEffectiveColumn` (`apps/web/src/components/
  WorkstreamPanel.tsx`) + column set to render `error` (its own lane or a clearly
  distinct treatment from `blocked`). Decide lane vs badge in-thread.
- **Gating interaction:** `error` does NOT release dependents (only `done` does —
  same as `blocked`). It DOES wake the parent (see 1d).

### 1b. The liveness sweep (new reactor/service)
A periodic sweep (model on `ProviderSessionReaper`; consider sharing a sweep
substrate with provider-intent reconciliation — see that doc) that, per active
sub-thread, derives state from the read model + activity projection and classifies:
- **Dead session** — `session.status === "running"` / `activeTurnId != null` but no
  activity row newer than a threshold AND/OR provider session absent from the
  directory / `session.status === "error"`. → set `error` (reason: crashed).
- **Mid-turn stall** — `activeTurnId != null` but `now - max(activity.createdAt) >
  staleWindow`. → set `error` (reason: stalled) in Stage 1 (Stage 2 routes this to
  the investigator instead of a blunt error).
- **Idle-but-non-terminal ("forgot to finish")** — `activeTurnId === null` &&
  `session.status ∈ {ready,stopped}` && status ∈ {planned,running}. → Stage 1: wake
  the parent with a "child went quiet without reporting" note (Stage 2: run the
  completion judge). **Never reap-as-failed with empty output.**

Derive "last activity at" via a new focused query (e.g. `maxActivityCreatedAt
ByThreadId`) rather than loading all rows. **Open: derive on-the-fly vs add a
persisted per-turn `lastActivityAt` column** — performance-first (a column +
index) may win; decide with the perf budget in mind.

### 1c. Cheap loop / no-progress detection
- **Loop detector** over recent activity rows: flag ≥3 consecutive identical
  `(tool, args)` tool-calls, two-call alternation, or a failing call retried without
  arg change. (Reference thresholds: AG2 window=10/repeat=3; AutoGPT 3-identical-
  failure hard stop, 6-empty-call abort.) Stage 1 action: mark `error`/escalate;
  Stage 2: route to investigator.
- **No-progress window** = the mid-turn-stall signal (1b). Start **generous** and
  tune from real runs (research: under-tuning caused false reclaims; Hermes
  `stale_timeout=0` default meant it never fired — **enable by default, generous
  threshold**, document the chosen value as an assumption).

### 1d. Circuit breaker + failure propagation
- **Per-sub-thread consecutive-failure cap** (start = 3) and **bounded retries**
  (3–5, exponential backoff: 0.5s base ×2, 30s cap). Beyond the cap → `error`,
  stop retrying (sustained failure isn't transient).
- **Every sub-thread ends in exactly one terminal state** (`done`/`blocked`/`error`)
  — no silent limbo.
- **Surface, don't cascade:** on `error`, **wake the parent** (reuse the D-notify
  wake — it already wakes on terminal states incl. `blocked`; add `error`) with the
  reason, and leave dependents un-started (visibly gated), not silently pending. The
  parent/human decides retry/reassign/abort. Do NOT auto-cascade-block.

### Stage 1 acceptance
- A child whose provider process is killed mid-turn is detected by the sweep and
  set `error` (not left `running` forever); its parent is woken with the reason.
- A child that finishes but never marks `done` is detected (idle + non-terminal)
  and its parent is woken — output preserved, never reaped-as-failed-empty.
- A child stuck in an identical-tool-call loop is detected and escalated.
- Repeated-failure child trips the cap → `error`, no infinite retry.
- `error` shows distinctly on the board; does not release dependents; the D-notify
  wake fires on `error`.
- `vp check` + `vp run typecheck` + server suite green.

---

## Stage 2 — LLM investigator + completion judge (builds on Stage 1 signals)

### 2a. Investigator agent (replaces D-notify's interim park stub)
- **Trigger only on a Stage-1 cheap-signal trip** (loop detected / no-progress
  window / soft budget breach at ~70% of a hard cap) — never poll per turn.
- **Inputs** (the reliability levers): the goal + acceptance criteria; elapsed time
  AND time-since-last-progress; tool-call count AND calls-since-last-progress AND
  unique-vs-repeated ratio; token usage AND tokens-since-last-progress; **last N
  tool calls with args AND results/errors**; **work-product delta** (git diff /
  changed files / lines / test & build exit codes); and the loop-detector's specific
  finding. (Reading the child's transcript/output benefits from the **D-notify
  Stage 2 `read_child`** tool — cross-dependency, flag it.)
- **Intervention ladder (never jump to kill):** (1) **nudge** — inject a corrective
  message; (2) **judge verdict** — classify `making-progress` (back off / raise
  threshold) / `stuck-loop` (kill+respawn or escalate) / `finished-didn't-signal`
  (run completion check) / `blocked-needs-human` (escalate); (3) **kill+respawn or
  escalate to human** only with cited no-progress evidence; (4) **hard-cap backstop**
  kill. **Bias false-positives to nudge, not kill** (small judges are lenient +
  inconsistent on close calls — use a capable judge for kill decisions). Give a
  **startup grace period** so a long first tool call (clone/large read) can't trip it.
- **Spawn mechanism (open):** is the investigator a workstream sub-thread / a pi
  subagent / an inline LLM call? Decide in-thread; it must read the target child's
  state (ties to D-notify Stage 2).

### 2b. Completion judge ("forgot to finish")
- **Detect completion mid-stream** (terminal assistant turn, no pending tool calls)
  — not only on process exit.
- On **subtree quiescence** (this child idle + its children idle + queues empty + no
  in-flight tool calls), run a **separate cold-context judge** (fresh model, not the
  doing agent — cf. Claude `/goal` Haiku, Managed-Agents cold grader) that checks
  output against the goal/acceptance criteria → done / not-done+reason.
- **Gate load-bearing "done" with a deterministic artifact check** (build/test exit
  code, file exists) — the child may only *propose* completion; a protected check
  grants it. Defeats premature-victory + oracle-gaming.
- If criteria met → set `done` (releases dependents) + **preserve output**. If not
  met but no progress → escalate per the ladder. **Never reap a finished child as
  `failed` with empty output** (the worst observed bug).

### Stage 2 acceptance
- A genuinely-slow child (steady git diffs) is NOT killed; a same-file-re-read loop
  IS caught and nudged, then escalated if it persists.
- A child that finished but forgot `done` is judged complete, marked `done`, output
  preserved, dependents released — without human intervention.
- The investigator replaces the rate-based park stub; the stub is removed (no
  coexistence).
- `vp check` + `vp run typecheck` + server suite green.

---

## Open decisions for the implementing thread
- **Last-activity signal:** on-the-fly `max(createdAt)` query vs a persisted per-turn
  `lastActivityAt` column (+ index). Performance-first leans column; decide with the
  perf budget.
- **All thresholds** (stale window, loop counts, failure cap, retry budget, soft-cap
  %, startup grace) — research numbers are general-purpose; **start generous, tune
  from real runs, document chosen values as assumptions.**
- **`error` board treatment** — own lane vs distinct badge.
- **Sweep substrate** — share one periodic read-model sweep with provider-intent
  startup reconciliation, or keep separate.
- **Investigator spawn mechanism** + how it reads the child (ties to D-notify Stage 2
  `read_child`/`ask_child`, not yet built — may need to land those first or inline a
  minimal read).
- **Completion judge model** + the deterministic artifact-gate contract per role
  (what "done evidence" means for a coder vs researcher vs reviewer).

## Out of scope
- Provider-intent startup reconciliation (separate signed doc) — though it likely
  shares the sweep substrate.
- D-notify Stage 2 tools (`read_child`/`ask_child`) — needed by the investigator;
  sequence accordingly.
- Cross-environment / cross-project orchestration; per-child worktree isolation.

## References
- Codebase: `ProviderSessionReaper.ts` (sweep model + the active-turn skip gap),
  `ProviderSessionDirectory.ts` (`lastSeenAt`), `ProviderRuntimeIngestion.ts`
  (turn lifecycle + per-event flow), `ProjectionThreadActivities.ts` /
  `ProjectionTurns.ts` (derivable stats), `WorkstreamDispatcher.ts` (the wake +
  the park stub to replace), `decider.ts` (`setRunning`, status writes),
  `packages/contracts/src/orchestration.ts` (`ThreadStatus`, `OrchestrationSession`).
- External patterns: Temporal heartbeat+timeout; Hermes kanban (15min claim TTL /
  1hr backstop / `stale_timeout=0` footgun / goal_mode judge); AG2 LoopDetector
  (window10/repeat3); AutoGPT circuit breaker (3-identical / 6-empty); LangGraph
  recursion_limit; Claude Code `/goal` (cold Haiku judge); geodocs Agent Circuit
  Breaker Spec (3-state, per-dependency, retries-inside, fallback); K8s
  liveness/readiness/startup probes. (Key reliability findings: judge must read
  work-product deltas + tool args/results; completion authority outside the doer +
  deterministic gate; surface failures to the orchestrator, don't strand.)
