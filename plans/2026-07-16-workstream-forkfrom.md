---
manager_sessions:
  - id: a3c5934f-e03d-4702-bd40-524af5d3c5e8
    role: plan
    authored_at: 2026-07-16T04:28:11.950Z
---

# `forkFrom` — fork-based child spawning for cached shared-prefix fan-out

_Revision 3 — reworked twice after review (reports under
`workstream-reports/003ee1b8-8a1c-4372-b9dd-9513f8bf5f55.md`). Rev 1 wrongly claimed
handler-only scope. Rev 2 fixed the launch race (D7) and scaffold algorithm (D4) but
captured launch identity at the wrong boundary and left an unsafe manual repair;
rev 3 moves capture into the pi driver at the argv boundary, keeps it current per
turn, and unifies kickoff replay (D8) so every recovery path re-delivers the brief.
Rev 4 re-pins D8 to a positive kickoff-DELIVERED marker (rev 3's "no completed turn"
predicate would re-deliver onto a delivered-but-errored first turn)._

## 1. Motivation

The PE-1593 taxonomy campaign runs three parallel `assessor` children over the same
~750k-token corpus, each judging it through a different lens. Each child is a fresh
session today, so the corpus is read (and paid for) three times, and provider prompt
caching cannot help: caching is prefix-identity based, and independent sessions diverge
at the first assistant turn.

The fix is **acknowledge-then-fork**:

1. A "reader" child reads the whole corpus and ends its turn cleanly with a bare
   acknowledgement.
2. N children are launched as **forks of the reader's session** — byte-identical
   transcript prefixes by construction.
3. Each fork receives its differentiated lens brief as its first post-fork turn; only
   the divergent suffix is un-cached.

Secondary benefit, preserved deliberately: **verdict comparability** — parallel
assessors forked from one read reason from literally identical context, so downstream
reconciliation never has to wonder whether two lenses disagree because they read
differently.

## 2. What already exists (thread_fork MVP inventory)

Field propagation is fully plumbed below the workstream surface (review-verified):

| Piece | Where | Status |
| --- | --- | --- |
| `forkFromThreadId` on `thread.create` command | `packages/contracts/src/orchestration.loom.ts:660` | done |
| `forkFromThreadId` on scaffold node command | `packages/contracts/src/orchestration.loom.ts:1021` | done |
| `forkFromThreadId` on `thread.created` payload + read model | `orchestration.loom.ts:408,737` | done |
| Decider propagation (create + scaffold) | `apps/server/src/orchestration/decider.ts:390`, `decider.loom.ts:1240` | done |
| Projector seeding (in-memory + production projection) | `apps/server/src/orchestration/projector.ts:312` | done |
| Bootstrap relay | `apps/server/src/ws.ts:730` | done |
| Fork-once at first launch via native `pi --fork` (no re-fork once the child's own session file exists; source never mutated; fresh child cwd) | `apps/server/src/provider/Drivers/PiDriver.ts:1795` | done |
| Mid-turn source guard at first fork launch (`shouldRefuseForkLaunch`) | `apps/server/src/orchestration/threadIdle.ts:45`, enforced at `ProviderCommandReactor.ts:524` | done (backstop only — see D7) |
| `--fork` argv assembly | `apps/server/src/provider/Layers/Pi/RpcProcess.ts:272` | done |
| UI fork provenance (`ForkedFromBadge`) | `apps/web/src/components/chat/ForkedFromBadge.tsx` | done |

What does NOT exist:

- any way for an **orchestrator** to create a fork (`thread_fork` forks only SELF into
  a parentless root; the workstream tools never set `forkFromThreadId`);
- a **dispatch-time** fork-source-idle gate (the provider-level guard fires too late —
  a refused kickoff is unretryable, D7);
- any **launch-identity capture** (the projection's role/goal/modelSelection are
  mutable intent, not the bytes the source actually launched with, D2);
- kickoff **replay** after a first-turn quota exhaustion (the sweep's generic
  "continue" never delivers the fork's lens brief, D8).

## 3. Design decisions

### D1 — `forkFrom` on `workstream_spawn` and scaffold nodes

- `workstream_spawn` gains optional `forkFrom: <threadId>`.
- `workstream_scaffold` nodes gain optional `forkFrom: <key | thread:id>`, resolved
  with the existing `resolveScaffoldReference` grammar. The driving shape is a single
  scaffold call: reader node → three fork nodes (`forkFrom: reader`), staged, released
  together.
- Unlike `thread_fork`'s parentless root, a `forkFrom` child is a **normal workstream
  child**: `parentThreadId` set, brief-gated, dependency-gated, joins the spawn
  generation, reports via `workstream_submit`, participates in parent wake.
  `forkFromThreadId` is orthogonal provenance the driver consumes at first launch.

### D2 — Launch identity: captured at the provider argv boundary, kept current per turn, replayed at the fork's first launch

pi recomposes the system prompt at every process launch from flags
(`--append-system-prompt` carries role overlay + roles catalogue + goal context,
composed at `ProviderCommandReactor.ts:594–624`); `pi --fork` copies only the
conversation jsonl. The cacheable prefix is `system prompt + tool defs + transcript`.
The projected role/goal/modelSelection cannot supply byte identity: all three are
mutable (`thread.meta.update`, `decider.ts:641-653`), the goal prompt embeds the
mutable task tree (`ProviderCommandReactor.ts:417-435`), and the projected selection
is intent only — pi applies model selection **per turn**, not per session
(`PiDriver.ts:1092-1138`), and reroutes in-session under exhaustion
(`PiDriver.ts:1295-1347`).

**Decision: the pi driver persists a per-thread launch-identity record at the exact
`createPiRpcProcess` boundary, keeps its model part current per completed turn, and
replays it whole at a fork's first launch.**

Record contents (sidecar keyed by thread id, storage pattern of the brief files):

- `appendSystemPrompt` — the **final argv bytes**, i.e. AFTER the driver prepends
  `PI_WORK_MODEL_SYSTEM_PROMPT` (`PiDriver.ts:1788-1791`). Capturing at the reactor
  boundary (rev 2) would double-prepend the work-model prompt on replay.
- `tools`, `skills` — the argv values.
- `providerInstanceId` + the **full applied model selection** — slug AND options
  (e.g. `thinkingLevel`, applied alongside the model at `PiDriver.ts:1134-1149`). A
  slug alone is not a replayable selection, and the instance picks the actual
  driver/cache route.
- The model part is **updated at turn settlement** with the model that actually
  served the turn's final round — the model that most recently consumed the full
  prefix. This covers in-session quota reroutes and the transient retry tier (which
  can run the successful suffix on a fallback and restore the original before
  `turn.completed`, `PiDriver.ts:895-915`); a start-time-only snapshot names neither.
  **Write order (review round 3):** snapshot `session.session.model` BEFORE
  `settleRetry` restores the original (`PiDriver.ts:1152-1162`), write the sidecar,
  THEN emit `turn.completed` — the dispatcher's source-idle re-trigger derives from
  that event, so emitting first would let a fork read stale identity. Apply the same
  settlement update in `failTurn` too: a source can be lane-`done` via
  `workstream_submit` yet have its provider turn settle in error afterwards.

Replay (all inside the driver, where the fork-once condition already lives,
`PiDriver.ts:1795`):

- When `forkFromThreadId` is set and the child's session file does not exist, the
  driver reads the SOURCE's record and uses its stored `appendSystemPrompt`/`tools`/
  `skills` verbatim as the `createPiRpcProcess` arguments (no re-prepend, no reactor
  recomposition) and its stored instance/model/options as the launch selection. This
  sidesteps every mutability hazard at once (role file edits, goal/task-tree drift,
  roles-catalogue drift, worktree-relative overlay loading).
- **Authority through the first send**: the reactor reasserts `thread.modelSelection`
  on every turn request, and the exhaustion sweep keys readiness off the projected
  selection (`ExhaustionResumeSweep.ts:178-193`) — so the captured selection must be
  PERSISTED onto the fork child's thread record before its kickoff turn-start (a
  server-issued meta/model update at promotion time, when the dispatcher reads the
  record). Otherwise the child can start on the captured model and silently switch
  back before the lens prompt is sent, or the sweep can watch the wrong account.
- Subsequent launches of the fork child (resumes) recompose normally — the
  cache-relevant moment is only the first launch.
- If the captured model is exhausted at fork launch, normal failover applies:
  **correctness kept, cache forfeited** — surfaced as a warning, never a refusal.
- Missing record (source predates the feature, or never launched): refuse the fork
  launch with a readable error naming the cause (also covers the "source session
  file missing" edge).

Spawn-time validation consequence: `role`, `modelSelection`, `modelPreset`,
`taskShape`, `sensitive` are all **rejected (400)** when combined with `forkFrom` —
identity comes from the launch record, not from spawn fields. `role` is stored on the
child's thread record as the source's role (display/overlay-on-resume correctness).
`purpose`/`title` remain required per-fork.

### D3 — `blockedBy: [forkFrom]` is implied

If `forkFrom` is not already in the node's `blockedBy`, it is added automatically with
a warning (the `gate.rework` precedent in `validateSpawnGraph`). The
acknowledge-then-fork sequencing falls out of the dependency graph. Note (review): a
`done` source is **not** necessarily an idle source — the lane and the provider turn
are decoupled; D7 owns launch-time idleness.

### D4 — Validation rules and the scaffold whole-graph algorithm

`forkFrom` must resolve to:

1. an **active direct child of the caller** (same ownership scope as `blockedBy`
   targets; archived → same rejection style as archived dependencies), or another node
   in the same scaffold batch;
2. a **pi-backed** source. Review finding (must-fix 4): `ThreadForkHttp.ts:62` reads
   `session.providerName`, which does not exist for an unlaunched in-batch reader.
   Instead resolve the source's provider **driver kind from its (resolved)
   `modelSelection.instanceId`** via provider instance metadata — uniform for existing
   children and batch nodes;
3. not the node itself; not UUID-shaped-without-prefix (existing grammar rule);
4. not combined with `gate` (v1 rejection — no driving use case for a gated-reviewer
   fork, and the attached-worktree promotion composition is unreasoned).

**Scaffold resolution is two-phase over the whole batch** (review must-fix 4 — the
rev-1 per-node loop is order-dependent and reports implied-edge cycles as generic
500s):

- *Phase 1 — resolve to a fixed point.* Resolve every node's `forkFrom` reference;
  build the fork-edge graph over the batch; reject fork-edge cycles (node-labelled
  400). Process fork chains in topological order so a fork-of-a-fork inherits the
  ultimate identity regardless of array order. Materialise every implied
  `blockedBy` edge.
- *Phase 2 — validate the complete effective graph.* Run the cycle check and per-node
  `validateSpawnGraph` over the batch **with all implied edges present**, so every
  rejection is the promised node-labelled 400 and the decider's atomic re-validation
  never sees a graph the handler didn't.

The source's lane is **not** checked at spawn time — the reader may still be running
when the forks are scaffolded; D3 + D7 gate the launch.

### D5 — Worktree / isolation semantics

- `isolation` composes with `forkFrom` unchanged — explicit override or role default.
  For the driving use case (assessors, `shared` by default) forks share the parent
  worktree and the copied transcript's file paths stay valid.
- Documented caveat: an `isolated` fork's copied transcript references the source's
  worktree paths. Fine when the corpus lives outside the worktree (PE-1593) or is
  read-only context. Orchestrator docs: prefer `shared` for fork fan-outs unless the
  forks write code.
- D2's verbatim replay makes the rev-1 "overlay loaded from the child's cwd" residual
  moot for the first launch (nothing is recomposed).

### D6 — Cache-effectiveness posture

- **Launch scheduling**: released fork siblings of one source clear their (identical)
  dependency and are *queued in the same dispatcher pass* (`promoteReadyThreads`) once
  D7's gate opens — promptly sequential provider starts, not measured concurrency
  (review wording fix). No keepWarm mechanism in v1; the tool description documents
  that scattering fork launches across hours forfeits the cache benefit (correctness
  unaffected).
- **Provider-path verification** (cache_read_input_tokens > 0, cliproxy behaviour) is
  out of scope for this repo — it is pi-binary/proxy behaviour and an acceptance step
  of the PE-1593 campaign.

### D7 — Fork-source idleness is a dispatch precondition (review must-fix 1)

The failure sequence in the **normal** flow, verified: `workstream_submit` emits
`thread.plan-lane-set(done)` while the reader's provider turn is still finishing
(`decider.loom.ts:883-914`); the dispatcher reacts to that event immediately and
promotes dependency-satisfied children with no fork-source check
(`WorkstreamDispatcher.ts:83-98`, `:1823`); the provider guard then refuses the
mid-turn fork (`ProviderCommandReactor.ts:524-544`) — but by then the kickoff has
persisted the child's first user message, and promotion eligibility requires
`latestUserMessageAt === null`, so the child is **permanently stranded**. Every fork
in the driving use case would hit this.

**Decision: gate promotion, not just launch.** In the dispatcher's promote selection,
a thread carrying `forkFromThreadId` whose own pi session file does not yet exist is
additionally required to have an **idle source** (`isThreadIdle` on the source +
pending-turn-start set — the exact predicate `shouldRefuseForkLaunch` uses, shared so
they cannot drift). A fork failing this stays `ready` and un-kicked; the dispatcher
already re-runs a pass on `thread.session-set` (`WorkstreamDispatcher.ts:2825`), which
is precisely the event the source going idle emits — so the deferred fork promotes on
the next pass with no new trigger wiring.

- The provider-level `shouldRefuseForkLaunch` guard **remains as the backstop** for
  the residual race (source starts a *new* turn between the dispatcher's check and the
  provider launch — only possible via a parent/human prompting the just-finished
  reader in that window). A backstop refusal surfaces as `thread.turn-start-failed` +
  error attention on the child, i.e. loudly, to the parent and the liveness surface.
  Durable automatic retry stays out of scope, but the **manual repair is made safe by
  D8**: a later `workstream_prompt` on the child re-delivers the composed kickoff
  (the child has no completed turn), so the lens brief is never lost — rev-2's repair
  path silently dropped it (`workstream_prompt` takes the plain-prompt path once a
  user message is persisted, `WorkstreamSpawnHttp.ts:2108-2131`). The
  stall-context/attention message names that repair explicitly.
- Restart window: startup clears a stale pending start but does not replay a
  sessionless kickoff (`loom/startup.ts:98-121`) — same backstop posture, same loud
  surfacing, same D8-safe repair. Test it.
- `workstream_prompt` on an unstarted briefed fork bypasses release/dependency gates
  today (`WorkstreamSpawnHttp.ts:2108`); it must ALSO refuse (or defer) when the fork
  source is not idle, else it reopens the stranding hole the dispatcher gate closes.

**Required test (the review's exact sequence):** submit-tool `done` lands while the
source session is `running` → no fork kickoff that pass → source turn completes,
`thread.session-set` fires → exactly one kickoff per fork, each launching with
`forkFromThreadId` intact.

### D8 — Undelivered-kickoff replay (review must-fix 3, generalised in rev 3)

On a fresh turn whose effective model is exhausted, the pi driver fails the turn
`quota_exhausted` **without sending the prompt to pi** (`PiDriver.ts:1952-1975`); the
exhaustion sweep later sends only a generic "Continue the task" control message
(`ExhaustionResumeSweep.ts:70-75`). A backstop-refused fork kickoff (D7) has the same
shape: user message persisted, nothing delivered to pi. For a fork child either is
silent corruption — the copied reader transcript exists, the lens brief was never
written into it, and the "resumed" assessor plausibly produces an undifferentiated
verdict.

**Decision: one general rule — replay the kickoff while (and only while) it has never
been DELIVERED to pi.**

- **Predicate (durable, positive):** a persisted **kickoff-delivered marker**, written
  the moment the initial `process.request({ type: "prompt" … })` is accepted by pi
  (the send at `PiDriver.ts:2000-2024`). Absence of the marker — not absence of a
  completed turn — is what makes a thread replay-eligible. Rev 3's "no completed
  turn" predicate is UNSOUND (review round 3): a first turn can be delivered and then
  settle `error`/`interrupted` (`PiDriver.ts:1165-1190`,
  `ProjectionPipeline.ts:90-105`) with tool calls and partial edits already in the
  transcript — re-prepending the kickoff there duplicates the task contract and can
  cause repeated side effects. Turn state / error class alone cannot even split
  `quota_exhausted` into its pre-dispatch (never sent, `PiDriver.ts:1938-1975`) and
  post-send variants; the delivery marker splits both exactly.
- The three intended replay cases all lack the marker: provider-guard backstop
  refusal, startup-cleared pending start, pre-dispatch quota exhaustion. Repeated
  pre-dispatch quota failures stay eligible until one prompt is actually accepted.
  A delivered-then-errored kickoff has the marker ⇒ never re-delivered.
- **Storage:** alongside the D2 sidecar (same per-thread storage module, one more
  field or sibling file) — driver-written, durable across restarts. Not a projection
  derivation.
- **Composition:** reconstruct the SAME composed kickoff bytes the dispatcher would
  send — `workstreamChildPrompt({ role, brief })`, brief re-read from
  `kickoffBriefPath` — not the raw brief (which would omit the child completion
  contract).
- **Consumers:** (a) the exhaustion sweep — resume message = control framing +
  composed kickoff instead of the generic continue; (b) `workstream_prompt` on such a
  thread — the composed kickoff is prepended to the parent's message (this is what
  makes D7's manual repair safe); (c) implemented generally, not fork-conditionally —
  a non-fork child whose kickoff hit exhaustion has the same dropped-brief bug today.

## 4. Implementation slices

Honest scope (review): this is **not** handler-only. Slice order is dependency order.

### Slice 1 — launch identity + replay (driver-centred)

1. Launch-identity sidecar (D2): storage module beside `workstreamBrief.ts`; record
   `{ providerInstanceId, model, options, appendSystemPrompt (final argv bytes),
   tools, skills }`. Written by the PI DRIVER at the `createPiRpcProcess` boundary;
   model part updated on turn completion with the model that served the turn's final
   round.
2. Fork-first-launch replay in the driver (D2): when `forkFromThreadId` is set and
   the child's session file does not exist, launch from the source's record verbatim
   (no reactor recomposition, no re-prepend); readable refusal when the record is
   missing.
3. Captured-selection persistence (D2 authority): at fork promotion the dispatcher
   persists the record's instance/model/options onto the fork child's thread record
   before the kickoff turn-start, so per-turn reassertion and the exhaustion sweep
   key off the captured selection.
4. Undelivered-kickoff replay (D8): driver-written kickoff-delivered marker (set on
   prompt acceptance) + `workstreamChildPrompt` recomposition, consumed by
   `ExhaustionResumeSweep.ts` and `workstream_prompt`; general, not fork-conditional.

### Slice 2 — dispatch gate (dispatcher)

5. Fork-source-idle promotion gate in `selectThreadsToDispatch` /`promoteThread`
   (D7), sharing the `shouldRefuseForkLaunch` predicate; stall-context message for
   the backstop path naming the D8-safe repair; `workstream_prompt` unstarted-fork
   guard.

### Slice 3 — surface (handlers + tool defs)

6. `WorkstreamSpawnHttp.ts` spawn handler: parse `forkFrom`; D4 validation
   (instance-metadata provider check, not `session.providerName`); D2 field
   rejections; D3 implied dependency via `validateSpawnGraph` extension; pass
   `forkFromThreadId` into `thread.create`.
7. Scaffold handler: two-phase whole-batch resolution (D4) — fork-edge fixed point,
   implied-edge materialisation, then complete-graph validation with node-labelled
   400s; pass `forkFromThreadId` on scaffold command nodes.
8. `providerToolDefs.ts`: `forkFrom` on both tool schemas; description covers the
   acknowledge-then-fork pattern, identity inheritance (no role/model fields), implied
   `blockedBy`, TTL note, and the shared/isolated guidance.

### Slice 4 — docs

9. `roles/orchestrator.md`: the acknowledge-then-fork pattern — when to reach for it,
   the reader's contract (read everything, end with a bare acknowledgement submit),
   forks carry the lens briefs, launch forks promptly (TTL), identity is inherited.

### Tests (per slice, sibling files of existing suites)

- D7's exact race sequence (see D7); restart in the kickoff window; backstop refusal
  surfaces error attention + repair message; `workstream_prompt` fork guard.
- Launch record round-trip at the argv boundary (no double `PI_WORK_MODEL_SYSTEM_PROMPT`);
  model part updated across an in-session reroute; fork launch replays byte-identical
  argv and the record's instance/model/options; captured selection persisted and
  honoured through the first `sendTurn` and by the sweep's readiness check;
  missing-record refusal; failover-at-fork-launch warning (correctness kept).
- D8: pre-dispatch exhausted kickoff → sweep resends the COMPOSED kickoff (fork and
  non-fork); `workstream_prompt` after a backstop-refused kickoff prepends the
  composed kickoff (the D7 repair test); repeated pre-dispatch quota failures stay
  eligible; **delivered-then-errored/interrupted first turn is NOT re-delivered**
  (the round-3 counter-example); marker survives restart.
- D2 settlement ordering: sidecar written before `turn.completed` is emitted
  (retry-tier restore race); `failTurn` settlement also updates the record.
- Handler validation: unknown id / not-a-direct-child / archived / non-pi / self-fork
  / each identity field / `gate`+`forkFrom` → 400s; implied `blockedBy` + warning;
  no double-add when explicit.
- Scaffold: in-batch key + `thread:<id>` sources; fork-of-fork inheritance is
  array-order-independent; fork-edge cycle → node-labelled 400; implied-edge cycle →
  node-labelled 400 (not a decider 500).
- Source archived/deleted between scaffold and launch → deterministic refusal (not
  dependent on a stale session file) — review hardening item.

### Review

Gated reviewer (thorough) over the coder's diff per slice group (1+2 together, 3+4
together), per the standard writer/reviewer split.

## 5. Edge cases (consolidated)

- **Source re-engaged while forks pending** → D7 gate defers; backstop loud-fails.
- **Source cancelled/failed before forks launch** → implied dependency never releases
  (existing `cancelled`-dependency warning at spawn when visible). No new mechanism.
- **Source never actually launched** (force-`done`, no session file / no launch
  record) → readable fork-launch refusal (D2).
- **Source archived/deleted after validation** → deterministic refusal at launch;
  dangling deps do not gate and `shouldRefuseForkLaunch` permits an unknown source, so
  the refusal must come from the D2 missing-record/missing-thread check. Test it.
- **Fork of a fork** → allowed; within a batch, inheritance resolves along the
  fork-edge topological order (D4).
- **Delta scaffold** adopting an existing `done` reader via `thread:<id>` → the
  PE-1593 path; spawn generations and dependencies are independent axes (review
  confirmed).
- **First-turn quota exhaustion** → D8 replay.

## 6. Acceptance

1. Scaffold: reader node → three fork nodes (`forkFrom: reader`, staged, released
   together) → each fork is a distinct multi-turn worker with tools, its own report,
   and a transcript whose prefix is byte-identical to the reader's — **including the
   final argv system prompt and the instance/model/options that last consumed the
   prefix** (D2), not just the copied jsonl.
2. The D7 race sequence test passes: no stranded fork in the normal
   submit-then-promote flow.
3. NO recovery path loses the kickoff brief — exhausted kickoff, backstop-refused
   fork kickoff, or restart-cleared kickoff (D8).
4. Clear node-labelled 400s for every D4 violation, including implied-edge cycles.
5. Identity fields with `forkFrom` are rejected, never silently ignored.
6. `vp check` and `vp run typecheck` green; new tests pass.
7. Docs updated (tool defs + `roles/orchestrator.md`).

Observable cache hits on a cache-supporting provider path are the PE-1593 campaign's
acceptance step, not this repo's (D6).

## 7. Out of scope

- keepWarm / scheduled launch-batching mechanics (D6).
- cache_control breakpoint verification per provider path (pi binary / cliproxy).
- Forking non-pi providers.
- `gate` + `forkFrom` composition (rejected in v1).
- Durable self-retry of a backstop-refused kickoff (D7 trades this for the dispatch
  gate + loud surfacing; D8 makes the manual repair brief-safe; revisit only if the
  backstop fires in practice).
- Any change to `thread_fork` / `consult_thread` semantics.
