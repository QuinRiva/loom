---
manager_sessions:
  - id: b0bd6ac3-218b-4b0e-86ac-7b45331f759c
    role: plan
    authored_at: 2026-07-05T15:23:11.008Z
---

# Plan: Workstream spawn hardening — fail-fast graph validation

## Problem and intent

The spawn lifecycle validates _shape_ but not _referential coherence_. The runtime
dependency predicate (`areDependenciesSatisfied`, `packages/shared/src/workstreamDependencies.ts:55`)
deliberately treats unknown / non-sibling `blockedBy` ids as _satisfied_, and nothing
upstream rejects them — so a one-character typo in a reviewer's `blockedBy` silently
stripped its dependency and the gated reviewer released before its coder (the incident
that triggered this work). The audit
(`~/.t3/cockpit/userdata/workstream-reports/0fa488d2-d269-4877-be36-84496d5dfcd6.md`)
catalogued 11 findings (H1–L11) in the same family, including one confirmed deadlock
(M3) and one silent-permanent-block class (M4/M5).

**Target invariant:** _an incoherent graph cannot be submitted._ The runtime predicate
stays permissive as a backstop (unchanged — decided with the user); every mistake it
would silently tolerate is instead rejected or warned about at the submission boundary,
in messages written for the LLM agent that made the call.

All audit claims were re-verified against the code while planning; every cited
file:line checks out. One deviation from the audit/brief is flagged inline (M5 §"Cycle
detection", and see §Deviations).

## Where validation lives — layering decision

Three candidate loci exist: the MCP HTTP handlers (`WorkstreamSpawnHttp.ts`), the
decider (`decider.ts` command invariants), and the runtime predicate. The plan places:

| Layer                                                                     | Gets                                                                                                                                                             | Why                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MCP handlers (`handleWorkstreamSpawn`, `handleWorkstreamSetDependencies`) | **All** hard rejections + all warnings (H1, H2, M3, M5, M6, L7, L9, M4-warn)                                                                                     | This is the agent submission surface. 400s with actionable prose and a `warnings` channel on success are only expressible here; decider invariant errors surface via the handler's catch as bare 500s.                                                                 |
| Decider (`thread.dependencies.set` **and** `thread.create`)               | Coherence backstop: reject a cyclic **and** a non-sibling/dangling `blockedBy` set; raise M4 attention on an edge onto an already-cancelled dep (R1/R2/R3 below) | Cycles and dangling ids are never legitimate from _any_ surface, and both commands are dispatched **directly by the web board / client-runtime** (`WorkstreamPanel.tsx:181,193-216` → `thread.dependencies.set` / `thread.create` over WS), bypassing the MCP handler. |
| Runtime predicate (`workstreamDependencies.ts`)                           | **No change**                                                                                                                                                    | Stays permissive as the backstop, per the agreed design. Existing tests remain valid as-is.                                                                                                                                                                            |

**Round-1 review correction (finding 2): `thread.create` is NOT left permissive.** The
command contract permits `blockedBy` and `routes` (`packages/contracts/src/orchestration.ts:848,851`),
`client-runtime`'s `createThread` forwards inputs verbatim (`packages/client-runtime/src/operations/commands.ts:163-170`),
and `WorkstreamPanel` already creates children via `thread.create` directly rather than
through `handleWorkstreamSpawn` (`WorkstreamPanel.tsx:193-216`). Even though the panel does
not pass `blockedBy` _today_, the surface is open, so the decider backstop below closes it
regardless of caller — otherwise the invariant is only enforced on the MCP path.

Following the existing pattern (`resolvePresetSelection`: pure function exported from
`WorkstreamSpawnHttp.ts`, unit-tested without an HTTP harness), the new validation is a
**pure exported function** so it is directly testable.

## New shared pieces

### 1. Pure validator: `validateSpawnGraph` (in `WorkstreamSpawnHttp.ts`, exported)

```ts
export interface SpawnGraphInput {
  readonly siblings: ReadonlyArray<{
    // threads with parentThreadId === spawner
    readonly id: ThreadId;
    readonly role: string | null;
    readonly planLane: ThreadPlanLane;
    readonly blockedBy: ReadonlyArray<ThreadId>;
  }>;
  readonly blockedBy: ReadonlyArray<ThreadId> | undefined;
  readonly gateRework: ThreadId | undefined; // pre-validated to exist as a sibling (existing check)
  readonly isolationOverride: ThreadIsolation | undefined;
  readonly role: string; // the new child's role
}

export type SpawnGraphResult =
  | { readonly kind: "rejected"; readonly message: string }
  | {
      readonly kind: "ok";
      readonly blockedBy: ReadonlyArray<ThreadId> | undefined; // post H2-injection
      readonly forceAttached: boolean; // M3
      readonly warnings: ReadonlyArray<string>;
    };
```

**Sibling set source — round-1 review correction (finding 1): active threads only.** Both
handlers derive `siblings` from `getShellSnapshot()` (active, non-archived, non-deleted),
filtered to `parentThreadId === <parent of the node being edited>` — **not** from
`collectGraphThreads()` (active + archived). The dispatcher gates against exactly the
active snapshot (`WorkstreamDispatcher.ts:68-80` → `getShellSnapshot` →
`listActiveThreadRows`, `ProjectionSnapshotQuery.ts:2015-2028`). If validation accepted an
archived sibling as a valid dependency target, the runtime predicate would then find it
absent from the active map and treat it as unknown→satisfied
(`workstreamDependencies.ts:52-56`) — recreating the exact silent-release class this work
eliminates. So the valid-dependency-target set must be _identical_ to the set runtime
gates on. An archived id therefore falls through the H1/D1 "not a known sibling"
rejection, with a message noting the sibling is archived (below). (`collectGraphThreads`
stays the scope for `workstream_list` and the auth predicate — visibility is a wider
scope than dependency-eligibility; only the latter narrows to active.)

The **`gate.rework` existence check** (existing, `WorkstreamSpawnHttp.ts:328-336`) is
tightened to the same active set for the same reason: `gate.rework` is auto-injected into
`blockedBy` (S3), so an archived gate target would inject an id that runtime treats as
satisfied → the reviewer releases early. Reject an archived/non-active `gate.rework`
target with the sibling message.

### 2. Cycle helper: `findDependencyCycle` (in `packages/shared/src/workstreamDependencies.ts`)

```ts
/** DFS over the sibling blockedBy graph; returns a cycle path (ids, first repeated
 *  last) or null. Only same-parent edges are followed — mirroring exactly which
 *  edges areDependenciesSatisfied treats as gating. */
export const findDependencyCycle = (
  threads: ReadonlyArray<{ id: ThreadId; parentThreadId: ThreadId | null; blockedBy: ReadonlyArray<ThreadId> }>,
): ReadonlyArray<ThreadId> | null
```

Lives next to the predicate so the "which edges gate" definition cannot drift. Consumed
by both the MCP handlers and the decider backstop.

### 3. `MAX_GATE_MAX_ROUNDS = 10` (in `packages/contracts`, beside `DEFAULT_GATE_MAX_ROUNDS`)

## Validation rules — exact semantics and messages

Rules run in the order listed, after the existing shape checks and (for spawn) after the
existing `gate.rework` sibling check. **Errors** are HTTP 400s (the pi extension throws
them as tool errors — `WorkstreamSpawnExtension.ts` already surfaces non-2xx as a thrown
tool failure, so the model sees them as failed calls). **Warnings** ride the success
response (see §Warnings channel).

### At `workstream_spawn` (`handleWorkstreamSpawn`)

**S1 (L9) — `gate.maxRounds` ceiling.** Extend the existing positive-integer check:

> `gate.maxRounds must be an integer between 1 and 10. Each round is a full rework + re-review cycle; if you expect to need more than a few, the work should be re-scoped instead of looped.`

**S2 (H1) — every `blockedBy` id must be an active known sibling.** Reject when any
trimmed id does not resolve to a thread in the **active** set (§"Sibling set source")
whose `parentThreadId` is the spawner. Error (listing _all_ offending ids, and echoing
valid sibling ids so the agent can self-correct without another lookup):

> `blockedBy contains ids that are not children of this thread: <bad ids>. A dependency can only name a sibling of the new child — a thread you directly parent. Known children: <id — "title" (lane)> [...]. Use the exact childThreadId returned by workstream_spawn, or check workstream_list. Nothing was spawned.`

**Archived-sibling distinction (round-2 nice-to-have).** The handler already holds the
wider `collectGraphThreads()` (active + archived) set for auth/visibility, so before
emitting the generic message it checks whether a rejected id is in fact a same-parent
_archived_ sibling and, if so, swaps in a targeted line for that id:

> `blockedBy names <id> ("title"), which is archived and no longer active — an archived thread cannot gate (depending on it would silently release). Depend on an active sibling instead. Nothing was spawned.`

This closes H1 and its subsets L8 (parent/ancestor ids are non-siblings → rejected) and
L11 (non-UUID strings → rejected). L10 (duplicate ids) stays a non-issue; the handler
dedupes silently while normalising.

**S3 (H2) — auto-inject `gate.rework` into `blockedBy`.** When a gate is declared,
`blockedBy := union(blockedBy ?? [], [gate.rework])` (decided: inject, don't reject on
divergence). When injection actually changed the set, add a warning so agents learn the
contract:

> `gate.rework <id> was added to blockedBy automatically — a gated reviewer always waits for the thread it reviews.`

**S4 (M3) — force `attached` isolation for a gated reviewer.** When `gate.rework` is set
and the caller passed an explicit `isolation`, ignore the override (decided: warn, don't
reject). The isolation expression at `WorkstreamSpawnHttp.ts:396` becomes: gate present →
`attached` unconditionally; otherwise `override ?? roleDefaultIsolation(role)`. Warning:

> `isolation "<override>" was ignored: a gated reviewer always runs attached (it joins the reviewed thread's worktree). Any other isolation deadlocks the gate — the reviewer would wait for the coder's fan-in, which is deferred until the gate the reviewer itself must resolve.`

**S5 (M4, spawn leg) — warn on a `cancelled` dependency.** A cancelled sibling is a
_known_ sibling (passes S2) but never satisfies the predicate, so the child would sit
blocked until a human intervenes. Warn rather than reject because `cancelled → ready` is
a legal lane transition (a human can revive the dep):

> `blockedBy names <id> ("title"), which is cancelled. A cancelled dependency never releases — this child will not start unless <id> is revived (workstream_set_lane → ready) or this child's dependencies are re-pointed.`

**S6 (L7) — warn on gating a non-writer.** Reuse the existing role classification
(`roleDefaultIsolation`: writers → `isolated`, readers → `shared`) rather than inventing
a role taxonomy; roles are free text, so rejection would break legitimate free-text
writer roles. When `roleDefaultIsolation(reworkTarget.role) !== "isolated"`:

> `gate.rework targets <id> ("title", role "<role>") — a reader-style role. Review gates loop rework back to the thread that produces the work (coder/planner/free-text writer); gating a <role> is usually a wiring mistake. Proceeding anyway.`

**S7 (M5, spawn leg) — cycle check, REJECT (round-1 review correction, finding 4).** Run
`findDependencyCycle` over the effective sibling graph the child is about to depend on
(`siblings` with the new node's `blockedBy` added). The new child cannot itself _close_ a
cycle (its id is server-generated after validation, so no existing sibling references it)
— but it _can_ be spawned blocked behind a sibling set that is _already_ cyclic, which
submits a graph where the child is wedged forever. Under the invariant "an incoherent
graph cannot be submitted," that must **reject**, not warn (the user-approved decision was
explicitly "reject fail-fast"; the round-0 draft's downgrade to warning-only was an
unapproved weakening — withdrawn):

> `blockedBy would place this child behind a dependency cycle: <a> → <b> → <a>. A cyclic set never releases, so the child would never start. Fix the cycle first (workstream_set_dependencies on one of the members). Nothing was spawned.`

With D2 + the decider backstop rejecting cycles at every construction point, a
pre-existing sibling cycle becomes unreachable going forward; S7 is then a
defence-in-depth guard (and catches pre-fix data). Same cost as the warning — one
`findDependencyCycle` call — but coherent with the approved semantics.

### At `workstream_set_dependencies` (`handleWorkstreamSetDependencies`)

**D1 (H1) — sibling validation relative to the target.** Every id must resolve to a
thread with the target's `parentThreadId`, excluding the target itself. A self-reference
gets its own message (the decider silently strips it today; silently accepting an edge
that does not exist violates the invariant):

> `A thread cannot block on itself (<id> is the target thread). Nothing was changed.`

Non-sibling message mirrors S2 (same active-set rule and the same archived-sibling
distinction) with `Nothing was changed.` and names the target's actual siblings. Root
threads (target `parentThreadId === null`) are rejected outright —
dependencies never gate a root (`selectThreadsToDispatch` requires a parent), so
recording them is pure display noise:

> `Dependencies have no effect on a root thread — only sub-threads are dependency-gated. Nothing was changed.`

**D2 (M5) — cycle rejection.** Run `findDependencyCycle` over the target's sibling set
with the target's `blockedBy` _replaced by the proposed set_. On a cycle, reject:

> `These dependencies would create a cycle: <a> → <b> → <a>. A cyclic set never releases — every member waits on another member forever. Remove one edge, or re-order the work. Nothing was changed.`

**D3 (M4, set-deps leg)** — same cancelled-dep warning as S5.

**D4 (M6) — warn when the target has already started.** "Started" uses the dispatcher's
own definition (`WorkstreamDispatcher.ts selectThreadsToDispatch`): `session !== null ||
latestUserMessageAt !== null`. The command still dispatches (replace-set semantics are
kept — the edge is real for display and for the parent's mental model), but the response
carries:

> `<id> has already started: the dependency edge was recorded for DISPLAY ONLY — a started thread is never un-run, so this will not pause or re-gate it. To pause it use workstream_stop; to abandon it set its lane to cancelled; to sequence future work, set blockedBy at spawn time.`

This is exactly the post-incident recovery path an operator reaches for; today it
returns bare success (`WorkstreamSpawnHttp.ts` returns `{ threadId, blockedBy }`) — a
false sense of recovery.

### Decider coherence backstop (findings 2 + 3): `thread.dependencies.set` **and** `thread.create`

The decider is the universal chokepoint every command crosses, including the web-board /
client-runtime paths that bypass the MCP handler. Three backstop rules, sharing the same
active-sibling filter as the handlers (`readModel.threads` filtered to the target's
`parentThreadId`, non-deleted, non-archived — use the existing `deletedAt === null` /
archived guards the cancel cascade already uses):

**R1 — cycle rejection (M5), both commands.** Before emitting `thread.dependencies-set`
(`decider.ts:1051`), run `findDependencyCycle` over the target's siblings with the
target's set replaced by `command.blockedBy.filter(id => id !== command.threadId)`. In
`thread.create` (`decider.ts:531-535`), when `command.blockedBy` is non-empty, run it over
the existing siblings plus the new node's proposed edges. On a cycle, fail with an
`OrchestrationCommandInvariantError`:

> `Dependencies for thread '<id>' would create a cycle (<a> → <b> → <a>); a cyclic set can never release.`

**R2 — non-sibling / dangling rejection, BOTH commands (findings 2 + round-2 finding 1).**
When `thread.dependencies.set` carries a non-empty set, or `thread.create` carries a
non-empty `blockedBy` (or `routes`/loop edges), every `blockedBy` id and every loop-route
target must resolve to an existing sibling — same `parentThreadId`, non-deleted,
non-archived (the same filter as runtime gating: `deletedAt === null` plus the archived
guard the cancel cascade already uses) — in `readModel`. Otherwise fail with an invariant
error naming the offending ids:

> `Dependencies for thread '<id>' name non-sibling/unknown ids (<bad ids>); a dependency can only name an active sibling (same parent). A dangling id never gates — it would silently release.`

This mirrors the MCP handler's H1/D1 rejection on the decider path, closing the bypass
for **both** commands: the `thread.create` contract permits `blockedBy`/`routes` and the
board creates children via it, AND `client-runtime` / the WS board dispatch
`thread.dependencies.set` **directly** (`WorkstreamPanel.tsx:181`) — so leaving _either_
to the old strip-self-refs-only behaviour (`decider.ts:531-535,1065-1070`) would let a
non-MCP caller submit exactly the incoherent H1 dependency the handler rejects.
Empty/absent `blockedBy` (root / manual-UI / goal-handoff norm) is unaffected — no
behavioural change for the common create. The board's editor only ever offers real
siblings (`WorkstreamPanel.tsx:663-672`), so no legitimate UI flow sends a dangling id;
this rejects only genuinely incoherent submissions. The existing decider comments
"Cycles/dangling ids tolerated permissively" (both handlers) are corrected accordingly —
the runtime predicate (`workstreamDependencies.ts`) remains the permissive backstop, but
the submission boundary no longer _accepts_ the incoherent set (decision 9: the
invariant is "cannot be submitted," not "tolerated at runtime").

**R3 — M4 attention on an edge onto an already-cancelled dep (finding 3).** The board's
dependency editor offers every sibling except self, unfiltered
(`WorkstreamPanel.tsx:663-672,703-719`), and dispatches `thread.dependencies.set`
directly. Wiring an un-started child to wait on an already-`cancelled` sibling silently
wedges it (cancelled never releases). So in `thread.dependencies.set`: if the target is
un-started (`!messages.some(m => m.role === "user")`) and non-terminal, and the _newly
added_ `blockedBy` set contains a gating (same-parent) sibling whose lane is `cancelled`,
emit `thread.attention-raised` reason `needs_guidance` on the target (same mechanism as
the cancel-cascade M4 scan below — the two are the symmetric orderings: dep-cancelled-
then-edge here, edge-then-dep-cancelled in the cascade). A UI nicety — filtering cancelled
siblings out of the editor's `options` — is a reasonable optional add, but the decider
guard is the load-bearing, surface-independent fix.

Rejecting an incoherent `thread.create`/`set` in the decider surfaces to the board via the
normal command-error path — strictly better than the silent deadlock/early-release it
produces today. LLM-agent-grade prose is not required here (the consumer is the UI / a
programmatic caller), but the messages still name the offending ids.

### M4 — surfacing a dependent wedged by a cancel (decider, cancel-cascade branch)

**Mechanism chosen: raise `needs_guidance` attention on each wedged dependent, at cancel
time, inside the existing cascade in `decider.ts` (`thread.plan-lane.set`,
`command.planLane === "cancelled"` branch).**

After computing the cancelled `subtree` set, scan `live` threads _outside_ the subtree
that are now wedged:

- not started (`!thread.messages.some(m => m.role === "user")` — the decider's own
  first-turn-gate definition of "never un-run"),
- `planLane` is `planned` or `ready` (not terminal, not running),
- `blockedBy` contains a member of the cancelled set that actually gates (same
  `parentThreadId` as the dependent — mirror the predicate).

For each, emit `thread.attention-raised` with reason `needs_guidance` (events emitted
directly, exactly like the cascade's existing direct `thread.attention-cleared` /
`thread.turn-interrupt-requested` emissions — never re-enter command handlers mid-decide).

Why attention, not a log activity or a spawn-time-only warning:

- Attention is the system's single "a human/parent must look" surface: it renders on the
  board, and the parent is woken on a child's attention flag — so the orchestrator that
  issued the cancel learns immediately that a replacement plan is needed. A
  parent-activity log line (the `reopened-with-started-dependents` pattern at
  `decider.ts:1267`) is observable but passive; a wedged thread left `blocked` forever
  is precisely the silent state we are eliminating.
- The lifecycle already fits: the flag clears automatically if the dependent is
  re-pointed and started (turn-start clears attention), or when it is itself cancelled.
- Blocking or auto-cancelling the dependent would be wrong: cancel must always succeed,
  and the dependent's fate (re-point, revive the dep, cancel it too) is the parent's
  call, not the control plane's.

The scan lives in the decider (not the dispatcher) so it happens transactionally with the
cancel — no polling, no missed window, and it covers cancels from every surface (agent
tool, web board, cascade membership).

## Warnings channel — MCP response and extension rendering

Success responses from spawn / set-dependencies gain an optional field:

```ts
{ ..., warnings?: ReadonlyArray<string> }   // present only when non-empty
```

`WorkstreamSpawnExtension.ts` renders them into the tool result `content` (the only
surface the model reads — `details` is UI/debug, per the existing `workstream_list`
comment):

```
Spawned Workstream sub-thread <id>: <title>
Warning: isolation "shared" was ignored: ...
Warning: gate.rework <id> was added to blockedBy automatically — ...
```

Same pattern for `workstream_set_dependencies` ("Set Workstream thread ... dependencies
(n waits-on).\nWarning: ..."). The extension file is rewritten unconditionally on server
start (`ensurePiWorkstreamSpawnExtension`), so no migration concerns.

Two tool-description touch-ups ride along (agents read these): the `workstream_spawn`
gate description drops "Combine with blockedBy on the same sibling" in favour of
"gate.rework is automatically added to blockedBy", and `workstream_set_dependencies`
gains "setting dependencies on an already-started thread returns a warning — the edge is
display-only".

## Ordering and atomicity — several spawns in one turn

Verified safe. `OrchestrationEngine.dispatch` is serialized through a single queue, and
the projection pipeline is updated **inside the dispatch transaction**
(`projectionPipeline.projectEvent(savedEvent)` in `Layers/OrchestrationEngine.ts`) before
the dispatch — and therefore the spawn's HTTP response — resolves. So when an agent
spawns a coder and then a reviewer with `blockedBy: [coderId]` in the same turn
(sequential tool calls), the coder is already visible to `ProjectionSnapshotQuery` when
the reviewer's validation reads the sibling set. This is the same mechanism the existing
`gate.rework` sibling check already relies on, working in production today. Staged
(`planned`) siblings are equally visible — `thread.created` lands regardless of lane.

If tool calls were ever issued concurrently, the failure mode is a **spurious rejection**
(validator reads the snapshot before the earlier spawn commits → id unknown → 400 naming
the id) — fail-closed and self-explaining; the agent retries or falls back to
`workstream_set_dependencies`. No silent-release path exists in any interleaving. No new
locking is needed.

## Impact on existing callers and tests

- **Runtime predicate and its tests** (`workstreamDependencies.test.ts`): unchanged. The
  "ignores a dangling/unknown dependency id" / "does not gate on a non-sibling" tests now
  document the _backstop_, not the contract; add a comment pointing at spawn-time
  validation, nothing more.
- **`decider.reviewGate.test.ts`, `commandInvariants.test.ts`**: no encoded semantics
  change. Review-gate fixtures build read models directly (post-spawn state), untouched
  by handler validation.
- **`decider.cancelCascade.test.ts`**: fixtures that include un-started dependents
  outside the cancelled subtree will now see extra `thread.attention-raised` events —
  audit event-count/shape assertions and update (expected, deliberate).
- **`WorkstreamSpawnHttp.test.ts`**: currently pure-function tests only
  (`resolvePresetSelection`); grows the `validateSpawnGraph` suite.
- **Web board**: unaffected except that a cycle set from the panel is now rejected by
  the decider (surfaced through the normal command-error path) — strictly better than
  the silent deadlock it produces today.
- **Behavioural break (intended):** any existing agent habit of passing speculative /
  cross-parent `blockedBy` ids now fails fast. This is the point; the error message
  carries the fix.

## Test plan

Repo convention: orchestration invariants are unit-tested (decider/predicate/pure-fn
level); no HTTP harness exists for these handlers and none is introduced.

**`WorkstreamSpawnHttp.test.ts` — `validateSpawnGraph` (new describe):**

1. rejects a dangling `blockedBy` id, message names it and the known siblings (H1 — the incident's typo).
2. rejects a non-sibling id (cross-parent) (H1/L8); rejects an **archived** sibling id (finding 1 — must match the active runtime set); accepts an active sibling.
3. accepts + dedupes duplicate sibling ids (L10).
4. **gate.rework ⊆ blockedBy** (audit gap 1): gate with omitted `blockedBy` → injected; gate with divergent `blockedBy` (the typo incident) → typo id rejected by H1 _and_ injection covers the gate target; union produces a warning when it changed the set.
5. **gated-reviewer isolation override** (audit gap 3, M3 regression): `gate.rework` + `isolation:"shared"` → `forceAttached: true` + warning; no gate → override honoured.
6. cancelled-dependency warning (M4 spawn leg).
7. non-writer gate target warning (L7); writer/free-text target → no warning.
8. maxRounds ceiling: 10 passes, 11 rejects (L9).
   8b. **S7 spawn-behind-cycle rejection (finding 4):** new child `blockedBy:[A]` where siblings A→B→A already cycle → rejected (not warned); acyclic sibling set → accepted.

**`workstreamDependencies.test.ts` — `findDependencyCycle`:** 9. 2-cycle detected with path; 3-cycle; no false positive on a diamond (A→B→C, A→C);
cross-parent edges not followed (a "cycle" through a non-sibling is not a cycle). 10. **M3 deadlock characterisation (regression for the wedge itself):** reviewer
`isolation:"shared"`, `blockedBy:[coder]`, coder `done` + `isolation:"isolated"` +
`fanInState:"none"` → `areDependenciesSatisfied` is false (the wedge); same fixture
with reviewer `attached` → true. Documents _why_ S4 forces attached.

**Decider tests:** 11. **R1/R2 `thread.dependencies.set` backstop:** rejects a proposed cycle (M5; staged
A↔B repro from the audit: B planned, A blockedBy [B], then set B's deps to [A] →
invariant error); rejects a **non-sibling/dangling/archived** id in the set naming it
(round-2 finding 1 — closes the direct-WS H1 bypass); a set of only active siblings →
accepted.
11b. **R1/R2 `thread.create` backstop (finding 2):** create with `blockedBy` forming a
cycle → rejected; create with a non-sibling/dangling `blockedBy` id → rejected naming
the id; create with empty/absent `blockedBy` (root/manual norm) → unaffected.
11c. **R3 (finding 3):** `thread.dependencies.set` wiring an un-started child onto an
already-`cancelled` gating sibling raises `needs_guidance` on the child; onto a live
sibling → no attention; started/terminal target → no attention. 12. Cancel cascade raises `needs_guidance` on an un-started outside-subtree dependent
(M4); does **not** raise on a started dependent, a terminal dependent, or a
subtree member; the flag lands in the same decide pass as the cancels.

**M6:** the started-target warning depends on shell state reads in the handler; extract
the predicate (`hasThreadStarted(shell)`) beside `selectThreadsToDispatch`'s definition
and unit-test it (session-only, message-only, both, neither). The handler wiring is
covered by `vp check` typechecking plus manual verification (below).

**Manual verification (canonical entrypoint):** run the dev server, spawn from a live
thread: (a) typo'd `blockedBy` → tool error naming the id; (b) gate without `blockedBy`
→ reviewer waits for coder; (c) `set_dependencies` on a running child → warning text in
the tool result.

## Work packages

Sequential (WP2 `blockedBy` WP1 — WP2's decider tests use `findDependencyCycle` from WP1,
and keeping the packages non-overlapping in files avoids merge friction).

### WP1 — submission-boundary validation (MCP handlers + extension + shared helper)

Scope: H1, H2, M3, M5 (handler legs, reject), M6, L7, L9, warnings channel.

Files: `apps/server/src/mcp/WorkstreamSpawnHttp.ts` (+ `.test.ts`),
`packages/shared/src/workstreamDependencies.ts` (+ `.test.ts`),
`packages/contracts` (`MAX_GATE_MAX_ROUNDS`),
`apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`.

Acceptance:

- Tests 1–10 (incl. 8b) above green; `vp check` and `vp run typecheck` pass.
- `validateSpawnGraph` is pure and exported; both handlers consume it; the
  **dependency-target sibling set is sourced from `getShellSnapshot()` (active only)**,
  matching the runtime gating set (finding 1) — `collectGraphThreads()` remains the
  visibility/auth scope only. The `gate.rework` existence check uses the same active set.
- Spawn-behind-cycle **rejects** (S7, finding 4), not warns.
- Spawn/set-deps success responses carry `warnings` and the extension renders them in
  `content`; errors are 400s with the message shapes above (verbatim intent, wording may
  be polished).
- Extension tool descriptions updated (auto-inject, display-only warning).

### WP2 — decider coherence backstop (findings 2 + 3 + M4 + M5)

Scope: R1 cycle rejection on `thread.dependencies.set` **and** `thread.create`; R2
non-sibling/dangling/archived rejection on **both** `thread.dependencies.set` and
dependency-bearing `thread.create` (findings 2 + round-2 finding 1); R3 M4 attention on an
edge onto an already-cancelled dep (finding 3); the cancel-cascade M4 attention scan.

Files: `apps/server/src/orchestration/decider.ts`,
`decider.cancelCascade.test.ts`, a `thread.dependencies.set` / `thread.create` decider
test (extend `commandInvariants.test.ts` or a small `decider.dependencies.test.ts`,
following the existing decider-test fixture style).

Acceptance:

- Tests 11, 11b, 11c, 12 green; existing cancel-cascade tests audited/updated; `vp check`
  and `vp run typecheck` pass.
- Cancel emits `needs_guidance` only for un-started, non-terminal, outside-subtree
  dependents with a gating (same-parent) dep in the cancelled set.
- `thread.create` and `thread.dependencies.set` from the web board / client-runtime
  reject cyclic and non-sibling/dangling dependency sets, and raise M4 attention on an
  edge onto a cancelled dep — closing the non-MCP bypass so the invariant holds on every
  surface.

## Deviations from the audit / brief

1. **M5 cycle handling** lands in _three_ places, all **fail-fast reject** (round-1
   review, finding 4, aligned the spawn leg to the approved "reject fail-fast"): the
   spawn handler (S7 — rejects spawning behind an already-cyclic sibling set), the
   set-deps handler (D2), and the decider backstop R1 (covering the web board /
   client-runtime, which dispatch `thread.dependencies.set` **and** `thread.create`
   directly). The audit located M5 at the handlers only; the decider backstop is the net
   addition, and it makes a pre-existing sibling cycle unreachable going forward.
2. **L7 warns via `roleDefaultIsolation`'s writer/reader split** rather than a role
   allowlist — roles are free text by design, so "non-coder ⇒ reject" would break
   legitimate free-text writer roles. Warn-only, keyed on reader-default roles
   (reviewer/researcher/shipper).
3. **M4 is surfaced on all four orderings**: a spawn/set-deps handler warning (dep
   already cancelled at wiring time, MCP path), the decider cancel-cascade attention scan
   (dep cancelled after the edge exists), and the decider R3 attention scan (edge wired
   onto an already-cancelled dep from the web board). The audit offered a single
   mechanism; the surface-independent decider scans are the additions that close the
   non-MCP paths (round-1 review, finding 3).

(The round-0 draft additionally left `thread.create` permissive and sourced siblings from
active+archived; both were corrected under round-1 review findings 2 and 1 respectively —
see §"Where validation lives" and §"Sibling set source".)

## Risks

- **Sibling-set read source (resolved under finding 1):** dependency-target validation
  must use the _same active set the dispatcher gates on_ (`getShellSnapshot`), not the
  wider active+archived visibility scope. Rejecting a dep onto an archived sibling is
  correct, not a false positive — such a dep is either meaningless (the archived thread is
  already terminal) or would release via the dangling→satisfied path, i.e. the silent
  mechanism being eliminated. Auth and `workstream_list` keep their wider
  `collectGraphThreads` scope; only dependency-eligibility narrows.
- **Warning fatigue:** every warning here fires on a genuine wiring anomaly, not on
  routine use; S3's injection notice is the only one expected in normal flows, and only
  when the agent omitted the id. Acceptable.
- **`decider.cancelCascade` fixtures** may embed event-count assertions that the M4
  events shift; WP2 must audit them rather than blindly appending expectations.
- **Message drift:** the exact strings above are contracts with LLM consumers in spirit,
  not in bytes — coders may polish wording but must keep the two components: _what was
  wrong_ and _what to do instead_.
