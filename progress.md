# Progress — DB-authoritative goals & tasks migration

Status: COMPLETE — all phases done; typecheck + lint:mobile pass; goal CLI round-trip validated. vp check has only pre-existing lint debt (untouched ProviderRuntimeIngestion.test.ts).

## DB lane D3 consults

- 2026-07-06: consulted plan author `9eb90884-ecb2-4f0e-970b-926ad1ae06bb` via `docs/plans/db-lane-reader-writer-split.md` about the CLI token path ambiguity. **Confidence: high.** Decision: use `ServerSecretStore` with secret name `cli-token` (actual file follows store convention: `cli-token.bin`) rather than bypassing the store for an extensionless path.

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

---

# Provider exhaustion failover — Chunk B (health registry + classification)

Status: COMPLETE — `vp run typecheck` PASS (0 errors); `vp check` PASS for all
changed source files; new registry unit test PASS (8).

## Manager consult (recorded per plan §11 requirement)

- Author: `fc530ab2` (plan role, docs/plans/provider-exhaustion-failover.md).
- Question: Codex explicit `limit_reached` reaches the health registry how, given
  the poller dropped the flag and it wasn't on `AccountUsageSnapshot`?
- Decision: **Option 1** — add an optional, provider-agnostic `limitReached?:
boolean` to `AccountUsageSnapshot`, populate in the poller's `feed()`, and mark
  account-wide on it. Confidence: **medium**. (Do NOT collapse into ≥99%.)

## Delivered

- Contracts: `RuntimeErrorClass += "quota_exhausted"` (+ exported schema);
  `AccountUsageSnapshot.limitReached?`; `ProviderSession.lastErrorClass?`;
  `OrchestrationSession.lastErrorClass?`; `ProviderFailoverSettings` (+ ServerSettings
  field + patch); shared `applyServerSettingsPatch` shallow-merges providerFailover.
- `ProviderHealthRegistry` service+layer (marks keyed (accountKey, modelScope),
  telemetry ≥99% / Codex flag / error sources, 30-min error TTL, <97% + until-passed
  clearing, soft-pause from settings). Server layer wiring: bundled with
  AccountUsageRegistry into one provideMerge step after hydration.
- `exhaustionMapping.ts`: `PI_QUOTA_ERROR_RE`, `classifiesAsQuota`,
  `accountKeyForModelSlug` / slug-namespace→accountKey table.
- PiDriver: quota classification BEFORE transient ladder (regex OR
  transient+corroboration), `markExhausted` (source error), fail with
  `quota_exhausted`; NO rerouting (chunk C). Direct adapters (Codex/Claude):
  classification only (§9).
- lastErrorClass plumbed end-to-end: ingestion → thread.session.set →
  ProjectionPipeline → migration 051 (last_error_class) → repo SQL → snapshot query.

## Decisions / notes

- Direct adapters classify only (no markExhausted) — §9 scopes them to
  classification; the poller marks their accounts within ≤60s.
- Error-sourced marks are model-scoped (conservative) unless account-key only.

## Pre-existing FAILS (NOT mine — reproduce with my changes stashed)

- `ProjectionSnapshotQuery.test.ts` ×1 (projection_projects.workspace_root unique,
  migration 050).
- `ProviderRegistry.test.ts` ×3 (Pi-fork provider-name drift — see prior entry).
- `vp check`: only `docs/plans/provider-exhaustion-failover.md` (planner-committed,
  not in my diff) + gitignored `.pi-subagents/` artifacts.

## Chunk F (UI/settings) — manager consult 2026-07-06

- Q: concrete-slug chain editor vs <m>-templated §5.2 defaults.
- Author fc530ab2 (role=plan), confidence MEDIUM → Option (b): editor renders all §5.2 default chains; target picker = concrete catalogue slugs ∪ one "Same model on {provider}" entry per namespace, PERSISTED as the bare namespace string that resolveFailoverTarget substitutes. Value grammar = concrete slug OR bare namespace. No other placeholder syntax.
- Escalate only if chunk C landed a chains schema rejecting namespace-only targets (it hasn't; contract is Record<string,string[]>).
- F decision: seed 3 wildcard source rows (openai-codex/_, anthropic/_, google-vertex-claude/_); anthropic/_ chain = [google-vertex-claude(same-model), anthropic/claude-opus-4-8] — resolver skip-exhausted covers model-scoped vs account-wide. DEFAULT_FAILOVER_CHAINS lives in packages/shared (single source for F editor + chunk C resolver) — C/F integration seam.

## Usage dashboard 5h-graph + pooled-meter scope fixes — 2026-07-13

- **Bug 1 (all 5h graphs squashed):** ChatGPT `wham/usage` now reports the
  weekly window in the `primary_window` slot (`limit_window_seconds: 604800`,
  `secondary_window: null`). `piQuotas.codexWindow` and the CodexAdapter
  rate-limits path trusted the slot name, so a 7-day window registered as the
  5-hour meter and (via freshest-reset fallback) poisoned every tab's window
  boundaries. Fix: classify by the window's own duration (>24h ⇒ secondary),
  slot name only as fallback.
- **Bug 2 (boundary scope match):** scope tabs send backend ids ("anthropic")
  but boundary matching compared storage keys ("claudeAgent") — never matched,
  always fell through to freshest snapshot. Fix: match via
  USAGE_METER_PROVIDER_NAMES, prefer usable reset, then freshest.
- **Pooled-meter scope mapping (cliproxy):** consulted plan manager
  (90713a56, confidence MEDIUM) → explicit declared coverage, never inferred
  (inference can't distinguish pooled-subscription cliproxy from API-billed
  vertex on the same instance). Added optional `providerIds` to
  `ProviderUsageSource`, flowed as `meteredProviderIds` through
  AccountUsageSnapshot → poller → ServerUsageBreakdownGauge; server boundary +
  row filter and client gaugeAppliesToScope/deriveUsageScopeTabs/
  isMeterlessProvider all extend the static meter→backend map with it.
  Pill deep-link scope ("pi\0carl@") now filters rows via declared coverage.
- Updated docs/providers/claude.md example + local settings.json
  (providerIds: ["cliproxy"] on both sources). Server restart needed.

## ask_user_question settlement: SDK-provider supersede delivery — 2026-07-29

- Q: the revised design's commitment 3 says a superseded question's message is
  delivered **as the tool result**. Pi can do that (its broker poll carries the
  prose). The five other providers cannot: Claude's `canUseTool` result is
  allow-with-answers or deny-with-a-message, Grok's ask_user_question models only
  accepted/cancelled, Cursor's and Codex's responses are answers maps, and
  OpenCode's `question.reject` takes no body. Releasing those callbacks with a
  bare cancellation would drop the human's message.
- Consulted the author of the current indefinite-blocking revision,
  `5185872f-ccf7-438e-91a1-1c47f1e74e73` (role=plan). **Confidence: HIGH.**
  Decision: **Option 1 — accept the exactly-once new-turn fallback and amend the
  plan to say so.** This is delivery mechanics within the settled design, not a
  departure from it, so no escalation. Acceptance is conditional on three
  invariants, all now implemented and regression-tested:
  1. **Release-before-turn, proven not assumed.** The callback must have handed
     its result back before the fallback turn dispatches. Completing a `Deferred`
     is _not_ proof (it only makes the value available to the blocked fibre), so
     each adapter carries an explicit `released` signal completed at the real
     boundary — for Claude that is after the SDK's promise settles, for OpenCode
     it is OpenCode's own `question.rejected` event (bounded by a timeout so a
     missing event cannot strand the message). `respondToUserInput` awaits it
     before reporting `deliveredContent: false`.
  2. **Exactly-once, durably.** The fallback turn's command id is derived from the
     causative settlement event (`server:user-input-late-delivery:<requestId>:<eventId>`),
     so a reactor retry or event redelivery is receipt-deduped instead of
     delivering an action-bearing message twice. The settlement helper likewise
     allocates its resolution id _outside_ its retry.
  3. **The released callback frames the handoff.** Not a bare `cancelled`:
     `renderUserInputOutcomeHandoff` says the questions are settled, the user's
     message arrives as the next message, and the model must not assume or re-ask.
     OpenCode is the one exception — `question.reject` has no body — so there the
     framing rides the fallback turn's opener alone.
- Also settled here: **first-terminal-wins is enforced in the decider**, not by a
  projection pre-check. A pre-check reads then dispatches, so a settlement
  committing in between still lets an adapter's delivery echo land second and
  leave one request carrying two contradictory terminal outcomes. The decider runs
  inside the engine's serialised command queue against the just-committed read
  model, so the check and the write are atomic; a rejected echo is expected and
  tolerated by ingestion.
