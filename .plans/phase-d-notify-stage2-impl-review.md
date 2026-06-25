# Phase D-notify Stage 2 — Implementation Review

**Branch:** `t3code/phase-d-notify-stage2` · **Commits reviewed:** `a00f33e` (shared `workstreamGraph` + dispatcher consolidation), `902acf7` (three tools).
**Contract:** `.plans/phase-d-notify-stage2-design.md` (signed plan).
**Verdict: PASS — recommend merge.** No merge-blockers found. All 8 verification points pass. A handful of low-priority "consider" notes below; none gate merge.

Independently re-ran: `vp run typecheck` → **0 errors**; `vp check` → **0 errors** (13 pre-existing web `react(no-unstable-nested-components)` warnings, unrelated); targeted suites (workstreamGraph + workstreamAsk + WorkstreamDispatcher) → **46 passed**.

---

## Verification points (all PASS)

### 1. No backwards-compat shim — PASS
`selectJoinedGenerations`/`isTerminalStatus`/`JoinedGeneration` are **deleted** from `WorkstreamDispatcher.ts` (the `export const` definitions are gone; confirmed by grep). The dispatcher now `import {selectJoinedGenerations, type JoinedGeneration} from "@t3tools/shared/workstreamGraph"` and uses `JoinedGeneration<OrchestrationThreadShell>`. `WorkstreamDispatcher.test.ts` repoints its import to the shared module (`:15`) and **removes** the relocated `isTerminalStatus`/`selectJoinedGenerations` describe blocks (now living in `packages/shared/src/workstreamGraph.test.ts`). No re-export, no facade. Clean relocation.

### 2. Read-only fork guarantee (decision 7) — PASS
`workstreamAsk.ts` launches the fork via `createPiRpcProcess` with: `forkFrom: targetSessionId`, `sessionId: freshSessionId` (UUID, pi's built-in aliasing guard), `tools: READONLY_FORK_TOOLS` (`["read","grep","find","ls"]` — no bash/edit/write), **no `extensions`**, and `env: withLocalNodeModulesBin(envWithoutWorkstream(), …)` which strips every `T3_WORKSTREAM_*` key (including `T3_WORKSTREAM_AUTHORIZATION`). Lifecycle is `Effect.acquireUseRelease`: the throwaway is always `stop()`ed and the fork file `unlink`ed on success/timeout/error/interruption.
- **dispatch-never-called** is *structurally* guaranteed: `handleWorkstreamAskThread` (and `read_thread`) never reference `OrchestrationEngineService` at all — engine `dispatch` calls exist only in spawn/status/deps/report handlers (lines 218/277/320/363). The ask path can only spawn a pi process.
- Tests (`workstreamAsk.test.ts`) assert: env-strip keeps non-workstream keys and drops all `T3_WORKSTREAM_*`; `buildPiRpcArgs` contains `--fork`/`--session-id`/`--tools read,grep,find,ls` and **`not.toContain("--extension")`**; tools are exactly `read,grep,find,ls`.
- **Consider (not blocking):** the unit tests do not use a recording `OrchestrationEngineService` to assert dispatch-never-called, and source-session-file-byte-unchanged is only *live-validated* (coder claim, not independently re-run here). Both are reasonable given the tracked engine-backed-Effect-test infra gap, and dispatch is structurally unreachable from this handler. The "no `--extension`" + env-strip tests cover the load-bearing invariant.

### 3. Same-tree auth — PASS
`read_thread` and `ask_thread` both: `find` the target across the combined active+archived set → `undefined` ⇒ **404**; then `!isInSameTree(scope.threadId, target, threads)` ⇒ **403**; else proceed (**200**). `isInSameTree` compares `rootOf(caller) === rootOf(target)` (same root orchestrator), so siblings/cousins/ancestors/descendants are included; tested for self, siblings (reviewer→coder), ancestor/descendant, cross-tree false, absent-target false, and cycle-termination. This is genuinely distinct from the parent-of-only `authorizationError` (still correctly used by status/deps, which *are* parent-of-only) — no silent reuse.

### 4. Module minimal & pure — PASS
No `ancestorsOf`/`siblingsOf` exports; `groupByGeneration` appears only in a comment explaining its deliberate absence (grouping is internal to `selectJoinedGenerations`). Exports are exactly: `childrenOf`, `descendantsOf`, `subtreeOf`, `isInSameTree`, `isTerminalStatus`, `selectJoinedGenerations`, `graphViewFor` (+ types). `rootOf`/`buildIndex`/`collectDescendants` are private. No I/O. Mirrors the `workstreamDependencies` minimal-node-shape precedent. `OrchestrationThreadShell` satisfies `GraphViewThread` (has `id/parentThreadId/role/title/status/spawnGeneration/reportPath/blockedBy`), confirmed against the contract struct.

### 5. `graphViewFor`/`list` cheap; `read_thread` single call + degraded archived; `ask_thread` cwd — PASS
- `graphViewFor` is one `buildIndex` + `subtreeOf` over the snapshot, no bodies, lean nodes (`hasReport` boolean). `collectGraphThreads` = `getShellSnapshot()` + `getArchivedShellSnapshot()` only.
- `read_thread`: one `getThreadDetailById` call + one file `readWorkstreamReport`; **does not** also call `listByThreadId` (confirmed empty). Archived target (`Option.isNone(detail)`) degrades to shell metadata (role/title/status/hasReport) + report markdown, `archived: true`, `recentActivity: null` — never error-empty. Recent-activity is bounded (last assistant message ≤800 chars, ≤3 activity rows).
- `ask_thread`: cwd = `shell.worktreePath ?? config.cwd`; `targetSessionId = piSessionIdForThread(target)`. Question capped at 8 000 chars; 120 s turn timeout.

### 6. Wiring complete/consistent — PASS
- **MCP registration:** `workstream_list`, `workstream_read_thread`, `workstream_ask_thread` registered in `WorkstreamSpawnExtension.ts` with the same `callWorkstreamEndpoint`/`process.env.T3_WORKSTREAM_*_URL` pattern, good descriptions + prompt guidelines.
- **HTTP:** 3 routes (`LIST_PATH`/`READ_THREAD_PATH`/`ASK_THREAD_PATH`) + matching `workstream*UrlFromMcpEndpoint` exporters + merged into `layer`.
- **Env block:** `PiDriver.ts` adds `T3_WORKSTREAM_LIST_URL`/`_READ_THREAD_URL`/`_ASK_THREAD_URL` beside `_REPORT_URL` in the mcpSession env block.
- **System prompt:** `PI_WORKSTREAM_SYSTEM_PROMPT` extended to teach list→read→ask and notes read/ask cover the whole tree incl. siblings + archived. Correctly leaves the status/deps "own thread or threads you directly spawned" sentence intact (those are parent-of-only).

### 7. Checks actually pass — PASS
`typecheck` 0, `vp check` 0 errors. Full `packages/shared` + `apps/server` run: **5 failures in 3 files** — `serverRuntimeStartup.test.ts` (Codex default model), `model.test.ts` (`normalizeModelSlug` expects `gpt-5.4`, gets `gpt-5-codex`), `ProviderRegistry.test.ts` (3 Codex-probe tests). **All are model-catalog/Codex drift, none touch any file in this diff** — independently confirmed the `model.test.ts` failure is a slug-alias assertion mismatch, not an import/break from the new module. Claim holds. The new read-only/auth/graph tests exist and pass (46/46).

### 8. No stale leftovers — PASS
No `read_child`/`ask_child` anywhere. `TextGeneration` hits are the pre-existing server text-generation service (commit summaries etc.), unrelated to the rejected "ask_child = TextGeneration" framing. No parent-of language leaked into the read/ask prompts.

---

## Consider (non-blocking, optional follow-ups)
1. **Per-instance pi binary not resolved** (coder flag): `ask_thread` uses `settings.providers.pi.binaryPath`, not a per-MCP-instance custom binary. Acceptable for v1; worth a note if custom-binary instances become common.
2. **Fork-file cleanup depends on `get_state.sessionFile`:** cleanup `unlink`s `forkSessionFile` captured from `proc.request("get_state")`. If `get_state` ever returns no `sessionFile`, the throwaway fork file leaks (best-effort `.catch(()=>undefined)`). Low risk; consider a path-derivation fallback if leaks are observed.
3. **Read-only assertion depth:** consider adding (when the engine-backed Effect test infra lands) a recording-engine test asserting `dispatch` never fires on the ask path and a source-file-hash-unchanged assertion, to lock in decision 7 deterministically rather than relying on the live run + structural argument.

## Live verification status
Not independently re-run (no live server in this review session). Coder claims a real-pi fork validation (answers from source context, source byte-unchanged, separate fork file, aliasing guard) but could not run the full server-driven sibling-spawn loop. The acceptance's end-to-end "spawn two siblings → list→read→ask" remains the one item validated only by the coder, not by this review.

## Fixes applied by reviewer
None — no trivial fixes were warranted; the diff is clean.
