---
manager_sessions:
  - id: 86c158b7-7422-42ee-abb0-c9065deaa1ec
    role: plan
    authored_at: 2026-06-23T15:27:00.982Z
---

# Phase C: status state machine + dependency edges

**Status:** plan (authored autonomously during an overnight work block; decisions
are reasonable defaults, all on a throwaway branch and revertible).

## Goal
Give sub-threads an **explicit status** and **dependency edges** so the
Workstream Board columns and Graph reflect true workflow state and "waits-on"
relationships, instead of only signals derived from session/turn state.

## Why this is split into C1 + C2
- **C1** = the data model + projection + UI (board columns + graph edges driven
  by real status/deps + manual controls). Self-contained; human-testable.
- **C2** = agent-facing setters (the orchestrator/sub-thread agent can move its
  own status and declare dependencies), reusing Feature A's credential+endpoint
  +extension pattern.
Each chunk is implemented then independently reviewed.

---

## Documented design decisions (made autonomously)

### D1 — `status` is an explicit, authoritative field; display falls back to derived
- Add `status: ThreadStatus` to the thread. Enum: `planned | running | blocked |
  review | done` (matches the five Board columns from the mockup; no separate
  `error` state — runtime errors stay a session-signal overlay, not a column).
- Default on create = `planned` (additive, replay-safe, decode-default).
- **Effective display status** (used by Board column + Graph node colour),
  precedence — documented so C1 and C2 agree:
  1. explicit `status` ∈ {review, done} → use it (human/agent intent wins)
  2. else if any `blockedBy` dep is not `done` → **blocked** (deps gate display)
  3. else if explicit `status` == blocked → blocked
  4. else if explicit `status` == running OR a live running session/turn → running
  5. else → planned
  Rationale: keeps the board "live" for spawned children (which start a turn)
  without coupling status to turn lifecycle, while letting explicit review/done
  and unmet dependencies take precedence.
- **Transitions are NOT hard-validated** (permissive). `thread.status.set`
  accepts any target. Rationale: prototype; a rejected transition could wedge an
  autonomous agent. The "state machine" is the state set + the UI/agent
  affordances that guide the normal flow (planned→running→review→done, with
  blocked and review→running bounce). Revisit hard validation later if needed.

### D2 — dependency edges via `blockedBy: ThreadId[]`
- Add `blockedBy: ReadonlyArray<ThreadId>` to the thread, default `[]`.
- Set via `thread.dependencies.set { threadId, blockedBy }` with **replace-set**
  semantics (simplest, idempotent). No add/remove deltas.
- Graph renders `blockedBy` as "waits-on" edges (distinct style) **in addition
  to** the existing parent→child lineage edges.
- Self/cycle guard: ignore a thread listing itself; the graph renderer must
  tolerate cycles (no infinite layout). Dangling ids (dep points at a
  deleted/unknown thread) are simply not drawn.

### D3 — who can set status/deps
- **C1:** manual controls in the Workstream panel (per-card status control +
  a dependency editor) so the feature is fully testable without a live model.
- **C2:** extend Feature A's `workstream` capability so the in-thread agent can
  call `workstream_set_status` and `workstream_set_dependencies` for threads it
  parents (or itself). Same credential scoping as A — the endpoint authorises by
  the credential's scoped threadId; an agent may set status on **its own thread
  or its own children**, nothing else. (Authorisation rule documented here so the
  reviewer can check it.)

---

## C1 — data model + projection + UI

### Contracts (`packages/contracts/src/orchestration.ts`)
- `ThreadStatus = Literals("planned","running","blocked","review","done")`.
- Add `status` (decode-default `"planned"`) and `blockedBy`
  (decode-default `[]`) to `ThreadCreatedPayload` and the projection read-model
  thread schemas (`OrchestrationThread`, `OrchestrationThreadShell`) — additive,
  replay-safe, mirroring how `parentThreadId`/`role`/`goal` were added in Phase 1.
- New commands + events (add to the appropriate command/event unions —
  `ClientOrchestrationCommand`/`DispatchableClientOrchestrationCommand` ~683/704,
  and the event union):
  - `thread.status.set` → `ThreadStatusSet { threadId, status, updatedAt }`
  - `thread.dependencies.set` → `ThreadDependenciesSet { threadId, blockedBy, updatedAt }`

### Server
- `decider.ts`: emit the two new events from the two new commands.
- `projector.ts`: carry `status`/`blockedBy` on `thread.created`; apply on the
  two new events. (No turn-lifecycle auto-transition — display fallback handles
  "running"; keep the projector dumb.)
- Persistence: migration **036** adds `status TEXT NOT NULL DEFAULT 'planned'`
  and `blocked_by TEXT NOT NULL DEFAULT '[]'` (JSON array) to the projection
  thread table; update `ProjectionThreads` Service schema + Layer insert/upsert/
  select and `ProjectionSnapshotQuery` select+decode (same sites Phase 1 touched).
- `ws.ts` normalizer: pass the two new commands through.

### Web (`apps/web/src/components/WorkstreamPanel.tsx` + `store.ts`/`types.ts`)
- Carry `status`/`blockedBy` on the web thread/summary types and apply on
  meta/status/deps events in the store reducer + client-runtime reducer.
- Replace `getThreadStatusColumn` with the **D1 effective-status precedence**
  (using explicit status + blockedBy + derived running signal).
- Board: column from effective status.
- Graph: draw `blockedBy` edges (distinct style) plus existing lineage.
- Manual controls: a per-card status control (cycle/select planned→…→done) that
  dispatches `thread.status.set`; a dependency editor (pick other sub-threads of
  the same parent) that dispatches `thread.dependencies.set`.

### C1 acceptance
- Spawn 2+ sub-threads; set one `blockedBy` the other → blocked one shows in the
  **Blocked** column and a "waits-on" edge appears in the Graph.
- Move a card through planned→running→review→done via the manual control; column
  + node colour update; survives reload (persisted).
- Old threads (no status/blocked_by columns pre-migration) load as
  planned/`[]`. `vp run typecheck` + `vp check` pass.

## C2 — agent-facing setters
- Reuse A's `WorkstreamSpawnHttp`/registry/extension pattern: add endpoints
  `workstream/status` and `workstream/dependencies`, two new agent tools, and
  extend the `workstream` capability.
- Authorisation: the credential's scoped `threadId` may set status/deps on
  **itself or a thread it parents** (verify parent linkage via projection);
  otherwise 403.
- C2 acceptance: typecheck + `vp check` pass; the generated extension loads;
  authorisation rejects cross-thread writes. (Live model→tool path may be
  unverifiable headlessly — document what was checked.)

## Out of scope (later)
- A real dispatcher (auto-promote ready / auto-block / heartbeat / circuit
  breaker) — Phase D. C only models state + edges + manual/agent setters; it does
  not *act* on dependencies beyond display.

---
## Post-implementation note (from C2 review)
`workstream_set_dependencies` authorises only the *mutated* threadId (own-or-child
per D3). The `blockedBy` **targets** are intentionally NOT authorisation-checked:
declaring a "waits-on" edge does not mutate the referenced thread (edges are
display-only / advisory), so cross-referencing another thread is benign. This is
by design, not a gap.
