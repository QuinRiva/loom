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
1. **Add a distinct `error` status (user-approved 2026-06-25), server-set only.**
   Liveness (error → restart/escalate) ≠ readiness (blocked → wait); different
   interventions warrant different states. Add `error` to `ThreadStatus` AND to
   `workstreamGraph`'s terminal-for-wake set, but **NOT** to dependency-release
   (`workstreamDependencies`, done-only) — so `error` wakes the parent without
   releasing dependents. Because `thread.status.set` is a dispatchable client/MCP
   command, the surface must **reject `error` from non-server callers**
   (`workstream_set_status` + decider validation) so only the sweep can set it. Hard
   stop if `error` would alter *when a generation is considered complete* for
   existing `done`/`blocked`/`review` (escalate — mutates the dispatcher/board
   contract). Contract + board change.
2. **Two-stage delivery** (below): Stage 1 deterministic (no LLM); Stage 2 LLM.
3. **Investigator inputs** must include tool-call **args + results** and
   **work-product deltas** + **since-last-progress** deltas, not just totals.
4. **Completion authority is a separate cold-context judge** gated by a
   deterministic artifact check; it **preserves output** and distinguishes
   finished-quiet from stuck-quiet.
5. **Failure propagation: surface, don't cascade.** On `error`, the parent wakes via
   the existing terminal-status wake (`error` now in the terminal set); dependents
   are left visibly gated, never auto-cascade-blocked.
6. **"Forgot-to-finish" is a DISTINCT per-child wake trigger (user-approved), not the
   generation barrier and not a status mutation** (consult 2026-06-25, §1e). The
   generation-join wake (`selectJoinedGenerations`) fires only when *every* sibling
   in a `(parent, generation)` group is terminal — it cannot signal one quiet child
   while siblings still run, and forcing the child terminal to trip it would be a
   lie. The idle-wake reuses the proven delivery rail (deterministic `commandId` +
   receipt dedup + `requireIdle`) and `workstreamGraph` parent resolution, but with
   its own fire-condition and **without touching the child's status**.
7. **D-notify Stage 2 inspection tools are MERGED** (`workstream_list` /
   `workstream_read_thread` / `workstream_ask_thread`,
   `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`; shared
   `packages/shared/src/workstreamGraph.ts`). The investigator and completion judge
   build on these — no inlined graph walk, no "land first" dependency.

---

## Stage 1 — deterministic detection + `error` status + circuit breaker (NO LLM)
Delivers "no more dark stalls" with zero LLM cost. All detection is a periodic
server sweep over the read model, modelled on `ProviderSessionReaper`.

### 1a. `error` status (contract + projection + board)
- Add `error` to `ThreadStatus` (`packages/contracts/src/orchestration.ts`).
- Add `error` to `workstreamGraph`'s `TERMINAL_STATUSES` (`packages/shared/src/
  workstreamGraph.ts` ~133) + its tests, so the generation join and parent-wake
  treat it as terminal. Do **NOT** add it to `workstreamDependencies`
  (`areDependenciesSatisfied`, done-only) — `error` wakes but does not release.
- **Server-only writer.** `thread.status.set` is a dispatchable client/MCP command
  whose status is `ThreadStatus`; once `error` is a literal, the surface must
  **reject `error` from non-server callers** — guard `workstream_set_status`
  (`apps/server/src/mcp/WorkstreamSpawnHttp.ts` ~324) and the decider so only the
  liveness sweep can set it.
- **Reason via activity-append, not the status event.** Keep `ThreadStatusSetPayload`
  lean (no `reason` field); emit the human-readable detail as a deterministic
  `thread.activity.append` (tone `error`), mirroring the dispatcher's park marker.
- Update the web board `getEffectiveColumn` (`apps/web/src/components/
  WorkstreamPanel.tsx`) → its **own red `error` lane** (badge-only risks hiding a
  liveness failure under `blocked`).
- **Gating interaction:** `error` does NOT release dependents (only `done` does). It
  DOES wake the parent (terminal-status wake, see 1d).

### 1b. The liveness sweep (new reactor/service)
A periodic sweep (model on `ProviderSessionReaper`; consider sharing a sweep
substrate with provider-intent reconciliation — see that doc) that, per active
sub-thread, derives state from the read model + activity projection and classifies:
- **Dead session** — `session.status === "running"` / `activeTurnId != null` but no
  activity row newer than a threshold AND/OR provider session absent from the
  directory / `session.status === "error"`. → set `error` (reason: crashed).
- **Mid-turn stall** — `activeTurnId != null` but `now - max(activity.createdAt) >
  staleWindow`, **respecting a startup grace** (see 1c) so a long first tool call
  (clone/large read) can't trip it, and being conservative when no activity row
  exists yet (deltas don't create rows). → set `error` (reason: stalled) in Stage 1
  (Stage 2 routes this to the investigator instead of a blunt error).
- **Idle-but-non-terminal ("forgot to finish")** — `activeTurnId === null` &&
  `session.status ∈ {ready,stopped}` && status ∈ {planned,running}. → fire the
  **idle-wake trigger (§1e)**: wake the parent to investigate, leaving the child's
  status untouched. **Never set the child terminal here and never reap-as-failed
  with empty output.**

Derive "last activity at" via a new focused query (e.g. `maxActivityCreatedAt
ByThreadId`) rather than loading all rows. **Open: derive on-the-fly vs add a
persisted per-turn `lastActivityAt` column** — performance-first (a column +
index) may win; decide with the perf budget in mind.

### 1c. Cheap loop / no-progress detection
- **Loop detector** over recent activity rows: flag ≥3 consecutive identical
  `(tool, args)` tool-calls, two-call alternation, or a failing call retried without
  arg change. (Reference thresholds: AG2 window=10/repeat=3; AutoGPT 3-identical-
  failure hard stop, 6-empty-call abort.) **Caveat:** tool activity is persisted as a
  generic `itemType/title/detail/data` shape (`ProviderRuntimeIngestion.ts` ~558),
  not a normalized `(tool, args)` tuple — add a small normalization fn before
  claiming identical-args detection. Stage 1 action: mark `error`/escalate; Stage 2:
  route to investigator.
- **Startup grace.** Every detector above (mid-turn stall, no-progress, loop) only
  arms after a minimum turn age, so a slow first tool call is never mistaken for a
  stall. (Pulled into Stage 1 — it gates the deterministic detectors, not just the
  Stage 2 investigator.)
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
- **Terminal-for-wake vs final-liveness-state.** "Every sub-thread ends in a
  terminal state" means terminal **for parent-wake** = `{done, blocked, review,
  error}` (the `workstreamGraph` set). `done` additionally releases dependents;
  `blocked`/`review` are awaiting-human; `error` is the new failure state. No silent
  `planned`/`running` limbo.

### 1e. The idle-wake trigger ("forgot to finish") — distinct trigger, shared rail
The "forgot-to-finish" notification (decision 6) is a **second trigger feeding the
existing wake delivery rail**, NOT the generation barrier and NOT a status change.

**Why not the barrier.** `selectJoinedGenerations` (`workstreamGraph.ts` ~170)
returns a `(parent, generation)` group only when **every** member is terminal — a
whole-generation, fire-once "all my children finished" signal. A single quiet child
while its siblings still run is never selected; and marking it terminal to trip the
barrier would (a) be semantically false and (b) not even fire unless the *whole*
generation is terminal.

**Detection (in the sweep).** For each thread with `status ∈ {planned, running}`
whose session is idle (`activeTurnId === null` && `session.status ∈ {ready,
stopped}`), classify as idle-unreported. This is derivable from session state alone
(`ProviderSessionDirectory` + shell snapshot) — no activity-freshness query needed
(that's the mid-turn-stall signal). The only `workstreamGraph` primitive used is
**parent resolution** (`buildIndex` / `parentThreadId`), never `selectJoinedGenerations`.

**Delivery (mirror `deliverWake`, `WorkstreamDispatcher.ts` ~274).** Dispatch to the
child's parent:
```
thread.turn.start
  commandId: idleWakeCommandId(child.id, <episode key>)   // receipt-store dedup
  threadId:  parent.id
  message:   buildIdleWakeMessage(child)                   // points at read_thread/ask_thread
  requireIdle: true                                         // defers if parent busy; retried next pass
  // the child's status is NOT mutated
```
The message tells the parent: child `<role>` (`<id>`) went quiet without reporting
(idle, status still `running`), here is its `reportPath` (if any), investigate via
`workstream_read_thread`/`workstream_ask_thread`, then set its status (`done`/`error`)
or re-dispatch.

**Dedup / re-arm (the one genuinely new bit).** `wakeCommandId` is keyed
`(parent, generation)` and fires once forever; idle-wake instead keys the
`commandId` by **`(child.id, latestActivitySequence | current turnId)`** so each
distinct quiet *episode* notifies exactly once and a child that resumes then goes
quiet again re-arms — while an unacted-on idle child is not re-nagged every sweep.

**Reused for free:** receipt-store idempotency (`hasAcceptedReceipt`), the
`requireIdle` busy-parent deferral, and the wake **rate guard**
(`wakeRateGuardTrips` → `parkAndEscalate`) which protects a parent flooded by many
quiet children at once.

**Top-level threads (`parentThreadId === null`)** have no agent parent to wake →
surface via the board (`error` lane / activity append) as escalate-to-human, not a
turn injection.

**Stage 2 evolution.** The Stage 1 idle-wake injects a turn that makes the *parent
agent* investigate. In Stage 2 the **completion judge** (cold-context, §2b) consumes
the *same* detection signal and auto-decides done/not-done — so the raw "go look"
notification becomes an automated verdict: same trigger, smarter handler, no second
detection path.

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
  finding. (Reading the child's transcript/output uses the **merged**
  `workstream_read_thread` / `workstream_ask_thread` tools — no new inspection
  capability needed.)
- **Intervention ladder (never jump to kill):** (1) **nudge** — inject a corrective
  message; (2) **judge verdict** — classify `making-progress` (back off / raise
  threshold) / `stuck-loop` (kill+respawn or escalate) / `finished-didn't-signal`
  (run completion check) / `blocked-needs-human` (escalate); (3) **kill+respawn or
  escalate to human** only with cited no-progress evidence; (4) **hard-cap backstop**
  kill. **Bias false-positives to nudge, not kill** (small judges are lenient +
  inconsistent on close calls — use a capable judge for kill decisions). Give a
  **startup grace period** so a long first tool call (clone/large read) can't trip it.
- **Spawn mechanism (open):** is the investigator a workstream sub-thread / a pi
  subagent / an inline LLM call? Decide in-thread. It reads the target child via the
  merged `workstream_read_thread`/`workstream_ask_thread` tools (frozen-oracle fork
  for `ask`) — **prefer not** spawning a normal workstream child as the investigator,
  which would add orchestration state to the very graph being judged.

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
- **Last-activity signal (recommended: on-the-fly first):** a focused
  `max(createdAt)` query filtered by `(threadId, activeTurnId)` rather than a
  persisted `lastActivityAt` column up front; add a column/index only if query plans
  demand it. (Note: "forgot-to-finish" detection in §1e needs *session idleness*,
  not activity freshness — this signal is only for the mid-turn-stall case.)
- **All thresholds** (stale window, loop counts, failure cap, retry budget, soft-cap
  %, startup grace) — research numbers are general-purpose; **start generous, tune
  from real runs, document chosen values as assumptions.**
- **`error` board treatment** — own lane vs distinct badge.
- **Sweep substrate** — share one periodic read-model sweep with provider-intent
  startup reconciliation, or keep separate.
- **Investigator spawn mechanism** (sub-thread vs subagent vs inline LLM) — reading
  the child is **resolved**: the merged `workstream_read_thread`/`workstream_ask_thread`
  tools exist; build on them.
- **Completion judge model** + the deterministic artifact-gate contract per role
  (what "done evidence" means for a coder vs researcher vs reviewer).

## Implementation notes / consult log
- **consult [2026-06-25]** — *how should `error` + "forgot-to-finish" integrate with
  the merged D-notify Stage 2 terminal-status/wake model?*
  author: `.plans/phase-d-notify-stage2-design.md` [plan], session
  `687bc03d-a443-499b-868a-9f23872d4ec0` · manager confidence: **medium**.
  - **Resolved:** `error` as a **wake-but-don't-release** status is a clean fit for
    the existing two-predicate split (terminal-for-wake in `workstreamGraph`
    `{done,blocked,review}` vs done-only release in `workstreamDependencies`). Add
    `error` to the `workstreamGraph` terminal set; leave dependency-release untouched.
  - **Corrected (now reflected in §1b + §1e):** do **NOT** route
    "forgot-to-finish" through a terminal status. Marking a still-working child
    terminal is semantically false, misleads the board, and — because
    `selectJoinedGenerations` is a *generation barrier* (fires only when **every**
    member of a generation is terminal) — would not even wake the parent for a lone
    quiet child. Build the idle/"forgot-to-finish" nudge as a **distinct wake
    trigger that consumes `workstreamGraph` primitives** (not a parallel graph
    walker). "Single source of truth" constrains *structural traversal* to one
    module, not the *number of wake triggers* — so a second trigger reusing the
    module is consistent with the Stage 2 intent (the earlier "third walker" worry
    was a misread).
  - **Escalate to the user (per manager):** the new `error` `ThreadStatus` and the
    per-child idle-wake semantics are contract-level additions Stage 2 never decided
    (`ThreadStatus` in contracts + the board's `getEffectiveColumn`). Hard stop if
    `error` would alter *when a generation is considered complete* for existing
    `done`/`blocked`/`review` — that mutates the dispatcher/board contract.

## Out of scope
- Provider-intent startup reconciliation (separate signed doc) — though it likely
  shares the sweep substrate.
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
