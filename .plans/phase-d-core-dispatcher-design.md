---
manager_sessions:
  - id: e60766ea-eda2-46fa-9573-bc03cc432a2f
    role: plan
    authored_at: 2026-06-24T06:04:23.616Z
---

# Phase D-core: dependency-gated execution (the dispatcher)

**Status:** design, ready to implement. Scope is **D-core only** — execution
gating. Liveness/stall-detection and the completion judge (D-liveness) are
explicitly deferred to a follow-on (see "Deferred" below).

**Parent plan:** `.plans/phase-d-dispatcher.md` (full Phase D vision). This doc
resolves that plan's open decisions for the gating slice and is the contract a
fresh implementing thread should follow.

---

## The architectural frame (why this is the right change, not a workaround)

A workstream dependency graph **is** a dataflow DAG. In every dataflow system,
node *construction* and node *execution-scheduling* are separate phases: you
build the graph, then a scheduler runs each node when its inputs are ready.

Today those two concerns are **fused**: `workstream_spawn` dispatches
`thread.create` + `thread.turn.start` + `status.set(running)` in one handler, so
a node executes the instant it is created. That fusion was *correct* while the
dependency graph was **display-only** (Phases 1/A/B/C) — nothing gated execution,
so "create" and "start" being one atomic act cost nothing. The moment we want
real orchestration, immediate-execution-at-spawn becomes wrong.

**The correct upstream change is to introduce the missing scheduler (the
dispatcher) and make it the *sole* authority over when a node runs.** This is not
a patch on a mistake; it is the half of the model the display-only phases
deferred.

Consequences that show this is *less* surface area, not more:

- Spawn shrinks to a pure graph-mutation: `thread.create` **only**.
- There is exactly **one** place anything ever starts (the dispatcher), instead
  of two (spawn for no-dep threads, dispatcher for dependents). We delete a
  special case rather than add one.
- The "dependent thread starts before its deps are declared" race disappears
  **by construction**, because nothing auto-starts anywhere.

### Where `blockedBy` belongs

A node's **run-condition is intrinsic to the node**, so it belongs in the atomic
command that creates the node. Therefore `workstream_spawn` gains an optional
`blockedBy`. This is not a race-closing band-aid (the dispatcher-owns-starts
model already closed the race) — it is making the creation command *complete*.

`workstream_set_dependencies` is demoted to a **re-planning** operation on
not-yet-started nodes. Gating is a start-time decision; you cannot un-run a
thread, so setting deps on an already-started thread must be a no-op for
execution purposes (the edge is still recorded for display, but it never
retroactively gates a running thread).

### Why not declarative DAG submission

We deliberately keep **imperative incremental spawn** rather than a one-shot
`workstream_plan([{role, deps}…])`. An LLM orchestrator discovers work reactively
and spawns as it learns; forcing it to declare the whole DAG up front is rigid
and fights agent ergonomics. Incremental node-addition is the right granularity —
we only require that each addition is **atomic and complete** (carries its own
run-condition), which is exactly the spawn-carries-`blockedBy` change.

---

## What changes

### 1. Contract: `blockedBy` on the spawn command

- Add optional `blockedBy: ThreadId[]` to the `thread.create` orchestration
  command and to its `thread.created` event payload (`packages/contracts`).
  Same replace-set / self-reference-drop semantics already used by
  `thread.dependencies.set` in `decider.ts` (filter out `id === threadId`;
  cycles and dangling ids tolerated permissively).
- The projector already stores `blockedBy` on the thread read model
  (`ThreadStatus`/`blockedBy` decoding defaults exist). `thread.created` must
  seed it from the command instead of defaulting to `[]`.

### 2. Spawn endpoint + MCP tool: create-only, carry `blockedBy`

`apps/server/src/mcp/WorkstreamSpawnHttp.ts`, `handleWorkstreamSpawn`:

- Accept optional `blockedBy` in the request body (array of non-empty id
  strings; trim before branding, mirroring the dependencies handler's guard).
- Dispatch **only** `thread.create` (carrying `blockedBy`). **Remove** the
  `thread.turn.start` and `status.set(running)` dispatches — the dispatcher now
  owns the kick-off.
- The MCP tool surface (`workstream_spawn`) gains an optional `blockedBy`
  parameter; update its description so the orchestrator knows to pass deps at
  spawn time (spawn the dependency first to get its id, then spawn the dependent
  with `blockedBy: [thatId]`).

A freshly-created thread therefore sits at `planned` (the existing default
status) with no session and no started turn.

### 3. New `WorkstreamDispatcher` reactor (the scheduler)

New service + layer beside the existing reactors:

- `apps/server/src/orchestration/Services/WorkstreamDispatcher.ts` (tag +
  `start()` shape, mirroring `ProviderCommandReactor`'s shape; include a `drain`
  effect for tests).
- `apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts` (implementation).
- Register in `OrchestrationReactor.ts` (`makeOrchestrationReactor` +
  `.start()`), and wire the layer into the reactor layer composition that
  `serverRuntimeStartup.ts` provides under the reactor scope.

**Behaviour:**

- Subscribe to `orchestrationEngine.streamDomainEvents`; react to
  `thread.created`, `thread.dependencies-set`, and `thread.status-set`.
- On each relevant event, run a **"promote ready" pass**: for every sub-thread
  (a thread with a `parentThreadId`) that has **not yet been kicked off** and
  whose `blockedBy` are **all satisfied**, dispatch its deferred
  `thread.turn.start` followed by `status.set(running)`.
- Use the same drainable-worker pattern as `ProviderCommandReactor` so events
  are processed serially off a queue.

**"Deps satisfied" predicate (server-side mirror of the client rule):** a
dependency is satisfied iff the dependency thread's status is `done`. `review`
does **not** release (matches `getEffectiveColumn` in `WorkstreamPanel.tsx`,
which only treats `done` as terminal-complete for gating). Self-refs and dangling
ids (unknown threads) do not gate. Resolve dep threads via
`ProjectionSnapshotQuery`.

**"Not yet kicked off" predicate (idempotency):** a sub-thread is un-started iff
it has no provider session **and** no started turn (no user message / no
`turn.start` yet). The dispatcher promotes only un-started threads and
immediately dispatches `status.set(running)` in the same serialized pass.
Because `OrchestrationEngine` processes commands on a single serialized queue and
the dispatcher's own worker is serial, the `running` status lands before the next
promote pass — so a thread is never double-started. (Belt-and-suspenders: the
`ProviderCommandReactor` already dedups `turn.start` by command/event id.)

The kick-off message is the same child prompt currently built in
`WorkstreamSpawnHttp` (`childPrompt({role, purpose})`). Move that prompt builder
to a shared location both the spawn path and the dispatcher can import (e.g.
`@t3tools/shared` or a small server-side module) rather than duplicating it.

### 3b. (sibling) `modelSelection` + thinking on spawn — intrinsic node config

Today `WorkstreamSpawnHttp` copies `modelSelection: current.modelSelection`, so a
sub-thread inherits the parent's model wholesale, and the `workstream_spawn` tool
exposes no model/thinking parameter. Model and thinking level are **intrinsic
node config** — the same argument that puts `blockedBy` on the creation command
puts them there too. Add optional `modelSelection` (and a thinking level if the
driver supports it) to the spawn request + the `workstream_spawn` tool schema;
fall back to the parent's selection when omitted. This unblocks heterogeneous
graphs (e.g. a coder on a strong model + a reviewer on a different model) and is
the minimum needed to dogfood a real coder→reviewer gating run later. Keep it
additive and optional; do not change inheritance behaviour when the field is
absent.

### 4. `set_dependencies` becomes re-planning-only (no execution effect)

No code change is strictly required for correctness (the dispatcher only ever
*starts* un-started threads, so setting deps on a running thread can never
un-run it). But the dispatcher's promote pass keying off "un-started" already
gives the right semantics: adding deps to a not-yet-started thread re-gates it;
adding deps to a running thread records the edge for display but does not stop
it. Document this in the tool description so the behaviour is intentional, not
incidental.

---

## Resolved decisions (from `phase-d-dispatcher.md`)

1. **Gate at turn-start vs spawn-time** → turn-start gating; dispatcher owns
   **all** kick-offs; spawn is create-only and carries `blockedBy`.
2. **Add a `ready` status?** → **No (v1).** Gating keys off "has a
   session/started turn", not a status label; `ready` would be cosmetic. The
   board still reads correctly: an un-started thread with unmet deps shows
   `blocked` via the existing `getEffectiveColumn`, and shows `planned` once
   deps clear but before the dispatcher's pass lands (a sub-second window).
3. **Where the dispatcher lives** → new `WorkstreamDispatcher` reactor beside
   `ProviderCommandReactor`, reacting to created/status-set/dependencies-set.
4. **Heartbeat / stale detection** → **deferred (D-liveness).**
5. **Completion authority** → **cooperative-only.** The child marks itself
   `done` via `workstream_set_status` (already prompted to). No judge in v1.
6. **Failure cascade** → **deferred (D-liveness).** In D-core, a dependency that
   never reaches `done` simply leaves its dependents un-started (visibly
   `blocked`). No `error` status, no auto-cascade. This is acceptable because the
   human/orchestrator can see the stuck dependency on the board.
7. **Concurrency cap** → **no hard cap.** The dispatcher promotes every ready
   thread. Matches the stated preference to expose agent count rather than
   throttle it.

---

## Deferred to D-liveness (explicitly out of scope here)

- Heartbeat→status wiring (detecting a crashed/stalled sub-thread). The signal
  exists (`ProviderSessionDirectory.lastSeenAt`, used by `ProviderSessionReaper`)
  but the dangerous case — a thread stalled *mid-turn* — is exactly the case the
  reaper skips today (it leaves active-turn sessions alone). Needs a turn-level
  stall signal that does not exist yet.
- The `error` status decision (add a status vs reuse `blocked`+reason).
- Failure propagation / cascade-block semantics.
- Completion judge (`goal_mode` / Ralph-loop style output verification).

These are deferred because they depend on a schema decision (`error` status) and
a liveness signal that isn't built, and because D-core delivers the headline
acceptance criterion on its own.

---

## Acceptance (D-core done when)

- **Live run, not just unit tests:** spawn a coder, then spawn a reviewer with
  `blockedBy: [coderId]`. Observe: the coder runs immediately; the reviewer stays
  un-started (board shows `blocked`) until the coder reaches `done`; then the
  dispatcher auto-starts the reviewer.
- A no-dependency spawn still starts promptly (one event-loop hop after create).
- A thread is never double-started (verify the idempotency predicate holds under
  rapid status/deps events).
- `vp check` + `vp run typecheck` + the server suite green.

## Implementation notes / guardrails

- **Serialization is your friend:** all starts now route through one dispatcher
  worker + the single `OrchestrationEngine` command queue. Do not add a second
  start path. If you find yourself starting a turn from anywhere other than the
  dispatcher, stop — that reintroduces the race we just deleted.
- **No backwards-compat shim:** this is a prototype. Delete spawn's auto-start
  outright; do not keep it behind a flag "in case." The contract change to
  `thread.created` (seed `blockedBy`) replaces the old shape — do not emit both.
- **Mirror, don't re-invent, the "done" rule.** The client
  (`getEffectiveColumn`) is the existing source of truth for what counts as a
  satisfied dependency. Keep the server predicate identical (only `done`
  releases) so board display and execution gating never disagree.
