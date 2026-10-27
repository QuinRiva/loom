---
manager_sessions:
  - id: 587eb0f7-db32-4147-ab5e-d898a81a88b4
    role: plan
    authored_at: 2026-06-29T05:30:58.347Z
---

# Workstream State Model — Implementation Plan (rev 3)

Implements `.plans/workstream-state-model-design.md` (signed architecture).
Prototype, breaking change, no compat shims. Australian-English prose; wire
identifiers stay conventional.

Rev 2 folded in the first GPT‑5.5 review: an **axis-explicit agent tool surface**
(no flat enum, no artificial tool-count cap), **explicit attention-clearing
rules**, the **stop/resume path that actually delivers "no silent halt"**, and
promotion of the **idle-rail fix from out-of-scope to a declared dependency**.
Rev 3 folds in the re-review: a **full agent-facing prompt-surface sweep** (the
misuse is taught by copy, not just the tool schema), the backstop **writing the
attention flag** on a halted child (not merely waking), and **async**
no-silent-halt verification.

Sequenced contracts → server → web → tools → migration; each phase ends
compiling. The system is briefly behaviourally mixed mid-sequence (acceptable
per the prototype/no-coexistence rule).

---

## 0. The contract this delivers (what "done" means)

A thread carries **two stored fields**; the rest is derived:

- `planLane: "planned" | "ready" | "in_progress" | "done" | "cancelled"`
- `attention: ReadonlyArray<AttentionReason>` where
  `AttentionReason = "error" | "awaiting_approval" | "awaiting_input" | "awaiting_acceptance" | "needs_guidance"`
  — a set (a node may simultaneously await acceptance and be flagged error).
  Only the **non-derivable** reasons are stored (`error`,
  `awaiting_acceptance`, `needs_guidance`); `awaiting_approval`/`awaiting_input`
  are projected from open approval/input requests (§2), never stored.

Derived, never stored: runtime (`executing | starting | idle | none`) and
board-`blocked` (unmet deps).

**`awaiting_acceptance` means exactly:** *a human (or the parent acting for the
human) must accept this thread's output before its plan lane may reach `done` —
and therefore before its dependents release.* It is **not** "some reviewer thread
should look at this." A thread whose output flows to a separate reviewer thread
goes `done` (which releases that reviewer); it never raises
`awaiting_acceptance`.

Load-bearing, machine-checked (must be exact):
1. `planLane === "done"` is the *only* releaser of dependents + the only
   downstream-promote trigger.
2. start = dependency gate (`deps done`) **and** release gate (`lane === ready`).
3. attention is the sole notification/wake surface; the **no-silent-halt
   invariant** (§6) guarantees nothing that needs a human sits unflagged.
4. terminal-for-join = `done` | `cancelled` | (attention-raised **and** not
   executing).

---

## 1. Contracts (`packages/contracts/src/orchestration.ts`)

1. Replace `ThreadStatus` with `ThreadPlanLane`
   (`planned|ready|in_progress|done|cancelled`). `DEFAULT_THREAD_PLAN_LANE` =
   `planned` (schema decode-default for root/manual creation; spawns choose
   `ready` explicitly — §5).
2. Add `AttentionReason` literal + `ThreadAttention = Schema.Array(AttentionReason)`.
3. On `OrchestrationThread` + `OrchestrationThreadShell`: rename `status →
   planLane`; add `attention` (decode-default `[]`). Drop the `error`
   status-value comments.
4. Commands — replace `ThreadStatusSetCommand` with:
   - `thread.plan-lane.set` `{ planLane }`.
   - `thread.attention.raise` `{ reason }` / `thread.attention.clear`
     `{ reason }` (+ an internal clear-all used by the lifecycle rules in §7).
   Keep `ThreadDependenciesSetCommand` unchanged.
5. Events mirror: `thread.status-set` → `thread.plan-lane-set`; add
   `thread.attention-raised` / `thread.attention-cleared`. Update
   `OrchestrationEventType`, payloads, projector.
6. `ThreadTurnStartCommand.setRunning` → `setInProgress` (server-only; emits the
   lane-set atomically with the turn-start — §3/§6).
7. `ThreadCreatedPayload.status` → `planLane` (+ optional `attention`).

## 2. Shared graph (`packages/shared/src/workstreamGraph.ts`, `workstreamDependencies.ts`)

1. `areDependenciesSatisfied`: gate on `dep.planLane === "done"` (cancelled does
   **not** satisfy). One predicate keeps decider + dispatcher + board in sync.
2. `GraphThread`: `status` → `planLane`; add `attention` + a runtime-executing
   bit (pass session/turn through) so the terminal predicate can see
   "attention-raised and not executing".
3. `isTerminalStatus` → `isTerminalForJoin(node)`: `planLane ∈ {done, cancelled}`
   **or** (`attention.length > 0` **and** not executing). Update
   `selectJoinedGenerations`.
4. `graphViewFor` / `GraphViewNode`: expose `planLane` + `attention`.

## 3. Decider (`apps/server/src/orchestration/decider.ts`)

1. `thread.plan-lane.set` — authorisation chokepoint (design §8): reject
   `in_progress` unless commandId is `server:`-prefixed (control-plane only,
   mirrors today's `error` guard); accept `planned|ready|done|cancelled` from
   client/agent.
2. `thread.attention.raise` — reject `error` unless `server:`-prefixed; reject
   `awaiting_approval|awaiting_input` always (derived, never stored); accept
   `awaiting_acceptance|needs_guidance`.
3. `thread.turn.start` — dependency first-turn gate **unchanged** (deps-`done`).
   Release gate lives in the dispatcher (§4); a human directly messaging a held
   `planned` thread stays a deliberate allowed override.
4. `setInProgress`: emit `thread.plan-lane-set in_progress` atomically with the
   turn-start, **and** the attention-clear-all of §7 — but only when the target
   lane is non-terminal (**sticky `done`/`cancelled`**: a turn-start on a
   terminal thread changes neither lane nor attention; runtime alone reflects the
   activity).
5. `thread.turn.interrupt` — **human stop path** (§6): when the interrupt is
   client/human-issued (bare commandId, not `server:`), additionally emit
   `attention.raise needs_guidance`, so a human-stopped thread surfaces
   immediately rather than waiting out the idle grace. An orchestrator stop of a
   child goes through the workstream stop action (§5) which interrupts **without**
   raising (the orchestrator owns the resume).

## 4. Dispatcher (`apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts`)

1. `selectThreadsToDispatch`: add the release gate — only promote
   `planLane === "ready"` (with the existing un-started + deps-satisfied
   conditions). `planned` is a hold.
2. `promoteThread`: `setRunning` → `setInProgress`.
3. `classifyChildWake`: `error` is now an **attention** reason —
   `child.attention.includes("error")`; "forgot to finish" = non-terminal lane
   (`ready|in_progress`) + idle + session ready/stopped.
4. `parkAndEscalate` (runaway guard): `status.set blocked` →
   `attention.raise needs_guidance`; keep the two-write receipt idempotency.
5. Wake-message builders (`WorkstreamDispatcher.ts`): speak in plan-lane +
   attention terms; the parent instruction to "accept (`done`) or escalate" is
   unchanged in spirit. (Part of the §5a prompt-surface sweep.)
7. **Backstop raises the flag, not just the wake (review point 2).** When the
   idle/grace discriminator fires on a halted non-terminal child, the dispatcher
   emits an **idempotent** `thread.attention.raise needs_guidance` on that child
   (deterministic/`server:` command id, receipt-deduped like the existing wakes)
   **and** wakes the parent. The design requires a halted node to *carry* a
   raised flag (not only generate a notification), so the board shows it even if
   the wake is deferred/rate-limited. (Dispatcher's part of the §6 async half; it
   does not modify the idle rail itself — that is the §11 dependency.)
6. error→done "recovered" rail: recompute against the new shape (a child whose
   `error` attention cleared and reached `done`).

## 5. Agent tool surface — axis-explicit (`WorkstreamSpawnExtension.ts`, spawn endpoint)

The misuse lives at the agent boundary, so the surface must force an
**axis-first** decision ("am I advancing the plan, or do I need a human?") — no
flat enum, no artificial tool-count cap (we add the tools the capability needs).

1. **`workstream_set_lane`** (replaces `workstream_set_status`). Plan axis only,
   enum `done | cancelled | ready | planned`. Self or direct child. (`in_progress`
   is never agent-settable.)
2. **`workstream_request_attention`** (new). Attention axis only, `reason:
   awaiting_acceptance | needs_guidance`. Self or direct child. A single
   intra-axis enum is fine — the cross-axis decision was already made by choosing
   this tool. Description states the `awaiting_acceptance` semantics from §0
   verbatim (acceptance gate, *not* "a reviewer should look").
3. **`workstream_release`** (new). Parent/human action: flip a held subtree
   `planned → ready` (`subtreeOf` walk, `plan-lane.set ready` per `planned`
   node). The tool result and UI must state the **scope** (which nodes flipped)
   so an intentional mixed-hold isn't silently erased (review minor).
4. **`workstream_stop`** (new). Orchestrator stop of a direct child: interrupts
   the child's active turn and **leaves the lane `in_progress`** (no attention
   raise — the orchestrator owns the resume; the §6 backstop covers a forgotten
   resume).
5. `workstream_spawn`: add `staged?: boolean` (default `false`). `false` → create
   `ready` (runs when deps clear, current ergonomics); `true` → `planned` (held,
   for the review-the-graph flow). Update description/guidelines.
6. Child kick-off prompt (design §7) mapping, principle-based, no absolutes:
   `done` when finished (releases any reviewer/dependents); raise
   `awaiting_acceptance` only when a *human* must accept before completion; raise
   `needs_guidance` when you cannot proceed without a human; `cancel` when the
   work should be abandoned.

### 5a. Prompt-surface sweep (review point 1 — the misuse is taught by copy)

The agent learns the model from prose, not just the tool schema, so **every**
agent-facing surface naming the old status vocabulary must be rewritten to the
axis-explicit model. Sweep and update (grep for residual
`workstream_set_status` / `planned|running|blocked|review|done`-as-status):

- `apps/server/src/orchestration/workstreamChildPrompt.ts` (kick-off; currently
  teaches `review`/`blocked`).
- `WorkstreamDispatcher.ts` wake/idle messages (§4.5; currently say "in
  `review`", "status is still running").
- All tool `description`/`promptSnippet`/`promptGuidelines` in
  `WorkstreamSpawnExtension.ts`.

Load-bearing: stale copy re-teaches the exact stall the redesign removes.

**Outstanding (owned elsewhere — do NOT edit here):**
`PI_WORKSTREAM_SYSTEM_PROMPT` in `apps/server/src/provider/Drivers/PiDriver.ts`
is being completely rewritten in a separate thread. It currently teaches the old
status vocabulary, but this plan must not touch it to avoid a collision; the
separate rewrite owns aligning it to the axis-explicit model. Flagged here so the
sweep is known to be incomplete-by-design until that rewrite lands.

## 6. Stop / resume + the no-silent-halt invariant

Delivers the design §4 promise (the headline "you can trust the board" benefit),
enforced **both** ways:

1. **Synchronous, intent known.**
   - *Human stop* (UI interrupt, §3.5) → raise `needs_guidance` immediately.
   - *Orchestrator stop* (`workstream_stop`, §5.4) → leave `in_progress`, raise
     nothing (it owns the resume).
2. **Resume** = send a prompt (turn-start) → clears stored attention (§7) and
   sets `in_progress` (unless sticky terminal). Restart is "just send a prompt"
   per the design.
3. **No hidden fourth state.** We deliberately add **no** "pending-resume owner"
   field. The **idle grace window is the universal discriminator**: anything
   still `in_progress` + `idle` + no-resume-pending past the grace is surfaced
   regardless of who paused it. The synchronous human-stop raise only makes the
   common case *immediate* instead of grace-delayed.
4. **Declared dependency (was "out of scope").** The asynchronous half relies on
   the idle / "forgot to finish" rail firing reliably on a genuinely-halted node
   (the false-*negative* direction). This work therefore **depends on** the
   idle-rail false-positive fix handoff being landed/verified first; "nothing
   silently halts" is not delivered until that backstop is known-good. This plan
   does not modify the rail, but does not ship its guarantee without it.

## 7. Attention lifecycle — when each reason clears

Mostly automatic in the projector; plus an explicit `attention.clear` command for
human/parent dismissal.

- **`awaiting_acceptance`** clears on: plan → `done` (accepted) or `cancelled`;
  or on resume (a new turn-start = revision/feedback underway). Re-submitting
  re-raises it.
- **`needs_guidance`** clears on: resume (the human/parent acted); or plan →
  `done`/`cancelled`.
- **`error`** clears on: resume/re-dispatch (running again), or plan → `done`
  (the recovered rail), or explicit `attention.clear`.
- **`awaiting_approval` / `awaiting_input`** are projected from open
  approval/input requests — they appear when a request opens and vanish when it
  resolves; never raised/cleared by command.

Unifying rule (encode once): **a turn-start clears all stored attention** (a
running thread is, by definition, no longer halted-awaiting-a-human), and a
**plan-terminal transition (`done`/`cancelled`) clears all stored attention**.
The §6 backstop re-raises if it stalls again. Sticky terminal (§3.4) means a
turn-start on an already-`done`/`cancelled` thread clears nothing and changes no
lane.

## 8. Web (`apps/web/src/lib/workstreamPresentation.ts`, `lib/workstreamGraph.ts`, `components/WorkstreamPanel.tsx`)

1. `resolveBaseColumn` → three-axis projection. Plan columns
   `planned|ready|in_progress|done|cancelled`; `blocked` derived from unmet deps;
   attention rendered as an **overlay/badge** on the node's plan column, **not**
   its own mutually-exclusive column. UI must label `in_progress` as the plan
   phase, never "running" (avoid re-introducing the truth/label desync).
2. `rollupGraphState` → **three** rollups (plan / activity / attention), not one
   fused state. Attention rollup keeps the `attentionReasonOf` priority ladder;
   activity = any descendant executing; plan = all `done`/`cancelled` vs
   incomplete.
3. `workstreamPresentation.ts`: COLUMN_ORDER / labels / styles for the new plan
   lanes; attention-badge styles keyed by reason; the lane setter offers only the
   plan enum, with a separate affordance for request-attention + release.
4. `WorkstreamPanel.tsx`: attention badges/rows overlay; highest-priority
   attention at graph level; a **release** control for held subtrees that names
   its scope; a **stop** affordance.

## 9. Migration (best-effort, one-time; design §9)

Event-sourced: remap old `thread.status-set` in the **projector** (no dual-shape
output, no kept-for-compat fields):

| old status | projected new state |
|---|---|
| `planned` | `planLane: planned` |
| `running` | `planLane: in_progress` (runtime re-derives executing/idle) |
| `blocked` | unmet deps → no stored value (board-blocked); else `attention:[needs_guidance]` |
| `review` | `attention:[awaiting_acceptance]`, `planLane: in_progress` |
| `done` | `planLane: done` |
| `error` | `attention:[error]` |

**Visibility note (review minor):** old *unstarted* children that previously
auto-dispatched map to held `planned` and will **stop** until released. This is
acceptable under prototype tolerance, but the migration/board must make the held
state visible so users aren't surprised by stalled work.

## 10. Verification

- `vp run typecheck` + `vp check` green (AGENTS.md gate).
- Targeted unit checks on the **load-bearing** predicates only (high-risk):
  - `areDependenciesSatisfied`: `done` releases, `cancelled` does not.
  - `isTerminalForJoin`: done/cancelled/flagged-idle terminal; executing not.
  - dispatcher release gate: `planned` not promoted, `ready` promoted on deps
    clear; `setInProgress` writes the lane.
  - decider auth: agent `in_progress`/`error` rejected; `server:` accepted.
  - sticky terminal: turn-start on `done`/`cancelled` flips neither lane nor
    attention.
  - attention lifecycle: turn-start clears stored attention; `done`/`cancelled`
    clears it; human-interrupt raises `needs_guidance`.
- Canonical entrypoint: run server + web; spawn a child (defaults `ready` →
  runs); spawn a `staged` DAG (held `planned` → release → runs in dep order);
  raise `awaiting_acceptance` and confirm dependents stay gated until `done`;
  cancel a planned node and confirm dependents stay blocked; human-stop a running
  child and confirm it surfaces as `needs_guidance`.
  - **async** no-silent-halt (review point 3): a quiet `in_progress` child with
    no resume pending, left past the idle grace, gets `needs_guidance` raised on
    *the child* and surfaces/wakes the parent — verified separately from the
    synchronous human-interrupt case.

## 11. Dependencies & out of scope

- **Dependency:** idle / "forgot to finish" rail false-positive fix (separate
  handoff) — the §6 async backstop is only trustworthy once that lands; this work
  ships its no-silent-halt guarantee on top of it.
- **Out of scope (deferred — design §10):** dedicated "pending automated review"
  upstream marker; concurrency-cap queue semantics for `ready`.
</content>
