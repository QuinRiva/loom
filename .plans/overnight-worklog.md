# Overnight autonomous worklog (workstreams feature)

Carl is asleep (~8h block). I'm driving the workstream feature to "fully built +
tested", making reasonable decisions, documenting them here. Everything is on the
throwaway `workstreams-ui` branch and is revertible.

## State at start of block
Committed on `workstreams-ui`:
- `3544ea3` chore(format) — pre-existing formatting debt isolated
- `8cf3d92` feat Phase 1 — sub-thread lineage (parentThreadId/role/goal), hidden from sidebar, Workstream panel from real projection data
- `7b7c3c6` feat A — agent-driven autonomous spawn (pi tool → scoped HTTP endpoint → thread.create + thread.turn.start)
- `740e314` feat B — Board + Graph views in the panel
- gates: `vp run typecheck` + `vp check` GREEN (0 errors; 12 pre-existing warnings)

## Plan for the block
1. Review A+B (async reviewer `6ae98bbb`) + ensure up/working. ✅ launched
2. Implement Phase C = status state machine + dependency edges, split C1 (data
   model + projection + UI) then C2 (agent-facing setters). Plan:
   `.plans/phase-c-status-and-dependencies.md` (signed). C1 worker `2da07e53`
   launched async.
3. Review C1, then C2, then C2 review. Fix all blockers.
4. Final combined gates + a headless runtime smoke (server boot + WS/HTTP
   round-trip for spawn/status/deps → projection/board). GUI render can't be
   verified headlessly — will document that gap.
5. Commit everything; update this log with decisions + outcomes.

## Key decisions (see phase-c plan for full rationale)
- D1: `status` explicit+authoritative, default `planned`; board/graph use an
  effective-status precedence (review/done > unmet-deps⇒blocked > running >
  planned). Transitions permissive (not hard-validated) so an autonomous agent
  can't get wedged.
- D2: dependencies via `blockedBy: ThreadId[]`, replace-set semantics; graph
  draws "waits-on" edges; tolerate cycles/dangling/self.
- D3: C1 = manual UI controls; C2 = agent setters scoped to own/child threads.
- Process: run workers SEQUENTIALLY in the one bootstrapped worktree (NOT
  parallel worktrees — sibling `pnpm install` corrupted node_modules earlier).
  The one concurrency I allowed: C1 worker alongside the READ-ONLY A+B reviewer.

## Running
- reviewer 6ae98bbb (A+B) — running
- gpt55-worker 2da07e53 (C1) — running

## Log
- (will append outcomes as async jobs complete)

## Morning update (Carl back)
Commits added: `473c3d1` C1 (status+deps), `1ec56ec` fix (graph overlap + always-rewrite extension).
Reviews done: A+B (no blockers; 2 safety should-fixes + minor), C1 (no blockers; graph-overlap should-fix → fixed).

### Owner decisions (override the reviewer's safety should-fixes)
- Fork-bomb hard cap: NOT added (reverted my depth cap). Owner will MONITOR and
  plans to *expose agent count* to the user rather than hard-cap. MVP: non-issue.
- Shared-worktree corruption: NOT guarded. Same risk already exists in the
  current subagent model; trust the orchestrator to avoid overlapping parallel
  work. Revisit (worktree-per-child) only if it bites. Phase 4 candidate.

### Kept fixes (genuine bugs, not safety guards)
- Graph node overlap (pitch 99 < node width 126) → pitch 132 + viewBox 684 + root recenter.
- Generated pi extension now rewritten unconditionally (was pinned by existsSync).

### In flight / next
- C2 (agent-facing status/dependency setters, auth = own-or-child) → worker a3be6369.
- After C2: review C2; run apps/server test suite to exercise migration 036 +
  projection round-trip against real SQLite (closes the "migration not run live"
  gap C1 flagged); then a headless server-boot smoke if feasible; final gates.

## Verification results (runtime — closes the "never booted" gap)
- `vp run typecheck` + `vp check`: GREEN at HEAD (0 errors; 12 pre-existing warnings).
- Server test suite (persistence + orchestration): **24 files / 166 tests PASS**
  against real temp SQLite — exercises projector, migration 036, status/blockedBy
  projection round-trip.
- Headless server-boot smoke (isolated T3CODE_HOME, port 13901): server boots,
  **all migrations (incl. 036) apply on a fresh DB**, listening OK; the three
  workstream endpoints (/spawn, /status, /dependencies) all return **401 without
  auth** → routes mounted + credential gate enforced at runtime.

## Still UNVERIFIED (needs Carl's browser + model creds — cannot do headlessly)
- Live model→tool→endpoint path (a real pi agent calling workstream_spawn /
  set_status / set_dependencies and the D3 403 on a non-child).
- GUI render of the Board/Graph in the actual web app.

## C2 status
Committed `114750b` (worker finished + committed itself; the "killed" alert was a
false alarm). Reviewer 6e8af804 running.

## FINAL — all phases built, reviewed, verified
- C2 reviewed (6e8af804): no blockers; 1 should-fix (empty `blockedBy` id defect)
  FIXED in `3e04582`. All A+B / C1 / C2 review findings now resolved or
  consciously deferred per owner (fork-bomb cap, worktree isolation).
- Commits: Phase1 8cf3d92 · A 7b7c3c6 · B 740e314 · C1 473c3d1 · graph/ext fix
  1ec56ec · C2 114750b · blockedBy fix 3e04582 (+ docs/worklog).
- Gates green; 166 server tests green; server boots + migrations(036) + endpoints
  401-gated. Remaining unverifiable headlessly: live model→tool path + GUI render.

## Breadcrumb (Option B) — complete
- Implemented `cb96967`, review fixes `2ff6295`. Gates green (typecheck/check + 6-case
  lineage unit test). Reviewed (107ce6b8): no blockers; both Should-fixes applied
  (stable EMPTY_LINEAGE for perf; explicit isRoot flag vs positional heuristic).

## Merge into main — analysis done, DECISION PENDING (owner)
- Conflict analysis (f3dff1df): 36 files; root cause = divergent goal model
  (main: goalId entity + deleted goal/ module, "no coexistence"; ours: goalSlug +
  additive fields). Migration 035/036 collision → renumber ours 037/038. Report:
  `.plans/merge-conflict-analysis.md`.
- consult_manager(goals plan author 94da13f3) ATTEMPTED → FAILED: session not on
  this machine ("No session found"). Per guidance (snapshot unreachable on a
  load-bearing call) → escalated to Carl. Confidence: N/A (no answer).
- Escalated decision: (1) sub-thread goal association under main's goalId model
  (recommend: inherit parent's goalId), (2) rename free-text `goal`->`purpose`,
  (3) go-ahead to rebase. NOT starting the 36-file rebase without sign-off.

## Architecture rebase — APPROVED by owner, in progress
- consult_manager: tried doc-manifest id (94da13f3) AND owner-provided id
  (019ef70d-778c-7a6c-95a1-9dc24b41d8de) AND session_read/session_search — ALL
  "no session found" / no match. The goals-work session is not on this machine.
  Fallback (per guidance): use main's committed code + the signed plan doc as the
  authoritative source (more authoritative than a chat snapshot for a rebase).
- Owner approved the rebase + my recommendations: adopt goalId / drop goalSlug,
  sub-threads inherit parent goalId, rename free-text `goal`->`purpose`.
- Recon (main): highest migrations 035_GoalsAndTasks/036_CanonicalizeReasoningEvents
  -> ours renumber to 037/038; main deleted file-centric goal/ module (replaced by
  goalTaskTree + ProjectionGoals); ThreadCreateCommand uses goalId optional NullOr;
  goalSlug = 0 refs on main.
- Mechanic: worker 5f88eb65 creates `workstreams-on-main` off main, `git merge
  --squash workstreams-ui`, resolves all 36 conflicts once (squash-once over
  13-commit rebase for tractability/reviewability; main + workstreams-ui left
  intact). DoD: typecheck+check green, server persistence/orchestration tests
  pass, lineage test passes. Then a reviewing agent reviews (owner-required).

## Rebase COMPLETE — ready to merge to main
- Branch `workstreams-on-main` = e60625a (single squash commit) on top of main 49f7eb5.
  main + workstreams-ui left intact. HEAD~1 == main.
- Reconciliation review (a4fa3497): NO blockers / no should-fixes. Verified: 0 goalSlug
  survivors, goal->purpose complete + tool-arg/endpoint field names agree, spawn inherits
  parent goalId, migrations 037/038 (no dup goal_id, no number clash), unions keep both
  sides, goal-module port clean, no dropped feature logic, replay-safe.
- My independent verification: typecheck 0, vp check 0 errors (11 pre-existing warnings),
  server persistence+orchestration 167/167, lineage 6/6, AND fresh-DB boot smoke (full
  migration chain incl 037/038 applies; workstream endpoints mount + 401-gate).
- Non-blocking notes: status transitions intentionally permissive (no hard state machine);
  main's goalId has no decode-default (main's pre-existing choice, untouched).
- STILL unverified (needs Carl's browser + model creds): live model->tool->spawn loop and
  GUI render. Suggested merge: `git checkout main && git merge --ff-only workstreams-on-main`.

## Status self-reporting fix (#1+#2) — COMPLETE
- Commit 0f3488e: threadId optional (defaults to caller's own thread) on status/deps
  endpoints+tools; childPrompt instructs child to set done/review/blocked; spawn sets
  child 'running' after turn.start. Verified by me: typecheck 0, vp check 0 errors,
  server suite 167/167. Reviewed (2ffa1c3f): NO blockers (default-to-self safe, no
  defect, #2 no race, scope clean). Residual (Phase D): 'running' is optimistic.
- Phase D plan signed+committed (1a4ca3b): .plans/phase-d-dispatcher.md.

## READY TO MERGE
Branch `workstreams-on-main` = full workstream feature on main's goal model + status
fixes, all reviewed, gates+tests green, fresh-DB boot verified. main + workstreams-ui
intact. Merge: `git checkout main && git merge --ff-only workstreams-on-main`.
Remaining manual validation (Carl's machine): live model->tool->spawn loop + GUI render.
