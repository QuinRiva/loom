---
manager_sessions:
  - id: 86c158b7-7422-42ee-abb0-c9065deaa1ec
    role: architecture
    authored_at: 2026-06-22T22:58:54.791Z
---

# Workflow-based sub-agents in T3 Code — landscape research & design options

**Status:** research / design exploration (not a commitment to build)
**Audience:** anyone designing how T3 Code spawns, displays, and lets you interact with sub-agent sessions
**Date:** 2026-06-23

---

## 0. The problem, restated

Today's sub-agent story is pi's TUI-oriented `subagent` tool: the outer agent
calls a tool, a child runs in disposable context, and only a summary returns.
That is great for "go read 40 files and tell me the nugget", but it is a poor
fit for the workflow you actually run:

> discuss a feature → agree a plan → **spawn a coder** → when it's done →
> **spawn a reviewer** → fold results back.

Two reasons you reach for a sub-agent here, and they pull in different directions:

1. **Context hygiene** — protect the orchestrator thread's window from the
   coder's file-reading / diff churn. (A *tool-style* subagent does this well.)
2. **Role-specific prompting** — the coder must carry the coding principles; the
   reviewer must carry review heuristics; the orchestrator should *not*. (A
   *separate session with its own system prompt* does this well.)

Your instinct — "don't use pi's in-process subagent; instead launch a **new pi
session** through the same remote mechanism that launched the first one, keep it
**goal-constrained but hidden from the goal hierarchy**, surface its
status/activity, and let me **drop into it and chat directly** like any other
agent" — is exactly the design the rest of the industry has converged on. The
tool-call subagent and the spawn-a-session subagent are *different primitives*,
and everyone who got serious shipped the second one alongside the first.

This document surveys who built what, what worked, what broke, and how it maps
onto T3 Code's existing event-sourced thread/goal/driver architecture.

---

## 1. The two primitives (this is the central distinction)

Every mature system ended up with **both** of these, named differently:

| | **Tool-call subagent** | **Spawned session ("teammate"/"managed agent"/"sub-thread")** |
|---|---|---|
| Claude Code | *Subagents* (`Task` tool) | *Agent Teams* / *agent view* sessions |
| Cursor | *Subagents* (delegated in-context) | *Agents Window* / *Multitask* async subagents |
| OpenAI Codex | (CLI subtasks) | *Codex Cloud* parallel agent threads / macOS app |
| Devin | (internal) | *Managed Devins* ("Devin can manage Devins") |
| **What it is** | A child loop invoked *by the model* mid-turn | A first-class session a *human or agent* can address |
| **Context** | Fresh, disposable, returns only a summary | Fresh, **durable**, full transcript persists |
| **Who talks to it** | Only the parent model | Parent model **and** the human directly |
| **Lifecycle** | Lives inside one parent turn | Independent; outlives the spawning turn |
| **Visibility** | A tool-call card in the parent transcript | Its own addressable thread + status row |

Anthropic's own docs draw the line explicitly: *"Unlike subagents, which run
within a single session and can only report back to the main agent, you can also
interact with individual teammates directly without going through the lead."*
(code.claude.com/docs/en/agent-teams)

**Takeaway for T3 Code:** you are not replacing pi's subagent — you are adding
the *second* primitive. pi's tool-subagent stays useful for context-hygiene
probes. The new thing is a **sub-thread**: a real T3 thread, spawned by another
thread, that a human can open and chat with.

---

## 2. Reference implementations — deep dives

### 2.1 Claude Code: Subagents → Agent Teams → agent view

Three escalating tiers, all on one entry point (`AgentTool`):

- **Subagent** — child loop, own context window, own tool set, own permission
  boundary, own abort controller; prompt must be *self-contained* (no parent
  history). Returns a summary. (`how-claude-code-works/07-multi-agent`,
  `claude-code-from-source/ch08`)
- **Fork / Coordinator mode** — manager→worker hierarchy with result synthesis.
- **Agent Teams** (v2.1.x, experimental) — multiple **separate `claude` CLI
  processes**, each its own context window, coordinating through a *file-based*
  substrate. This is the closest analogue to your idea, and it was
  reverse-engineered in detail (nwyin.com). Key facts:
  - Coordination substrate is **flat files** under `~/.claude/`: `teams/{team}/config.json`, per-agent `inboxes/{name}.json`, `tasks/{team}/{id}.json` + `.lock` (flock) + `.highwatermark`.
  - **Messaging = file append + poll.** Inbox messages are injected into the recipient as *synthetic user turns*. Latency = poll interval.
  - Teammates **do not inherit the lead's history** — only the spawn prompt + project context (CLAUDE.md, MCP, skills).
  - Each teammate auto-sends an `idle_notification` when its turn ends; the lead has `waitForTeammatesToBecomeIdle()` as a sync primitive.
  - Teammate context carried in `AsyncLocalStorage`: `agentId`, `agentName`, `teamName`, **`parentSessionId`**, `color`, `planModeRequired`.
  - **Cost: ~7× tokens** in plan mode (each teammate is a full instance). Stall detection is *manual*. No automatic merge — agents edit the shared working dir directly (→ conflicts).

- **agent view** (`claude agents`) — the *management surface*. One screen lists
  every background session grouped by state, **pinned + "needs you" at the top**,
  each row showing name, current activity, and time-since-change, with an icon
  whose **color/animation encode state**. Notably: *"Subagents and teammates a
  session spawns aren't listed as separate rows"* and *"interactive sessions you
  have open in other terminals don't appear until you background them."*

**Lessons to steal:** the `parentSessionId` field; the idle-notification
heartbeat; the status row (name + activity + age + state-color); the "needs you"
sort. **Lessons to avoid:** file-poll mailboxes (you have a WebSocket + event
store — use them); shared working dir without isolation; no cost aggregation.

### 2.2 OpenAI Codex Cloud / macOS app

Async task engine: dispatch from CLI / Slack / GitHub issue / web; each task
runs in an **isolated cloud sandbox** and returns a *reviewable diff*. The
macOS app (Nov 2025) is explicitly *"designed to manage multiple agents at once,
run work in parallel, and collaborate over long-running tasks."* Each task is an
**agent thread** you manage; you *review completed work rather than babysit*.

**Lessons:** the dispatch-surface plurality (you already have a remote launcher —
lean into "spawn from anywhere"); diff-as-the-unit-of-review; parallel threads
with a review queue.

### 2.3 Devin — "Devin can manage Devins"

A main session acts as **coordinator**; it breaks a large task into pieces and
delegates to *managed Devins*, each a **full Devin in its own VM with its own
terminal/browser/env**, **its own session link**, so you can *"inspect its work
or message it directly."* Devin Desktop's **Agent Command Center** is a
**Kanban board** of all agents (local + cloud); *Spaces* group related
sessions/PRs/files/context.

**Lessons:** "each sub-agent has its own session link you can message directly"
is *precisely* your requirement; Kanban-by-state is a strong management UI;
Spaces ≈ your goal grouping.

### 2.4 Cursor — Agents Window + Multitask + tiled layout

- **Agents Window** is the agent-first control center for many agents across
  repos/environments.
- **`/multitask`** spins up **async subagents** that appear as **threads in a
  side pane**; you can switch into any thread and steer it.
- **Tiled agent layout** (3.1): one pane per agent. The documented rationale
  (agentpatterns.ai): *once concurrency exceeds 2–3, tab-based switching breaks
  down — each switch costs a click + a "which agent is this, what was it doing"
  reload, so the supervisor stops checking agents that aren't focused (they "go
  dark behind the active tab").* Tiles lower per-switch cost.
- **Documented failure** (Cursor forum): a background subagent blocked on a
  permission prompt went **silently stuck** — the side pane *did not signal that
  the thread needed attention*. → **Attention state must be a first-class,
  surfaced signal**, not something you discover by clicking in.

### 2.5 OSS dashboards & orchestrators (the "hundreds of GitHub projects")

The space is crowded; useful to triage by **shape**:

- **Terminal-session managers:** Claude Squad (tmux/TUI, worktrees, MIT) — lean.
- **Parallel-worktree desktop apps:** Conductor (macOS, checkpoints), Crystal.
- **Task boards:** **vibe-kanban** (Apache-2.0, harness-agnostic: Claude/Codex/
  Gemini/Amp/Copilot/Cursor/OpenCode; web + usable on mobile) — Kanban over
  issues/workspaces.
- **Web control rooms (most relevant to T3 Code):**
  - **agent-cockpit** — local-first browser control room; approvals, diffs,
    **timeline replay**, memory, chat, session history.
  - **antonioromano/code-orchestrator** — spawn Claude/Gemini/Codex via PTYs,
    stream I/O to browser terminals, real-time session state.
  - **dustinblack/agent-dashboard** — FastAPI+React, PTY streaming, **OpenTelemetry
    token tracking**, multi-host, worktrees.
  - **TermHive**, **Shep** (worktree-per-feature → PR), **overstory** (explicitly
    supports **pluggable runtime adapters for Claude Code *and pi***, SQLite
    "mail" coordination, `ov serve` web UI).
- **DAG / role-pipeline orchestrators:** Shard (LLM decomposes task → DAG of
  parallel subtasks with exclusive file ownership), Antfarm (planner/dev/verifier/
  tester/reviewer with fresh context + clean handoffs), soo (simple
  orchestrator: plan→approve→implement→review).
- **pi-specific prior art:** **marcfargas/pi-server** — runs pi as a *headless
  daemon* with detachable terminal clients over WebSocket (your "launch a session
  remotely and reconnect" pattern, already done for pi). GSD's ADR #2555
  documents pi's **headless mode + JSON-RPC over stdio** (`--mode rpc`, ~30
  commands, JSONL events on stdout) as the programmable surface — this is the
  exact API a T3 PiDriver would drive to spawn/stream a sub-session.

---

## 3. Cross-cutting design axes (decide these explicitly)

1. **Isolation model.** Shared working dir (Claude Teams — simple, conflict-
   prone) vs **git-worktree-per-agent** (Conductor/Crystal/Shep/Shard/overstory —
   the dominant choice). *T3 Code already has a VCS/worktree subsystem and threads
   already carry `branch`/`worktreePath`.* A coder sub-thread on its own worktree
   is natural; a reviewer sub-thread is read-only on the coder's branch.
2. **Coordination substrate.** Files+poll (Claude) vs DB/mailbox (overstory's
   SQLite, Hive) vs **event log + push** (T3 Code already *is* event-sourced with
   a WebSocket). Use what you have.
3. **Topology.** Lead+flat-peers (Claude Teams), strict hierarchy/coordinator
   (Devin), DAG (Shard). Your workflow is a **shallow hierarchy**: orchestrator →
   {coder, reviewer}, usually sequential.
4. **History inheritance.** Universal answer: **teammates start fresh** with a
   self-contained spawn prompt, *not* the parent transcript. This is both a
   context-hygiene win and the reason role-prompts work.
5. **Human addressability.** Tool-subagents: no. Sessions/teammates: **yes** —
   and this is the feature you specifically want.
6. **Merge/review unit.** Diff/PR (Codex, Shep) is the clean handoff. Fits your
   plan→code→review loop: the reviewer reviews the coder's *diff*.

---

## 4. What worked vs what burned people

**Worked**
- Fresh-context children + self-contained spawn prompts (context hygiene + role
  prompting in one move). *Everyone.*
- Worktree-per-agent isolation. *Conductor/Crystal/Shep/Shard/overstory.*
- A dedicated management surface (list/Kanban/tiles) separate from any single
  transcript, with state-coloured rows and a **"needs you" priority sort**.
  *Claude agent view, Devin Command Center.*
- Diff/PR as the review artifact and merge unit. *Codex, Shep.*
- Idle/heartbeat notifications so the parent (and human) know a child finished or
  stalled. *Claude Teams `idle_notification`.*

**Burned people** (the pitfalls literature is remarkably consistent)
- **Shared filesystem = silent corruption.** "Parallel agents that share a
  filesystem will corrupt each other's work" (rezzed.ai, 9-agents-in-parallel).
  → isolate.
- **The coordination channel breaks and agents go dark** without crashing
  ("Session not found" on every MCP call; relay goes silent). → treat as a
  distributed system; make liveness observable.
- **Silent stalls / lost attention requests.** Cursor's stuck-on-permission bug;
  Claude's manual stall detection. → **attention is a first-class surfaced
  state**, with timeout/heartbeat, not a thing you find by clicking in.
- **Opaque routing in heavy frameworks.** "Why I stopped using multi-agent
  frameworks" — when a multi-agent workflow fails you must debug *your prompts +
  the framework's routing + the model* at once, and routing is usually
  undocumented and invisible in traces. → keep orchestration thin and **fully
  visible in your own event log**; you already have replay.
- **Lost-update / distributed-state races** (two agents read state, both write,
  one clobbers). → single writer per resource; your event store + per-thread
  ownership helps.
- **Token blow-up (~7×).** Each session is a full context. → **aggregate and
  display per-sub-thread cost/tokens**; make spawning a deliberate act.
- **Identity drift in long peer chains** (reviewer contradicts coder contradicts
  orchestrator). → keep the hierarchy shallow and role-scoped; prefer
  orchestrator-mediated handoffs over free peer chatter.

---

## 5. UX patterns for status & direct interaction (your two UI questions)

**Q: how do we show that sub-agents are running?**

Converged patterns, in rough order of fit:

- **Inline "spawn card" in the parent transcript** (assistant-ui's
  `MessagePartPrimitive.Messages`, Trigger.dev sub-agent streaming): the
  orchestrator's message that launched the child renders an **expandable card**
  showing the child's live activity + status, collapsed by default. This keeps
  the spawn legible in context *without* dumping the child's whole transcript
  into the parent. Click to expand → drill into the full child thread.
- **A status strip / "sub-agent rail"** attached to the parent thread (not the
  global goal sidebar): one row per sub-thread with **name · role · state ·
  age · token/cost**, state encoded by colour + motion (running pulses, blocked
  is amber + "needs you", done is green). This is Claude's agent-view row,
  scoped to one parent.
- **Global agent view / Kanban** (optional, later): all live sub-threads across
  the app, "needs you" pinned to top. Matches Devin Command Center / Claude
  `claude agents`. Probably v2 for you.
- **Tiled panes** once >2–3 run concurrently (Cursor 3.1 rationale). Likely
  overkill for a sequential coder→reviewer loop; revisit if you fan out.

**Q: how do we engage directly with a sub-agent?**

- The sub-thread **is a real T3 thread** (its own provider session, transcript,
  composer, runtime mode). "Engaging" = opening it and typing, identical to any
  other thread — which is exactly your stated requirement ("engage with them in
  a similar way to how we engage with any other agent").
- Surface it as a **drill-in from the parent** (expand the spawn card → "Open
  thread"), *not* as a top-level goal-tree node. Render it as a child route/panel
  of the parent thread. Breadcrumb back to the parent.
- When you send a message into a running child, mirror Claude Teams: it lands as
  a normal user turn and *wakes* the child on its next step.
- **Attention routing:** if a child blocks (approval needed, error, idle-with-
  unfinished-work), bubble a badge up the spawn card → parent thread row → global
  indicator. Do not let it go dark (the Cursor failure).

---

## 6. Mapping onto T3 Code's existing architecture

You are unusually well-positioned: most of the substrate the OSS projects had to
invent, you already have.

**What already exists (grounding):**
- **Event-sourced orchestration** (`apps/server/src/orchestration/`:
  decider/projector/event store, command receipts, projection checkpoints).
  Coordination substrate = your event log, not files-on-disk.
- **Threads as aggregates** (`ThreadCreatedPayload`): already carry
  `projectId`, `goalSlug`, `title`, `modelSelection`, `runtimeMode`,
  `interactionMode`, `branch`, `worktreePath`. **No `parentThreadId` yet.**
- **Goals are file-centric** (`goals/<slug>/goal.md`, `GoalsService` re-scans);
  threads link to goals via `goalSlug`. The sidebar/goal index is driven by this.
- **Provider drivers** incl. **`PiDriver`** (861 lines) — spawning a pi session
  *as a provider session* is already the model. Codex/Claude/Cursor/OpenCode/Grok
  drivers too → sub-threads can be *any* provider, not just pi.
- **WebSocket protocol** (`subscribeThread`, `subscribeShell`, `dispatchCommand`,
  `replayEvents`) — push-based streaming + replay already done.
- **VCS/worktree subsystem** (`apps/server/src/vcs/`, `git/`) — isolation
  primitive already present.

**The minimal shape of the change (illustrative, not a plan):**
1. **Add lineage to the thread aggregate.** A nullable `parentThreadId` (and
   maybe `role: "coder" | "reviewer" | …` + `spawnPrompt`) on `ThreadCreated`.
   This is the single load-bearing schema addition — it makes a thread a
   *sub-thread* without a new aggregate. (Mirror Claude's `parentSessionId`.)
2. **Hide sub-threads from the goal tree, show them under the parent.** The goal
   sidebar already filters by `goalSlug`; additionally exclude threads with a
   `parentThreadId` from the top-level list, and render them as children of the
   parent thread's view. A sub-thread can still *inherit* the parent's `goalSlug`
   for constraint without appearing as a goal node.
3. **A "spawn sub-thread" command** = the existing thread-create command +
   `parentThreadId` + a role-specific system-prompt overlay (the coding-
   principles prompt for coder, review heuristics for reviewer). The orchestrator
   issues it via a tool, *or* you click "spawn coder" in the UI.
4. **Status surfacing rides existing events.** The projector already produces
   per-thread state; add a derived "sub-thread summary" (state/age/tokens) the
   parent thread subscribes to. Inline spawn card + sub-agent rail consume it.
   No new transport.
5. **Direct interaction is free.** A sub-thread is a thread; `dispatchCommand` /
   `subscribeThread` already let the UI open and message it. The only new UI is
   the drill-in affordance and the breadcrumb.
6. **Lifecycle / attention.** Reuse runtime-mode + approval events to mark
   "needs you"; bubble it up the parent. Reuse the reaper for cleanup.

**Things to consciously *not* copy:**
- File-poll mailboxes / `.highwatermark` (you have an event log).
- A second coordination database (overstory/Hive built SQLite mail because they
  had no event store — you do).
- Heavy DAG decomposition (Shard) — your loop is shallow and human-gated.
- Free peer-to-peer messaging between children — keep handoffs orchestrator-
  mediated to avoid identity drift.

---

## 7. A concrete recommended direction

For the workflow you described (plan → spawn coder → spawn reviewer):

- Model sub-agents as **sub-threads = real threads with `parentThreadId`**, each
  its own provider session (often pi, but driver-agnostic), each with a
  **role-scoped system prompt**, started **fresh** (self-contained spawn prompt,
  not parent history).
- **Isolation:** coder on a **worktree/branch**; reviewer **read-only on the
  coder's branch**, reviewing the **diff**.
- **UI:** inline **expandable spawn card** in the parent transcript (live status,
  collapsed by default) + a **sub-agent rail** on the parent thread (row per
  child: role · state-colour · age · tokens · "needs you"). Drill-in opens the
  child as a child route you can chat with exactly like any thread. **Keep
  sub-threads out of the left goal hierarchy.**
- **Coordination:** your **event log + WebSocket**, not files. Spawn / status /
  completion / attention are all events.
- **Guardrails up front** (the pitfalls): worktree isolation, surfaced
  attention/heartbeat state (no dark stalls), per-child token/cost display,
  thin+visible orchestration (lean on replay), shallow hierarchy.

This keeps pi's tool-subagent for context-hygiene probes and adds the durable,
addressable **sub-thread** as the workflow primitive — which is the same split
Anthropic (subagents vs teams), Cursor (subagents vs multitask), and Devin
(internal vs managed Devins) all landed on.

---

## 8. Open questions for you

1. **Spawn trigger:** model-initiated (orchestrator calls a "spawn coder" tool),
   human-initiated (a button), or both? (Devin/Codex lean model-initiated;
   Conductor/vibe-kanban lean human.)
2. **Concurrency:** is the coder→reviewer loop strictly sequential, or do you
   want fan-out (multiple coders)? Drives whether you need tiles / global agent
   view now or later.
3. **Isolation strictness:** worktree-per-sub-thread (clean, heavier) vs shared
   working dir with the parent (simpler, conflict-prone)?
4. **Cross-provider:** must a pi orchestrator be able to spawn a *Codex/Claude*
   sub-thread (driver-agnostic), or is pi→pi enough for v1?
5. **Goal coupling:** should a sub-thread inherit the parent's `goalSlug`
   (constrained but hidden), or be fully detached from goals?
6. **Persistence of role prompts:** where do the coder/reviewer system prompts
   live — pi agent definitions, T3 config, or per-project files?

---

## 9. Addendum — Hermes, OpenClaw, and the DAG question

### 9.1 The DAG claim, split into three different claims
"Workflows are best represented as a DAG" conflates three separable decisions:

1. **Dependency model** — *what waits on what.* A DAG is the right shape here.
   "reviewer waits on coder" is a directed edge; independent coders are parallel
   branches. (tianpan.co, zylos.ai: DAGs give determinism, auto-parallelism of
   independent branches, auditability.)
2. **Execution engine** — *what actually drives the runtime.* A **pure DAG is a
   poor fit** for your workflow, for two reasons:
   - **Your loop is cyclic.** plan → code → review → *fix → re-review* → done.
     Review-bounce and human-redirect are cycles; a DAG is acyclic *by
     definition*. Pure-DAG engines (Airflow/Prefect-classic) suit ETL where a
     step never revisits a prior stage; LLM agents intrinsically iterate, which
     is why LangGraph chose a *cyclic* graph + shared state, and why Hermes uses
     a state board, not a DAG scheduler. (zylos.ai, bestaiweb.ai, latenode.)
   - **Work is emergent, not pre-planned.** A DAG wants the node/edge set up
     front; an orchestrator *discovers* sub-tasks mid-flight ("also needs a
     migration — spawn another coder"). Static DAGs force constant graph rewrites.
3. **Visualization** — *what the human sees.* This is where your intuition is
   strongest and most defensible: a **dependency/lineage graph view** ("what's
   running, what's waiting, what's planned") is genuinely clarifying — but it can
   be a *derived view* over event-sourced state, **without** committing the
   runtime to DAG execution.

**Verdict:** adopt DAG as the *dependency overlay* and offer a graph *view*;
do **not** make a pure DAG your execution substrate. Model runtime state as a
per-thread **state machine** + parent/blockedBy edges in your event log, and
render the graph from it. This is exactly what the strongest reference (Hermes)
does.

### 9.2 Hermes (NousResearch/hermes-agent) — Kanban, not a graph engine
Hermes **deliberately moved off in-process subagent swarms** (its `delegate_task`
throwaway-child model — pi's current shape) toward **Hermes Kanban**: a durable
board in `~/.hermes/kanban.db` where *"every task is a row, every handoff is a
row anyone can read/write, every worker is a full OS process with its own
identity"* (issue #344 frames the old way as "delegation, not multi-agent").
Grounded in the source (`hermes_cli/kanban*.py`, `tools/kanban_tools.py`):

- **State machine, not a DAG, is the lifecycle truth:** `todo → ready → running
  → blocked/scheduled → done → archived`. Kanban owns this; **workers execute
  but never own truth** — everything flows back via `kanban_*` tools
  (`kanban_show/list/complete/block/heartbeat/comment`) or an API for external
  workers. *Reviewers gate.*
- **Dependencies *are* a DAG, built by the decomposer** (`kanban_decompose.py`):
  the LLM emits tasks with `parents` = indices expressing *"actual data
  dependencies. Tasks with no parents run in PARALLEL. Tasks with parents wait
  until every parent completes."* So the DAG is the **dependency substrate**, and
  the dispatcher topologically promotes `ready` tasks and fans out parallel ones.
- **Dispatcher loop:** "reclaim stale, promote ready, spawn workers" — with
  **stale-claim reclamation via heartbeats** (directly fixes the silent-stall
  failure mode) and a **per-profile cap** on concurrent workers.
- **Worker lanes:** a class of process the dispatcher routes to; each lane =
  identity (assignee) + spawn mechanism + contract. `kanban claim` **atomically
  claims a ready task and prints a resolved workspace path** (worktree isolation
  per task).
- **The UI is a board, not a node-graph:** the dashboard plugin
  (`plugins/kanban/dashboard`) is *"Multi-agent collaboration board — drag-drop
  cards across columns, read comment threads, see which profile is running
  what."* They had the full dependency DAG and still chose **columns-by-state**
  for the human view.
- (`hermes claw migrate` exists — Hermes positions itself as a migration target
  *from* OpenClaw; the two are related lineages.)

**Why this matters for you:** Hermes is the closest match to your exact
coder→reviewer workflow and your "full session with its own identity, addressable
directly" requirement — and its considered answer was **DAG-for-dependencies +
state-board-for-everything-else**, explicitly *not* a DAG execution/visual model.

### 9.3 OpenClaw — layered: tasks → Task Flow → workflow engine
- **Task Flow:** durable multi-step flows (sequential *or branching*) with their
  own state, revision tracking, sync semantics, surviving gateway restarts; a
  plain "task" is the unit of detached work beneath it.
- **Lobster workflow engine:** **stateful, resumable, pausable for human
  approval** — i.e. a state machine, chosen over stateless cron for anything that
  must survive failure or gate on a human.
- **Multi-agent routing:** isolated agents, each its own `agentDir` workspace /
  auth / model registry / session store; inbound messages routed by bindings.
- **`jerednel/openclaw-workflow` plugin:** the one place that *is* an explicit
  **declarative dependency graph** — YAML/JSON with dependency edges, parallel
  execution, output gates, retry, **partial resume**. Note it's a *declarative
  pipeline* (known steps up front) — great for repeatable automations, weaker for
  emergent agent work, which is why it coexists with the stateful engine rather
  than replacing it.

**Net:** OpenClaw, like Hermes, keeps the *declarative dependency graph* for
known pipelines but runs *emergent/human-gated* work on a **stateful, resumable
state-machine** substrate. Same conclusion as §9.1.

### 9.4 Recommendation for T3 Code's visualization
- **Primary view: a state board (Kanban-style lanes)** of sub-threads for a given
  parent/goal — columns `planned → running → blocked/needs-you → in review →
  done`. This directly answers "what's running, what's waiting" and matches your
  prior UI prefs (sortable secondary views, "needs you" surfaced, combined +
  per-stage counts). It tolerates cycles (a card moves back to `running`) and
  emergence (add a card anytime) — both of which break a node-graph.
- **Secondary view: a derived dependency/lineage graph** ("plan view") rendered
  from `parentThreadId` + `blockedBy` edges in the event log — the DAG overlay
  the user wants, *without* the runtime being a DAG. Best for inspecting "what's
  planned and what waits on what" at a glance.
- **Per-thread: the state machine** (`planned/running/blocked/review/done`) lives
  on the thread aggregate; the board and graph are both projections of it. Add a
  **heartbeat/stale-claim** mechanism (steal from Hermes) so blocked/dead
  sub-threads never go dark.

This keeps the DAG where it's strong (dependencies + a clarifying view) and uses
a state machine where the DAG is weak (cyclic, emergent, human-gated execution).

---

### Appendix — primary sources

- Claude Code subagents/teams/agent-view: code.claude.com/docs/en/{sub-agents,
  agent-teams, agent-view, agents}; reverse-engineering: nwyin.com (agent teams
  protocol); claude-code-from-source ch08/ch10; how-claude-code-works/07-multi-agent.
- Codex Cloud / app: developers.openai.com/codex/cloud; openai.com (Introducing
  the Codex app / Introducing Codex).
- Devin: cognition.ai/blog/devin-can-now-manage-devins; docs.devin.ai/desktop/
  agent-command-center; devin.ai/blog/windsurf-is-now-devin-desktop.
- Cursor: cursor.com/help/ai-features/{background-agents,multi-agent};
  cursor.com/docs/subagents; cursor.com/changelog/04-24-26; agentpatterns.ai/
  workflows/tiled-agent-layout; Cursor forum stuck-subagent bug.
- OSS: vibe-kanban, agent-cockpit, antonioromano/code-orchestrator,
  dustinblack/agent-dashboard, TermHive, Shep, overstory (pi adapter!), Shard,
  Antfarm, soo; comparisons: munderdiffl.in, amux.io, nimbalyst.com, parallelcode.app.
- pi prior art: marcfargas/pi-server (headless daemon + WS); GSD ADR #2555
  (pi headless mode + JSON-RPC).
- UI rendering: assistant-ui multi-agent (`MessagePartPrimitive.Messages`);
  trigger.dev sub-agents (streaming child into parent tool card).
- Hermes: hermes-agent.nousresearch.com/docs (kanban, kanban-worker-lanes,
  agent-loop); GitHub NousResearch/hermes-agent (issue #344; `hermes_cli/kanban*.py`,
  `tools/kanban_tools.py`, `plugins/kanban/dashboard`).
- OpenClaw: documentation.openclaw.ai/automation/taskflow; docs.openclaw.ai/
  concepts/multi-agent; learnopenclaw.org/multiagent; github.com/jerednel/openclaw-workflow.
- DAG vs state machine: tianpan.co (DAG-first), zylos.ai (orchestration patterns;
  graph-based production landscape), bestaiweb.ai (DAGs vs state machines),
  latenode.com (LangGraph), arunbaby.com (dependency graphs for agents).
- Pitfalls: rezzed.ai (9 parallel programs), turion.ai (production lessons),
  marklaursen.com (why I stopped using frameworks), mohammadkhan.dev
  (distributed-systems problem), codewithagents.de (the agent that hung).
