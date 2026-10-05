# Pull 9 — upstream Pi V2 driver vs Loom Pi driver

Thread `226063dd-3d11-464e-9cca-4e2c5189848f`. Compared `upstream/main` = `a1d9d72aef` against Loom `HEAD` = `131166c11d`. Upstream was read with `git show upstream/main:…`; Loom was read from the working tree.

## Headline

1. **The two drivers target different orchestration contracts, so "swap one for the other" is not the question.** Upstream's Pi is a **V2 `ProviderAdapterV2`** (`openSession`, `ensureThread`, `resumeThread`, `startTurn`, `steerTurn`, `rollbackThread`, `forkThread`, `readThreadSnapshot`, `respondToRuntimeRequest`). It emits V2 nodes, turn items, provider threads and turns, and runtime requests. Loom's Pi is a **V1 `ProviderAdapterShape`** (`startSession`, `sendTurn`, `interruptTurn`, `respondToUserInput`, `rollbackThread(numTurns)`, `canResumeThread`). It emits V1 `ProviderRuntimeEvent`s (`content.delta`, `item.*`, `turn.*`, `thread.token-usage.updated`). Loom has no `apps/server/src/orchestration-v2/` at all. Whether Loom adopts upstream's driver is therefore decided by whether Loom adopts V2 orchestration. If V2 lands, Loom's driver would have to be rewritten against `ProviderAdapterV2` anyway, and upstream's adapter is that rewrite already written and tested.
2. **The extension-bridge "rhyme" holds for the mechanism but not for the contract.** Both servers write a T3-owned extension file at session open and pass it with `--extension`. Both give it a per-session bearer drawn from the same `McpSessionRegistry` credential (`McpProviderSession.readMcpProviderSession(threadId)`), and both forward `pi.registerTool` calls over HTTP to the T3 server. The differences:
   - **Upstream:** a real MCP client (JSON-RPC, SSE, `mcp-session-id`) that discovers tools dynamically from `/mcp` and namespaces them `mcp__t3-code__*`, with generic guidance.
   - **Loom:** a static list of 23 hand-authored tools plus the local `enable_toolset`. They are bare-named (`workstream_spawn`, `goal_task_add`, …) and POST to bespoke REST routes `/provider-tools/*`. Loom's extension also owns role tool profiling (`T3_ACTIVE_TOOLS`), the `ask_user_question` long-poll and the prompt-debug capture.
   - **Upstream-only hooks:** the permission gate (`tool_call`), the orchestration-instruction injection (`before_agent_start`) and an OpenRouter `max_tokens` cap.

   The two extensions are independent, and **both can be loaded into one pi process** (two `--extension` flags).
3. **The deepest incompatibility is session identity.** Upstream's identity is the session **file path** (`nativeThreadRef`), with pi's default `<timestamp>_<uuid>.jsonl` naming. Upstream reserves `--session`, `--session-id` and `--fork` from launch args, resumes with RPC `switch_session`, and rolls back with RPC `fork(entryId)`, which **creates a new file**. Loom's identity is a **deterministic per-thread id** (`--session-id <threadId>` → `*_<threadId>.jsonl`), resumed with the patched `--session <file> --cwd <dir>` and rolled back by truncating the file in place. About 10 Loom modules locate sessions by that name: consult, fork, handoff/retro drafts, stall context, thread resolve, the dispatcher, and the identity clause. **RPC `switch_session` throws `MissingSessionCwdError` when the recorded worktree is gone** (`assertSessionCwdExists`, pi 0.99.2). That is exactly the reaped-worktree case Loom's patch 0001 exists for, and patch 0001 only covers the CLI `--session` path.
4. **Loom's pi patches are still needed against pi 1.0.2**, the latest release; upstream recommends 1.0. pi 1.0.2 has no `--cwd` in `dist/cli/args.js`, and `dist/core/auth-storage.js` still uses plain `writeFileSync` with no atomic rename. Upstream does not bundle or patch pi: it runs the user's `pi` from `PATH`, minimum `0.80.5`. Its recorded fixtures say `piVersion: 1.0.0`. It also registers `pi update --self` as provider maintenance, which would overwrite a patched global install.
5. **Upstream is structurally richer on runtime fidelity.** It adds permission modes, extension dialogs mapped to approvals and questions, `agent_settled` + idle-probe turn settlement, native rollback, fork and fork-from-turn, thread snapshots for handoff, per-model thinking ladders, the "Pi default" model, live usage, a single retry row, compaction rows, a guard against unsolicited activity, and replay fixtures.
6. **Loom is richer on workstream semantics and economics.** It adds role-composed system prompts, role tool profiles plus `enable_toolset`, `--skill` per role, the forkFrom cache-identity replay, cache-retention A/B, quota failover plus a T3-level retry tier, cost and model attribution, the codex→Anthropic tool-id sanitiser, the search guard, durable `ask_user_question`, activity slimming, backpressure and relocated-worktree resume. Upstream's V2 contract has no slot for any of these. Each would be a Loom hunk in, or alongside, `PiAdapterV2.ts`.

---

## 1. Process model and transport

| Aspect | Upstream V2 (`apps/server/src/orchestration-v2/Adapters/PiAdapterV2.ts`, `PiRpc.ts`) | Loom (`apps/server/src/provider/Drivers/PiDriver.ts`, `Layers/Pi/RpcProcess.ts`) |
| --- | --- | --- |
| Binary | `settings.binaryPath \|\| "pi"`, resolved on `PATH` (`resolveSpawnCommand`) | `resolvePiInvocation`: when the path is `"pi"`, runs the **bundled, patched** `node_modules` copy (`process.execPath <bundle>/cli.js`), else `PATH` (`Layers/Pi/Cli.ts`) |
| Argv | `--mode rpc` + validated user `launchArgs` + `--extension <cache>/pi-t3-mcp-extension.ts` (`buildPiRpcLaunch`) | `--mode rpc` + `--session-id <id>` (new), or `--session <file> --cwd <dir>` (resume), `--fork <src>` (first fork launch), `--skill …`, `--append-system-prompt …`, `--extension t3-provider-tools-extension.mjs` (only with an MCP session) + `--extension` search guard (always) (`buildPiRpcArgs`) |
| User extensions, skills, context files | Loaded deliberately ("honour the user's Pi customisations"; no `--no-*` flags) | Also loaded (no `--no-*` flags); Loom adds its own on top |
| cwd | `runtimePolicy.cwd ?? serverConfig.cwd` | `startInput.cwd ?? serverConfig.cwd`; on resume, falls back to the server root if the recorded worktree dangles |
| Env | Instance env merged with host; **strips inherited** `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN`, then sets per session; `T3_PI_RUNTIME_MODE` | `process.env` + `T3_ACTIVE_TOOLS` (always set), `PI_CACHE_RETENTION`, `T3_WORKSTREAM_ENDPOINT` / `T3_WORKSTREAM_AUTHORIZATION` / `T3_PROMPT_DEBUG_PATH` (with an MCP session); worktree `node_modules/.bin` prepended to PATH |
| Home, config and session dir | pi defaults (`~/.pi/agent`); `--session-dir` allowed in launchArgs | pi defaults; `piSessionsRoot()` assumes `~/.pi/agent/sessions` |
| Process cardinality | One process per V2 provider session (`supportsMultipleProviderThreadsPerSession: false`), effectively one per thread | One process per thread (`sessions` map keyed by `threadId`) |
| Resume across restart | Spawn, then `switch_session {sessionPath: nativeThreadRef}` (60 s lifecycle timeout; timeout terminates the process); a new thread uses the startup session, a re-registration uses `new_session` | Spawn directly into the deterministic file: `resolveResumableSessionFile` → `--session <file> --cwd`; `canResumeThread` mirrors the same predicate; `resumeState: "session-file"` |
| Turn start | `prompt` sent fire-and-forget under a session permit; the deferred id-less `response` is matched FIFO (`pendingPromptResponses`) | `process.request({type:"prompt"})`; a turn id is minted by the driver (`pi-turn-<uuid>`) |
| Turn terminal | **`agent_settled`** → `get_state` idle probe (`isStreaming` / `isCompacting` / `pendingMessageCount`) → `finalizeTurn`; command-only prompts settle on the ack plus the probe | **`agent_end`** (unless `willRetry`) → `piRunOutcome(messages)` → complete, fail or interrupt; `auto_retry_end` failure covers abort-during-backoff |
| Steer | `prompt` + `streamingBehavior:"steer"` (atomic: starts a new run if settlement won the race); `/compact` steered as RPC `compact` | `prompt` + `streamingBehavior:"steer"` when a turn is active and not in T3 backoff |
| Abort | `abort`; with `requestRuntimeRestart`, an active compaction or a settle-pending turn → captures tree refs, then **terminates** the process group (SIGTERM → SIGKILL; `taskkill /T` on Windows) | `abort` write; in a T3 retry backoff, settles as interrupted locally |
| Text and reasoning | `text_delta` / `thinking_delta` → stream items keyed `turn:m<n>:c<contentIndex>`, flushed every 50 ms as `assistant_message` / `reasoning` turn items + `message.updated` | `content.delta` with `streamKind` `assistant_text` / `reasoning_text`, keyed by a per-message uuid; `item.completed` on `message_end` |
| Tools | `bash` → `command_execution` (+`exitCode`); `edit`/`write` → `file_change` (+`diffStr` from `details.patch`, `newStr`); else `dynamic_tool` with `mcpToolPresentation`; aborted tools → `interrupted` | Name heuristics (`toolItemType`: contains "agent"/"task" → `collab_agent_tool_call`, etc.); args stashed and merged into the result as `rawInput` (feeds loop and stall detection); payloads slimmed (inline base64 images materialised as attachments, 12 k truncation, subagent `results` compacted) |
| Errors | `message_end` `stopReason:error` → `turn.failure`; `extension_error` → error item (buffered until the next turn if out of turn); transport death → failed turn + `transport_error` | `classifyAndHandleError` → retry, failover or fail with a `RuntimeErrorClass` (incl. `quota_exhausted`); exit → `session.exited` (graceful vs error) |
| Usage | Live `message_update.usage` (when the total changes) + `get_session_stats` at settle (`contextUsage.tokens / contextWindow`, input / cacheRead / output); compaction `estimatedTokensAfter` as a fallback | `message_end.usage` → `normalizePiTokenUsage` (used / input / cached / cacheWrite / output **+ `costUsd` from `usage.cost.total`** + `model` / `resolvedModel` / `providerId` for the usage ledger); compaction `afterTokens` emitted as usage |
| Cost | Not mapped | Mapped (`costUsd`) |
| Backpressure | Unbounded event queue | The stdout reader pauses the child while the bounded events queue is full (`PiDriver.backpressure.test.ts`) |
| Unsolicited work | `agent_start` with no T3 turn → session error + **terminate** (`PI_UNSOLICITED_ACTIVITY_ERROR`) | Status goes to running; no turn |

## 2. Tool injection — the extension bridge

| | Upstream `piT3McpExtensionSource.ts` + `piT3McpInjection.ts` | Loom `Drivers/Pi/providerToolExtension.ts` + `providerToolDefs.ts` (+ `mcp/toolPaths.ts`) |
| --- | --- | --- |
| Artefact | TS string (`pi-t3-mcp-extension.ts`) written to `providerStatusCacheDir`, only when its content changed; imports `ExtensionAPI` and `typebox` from the user's pi install | `.mjs` generated from typed defs, written **unconditionally** to `<stateDir>/pi-extensions/t3-provider-tools-extension.mjs` at every launch; no imports except `node:fs` |
| When loaded | **Always** (it also carries the permission hook); MCP part only when a credential exists | Only when an MCP provider session exists; the search guard (a separate extension) always |
| Discovery | Dynamic: `initialize` → `tools/list` (paginated) at load (awaited, 10 s), retried on `session_start` | Static: the tool list is baked in at generation time |
| Transport | MCP Streamable HTTP JSON-RPC (`tools/call`), SSE-or-JSON parse, `mcp-session-id`, `mcp-protocol-version: 2025-06-18` | Plain `POST <base>/provider-tools/<route>` with JSON params; the server returns `rendered` text; per-tool `errorMode` `throw`/`soft`; `user-input` mode long-polls `ask_user_question` with a reconnect loop |
| Naming | `mcp__t3-code__<name>` (e.g. `mcp__t3-code__delegate_task`) | Bare (`workstream_spawn`, `consult_thread`, `goal_tasks_rewrite`, …) |
| Auth env | `T3_MCP_URL`, `T3_MCP_BEARER_TOKEN` (raw token; inherited values deleted first) | `T3_WORKSTREAM_ENDPOINT` (= MCP endpoint minus `/mcp`), `T3_WORKSTREAM_AUTHORIZATION` (full header) — **same credential** |
| Credential scope and expiry | `McpSessionRegistry`: environment + thread + instance + provider session; max lifetime + idle expiry; revoked on release; grants `preview` + `orchestration` | Same registry lineage; Loom's driver declares `capabilities.mcp: ["workstream"]` so the credential carries the `workstream` capability that gates `/provider-tools/*` (`mcp/httpScope.ts`) |
| Descriptions | MCP `description`; `promptSnippet` = first line; one generic guideline ("Use X from the t3-code MCP server when…") | Hand-authored `description`, `promptSnippet` and `promptGuidelines` per tool (`providerToolDefs.ts`, ~1000 lines) |
| Per-role composition | None. Every discovered tool is active. | `T3_ACTIVE_TOOLS` applied with `pi.setActiveTools` on `session_start` (select, never restrict; the registry stays full), `enable_toolset(family)` re-activates dormant families (delegation / human-input / browser / studio / all) and returns the delegation digest. `--tools` is deliberately **not** used because it deletes tools from the registry. |
| Other hooks | `tool_call` permission gate (runtime mode), `before_agent_start` appends `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, `before_provider_request` caps OpenRouter `max_tokens` at 32 768, `session_start` notify on MCP failure | `before_agent_start` effective-prompt debug sidecar (`T3_PROMPT_DEBUG_PATH`, write-once `.first.md`) |
| Pi's own tools and extensions | Untouched; `--tools` and `--extension` allowed in launchArgs; the official `subagent` extension is observed (§8) | Untouched; the search guard adds `tool_call` / `tool_result` hooks to bash (blocks unbounded searches outside the worktree, auto-bounds pipelines to 30 s) |
| Tool surface reached | Every T3 MCP toolkit the credential allows: orchestrator (`delegate_task`, `task_status`, `t3_thread_launch`, `create_threads`, `schedule_task`, …), preview, metadata | Loom workstream, goal and thread tools only. Loom's `/mcp` (preview / device / PR toolkits) is **not** bridged into pi. |

Verdict on the rhyme: the same idea is implemented twice with different contracts. The two artefacts do not conflict and can be loaded side by side. Loom's shim could also read upstream's `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN` instead of its own variables, because the base URL is derived from the same endpoint. Per-thread `T3_ACTIVE_TOOLS` and `T3_PROMPT_DEBUG_PATH` have no carrier in upstream's launch: instance env is per instance, not per thread. The tool names collide only conceptually. Upstream's `delegate_task` / `t3_thread_*` overlap Loom's `workstream_spawn` / `notify_thread`, so both surfaces live in one prompt unless one is filtered out.

## 3. Prompt and instruction composition

- **Upstream:** `acceptsSystemContext: false`. Pi gets only `T3_CODE_ORCHESTRATION_INSTRUCTIONS`, appended in the extension's `before_agent_start` and only when MCP is present (comment: "never by wrapping the user text… slash commands would stop expanding"). It gets **no** `buildRuntimeInstructions` (unlike Claude, Codex, Cursor and OpenCode), no role overlay and no per-thread prompt. AGENTS.md and skills reach pi through pi's own loader. `$skill` references are expanded through `get_commands` (`expandPiSkillReference`). Delegated children get only the task prompt plus an optional `role` enum string from the `delegate_task` call. Handoffs go in as synthetic user context (`acceptsSyntheticUserContext`, `supportsDeltaHandoff`, `supportsFullThreadHandoff`).
- **Loom:** `--append-system-prompt` argv. The prompt is `PI_WORK_MODEL_SYSTEM_PROMPT` (the driver prepends it when an MCP session exists) followed by the reactor-composed `appendSystemPrompt`. The reactor (`orchestration/Layers/ProviderCommandReactor.ts`, around line 1000) composes, in order: `threadIdentityClause` (thread id, `$PI_SESSION_FILE`), role overlay prompt, shipping policy (`.t3code/ship.json`), the role catalogue (only for delegation-capable roles), the goal and task-tree prompt, and the relocation clause. `--skill` comes per role overlay, and the tool profile per role goes through `T3_ACTIVE_TOOLS`. The final argv bytes are captured as launch identity, so a `forkFrom` child replays them verbatim and keeps the cache prefix byte-identical. AGENTS.md and skills also flow through pi's own loader. `RuntimeInstructions.ts` currently carries **no** `// loom:` hunks; it is upstream's runtime-info and PR-linking text, which Loom's pi path does not call either.
- **Coupling:** Loom's composition is split between the V1 reactor (`ProviderCommandReactor.ts`) and driver argv. Under V2, the reactor's `startSession` input (`appendSystemPrompt`, `skills`, `tools`, `forkFromThreadId`, `forkIdentity`, `cacheRetention` — all Loom fields on `ProviderSessionStartInput` in `packages/contracts/src/provider.ts`) has no equivalent on `ProviderAdapterV2OpenSessionInput`.

## 4. Model and thinking

| | Upstream | Loom |
| --- | --- | --- |
| Model ids | `provider/modelId` slugs; the sentinel `"default"` means "don't call `set_model`, use pi's settings.json", and the baseline is captured from the first `get_state` so it can be restored | `provider/modelId` slugs; `PI_DEFAULT_MODEL = "cliproxy/claude-opus-5-5"` (`packages/contracts/src/model.ts`); the session is pinned with `set_model` at birth |
| Catalogue | `PiProvider.ts`: ephemeral `pi --mode rpc --no-session` → `get_available_models` + `get_commands`; `customModels` are `CustomModelSetting` objects | `enrichPiSnapshot` (in `PiDriver.ts`): a short-lived pi on a 2-minute cadence (90 s request timeout), shares `modelContextWindows`; `customModels` are a string array |
| Thinking | Per model from pi's own model metadata (`thinkingCapabilitiesForPiModel`, mirroring pi-ai's `getSupportedThinkingLevels` / `clampThinkingLevel`), ladder `off…max`, default = pi's configured level; option id **`thinking`** | One global descriptor `PI_THINKING_LEVEL_OPTIONS` (`off…xhigh`, no `max`), default `medium`; option id **`thinkingLevel`** (stored selections would need migrating) |
| Context window | From `get_state` / `set_model` / `get_available_models`; `getModelContextWindow` used by V2 handoff budgeting | From the enrichment catalogue map |
| Multiple backends inside pi | Whatever pi is configured for (OpenRouter used in fixtures) | Same, plus Loom routing: `resolveEffectiveModel` (tier-2 failover over `failoverChains`, `ProviderHealthRegistry` exhaustion marks), `model.rerouted` events, T3 slow-tier retry with backend fallback (`piTurnRetryPolicy.ts`), `quota_exhausted` turns for the resume sweep |
| Account quota | None for pi | `accountUsage.loom.ts` (per-account windows, carve-outs) + `quotas/piQuotas.ts` (Anthropic / Codex usage endpoints) feeding the subscription-usage poller and exhaustion routing |
| Instance options | `enabled` (default **false**), `binaryPath`, `launchArgs` (validated, reserved flags rejected), `customModels` | `enabled` (default **true**), `binaryPath` (described as forfeiting the patches if changed), `customModels` |

## 5. Session artefacts

- **Location and naming.** Upstream uses pi defaults: `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<uuid>.jsonl`, with the absolute path stored as `nativeThreadRef`. `set_session_name` mirrors the thread title into pi's `/resume` listing. Loom also uses pi defaults, but the id is fixed: `--session-id piSessionIdForThread(threadId)` → `*_<threadId>.jsonl`. `resolveSessionFilePath` finds it by suffix across all project-slug directories. Ten non-test modules depend on that convention (`orchestration/{stallContext,threadResolve,threadIdle,workstreamAsk,workstreamLaunchIdentity}.ts`, `orchestration/Layers/{ProviderCommandReactor,WorkstreamDispatcher}.ts`, `mcp/{WorkstreamSpawnHttp,ThreadForkHttp,GoalHandoffHttp}.ts`, `loom/{handoffDraft,retroDraft}.ts`). `$PI_SESSION_FILE` is **pi-native** (its bash tool sets it in 0.99.2 and 1.0.2), so it survives either driver.
- **Fork.** Upstream `forkThread` runs a throwaway `pi --mode rpc --no-extensions --no-tools --fork <src>` in the **destination** cwd, optionally `fork(entryId)` for fork-from-turn, then `get_state.sessionFile` → new identity → `registerThread`. Loom's `forkFrom` is a fork-once `--fork <src>` at the child's first launch into the child's deterministic id. It replays the source's launch identity (argv prompt, tools, skills, last applied model) unless `forkIdentity: "compose"` (`/retro`), and refuses loudly when no identity record exists. `consult_thread` (`orchestration/workstreamAsk.ts`) is a separate read-only fork (`--fork --session-id <fresh> --tools read,grep,find,ls`, no Loom extension or env, file deleted afterwards). `thread_fork` and goal handoff build on these.
- **Rollback.** Upstream records each turn's first user entry id with `get_entries since <leaf>` as a strong `nativeTurnRef`, then rolls back with RPC `fork(entryId)`. That **replaces the session file** and updates `nativeThreadRef`. It is non-destructive: the old file remains. Loom rolls back with `planPiSessionRewind`: stop pi, truncate the branch **in place**, relaunch, and re-assert the model and thinking level. The comment in `PiDriver.ts` explicitly rejects pi `fork` because a new file breaks the deterministic id.
- **Compaction.** Upstream maps `compaction_start` / `compaction_end` to one `compaction` turn item (running → completed / failed / cancelled, with summary and token counts). `/compact` and `compactThread` go to RPC `compact` (also when steered), and Stop terminates pi because abort does not cancel compaction. Loom uses `ProviderCompaction` `"native"`: RPC `compact` with a 10-minute timeout, then a `thread.state.changed` `compacted` event and usage dropped to `afterTokens`. Failed auto-compactions are suppressed so a turn pi is still running does not fail.
- **Snapshot and context budget.** Upstream `readThreadSnapshot` uses `get_messages` (active branch only), which feeds V2 handoffs. Loom has none: `readThread` returns in-memory turn ids only. Handoff drafts read the jsonl directly.

## 6. Pi version and patches

- **Pins.** Upstream has **no** pi dependency. It needs pi ≥ `0.80.5` (`MINIMUM_PI_VERSION`), recommends 1.0, recorded its fixtures on `1.0.0`, and has no pi patch in `patches/`. Loom pins `@earendil-works/pi-coding-agent` at exactly `0.99.2` (`apps/server/package.json`) and patches it through `patches/@earendil-works__pi-coding-agent@0.99.2.patch` (`pnpm-workspace.yaml` `patchedDependencies`). The patch is generated from `infra/pi-patches/0001-pi-cwd-override-rpc-resume.patch`, `0002-pi-auth-storage-atomic-write.patch` and `patch-bundle.mjs` (minified bundle chunks).
- **What the patches do.**
  - **0001** adds `--cwd <dir>`, valid only with `--session <path>`, so a session whose recorded worktree was reaped can be reopened. Without it, launching elsewhere creates an empty same-id session (amnesia), or startup hard-exits on a missing stored cwd.
  - **0002** makes `auth.json` writes atomic, because `~/.pi/agent/auth.json` is shared by every pi process on the machine.
- **Still needed against upstream's target?** Yes for both. pi 1.0.2 (published 2026-10-04) has no `--cwd`, and `auth-storage.js` still writes with `writeFileSync`. Upstream's resume path has the same failure mode through a different door: RPC `switch_session` calls `SessionManager.open(path, undefined, undefined)` and then `assertSessionCwdExists`. So adopting upstream would need **patch 0001 extended to the RPC `switch_session` command** (pi's `switchSession` already accepts `options.cwdOverride`; RPC just never passes it), or a Loom hunk that keeps the `--session --cwd` launch for resumes. pi already exposes everything else upstream needs in 0.99.2: `agent_settled`, `get_entries`, `switch_session`, `fork`, `set_session_name`, `get_session_stats`.
- **Risk of double-driving one install.**
  - Upstream's `binaryPath: "pi"` resolves the **global** pi. Loom's `"pi"` resolves the **bundled** copy (`resolveBundledPiCliPath`), so adopting upstream silently moves Loom onto the unpatched global binary unless that resolution is kept as a hunk.
  - Upstream's `PiDriver` registers `pi update --self` as package-managed maintenance. The patch README warns that `pi update` reverts patches on the global install. Loom uses manual-only maintenance.
  - Upstream spawns more short-lived pi processes (discovery per refresh, text generation, and a throwaway process per fork), all of which write the shared `auth.json`. That raises the value of 0002 on every writer.

## 7. Capabilities declared to V2 (`PiProviderCapabilitiesV2`)

- **Sessions:** model switch in session ✓; provider switching via handoff ✓; **runtime-mode switch ✗** (the orchestrator restarts the process so the permission hook gets an immutable policy); pending requests do not survive restart; one thread per session.
- **Threads:** create empty ✓, snapshot ✓, rollback ✓, **fork ✓, fork from turn ✓**, fork from a subagent thread ✗; native thread id ✓ (strong).
- **Turns:** started and completed ✓; interrupt ✓; **active steering ✓**; queued messages ✓; steer-by-restart ✗; terminal quality "strong"; native turn id weak (synthetic until the session-tree ref is captured).
- **Streaming:** text, reasoning and tool output ✓; plan text ✗.
- **Tools:** item ids ✓; **MCP tools ✓**; dynamic tool callbacks ✗.
- **Approvals:** command ✓ and file-change ✓ through the bridge's `tool_call` hook; file-read and apply-patch ✗; live-only callbacks.
- **Planning:** structured questions ✓ (extension dialogs); plan, todo and proposed plan ✗.
- **Subagents:** `supportsSubagents ✓`, `exposesSubagentThreadIds ✗`, lifecycle ✓, wait / close / fork ✗.
- **Context:** system / developer context ✗; synthetic user context ✓; delta and full handoff ✓.
- **Checkpointing:** app filesystem checkpoint ✓; provider rollback ✓ and returns a snapshot.

Policy consequences in `orchestration-v2/CommandPolicy.ts`:
- Follow-up sends resolve to `steer_active`.
- `ensureNativeFork` / `canForkNatively` choose a native fork for same-provider forks with a strong source. Otherwise a portable-context fork is used.
- Rollback goes through the provider, and the snapshot is required because rollback is enabled.
- A mode change goes through `Orchestrator`'s restart path.
- Delegation always goes through T3's MCP `delegate_task`, which creates orchestrator-owned child threads.

Loom's V1 capabilities: `sessionModelSwitch: "in-session"`, `emitsExitOnStop`, `resumeState: "session-file"`, `supportsConversationRollback: true`, `mcp: ["workstream"]`, `compaction: {type:"native"}`. Approvals are refused (`respondToRequest` fails, "not exposed separately in v1"), and runtime mode is ignored.

## 8. Subagent handling

- **Upstream:** two paths.
  1. **Durable delegation** goes through `mcp__t3-code__delegate_task` (+ `task_status`, `task_cancel`, `t3_thread_*`). The V2 orchestrator creates a child T3 thread and run, and the child receives only the task prompt plus an optional role string.
  2. **Pi's example `subagent` extension**, if installed, is observed passively. `emitSubagentTasks` reads `result.details.results[]` (`agent`, `task`, `step`, `exitCode`, `stopReason`, `messages`, `finished`) and emits `subagent.updated` + `subagent` turn items with `origin: "provider_native"`, `childThreadId: null` and output from the last assistant text or stderr. The children cannot be opened or resumed, because that extension runs them with `--no-session`.
- **Loom:** delegation is the workstream: `workstream_spawn` / `workstream_scaffold` / `workstream_brief` / … create durable child threads with roles, briefs, dependency edges, review gates and lanes, and children report through `workstream_submit`. Native pi subagent output is not given cards. The `subagent` tool maps to `collab_agent_tool_call` by name heuristic, and `details.results` are compacted (`compactChildResult`: child id, title, status, message count, last-two-message tail, transcript ref) so they do not bloat activity rows. Any pi-side subagent extensions in the user's install still load.

---

## Feature matrix

● present · ◐ partial · ○ absent. The symbol in brackets names where the behaviour lives.

| Behaviour | Upstream V2 Pi | Loom Pi |
| --- | --- | --- |
| Orchestration contract | ● V2 (`ProviderAdapterV2`) | ● V1 (`ProviderAdapterShape`) |
| Bundled + patched pi binary | ○ (`PATH`) | ● (`resolveBundledPiCliPath`) |
| User launch args (validated) | ● (`resolvePiLaunchArgs`) | ○ |
| Resume across restart | ● (`switch_session`) | ● (`--session --cwd`, `canResumeThread`) |
| Resume after the worktree is reaped | ○ (`MissingSessionCwdError`) | ● (patch 0001 + dangling-cwd fallback) |
| Deterministic `*_<threadId>.jsonl` | ○ | ● (`piSessionIdForThread`) |
| Turn settle on `agent_settled` + idle probe | ● (`scheduleSettleProbe`) | ○ (`agent_end`) |
| Active steering | ● (`streamingBehavior:"steer"`) | ● (same) |
| Queue display (`queue_update`) | ○ | ● (`thread.queue.updated`) |
| Interrupt during compaction | ● (terminate) | ◐ (`abort` only) |
| Text and reasoning streaming | ● (coalesced 50 ms items) | ● (`content.delta`) |
| Typed tool items (command exit code, file diff) | ● (`emitToolItem`) | ◐ (heuristic `toolItemType` + `rawInput` merge) |
| Activity payload slimming / inline image extraction | ○ | ● (`slimPiToolPayloadData`) |
| Live usage while streaming | ● (`reportLiveUsage`) | ○ (per `message_end`) |
| Cost (`costUsd`) and model attribution | ○ | ● (`normalizePiTokenUsage`) |
| Retry progress row (pi auto-retry) | ● (`emitProviderRetry`) | ◐ (`runtime.warning` per attempt) |
| T3-level retry tier + backend fallback | ○ | ● (`piTurnRetryPolicy.ts`) |
| Quota-aware failover / reroute | ○ | ● (`resolveEffectiveModel`, `ProviderHealthRegistry`) |
| Account quota fetchers | ○ | ● (`quotas/piQuotas.ts`, `accountUsage.loom.ts`) |
| Codex→Anthropic tool-id sanitiser | ○ | ● (`SessionIdSanitiser.ts`) |
| Permission modes (Supervised / auto-accept / full) | ● (`tool_call` hook) | ○ |
| Extension dialogs → approvals / questions | ● (`handleExtensionUiRequest`; session approvals) | ◐ (all → `user-input.requested`) |
| Extension `notify` / `extension_error` surfaced | ● | ○ |
| Durable `ask_user_question` | ○ | ● (`askUserBroker.ts`, `UserInputHttp.ts`) |
| "Pi default" model / baseline restore | ● (`PI_INHERIT_MODEL_SLUG`) | ○ (`PI_DEFAULT_MODEL` pinned) |
| Per-model thinking ladder incl. `max` | ● (`piThinkingCapabilities.ts`) | ○ (global list) |
| `$skill` expansion | ● (`expandPiSkillReference`) | ◐ (skills listed in the snapshot as commands) |
| Session name mirrors thread title | ● (`set_session_name`) | ○ |
| Native rollback (non-destructive) | ● (`fork(entryId)`) | ◐ (in-place truncation) |
| Native fork / fork from turn | ● (`forkThread`) | ◐ (`forkFrom` at first launch, whole session) |
| Fork cache-identity replay | ○ | ● (`workstreamLaunchIdentity.ts`) |
| Read-only consult fork | ○ | ● (`workstreamAsk.ts`) |
| Thread snapshot for handoff | ● (`get_messages`) | ○ |
| T3 tools bridged into pi | ● MCP-discovered, `mcp__t3-code__*` | ● static REST, bare names |
| Per-role tool profile + `enable_toolset` | ○ | ● (`T3_ACTIVE_TOOLS`) |
| Per-thread system prompt (role / goal / ship policy) | ○ (orchestration text only) | ● (`--append-system-prompt`) |
| Per-role skills | ○ | ● (`--skill`) |
| Search guard | ○ | ● (`searchGuardExtension.ts`) |
| Prompt debug sidecar | ○ | ● (`T3_PROMPT_DEBUG_PATH`) |
| Cache-retention A/B | ○ | ● (`PI_CACHE_RETENTION`) |
| Native subagent extension cards | ● (`emitSubagentTasks`) | ◐ (compacted results) |
| Unsolicited-activity guard | ● | ○ |
| OpenRouter `max_tokens` cap | ● | ○ |
| Stdout backpressure | ○ | ● (`RpcProcess`) |
| Windows process-tree kill | ● (`taskkill /T`) | ◐ |
| Recorded replay fixtures | ● (8 transcripts) | ○ |

## Loom-only behaviours that would need re-expression if upstream's driver is adopted

Sizes are rough: S < 100 lines, M 100–400, L > 400. "Self-contained" means the behaviour lives in its own module or extension and only needs a launch hook. "Interleaved" means it threads through the turn lifecycle in the driver.

1. **Provider-tool extension (workstream and goal tools, `enable_toolset`, role profile, prompt-debug capture).** Self-contained artefact. It needs (a) a second `--extension` in `buildPiRpcLaunch` and (b) per-thread env or a server fetch for `T3_ACTIVE_TOOLS` and `T3_PROMPT_DEBUG_PATH`. The endpoint and auth could be derived from upstream's own `T3_MCP_URL` / `T3_MCP_BEARER_TOKEN`. The credential must request the `workstream` capability from the V2 session manager. S hunk + the existing L module unchanged. A decision is also needed on co-existence with upstream's `mcp__t3-code__delegate_task` / `t3_thread_*` (filter them out of the active set, or not).
2. **Search guard extension.** Self-contained. One `--extension` entry. S.
3. **Role- and goal-composed system prompt (`PI_WORK_MODEL_SYSTEM_PROMPT` + identity, overlay, ship policy, roles, goal, relocation).** Interleaved: it is composed in the V1 reactor and carried as argv. It needs a V2 open-session input field plus a launch hook (`--append-system-prompt`), or the Loom extension fetching it in `before_agent_start`. The argv form is what makes forkFrom's byte-identical prefix possible, so the fetch route would need the same determinism. M.
4. **Per-role `--skill` and tool-profile plumbing.** Interleaved (same carrier as 3). S once 3 exists.
5. **Deterministic per-thread session id + `--session <file> --cwd` resume + dangling-cwd fallback.** Interleaved with upstream's identity model: `nativeThreadRef` = path, `switch_session`, rollback by `fork` creating new files. There are two options. The first is a Loom hunk in `openSession` / `registerThread`: spawn with `--session-id` or `--session --cwd`, and make rollback keep the file name. The second is re-pointing roughly 10 consumers to look sessions up through the V2 provider thread's `nativeThreadRef` instead of by name. Either way, patch 0001 must also cover RPC `switch_session` if upstream's resume path is kept. M–L; this is the riskiest item (silent amnesia when wrong).
6. **forkFrom launch-identity replay, `forkIdentity: "compose"`, kickoff-delivered marker.** Interleaved (launch + settle + send). It conflicts with upstream's `forkThread`, which already forks natively, but in a throwaway process without replaying argv identity. M.
7. **Quota failover, tier-2 effective model resolution, `model.rerouted`, T3 slow retry tier, `quota_exhausted` + resume sweep.** Heavily interleaved (`applyModelSelection`, `sendTurn`, `agent_end` classification, timers). L, roughly 600 lines in `PiDriver.ts` + `piTurnRetryPolicy.ts`. Upstream's turn terminal moves to `agent_settled`, so this logic would need re-anchoring, not just porting.
8. **Codex→Anthropic tool-id sanitiser + relaunch-with-rewritten-history.** Pre-spawn half is self-contained; the in-session cross-over relaunch is interleaved. M.
9. **Cost and model attribution on usage (`costUsd`, `model`, `resolvedModel`, `providerId`) for the usage ledger.** Interleaved in usage mapping; the V2 `tokenUsage` shape has no cost field (a contract question). S–M.
10. **Account quota pollers (`piQuotas.ts`, `accountUsage.loom.ts`).** Self-contained (driver-independent poller). S to rewire.
11. **Durable `ask_user_question` broker** (long-poll + durable settlement). Self-contained HTTP side; its emitter is registered per session in the driver and would map to V2 `runtime_request` / `user_input_request`. M.
12. **Activity slimming / inline-image materialisation / subagent result compaction.** Self-contained functions; hook into `emitToolItem`. S–M.
13. **`rawInput` merge for loop and stall detection.** Interleaved with V1 activity consumers. Upstream's items already carry `input`, so this may become redundant under V2. S.
14. **Stdout backpressure.** Transport-level (`RpcProcess` vs `PiRpc`). M if it is still wanted under V2's unbounded queue.
15. **Bundled-pi resolution + manual-only maintenance.** Self-contained (`Cli.ts`). S hunk in `PiAdapterV2` / `PiProvider` / `PiTextGeneration` spawn paths plus disabling `pi update --self`.
16. **`PI_CACHE_RETENTION` A/B.** Env at launch. S.
17. **`queue_update` → queue display.** S.
18. **Read-only consult fork, `thread_fork`, goal handoff and retro drafts.** These live outside the driver (`workstreamAsk.ts` uses Loom's `RpcProcess`) and depend on item 5's naming. M, coupled to 5.
19. **Contract deltas:** `PiSettings.enabled` default true; `customModels` as strings; thinking option id `thinkingLevel` vs `thinking` (stored selections); the `PI_DEFAULT_MODEL` default. S each, plus a data migration for stored option ids.

## Upstream-only behaviours Loom lacks

1. **The V2 adapter contract itself:** nodes, turn items, provider threads and turns, runtime requests, strong native refs. Loom would need it under any V2 adoption. L (already written upstream).
2. **Permission modes** through the bridge's `tool_call` hook, with mode change restarting pi. Self-contained in the extension. Loom deliberately runs full-access, so the value to Loom is low.
3. **Extension dialog fidelity:** confirm → approval with remember-for-session, file-change vs command classification, editor prefill, empty-value option, `notify` → work log, `extension_error` surfaced (buffered out of turn). M.
4. **`agent_settled` + idle-probe settlement,** command-only prompt settling, steer races, stale-probe generations, and detached compaction after settle. Interleaved; M–L. It makes turn ends more robust than Loom's `agent_end` path.
5. **Native, non-destructive rollback and fork / fork-from-turn** using session-tree entry refs (`get_entries`, `fork(entryId)`, throwaway `--fork` process in the destination cwd). M; conflicts with Loom's naming (item 5 above).
6. **`readThreadSnapshot`** (active branch through `get_messages`) for cross-provider handoff. S.
7. **"Pi default" model** with baseline capture and restore; **per-model thinking ladders** including `max`, with pi's configured level as default. S–M.
8. **Live context meter** from streaming usage + `get_session_stats` at settle. S.
9. **One retry row** across `auto_retry_start` / `auto_retry_end`; a compaction progress row; extension-error rows. S–M.
10. **Unsolicited-activity guard** (kill pi if it starts a run with no T3 turn owner). S. Loom should check this against its own extensions (`pi-intercom`, notices) before adopting it.
11. **`set_session_name`** from the thread title. S.
12. **`$skill` expansion** through `get_commands`. S.
13. **MCP-discovered T3 toolkit bridging** (orchestrator, preview, metadata tools appear in pi automatically). Self-contained. Loom gets T3's preview and PR toolkits in pi for free if it adopts this.
14. **`launchArgs` setting** with reserved-flag validation; **OpenRouter `max_tokens` cap**; **Windows process-tree kill**; **package-managed update** (undesirable for Loom while it patches).
15. **Replay harness:** `PiOrchestratorReplayHarness` + 8 recorded pi 1.0.0 transcripts (simple, multi-turn, steering, compaction, resume, rollback, rollback-after-stop, interrupt mid-tool) run through `OrchestratorReplayFixtures.integration.test.ts`.

## Base-choice assessment (facts only)

**Size and tests:**

| | Upstream | Loom |
| --- | --- | --- |
| Adapter + transport | ~3 500 lines: `PiAdapterV2.ts` 3 017 + `PiRpc.ts` 484 | ~3 600 lines: `PiDriver.ts` 2 959 + `RpcProcess.ts` 625 |
| Bridge | ~640 lines (injection 316 + extension source 328) | ~1 820 lines (`providerToolExtension.ts` 443 + `providerToolDefs.ts` 1 003 + `searchGuardExtension.ts` 377) |
| Other driver modules | — | ~1 320 lines in `askUserBroker.ts`, `piTurnRetryPolicy.ts`, `SessionIdSanitiser.ts`, `piSessionFiles.ts`, `Cli.ts`, `OneShotCompletion.ts`, `piQuotas.ts` |
| Pi test cases | 67 (49 in `PiAdapterV2.test.ts`, 2 530 lines) | 152 across 17 files (~4 300 lines), including 6 contract tests that run the **real patched pi** for `--cwd` (`PiCwdOverride.contract.test.ts`) |
| Replay fixtures | 8 recorded live-pi transcripts (~960 ndjson lines) + a 524-line testkit, driven through the shared V2 replay harness | None |

**Where each is richer:**
- **Runtime fidelity and orchestration integration — upstream.** Upstream's adapter is structurally richer on how pi's own runtime is reflected in the app: settlement, dialogs, approvals, rollback, fork and snapshot through session-tree refs, per-model thinking, the retry and compaction rows. It is the only one that implements the contract V2 orchestration requires.
- **Workstream, economics and operational behaviour — Loom.** Loom's driver carries behaviour upstream's cannot reproduce without work: the role- and goal-composed prompt with cache-identity fork replay, role tool profiles with `enable_toolset`, deterministic session naming that about 10 workstream modules depend on, resume after a worktree is reaped (patch 0001), quota failover with the retry tier, cost attribution, the tool-id sanitiser, the search guard and durable `ask_user_question`. Of these:
  - **Self-contained, attachable with a small launch hook:** the two extensions, quotas, the bundled-binary resolution and cache retention.
  - **Interleaved with lifecycle and identity, needing a design decision rather than a port:** session naming, resume and rollback; forkFrom replay; failover and retry; prompt composition.
- **Upstream's tool bridge and Loom's extension are complementary, not rival.** Loading both is mechanically trivial. The design question is whether Loom's workstream tools stay as REST-backed bare names or move into the T3 MCP toolkit, which would make them `mcp__t3-code__*` and change every role text, skill and memory that names them.
