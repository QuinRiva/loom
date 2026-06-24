---
manager_sessions:
  - id: e60766ea-eda2-46fa-9573-bc03cc432a2f
    role: plan
    authored_at: 2026-06-24T11:10:25.561Z
---

# Phase D-notify: completion propagation + parent↔child communication

**Status:** design, ready to implement after sign-off. Builds on D-core
(`.plans/phase-d-core-dispatcher-design.md`, merged to `main` as `706c046`) and
the Phase D vision (`.plans/phase-d-dispatcher.md`). Self-contained for a fresh
implementing thread.

---

## The gap

D-core made completion propagate **downward**: when a child reaches `done`, the
`WorkstreamDispatcher` promotes downstream dependents. But completion never
propagates **upward**. A parent that fans out a researcher ends its own turn,
the researcher finishes, and **nothing re-wakes the parent** — the result sits
unconsumed until a human intervenes. There is no notification/subscription path
to the parent today (verified: `AgentAwarenessRelay` only publishes activity to
the remote cloud relay; the only uses of `parentThreadId` are spawn-auth and the
dependency predicate).

## Core insight

A parent thread is an LLM agent — it only acts when a **turn** is started on it.
So "notifying" the parent is not a passive subscription; it resolves to
**injecting a new turn into the parent thread** carrying the child's result.
This is the symmetric twin of D-core's dispatcher:

- **D-core:** child becomes runnable (deps `done`) → inject a turn into the **child**.
- **D-notify:** child reaches a terminal state → inject a turn into the **parent**.

Same primitive (react to `thread.status-set` → start a turn), pointed upward.

---

## Resolved decisions

### 1. Join, generation-scoped (not stream, not "all children ever")
Wake the parent **once a spawn *batch* has no remaining non-terminal children** (a
join / barrier), not once per child completion. Matches the fan-out→gather
pattern, avoids fragmented premature action, and structurally prevents fan-out
amplification (N children → 1 wake, not N).

**Batch = a generation.** "All direct children" is wrong: a long-running child
from earlier work would starve a later quick child's wake (the join would never
be satisfied). Instead, children spawned in the **same parent turn** form a
batch, **generation-stamped at `thread.create`** (a `spawnGeneration` on the
child). The parent is woken when every child of a given generation is terminal.
Generation membership is durable (on the thread record), so it survives restart
and is recomputable from the read model. Exclude archived/deleted children.

"Non-terminal" = a child whose status is not in {`done`, `blocked`, `review`}.

### 2. Wake triggers: `done`, `blocked`, `review`
- **`done`** — child succeeded; parent consumes the result.
- **`blocked`** — child is stuck/failed; parent is informed so it can intervene
  (this is also the upward path failure-propagation will later use).
- **`review`** — child explicitly requests assessment. **The parent is the
  first-pass reviewer and the human-escalation gatekeeper.** Rationale: the
  parent has substantially more business-logic and use-case context than a
  coding child, so it is better placed to judge what a human would actually want
  reviewed, and to make decisions on the human's behalf where appropriate. On a
  `review` wake the parent reviews and either **accepts** (sets the child to
  `done`, releasing any downstream dependents) or **escalates to the human** when
  it judges human review is genuinely warranted. This gives `review` a real
  agent-world job rather than being a passive board lane.

### 3. Defer-until-idle injection (the one piece of real machinery)
A turn injected into a **busy** thread is NOT queued or rejected by T3 — it is
forwarded immediately. For pi/ACP that means a second concurrent `prompt` that
clobbers `activeTurnId` and can mis-attribute the original turn's runtime events
(verified: `PiDriver.sendTurn` has no busy guard; only Claude has an in-process
*steer* queue, which is the wrong semantic here — we do not want to merge the
wake into the parent's in-flight thought).

Therefore the wake path must gate on parent idleness. **Idle must NOT be keyed on
`activeTurnId === null` alone** — there is a window where a turn has been
requested/sent (`ProviderCommandReactor` forks `sendTurn` after
`thread.turn-start-requested`) but `activeTurnId` is still null until the runtime
`turn.started` lands. Define:

> **parent idle ≝ no pending turn-start AND session not `running` AND no active
> turn.**

The pending-turn-start signal already exists in the projection
(`ProjectionPipeline`) and must be exposed via `ProjectionSnapshotQuery`.

- **Parent idle** (the common case — a parent usually ends its turn after
  spawning) — inject the wake turn directly.
- **Parent busy** — defer, and re-evaluate when the parent's turn ends. **There
  is no "turn-completion" domain event on the dispatcher's stream**
  (`streamDomainEvents` carries orchestration events; a completed turn surfaces
  as a durable **`thread.session-set` with `activeTurnId: null`**). So the drain
  trigger is: react to `thread.session-set` where the parent leaves `running` /
  goes idle, then re-evaluate eligible wakes.

### 4. Idempotency + durability: eligibility is recomputable, delivery is once
Wake state must survive restart (`streamDomainEvents` is live PubSub, no replay —
the same reason D-core needed a startup promote pass). Therefore:

- **Wake-eligibility is recomputed from the persisted read model**, not held only
  in memory. "Which parents have a fully-terminal generation not yet woken" is a
  pure function of durable thread state (statuses + `spawnGeneration` + a durable
  per-generation "woken" marker). Any in-memory pending queue is a *cache* of this
  recomputable set, never the source of truth.
- **Startup reconciliation pass** (mirroring D-core): on start, scan for parents
  with a terminal joined generation and no delivered wake, and deliver.
- **Delivery is idempotent** via a durable per-(parent, generation) woken marker
  and/or a **deterministic wake command id** (e.g. derived from
  parent+generation), so a restart between "terminal" and "injected", or between
  "injected" and "marked", cannot drop or duplicate the wake.
- **Fingerprint precisely:** the delivered unit is a (parent, generation). A
  parent accepting a `review` child (`review`→`done`) must NOT re-wake for that
  same generation. If a child recovers from a terminal state (e.g.
  `blocked`→`running`→`done`) the generation is simply re-evaluated; it does not
  manufacture a second wake for an already-woken generation.

### 5. Runaway guard: minimal rate-based park-and-escalate (interim)
Idempotency + generation-join + strictly one-directional waking (child→parent
only) structurally prevent the echo loop, fan-out amplification, and mutual-wake
loops. The only remaining loop is the **open-ended spawn-loop** (a parent that
re-spawns on every wake and never terminates) — an unbounded *sequential spend*
loop that join/idempotency do NOT bound.

A hard count cap is the wrong instrument: a legitimate long-running ("overnight")
job racks up many *real* wake-generations and would trip it. The signal that
distinguishes real work from a spin-loop is **cadence, not count** — real work
has slow generations (minutes of child work each); a spin-loop fires many wakes
in a short window. So the interim guard is **rate-based**:

- Park-and-escalate when wake-generations for a parent exceed a threshold within
  a **short rolling window** (tight looping), with a deliberately **high absolute
  backstop** as a secondary catch. Defaults set **generously** and documented as
  tunable — a slow-cadence overnight job must never trip them.
- On trip: do not kill. Append an activity, set the parent `blocked` with a
  reason, and **escalate to the human** (this is a stub for the future
  investigator agent — same trigger point, escalates to a human instead of to a
  judge agent).

The stronger future solution (D-liveness) replaces this stub with a **heartbeat
threshold that triggers an investigator/judge agent** to assess real-work-vs
-stuck-loop — strictly stronger than Hermes, whose heartbeat only catches
*silence* (a spinning-but-heartbeating worker slips past it).

### 6. Ask-child = frozen oracle
The parent-to-child question tool consults a **read-only frozen snapshot** of the
child's session (the consult_manager pattern), NOT a live resume. Side-effect
-free: no risk of re-activating a `done` child and having it wander off.

---

## The communication layer (three pieces)

Keep the parent's context lean: it gets a **summary + a pointer**, and pulls
detail only on demand.

1. **Completion artifact (child→parent) — markdown file.** The child records a
   deliberate markdown handoff of what it wants to communicate back — not its
   whole transcript — via a `workstream_report(markdown)` tool. **Stored as a
   markdown file, not in the DB/event store** (large markdown in an event-sourced
   store bloats every replay; a file is directly human-viewable). The file lives
   in a **stable per-thread artifact directory keyed by `threadId`** (alongside
   durable session data — NOT in the ephemeral worktree, which gets reclaimed).
   A **tiny path pointer is recorded on the thread record** for association
   (board "report ready", wake reference) — pointer in the model, content on
   disk. `workstream_read_child` reads the file server-side. The parent's wake
   message carries a **compact bounded summary + the reference**, never the full
   report text. Auth: a child may upsert only its own report; a parent may read
   reports of children it directly parents. If a child reaches a terminal status
   with no report, the wake still fires (status is the trigger; the report is
   best-effort context).
2. **Read-child tool (parent→child, passive).** `workstream_read_child(threadId)`
   returns the child's report/output/summary on demand, so the parent never hunts
   for a `.jsonl`. Authorization: a parent may read threads it directly parents.
3. **Ask-child tool (parent→child, active, frozen).** Extends the
   consult_manager oracle pattern: the parent poses a clarifying question and an
   oracle answers from a read-only frozen snapshot of the child's session.
   Authorization: same parent-of relationship.

### The parent wake message contract
The injected user-role turn tells the parent: which child/children completed
(role + id + terminal status), each one's report (or a reference + one-line
summary), and the instruction to **review the results, decide what (if anything)
needs human escalation vs. what it can act on or accept on the human's behalf,
and continue orchestrating** (including accepting `review` children → `done`).

---

## Where it lives
Extend `WorkstreamDispatcher` (it already reacts to `thread.status-set` and owns
turn injection; "wake a parent whose children are all done" is conceptually the
same "promote a now-runnable thread" pass pointed upward), OR a sibling
`ParentNotificationReactor` if the wake-message + artifact logic grows heavy.
It must additionally react to **`thread.session-set`** (the parent going idle) to
drain deferred wakes (decision 3). Either way, use **one serial drainable-worker**
for the status/session events (a second worker reintroduces race windows), run a
startup reconciliation pass (decision 4), and route all injected turns through
`OrchestrationEngine` as today.

---

## Suggested two-stage implementation
- **Stage 1 (headline):** the generation-scoped join-wake + defer-until-idle gate
  + recomputable/idempotent delivery + startup reconciliation + the rate-based
  park-and-escalate guard + the `workstream_report` markdown artifact + the
  parent wake message. Delivers "the parent automatically picks up its
  researcher's result."
- **Stage 2 (enrichment):** `workstream_read_child` + the frozen-oracle
  `workstream_ask_child` tools.

Stage 1 is independently shippable and is the acceptance-defining behavior.

## Out of scope / deferred
- The **investigator/judge** version of the runaway guard → future heartbeat +
  investigator-judge (D-liveness). The interim rate-based park-and-escalate stub
  (decision 5) ships in Stage 1.
- Live-resume ask-child (frozen oracle only here).
- Per-child worktree isolation (Carl: shared worktree acceptable for now).

## Acceptance (Stage 1)
- **Live pi run:** a parent spawns a researcher and ends its turn; the researcher
  works, calls `workstream_report(...)`, and marks itself `done`; the parent is
  **automatically woken** with the report and resumes — no human intervention.
- A `review` child wakes the parent; the parent reviews and either flips it to
  `done` or escalates.
- Parent-busy case: a wake fired while the parent is mid-turn is delivered
  **after** its current turn ends, exactly once (no `activeTurnId` clobber, no
  duplicate wake).
- **Restart survival:** a server restart between a child going terminal and the
  wake injection still results in exactly one wake (startup reconciliation), and
  a restart after injection does not duplicate it (durable idempotent marker).
- Generation scoping: a parent with an unrelated long-running child still gets
  woken when a *later* spawn generation completes.
- The rate-based park-and-escalate trips on a tight spin-loop but NOT on a
  slow-cadence long-running job.
- `vp check` + `vp run typecheck` + server suite green.
