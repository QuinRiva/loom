# Progress — DB-authoritative goals & tasks migration

Status: COMPLETE — all phases done; typecheck + lint:mobile pass; goal CLI round-trip validated. vp check has only pre-existing lint debt (untouched ProviderRuntimeIngestion.test.ts).

## Plan phases

- [x] Phase 1: Contracts + decider + invariants + in-memory projector + goalTaskTree helper.
- [x] Phase 2: SQL migration 035, ProjectionGoals repo, ProjectionPipeline goals projector, ProjectionSnapshotQuery goal assembly.
- [x] Phase 3: vcs/http.ts (/api/vcs/diff relocated), removed GoalsService/GoalPackage/goal http, server wiring updated.
- [x] Phase 5 (server side): goal CLI (cli/goal.ts + shared orchestrationMutation.ts), buildGoalSystemPrompt rewritten to DB+CLI.
- Server package `tsgo --noEmit` PASSES (incl tests).
- [ ] Phase 2: SQL projections + snapshot query
- [ ] Phase 3: Server API/WS/store integration + relocate /api/goals/diff
- [x] Phase 4: Web cutover — store goals slice + selectors, types goalId, Sidebar/ChatHeader/GoalTasksPanel/\_chat.index use store goals, goalIndex.tsx removed, DiffPanel -> /api/vcs/diff, client-runtime reducer + mobile fixtures.
- [x] Phase 5: goal CLI + DB-state system prompt.
- [x] Phase 6: deleted GoalsService/GoalPackage/goal http; marked goal-index-ws-push.md superseded + goal.md non-authoritative.
- [x] Phase 7: vp run typecheck PASS (15 pkgs); vp run lint:mobile PASS; focused unit tests PASS (38); goal CLI real-DB round trip PASS; vp check fmt applied (only pre-existing lint error remains).

## Notes / findings

## Notes / findings

- Consulted author session `/home/Carl/.pi/agent/sessions/--home-Carl-pi-frontend--/2026-06-23T12-55-13-430Z_019ef48c-9116-7f8f-b240-e6d7727121f2.jsonl` about `036_CanonicalizeReasoningEvents.ts` after reviewer flagged it as unrelated. Confidence: medium. Guidance: keep migration 036 in this branch as an explicitly documented enabling runtime-data fix because it restored dogfood startup after a reasoning-event decode failure; escalate only if strict feature isolation is required.

## Review fixes (gpt55-review.md)

All must-fix issues addressed (see
`plans/db-goals-and-tasks-migration.fix-implementation.md`):

- [x] 1. Shell stream emits goal-upserted/goal-removed for goal/task events
     (ws.ts `toShellStreamEvent` goal branch + new `getGoalShellById`).
- [x] 2. client-runtime `shellSnapshotReducer` handles goal-upserted/goal-removed;
     `threadDetailReducer` applies `goalId` on thread.meta-updated. (web store
     already handled both.)
- [x] 3. Project-scoped goal assignment: thread.create/meta.update use
     `requireActiveGoalInProject` (active + same project); clearing goalId still ok.
- [x] 4. Slug uniqueness matches DB constraint: deleted goals still reserve
     slugs (`requireUniqueGoalSlug` no longer filters deletedAt).
- [x] 5. `projection.goals` added to REQUIRED_SNAPSHOT_PROJECTORS.
- [x] 6. Archive coherence: `toGoalShells` excludes archived; task mutations and
     goal assignment require active goal (`requireGoalActive`).
- [x] 7. Task reparent disallowed for MVP: `parentTaskId` removed from
     goal.task.update command/payload + decider/projector/projection; create still
     sets parentTaskId.
- [x] 8. Migration 036 documented in-file as an enabling dogfood runtime-data fix.

Validation: `vp run typecheck` PASS (15/15); focused tests PASS (server
orchestration 36, ProjectionRepositories 2, client-runtime 188/189 — the 1
failure is pre-existing default-model drift in addProject.test, unrelated; web
store 17). `vp lint` clean except the pre-existing
ProviderRuntimeIngestion.test error.

## Open decisions / escalations

---

# Liveness redesign Phase 3 — recoverable-stall response (State C)

## Decisions / consults

- **Auth gate (system-driven recovery nudge).** Consulted the status-model
  author `/home/Carl/.pi/agent/sessions/--home-Carl-.t3-cockpit-worktrees-pi-frontend-t3code-df4695a1--/2026-06-29T02-44-14-373Z_587eb0f7-db32-4147-ab5e-d898a81a88b4.jsonl`
  (resolved by ABSOLUTE PATH — the manifest id `587eb0f7…` lives under the
  `df4695a1` worktree slug, so a bare-id consult from this `c61cd9a0` worktree
  hit the id-scoping trap and returned "No session found"; the file was on disk
  all along). **Confidence: medium.** Ruling: §8's start/stop reservation
  targets agent/human actors; the control plane already drives `server:`-prefixed
  turn-starts pervasively. A `server:`-prefixed steer into an ALREADY-OPEN turn
  that writes neither `in_progress` nor stored attention is, by the model's own
  definition, **not a "start"** → **Option 1 sanctioned.** Hard guardrail: the
  nudge may fire ONLY when the turn is genuinely open (`activeTurnId` set); if
  null, `sendTurn` would start a fresh turn (a real §8 start) — not allowed.

## Implementation (Phase 3 — State C)

- `apps/server/src/orchestration/stallContext.ts` (new): pure `extractStallContext`
  (last meaningful event from a pi JSONL — errored toolResult or last assistant,
  whichever is last), `renderStallContext`, and `readThreadStallContext` (resolves
  the thread's deterministic pi session file via `piSessionIdForThread` +
  `resolveSessionFilePath`, reads it, never fails the sweep).
- `WorkstreamLivenessSweep.ts`: split `markError` into `markDead` (State A →
  attention `error`, unchanged) and the State-C ladder. `stalled` verdict now
  carries `effectiveActivityMs` (the stall-episode key). New pure
  `decideStallAction` (nudge first sweep / escalate when still frozen / re-arm on
  heartbeat advance / escalate if no open turn). `nudgeStall` drives ONE
  `thread.turn.start` (no `requireIdle`/`setInProgress`) → PiDriver steers it into
  the open turn; `escalateStall` raises **`needs_guidance`** (NOT `error`) with the
  extracted context. Serial-safe `stallNudges` Map mirrors `failureCounts`.
- Transport: existing send-turn path (`thread.turn.start` → ProviderCommandReactor
  → `providerService.sendTurn` → `streamingBehavior:"steer"` for an open turn). No
  new transport. `server:`-prefixed, episode-keyed command ids (idempotent within
  an episode, re-armable across episodes).
- Gates: `vp run typecheck` PASS; `vp check` PASS (0 errors; 13 pre-existing web
  warnings). New unit tests PASS (stallContext 9, sweep 12 incl. ladder +
  nudge-message + effectiveActivityMs). Pre-existing FAILS (NOT mine, confirmed by
  stashing my changes): `ProviderCommandReactor.test.ts` ×2 (title-match poll
  timeouts) and the noted `serverRuntimeStartup.test.ts:30` default-model drift.

---

# Liveness redesign Phase 2 — State D (possibly spinning)

## Decisions / consults

- **Fingerprint signal inversion (architecture author, `.plans/liveness-detector-redesign.md`, id 2d4d011f).
  Confidence: HIGH.** §3d literally names the checkpoint diff as the primary
  progress signal. Recorded evidence (thread `48d7345f`) proves checkpoints
  materialise only at TURN END — that 4-min / 8-edit run produced exactly ONE
  `projection_turns` checkpoint row, written at the final timestamp. Sub-threads
  run a single kickoff turn, so the checkpoint diff is flat for the entire
  working turn and cannot tell slow real work from spinning. Ruling: **invert** —
  the within-turn tool-call CONTENT (`data.rawInput`, falling back to
  `data.details.diff`) is primary; checkpoint source is OR-folded as a cross-turn
  corroborator (either advancing re-arms). Hard guardrail from the author: digest
  the ACTUAL content, never the display projection (the display string
  re-collapses distinct calls — the exact retired-loop-detector bug).
- **Attention reason for a system advisory (status-model author,
  `.plans/workstream-state-model-design.md`, id 587eb0f7). Confidence: HIGH.**
  State D raises attention **`needs_guidance`** (system-raised, non-terminal),
  NOT `error`. The auth table's "raised by: agent" entry describes the agent tool,
  not exclusivity — the design already has the system raise `needs_guidance`
  (dispatcher idle backstop, Phase 3 stall escalation), and the decider only
  gates `error` as server-only. `error` would over-escalate a heuristic to a
  failure verdict, reintroducing the false-failure ambiguity the redesign removes.
  (A dedicated `possibly_stalled` reason would be a new product decision — not
  taken.)

## Implementation (Phase 2 — State D)

- **Kill switch:** `const ENABLE_STATE_D = true` at the top of
  `WorkstreamLivenessSweep.ts`. It gates the `busy` predicate in the in-loop
  branch, so flipping it to `false` short-circuits the entire State-D branch with
  zero other edits; the branch, its `progressLoop` map, pure helpers, threshold
  fields, and `adviseProgressLoop` closure are all labelled "State D" for one-pass
  deletion.
- **Fingerprint:** new `ProjectionSnapshotQuery.getThreadProgressSignal` pulls,
  in ONE query over already-persisted rows (no git diff recompute), the latest
  `progressInputSampleSize` (16) tool calls' raw content joined + the latest
  checkpoint turn-count/files JSON. Pure `computeProgressFingerprint` cyrb53-hashes
  the two opaque sources into a compact per-thread fingerprint. **Performance:**
  read-only indexed rows, run only for genuinely-busy sub-threads (open turn past
  grace) — never a per-sweep diff for every thread.
- **Detection:** State D fires only when BOTH (a) the thread is busy — open turn
  past `startupGraceMs`, heartbeat fresh (a frozen heartbeat is State C, returned
  as a non-null verdict before this branch) — AND (b) the fingerprint stays flat
  across `noProgressWindowMs` (10m default, tunable). Pure `decideProgressLoop`
  re-arms (resets the flat clock, clears `advised`) on any fingerprint change, so
  a growing/oscillating diff NEVER advises.
- **Response:** `adviseProgressLoop` appends an `info` activity
  (`workstream.liveness.progress-loop`, with busy-minutes + evidence) and raises
  attention `needs_guidance`. Sets NO plan lane, never kills the thread; fires at
  most once per episode (episode-keyed `server:` ids; the attention flag also
  makes the next sweep skip the thread until it clears). Re-arms when work
  resumes (attention clears → fingerprint advanced).
- **Gates:** `vp run typecheck` PASS (15/15); `vp check` PASS (0 errors, 13
  pre-existing web warnings). New unit tests PASS (sweep suite 23 incl. 9 State-D
  cases; ProjectionSnapshotQuery 9). Recorded-evidence validation: simulated the
  real sweep logic over thread `48d7345f` — State-D advisory NEVER fires (3
  distinct fingerprints across 3 busy sweeps → real edits re-arm every sweep; and
  the 3.8-min run never reaches the 10-min window regardless).
- **Pre-existing FAILS (NOT mine — identical 6 failures with my changes stashed):**
  `ProviderCommandReactor.test.ts` ×2 (title-match poll timeouts),
  `serverRuntimeStartup.test.ts:30` (Codex default-model drift),
  `ProviderRegistry.test.ts` ×3 (provider-name drift: `pi` vs codex/cursor/… —
  the Pi-fork).
