# pi-frontend progress

> Rewritten 2026-06-15 by the continuation worker after reconciling the on-disk
> state against `goals/pi-frontend/architecture-plan.md`. The previous notes
> badly understated what was actually built (it claimed Phases 2–3 "not started"
> — in fact the entire Goal aggregate is on disk and compiles).

## Canonical commands (Phase 0 — established & verified)
- Boot/dev: `pnpm dev` (server+web) or `pnpm dev:server` + `pnpm dev:web`.
- Server start (built): `node apps/server/dist/bin.mjs start --host 127.0.0.1 --port <p> --no-browser <cwd>`.
- Typecheck: `pnpm typecheck` (`vp run -r typecheck`). **Currently GREEN (exit 0).**
- Build: `pnpm build`. Lint/format: `pnpm exec vp check`.
- Node engine wants `^24.13.1`; runtime here is v22.22.1 (pnpm warns, builds/runs fine).
- pi: `pi` 0.75.5 on PATH, authenticated (real `get_state` + `prompt` → `PONG` confirmed).

## Ground-truth phase status (verified by reading on-disk code + real pi)

### Phase 0 — Fork & bootstrap — DONE (functional), de-clouding NOT done
- Fork builds/typechecks/boots; git repo on `throwaway-pi-frontend`, **0 commits** (all changes uncommitted/untracked).
- pi-only registration DONE: `BUILT_IN_DRIVERS = [PiDriver]`; `PiSettings`/`PI_DEFAULT_MODEL` added; deterministic git titles/branches (no codex text-gen). (§1.6)
- **De-clouding NOT done**: `infra/relay`, `apps/server/src/cloud/` (Clerk) still present. App still boots pi-only; de-clouding is cleanup, deferred (see Deviations).
- `packages/tailscale` + `--host` flag retained (correct per §1.7).

### Phase 1 — pi over RPC — DONE & VERIFIED end-to-end against real pi
- `PiDriver.ts` + `Layers/Pi/{RpcProcess,Cli}.ts` written, compile, map pi events → `ProviderRuntimeEvent`. Borrowed bigbud transport + upcomputer shell shape per §1.5.
- Verified against real pi RPC protocol (`rpc-types.d.ts`, `rpc-mode.js`):
  - `prompt` response = fast preflight ack (NOT turn-end), so the 30s `request` timeout is correct.
  - Event shapes (agent_start/turn_start/message_update{text_delta,thinking_delta}/tool_execution_*/turn_end/agent_end) match the driver mapping.
- **BUG FOUND + FIXED**: driver mapped ALL `extension_ui_request` → `user-input.requested`. Only `select`/`confirm`/`input`/`editor` need responses; `notify`/`setStatus`/`setWidget`/`setTitle`/`set_editor_text` are display-only and pi emits several on startup — they would have spammed the UI with bogus prompts. Now filtered.
- **VERIFIED (real pi 0.75.5)**: `apps/server/src/pi-e2e-check.ts` drives the real `PiDriver` adapter against a real `pi --mode rpc` in a real git worktree. Result PASS: `session.started`/`thread.started` → assistant tool call (`write`) → `file_change` item.started/completed → real on-disk edit (`pi-e2e.txt`, shows in `git status`) → streamed `assistant_text` deltas ("DONE") → 2-turn lifecycle + `agent_end`. Exercises PiDriver + RPC transport + full event mapping. Re-run: `node apps/server/src/pi-e2e-check.ts <git-dir>`.
- **Server boot smoke**: `node apps/server/src/bin.ts start --host 127.0.0.1 --port <p> --no-browser <cwd>` → HTTP 200, pi registered, no provider/default/codex errors (only harmless "T3 Connect config missing" cloud standby).
- Layer not exercised by me: React rendering + the ws RPC protocol wrapper (no browser tool). The adapter-level e2e covers decider-independent provider correctness.

### Phase 2 — Goal aggregate + 3-tier nav — aggregate ~DONE, worktree-reloc + sidebar NOT done
- Goal aggregate touchpoints (§1.1) DONE & compiling: `OrchestrationGoal` + `"goal"` kind + goal events/commands/payloads + `goalId` on thread types (contracts); `GoalId` brand (baseSchemas); decider goal create/meta/delete + invariants (`requireGoal`/`requireGoalAbsent`); projector goal handlers + thread `goalId`; event-store aggregate-id union includes `GoalId`; migration `033_ProjectionGoals.ts` registered; `ProjectionGoals` repo/layer/service; `ProjectionPipeline` + `ProjectionSnapshotQuery` goal wiring.
- **§1.4 worktree relocation NOT done**: `OrchestrationThread`/create-command/created-payload still carry `worktreePath`/`branch`; `ws.ts` bootstrap still resolves the thread's own worktree; goal-as-worktree-owner not wired. `thread.create` only validates `goalId` when present (goalId still OPTIONAL — not yet a hard `requireGoal`).
- **§1.6 Sidebar goal tier NOT done**: `Sidebar.tsx` has zero goal references.

### Phase 3 — Goal package files + spine — discovery/parser DONE & VERIFIED; rendering/diff NOT done
- **DONE & VERIFIED (real files)**: `apps/server/src/goal/GoalPackage.ts` — the sole reader of the `goals/<slug>/goal.md` convention (§1.2). Pure `parseGoalMarkdown` (anchors `# title` / `## Goal` paragraph / `## Tasks` nested checklist tree), `taskProgress`, plus `listWorktrees` (`git worktree list --porcelain`) and `discoverGoals(workspaceRoot)` (scan each worktree for goal packages). Verified: nested-tree parse correct; real `git worktree list` discovery found the dogfood goal `goals/pi-frontend/goal.md` (6/11 tasks, title/paragraph/branch/packagePath extracted). Typecheck-clean.
- **Dogfood artifact**: `goals/pi-frontend/goal.md` created (this project's own goal package; the real discovery target).
- **NOT done**: wiring discovery → `goal.created`/`meta-updated`/`deleted` (a reactor calling `discoverGoals` and emitting goal commands per §1.1 sync rules); `## Goal` + `## Tasks` deep-view rendering; goal overview UI; diff-panel (`DiffPanel.tsx` / `@pierre/diffs`) wiring to the goal workflow (`git diff` vs HEAD).

## Recommended next-worker sequencing (UI phases need browser verification)
1. **Wire goal discovery → aggregate** (server-only, verifiable): a reactor that runs `discoverGoals(project.workspaceRoot)` and emits `goal.created`/`meta-updated`/`deleted` per §1.1. `GoalPackage.ts` is ready to consume.
2. **§1.4 worktree relocation** — BLAST RADIUS: `worktreePath`/`prepareWorktree` read in ~22 server files + ~12 web files + client-runtime + contracts (`grep -rl worktreePath apps packages`). Key nodes: `ws.ts` turn-start bootstrap, `ProjectionSnapshotQuery.ts`, `decider.ts`/`projector.ts`, `GitManager`/`GitVcsDriverCore`/terminal/setup-script/checkpoint readers. ALSO requires a goal-creation lifecycle/UI that does not exist yet (web has only a `goalId` read selector in `store.ts`). Do NOT half-migrate — it breaks the build. Sequence: build goal-create (UI + command that owns the worktree) → flip thread bootstrap to inherit the goal worktree → delete thread worktree fields → fix all readers.
3. **§1.6 Sidebar goal tier** — copy the per-project grouping/expand machinery in `Sidebar.tsx` (no goal refs today).
4. **Phase 3 rendering + diff** — deep-view `## Goal`/`## Tasks` from the live file, overview list, reuse `DiffPanel.tsx`.

## Verification approach (no browser tool)
The plan's canonical verify = "run the forked app against a real pi session" through the web UI. **No browser-automation tool is available in this environment**, so:
- Phase 1 verified by driving the real `PiDriver` adapter against real `pi --mode rpc` (full provider/transport/mapping path) + a server-boot HTTP smoke. The throwaway verification script was deleted after passing (it tripped the strict effect-diagnostics lint that gates `pnpm typecheck`); PASS result recorded above.
- Phase 3 discovery/parser verified against real files via a now-deleted throwaway script (PASS recorded).
- React rendering + the ws RPC protocol wrapper remain un-exercised by automated means here — UI phases need a session with browser verification. Documented tooling constraint, NOT a synthetic substitute.

## Assumptions
- Internal prototype, no backwards-compat shims.
- Default transport = local `pi` binary (`pi --mode rpc`); bundled package resolution best-effort.

## Deviations / deferred
- De-clouding (strip `infra/relay` + `apps/server/src/cloud`/Clerk) deferred: app boots pi-only without it; lower value than the goal-centric workflow. Revisit before declaring Phase 0 fully complete.
- `vp` not on PATH; use `pnpm exec vp` / `pnpm typecheck`.
</content>
</invoke>
