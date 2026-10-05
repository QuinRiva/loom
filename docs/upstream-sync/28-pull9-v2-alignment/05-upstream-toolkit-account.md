# Pull 9 — upstream's agent-facing orchestration toolkit, tool by tool

**Scope.** What upstream T3 Code's MCP orchestration toolkit is, what model of multi-agent work it
expresses, and exactly what each tool does — read from the code. This is the factual base for a
later judgement about whether any upstream tool earns a place beside Loom's workstream and goal
tools. It makes **no coexistence judgement**. It goes deeper than §B/§C/§F of
`01-upstream-v2-inventory.md` (the sibling inventory) and says so wherever it corrects it.

**Snapshot.** `upstream/main` at `7812230572` (5 Oct 2026). That is 8 commits past the inventory's
snapshot `a1d9d72aef`, and one of them matters here: `06e627448b` "T3 MCP tools take explicit
thread and project targets" (#15219, 411 lines changed in `OrchestratorMcpService.ts` alone). It
replaced project-scoped thread access with environment-wide access, added an (as yet unissued)
"client caller" kind for agents T3 did not launch, and added two failure codes. Where the
inventory describes the pre-#15219 behaviour, this document flags it as **changed since the
inventory**, not as an inventory error.

**Conventions.** Every reference is `file:line` inside `upstream/main` (read with
`git show upstream/main:<path>`). Short names:

| Short name                               | Path                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `OrchestratorMcpService.ts`              | `apps/server/src/mcp/OrchestratorMcpService.ts` (2 120 lines)         |
| `threadAccess.ts`                        | `apps/server/src/mcp/threadAccess.ts`                                 |
| `McpInvocationContext.ts`                | `apps/server/src/mcp/McpInvocationContext.ts`                         |
| `McpSessionRegistry.ts`                  | `apps/server/src/mcp/McpSessionRegistry.ts`                           |
| `McpHttpServer.ts`                       | `apps/server/src/mcp/McpHttpServer.ts`                                |
| `ThreadMetadataMcpService.ts`            | `apps/server/src/mcp/ThreadMetadataMcpService.ts`                     |
| `WorktreeMcpService.ts`                  | `apps/server/src/mcp/WorktreeMcpService.ts`                           |
| `orchestrator/tools.ts`                  | `apps/server/src/mcp/toolkits/orchestrator/tools.ts`                  |
| `thread/tools.ts`, `…/handlers.ts`       | `apps/server/src/mcp/toolkits/thread/{tools,handlers}.ts`             |
| `project/tools.ts`, `…/handlers.ts`      | `apps/server/src/mcp/toolkits/project/{tools,handlers}.ts`            |
| `pullRequests/tools.ts`, `…/handlers.ts` | `apps/server/src/mcp/toolkits/pullRequests/{tools,handlers}.ts`       |
| `worktree/tools.ts`, `…/handlers.ts`     | `apps/server/src/mcp/toolkits/worktree/{tools,handlers}.ts`           |
| `ThreadManagementService.ts`             | `apps/server/src/orchestration-v2/ThreadManagementService.ts`         |
| `Orchestrator.ts`                        | `apps/server/src/orchestration-v2/Orchestrator.ts` (10 281 lines)     |
| `SubagentProjection.ts`                  | `apps/server/src/orchestration-v2/SubagentProjection.ts`              |
| `ProviderContinuationService.ts`         | `apps/server/src/orchestration-v2/ProviderContinuationService.ts`     |
| `ScheduledTaskService.ts`                | `apps/server/src/scheduledTasks/ScheduledTaskService.ts`              |
| `piT3McpExtensionSource.ts`              | `apps/server/src/orchestration-v2/Adapters/piT3McpExtensionSource.ts` |
| `orchestratorMcp.ts`                     | `packages/contracts/src/orchestratorMcp.ts`                           |
| MCP design doc                           | `docs/orchestration-v2/orchestrator-mcp-server.md`                    |

---

## 1. The model, in plain language

### 1.1 The shape of the thing

Upstream gives every agent it launches a bearer token for one HTTP MCP server (`/mcp`, server key
`t3-code`) and, through it, 72 tools in ten toolkits. Five toolkits are about orchestration:
`OrchestratorToolkit` (15 tools), `ThreadToolkit` (17), `t3_thread_launch` in `ProjectToolkit`,
`PullRequestsToolkit` (5) and `WorktreeToolkit` (3). The model they express is small and worth
stating up front, because nearly every tool follows from it:

> **An agent is a thread mid-turn. While its turn is live it may start other agents, talk to any
> thread, and change threads that run within its own permissions. Results come back as a pointer
> to read, not as pushed text. The app — not the agent — owns workspaces, queues, schedules and
> durable records.**

There are two very different things an agent can start, and upstream keeps them deliberately
apart in tool names, prompts and data:

- A **delegated task** (`delegate_task`): child work _owned by the calling thread_. It gets a
  `taskId`, a subagent card in the parent's timeline, a backing child thread with `subagent`
  lineage, a durable result, and an automatic wake when it finishes. It shares the parent's
  checkout.
- An **ordinary top-level thread** (`create_threads`, `t3_thread_launch`): a separate
  conversation with no lineage back to the caller. The caller can talk to it, wait for it or
  interrupt it with the `t3_thread_*` tools, but nothing reports back automatically. Only
  `t3_thread_launch` can give it its own worktree.

Everything else is plumbing around those two: reading and searching threads, messaging and
steering them, managing their queues, answering their questions, forking and merging context,
sidebar housekeeping, recurring schedules, PR watching, and moving the caller into a worktree.

### 1.2 Who is calling, and what that allows

Every tool call carries an `McpInvocationScope` resolved from the bearer token
(`McpInvocationContext.ts:43`). Since #15219 a scope has two possible callers:

- a **thread caller** — a provider session T3 launched for one thread (`thread: {threadId,
providerSessionId, providerInstanceId}`); this is the only kind the session registry issues
  today (`McpSessionRegistry.ts:124–166`, `resolve` returns only thread scopes at `:168`);
- a **client caller** — "an agent T3 Code did not launch, signed in through MCP OAuth", with a
  `runtimeModeCeiling` (`McpInvocationContext.ts:29–34`). The type and every branch for it exist
  across the toolkits, but nothing on `upstream/main` issues such a scope. It is scaffolding for a
  feature that has not landed.

A thread caller's credential always carries the capabilities `orchestration`, `worktree` and
`pull-requests`, plus `preview` when browser tools are allowed or whatever extra set the caller of
`issue` supplies (`McpSessionRegistry.ts:140–145`). Capabilities are checked **when a tool is
called, not when tools are listed**: none of upstream's tools carries the MCP library's
`EnabledWhen` visibility annotation, and the Pi bridge registers every tool `tools/list` returns
(`piT3McpExtensionSource.ts:189–203, 266–296`). A credential without `orchestration` therefore
still _sees_ all 72 tools and gets `capability_denied` from most of them.

A thread caller's **limits** are its own thread's runtime mode and interaction mode
(`OrchestratorMcpService.ts:862–882`, `threadAccess.ts:42–77`). Anything it starts or changes must
run within them: runtime modes order `approval-required < auto-accept-edits < auto < full-access`,
interaction modes order `plan < default`, and a child or target may be equal or narrower, never
broader (`OrchestratorMcpService.ts:436–481`).

Three access tiers decide what a caller may do:

1. **Read** — any live thread or project in the environment (`threadAccess.ts:164–192`,
   `OrchestratorMcpService.ts:909–920, 968–988`). No live-turn requirement. _Changed since the
   inventory:_ before #15219 reads were limited to the caller's project plus threads a user had
   attached as context.
2. **Write another thread** — the caller must be **mid-turn** (its thread has an active run owned
   by the credential's provider instance, and is not archived), and the target must run within the
   caller's modes (`OrchestratorMcpService.ts:930–966`, `threadAccess.ts:94–106, 194–201`). The
   failure is `parent_not_active`. Writes to the caller's _own_ thread skip the live-turn check in
   `OrchestratorMcpService` (`:935–943`) but not in `ThreadToolkit`, whose `readWritableThread`
   applies it to every target including self.
3. **Change the environment** (`t3_thread_launch`, project CRUD, `run_scheduled_task_now`,
   environment preferences) — additionally requires the caller itself to be `full-access` +
   `default` (`threadAccess.ts:119–136`, `project/handlers.ts:46–55`).

"Owned by this provider session" in upstream's prose is implemented as "owned by this provider
**instance**": every live-turn check compares `run.providerInstanceId` with
`scope.thread.providerInstanceId` (`OrchestratorMcpService.ts:954–966, 1508–1519`). It is
session-tight in practice only because opening a new provider session revokes the thread's earlier
credentials before issuing one (`McpSessionRegistry.ts:241–248`).

### 1.3 A delegated task, from `delegate_task` to result

**Who creates the child, and when.** Only the parent agent, from inside its own live turn. The MCP
handler finds the parent thread's newest active run (`preparing | starting | running | waiting`)
and refuses with `parent_not_active` unless that run exists, has a root node and belongs to the
calling provider instance (`OrchestratorMcpService.ts:1504–1519`). The decider repeats the check
under the parent's dispatch lock — the named parent run must still be blocking and the parent node
must belong to it (`Orchestrator.ts:6344–6366`). There is no other path to a delegated task: no
WebSocket command a client or control plane could send on the parent's behalf between turns, no
staged or held child.

**What the child receives.**

- _Prompt:_ only the task text. With `role` set to anything but `general`, the text is prefixed
  with one sentence, `Act as the <role> sub-agent for this task.` (`OrchestratorMcpService.ts:564`).
  No parent history, no summary: the `subagent_spawn` context transfer is written `consumed` with
  `resolution: null` (`Orchestrator.ts:6543–6580`). Like every T3-launched session with a
  credential, the child also gets the shared orchestration instructions and runtime info in its
  system prompt (inventory §G) — and its own credential, so it can delegate further.
- _Thread:_ a new app thread built by spreading the parent thread (`makeSubagentChildThread`), so
  it inherits project, branch and **worktree path** — the child works in the parent's checkout —
  with lineage `subagent` back to the parent and `forkedFrom: {type:"node"}` pointing at the
  parent's task node (`Orchestrator.ts:6398–6412`). There is no workspace parameter.
- _Model:_ the parent's instance and model unless `target` overrides them; a driver-only target
  prefers the parent's instance when it is that driver and healthy; an explicit instance is
  honoured exactly; a different instance without a model gets its first advertised model; options
  are validated against the model's descriptors (`OrchestratorMcpService.ts:998–1114`).
- _Modes:_ inherited, or narrowed by `runtimeMode` / `interactionMode`; broader is refused
  (`:1526–1530`).
- _Start:_ the child's first message is dispatched `start_immediately` in the same transaction
  that creates the thread, the parent's task node, the `app_owned` subagent row and the parent's
  subagent card (`Orchestrator.ts:6466–6532`).

**Idempotency.** Every id (command, child thread, task node, message, card) is derived from
`clientRequestId`, namespaced by the credential (`OrchestratorMcpService.ts:487–503, 1531–1536`;
`Orchestrator.ts:6380–6392`). A retry with the same `clientRequestId` from the same session returns
the same task; omitting it always creates new work.

**`wait` versus `async`.** `async` (the default) dispatches and returns the task's current state
at once. `wait` dispatches and then polls the task every 50 ms until it is terminal or `timeoutMs`
elapses (default 10 min, clamped to 1 ms–60 min) (`OrchestratorMcpService.ts:82–84, 1276–1283,
1577–1585`). The difference that matters is the **wake policy** written on the task:
`completionWake: "always"` for async, `"settled_only"` for wait (`:1554`). A wait-mode task
delivers its result through the blocking call; it only wakes the parent if the parent's turn has
already ended. If the wait times out, the handler upgrades the task to `always` (best effort) so a
later finish still wakes the parent mid-turn, and returns `waitTimedOut: true`
(`:1586–1626`, `Orchestrator.ts:6587–6680`). A timeout never cancels the child.

**When is the task "done", and which run is the result?** Upstream distinguishes the child
_thread's_ runs from the _task's_ result:

- The task's work state is computed from the child thread (`SubagentProjection.ts:210–255`):
  `working` while any non-monitor run on the child is not terminal; `waiting_for_children` when
  the child's runs are terminal but it still has live subagents of its own, pending/claimed
  completion deliveries, or provider background tasks; `result_available` otherwise.
- The candidate result run is the **most recently run terminal work run** on the child thread
  (`SubagentProjection.ts:243–245`) — not the first run as such.
- The result is **published once**: when the child first reaches `result_available` (and no
  restart continuation is pending), `finalizeAppOwnedSubagent` writes the terminal subagent row
  with `result` text, terminal node and card, a `subagent_result` context transfer, and (when both
  provider threads exist) a `manual_context` handoff carrying the text
  (`Orchestrator.ts:8872–9161`). If a `subagent_result` transfer already exists it returns without
  doing anything (`:8946–8954`). Nothing else writes `task.result`.
- Result text is the run's provider error if it failed, else its latest non-empty assistant
  message, else a stock sentence (`SubagentProjection.ts:158–208`).

So, stated precisely: _a delegated task's result is published exactly once, at the first moment
the child thread is quiescent, from whichever child run finished last at that moment; after that
it never changes._ In the common case that is the child's first run. It is a later run when the
child had to wait for its own subagents (their completion wakes the child, and the wake run's
output becomes the result), when a restart cut the first run and a continuation finished it, or
when someone queued another message on the child thread before it went quiet.

**After publication.** Later runs on the child thread — a `t3_thread_send` to `childThreadId`, a
PR watch, a schedule — do not reopen or rewrite the task. `task_status` keeps returning the
published `summary` and `resultContextTransferId`; later activity surfaces only through
`hasPendingChildRuns` and the `latestTerminal*` fields (`OrchestratorMcpService.ts:1121–1274`), and
`task_cancel` on a terminal task deliberately does not interrupt those later runs (`:1663–1672`).
The tool descriptions and shared instructions tell agents to start every further review round as a
**new** `delegate_task` with the full context, never as a send to `childThreadId`
(`orchestrator/tools.ts:61, 205`; `T3OrchestrationInstructions.ts`).

**How the result reaches the parent.** It is _pulled_, not pushed. After publication,
`planDelegatedCompletionDelivery` (`Orchestrator.ts:8666–8862`) decides whether to wake the parent:

- nothing, if delivery for this task was already acknowledged, delivered or disposed;
- disposed (no wake), if the parent run that spawned the task is gone, the parent thread is
  archived or deleted, or that run's completion cohort is no longer `open` — which is what
  interrupting the parent run does (`:8069–8079`);
- nothing yet, for a `settled_only` task while the spawning run is still live (`:8713–8726`) —
  the blocking `wait` call owns delivery;
- otherwise the task joins the spawning run's **completion cohort**: siblings that finish while a
  wake is still queued are folded into that same wake message rather than creating another.

The wake is an ordinary parent run started by a server-created message whose text is only a
pointer: "Delegated task `<id>` reached a terminal state. Use task_status with taskId `<id>` to read
the result." (`Orchestrator.ts:509–514`; dispatched as `queue_after_active` by
`ProviderContinuationService.ts:113–145`). If the parent is mid-turn on a provider that supports
active steering without interrupting tools (Pi does), and every task in the cohort is `always`, the
wake is **steered into the live turn**; otherwise it is queued behind it. A notification never
interrupts a turn (`Orchestrator.ts:4570–4605`).

**Acknowledgement.** Reading a terminal result acknowledges its delivery: `task_status`, the
`delegate_task` response itself, and a `t3_thread_read` of the child that includes the untruncated
result item (`OrchestratorMcpService.ts:1240–1273, 1936–1978`). `t3_thread_wait` does not. The
acknowledgement matters because it removes the task from any still-queued wake, and cancels that
wake run entirely if no other task is left in it (`Orchestrator.ts:1952–2011`). Reading the result
mid-turn therefore suppresses the redundant wake. When a wake run finishes, its tasks become
`delivered` (`Orchestrator.ts:9164–9260`).

**Cancellation.** `task_cancel` interrupts the child's newest active run and disposes the task's
automatic delivery; on a terminal task it only disposes delivery (`OrchestratorMcpService.ts:
1633–1713`). There is no cascade from parent to app-owned children (inventory §A).

### 1.4 What wakes a thread, and when

Every wake is an ordinary run on the woken thread, started by a message. The sources, in the order
an agent would meet them:

1. **A delegated task finishing** (§1.3) — steered or queued into the parent; never for a parent
   whose spawning run was interrupted.
2. **Any thread sending to it** with `t3_thread_send` — `auto` starts an idle thread outright.
   This is the only general "notify another thread" channel; a child can use it to reach its
   parent, but only if the parent's modes are no broader than the child's, which in practice means
   only when the child was not narrowed (§1.2).
3. **A pull-request watch** (`watch_pull_request`) — a sweep every minute; wakes on a failed or
   newly passing check, a foreign comment or review, or a conflict; never wakes a settled thread
   (`PullRequestWatchReactor.ts:67, 196–198, 275`).
4. **A bound scheduled task** firing (§1.8) — always `queue` mode.
5. **Provider background work** finishing, usage-limit recovery, restart continuation (inventory
   §C).
6. **The thread's own continuation prompt** after `t3_worktree_handoff` (§2.5).

A woken thread that was settled is un-settled by the dispatch itself (`Orchestrator.ts:4410–4456`).

### 1.5 `t3_thread_send` and the queue

`t3_thread_send` puts a user-role message (`createdBy:"agent"`, `creationSource:"mcp"`,
`senderThreadId` = caller) into any thread the caller may write to. Its four modes are resolved by
`ThreadManagementService.sendToThread` (`ThreadManagementService.ts:535–621`) against the target's
_steerable_ run — a `running` run whose active attempt has a `running` provider turn (`:374–387`):

| Mode      | Target has a steerable turn                        | Target is busy but not steerable (preparing, starting, `waiting`) | Target is idle        |
| --------- | -------------------------------------------------- | ----------------------------------------------------------------- | --------------------- |
| `auto`    | **steer** into it                                  | queued behind it                                                  | started               |
| `queue`   | queued behind it                                   | queued behind it                                                  | started               |
| `steer`   | steer into it                                      | `thread_not_sendable`                                             | `thread_not_sendable` |
| `restart` | interrupt the turn and restart it with the message | `thread_not_sendable`                                             | `thread_not_sendable` |

"Queued" happens in the decider: a `start_immediately` or `queue_after_active` message on a thread
with a blocking run becomes a `queued` run (`Orchestrator.ts:4690–4720`). "Steer" means the provider
receives the text inside the running turn if it supports active steering; on providers that do not
(Cursor, ACP) the steer is executed as interrupt-and-restart (`CommandPolicy.ts:249–262`). If the
turn completed between the check and the dispatch, the steer silently becomes a new turn
(`Orchestrator.ts:4497–4515`). The result's `delivery` says which happened. An archived target is
`thread_not_sendable`.

The **queue** is the list of a thread's `queued` runs, each holding the message that will start
it. `t3_queue_*` lets an agent list, read, edit, cancel, reorder, or promote one of those to a
steer into the active run (`thread/handlers.ts:225–277`). Queued runs start one at a time when the
thread's blocking run ends (`Orchestrator.ts:1210–1225`). Automatic wakes (delegated completions,
notifications) are queued runs too, hidden from the queue UI (`Orchestrator.ts:2490–2493`).

**Interrupt holds the queue.** `run.interrupt` — from `t3_thread_interrupt`, `task_cancel`, or the
user's stop button — marks every queued run on that thread `queueHeld`, and held runs do not start
until a `queue.resume` command (`Orchestrator.ts:8082–8095, 1220, 9586–9640`). No MCP tool issues
`queue.resume`; only the client does. An agent that interrupts another thread can therefore leave
that thread's queue frozen until a human resumes it.

### 1.6 Pending requests

A pending request is a provider's open question to the user, recorded as a `RuntimeRequest` of
kind `user_input` with `status: "pending"` and a `user_input_request` turn item carrying the
structured questions (header, question, options, multi-select, custom answer). An agent may list
and read them on any thread, and answer them on a thread it may write to, through the same
`runtime-request.respond` command the UI uses (`thread/handlers.ts:52–77, 197–224`). It may
**not** respond to approval requests (command, file read, file change, dynamic tool permission) —
the tools filter to `kind === "user_input"` and the descriptions say so (`thread/tools.ts:147–172`).

### 1.7 Fork, merge-back, settle and organise

**Fork** creates an idle thread that spreads the source thread — same project, branch and
worktree path, so it shares the checkout — with `fork` lineage, `forkedFrom: {type:"run"}`, and a
`pending` fork transfer (`ThreadForkService.ts:77–136`). No provider runtime is created; the first
message on the fork resolves the transfer natively or with a portable handoff (inventory §F). The
source run must be stable.

**Merge-back** is context, not code. It is allowed only from a fork to the thread it forked from,
from a provider-finished run (`completed` or `waiting`), and creates a `merge_back` transfer with
`basePoint` = the fork point, `status: "pending"`, superseding any earlier pending merge-back for
the pair (`Orchestrator.ts:3442–3583`). The next run on the target consumes it as a
`fork_delta_summary`. While a merge-back is pending, a message that would be _queued_ on the
target fails ("queued merge-back consumption is not implemented yet", `Orchestrator.ts:4703–4709`).

**Settle, snooze, pin, archive, mark unread** (`t3_thread_organize`) dispatch the same commands as
the sidebar. Settle is refused while the thread has active or blocked work (any preparing, queued,
starting, running or waiting run other than automatic wakes, or a blocking request); on success it
cancels queued automatic wakes and detaches the provider session (`Orchestrator.ts:2484–2560,
3205–3275`). An agent cannot settle itself mid-turn for that reason.

### 1.8 Scheduled tasks

A scheduled task is a persisted recurring prompt (`scheduled_tasks` table) with a schedule
(`interval{everyMs}` or `fixed_time{timeOfDay, weekdays?}`), a project, an optional **bound
thread**, a model selection and modes copied from the creator. A server worker registered as
`"scheduled-tasks"` runs due tasks one at a time (`ScheduledTaskService.ts:458–590, 701`):

- a **bound** task sends its prompt into the bound thread with `mode: "queue"` — it never
  interrupts or steers (`:538–553`);
- an **unbound** task launches a fresh top-level thread per run through the launch service, with
  the stored workspace strategy (`:516–537`). Over MCP that strategy is hard-coded to a new worktree
  from `main`, fetched from origin (`OrchestratorMcpService.ts:196–203`).

A missed fixed-time run (server off) is skipped and re-aimed, not fired late; a run cut by a
restart is recorded as failed (`ScheduledTaskService.ts:598–690`). Schedules run whether or not any
agent is live; that is their point.

### 1.9 Lifecycle assumptions, as checkable sentences

| #   | Assumption                                                                                                                                                                                                         | Decided by                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| L1  | A delegated task can only be created by an agent inside its own live turn; with no active run owned by the caller's provider instance the call fails `parent_not_active`.                                          | `OrchestratorMcpService.ts:1504–1519`; `Orchestrator.ts:6344–6366`            |
| L2  | A delegated child receives only the task text (plus a one-sentence role prefix); no parent history is transferred.                                                                                                 | `OrchestratorMcpService.ts:564`; `Orchestrator.ts:6543–6580`                  |
| L3  | A delegated child runs in its parent's checkout; there is no per-child workspace.                                                                                                                                  | `Orchestrator.ts:6398–6412` (`makeSubagentChildThread` spreads the parent)    |
| L4  | A delegated child's runtime and interaction modes are equal to or narrower than its parent's.                                                                                                                      | `OrchestratorMcpService.ts:453–481, 1526–1530`                                |
| L5  | A delegated task's result is published exactly once, when the child thread first becomes quiescent, from the child run that finished last at that moment; it is never rewritten.                                   | `SubagentProjection.ts:243–254`; `Orchestrator.ts:8946–8954`                  |
| L6  | A later message to the same child thread (any mode) does not update the parent's task, reopen it, or produce another parent wake; it shows only in `hasPendingChildRuns` / `latestTerminal*`.                      | `Orchestrator.ts:8946–8954`; `OrchestratorMcpService.ts:1121–1274`            |
| L7  | A message queued on the child _before_ publication does change the published result, because the task waits for it and publishes the later run.                                                                    | `SubagentProjection.ts:229–254`                                               |
| L8  | The parent learns of completion through a generic pointer message; the result text is never pushed into the parent's prompt.                                                                                       | `Orchestrator.ts:509–514`; `ProviderContinuationService.ts:113–145`           |
| L9  | An async completion is steered into the parent's live turn when the provider supports active steering, otherwise queued; it never interrupts a turn.                                                               | `Orchestrator.ts:4570–4605`                                                   |
| L10 | A wait-mode task wakes the parent only if the parent's spawning run has ended; a timed-out wait upgrades it so it wakes regardless.                                                                                | `Orchestrator.ts:8713–8726`; `OrchestratorMcpService.ts:1586–1626`            |
| L11 | Interrupting the parent's spawning run means none of its delegated tasks will ever wake it; results stay readable through `task_status`.                                                                           | `Orchestrator.ts:8069–8079, 8696–8711`                                        |
| L12 | Reading a terminal result (`task_status`, `delegate_task`'s own response, or a full `t3_thread_read` of the child) acknowledges it and removes or cancels the queued wake; `t3_thread_wait` does not.              | `OrchestratorMcpService.ts:1240–1273, 1936–1978`; `Orchestrator.ts:1952–2011` |
| L13 | Sibling completions that land while a wake is still queued share that one wake message.                                                                                                                            | `Orchestrator.ts:8730–8770`                                                   |
| L14 | Any write to another thread requires the caller to be mid-turn (`parent_not_active` otherwise) and the target to run within the caller's modes.                                                                    | `OrchestratorMcpService.ts:930–966`; `threadAccess.ts:94–106, 194–201`        |
| L15 | Any thread in the environment can be read, regardless of project or of whether the caller is mid-turn.                                                                                                             | `threadAccess.ts:164–192`; `OrchestratorMcpService.ts:909–920, 968–988`       |
| L16 | `t3_thread_send` in `auto` steers a steerable turn, queues behind a non-steerable one, and starts an idle thread; `steer`/`restart` fail without a steerable turn.                                                 | `ThreadManagementService.ts:374–387, 535–621`                                 |
| L17 | Interrupting a thread holds its queued runs until `queue.resume`, which no agent tool can issue.                                                                                                                   | `Orchestrator.ts:8082–8095, 1220, 9586`                                       |
| L18 | A bound scheduled task never interrupts or steers its thread; it queues.                                                                                                                                           | `ScheduledTaskService.ts:538–553`                                             |
| L19 | `create_threads` and `t3_thread_launch` threads have no lineage to the caller and never report back automatically.                                                                                                 | `OrchestratorMcpService.ts:1715–1859`; `project/handlers.ts:42–144`           |
| L20 | Tools are listed to every credential; capabilities are enforced only at call time.                                                                                                                                 | `McpHttpServer.ts:718–729`; `piT3McpExtensionSource.ts:189–203, 266–296`      |
| L21 | `clientRequestId` makes a retry return the same work only within the same credential; tools without it (all of `ThreadToolkit`, `t3_thread_launch`, PR tools, worktree handoff) create new commands on every call. | `OrchestratorMcpService.ts:487–503`; `threadAccess.ts:203–206`                |

### 1.10 The two load-bearing claims in the strategy plan

The plan (`plans/upstream-pull9-strategy/plan.mdx`, "Loom children are not V2 delegated tasks")
rests its decision to keep Loom's children off `delegate_task` on two invariants.

**Claim 1 — "`delegated_task.request` requires a blocking parent run owned by the calling
session".** **Confirmed.** Two gates decide it. The MCP gate refuses unless the newest active run
of the calling thread has a root node and `providerInstanceId === scope.thread.providerInstanceId`
(`OrchestratorMcpService.ts:1504–1519`, `parent_not_active`). The decider gate refuses unless the
named parent run is still `preparing | starting | running | waiting` and the named parent node
belongs to it (`Orchestrator.ts:6344–6366`, `isBlockingRun` at `:460–467`). Two refinements: the
ownership check is by provider _instance_, not session (session-tight only through credential
revocation, §1.2); and `waiting` counts as active, so a parent parked on a user request or in
post-terminal drain can still delegate. Nothing else creates `app_owned` subagent rows.

**Claim 2 — "publishes the first child run's output as the stable result, and never reopens".**
**Half confirmed, half corrected.** _Never reopens_ is exact: publication is guarded by the
existence of the `subagent_result` transfer (`Orchestrator.ts:8946–8954`), only
`finalizeAppOwnedSubagent` writes `task.result`, and later child runs reach the parent only as
`latestTerminal*` read-outs. _First child run_ is not what the code says: the published result is
from the **latest terminal work run at the moment the child first becomes quiescent**
(`SubagentProjection.ts:243–254`). That is the first run whenever nothing else happened on the
child before it finished — the common case — but a child waiting on its own subagents, a
restart-continued child, or a child that received a queued message before finishing publishes a
later run. The design doc says this correctly ("Successful results use the latest assistant
content from the final work turn"); the inventory's §C sentence "the first (original) child run's
terminal output" and the plan's paraphrase are the imprecise ones. The plan's conclusion is
unaffected: a task still has exactly one result per task and no re-engagement.

**A third, unasked correction that is load-bearing for the same plan.** The plan's Area B says that
issuing Loom credentials without `orchestration` means the `OrchestratorToolkit` and `ThreadToolkit`
"are not listed to the agent at all". They would be listed. Capability checks are call-time only
(L20), so the agent would see `delegate_task` and the other 31 tools and get `capability_denied`
if it called them. Hiding them needs a filter somewhere — in the Pi bridge's registration loop, or a
server-side listing filter; the MCP library's `EnabledWhen` annotation only sees the client's
protocol profile, not the bearer credential. Withholding `orchestration` also disables more than
those two toolkits: `t3_thread_launch` and project CRUD (`project/handlers.ts:31–40`), the
environment and attachment tools (including `t3_thread_send_attachments`), `t3_thread_update`
(`ThreadMetadataMcpService.ts:143`) and `t3_worktree_list` (which reads through
`threadAccess.readThread`, `worktree/handlers.ts:13–36`). It leaves the five PR tools
(`pull-requests`) and `t3_worktree_handoff` / `t3_worktree_status` (`worktree`) working.

---

## 2. Per-tool entries

Each entry: purpose; what an agent reaches for it for; inputs that matter; what comes back;
preconditions; failures; code; and where the design doc differs. Unless stated, every
`OrchestratorToolkit` tool first requires the `orchestration` capability (`capability_denied`) and
loads the calling thread (`orchestration_error` if that fails). "Mid-turn" means the live-turn
check of §1.2 (`parent_not_active`). "Within modes" means the target's modes are no broader than
the caller's (`runtime_mode_escalation_denied` / `interaction_mode_escalation_denied`).

### 2.1 `OrchestratorToolkit` (15)

#### `orchestrator_capabilities`

- **Purpose.** Tell the agent which providers and models it can start children on, and with what
  inherited settings.
- **Reach for it** before choosing a `target` for `delegate_task`, `create_threads` or
  `t3_thread_configure`.
- **Inputs.** None.
- **Returns.** `parentThreadId`, inherited instance and model, the caller's runtime/interaction
  limits, every registered provider instance with models (and option descriptors),
  `canRunChildTask`, `canRunCrossProviderChildTask` (always equal to `canRunChildTask`), and
  model-visible `constraints[]`; static `features` flags (`maxBatchThreads: 20`).
- **Preconditions.** Capability only; works for any caller, mid-turn or not. The
  orchestration-capable set is exactly the adapter registry's `list()`, the same lookup dispatch
  uses.
- **Failures.** `capability_denied`, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:46`; `OrchestratorMcpService.ts:1459–1502`, constraints
  `:218–239`, capable set `:991–996`.
- **Docs differ.** The design doc lists feature flags "for polling, cancellation, and batch thread
  creation"; code also reports `threadManagement`, `incrementalThreadRead`, `scheduledTasks`.

#### `delegate_task`

- **Purpose.** Start one child agent owned by this thread and get a durable result back.
- **Reach for it** for parallel or cross-model sub-work whose answer the parent needs — research,
  implementation, a review round.
- **Inputs.** `task` (the whole prompt); `target {providerInstanceId?, driverKind?, model?,
options?}`; `title`; `role` (`implementation | research | review | design | test | general`,
  prompt prefix only); `mode` (`async` default, `wait`); `timeoutMs` (wait only, default 10 min,
  max 60 min); `runtimeMode` / `interactionMode` (`inherit` or narrower); `clientRequestId`.
- **Returns.** `DelegateTaskResult`: `taskId` (keep it), `childThreadId` (backing storage),
  `childRunId` (the original run), `status`, `workState`, `summary` (the result once published),
  `resultContextTransferId`, `hasPendingChildRuns`, `latestTerminal{RunId, Status, Summary,
ResultContextTransferId}`, provider/model, `waitTimedOut`.
- **Preconditions.** Thread caller (`thread_credential_required`); mid-turn, checked against the
  newest active run (§1.10); target resolvable and healthy; modes narrower or equal. Idempotent
  per `clientRequestId` within the credential. A terminal result in the response acknowledges
  delivery.
- **Failures.** `thread_credential_required`, `capability_denied`, `parent_not_active`,
  `provider_unavailable`, `model_unavailable`, `invalid_request` (driver/instance mismatch, bad
  options), `runtime_mode_escalation_denied`, `interaction_mode_escalation_denied`,
  `orchestration_error` (dispatch, or no task row produced), plus `thread_not_found` /
  `run_not_found` from the follow-up read.
- **Code.** `orchestrator/tools.ts:59–70`; `OrchestratorMcpService.ts:1504–1627`, target
  `:998–1114`, read `:1121–1274`, wait `:1276–1283`; decider `Orchestrator.ts:6319–6582`,
  wake-policy `:6587–6680`, finalise `:8872–9161`.
- **Docs differ.** Doc's input type omits `target.options` and the `auto` runtime mode. Doc says
  ownership is by provider _session_; code checks the provider _instance_.

#### `task_status`

- **Purpose.** Read a delegated task's state and result.
- **Reach for it** when woken by a completion pointer, or mid-turn when the result is needed now.
- **Inputs.** `taskId`.
- **Returns.** `DelegateTaskResult` (as above), `waitTimedOut: false`. Before publication,
  `status`/`summary` are derived live from the child; after publication they are frozen.
- **Preconditions.** Thread caller; the task must be an `app_owned` task of _this_ thread
  (another parent's task id is `task_not_found`). No mid-turn requirement. Reading a terminal
  task acknowledges delivery (and so removes or cancels the queued wake). A child cut by a restart
  whose continuation has not settled reads as `working` (`heldForRestart`, `:1173–1180`).
- **Failures.** `thread_credential_required`, `capability_denied`, `task_not_found`,
  `thread_not_found`, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:72–84` (annotated _not_ read-only because of the
  acknowledgement); `OrchestratorMcpService.ts:1628–1632, 1121–1274`.

#### `task_cancel`

- **Purpose.** Stop a delegated task that is still working, and stop its automatic wake.
- **Reach for it** when a child is no longer wanted.
- **Inputs.** `taskId`, `reason?`, `clientRequestId?`.
- **Returns.** `{taskId, status}` — `cancel_requested`, or the existing terminal status.
- **Preconditions.** Thread caller; own task. No mid-turn requirement. On a working task:
  interrupts the child's newest active run (which also holds the child's queue, §1.5) and disposes
  delivery. On a terminal task: disposes delivery only, never touching later child runs.
- **Failures.** `thread_credential_required`, `capability_denied`, `task_not_found`,
  `task_not_cancellable` (no interruptible child run, or the interrupt was rejected),
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:86–96`; `OrchestratorMcpService.ts:1633–1713`.

#### `schedule_task`

- **Purpose.** Create recurring work the app runs on a timer, with or without a live agent.
- **Reach for it** for "check this every hour", a weekday-morning digest, or a recurring wake-up
  in this thread.
- **Inputs.** `prompt`; `schedule` (`{type:"interval", everyMs}` or `{type:"fixed_time",
timeOfDay, weekdays?}`); `projectId?`; `title?`; `enabled?` (default true);
  `bindToCurrentThread?` (default true when the target project is the caller's); `clientRequestId`.
- **Returns.** Scheduled-task summary: id, title, prompt, enabled, project, `boundThreadId`,
  schedule, `nextRunAt`, `lastRunStatus`.
- **Preconditions.** Capability. Scheduling into **another** project requires mid-turn. Binding
  requires a thread caller in that project. The task copies the caller's model selection and
  modes; unbound tasks get the hard-coded workspace strategy "new worktree from `main`, from
  origin". Idempotent per `clientRequestId`.
- **Failures.** `capability_denied`, `target_required`, `parent_not_active`, `invalid_request`
  (unknown project, bad binding, project without a default model for a client caller),
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:98–109`; `OrchestratorMcpService.ts:1315–1374`, strategy
  `:196–203`; runner `ScheduledTaskService.ts:458–590`.
- **Docs differ.** Absent from the design doc's tool list and from `feature-lifecycles.md`.

#### `list_scheduled_tasks`

- **Purpose.** See the recurring tasks in a project.
- **Reach for it** before updating, pausing or deleting one.
- **Inputs.** `projectId?` (omitted = caller's project).
- **Returns.** `{tasks[]}` of summaries.
- **Preconditions.** Capability only. Read across any project.
- **Failures.** `capability_denied`, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:111–123`; `OrchestratorMcpService.ts:1375–1391`.

#### `update_scheduled_task`

- **Purpose.** Change, pause, or rebind a scheduled task.
- **Inputs.** `scheduledTaskId`; any of `prompt`, `title`, `schedule`, `enabled`,
  `bindToCurrentThread`.
- **Returns.** Updated summary.
- **Preconditions.** The task's stored modes must be within the caller's (so editing its prompt
  cannot run work above the caller); a task in another project needs mid-turn. Rebinding also
  rewrites the workspace strategy. Model and modes are never changed. No idempotency key.
- **Failures.** `capability_denied`, `task_not_found`, both escalation codes, `parent_not_active`,
  `invalid_request`, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:125–135`; `OrchestratorMcpService.ts:1392–1444, 1290–1313`.

#### `delete_scheduled_task`

- **Purpose.** Remove a scheduled task permanently.
- **Inputs.** `scheduledTaskId`.
- **Returns.** `{scheduledTaskId, deleted: true}`.
- **Preconditions.** As for update.
- **Failures.** `capability_denied`, `task_not_found`, both escalation codes, `parent_not_active`,
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:137–147`; `OrchestratorMcpService.ts:1445–1458`.

#### `create_threads`

- **Purpose.** Open 1–20 ordinary top-level conversations that share the caller's checkout.
- **Reach for it** only when the user asks for separate threads and a shared checkout is fine.
- **Inputs.** `threads[1..20] {prompt?, title?, target?, runtimeMode?, interactionMode?}`,
  `clientRequestId?`.
- **Returns.** `threads[] {threadId, runId, status, title, createdBy, creationSource,
providerInstanceId, model}`.
- **Preconditions.** Thread caller; mid-turn (same check as `delegate_task`). Project, branch and
  worktree path are always the caller's. Entries without a prompt are created idle. No lineage;
  the parent records a `thread_created` card. Created sequentially; a failure part-way leaves the
  earlier threads. Idempotent per `clientRequestId`.
- **Failures.** `thread_credential_required`, `capability_denied`, `parent_not_active`,
  `provider_unavailable`, `model_unavailable`, `invalid_request`, both escalation codes,
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:149–160`; `OrchestratorMcpService.ts:1715–1859`.

#### `t3_thread_list`

- **Purpose.** List threads in a project, newest first.
- **Reach for it** to find a thread to read, message or wait on, or to check whether a lost launch
  happened.
- **Inputs.** `projectId?`, `statuses?`, `titleContains?`, `settled?`, `includeSubagents?`
  (default true), `cursor?`, `limit?` (≤ 100, default 50).
- **Returns.** `{projectId, currentThreadId, threads[], nextCursor, total}`; each shell carries
  status, provider/model, modes, linked PR, settled state, `parentThreadId`,
  `relationshipToParent`, item count, timestamps.
- **Preconditions.** Capability only; any project.
- **Failures.** `capability_denied`, `target_required` (client caller without `projectId`),
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:162–174`; `OrchestratorMcpService.ts:1861–1902`;
  `ThreadManagementService.ts:511–533`.
- **Docs differ.** Doc: "in the calling thread's project … threads from other projects are never
  exposed." Code: `projectId` targets any project (changed by #15219).

#### `t3_thread_read`

- **Purpose.** Read a thread's state, recent runs and a paginated timeline.
- **Reach for it** to see what another agent or the user said or did, or to fetch a long item in
  pieces.
- **Inputs.** `threadId`; `view` (`messages` default: user/assistant messages and plans;
  `activity`: every summarised item); `afterPosition`, `limit`; `runLimit`; `maxCharsPerItem`
  (default 20 000); `itemId` + `textOffset` to page one long item.
- **Returns.** Thread detail (status, active/latest run, provider/model, modes, branch, worktree,
  lineage, pending-request count, archived, settled), recent runs, timeline items with
  `visibility local | inherited | synthetic` and provenance, `nextPosition`, `hasMore`.
- **Preconditions.** Capability; any live thread in the environment; no mid-turn requirement.
  Reading an untruncated terminal result of this thread's direct app-owned child acknowledges that
  task's delivery (so it is annotated not read-only).
- **Failures.** `capability_denied`, `thread_not_found`, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:176–188`; `OrchestratorMcpService.ts:1903–1993`, acknowledgement
  `:1936–1978, 367–405`.
- **Docs differ.** Doc: "a project-scoped thread". Code: any thread in the environment (#15219).

#### `t3_thread_update`

- **Purpose.** Rename a thread, regenerate its title, or link/unlink a PR in its metadata.
- **Inputs.** `threadId?` (omitted = self); `action` (`rename` + `title`, `regenerate_title`,
  `link_pull_request` + `pullRequest`, `unlink_pull_request`); `clientRequestId?`.
- **Returns.** Command id, event sequence, resultant title, title-regeneration marker, linked PR.
- **Preconditions.** Capability. Another thread: mid-turn and within modes. Self: neither check.
  Idempotent per `clientRequestId` + thread + action. Served by `ThreadMetadataMcpService`.
- **Failures.** `capability_denied`, `target_required`, `thread_not_found`, `parent_not_active`,
  both escalation codes, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:190–201`; `ThreadMetadataMcpService.ts:139–249`.
- **Docs differ.** Doc: "another thread in the same project". Code: any thread in the environment.
  Its PR actions overlap `link_pull_request` / `unlink_pull_request` (§2.4), which record the link
  as agent-sourced and drive watching; the two paths coexist.

#### `t3_thread_send`

- **Purpose.** Put a message into another thread (or this one): start it, queue a follow-up,
  steer its turn, or restart its turn.
- **Reach for it** to direct a thread the agent did not delegate, answer a top-level thread, or
  nudge a busy one.
- **Inputs.** `threadId`, `message`, `mode` (`auto` default, `queue`, `steer`, `restart`),
  `clientRequestId?`.
- **Returns.** `{threadId, messageId, runId, status, delivery: started | queued | steered |
restarted}`.
- **Preconditions.** Capability. Another thread: mid-turn and within modes. Self: within modes
  only (always true), no mid-turn check — so an agent can queue a follow-up turn for itself.
  Archived target refused. Idempotent per `clientRequestId`. Does not create or reopen a delegated
  task (§1.3, L6).
- **Failures.** `capability_denied`, `thread_not_found`, `parent_not_active`, both escalation
  codes, `thread_not_sendable` (archived, or `steer`/`restart` without a steerable turn),
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:203–214`; `OrchestratorMcpService.ts:1995–2043`;
  `ThreadManagementService.ts:535–621`; decider `Orchestrator.ts:4310–4720`.
- **Docs differ.** Doc: "in the calling project". Code: any thread in the environment.

#### `t3_thread_wait`

- **Purpose.** Block until a thread's run reaches a terminal state, or a timeout.
- **Reach for it** after `t3_thread_send` or `t3_thread_launch` when the agent needs the outcome
  before continuing.
- **Inputs.** `threadId`, `runId?` (omitted = latest run at call time), `timeoutMs?` (default
  10 min, max 60 min).
- **Returns.** `{threadId, runId, status, timedOut}`. Status only — no content.
- **Preconditions.** Capability; any thread; no mid-turn requirement. Polls every 250 ms. An idle
  thread returns at once. A timeout does not interrupt. Does **not** acknowledge a delegated
  result.
- **Failures.** `capability_denied`, `thread_not_found`, `run_not_found`, `orchestration_error`.
- **Code.** `orchestrator/tools.ts:216–228`; `OrchestratorMcpService.ts:2044–2064`;
  `ThreadManagementService.ts:623–675`.

#### `t3_thread_interrupt`

- **Purpose.** Stop a thread's running turn.
- **Inputs.** `threadId`, `runId?` (omitted = newest active run), `reason?`, `clientRequestId?`.
- **Returns.** `{threadId, runId, status}` — `interrupt_requested`, `no_active_run`, or the run's
  existing terminal status.
- **Preconditions.** Capability. Another thread: mid-turn and within modes. Interrupting **holds
  the target's queue** until a human resumes it (§1.5, L17); interrupting a parent's spawning run
  stops its delegated tasks' wakes (L11). Idempotent per `clientRequestId`.
- **Failures.** `capability_denied`, `thread_not_found`, `run_not_found`, `parent_not_active`,
  both escalation codes, `thread_not_interruptible` (named run is not the active one),
  `orchestration_error`.
- **Code.** `orchestrator/tools.ts:230–240`; `OrchestratorMcpService.ts:2065–2117`;
  `ThreadManagementService.ts:677–728`; `Orchestrator.ts:8001–8095`.

### 2.2 `ThreadToolkit` (17)

Shared behaviour (`thread/handlers.ts`, `threadAccess.ts`). Every tool requires the
`orchestration` capability and a findable calling thread (`capability_denied`,
`thread_not_found`). Read tools (`readThread`) reach any thread; `threadId` omitted means the
caller. Write tools (`readWritableThread`) require mid-turn **for every target including self**,
and the target within modes. None takes `clientRequestId`; every call mints a fresh command id
(`threadAccess.ts:203–206`). Dispatch failures from the decider are flattened to
`orchestration_error` "The operation could not be completed." (`threadAccess.ts:18–22`), so an
agent does not see _why_ a settle or queue edit was refused.

#### `t3_thread_organize`

- **Purpose.** Sidebar housekeeping on a thread: pin, unpin, snooze, unsnooze, settle, unsettle,
  archive, unarchive, mark unread.
- **Reach for it** to settle a finished thread, snooze one until a time, archive clutter.
- **Inputs.** `threadId?`, `action`, `snoozedUntil` (required for snooze).
- **Returns.** `{sequence}`.
- **Preconditions.** Write tier. Settle is refused while the target has active or blocked work,
  so it cannot settle the calling thread mid-turn; archive and settle detach the target's provider
  session. "Does not schedule a future action."
- **Failures.** Shared codes; `invalid_request` (snooze without `snoozedUntil`);
  `orchestration_error` for decider refusals.
- **Code.** `thread/tools.ts:31–59`; `thread/handlers.ts:278–305`; settle guard
  `Orchestrator.ts:2484–2560`.

#### `t3_queue_list`

- **Purpose.** List a thread's queued messages in delivery order.
- **Inputs.** `threadId?`, `cursor?`, `limit?` (≤ 100, default 20).
- **Returns.** `items[] {queuedRunId, text (first 1 000 chars), truncated}`, `nextCursor`.
- **Preconditions.** Read tier.
- **Code.** `thread/tools.ts:77–92`; `thread/handlers.ts:225–238`.

#### `t3_queue_read`

- **Purpose.** Read one queued message (up to 16 000 chars).
- **Inputs.** `threadId?`, `queuedRunId`.
- **Returns.** `{queuedRunId, text, truncated}`.
- **Failures.** Shared; `invalid_request` if not found or no longer queued.
- **Code.** `thread/tools.ts:93–100`; `thread/handlers.ts:239–250`.

#### `t3_queue_edit`

- **Purpose.** Replace a queued message's text, keeping its attachments.
- **Inputs.** `threadId?`, `queuedRunId`, `text` (≤ 100 000).
- **Returns.** `{sequence}`.
- **Preconditions.** Write tier; the decider rejects a run that is no longer queued.
- **Code.** `thread/tools.ts:101–109`; `thread/handlers.ts:251–257` (`queued-run.edit`).

#### `t3_queue_cancel`

- **Purpose.** Drop a queued message before it runs.
- **Inputs.** `threadId?`, `queuedRunId`. **Returns.** `{sequence}`. Write tier.
- **Code.** `thread/tools.ts:110–114`; `thread/handlers.ts:258–263` (`queued-run.cancel`).

#### `t3_queue_reorder`

- **Purpose.** Move a queued message before another, or to the end (`beforeRunId: null`).
- **Inputs.** `threadId?`, `queuedRunId`, `beforeRunId`. **Returns.** `{sequence}`. Write tier.
- **Code.** `thread/tools.ts:115–119`; `thread/handlers.ts:264–270` (`queued-run.reorder`).

#### `t3_queue_promote_to_steer`

- **Purpose.** Turn a queued message into a steer of the running turn now.
- **Inputs.** `threadId?`, `queuedRunId`, `targetRunId`. **Returns.** `{sequence}`. Write tier;
  the steer rules of §1.5 apply.
- **Code.** `thread/tools.ts:120–125`; `thread/handlers.ts:271–277`
  (`queued-message.promote-to-steer`); `Orchestrator.ts:3585`.

#### `t3_pending_request_list`

- **Purpose.** List the open user questions in a thread.
- **Inputs.** `threadId?`. **Returns.** `{requestIds[]}` — `user_input` requests only; approvals
  are excluded.
- **Preconditions.** Read tier.
- **Code.** `thread/tools.ts:147–155`; `thread/handlers.ts:197–205`.

#### `t3_pending_request_read`

- **Purpose.** Read the structured questions of one open request.
- **Inputs.** `threadId?`, `requestId`. **Returns.** `{requestId, questions[]}` (header,
  question, options, multiSelect, allowCustomAnswer, required).
- **Failures.** Shared; `invalid_request` if not a pending user-input request.
- **Code.** `thread/tools.ts:156–164`; `thread/handlers.ts:52–77, 206–210`.

#### `t3_pending_request_respond`

- **Purpose.** Answer another agent's question on the user's behalf.
- **Reach for it** when the agent knows the answer a child or sibling thread is blocked on.
- **Inputs.** `threadId?`, `requestId`, `answers`. **Returns.** `{sequence}`.
- **Preconditions.** Write tier; user-input requests only — cannot approve a permission request.
  Uses the same `runtime-request.respond` as the UI, so a live request resumes the turn and a
  message-capable request is delivered as a message.
- **Code.** `thread/tools.ts:165–172`; `thread/handlers.ts:211–224`.

#### `t3_thread_configuration`

- **Purpose.** Read a thread's provider/model selection and modes.
- **Inputs.** `threadId?`. **Returns.** `{threadId, modelSelection, runtimeMode,
interactionMode}`. Read tier.
- **Code.** `thread/tools.ts:174–187`; `thread/handlers.ts:168–179`.

#### `t3_thread_configure`

- **Purpose.** Change a thread's provider, model and options for its next turn.
- **Inputs.** `threadId?`, `modelSelection`. **Returns.** `{sequence}`.
- **Preconditions.** Write tier. Dispatches `thread.model-selection.set` or `provider.switch` as
  appropriate; never changes permission modes. The tool does no catalogue check of its own
  (unlike `delegate_task`'s `target`).
- **Code.** `thread/tools.ts:188–196`; `thread/handlers.ts:180–196`.
- **Inventory differs.** Inventory §B: "change the _calling_ thread's model selection". Since
  #15219 it targets any writable thread.

#### `t3_thread_fork`

- **Purpose.** Branch a thread's conversation into a new idle thread from a stable point.
- **Reach for it** to explore an alternative without disturbing the original.
- **Inputs.** `threadId?`, `sourcePoint` (`latest_stable | run | checkpoint`), `title?`.
- **Returns.** `{sequence, targetThreadId}` (id = `<commandId>:fork`).
- **Preconditions.** Write tier on the **source**. The fork shares the source's checkout (§1.7)
  and starts idle; acceptance is not a turn.
- **Code.** `thread/tools.ts:199–209`; `thread/handlers.ts:118–136`; `ThreadForkService.ts:77–136`.

#### `t3_thread_merge_back`

- **Purpose.** Bring a fork's conclusions back into the thread it forked from, as context.
- **Inputs.** `sourceThreadId?` (omitted = self), `targetThreadId`, `sourcePoint`.
- **Returns.** `{sequence, targetThreadId}`.
- **Preconditions.** Write tier on **both** threads. The decider requires the source to be a
  direct fork of the target and the source run to be provider-finished. Produces a pending
  `merge_back` transfer consumed by the target's next run; queued messages on the target fail
  while it is pending.
- **Code.** `thread/tools.ts:210–220`; `thread/handlers.ts:137–153`; `Orchestrator.ts:3442–3583,
4703–4709`.
- **Docs differ.** The tool says "a related thread in the same project"; the decider accepts only
  fork → its parent. `feature-lifecycles.md` describes merge-back as triggered by "the next
  source-thread message with merge-back intent"; code has an explicit command (inventory §M6).

#### `t3_thread_transfers`

- **Purpose.** See a thread's context transfers (forks, handoffs, merge-backs, subagent spawns and
  results) and their status.
- **Inputs.** `threadId?`. **Returns.** `transfers[] {id, sourceThreadId, targetThreadId,
status}` — no type, points or resolution. Read tier.
- **Code.** `thread/tools.ts:221–237`; `thread/handlers.ts:154–167`.

#### `t3_thread_search`

- **Purpose.** Search thread titles and content with the app's bounded search.
- **Inputs.** The app's search input plus `projectId?`. **Returns.** `matches[]`, filtered to one
  project after taking the global top matches, so it may return fewer than `limit`.
- **Preconditions.** Capability only.
- **Code.** `thread/tools.ts:239–251`; `thread/handlers.ts:102–117`.

#### `run_scheduled_task_now`

- **Purpose.** Fire a scheduled task immediately, outside its schedule.
- **Inputs.** `taskId`. **Returns.** `{taskId, threadId, lastRunStatus, runCount, nextRunAt}`;
  completion means dispatch, not a finished turn.
- **Preconditions.** Environment tier: mid-turn and the caller itself `full-access` + `default`.
  Any task in the environment, no project check. A new manual run every call.
- **Failures.** `capability_denied`, `parent_not_active`, `invalid_request` (unknown task),
  `orchestration_error`.
- **Code.** `thread/tools.ts:253–268`; `thread/handlers.ts:79–101`.

### 2.3 `t3_thread_launch` (from `ProjectToolkit`)

- **Purpose.** Start one ordinary top-level thread already bound to a chosen workspace —
  including a **new worktree** — before its agent starts.
- **Reach for it** for independent implementation, a PR-stack layer, or anything that must not
  share the caller's checkout. It is the only agent tool that gives another agent its own
  worktree.
- **Inputs.** `title`; `message` (first prompt, delivered after workspace preparation; omit for an
  idle thread); `workspaceStrategy` (`root` default — **not** the caller's worktree;
  `existing_worktree {worktreePath, branch}`; `worktree {baseRef, branch?, startFromOrigin?}`);
  `projectId?`; `scratch?` (own folder under the Scratch project, outside any repository);
  `modelSelection?`, `runtimeMode?`, `interactionMode?`; `attachments?` (pending uploads, ≤ 8).
- **Returns.** `{threadId, projectId, modelSelection, runId, status}`; preparation may still be
  running.
- **Preconditions.** Capability; mid-turn (`readMutationCaller`); the caller itself
  `full-access` + `default` (`capability_denied` otherwise), and the requested runtime mode within
  the caller's. Inherits project, model and modes; never inherits the workspace. No idempotency
  key: retain `threadId`, and inspect `t3_thread_list` before retrying a lost call. No lineage to
  the caller; the first message carries `senderThreadId`.
- **Failures.** `capability_denied`, `parent_not_active`, `target_required`, `invalid_request`
  (non-pending attachment, `scratch` with `projectId`/`workspaceStrategy`, no model available),
  `runtime_mode_escalation_denied`, `orchestration_error`.
- **Code.** `project/tools.ts:102–145`; `project/handlers.ts:42–144`; workspace preparation
  `ThreadLaunchService.ts` (inventory §A, "Held / staged creation").

### 2.4 `PullRequestsToolkit` (5)

Shared behaviour (`pullRequests/handlers.ts:156–264`). Requires the `pull-requests` capability, not
`orchestration`. `threadId` omitted means the caller. Target a PR by `url`, or `repository` +
`number` (+ `host`, defaulting to the project's remote). Writing to **another** thread requires
mid-turn and within modes (`PullRequestThreadAboveLimitsError`); the caller's own thread is always
writable, even between turns. Failures are tagged errors, not `OrchestratorMcpFailure` codes:
`McpCapabilityUnavailableError`, `PullRequestUrlInvalidError`, `PullRequestTargetIncompleteError`,
`PullRequestHostRequiredError`, `PullRequestThreadRequiredError`,
`PullRequestThreadAboveLimitsError`, `PullRequestThreadNotFoundError`, and per-operation
`…FailedError` (`pullRequests/tools.ts:62–175`). No idempotency key, but every tool is idempotent
by outcome (`alreadyLinked`, `wasLinked`, `wasWatching`).

#### `link_pull_request`

- **Purpose.** Register a PR the agent opened against this thread so T3 tracks its status and
  settles the thread when it merges.
- **Reach for it** right after opening every PR, including each layer of a stack (the shared
  runtime instructions demand it).
- **Returns.** `{host, repository, number, url, alreadyLinked}`.
- **Code.** `pullRequests/tools.ts:246–258`; `pullRequests/handlers.ts:305–334`
  (`thread.pull-request.link`, `source:"agent"`).

#### `unlink_pull_request`

- **Purpose.** Remove a mistaken PR link. **Returns.** `{…, wasLinked}`.
- **Code.** `pullRequests/tools.ts:259–272`; `pullRequests/handlers.ts:335–367`.

#### `list_thread_pull_requests`

- **Purpose.** See a thread's linked PRs with last-known host state and how they stack.
- **Returns.** `pullRequests[] {identity, source, watching, state, title, headBranch, baseBranch,
isDraft, stack}`, `chains[]` bottom to top. Read: any thread, no mid-turn check.
- **Code.** `pullRequests/tools.ts:273–289`; `pullRequests/handlers.ts:368–371`.

#### `watch_pull_request`

- **Purpose.** Have T3 poll an open PR every minute and wake this thread with news.
- **Reach for it** instead of sleeping, polling or running a watcher while babysitting a PR.
- **Wakes on** a failed check, required checks passing, someone else's comment or review, or a
  conflict with base. Only comments after the call wake. Watching ends on merge, close, 15
  minutes of unreadable host, or `unwatch_pull_request`. Never wakes a settled thread. Links the
  PR first if needed; refuses a PR that is not open (`PullRequestNotOpenError`).
- **Returns.** `{…, watching, wasWatching}`.
- **Code.** `pullRequests/tools.ts:290–303`; `pullRequests/handlers.ts:265–303`;
  `PullRequestWatchReactor.ts`.

#### `unwatch_pull_request`

- **Purpose.** Stop watching; the link stays. **Returns.** `{…, watching, wasWatching}`.
- **Code.** `pullRequests/tools.ts:304–317`; `pullRequests/handlers.ts:373`.

### 2.5 `WorktreeToolkit` (3)

#### `t3_worktree_handoff`

- **Purpose.** Move the **calling** thread out of the project checkout into a new git worktree and
  branch, optionally continuing the conversation there.
- **Reach for it** when an agent started in the main checkout realises its work needs isolation.
- **Inputs.** `branch` (must not exist); `baseRef?` (default the project's current branch);
  `startFromOrigin?` (default the server setting); `path?` (absolute); `runSetupScript?` (default
  true); `continuationPrompt?`.
- **Returns.** `{worktreePath, branch, baseRef, startedFromOrigin, setupScript{status},
continuation{status, delivery?}, note}`.
- **Lifecycle.** Re-pointing the thread detaches its provider session, so the current turn ends
  shortly after; call it last. With `continuationPrompt` the remaining work is queued and starts a
  new turn inside the worktree with the conversation preserved; without it the thread idles until
  its next message. The worktree is not removed when the thread is deleted. Serialised per thread;
  rolls the worktree back if binding fails.
- **Preconditions.** `worktree` capability (not `orchestration`); thread caller; thread not already
  in a worktree, not archived; project is a git repository. No mid-turn check, no idempotency key.
- **Failures.** `WorktreeMcpFailure` codes: `capability_denied`, `thread_credential_required`,
  `thread_not_found`, `project_not_found`, `already_in_worktree`, `invalid_request`,
  `handoff_in_progress`, `operation_failed`.
- **Code.** `worktree/tools.ts:25–38`; `WorktreeMcpService.ts:145–473`.

#### `t3_worktree_status`

- **Purpose.** Report the calling thread's worktree binding before deciding on a handoff.
- **Returns.** `{attached, worktreePath, branch, projectWorkspaceRoot, defaultStartFromOrigin}`.
- **Preconditions.** `worktree` capability; thread caller.
- **Failures.** `capability_denied`, `thread_credential_required`, `thread_not_found`,
  `project_not_found`, `operation_failed`.
- **Code.** `worktree/tools.ts:40–56`; `WorktreeMcpService.ts:475–494`.

#### `t3_worktree_list`

- **Purpose.** List branch refs and their checkout paths for a thread's workspace.
- **Reach for it** to find an existing worktree path for `t3_thread_launch {existing_worktree}`.
- **Inputs.** `threadId?`, `query?`, `cursor?`, `limit?`, `refKind?`,
  `includeMatchingRemoteRefs?`.
- **Returns.** The app's `VcsListRefsResult`; detached worktrees are omitted.
- **Preconditions.** `worktree` capability **and** `orchestration` (it reads the thread through
  `threadAccess.readThread`); any thread.
- **Failures.** `capability_denied`, `target_required`, `thread_not_found`, `invalid_request`
  (project missing), `orchestration_error`.
- **Code.** `worktree/tools.ts:58–80`; `worktree/handlers.ts:13–36`.

---

## 3. Divergences

### 3.1 Design doc vs code

| #   | Doc says (`orchestrator-mcp-server.md` unless noted)                                                                                                 | Code does                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | "The server exposes eleven orchestration tools" (and lists twelve).                                                                                  | 15 in `OrchestratorToolkit`, 17 more in `ThreadToolkit`, `t3_thread_launch` in `ProjectToolkit`; 72 tools on `/mcp` (`McpHttpServer.ts:718–729`). (Inventory §M1.)                    |
| D2  | "The credential grants `preview` and `orchestration` capabilities."                                                                                  | `orchestration`, `worktree`, `pull-requests` always; `preview` when browser tools are allowed; `device` when requested (`McpSessionRegistry.ts:140–145`).                             |
| D3  | "Credentials expire after a maximum lifetime, expire when idle."                                                                                     | One 24 h liveness window refreshed by every MCP request and provider turn; no absolute maximum (`McpSessionRegistry.ts:68–82`). (Inventory §M2.)                                      |
| D4  | "Orchestration handlers additionally check the `orchestration` capability before reading or mutating state."                                         | True at call time, but tools are listed to every credential (`piT3McpExtensionSource.ts:189–203`); no listing filter exists.                                                          |
| D5  | Pi: "The first turn of a session also receives the shared T3 orchestration instructions."                                                            | Appended to Pi's system prompt on every `before_agent_start` (`piT3McpExtensionSource.ts:321–326`). (Inventory §M3.)                                                                  |
| D6  | "`ThreadManagementService` … owns project-scoped lookup"; "General thread management is limited to the calling thread's project."                    | Since #15219 reads and writes reach any thread in the environment; `projectId` on list/schedule targets any project (`threadAccess.ts:164–201`, `OrchestratorMcpService.ts:909–920`). |
| D7  | `t3_thread_list`: "Deleted threads and threads from other projects are never exposed."                                                               | Other projects are exposed via `projectId` (`OrchestratorMcpService.ts:1861–1866`).                                                                                                   |
| D8  | `t3_thread_read`: "a project-scoped thread"; `t3_thread_send`: "in the calling project"; `t3_thread_update`: "in the same project".                  | Any thread in the environment; the tool descriptions themselves say so ("any T3 thread in this environment", `orchestrator/tools.ts:178, 205, 232`).                                  |
| D9  | "Delegation requires an active parent run owned by the MCP credential's provider session."                                                           | Owned by the credential's provider **instance** (`OrchestratorMcpService.ts:1514`).                                                                                                   |
| D10 | `DelegateTaskInput` lists `runtimeMode: inherit \| approval-required \| auto-accept-edits \| full-access`; `target` without `options`.               | `auto` is also a mode (`OrchestratorMcpService.ts:436–451`); `target.options` exists and is validated (`:1091–1102`).                                                                 |
| D11 | Failure list of 14 codes.                                                                                                                            | 16: adds `thread_credential_required` and `target_required` (`orchestratorMcp.ts:591–613`); worktree and PR tools use their own error types.                                          |
| D12 | `orchestrator_capabilities` feature flags "for polling, cancellation, and batch thread creation".                                                    | Also `threadManagement`, `incrementalThreadRead`, `scheduledTasks` (`OrchestratorMcpService.ts:1492–1501`).                                                                           |
| D13 | No scheduled-task, queue, pending-request, fork/merge, organise, PR or worktree tools are described; `feature-lifecycles.md` has no scheduled tasks. | All exist (§2.1–2.5).                                                                                                                                                                 |
| D14 | `feature-lifecycles.md`: merge-back on "next source-thread message with merge-back intent".                                                          | Explicit `thread.merge_back` command and `t3_thread_merge_back` tool (`Orchestrator.ts:3442`). (Inventory §M6.)                                                                       |
| D15 | Tool text for `t3_thread_merge_back`: "to a related thread in the same project".                                                                     | Only from a fork to the thread it forked from (`Orchestrator.ts:3484–3493`).                                                                                                          |
| D16 | Docs: child receives "an optional role instruction".                                                                                                 | One fixed sentence from a six-value enum (`OrchestratorMcpService.ts:564`). (Inventory §M7.)                                                                                          |

The doc sentence "Successful results use the latest assistant content from the final work turn" is
**correct** and is the precise statement of L5.

### 3.2 Corrections to the sibling inventory and the strategy plan

| #   | Source and claim                                                                                                                                            | Code                                                                                                                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Inventory §C and plan: "A delegated task's published result is the first (original) child run's terminal output"; "publishes the first child run's output". | The latest terminal work run when the child first becomes quiescent (`SubagentProjection.ts:243–254`). Usually the first run; not when the child waited on its own children, was restart-continued, or had a message queued before finishing. |
| C2  | Plan, Area B: with `orchestration` withheld, `OrchestratorToolkit` and `ThreadToolkit` "are not listed to the agent at all".                                | They are listed; calls fail `capability_denied` (§1.10, L20). Hiding needs a listing filter. Withholding also disables `t3_thread_launch`, project/environment/attachment tools, `t3_thread_update`, `t3_worktree_list`.                      |
| C3  | Inventory §B: "Thread management is project-scoped; exception: `t3_thread_read` may read a thread the user attached".                                       | **Changed since the inventory** (#15219): environment-wide reads; cross-thread writes gated by mid-turn and modes, not project.                                                                                                               |
| C4  | Inventory §B: `t3_thread_configure` changes "the calling thread's model selection".                                                                         | **Changed since the inventory**: any writable thread (`thread/handlers.ts:180–196`).                                                                                                                                                          |
| C5  | Inventory §B: `McpInvocationScope` = `environmentId, threadId, providerSessionId, providerInstanceId, capabilities, issuedAt`.                              | **Changed since the inventory**: `{environmentId, capabilities, issuedAt, requestNamespace, thread?, client?}`; idempotency is namespaced by `requestNamespace` (`McpInvocationContext.ts:43–51`).                                            |
| C6  | Inventory §F: "Child → parent: only via delegated-task completion delivery … There is no general … 'notify parent' tool."                                   | `t3_thread_send` to `parentThreadId` works as one, provided the parent's modes are no broader than the child's (§1.4 item 2).                                                                                                                 |
| C7  | Inventory §B lists failure codes (14).                                                                                                                      | 16 on `upstream/main` (D11).                                                                                                                                                                                                                  |

Claim 1 of the plan (delegation needs a live parent turn) stands as written, with the instance-not-
session refinement (D9).

---

## 4. The remaining toolkits (not orchestration)

| Toolkit (count)              | Tools                                                                                                                                                                                                                                                                                 | One line                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PreviewToolkit` (14)        | `preview_status`, `preview_open`, `preview_navigate`, `preview_resize`, `preview_set_appearance`, `preview_snapshot`, `preview_click`, `preview_type`, `preview_press`, `preview_scroll`, `preview_evaluate`, `preview_wait_for`, `preview_recording_start`, `preview_recording_stop` | Drive the in-app browser shared with the user; `preview` capability, thread callers only.                                                                                      |
| `PreviewControlsToolkit` (2) | `t3_preview_list`, `t3_preview_close`                                                                                                                                                                                                                                                 | List and close the calling thread's preview tabs; `preview` capability.                                                                                                        |
| `DeviceToolkit` (4)          | `device_list`, `device_open`, `device_screenshot`, `device_close`                                                                                                                                                                                                                     | Drive a simulator or device session for mobile work; `device` capability, thread callers only.                                                                                 |
| `AttachmentToolkit` (3)      | `t3_attachment_prepare_upload`, `t3_attachment_discard`, `t3_thread_send_attachments`                                                                                                                                                                                                 | Stage files and send them to a thread; `orchestration` capability, mid-turn, write tier — `t3_thread_send_attachments` is the attachment-carrying sibling of `t3_thread_send`. |
| `EnvironmentToolkit` (2)     | `t3_environment_read`, `t3_environment_preferences_update`                                                                                                                                                                                                                            | Read the environment; change its preferences (full-access caller).                                                                                                             |
| `ProjectToolkit` CRUD (6)    | `t3_project_list`, `t3_project_read`, `t3_project_create`, `t3_project_update`, `t3_project_delete`, `t3_project_clone`                                                                                                                                                               | Register, change, delete or clone projects; reads need `orchestration`, changes need a full-access mid-turn caller.                                                            |
