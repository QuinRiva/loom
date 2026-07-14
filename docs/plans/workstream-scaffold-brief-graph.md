---
manager_sessions:
  - id: a8479403-bfea-495b-abb2-346fed1e2b16
    role: plan
    authored_at: 2026-07-14T05:24:28.822Z
---

# Plan: Scaffold-first graph authoring — `workstream_scaffold` + `workstream_brief`

## Problem

Today an orchestrator defines a workstream graph **incrementally through
`workstream_spawn` calls**, and this serialises graph authoring in three ways:

1. **Id threading forces ordering.** `blockedBy` and `gate.rework` must name
   thread ids returned by _earlier_ spawn calls, so the orchestrator cannot lay
   out the whole topology in one pass. A structural mistake noticed at spawn 6
   means cancel-and-respawn.
2. **The brief is welded to node creation.** The full kickoff brief — the
   token-heavy, slow-to-write component — must be authored inline in the spawn
   call, as an escaped string inside JSON tool args. Topology definition is
   rate-limited by prose generation, and a long generation covering many briefs
   degrades in quality towards the end.
3. **The human has no shape-review moment.** The graph only becomes visible
   node-by-node as spawns land. By the time the user can evaluate whether the
   overall _shape_ of the solution makes sense, briefs have already been paid
   for and nodes may be running. (`staged: true` gates _execution_ but not
   _authoring cost_, and the review surface is a transcript of tool calls, not
   one legible object.)

This was prompted by studying Claude Code's dynamic workflows (a
model-authored JavaScript orchestration script). We reject most of that model —
no mid-run human input, hand-rolled rework loops, within-session-only
resumability — but its one clearly superior property is that **the orchestrator
authors the whole graph shape as a single coherent artefact before execution**.
This plan adopts that property without the script runtime.

## Design summary

Split graph authoring into two phases with two new provider tools:

- **`workstream_scaffold`** — one call carrying the whole topology (or a delta
  to it): nodes with cheap metadata only (key, role, title, purpose,
  taskShape/model, isolation), plus `blockedBy` edges and `gate` declarations
  **by symbolic key**. Threads are created eagerly (real thread ids, visible in
  `workstream_list` and the graph render immediately) but **no node can launch
  yet** because none has a brief.
- **`workstream_brief`** — attaches the kickoff brief to one node. A node's
  launch precondition becomes **deps satisfied AND brief exists** (two
  orthogonal gates). Briefs are written one at a time, just-in-time, each as a
  single focused generation.

The pipeline this enables:

```
scaffold (cheap, instant) ──▶ graph renders ──▶ user evaluates SHAPE
        │                                             (in parallel)
        └─▶ brief node 1 ─▶ node 1 launches ─▶ brief node 2 ─▶ …
```

The user gets a shape-evaluation window that currently does not exist, the
first node starts as soon as its brief lands (the whole graph is never paused
on prose), and **late-bound briefs can incorporate actual upstream results** —
a mid-graph node's brief written after its dependencies completed references
what actually happened, not what was predicted. Deterministic shape, adaptive
substance: neither pure script-orchestration nor pure incremental spawning has
this property.

### Decisions already settled (with the user)

1. **No file-based manifest.** The scaffold is a tool call, not an on-disk
   graph file. The call args are the one-shot authoring artefact; the render is
   the review surface. (A file added a second source of truth and nothing else
   once briefs moved out of it.)
2. **Briefs are excluded from the scaffold by design.** The brief is precisely
   the slow part; the scaffold must stay cheap so it renders fast.
3. **One mechanism, not two.** `workstream_scaffold` subsumes
   `workstream_spawn`: spawning a single node is a one-node scaffold + one
   brief. `workstream_spawn` is retired at the end of the migration (this is a
   prototype; no compatibility shims).
4. **Briefs are editable on disk until launch, frozen after.**
   `workstream_brief` is the creation act; the control plane stores the brief
   at a stable path it returns, and pre-launch edits are ordinary file edits.
   Post-launch the brief has been consumed as the kickoff turn; steering is
   `workstream_prompt`, as now. `workstream_brief` on an unstarted node that
   already has a brief overwrites (allowed, but editing is the expected path).
5. **Race between user shape-evaluation and node-1 launch is acceptable.** The
   window is an _opportunity_ the user currently lacks, not a mandatory gate.
   An optional scaffold-level `staged: true` holds everything for explicit
   `workstream_release` when the orchestrator is unsure.
6. **No reusable/saved graphs.** Common shapes are documented as _examples_
   inside skills (like `/skill:pr-review`), keeping the orchestrator exercising
   judgment rather than replaying a frozen script.
7. **`purpose` stays in the scaffold**, in its current short form — title +
   purpose are what make the render evaluable by a human.
8. **Backstop for stranded nodes.** A node whose dependencies are all done but
   which has no brief is a new stall state the control plane must surface.

## Tool contracts

### `workstream_scaffold`

Creates and/or extends the caller's child graph atomically (see "Atomicity"
under Control-plane changes — this is a single engine command, not a handler
loop over per-node spawns).

```jsonc
{
  "staged": false, // optional; true = every created node starts "planned"
  "nodes": [
    {
      "key": "api", // REQUIRED. Symbolic, unique among the caller's
      // children (see "Key scoping" below).
      "role": "coder", // as today
      "title": "Dedup API endpoint",
      "purpose": "Adds the merge endpoint so duplicate receipts can be collapsed.",
      "taskShape": "thorough", // optional, as today
      "sensitive": "security", // optional, as today
      "isolation": "isolated", // optional, role-defaulted as today
      "modelPreset": "…", // optional escape hatches, as today
      "blockedBy": ["thread:wt_abc123", "api"], // keys and/or existing thread ids
      "gate": { "rework": "api", "maxRounds": 2 }, // gate target by key or thread id
    },
  ],
}
```

**Response:** the key→threadId mapping for every created node, plus any
warnings (identical warning surface to today's spawn: gate-on-reader,
cancelled-dependency, isolation-ignored-for-gated-reviewer, …).

**Semantics:**

- Per-node fields are exactly today's `workstream_spawn` args **minus
  `brief`**, **plus `key`**. Nothing else to learn.
- All intra-call references use keys; references to pre-existing threads use
  the `thread:` prefix. Parsing is deterministic by contract: `thread:`-prefixed
  strings are always thread ids, everything else is a key, and **UUID-shaped
  keys are rejected at validation** so a bare id pasted without the prefix
  fails loudly instead of silently becoming a key.
- **Validation is all-or-nothing**: unique keys, no dangling references, no
  dependency cycles (extending today's cycle check in
  `apps/server/src/mcp/WorkstreamSpawnHttp.ts` across the whole batch), gate
  targets resolvable to a sibling. On any error, _nothing is created_ and the
  error names the offending node key.
- Threads are allocated **eagerly**: real ids, real rows, visible in
  `workstream_list`/graph render, controllable pre-launch (cancel, re-gate).
  They cannot dispatch because they have no brief (see dispatcher changes).
- **Delta calls** are the same shape: a later `workstream_scaffold` whose
  `blockedBy` references existing children (by key or id) extends the live
  graph. This is the replacement for today's mid-flight `workstream_spawn`.
- `staged` applies to the nodes created _in this call_ (mirrors today's
  per-spawn `staged`); `workstream_release` releases them as now.

**Key scoping (settled):** keys are namespaced per parent thread,
**unique-forever** among that parent's children (active and terminal alike;
error on reuse), and **immutable** once assigned. Persisted on the thread
record as `graphKey` and exposed in `workstream_list` and the graph
projections (`graphViewFor` in `packages/shared/src/workstreamGraph.ts`
currently omits both purpose and key — both are added so the agent-facing list
render works as a shape-review surface).

### `workstream_brief`

```jsonc
{
  "node": "api", // key or thread id of a direct child
  "markdown": "…",
} // the full kickoff brief
```

**Response:** `{ "threadId": "…", "briefPath": "/abs/path/…/brief.md" }`.

**Semantics:**

- Valid only on a direct child that has **not started** (no kickoff turn yet).
  On a started node it errors with guidance to use `workstream_prompt`.
- Writes the markdown to disk at a stable per-thread location and event-sources
  the _path_ onto the thread record. Storage mirrors the existing report
  pattern (`apps/server/src/orchestration/workstreamReport.ts`: durable
  per-thread directory, absolute path handed back, never inside the ephemeral
  worktree), but with **atomic replacement** (write temp + rename) — the plain
  `writeFileString` the report module uses is not sufficient for a file that a
  kickoff may read concurrently with an edit. Suggested:
  `<workstreamBriefsDir>/<threadId>.md`.
- Calling it again pre-launch overwrites. Editing the file directly pre-launch
  is equally valid — **the kickoff reads the file's current content at launch
  time**, so on-disk edits are honoured without any further tool call.
- **"Frozen after launch" means the kickoff event is the record, not the
  file.** The exact consumed text is persisted in the kickoff turn's event (as
  today — the turn-start message carries the full text), so a post-launch edit
  to the file changes nothing that matters. No filesystem immutability is
  attempted.

### Relationship to existing tools

- `workstream_set_dependencies`, `workstream_set_lane`, `workstream_release`,
  `workstream_stop`, `workstream_submit`, `workstream_request_attention`,
  `workstream_list`: **unchanged**. A scaffolded-unbriefed node is just a
  thread whose first prompt has not been written yet; these controls all
  apply.
- `workstream_prompt`: unchanged for started children. A **first-use** prompt
  on an unstarted child changes: on a briefed child the kickoff is composed as
  brief + supplied message; on an **unbriefed** child it errors with guidance
  to call `workstream_brief` first (handler-level check). A direct human UI
  send on an unstarted child simply **is** the kickoff — intended behaviour,
  not a bypass (§1).
- `workstream_spawn`: retired at the end of the migration (phase 3 below).

## Control-plane changes

### 0. Atomic scaffold creation (new engine command)

The all-or-nothing guarantee cannot be delivered by a handler looping over the
existing spawn path: the engine API dispatches one command at a time
(`apps/server/src/orchestration/Services/OrchestrationEngine.ts:41-52`), and
atomic persistence covers only the events of a **single** command
(`apps/server/src/orchestration/Layers/OrchestrationEngine.ts:225-267`).
Sequential `thread.create` dispatches could partially create a scaffold, and
the decider's sibling validation (`decider.loom.ts:83-105`) would not see
batch members created later in the loop.

Therefore: add a **single internal scaffold command** (e.g.
`thread.scaffold`). Thread ids for all nodes are preallocated before
validation; the decider validates keys, gates, and cycles against the union of
the existing graph and the whole batch, then emits every `thread.created`
event in **one engine transaction**. The HTTP handler does schema/shape checks
and key resolution, but graph-consistency validation lives in the decider
where it is transactional.

### 1. Launch precondition (dispatcher + one guard)

`selectThreadsToDispatch`
(`apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts:79`) gains the
brief gate: a thread dispatches only when **`kickoffBriefPath !== null`** (and
deps satisfied, lane ready, etc. as now).

`promoteThread` (`WorkstreamDispatcher.ts:1598`) reads the brief file at
kickoff time and feeds its content. A read failure parks the node
(`needs_guidance`) rather than launching with a stale or empty prompt — same
posture as worktree-provision failure.

The dispatcher is not the only path that can start an unstarted child, and
the minimal v1 deliberately does **not** try to seal every door:

- **`workstream_prompt` on an unstarted child**
  (`apps/server/src/mcp/WorkstreamSpawnHttp.ts:1565-1625`): add a
  handler-level check — unbriefed child errors with guidance to call
  `workstream_brief`; briefed child composes brief + supplied message as the
  kickoff. This is the one realistic misuse path (an orchestrator confusing
  briefing with steering), and a ~5-line check covers it. The theoretical
  race (concurrent start between check and dispatch) is accepted: the
  orchestrator is the only writer for its children.
- **A direct human UI send on an unstarted child is a feature, not a
  bypass.** A human typing into a scaffolded child means "start with this";
  the send becomes the kickoff, exactly as a human send on a staged root
  works today. Document it; don't block it.

Worst case if a child starts on the wrong prompt: cancel the node and
rescaffold — a cheap, user-visible recovery in a system being watched. That
blast radius does not justify transactional enforcement in a prototype (see
Deferred hardening).

Gate rework/re-verify rounds are unaffected: those direct turn starts occur
only after a first user turn exists, and the gate reactor already bypasses
promotion (`WorkstreamDispatcher.ts:2186-2265`).

**Pre-existing, out of scope:** `ProviderCommandReactor`'s provision-recovery
path re-assembles a kickoff post-event from `thread.brief ?? thread.purpose`
(`ProviderCommandReactor.ts:1020-1069`). Under this plan it should read the
brief file instead — a one-line source change — but the ordering quirk it
embodies (provisioning after the turn-start event persists,
`ProviderCommandReactor.ts:1006-1016, 1029-1049`) predates this feature,
affects every child launch today, and should be assessed as its own fix, not
smuggled into this plan.

### 1a. Schema: a new child-only pointer; the existing `brief` field stays

The event-sourced `brief` string
(`packages/contracts/src/orchestration.loom.ts:359-372`) is **not** replaced —
it has a second live contract this plan must not break: `goal_handoff` /
`goal_continue` create parent-less staged roots carrying an inline `brief`
(`apps/server/src/mcp/GoalHandoffHttp.ts:149-170, 235-256`), and the
sidebar/chat use that inline string to identify, display, edit, and launch
staged kickoffs (`apps/web/src/components/Sidebar.logic.loom.ts:41-54`,
`ChatView.tsx:4343-4368, 5274-5288`).

Introduce a **child-specific `kickoffBriefPath`** field instead. Root
staged-handoff `brief` behaviour is untouched. At the end of the migration,
child threads use only `kickoffBriefPath`; the string `brief` remains the root
handoff mechanism.

During the dual period, `workstream_spawn` writes the **effective** kickoff —
`brief ?? purpose`, matching today's fallback in `promoteThread`
(`WorkstreamDispatcher.ts:1597-1620`) — through to a brief file, so the
dispatcher has one read path and legacy brief-less spawns keep working.

### 2. Brief-needed wake (new batched action-required rail)

Parent wakes are no longer whole-generation joins: the dispatcher collects
per-child terminal **deltas** with durable receipt markers
(`WorkstreamDispatcher.ts:1883-1925`; whole-generation replay was removed —
see `docs/design/workstream-notice-coalescing.md:102-109`). `spawnGeneration`
survives as a UI dispatch-episode key, not a wake barrier
(`WorkstreamDispatcher.ts:709-733`). Action rails already wake a parent
mid-wave, so a brief-needed wake creates no conflict with the join model.

Add a **batched action-required rail**: on each reconciliation pass, collect
**every** child of a parent currently in the eligible state (deps-satisfied +
ready + unbriefed), deliver **one** idle-gated notice naming them all
(key/id + title), and write one durable receipt marker per included child
only after delivery — keyed by **eligibility episode** `(childId,
briefNeededSince)` (§3), not child id alone, so a node that leaves and later
re-enters the eligible state (re-gating, re-release) is re-notified. Batching matters: the per-child pattern would wake the
parent once, make it busy, then serially re-wake it for each remaining node.
Reconciliation triggers: the existing subscription list
(`WorkstreamDispatcher.ts:2476-2502` — create, lane/dependency changes,
fan-in) **plus the new brief-attached event** (attaching a brief can make a
sibling's wake stale or complete a batch).

This wake is also precisely the moment the orchestrator has the upstream
reports in hand — the late-binding advantage lands here.

### 3. Stalled-brief backstop (liveness)

The brief-needed wake covers the live-orchestrator case. For a distracted or
dead orchestrator, extend the idle backstop (`WorkstreamLivenessSweep`) — noting
the sweep currently skips every no-session child outright
(`WorkstreamLivenessSweep.ts:598-605`), so unbriefed nodes need their own
clause. The grace clock must **not** be `createdAt`/`updatedAt`: a node
scaffolded early may become deps-satisfied only much later, and an age-based
clock would trip immediately. Define a **`briefNeededSince` episode** —
derivable from the latest transition that made the node eligible (its final
dependency's terminal event, its own release to ready, or scaffold time if
born eligible) — and raise attention on the **parent** (the child cannot help
itself) once the grace window elapses, deduped per episode. Without this a
graph strands silently at its first unbriefed node.

### 4. Gated reviewers and briefs

A gate today auto-launches the reviewer when the coder completes. With the
brief gate, a scaffolded-but-unbriefed reviewer instead enters the
brief-needed state and wakes the parent — which is _desirable_ (the review
brief can now reference the coder's actual report) but changes gate timing:
the rework loop's re-review rounds must **not** require a fresh brief per
round. Rule: the brief gates only the **first** launch; gate-round re-prompts
(routed submits) proceed as today.

### 5. UI

The graph render is the payoff surface. A scaffolded-unbriefed node needs a
visible **"awaiting brief"** state distinct from `planned` (staged) and
`ready`, across every surface that would otherwise mislabel it "Ready" /
"about to run":

- status presentation (`apps/web/src/lib/workstreamPresentation.ts:386-404` —
  and `parentWorkstreamQuiet`, so an unbriefed ready child doesn't count as
  imminent work)
- spawn cards (`apps/web/src/loom/SpawnCardSection.tsx:130-136`)
- release copy (`apps/web/src/components/WorkstreamPanel.tsx:686-694` says
  "runs once deps clear" — now "…and it has a brief")
- board/graph/rollup views

This composes with the fork–join graph work
(`docs/plans/workstream-fork-join-graph.md`) — eager thread allocation means
scaffolded nodes appear there with no extra plumbing; only the unbriefed
visual state is new. Sidebar cards: title + purpose already render; no change.

## Validation rules (scaffold, consolidated)

Reuse the existing spawn validation (`WorkstreamSpawnHttp.ts`) per node, then
add batch-level checks:

- keys unique within the call and against **all** of the parent's existing
  children (unique-forever); not UUID-shaped; immutable
- every `blockedBy`/`gate.rework` reference resolves to a key in the call or an
  active existing child
- no cycles across the union of existing edges + new edges (extend the current
  cycle walk)
- gate target must be a sibling in the same graph (key or existing child);
  existing gate-on-reader and isolation warnings carry over
- all-or-nothing: any error creates nothing and names the offending node key —
  guaranteed by the single `thread.scaffold` engine command (§0), not by
  handler-loop discipline

## Migration

Prototype posture: move fast, delete the old path, no shims.

- **Phase 1 — add.** New `thread.scaffold` engine command + decider
  validation (§0); new routes in `apps/server/src/mcp/toolPaths.ts`
  (`workstream_scaffold`, `workstream_brief`), handlers factored to share
  `WorkstreamSpawnHttp.ts`'s per-node validation; brief storage module
  (report-pattern layout, atomic replace); `kickoffBriefPath` contract field;
  dispatcher brief gate + read-at-kickoff, `workstream_prompt` unstarted-child
  check, provision-recovery reads the brief file (§1); brief-needed wake
  rail; liveness backstop; UI awaiting-brief state; tool descriptions
  teaching the scaffold→brief flow. `workstream_spawn` still works: its
  effective kickoff (`brief ?? purpose`) writes through to a brief file at
  spawn time.
- **Phase 2 — teach.** Update the orchestrator work-model prompt and any
  skills that reference `workstream_spawn` to author via scaffold+brief;
  scaffold becomes the documented default for ≥1 node.
- **Phase 3 — retire.** Remove `workstream_spawn` (tool, route, prompt
  references). Keep the internal spawn machinery it shared with scaffold.

## Deferred hardening (documented, not built)

A full first-turn enforcement stack was designed during review and is
recorded here in case the loose rule bites in practice: a pre-dispatch
first-kickoff coordinator (provision → read/compose brief → dispatch), a
server-only kickoff marker on the turn-start command, a pure decider
invariant (`kickoffBriefPath` set AND marker present, rejecting all unmarked
first turns — the decider is pure and cannot do I/O, `decider.ts:159-169`,
`OrchestrationEngine.ts:207-224`), and UI-ingress conversion of first sends
into coordinator calls. It guarantees "the exact bytes sent to the provider
are the bytes in the immutable kickoff event" across every ingress,
race-free. Build it only if orphaned-brief launches are actually observed:
the failure it prevents is low-probability and 30-second-recoverable, and the
stack costs roughly a third of the feature's implementation (new command
field, decider change, coordinator refactor, UI send-path change).

## Out of scope

- Reusable/saved graph definitions (deliberately rejected; shapes live as
  examples in skills).
- `ProviderCommandReactor`'s post-event provisioning order — pre-existing,
  affects all launches, assess separately (§1).
- Artefact-based gating ("launch B when file X exists") — collides with
  worktree isolation (a node's outputs are only observable after fan-in).
  A possible later refinement is `produces:` deliverables as a _completion
  contract_ (anti-laziness check at submit time), noted for future work.
- Any change to gates, lanes, attention, fan-in, or report semantics.
- Cross-parent graphs (keys and edges stay within one parent's children,
  matching today's sibling-only dependency rule).

## Formerly open questions (settled by review)

1. **Key reuse rule** — unique-forever per parent, immutable, exposed in
   `workstream_list`/graph projections; UUID-shaped keys rejected.
2. **Brief-needed wake batching** — coalesce all simultaneously eligible nodes
   into one action notice with per-node receipt markers, matching the existing
   terminal same-pass batching discipline (not the FYI digest).
3. **`purpose` stays required per node** — card presentation depends on it
   (`apps/web/src/lib/workstreamPresentation.ts:559-574`) and the scaffold
   review surface is worthless without it. Purpose (and `graphKey`) are added
   to the agent-facing graph/list render.
4. **Read-at-kickoff TOCTOU** — harmless (last write wins, single reader), and
   moot for the historical record: the kickoff event persists the exact
   consumed text, so the event — not the mutable file — is the record. Brief
   writes are atomic-replace so a kickoff never reads a torn file.

> **Review posture note.** The reviewer's factual corrections (decider
> purity, `brief` field's second contract, stale wake architecture, episode
> clock) are incorporated above. Its prescribed first-turn enforcement stack
> was judged over-engineered for a prototype after severity assessment and
> moved to Deferred hardening — must-fix status requires a likely failure
> with expensive recovery, and this one is neither.
