---
manager_sessions:
  - id: 587eb0f7-db32-4147-ab5e-d898a81a88b4
    role: architecture
    authored_at: 2026-06-29T04:25:41.592Z
---

# Workstream State Model — Three-Axis Design

Status: **agreed intent** (design session, grill-me). This document pins the
intended state model for T3 Code Workstream threads. A separate implementation
plan and coder follow; this is the contract they build to.

Supersedes the single-`status` model in `.plans/phase-c-status-and-dependencies.md`
(effective-display precedence, permissive transitions) and refines the dispatcher
contract in `.plans/phase-d-core-dispatcher-design.md`.

---

## 1. Problem — one field, three meanings

Today a single stored `ThreadStatus` (`planned | running | blocked | review |
done | error`) conflates three orthogonal things, which is the root cause of the
observed misuse:

- **Plan intent** — where a node sits in the intended design (a lane an
  agent/human chooses).
- **Runtime condition** — whether the agent loop is literally executing a turn
  right now.
- **Attention** — whether a human is needed, and why.

Because they share one writable enum, they desync and get misused:

- `review` is told to a `coder` whose output flows to a separate `reviewer`
  thread — conflating "a *reviewer thread* will process this" (automatic) with
  "a *human* must review this" (pause). `review` was never defined for the
  thread, so it was used meaninglessly.
- `blocked` conflates "waiting on upstream work" (resolves itself) with "paused
  awaiting a human" (won't resolve without action).
- A node can read `running` while nothing executes, or execute while labelled
  otherwise — "describes the plan" and "is the truth" silently disagree.
- A re-engaged `done` node (a follow-up question beyond original scope) has no
  way to show *activity* without appearing to revert to incomplete.

The runtime overlay already half-exists on the read path
(`resolveBaseColumn`/`getEffectiveColumn` derive `running` from live
session/turn signals; `getEffectiveColumn` derives `blocked` from unmet
dependencies). The bug is that these derived facts share one vocabulary with —
and are overwritten by — the agent-writable stored field.

---

## 2. The model — three independent axes

State is decomposed into **three axes**. The slogan *"status describes the plan;
runtime is the truth"* becomes literally true because an agent can only ever
write plan/attention intent, never the runtime or the control-plane-owned
values.

### Axis 1 — Plan lane (intent; the kanban board)

Mutually-exclusive waypoints describing the node's intended position in the
design. This is the only "lifecycle" axis and it is deliberately small:

```
planned  →  ready  →  in_progress  →  done
                                  ↘  cancelled   (terminal, from any pre-terminal lane)
```

| lane | meaning |
|---|---|
| `planned` | in the plan, **staged/held** — not released to run |
| `ready` | **released** — will run once dependencies clear |
| `in_progress` | the active phase of the plan is underway |
| `done` | accepted-complete — **releases dependents** |
| `cancelled` | abandoned (was planned, deliberately stopped) — terminal, does **not** release dependents |

Everything that used to muddy the lane moves off it:

| old `status` value | where it lives now |
|---|---|
| `planned` / `done` | plan lane (unchanged) |
| `running` | split: plan lane `in_progress` (control-plane-set) + runtime `executing` (derived) |
| `blocked` (on upstream) | **derived** from unmet dependencies — never stored |
| `review` | **attention** reason = *awaiting acceptance* (plan stays `in_progress`) |
| `blocked` (paused on a human) | **attention** reason = *needs guidance* |
| `error` | **attention** reason = *failed/stalled* (system-set) |
| pending approval / user-input | **attention** reasons (already derived today) |

### Axis 2 — Runtime / activity (the truth; derived, never stored as intent)

A pure projection over the session and latest turn — *is a turn turning right
now?* Never an agent-writable field.

| runtime | derivation |
|---|---|
| `executing` | `session.status === "running"` or `latestTurn.state === "running"` |
| `starting` | session connecting / spinning up (transient) |
| `idle` | session exists, no active turn |
| (none) | no session yet |

Activity **bubbles up**: a subtree with any `executing` descendant reads as
active *regardless of plan state*. A re-engaged `done` node is `done` (plan) +
`executing` (activity) at once.

The only stored "activity-ish" value is the plan lane `in_progress`, whose sole
writer is the control plane at kickoff. There is nothing to keep in sync, so it
cannot desync.

### Axis 3 — Attention (needs-a-human; the single notification surface)

A reason-tagged flag that can co-exist with any plan lane and bubbles up. This is
the **one** axis the notification/escalation machinery watches.

| attention reason | raised by |
|---|---|
| `error` (failed / stalled / looping) | **system** (liveness sweep) |
| `awaiting_approval` | **system** (open approval request) |
| `awaiting_input` | **system** (open user-input request) |
| `awaiting_acceptance` (review/sign-off) | **agent** ("my output needs sign-off") |
| `needs_guidance` (stuck) | **agent** ("I can't proceed without a human") |

Attention is a union of **derived** reasons (error, approval, input) and
**agent-raised** reasons (acceptance, guidance). When the underlying condition
clears (the human answers, the plan advances to `done`/`cancelled`, the agent
resumes), the flag clears.

> Names above are the proposed wire contract. Australian-English prose is used
> throughout this document; identifiers stay conventional.

---

## 3. Two orthogonal start-gates

A thread starts executing only when **both** gates clear — and the two gates are
the same "waiting on work vs waiting on a human" split, applied at the launch
boundary:

1. **Dependency gate** (automatic, structural): every `blockedBy` thread is
   `done`. Waiting here ⇒ board shows **blocked (on upstream)**; resolves itself.
2. **Release gate** (intentional): plan lane is `ready`, not `planned`. Waiting
   here ⇒ the plan is **staged but unreleased**; needs a human/agent to release.

The dispatcher promotes when `lane == ready && deps satisfied && not started`
(today's trigger is just deps-satisfied — this adds the release gate).

`planned` is therefore a genuine **hold**: even with deps clear it sits still
until released. This enables laying out a whole DAG for human review of the work
breakdown *before any tokens are spent*.

**Release semantics:** releasing flips the whole subtree `planned → ready` at
once; dependency edges still sequence execution layer by layer.

**Spawn default:** a plain `workstream_spawn` defaults to `ready` (current
"spawn → it runs" ergonomics preserved). **Staging is the explicit opt-in**
(spawn `planned`), used for the review-the-graph flow.

---

## 4. Start / stop / re-engage

### Start ("execution drives status")

The dispatcher remains the **sole start authority**. On kickoff it sends the
first-turn prompt **and** sets plan lane → `in_progress` in one atomic
transaction (today's `setRunning`, retargeted). Runtime → `executing` follows
from the turn running. The act of starting writes `in_progress`; an agent never
does.

### `done` is sticky (activity ≠ plan)

A started turn pulls a **pre-completion** lane (`ready`, or `in_progress` with a
raised attention flag) to `in_progress`. It does **not** revert a terminal lane:

- Re-engaging a `done` node (out-of-scope follow-up) lights the **activity** axis
  only; the lane stays `done`. Reopening the plan requires an *explicit* lane
  change — implicit un-completing is the bug being removed.
- Answering an `awaiting_acceptance` thread (sending revision feedback) resumes
  it → `in_progress`; accepting it → `done`.

### Stop, and the "no silent halt" invariant

There is a mechanic to **stop** a running agent (`thread.turn.interrupt`
interrupts the active turn; runtime → `idle`). Restarting is typically just
sending a prompt (which progresses the next turn → `executing`).

**Invariant:** *a node that is not executing, will not be auto-resumed, and is
not plan-terminal (`done`/`cancelled`) must carry a raised attention flag.*
Nothing that needs a human may sit silently halted. The discriminator is "is
there an owner who will resume it?" — the same resolves-itself-vs-needs-a-human
split.

Enforcement is **both** (decision: option c):

- **Synchronous, where intent is known.** A **human** stop with no auto-resumer
  defaults to raising `needs_guidance` (so it surfaces immediately). An
  **orchestrator** pause-to-rethink (it owns the restart) leaves the lane
  `in_progress` and raises nothing.
- **Asynchronous backstop.** The existing idle / "forgot to finish" rail catches
  anything that ends up `in_progress` + `idle` + no resume pending (a dropped
  orchestrator, a crash mid-pause) and surfaces/wakes after its grace window.

> The idle-rail's false-positive fix is a **separate handoff**; this design only
> relies on the rail as the backstop and does not change it.

---

## 5. Graph rollups — three projections, not one fused state

The subtree rollup (`rollupGraphState`) must carry **separate** projections so a
graph can be e.g. "plan: done" and "activity: active" simultaneously (the
re-engaged-`done` case):

- **Plan rollup** — is all intended work `done` (vs in-progress / cancelled)?
- **Activity rollup** — is anything `executing`?
- **Attention rollup** — does anything need a human, and the highest-priority
  reason (the existing `attentionReasonOf` priority ladder)?

Today these are fused ("active dominates"), which is the source of the
node-vs-graph confusion.

---

## 6. Load-bearing vs descriptive

**Load-bearing** (a few, machine-checked — must be strict):

- `done` (plan) — the *only* thing that releases dependents and lets the
  dispatcher promote the next thread.
- the `blockedBy` dependency gate + the `ready`/`planned` release gate — the two
  start-gates.
- attention `error` and the agent-raised reasons — drive notification / parent
  wakes (the attention axis is the notification surface).
- terminal-ness for the generation join barrier: `done`, `cancelled`, and any
  attention-flagged-and-idle node ("won't progress without a human").

**Descriptive** (most of it — generous, human-facing):

- `planned` vs `ready` distinction beyond the release gate, `in_progress` as a
  label, the runtime axis, and the board projections (`blocked`, `ready`,
  "working between turns"). These describe; they don't gate.

---

## 7. Tool surface (agent-facing)

The agent no longer sets one flat enum mixing plan and attention. It does two
conceptually distinct things:

- **Advance the plan** — small set: `done`, `cancel`, and `ready`/`planned` for
  staging. (`in_progress` is never agent-settable.)
- **Raise attention** — with a reason: `awaiting_acceptance` (review) or
  `needs_guidance` (stuck).

The child kick-off prompt's guidance ("`done` when finished, `review` if your
output must be reviewed, `blocked` if you cannot proceed") maps to: `done` =
advance plan; `review` = raise `awaiting_acceptance`; `blocked` = raise
`needs_guidance`. Prompt text stays principle-based, not absolute directives.

---

## 8. Authorisation

Extends the existing "own thread / own direct children" precedent:

| write | allowed actor |
|---|---|
| plan `ready` / `planned` (staging), `done`, `cancel` | the thread itself, or its **direct parent** |
| raise attention `awaiting_acceptance` / `needs_guidance` | the thread itself (or its direct parent) |
| plan `in_progress` | **control plane only** (set by starting) |
| attention `error` | **system only** (liveness) |
| attention `awaiting_approval` / `awaiting_input` | **system only** (derived from open requests) |
| start / stop / release-subtree | the thread's **direct parent** orchestrator, or a human |

Agents drive *plan + agent-raised attention* on themselves and their direct
children; the system exclusively owns `in_progress`, `error`, and the derived
attention reasons. The decider remains the single chokepoint that enforces these
(as it already does for the server-only `error` guard).

---

## 9. Migration — clean break, no compat shim

Prototype: a **breaking change** with a one-time best-effort remap, no
dual-shape coexistence, no "kept for backward compatibility" fields.

Best-effort remap of persisted threads:

| old `status` | new state |
|---|---|
| `planned` | plan `planned` (note: new default is `ready` for fresh spawns; see §3) |
| `running` | plan `in_progress` (runtime re-derives `executing`/`idle`) |
| `blocked` | derive: unmet deps → board-blocked (no stored value); else attention `needs_guidance` |
| `review` | attention `awaiting_acceptance`, plan `in_progress` |
| `done` | plan `done` |
| `error` | attention `error` |

Oddities in old/in-flight threads during transition are acceptable.

---

## 10. Open questions (deferred deliberately)

- **Pending *automated* review marker.** Dropped for now. "Awaiting automated
  review" is already visible on the board as the **reviewer thread's own
  activity** (the upstream node is `done`; the reviewer node is live). Re-add a
  dedicated upstream marker only if a concrete need arises.
- **Stored `ready` under a concurrency cap.** `ready` is stored now to serve the
  staging/hold use case. If a concurrency cap is later added, `ready` also gains
  a queue-backpressure meaning ("eligible, awaiting a start slot") — no model
  change anticipated, just richer board semantics.
- **Final attention vocabulary / UI surfacing** of reasons (single badge vs
  per-reason) — settle during implementation against the existing
  `attentionReasonOf` ladder.
</content>
</invoke>
