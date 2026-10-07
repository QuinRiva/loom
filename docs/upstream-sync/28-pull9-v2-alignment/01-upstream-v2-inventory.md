# Pull 9 — upstream Orchestration V2 inventory (upstream half)

**Scope.** What upstream T3 Code's Orchestration V2 is and does, area by area, described on its own
terms. This is the upstream half of the Loom ↔ V2 comparison; the Loom half uses the same letters
A–L. No recommendations are made here.

**Snapshot.** `upstream/main` at `a1d9d72aef` ("fix(mobile): a message that fails to send now says
why in the thread", #15807). V2 landed in `de34391427` ("feat(orchestrator): introduce new
orchestrator", #2829, 2 Oct 2026) and has 155 follow-ups in `024d49520e..upstream/main`.

**Conventions.** Every path is a path inside `upstream/main` (read with
`git show upstream/main:<path>`), not inside the Loom worktree. Line numbers are approximate
anchors at this snapshot; symbol names are the stable reference. "Docs say" marks _intent_ from
`docs/orchestration-v2/` and related docs; "Code does" marks behaviour verified in source. Where they
differ, the divergence is called out (consolidated in §M).

**Frequently cited files.**

| Short name                                 | Path                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Orchestrator (decider + reactors, ~390 KB) | `apps/server/src/orchestration-v2/Orchestrator.ts`                                                           |
| V2 contracts (commands, events, entities)  | `packages/contracts/src/orchestrationV2.ts`                                                                  |
| MCP contracts                              | `packages/contracts/src/orchestratorMcp.ts`                                                                  |
| MCP service (delegate/task/thread tools)   | `apps/server/src/mcp/OrchestratorMcpService.ts`                                                              |
| Orchestrator toolkit definitions           | `apps/server/src/mcp/toolkits/orchestrator/tools.ts`                                                         |
| Thread toolkit definitions                 | `apps/server/src/mcp/toolkits/thread/tools.ts`                                                               |
| Subagent helpers                           | `apps/server/src/orchestration-v2/SubagentProjection.ts`                                                     |
| Shared prompt text                         | `apps/server/src/provider/T3OrchestrationInstructions.ts`, `apps/server/src/provider/RuntimeInstructions.ts` |

---

## A. Thread graph & delegation

### Data model

- **Lineage** is lightweight browsing metadata on every app thread:
  `OrchestrationV2AppThreadLineage = { parentThreadId: ThreadId | null, relationshipToParent: "fork" | "subagent" | null, rootThreadId }`
  (`packages/contracts/src/orchestrationV2.ts:103`). A thread has **at most one parent** and one of
  only two relationship kinds. There is no other edge type between threads.
- `OrchestrationV2AppThread.forkedFrom` (`orchestrationV2.ts:~385`) records the precise source:
  `{type:"run", threadId, runId}` | `{type:"node", nodeId}` | `{type:"provider_thread", providerThreadId, providerTurnId?}`.
  Delegated children use `{type:"node", nodeId: <parent's subagent node>}`.
- **Operational relationships** live in `ContextTransfer` rows (`orchestrationV2.ts:161`), typed
  `fork | provider_handoff | merge_back | subagent_spawn | subagent_result`. A thread can be in many
  transfers over time (docs: `docs/orchestration-v2/thread-lineage-and-context-transfer.md`, "Data
  Ownership").
- **Subagent record** on the _parent_ thread: `OrchestrationV2Subagent` (`orchestrationV2.ts:656`):
  `id` (= the parent's `subagent` execution node id, and the MCP `taskId`), `threadId` (parent),
  `runId` (parent run that spawned it), `parentNodeId`, `origin: "provider_native" | "app_owned"`,
  `childThreadId`, `prompt`, `title`, `model`, `providerInstanceId`, `driver`,
  `completionWake: "always" | "settled_only"`, `completionDelivery`, `status`
  (`idle|pending|running|waiting|completed|failed|cancelled|interrupted`), `progress`, `result`,
  timestamps. Persisted in `orchestration_v2_projection_subagents`.
- The parent's run also gets an `ExecutionNode` of `kind:"subagent"`, `countsForRun:false`, and a
  `subagent` turn item (the "task card").

### Three ways a thread gets created by an agent

| Path                                                                                                          | Lineage                                 | Code                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegate_task` (app-owned subagent)                                                                          | `subagent`, parent = caller             | `delegated_task.request` command → `dispatchDelegatedTaskRequest` (`Orchestrator.ts:6318`)                                                          |
| Provider-native subagent (Codex collab agent, Claude Agent/Task tool, Cursor, OpenCode 2, ACP/Grok subagents) | `subagent`, `creationSource:"provider"` | adapters call `makeSubagentChildThread` (`SubagentProjection.ts:42`), e.g. `Adapters/CodexAdapterV2.ts:2520`, `Adapters/ClaudeAdapterV2.ts:4161`    |
| `create_threads` / `t3_thread_launch`                                                                         | none (top-level, `parentThreadId:null`) | `OrchestratorMcpService.createThreads` (`:1576`), `ThreadLaunchService.ts`; parent records a `thread_created` turn item via `thread.created.record` |

Provider-native subagent threads cannot take messages (`isProviderNativeSubagentThread`,
`orchestrationV2.ts:440`; web shows `ProviderSubagentBar` instead of a composer). App-owned
delegated children (`creationSource:"mcp"`) can. Pi's example `subagent` extension is observed
best-effort and projected as subagent cards **with no child thread** (`Adapters/PiAdapterV2.ts:~1026`).

### How a delegated child is created and what it receives

`dispatchDelegatedTaskRequest` (`Orchestrator.ts:6318–6578`), under the parent thread's dispatch lock:

1. Requires the parent run to be blocking (`preparing|starting|running|waiting`) and the parent node
   to belong to it. The MCP layer additionally requires the active run to be owned by the calling
   credential's provider instance, else `parent_not_active` (`OrchestratorMcpService.ts:1369`).
   **Delegation is only possible from inside a live parent turn.**
2. Resolves the target adapter from `ProviderAdapterRegistryV2`.
3. Derives child thread id, task node id, message id and turn item id deterministically from the
   `commandId` (`idAllocator.derive.delegatedTask*`), so retries with the same `clientRequestId`
   return the same work.
4. Builds the child `AppThread` with `makeSubagentChildThread`, which **spreads the parent thread**
   — so the child inherits `projectId`, `branch`, `worktreePath` — then overrides id, title,
   provider/model, `lineage:{parentThreadId, relationshipToParent:"subagent", rootThreadId}`,
   `forkedFrom:{type:"node"}`, and resets settle/snooze/archive. Runtime and interaction modes come
   from the command (already narrowed by the MCP layer).
5. Emits on the parent: `thread.created` (child), `node.updated` (subagent node, running),
   `subagent.updated` (status running), `turn-item.updated` (subagent card).
6. Dispatches `message.dispatch` into the child with `dispatchMode:{type:"start_immediately"}`,
   `senderThreadId = parent`, text = task.
7. Emits a `subagent_spawn` `ContextTransfer` with `status:"consumed"` and `resolution:null` —
   i.e. **no context is transferred**; the child's only input is the task text.

The task text is `taskPrompt(input)` (`OrchestratorMcpService.ts:555`): the raw `task`, or, when
`role` is set and not `general`, `"Act as the <role> sub-agent for this task.\n\n<task>"`. Like every
V2 session with an MCP credential, the child also gets the shared orchestration instructions and
runtime info (see §G), and its own MCP credential — so **children can delegate further**; no depth
limit was found.

### Dependencies / ordering between children

**Nothing.** There is no dependency, blocking, or ordering field on a delegated task, and no
scheduler that starts one child when another finishes. Each `delegate_task` dispatches immediately
and children run concurrently. The only fan-in is notification batching: terminal children of the
same parent run are coalesced into one "completion cohort" wake message (see §F).

### Held / staged creation

- **Delegated tasks:** nothing — always dispatched immediately.
- `create_threads` entries without a `prompt` are created idle (the closest thing to staging).
- `message.dispatch` with `dispatchMode:{type:"defer_start", workspaceStrategy?}` puts a run in
  `preparing` until `prepared-run.release` (`ThreadLaunchService.ts:536, 819`). This is **workspace
  preparation** (worktree creation + setup script, `prepared-run.progress` phases `worktree|setup`,
  retry via `prepared-run.retry`, `737993303d`), not a hold for a human or a dependency.
- After a server restart, recovery can set `Run.queueHeld` so queued runs wait for an explicit
  `queue.resume` (`orchestrationV2.ts:~547`).

### Cancellation

- `task_cancel` → `run.interrupt` on the child's newest active run + dispatches
  `delegated_task.completion-delivery.dispose` (`OrchestratorMcpService.ts:1495`). On a terminal task
  it only disposes delivery and returns the existing status; later child runs are not interrupted.
- **No cascade from parent to app-owned children.** Interrupting the parent run marks its
  completion cohort `disposition:"stopped"` (`Orchestrator.ts:~8065`) but does not interrupt child
  threads. `thread.delete` on the parent disposes pending deliveries (`ThreadDeletion.ts:~131–180`)
  but does not touch child threads.
- A narrower cascade exists for **provider-native** subagents: when a root run ends
  interrupted/failed/cancelled, `cascadeTerminalizeRunOwnedSubagents`
  (`RunExecutionService.ts:205`, invoked at `:628`) terminalises the open subagent rows/nodes/turn
  items that the adapter's event stream attributed to that root run, including linked child-thread
  nodes. App-owned tasks are written by the orchestrator, not that stream.

### Worktree isolation and merge-back

- **No per-child worktree.** `delegate_task` has no workspace parameter; the child shares the
  parent's checkout.
- A separate worktree is only available for _top-level_ threads via `t3_thread_launch` with
  `workspaceStrategy: root | existing_worktree{worktreePath} | worktree{baseRef, branch?, startFromOrigin?}`
  (`OrchestrationV2ThreadLaunchWorkspaceStrategy`, `orchestrationV2.ts:511`), or by moving the
  _calling_ thread with `t3_worktree_handoff`. The shared instructions tell agents that `git
worktree add` in a prompt does not rebind a thread.
- **Merge-back is context, not code.** `thread.merge_back` creates a `merge_back` `ContextTransfer`
  resolved as `fork_delta_context` (a `fork_delta_summary` handoff of the child's delta since the
  fork point), injected with the next run on the target. There is no git merge or branch fan-in.
  Web exposes a **Merge** action in the Lineage panel (`ThreadRelationshipsControl.tsx`); agents have
  `t3_thread_merge_back`.

### Docs intent

`thread-lineage-and-context-transfer.md` wants user forks and agent-created subthreads to "feel like
the same graph shape with different `createdBy` and lifecycle policy"; that is what the code does
(both are app threads with `lineage` + `ContextTransfer`). The docs' broader fork sources
(`ForkSource` of `run | node | provider_thread`) are only partly exposed: the `thread.fork` command
accepts `latest_stable | run | checkpoint` (`OrchestrationV2ThreadForkSourcePoint`,
`orchestrationV2.ts:129`).

---

## B. Agent tool surface & transport

### Transport and credential scoping

- One authenticated HTTP MCP endpoint: `http://<host>:<port>/mcp`, provider-visible server key
  `t3-code` (`apps/server/src/mcp/McpHttpServer.ts`). It is mounted **outside** the environment auth
  stack; the bearer token is the only guard (comment at `McpSessionRegistry.ts:~70`).
- Before `ProviderSessionManager` opens a V2 provider session it revokes the thread's previous
  credential and issues a new one (`ProviderSessionManager.ts:~455–491`). Scope
  (`McpInvocationScope`, `apps/server/src/mcp/McpInvocationContext.ts`): `environmentId`, `threadId`,
  a credential-local `providerSessionId` (a fresh UUID, not the V2 `ProviderSessionId`),
  `providerInstanceId`, `capabilities`, `issuedAt`.
- Capabilities: always `orchestration`, `worktree`, `pull-requests`; plus `preview` when browser
  tools are allowed and `device` when device tools are allowed (`McpSessionRegistry.issue`, `:123`).
  Orchestration, thread, project, environment and attachment toolkits check `orchestration`
  (`OrchestratorMcpService.requireCapability`, `mcp/threadAccess.ts`).
- Lifetime (code): a single **24 h liveness window** (`DEFAULT_LIVENESS_WINDOW_MS`, `:81`) refreshed
  by every MCP request and by `touchActiveMcpThread` on every provider turn
  (`RunExecutionService.ts:1345`); eager revocation on session stop, thread revoke, or server stop.
  Only the SHA-256 of the token is held, in memory. (Docs say "maximum lifetime … and expire when
  idle"; no absolute maximum was found — see §M.)
- Idempotency: `clientRequestId` → stable command/thread/message ids scoped by the credential's
  `providerSessionId` (`stableCommandId`, `OrchestratorMcpService.ts:~475`). Without it, a random
  request key is generated and new work is created.

### Per-provider injection

| Provider              | Mechanism                                                                                                                                                      | Instructions channel                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Codex app-server      | `-c mcp_servers.t3-code.url=… -c mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"`                                                               | developer instructions (`provider/CodexDeveloperInstructions.ts:218`) |
| Claude Agent SDK      | `mcpServers["t3-code"] = {type:"http", url, headers:{Authorization}}`, `allowedTools += "mcp__t3-code__*"`                                                     | appended to system prompt (`Adapters/ClaudeAdapterV2.ts:911`)         |
| Cursor Agent SDK      | SDK `mcpServers`                                                                                                                                               | prepended to first-run prompt (`t3OrchestrationPromptForFirstRun`)    |
| OpenCode / OpenCode 2 | SDK MCP config                                                                                                                                                 | system prompt (`t3OrchestrationSystemPrompt`)                         |
| Grok / ACP Registry   | ACP `session/new                                                                                                                                               | load                                                                  | fork` `mcpServers`; fallback CLI `acp-mcp-call`via`T3_ACP_MCP_NODE` (`mcp/AcpMcpStdioBridge.ts`, `mcp/AcpMcpOverAcpBridge.ts`) | `<t3_code_instructions>` wrapper in first prompt and on mode/tool change (`t3AcpPromptWithInstructions`) |
| Pi                    | T3-owned extension written to cache, `pi --mode rpc --extension <cache>/pi-t3-mcp-extension.ts`, env `T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, `T3_PI_RUNTIME_MODE` | `before_agent_start` appends to system prompt                         |

**Pi bridge** (`Adapters/piT3McpExtensionSource.ts`, `Adapters/piT3McpInjection.ts`): a minimal
fetch-based MCP client (initialize → `tools/list` with pagination → `tools/call`, header
`mcp-protocol-version: 2025-06-18`). Every listed tool is registered with `pi.registerTool` as
`mcp__t3-code__<name>`, JSON Schema wrapped with `Type.Unsafe`. The same extension also implements
T3 permission modes via Pi's blocking `tool_call` hook (`ctx.ui.confirm`, read-only tools exempt,
edit/write exempt in auto-accept-edits) and caps OpenRouter `max_tokens` at 32 768 as a workaround.
T3 does not replace Pi's own `subagent` tool or extension loader.

### Full tool catalogue (code)

72 tools across ten toolkits are registered on `/mcp` (`McpHttpServer.ts:~650–730`). The
orchestration-relevant ones:

**`OrchestratorToolkit`** (`mcp/toolkits/orchestrator/tools.ts`, 15 tools):

| Tool                                                                       | Inputs                                                                                                                                                           | Output                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator_capabilities`                                                | none                                                                                                                                                             | `parentThreadId`, inherited instance/model, runtime/interaction modes, `providers[]` {instanceId, driverKind, displayName, models[{id,label,options?}], `canRunChildTask`, `canRunCrossProviderChildTask`, `constraints[]`}, `features` {appOwnedSubagents, asyncPolling, cancellation, batchThreadCreation, threadManagement, incrementalThreadRead, scheduledTasks, maxBatchThreads:20} |
| `delegate_task`                                                            | `task`, `target?{providerInstanceId?, driverKind?, model?, options?}`, `title?`, `role?` (`implementation                                                        | research                                                                                                                                                                                                                                                                                                                                                                                  | review                                                        | design                        | test                                          | general`), `mode?` (`async`default,`wait`), `timeoutMs?`(default 10 min, max 60 min),`clientRequestId?`, `runtimeMode?`, `interactionMode?` | `DelegateTaskResult` {`taskId`, `childThreadId`, `childRunId`, `childNodeId`, `status` (`queued | running     | waiting | completed | failed | cancelled | interrupted`), `workState` (`working | waiting_for_children | result_available`), `hasPendingChildRuns`, `latestTerminal{RunId,Status,Summary,ResultContextTransferId}`, `providerInstanceId`, `model`, `summary`, `resultContextTransferId`, `waitTimedOut`} |
| `task_status`                                                              | `taskId`                                                                                                                                                         | `DelegateTaskResult`; reading a terminal result **acknowledges** automatic parent delivery                                                                                                                                                                                                                                                                                                |
| `task_cancel`                                                              | `taskId`, `reason?`, `clientRequestId?`                                                                                                                          | `{taskId, status: cancel_requested                                                                                                                                                                                                                                                                                                                                                        | completed                                                     | failed                        | cancelled                                     | interrupted}`                                                                                                                               |
| `schedule_task`                                                            | `prompt`, `schedule` (`interval{everyMs}` / `fixed_time{timeOfDay, weekdays?}`), `title?`, `enabled?`, `bindToCurrentThread?` (default true), `clientRequestId?` | scheduled task summary                                                                                                                                                                                                                                                                                                                                                                    |
| `list_scheduled_tasks` / `update_scheduled_task` / `delete_scheduled_task` | project-scoped CRUD                                                                                                                                              | summaries                                                                                                                                                                                                                                                                                                                                                                                 |
| `create_threads`                                                           | `threads[1..20]{prompt?, title?, target?, runtimeMode?, interactionMode?}`, `clientRequestId?`                                                                   | `threads[]{threadId, runId, status, title, createdBy, creationSource, providerInstanceId, model}`                                                                                                                                                                                                                                                                                         |
| `t3_thread_list`                                                           | `statuses?`, `titleContains?`, `settled?`, `includeSubagents?`, `cursor?`, `limit?`                                                                              | shells incl. `parentThreadId`, `relationshipToParent`, `settled`, linked PR                                                                                                                                                                                                                                                                                                               |
| `t3_thread_read`                                                           | `threadId`, `view?` (`messages                                                                                                                                   | activity`), `afterPosition?`, `limit?`, `runLimit?`, `maxCharsPerItem?`, `itemId?`, `textOffset?`                                                                                                                                                                                                                                                                                         | thread detail, recent runs, timeline items (`visibility local | inherited                     | synthetic`), `nextPosition`, `nextTextOffset` |
| `t3_thread_update`                                                         | `threadId?`, action `rename                                                                                                                                      | regenerate_title                                                                                                                                                                                                                                                                                                                                                                          | link_pull_request                                             | unlink_pull_request`          | receipt + resultant metadata                  |
| `t3_thread_send`                                                           | `threadId`, `message`, `mode?` (`auto                                                                                                                            | queue                                                                                                                                                                                                                                                                                                                                                                                     | steer                                                         | restart`), `clientRequestId?` | `{messageId, runId, status, delivery: started | queued                                                                                                                                      | steered                                                                                         | restarted}` |
| `t3_thread_wait`                                                           | `threadId`, `runId?`, `timeoutMs?`                                                                                                                               | `{runId, status, timedOut}`; does **not** acknowledge a delegated result                                                                                                                                                                                                                                                                                                                  |
| `t3_thread_interrupt`                                                      | `threadId`, `runId?`, `reason?`, `clientRequestId?`                                                                                                              | `interrupt_requested                                                                                                                                                                                                                                                                                                                                                                      | no_active_run                                                 | <terminal status>`            |

**`ThreadToolkit`** (`mcp/toolkits/thread/tools.ts`, 17 tools): `t3_thread_organize` (pin, unpin,
snooze, unsnooze, settle, unsettle, archive, unarchive, mark_unread); `t3_queue_list`,
`t3_queue_read`, `t3_queue_edit`, `t3_queue_cancel`, `t3_queue_reorder`, `t3_queue_promote_to_steer`;
`t3_pending_request_list`, `t3_pending_request_read`, `t3_pending_request_respond` (user questions
only, never approvals); `t3_thread_configuration`, `t3_thread_configure` (change the _calling_
thread's model selection); `t3_thread_fork`, `t3_thread_merge_back`, `t3_thread_transfers`;
`t3_thread_search`; `run_scheduled_task_now`.

**`ProjectToolkit`** (7): `t3_project_list|read|create|update|delete|clone`, and
**`t3_thread_launch`** (top-level thread with `workspaceStrategy`; requires full-access/default
caller; no idempotency key).

**Others:** `WorktreeToolkit` (`t3_worktree_handoff`, `t3_worktree_status`, `t3_worktree_list`),
`PullRequestsToolkit` (`link_pull_request`, `unlink_pull_request`, `list_thread_pull_requests`,
`watch_pull_request`, `unwatch_pull_request`), `AttachmentToolkit` (3), `EnvironmentToolkit` (2),
`PreviewToolkit` (14 `preview_*`), `PreviewControlsToolkit` (2), `DeviceToolkit` (4).

### Policy

- Runtime-mode ceiling: child/send target may be equal or narrower
  (`approval-required < auto-accept-edits < auto < full-access`); interaction mode may narrow
  `default → plan` only (`resolveRuntimeMode` / `resolveInteractionMode`,
  `OrchestratorMcpService.ts:~446–475`).
- Thread management is project-scoped; exception: `t3_thread_read` may read a thread the _user_
  attached as context to one of their own messages, even cross-project
  (`userAttachedThreadIds`, `:836`).
- Typed failures (`OrchestratorMcpFailure.code`, `orchestratorMcp.ts:568`): `capability_denied`,
  `parent_not_active`, `provider_unavailable`, `model_unavailable`,
  `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`, `task_not_found`,
  `task_not_cancellable`, `thread_not_found`, `run_not_found`, `thread_not_sendable`,
  `thread_not_interruptible`, `invalid_request`, `orchestration_error`.

`ThreadManagementService` (`orchestration-v2/ThreadManagementService.ts`) is the shared
application boundary for WebSocket and MCP: project-scoped lookup/listing, send-mode selection,
durable send postconditions, wait polling, interrupt selection. `OrchestratorV2` remains the
command/event processor.

---

## C. Lifecycle & state model

### State names

- **Run** (`OrchestrationV2RunStatus`, `orchestrationV2.ts:446`): `preparing`, `queued`,
  `starting`, `running`, `waiting`, `completed`, `interrupted`, `failed`, `cancelled`,
  `rolled_back`. On a provider "completed" terminal the run first persists as `waiting` (finalisation
  barrier: streams flushed, checkpoint captured) before `completed` (`RunExecutionService.ts:637`);
  the orchestrator treats a `waiting` run as "post-terminal drain" (`hasLiveRun`,
  `Orchestrator.ts:474`). Docs also put a run in `waiting` on a user-input request; in code the
  request's node/turn item goes `waiting` and the shell exposes `pendingRuntimeRequest`.
- **RunAttempt**: `reason initial|steering_restart|retry|provider_recovery`; status adds
  `superseded`.
- **ExecutionNode**: `idle|pending|running|waiting|completed|interrupted|failed|cancelled|rolled_back`.
- **ProviderSession**: `starting|ready|running|waiting|stopped|error`. **ProviderThread**:
  `not_loaded|idle|active|archived|closed|error`, plus `pendingBackgroundTasks[]` (kinds
  `subagent|command|monitor|background_task`).
- **Thread shell** (`OrchestrationV2ThreadShell`, `:1714`): `status` (= `idle` or a run status),
  `activityRunStatus` (`preparing|starting|running|waiting`), `pendingRuntimeRequest`,
  `pendingBackgroundTasks`, `hasActionableProposedPlan`, `settledOverride` (`settled|active`),
  `settledAt`, `unsettledAt`, `snoozedUntil`, `snoozedAt`, `limitRecovery`, `pinnedAt`,
  `autoSettleDisabledAt`, `lastVisitedAt`, `latestUserAuthoredMessageAt`.
- **Delegated task**: `status` above plus derived `workState` (`delegatedTaskProgress`,
  `SubagentProjection.ts:208`): `working` while any non-monitor child run is active;
  `waiting_for_children` when the child's turn ended but it has live subagents, pending completion
  deliveries, or pending background tasks; `result_available` otherwise.

### What completes a turn

Docs invariant 3/README: "Make root-run completion the only event that completes a user-visible
turn"; "Child execution completion never closes the parent run." Code: only the root node
terminalises the run; subagent nodes complete independently. A delegated task's **published result
is the first (original) child run's** terminal output and stays stable; later runs on the child
thread are surfaced as `latestTerminal*`/`hasPendingChildRuns` and never reopen the task
(`readTask`, `OrchestratorMcpService.ts:1012`).

### Wake conditions (what starts a run without the user)

All wakes are ordinary runs started by `message.dispatch` with `createdBy:"agent"` and a
`notification` (`OrchestrationV2Notification{source, outcome, summary, detail?}`, sources
`delegated_task | subagent | command | monitor | background_task`). `Run.workStartedAt` keeps
working timers counting from the original prompt (`736130c2fd`).

1. **Delegated task completion** (§F) — steered into the parent's active turn when the live session
   `supportsActiveSteering` and all tasks are `completionWake:"always"`, otherwise queued
   (`queue_after_active`); never interrupts a turn (`Orchestrator.ts:~4570`).
2. **Provider-native background work** (Claude background Bash, Codex/Grok monitors, subagent
   finishes) — adapters offer `ProviderContinuationRequests`; `ProviderContinuationService` queues a
   continuation run (`ProviderContinuationService.ts:~60–175`).
3. **PR watch** (`18b21325c3`) — `watch_pull_request`; `PullRequestWatchReactor` polls every minute
   and wakes the thread when a check fails, required checks pass, someone else comments/reviews, or
   the branch conflicts (internal command `thread.pull-request-watch.sync` with `wake`; rejected on a
   settled or archived thread).
4. **Scheduled tasks** — bound to a thread (`bindToCurrentThread`) or launching a fresh thread.
5. **Usage-limit recovery** — `limitRecovery{runId, resetAt, autoResume, snooze}`,
   `UsageLimitRecoveryWorker.ts`.
6. **Restart continuation** (below).

Separately, **snooze/wake** is a sidebar state: `thread.snooze{snoozedUntil}` / `thread.unsnooze`;
a thread "wakes" when `snoozedUntil` passes or early when it "raises a hand" (needs approval/answer);
clients show a **Woke** pill/banner until visited (`threadWokeAt`,
`packages/client-runtime/src/state/threadSettled.ts:185`; `c5a929e1ac`).

**Settlement** is server-owned (`ThreadSettlementService.ts`): `thread.settle`/`thread.unsettle`
(user), `thread.auto-settle` (server sweep, guarded against newer activity and explicit overrides),
`thread.auto-settle.set` (per-thread opt-out). Defaults: settle after 3 days inactive and when a
linked PR merges (`ca4f84e702`, `243d1e7c44`); work in progress, pending requests and live
background work block it. Only user-authored messages count as resuming a merged thread.

### Restart recovery

`docs/internals/server-updates.md` ("Recovering interrupted threads"; `5108c978b1` "restarts keep
delegated tasks, queued threads, and stops intact"):

- Restart continuation is an environment preference, **off by default**.
  `ProviderRuntimeRecoveryService.ts` requires matching durable run, provider thread, session and
  strong native resume identity; `restartContinuationRun` (`RestartContinuation.ts`) only resumes an
  unfinished root turn ("Continue where you left off."). Queued runs are held behind the cut run.
- Recovery retires effects tied to the lost process and records continuation intent in the durable
  effect outbox; continuations wait for server activation.
- **Delegated tasks are reconciled as their own threads**, never as the parent's background work. A
  startup pass after reconciliation settles child results and completion deliveries; a cancelled
  child with a pending restart continuation is not yet a result (`childAwaitsRestartContinuation`,
  `delegatedTaskResultPending`). `task_status` reports `working` meanwhile.
- Restart-cancelled background work is recorded on the run (`restartCancelledBackgroundWork`) and
  told to the provider once on the next turn (`RestartBackgroundNote.ts`). Settled threads stay
  asleep after restarts (`253dea360e`).

### Stuck runs, idle and stall detection

- `ProviderSessionManager` releases **idle** sessions after 30 min (`DEFAULT_IDLE_TIMEOUT_MS`),
  deferring up to 4 h while the adapter reports pending background work
  (`DEFAULT_MAX_IDLE_PIN_MS`); release reasons `idle_timeout|runtime_error|manual_shutdown|server_shutdown`
  (`ProviderSessionManager.ts:52–62`). Sessions are recreated lazily on next work.
- `6108ef3d3d` ("runs no longer get stuck") hardened outbox/event-sink/session-manager races.
- **Nothing** detects a turn that is running but making no progress (no heartbeat or no-output
  watchdog for an active run). Inactivity only matters for auto-settlement of idle threads.

---

## D. Review gates & verdict routing

**Nothing structural.** There is no review gate, verdict token, round counter, round cap, reviewer
role binding, or routing of a worker's output to a reviewer.

What exists is guidance (`31a9da179e`, "keep delegated review rounds on the task API"):

- The shared instructions and `delegate_task`/`t3_thread_send` descriptions tell the agent: for
  every delegated review round, call `delegate_task` **again** with the original brief, prior
  findings, responses, and unresolved objections; track each round by its own `taskId`; use a
  distinct `clientRequestId` per round; do **not** use `t3_thread_send` on `childThreadId` to
  continue a review (`T3OrchestrationInstructions.ts`, `orchestrator/tools.ts:58`).
- Docs: "There is no task-level follow-up API for preserving the same reviewer session"
  (`orchestrator-mcp-server.md`, `delegate_task`).
- `role: "review"` only prefixes the prompt with "Act as the review sub-agent for this task."

The loop, its termination, and verdict interpretation live entirely in the parent agent's reasoning.

---

## E. Goals & task tree

**Nothing.** No durable objective above a thread, no shared checklist/task tree, no goal entity,
and no tool for agents to read or update one (no `goal` concept in
`apps/server/src/orchestration-v2/`, `packages/contracts/src/`, or the MCP toolkits).

Adjacent things that are _not_ goals or trees:

- **Todo lists** — provider-native live progress (`todo_list` turn items / `PlanArtifact
kind:"todo_list"`, steps `pending|running|completed`) scoped to a single run. Child todo lists stay
  nested under their node and do not replace the root's (`feature-lifecycles.md`, "Plans And Todo
  Lists").
- **Proposed plans** — `proposed_plan` artifacts from plan mode; implementing one creates a new run
  or thread (`sourcePlanRef`), thread shell flag `hasActionableProposedPlan`.
- **Scheduled tasks** — recurring prompts (`ScheduledTask`, `packages/contracts/src/scheduledTask.ts`;
  table `scheduled_tasks`).
- The `Subagent` rows on a parent are the only per-parent list of delegated work.

---

## F. Context transfer

### Primitives

`ContextTransfer` (relationship + `sourcePoint` + optional `basePoint` + `status
pending|resolved_native|resolved_portable|failed|consumed|superseded` + `resolution`) and
`ContextHandoff` (the materialised payload). Resolution strategies (`orchestrationV2.ts:136`):
`native_fork`, `portable_context`, `delta_context`, `fork_delta_context`, `checkpoint_context`.
Handoff strategies (`:883`): `delta_since_target_last_seen`, `fork_delta_summary`,
`full_thread_summary`, `checkpoint_summary`, `manual_context`. Docs principle (README invariants
8–9): handoffs are explicit, auditable graph artefacts, "not hidden prompt hacks"; forks record
lineage first and resolve provider context lazily at first dispatch.

### Fork

`thread.fork{sourceThreadId, targetThreadId, sourcePoint: latest_stable|run|checkpoint}`
(`ThreadForkService.ts`) creates an idle thread with `fork` lineage and a `pending` transfer; no
provider session/thread is created. First dispatch resolves it: same provider with native fork
support → `native_fork` (`resolved_native` → `consumed`); otherwise a portable handoff is
materialised. Active source runs are rejected for explicit forks. Codex native fork uses
`lastTurnId`; paginated Codex threads cannot use the rollback fallback, and paginated
`thread/revert` is "not implemented yet" (docs).

### Provider handoff / switching

Switching provider is a transfer on the same thread (`provider_handoff`). Intent
(`provider-switching-and-context.md`): on return to a provider, resume its old provider thread and
inject a delta of off-provider runs; fall back to a fresh provider thread with a full summary when
resume fails, settings are incompatible, or context is stale. Code: `ProviderSwitchService.ts` +
`ProviderSessionTransitionPolicy.decideProviderSessionTransition` →
`reuse | switch_model_in_session | restart_and_resume | create_with_handoff | reject`.

### Handoff content and budget

- `ContextHandoffServiceV2` (`ContextHandoffService.ts`) produces both a compact `summaryText`
  (each item ≤240 chars via `compactText`; user/assistant messages, commands, file changes,
  checkpoints, prior handoffs) and a `history` block of selected historical messages kept intact
  (`OrchestrationV2HistoricalMessage[]`, `coverage`, `omittedItems`, `omittedItemIds`).
- `ContextHandoffBudget.ts`: `T3CODE_CONTEXT_HANDOFF_TOKEN_CAP` (default 16 000, clamped
  1 024–64 000), one token per UTF-8 byte, 64 000-byte ceiling on imported history; uses model
  capacity and live provider context telemetry; fallback window 128 000 tokens with a reserve of
  max(16 000, ¼ window); images reserve 8 192, other attachments 4 096 (`docs/user/portable-handoffs.md`).
- `ContextHandoffDelivery.ts`: Codex receives history natively via `injectHistory` when supported
  (`delivery.status:"injected"`); others get attributed inline context (`"inline"`). Omitted items
  are referenced so the agent can fetch them with `t3_thread_read`.
- Legacy V1 continuation uses a separate 32 000-character user/assistant suffix
  (`docs/internals/legacy-orchestration-migration.md`).

### Continue with fresh context

No explicit "fresh context" command. A fresh provider thread with a full summary happens through
the transition policy (`create_with_handoff`) or when resume fails; users can fork, or start a new
thread. Native `/compact` is treated as a maintenance turn.

### Reading another thread

`t3_thread_read` (project-scoped, plus user-attached threads) with incremental `afterPosition`
paging and long-item `textOffset` recovery; `t3_thread_list`, `t3_thread_search`,
`t3_thread_transfers`. Reading an untruncated terminal assistant result of a direct app-owned child
acknowledges that child's delivery. `88744f3ddb` fixed paging back through earlier transcript pages
of app-agent threads.

### Notifications between threads

- Agent → thread: `t3_thread_send` (`auto|queue|steer|restart`), recorded as a user-role message
  with `createdBy:"agent"`, `creationSource:"mcp"`, `senderThreadId`.
- Child → parent: only via delegated-task completion delivery (below) and, for provider-native
  children, background-work notifications. There is no general pub/sub or "notify parent" tool.

### How a child's result is handed back

`finalizeAppOwnedSubagent` (`Orchestrator.ts:8871`), triggered by terminal child run events (event
stream replays persisted events then follows live ones, so it also runs after restart), under the
**parent's** lock:

1. Skips until `delegatedTaskProgress` says `result_available` and no restart continuation is
   pending.
2. Result text = `subagentResultForRun` (`SubagentProjection.ts:156`): the provider error message for
   a failed run, else the latest non-empty assistant message of that run, else a stock sentence.
3. Writes the terminal `subagent.updated` (status, `result`), parent node/turn item terminal, a
   `subagent_result` `ContextTransfer` (`status:"consumed"`, `createdBy:"system"`) and, when both
   provider threads exist, a `manual_context` `ContextHandoff` carrying the result text. An existing
   `subagent_result` transfer makes this idempotent.
4. Plans delivery (`planDelegatedCompletionDelivery`, `:8665`). State per task:
   `completionDelivery.state pending | claimed | acknowledged | delivered | disposed`; per parent run:
   `delegatedCompletion` cohort `{disposition open|stopped|disposed, nextGeneration, delivery{generation, messageId, taskIds[]}}`.
   `completionWake:"always"` (async) offers a wake even mid-turn; `"settled_only"` (wait mode)
   offers only when the parent has no live run (the blocking tool call delivers otherwise). Siblings
   join a still-queued cohort message rather than creating another.
5. The wake message text is generic: "Delegated task <id> reached a terminal state. Use task_status
   with taskId <id> to read the result." (`delegatedCompletionWakeDetail`, `:509`). **The result
   itself is not pushed into the parent's prompt;** the parent must call `task_status` (or read the
   child), which acknowledges delivery.

The wake is a durable mailbox offer: delivery is at-least-once with stable message ids
(`NotificationMailbox.ts`); `notification.delivery.accept` records provider acceptance.

---

## G. Prompt composition

- **Shared orchestration instructions** — `T3_CODE_ORCHESTRATION_INSTRUCTIONS`
  (`provider/T3OrchestrationInstructions.ts`): distinguishes delegated tasks from top-level threads;
  prefer native subagents only when they support the chosen model, otherwise `delegate_task`; retain
  `taskId`; `childThreadId` is backing storage; review-round rule (§D); `schedule_task` shape;
  "choose the workspace before starting a new thread" with `t3_thread_launch` examples; idempotency;
  lazy MCP attachment hint (`tools.mcp__t3_code__orchestrator_capabilities({})` in Codex code mode);
  ACP CLI fallback. Injected only when the session has an MCP credential.
- **Browser instructions** — `T3_CODE_BROWSER_TOOL_INSTRUCTIONS` (preview tools), only when the
  `preview` capability is granted.
- **Runtime info** — `buildRuntimeInstructions` (`provider/RuntimeInstructions.ts`): one
  `<runtime_info>` line (harness, model display name/slug, reasoning effort) plus
  `<pull_request_linking>` rules (always `link_pull_request`, use `watch_pull_request` instead of
  polling).
- **ACP interaction-mode text** — Default/Plan mode paragraphs, since ACP has no system prompt.
- **Per-delegate role** — a single sentence prefix from the six-value `role` enum. There are **no
  role definitions**, role files, or role-specific tool sets.
- **AGENTS.md / skills** — not composed by T3. Each provider loads its own context files natively
  (Pi: AGENTS.md/SYSTEM.md, settings, extensions, skills all stay Pi's, `Adapters/PiAdapterV2.ts:7`).
  T3 only _discovers_ skills for the composer `$` picker (`provider/Drivers/ClaudeSkills.ts`,
  `CursorSkills.ts`, `GrokSkills.ts`, `AntigravitySkills.ts`, `provider/PiCommands.ts`). The only
  T3-side AGENTS.md read is for git commit-message generation (`git/GitManager.ts:777`).
- Composition per provider is in §B's table (developer instructions, system prompt append,
  first-prompt wrapper, or Pi `before_agent_start`).

---

## H. Model selection

- **Per child:** `delegate_task.target` / `create_threads[].target` — `providerInstanceId`
  (honoured exactly, fails if unavailable), or `driverKind` (prefer the parent's instance if it is
  that driver and healthy, else the first healthy instance of the driver), `model` (must be
  advertised when the provider publishes a list; a different provider without a model gets its first
  advertised model), `options` (validated against model option descriptors; inherited only when
  provider+model equal the parent's) (`resolveTarget`, `OrchestratorMcpService.ts:889`).
- **Availability:** `orchestrator_capabilities` lists every registered provider instance and marks
  `canRunChildTask` false with model-visible `constraints` when no V2 adapter resolves or the
  instance is disabled/not installed/unauthenticated. The orchestration-capable set is exactly
  `ProviderAdapterRegistryV2.list()` — the same lookup `delegated_task.request` uses.
- **Between runs on one thread:** `thread.model-selection.set`, `provider.switch`; each `Run`
  records its own `providerInstanceId`, `modelSelection`, `providerThreadId`;
  `providerInstanceHistory` on the shell lists where a thread has been. Agents can change their own
  selection with `t3_thread_configure`.
- **Capability-driven behaviour:** `OrchestrationV2ProviderCapabilities` (`orchestrationV2.ts:312`:
  sessions, threads, turns, streaming, tools, approvals, planning, subagents, context,
  checkpointing, identity, runtimePolicy) is emitted by each adapter. E.g. steering:
  `supportsActiveSteering` true for Codex, Claude, OpenCode, OpenCode 2, Pi; false for Cursor and ACP
  (which use interrupt-and-restart).

---

## I. Human-in-the-loop

- **Approvals** — provider callbacks become `RuntimeRequest`s (`orchestrationV2.ts:966`) with kind
  from `ProviderRequestKind` (command, file-read, file-change, …) or `dynamic_tool_call | user_input |
auth_refresh`; status `pending|resolved|expired|cancelled`; `responseCapability live | message |
not_resumable`. The request's node is `waiting` and the shell carries `pendingRuntimeRequest`;
  UI `ComposerPendingApprovalPanel`; response via
  `runtime-request.respond{decision}`. After restart, requests without live callback state are
  `not_resumable`.
- **Structured user questions** — `user_input_request` nodes/turn items and `PlanArtifact
kind:"questions"`; questions carry `header`, `question`, `options[{label, description, value?}]`,
  `multiSelect`, `allowCustomAnswer`, `required`. Sources: Codex `requestUserInput`, Claude
  AskUserQuestion, OpenCode, ACP, Grok's xAI extension (`extractXAiAskUserQuestions`,
  `provider/acp/XAiAcpExtension.ts`), Pi extension dialogs (`select|input|editor` → user input,
  `confirm` → approval). `supportsStructuredQuestions` is false only for Cursor. Answer via
  `runtime-request.respond{answers, attachmentsByQuestionId}`; dismiss via
  `thread.user-input.dismiss`; manual settle dismisses unanswered async questions.
- **Agent-answered questions** — `t3_pending_request_list|read|respond` let an agent answer another
  thread's user question in the project; they cannot approve permissions.
- **Subagent requests** — user doc: when a provider-native subagent needs an approval or answer, the
  parent thread asks for it.
- **Interaction modes** — `plan` vs `default`; plan mode yields `proposed_plan` artefacts the user
  accepts/implements.
- **Holding a thread for a human** — only implicitly: a run waiting on a request, an actionable
  proposed plan, or snooze. There is **no** acceptance/sign-off hold, no "needs guidance" flag, and
  no agent tool to raise one.

---

## J. UI (web and mobile)

- **Lineage panel** (web thread details): `apps/web/src/components/chat/ThreadRelationshipsControl.tsx`
  — "Lineage · N running"; rows for parent agent, subagents, forks, parent thread, context transfers;
  groups _active_ / _Previous agents_ (collapsed); paged 6 then 12; actions **Merge** (merge-back)
  and **Detach** (stop session). Live child runs override a settled task's timer (`d3071275d5`).
- **Agents surface / subagent cards**: `chat/ProviderSubagentBar.tsx` (stands in for the composer on
  provider-native subagent threads), `chat/SubagentTooltipContent.tsx`, `chat/agentSpawnSummary.ts`,
  `ThreadRelationshipIcon.tsx`; client state `packages/client-runtime/src/state/threadSubagents.ts`,
  `subagentDisplay.ts`, `subagentRuntime.ts`. Cards name the provider account (`daa1d0ed94`);
  finish notifications render as subagent cards (`dab26f582c`). Subagent threads are filtered out of
  the sidebar (`filterSidebarV2VisibleThreads`, `Sidebar.logic.ts:~565`).
- **Mobile**: `apps/mobile/src/features/threads/ThreadAgentsSheet.tsx`, `SubagentRow.tsx`,
  `SubagentStatusDot.tsx`, `thread-subagent-group.tsx`, `ProviderSubagentBar.tsx`,
  `thread-handoff-row.tsx`, `threadForkNavigation.ts`; back from an agent's thread returns to its
  parent (`01f894e23e`).
- **Working section (beta)**: `packages/client-runtime/src/state/threadInbox.ts` — threads running
  or monitoring background work fold into a collapsed **Working** section; they return to the inbox
  on finish/failure/approval/question/plan prompt. Inbox ordered by "last came back to you"; Working
  ordered by last user send (`8d846660ce`, `1302ccacbd`).
- **Settle / wake**: sidebar Settle, Un-settle and Wake buttons with drag-sweep across a section
  (`1826fb55cc`); Settled and Snoozed shelves; **Woke** pill and in-thread banner, dismiss syncs
  (`c5a929e1ac`); Undo toasts.
- **Activity log**: consecutive tool calls grouped; T3 Orchestrator calls summarised ("Ran 2
  commands and sent messages to 3 threads"), shared across providers by
  `packages/shared/src/t3McpToolPresentation.ts` (`ec20db4a5a`); `docs/user/activity-log.md`.
- **Plans / questions**: `ProposedPlanCard.tsx`, `ComposerPlanFollowUpBanner.tsx`,
  `ComposerPendingUserInputPanel.tsx`, `ComposerPendingApprovalPanel.tsx`; todo lists in the
  timeline. No goal or task-tree view.
- Timeline rendering: `apps/web/src/lib/orchestrationV2Timeline.ts` over the server's ordered
  `turnItems` / `visibleTurnItems` (forks show inherited items with `visibility:"inherited"`).

---

## K. Persistence

- **Database file:** V2 uses `statev2.sqlite` (`apps/server/src/config.ts:140`). On first launch
  `initializeV2Database` (`persistence/initializeV2Database.ts`) takes a read-only SQLite
  `backup()` of `state.sqlite` and hard-links it into place; only the copy is migrated. It is a
  whole-file copy, so **every table** in `state.sqlite` (including any fork tables and ledgers) is
  carried into `statev2.sqlite` once; afterwards the two never sync.
- **Event store:** `orchestration_v2_events` (`sequence INTEGER PRIMARY KEY AUTOINCREMENT`,
  `event_id`, `command_id`, `thread_id`, `run_id`, `node_id`, `provider`/`provider_instance_id`,
  `raw_event_id`, `event_type`, `occurred_at`, `payload_json`) with thread/type/run/node/command
  indexes; `orchestration_v2_command_receipts` (`command_id` PK, `result_sequence`, …) for
  idempotent dispatch. The sequence is the snapshot-plus-cursor boundary for WebSocket streams.
- **Domain events** (`OrchestrationV2DomainEvent`): `thread.created`, `run.created`, `run.updated`,
  `run.background-work-cancelled`, `run-attempt.created|updated`, `node.updated`,
  `subagent.updated`, `provider-session.detached`, `provider-thread.updated`,
  `provider-turn.updated`, `runtime-request.updated`, `message.updated`, `turn-item.updated`,
  `plan.updated`, `checkpoint-scope.created`, `checkpoint.captured`,
  `checkpoint.rollback-requested`, `context-handoff.updated`, `context-transfer.created|updated`.
  Many are full-row upserts ("`.updated`" with the whole entity as payload).
- **Commands** (`OrchestrationV2Command`, `orchestrationV2.ts:2477`, ~50 client commands) plus
  server-only `OrchestrationV2InternalCommand` (`:2923`: `thread.pull-request-watch.sync`,
  `checkpoint.rollback.fail`, `thread.background-work.settle`).
- **Projections** (one table per entity): `orchestration_v2_projection_{threads, runs, run_attempts,
nodes, subagents, provider_sessions, provider_session_bindings, provider_threads, provider_turns,
runtime_requests, messages, plans, turn_items, checkpoint_scopes, checkpoints, context_handoffs,
context_transfers, metadata}`, plus `orchestration_v2_turn_item_positions`.
  `ProjectionMaintenance.ts` verifies projection sequence/schema against the event log.
- **Durable effect outbox:** `orchestration_v2_effect_outbox` (+ `_next`), claimed by
  `EffectWorker.ts`; effect kinds `provider-turn.start|interrupt|steer|restart`,
  `provider-runtime.continue`, `provider-session.detach`, `runtime-request.respond`,
  `provider-thread.rollback`, `checkpoint.capture`, `terminal.cleanup`, `attachment.cleanup`,
  `thread-title.generate`. (The README still lists this as a "tracked follow-up"; it is implemented.)
- **Other V2 tables:** `scheduled_tasks`, `orchestration_v2_thread_launch_workflows`,
  `orchestration_v2_legacy_imports`.
- **V1 import** (`orchestration-v2/legacy/LegacyV1ThreadImporter.ts`): shell events first
  (ids, title, provider/model, modes, branch, worktree, timestamps, archive/delete, settlement,
  snooze, pin, linked PR), full transcript lazily on read/continue from
  `projection_threads`/`projection_thread_messages` (user and assistant rows only). Not imported:
  provider sessions, runs, checkpoints/diffs, activities/tool calls, approvals, proposed plans.
  Imported threads have `historyOrigin:"v1_import"`. V1 command/event unions are deleted.
- **Migration numbering:** upstream's `effect_sql_migrations` ledger runs 1–56 at this snapshot.
  Migration **55 `OrchestrationV2`** bundles the whole V2 schema (`Migrations/055_OrchestrationV2.ts`
  composed from `Migrations/OrchestrationV2/*.ts`); 56 is `RemoveRedundantProjectionIndexes`.
  `reconcileV2PreviewMigration.ts` rewrites ledger rows of V2 preview databases (which recorded
  `OrchestrationV2` at 53 or 54) to 55/56. `runMigrations` logs every recorded id whose name differs
  from the manifest, including rows "unknown to this build".
- **Fork-ledger implications stated by upstream** (`docs/internals/legacy-orchestration-migration.md`,
  "Divergent migration ids"): the migrator compares ids only; "there is no safe id range for a fork
  inside this ledger … fork schema changes belong in a separate migration table or outside the
  migrator entirely." A fork keeping a _separate_ ledger table is the arrangement upstream endorses.
  Note the preview reconciler only inspects `effect_sql_migrations` rows ≥ 53 named
  `OrchestrationV2`.
- **Wire protocol gate:** `ORCHESTRATION_PROTOCOL_VERSION = 2`
  (`packages/contracts/src/environment.ts:13`); `/ws` rejects a missing/mismatched
  `orchestrationProtocol` with HTTP 426 (`orchestration_protocol_incompatible`).

---

## L. Provider registry

- A driver (`apps/server/src/provider/ProviderDriver.ts`) produces a `ProviderInstance` record whose
  fields include `snapshot`, `textGeneration`, `auth?`, and a required
  **`orchestrationAdapter: ProviderAdapterV2Shape`**. Built-in drivers
  (`provider/builtInDrivers.ts` `BUILT_IN_DRIVERS`): Codex, Claude, Cursor, Grok, OpenCode,
  Antigravity, Pi, ACP Registry (Codex also has a managed variant, `CodexManagedProvider.ts`;
  OpenCode selects an OpenCode or OpenCode 2 runtime adapter).
- `ProviderAdapterRegistryV2.layerFromProviderInstanceRegistry`
  (`orchestration-v2/ProviderAdapterRegistry.ts`) is a dynamic facade over
  `ProviderInstanceRegistry`: `get(instanceId)` returns the instance's `orchestrationAdapter`
  (wrapped to block session opens during credential changes), `list()` returns instance ids,
  `getMetadata` returns driver, continuation key, enabled, capabilities. Settings hot-reloads are
  visible without a second registry.
- Adapter contract (`orchestration-v2/ProviderAdapter.ts:~580`): `getCapabilities`,
  `planSelectionTransition`, `openSession` → session runtime with `ensureThread`, `resumeThread`,
  `injectHistory?`, `startTurn`, `compactThread?`, `steerTurn`, `interruptTurn`, `unloadThread?`,
  `respondToRuntimeRequest`, `readThreadSnapshot`, `uploadFeedback?`, `rollbackThread`,
  `forkThread`, `events` stream, `hasPendingBackgroundWork?`, `getModelContextWindow?`.
  `orchestration-v2/builtInProviderAdapterDrivers.ts` lists the V2 adapter drivers (Codex, Claude,
  Cursor, OpenCode, Grok, Pi, ACP Registry; Antigravity builds its adapter directly in its driver).
- `OrchestrationV2ProviderCapabilities.runtimePolicy.enforcement: "native" | "client-boundary"`
  records whether runtime modes are enforced by the provider or only where T3 mediates (Pi is
  `client-boundary`).
- **Pi in the registry:** `provider/Drivers/PiDriver.ts` builds `PiAdapterV2Driver.create(...)` as
  its `orchestrationAdapter`, so Pi instances appear in `ProviderAdapterRegistryV2.list()` and can
  run delegated tasks. `PiAdapterV2` drives `pi --mode rpc` (`Adapters/PiRpc.ts`) and declares
  active steering, native fork, structured questions, and best-effort subagent observation; MCP
  reaches Pi only through the injected extension (§B). Details are covered by the sibling Pi thread.

---

## M. Intent vs code divergences (consolidated)

| #   | Docs say                                                                                                                                                 | Code does                                                                                                                                                                                                            |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `orchestrator-mcp-server.md`: "eleven orchestration tools" (and lists twelve).                                                                           | `OrchestratorToolkit` has 15 (adds four scheduled-task tools); `t3_thread_launch` lives in `ProjectToolkit`; `ThreadToolkit` adds 17 more agent-facing thread/queue/request/fork tools. 72 tools on `/mcp` in total. |
| 2   | Credentials "expire after a maximum lifetime, expire when idle".                                                                                         | One 24 h liveness window refreshed by MCP traffic and every provider turn; no absolute maximum found.                                                                                                                |
| 3   | Pi: "The first turn of a session also receives the shared T3 orchestration instructions."                                                                | Appended to Pi's system prompt on every `before_agent_start`.                                                                                                                                                        |
| 4   | README: durable effect outbox is a "tracked follow-up", not a prerequisite.                                                                              | Implemented (`EffectOutbox.ts`, `EffectWorker.ts`, `orchestration_v2_effect_outbox`).                                                                                                                                |
| 5   | Core graph doc enumerations.                                                                                                                             | Code adds run status `preparing`, transfer resolution `fork_delta_context`, handoff strategy `fork_delta_summary`, request capability `message`, node status `idle`.                                                 |
| 6   | Feature lifecycles: merge-back triggered by "next source-thread message with merge-back intent".                                                         | Explicit `thread.merge_back` command, a **Merge** button, and `t3_thread_merge_back`.                                                                                                                                |
| 7   | Docs: child receives "an optional role instruction".                                                                                                     | A one-sentence prefix from a fixed six-value enum.                                                                                                                                                                   |
| 8   | Docs: `interrupt.node`, `rollback.node`, `fork.fromNode`, fork from a provider thread.                                                                   | Commands are `run.interrupt`, `checkpoint.rollback{scopeId, checkpointId}`, `thread.fork` with `latest_stable                                                                                                        | run | checkpoint`. Paginated Codex revert is not implemented (doc says so). |
| 9   | `docs/internals/context-handoffs.md` describes 240-char compact summaries; `docs/user/portable-handoffs.md` describes budgeted intact-message selection. | Both: `summaryText` is compacted, `history` is a budgeted intact selection delivered natively (Codex) or inline.                                                                                                     |

---

## Design centre of gravity

V2 is a **provider-fidelity rewrite of a single conversation's execution model**. Its README says it
is "designed around the real provider behavior observed in the Codex app-server probes": idle
status can precede `turn/completed`, interrupts complete as requests before the terminal event,
approvals are provider-initiated requests scoped to thread/turn/item, child `turn/completed` events
arrive before the parent's. The answer is an app-owned identity layer (app ids primary, provider ids
as refs), a run/attempt/execution-node graph where only the root node completes a user-visible
turn, explicit capability flags so weaker providers degrade by policy, and explicit `ContextTransfer`
/ `ContextHandoff` artefacts so forks, provider switches, merge-back and subagents share one
lineage-plus-source-point primitive. Everything is event-sourced with command receipts, a durable
outbox, deterministic ids and restart reconciliation. The multi-agent features (`delegate_task`,
thread management, PR watches, scheduled tasks, settle/wake, the Working section) are built _on_ this
substrate as "an agent can open, message, wait on and be woken by other threads", not as a workflow
engine.

Invariants a fork layering a richer workflow (goals, gates, dependency graphs) on top would run into:

- **Delegation is turn-scoped and agent-initiated.** `delegated_task.request` requires a blocking
  parent run and, through MCP, one owned by the calling session (`parent_not_active`). There is no
  path to create a child "between turns" or from a control plane without a live parent turn, and no
  held/staged child.
- **A task is one run.** The published result is the first child run's terminal output; later
  runs never reopen it, and review rounds are specified as fresh `delegate_task` calls with no
  persistent reviewer session. Verdicts, rounds and gates have no representation.
- **Results are pulled, not pushed.** The parent's wake is a generic pointer to `task_status`, steered
  into an active turn or queued, never interrupting. Delivery has its own durable state machine
  (`pending → claimed → acknowledged|delivered|disposed`, per-parent-run cohorts) that reading the
  result mutates.
- **The graph is a tree of single-parent lineage edges** (`fork | subagent`) plus context transfers.
  There are no dependency edges, no ordering between siblings, no cascade cancellation of app-owned
  children, and no per-child worktree; children share the parent's checkout.
- **One closed, typed command/event union.** All commands and domain events are members of
  `OrchestrationV2Command` / `OrchestrationV2DomainEvent` in `packages/contracts`, processed by one
  decider under a per-thread serial lock (parent lock taken before child lock; the keyed executor is
  neither re-entrant nor deadlock-aware). New durable workflow state either extends those unions or
  lives beside them.
- **Policy ceilings and scope.** Children and sends may only narrow runtime/interaction modes; thread
  management is project-scoped; provider choice is capability- and registry-driven.
- **Separate database and ledger rules.** V2 runs on a one-time copy (`statev2.sqlite`) with its own
  schema in migration 55, and upstream explicitly directs fork schema to a separate migration table.
