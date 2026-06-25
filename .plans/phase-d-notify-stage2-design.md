---
manager_sessions:
  - id: e60766ea-eda2-46fa-9573-bc03cc432a2f
    role: plan
    authored_at: 2026-06-25T05:57:00.534Z
  - id: 687bc03d-a443-499b-868a-9f23872d4ec0
    role: plan
    authored_at: 2026-06-25T07:24:00.362Z
---

# Phase D-notify Stage 2: workstream-graph inspection tools (`list` + `read_thread` + `ask_thread`)

**Status:** design, ready to implement. Self-contained for a fresh thread (the
authoring thread's context is exhausted). The intent was specified in
`.plans/phase-d-notify-design.md` (the "communication layer", decision 6, and the
two-stage split); this doc makes Stage 2 implementation-ready.

> **Revision history (this doc evolved through review):**
> 1. The first draft named the tools `read_child`/`ask_child` and framed
>    `ask_child`'s LLM call as "mirror the `TextGeneration` service." Both wrong:
>    the asker can be a **sibling** (a reviewer asking a sibling coder), and
>    `ask_thread` is the **`consult_manager` fork-a-frozen-session mechanism**, not
>    a `TextGeneration` call.
> 2. The second draft added `workstream_list` for discovery, then a review found
>    that a bolt-on list would be the **third** ad-hoc walker of the workstream
>    graph (after the dispatcher's `selectJoinedGenerations` and the web
>    `WorkstreamPanel`). So Stage 2 now builds **all** graph consumers — discovery,
>    the same-tree auth predicate, and the existing dispatcher join — on **one
>    shared pure graph module**, mirroring the existing
>    `@t3tools/shared/workstreamDependencies` "single source of truth" pattern.

**Prerequisite (merged):** D-notify Stage 1 — `workstream_report(markdown)` already
exists: a child records a markdown handoff stored as a file in a stable per-thread
dir, with a `reportPath` pointer on the thread record, surfaced to the parent's
wake message as a bounded summary + reference. Stage 2 builds directly on that.

## Why this exists
Stage 1 propagates a child's completion *up* to its parent with a bounded summary +
a `reportPath`. But a thread has **no first-class way to (a) discover the other
threads in its workstream, (b) pull another thread's full report, or (c) ask another
thread a clarifying question.** Stage 2 adds three tools, all scoped to the caller's
**workstream tree**:
1. **`workstream_list`** — discovery: return the caller's workstream graph
   (structure + state), so the caller knows which threads exist and their ids.
2. **`read_thread`** — passive: return a target thread's report/output/metadata. No
   model call.
3. **`ask_thread`** — active but **read-only (frozen oracle)**: answer a question
   from a read-only *fork* of the target thread's pi session, without re-activating
   or mutating the target.

**Discovery is load-bearing, not optional.** `read_thread`/`ask_thread` take a
**workstream `threadId`** (not a pi `session_id` — that is derived internally). A
thread only ever learns ids from `workstream_spawn`'s return value, which a sibling
never sees. Without `workstream_list`, the sibling→sibling case (the whole reason
the scope widened past parent-of) is **unreachable** — the agent would have to hunt
for an id it cannot get. `list` is what makes `read`/`ask` usable.

**Cross-dependency to flag:** the **D-liveness investigator (Stage 2 of the
dispatcher doc)** needs to read the graph + a target's transcript to judge
real-work-vs-stuck-loop. The shared graph module and these tools are exactly that
capability. Land this Stage 2 **before** the D-liveness investigator (the user's
chosen sequence) so it builds on this foundation rather than inlining its own.

---

## Part A — the shared graph module (`@t3tools/shared/workstreamGraph`)

### Why a shared module (the duplication this kills)
The workstream graph is already walked in (at least) two places with independent
code, and a third is coming:
- **Server, dispatcher:** `selectJoinedGenerations(threads)`
  (`apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts:84`) — a pure
  function over `OrchestrationThreadShell[]` that groups by
  `(parentThreadId, spawnGeneration)` and evaluates terminal-ness.
- **Client, panel:** lineage/waits-on **edge derivation** in `WorkstreamPanel.tsx`
  (note: its `groupChildrenByColumn` @220 is status *bucketing*, not graph traversal,
  so the module won't replace that part — the web overlap is edges, migrating it is
  out of scope here). The immediate, real dedup is **server-side** (dispatcher join +
  new list traversal + auth predicate), which alone justifies the module.
- **Future:** the D-liveness investigator will walk the same graph for stall
  detection.

Adding a third bespoke walker for `workstream_list` would compound the smell. The
canonical node already exists — `OrchestrationThreadShell`
(`packages/contracts/src/orchestration.ts:507`: `threadId`, `parentThreadId`,
`spawnGeneration`, `status`, `role`, `title`) — and the read model already emits a
snapshot of them (`projectionSnapshotQuery.getShellSnapshot()`,
`WorkstreamDispatcher.ts:307`). The module is a pure layer over that node set.

### Precedent to mirror exactly
`@t3tools/shared/workstreamDependencies` (`packages/shared/src/workstreamDependencies.ts`)
is the template: it defines a **minimal structural node shape**
(`DependencyGateThread`) that **both** `OrchestrationThread` and
`OrchestrationThreadShell` satisfy, and one pure predicate
(`areDependenciesSatisfied`) that is *the* single source of truth, consumed by both
the decider and the dispatcher so "board display and execution gating never
disagree." `workstreamGraph` is its sibling for **structure + membership**.

### Module surface (pure, no I/O; new subpath export `@t3tools/shared/workstreamGraph`)
Operate on a minimal node shape both the shell and the read-model thread satisfy:
```ts
interface GraphThread {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly spawnGeneration: string | null;
  readonly status: ThreadStatus;
  readonly role: string | null;
  readonly title: string | null;
}
```
Provide:
- **Adjacency:** build `byId` + `childrenByParent` once from `ReadonlyArray<GraphThread>`.
- **Structural queries (only what Stage-2 consumers use):** `rootOf(id)` (internal
  ancestor-walk), `childrenOf(id)`, `descendantsOf(id)`/`subtreeOf(id)`. Do **not**
  export `ancestorsOf`/`siblingsOf` speculatively — no Stage-2 consumer needs them;
  add them when D-liveness actually lands (AGENTS.md minimal surface).
- **Membership predicate (powers auth):** `isInSameTree(callerId, targetId)` ⇔ the
  two share the same root orchestrator (root = a thread with `parentThreadId === null`).
  The **single** boundary used by both `list` (what you can see) and `read`/`ask`
  (what you can touch); it correctly includes siblings.
- **Generation join:** **relocate** `selectJoinedGenerations` + `isTerminalStatus`
  here (already pure and well-tested; the move deletes the dispatcher's private
  grouping). Keep generation grouping **internal** to `selectJoinedGenerations` — do
  not export a standalone `groupByGeneration` (no consumer needs it). The dispatcher
  imports the two relocated functions afterward.
- **Graph view (the discovery payload):** `graphViewFor(callerId, threads)` → the
  caller's whole workstream tree (rooted at `rootOf(callerId)`) as nodes
  (`id, role, title, status, spawnGeneration, parentThreadId, reportPath?`) + lineage
  edges (parent→child) + waits-on edges (`blockedBy`). Lean by construction.

### Consumers after this change
| Consumer | Uses |
|---|---|
| Dispatcher (existing) | `selectJoinedGenerations` / `groupByGeneration` imported from the module (private copy deleted) |
| `workstream_list` (this stage) | `graphViewFor` |
| `read_thread` / `ask_thread` auth (this stage) | `isInSameTree` |
| D-liveness investigator (future) | structural queries + status classification |
| Web Board/Graph (optional follow-up, not required here) | the same structural derivation |

---

## Part B — `ask_thread` is `consult_manager` for workstream threads
`consult_manager` already consults a **frozen, read-only snapshot** of a prior pi
session and answers a question from it, without resuming or mutating it.
`ask_thread` is the same pattern pointed at a workstream sibling/child. The
pi-native primitive is **session forking**, exported from the pi package's
`SessionManager`:
```ts
static forkFrom(sourcePath, targetCwd, sessionDir?, options?): SessionManager
//  New session file with the full history of the source, new id,
//  `parentSession: sourcePath`. The source file is never touched.
```
So `ask_thread(threadId, question)` is, using pi's **native `--fork` CLI flag** (no
need to import `SessionManager` into the server or compute file paths):
1. **Spawn a throwaway `pi --mode rpc` process** with `--fork <target's deterministic
   session id>` + `--session-id <freshUuid>`, run with the **target's `worktreePath`
   as cwd** (so pi resolves the target id within its cwd-keyed session dir). pi forks
   the frozen session (full native context via `buildSessionContext`); the fresh id
   guarantees no aliasing (pi errors if the id already exists — built-in guard). The
   driver already spawns this kind of throwaway for `get_available_models`
   (`PiDriver.ts:222`).
2. **Launch it read-only (decision 7):** **without** the workstream MCP extension or
   any `T3_WORKSTREAM_*` env, so the fork physically cannot dispatch/spawn/mutate
   orchestration, plus a read-only system prompt.
3. **Send one `prompt` RPC** (the question), read the assistant reply, `stop()`,
   delete the fork file.

### Why forking beats stuffing a transcript into a prompt
This is why `ask_thread` is NOT a `TextGeneration`-style "extract → truncate → feed
as context" call:
- **Context sizing is pi's problem.** The fork resumes the target's real context —
  nothing to extract, truncate, or map-reduce.
- **Read-only is structural.** `forkFrom` writes a *separate* throwaway file; the
  target's session is physically untouched and never re-activated. No "don't dispatch
  a command" tightrope.
- **Parallel, unrelated questions don't pollute the target or each other.** Each
  `ask_thread` is an independent fork.

### Feasibility (verified)
- pi has a **native `--fork <id-or-path>` CLI flag** (`forkSessionOrExit` →
  `SessionManager.forkFrom`); `resolveSessionPath` accepts either an exact session id
  or a path. `--fork <targetId>` + `--session-id <freshId>` gives the fork a fresh,
  non-aliasing id (pi errors if the id exists — built-in guard). The server does
  **not** need to import `SessionManager.forkFrom` or compute file paths.
- The target's deterministic per-thread session id is `threadId` sanitized
  (`PiDriver.ts:644`), resolved within the target's cwd-keyed session dir — so the
  throwaway must run with the **target's `worktreePath`** as cwd.
- Throwaway `pi --mode rpc` has precedent (`PiDriver.ts:222`). `createPiRpcProcess`
  (`apps/server/src/provider/Layers/Pi/RpcProcess.ts`) needs a small addition to emit
  `--fork`/`--session-id` (today it emits only `--session-id`).

---

## Resolved decisions
1. **One shared graph module is the foundation.** Discovery, the same-tree auth
   predicate, and the dispatcher join all consume `@t3tools/shared/workstreamGraph`.
   No new bespoke graph walks. (Mirrors the `workstreamDependencies` precedent.)
2. **Auth = same workstream tree (NOT parent-of-only),** implemented via the
   module's `isInSameTree` (same root orchestrator). This supports
   reviewer-asks-sibling-coder. **This is a real change**: the existing
   `authorizationError` (`WorkstreamSpawnHttp.ts:67-83`) is parent-of-target only —
   do not silently reuse it; route the new tools through the same-tree predicate.
   Least-privilege: same tree, never global.
3. **`ask_thread` = frozen-oracle fork, NOT live-resume and NOT `TextGeneration`.**
   Forks a read-only snapshot via pi's `--fork` flag, answers one question in the
   fork, discards it; never resumes/mutates the target; emits no orchestration command.
4. **`ask_thread` is pi-only.** Session forking + one-shot turn is pi-native; all
   workstream threads run under the pi driver. `workstream_list` and `read_thread`
   are driver-agnostic (read model + files only).
5. **Additive, no schema migration.** All three tools read existing data (shell
   snapshot, read-model thread detail, the Stage 1 report file, the target's pi
   session file). `ask_thread` writes only a throwaway fork it then deletes. No new
   events/commands/columns.
6. **`workstream_list` returns structure + state, not a flat list.** It returns the
   `graphViewFor` payload (tree + statuses + generations + waits-on edges) — the
   shape an orchestrator actually reasons over and the same set the auth scope
   covers (you can only `read`/`ask` what `list` shows you).
7. **`ask_thread`'s fork is launched read-only.** "Read-only" is NOT guaranteed by
   forking alone — a forked `pi --mode rpc` turn is a real agent turn with pi's
   default tools (bash/edit). The fork therefore runs **without the workstream MCP
   extension/`T3_WORKSTREAM_*` env** (so it cannot dispatch/spawn/mutate orchestration)
   and with a read-only system prompt. Constraining the fork's bash/edit tool surface
   further is desirable (open decision).

## What to build

### Part A — `@t3tools/shared/workstreamGraph` (the module above)
Plus its subpath export in `packages/shared/package.json`, and refactor
`WorkstreamDispatcher.ts` to import `selectJoinedGenerations`/`isTerminalStatus`
from it (delete the in-file copies). Keep the dispatcher's behavior identical — this
is a pure relocation + reuse, covered by the existing dispatcher tests.

### Tool 1 — `workstream_list()`
- **Returns:** `graphViewFor(callerThreadId, shellSnapshot)` — the caller's
  workstream tree (nodes with `id`, `role`, `title`, `status`, `spawnGeneration`,
  `parentThreadId`, `reportPath` presence) + lineage edges + waits-on edges.
- **Source:** `projectionSnapshotQuery.getShellSnapshot()` (already used by the
  dispatcher). For `reportPath` presence, the shell already carries enough, or join
  the thread detail — keep it cheap.
- **Auth:** the caller is implicitly in its own tree; no target arg. (No 403 path —
  it only ever returns the caller's own tree.)

### Tool 2 — `read_thread(threadId)`
- **Returns:** the target's full report markdown (`readWorkstreamReport`,
  `apps/server/src/orchestration/workstreamReport.ts` ~43) **plus** metadata from
  `getThreadDetailById`: role, title, `status`, `reportPath` presence, and a compact
  recent-activity summary (last assistant message and/or ≤3 activity rows). If no
  report, say so explicitly and still return metadata/last-output (never error-empty).
- **One read-model call:** `getThreadDetailById` returns `OrchestrationThread`
  (`packages/contracts/src/orchestration.ts:366`) already carrying `messages` +
  `activities` + `reportPath` + `role`/`title`/`status`. Do **not** also call
  `ProjectionThreadActivities.listByThreadId` — redundant.
- **Archived targets (verified gap):** `getThreadDetailById` is **active-only**
  (returns `None` → would 404 for an archived/finished thread, the *most likely*
  inspection target). There is **no archived detail query** — `getArchivedShellSnapshot`
  returns shells only (no `messages`/`activities`). **Decision for v1:** accept
  **degraded** metadata for archived targets — return the report markdown (file-based,
  works regardless of archive state) + shell metadata (role/title/status/reportPath)
  from the archived shell, and **omit** the recent-activity summary. Do not add an
  archived detail query this stage (minimal surface). Resolve the target from the
  active detail when present, else the archived shell.
- **Auth:** `isInSameTree(caller, target)` (decision 2). Distinguish 403
  (exists, out-of-tree) from 404 (missing).
- **Output shape:** lean — never dump full `messages[]`.

### Tool 3 — `ask_thread(threadId, question)`
- **Mechanism:** Part B — throwaway `pi --mode rpc` with `--fork <targetId>` +
  `--session-id <freshId>`, run with the **target's `worktreePath` as cwd** (sourced
  from the active detail's `session`, else the archived shell's `worktreePath`,
  fallback `serverConfig.cwd`), **without** the workstream extension/env → one prompt
  → reply → delete fork. Works for archived targets too (the session file persists).
- **Returns:** an answer from the read-only fork, plus an honest "the thread's
  session does not resolve this" escape (mirror the `consult_manager` oracle — don't
  fabricate). Confidence indicator optional.
- **Read-only guarantee (decision 7):** structural — the fork is a separate file and
  carries **no workstream extension**. Verifiable invariants: (a) the target's session
  file is byte-for-byte unchanged, (b) `OrchestrationEngine.dispatch` is never called,
  (c) the fork process is launched without the `T3_WORKSTREAM_*` env/extension.
- **Cost guard:** a question-length cap is enough; forking handles transcript size.
  No quota system. Set a server-side timeout on the throwaway turn; honor the
  extension's abort `signal`; map failures to a clean tool error (not a 500).
- **Auth:** `isInSameTree` (decision 2). **pi-only** (decision 4).

### Wiring (mirror the existing 4 workstream tools)
- **MCP tool registration:** add `workstream_list` + `workstream_read_thread` +
  `workstream_ask_thread` to `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts`
  — same `callWorkstreamEndpoint` + `T3_WORKSTREAM_*_URL` + `T3_WORKSTREAM_AUTHORIZATION`
  pattern as `workstream_report`.
- **HTTP handlers:** add three routes in `apps/server/src/mcp/WorkstreamSpawnHttp.ts`
  beside the report handler (new path consts; `resolveWorkstreamScope` → same-tree
  predicate (for read/ask) → work → JSON). Export the matching
  `workstream*UrlFromMcpEndpoint` helpers. The shared `authorizationError` message
  (`WorkstreamSpawnHttp.ts:67-83`) is status/deps-specific; generalize it or pass a
  contextual message for the read tools.
- **Env wiring:** add the three `T3_WORKSTREAM_*_URL` vars in **`PiDriver.ts`**
  (correct path: `apps/server/src/provider/Drivers/PiDriver.ts`, the
  `withLocalNodeModulesBin(...)` mcpSession env block ~652-668) alongside
  `T3_WORKSTREAM_REPORT_URL`.
- **Prompt guidance:** update `PI_WORKSTREAM_SYSTEM_PROMPT` (`PiDriver.ts:83`) to
  teach the discovery→read→ask flow: list your workstream to find a thread, pull its
  report (`read_thread`), or ask it a read-only question (`ask_thread`).

## Open decisions for the implementing thread
- **`ask_thread` fork plumbing (mostly resolved):** use pi's native `--fork
  <targetId>` + `--session-id <freshId>` (built-in aliasing guard); extend
  `createPiRpcProcess` to emit them. Verify during impl: (a) `--mode rpc` + `--fork`
  + `--session-id` don't trip pi's CLI conflict checks, (b) the throwaway runs with
  the target's `worktreePath` cwd so id-resolution finds the session. Handle
  "session not found" (target never took a turn) cleanly.
- **`ask_thread` fork tool surface (decision 7 + how far to go):** no workstream
  extension is required (hard guarantee). Decide whether to *also* constrain the
  fork's bash/edit tools (true read-only) vs. rely on a read-only system prompt.
  Prefer the strongest restriction pi supports.
- **`isInSameTree` scope:** same-root is recommended (covers siblings, ancestors,
  descendants, cousins within one orchestration tree). Confirm this is the intended
  boundary vs. a tighter siblings+descendants-only rule; must include siblings.
- **Archived nodes in `list`:** decide whether `list` includes archived/finished
  threads in the tree view (recommend yes — they're the inspection targets) using
  `getArchivedShellSnapshot` alongside the active snapshot. (`read_thread`'s archived
  contract is resolved above: degraded report+shell metadata.)
- **Honesty contract for `ask_thread`:** confirm the "fork doesn't resolve this"
  escape; confidence indicator optional.

## Out of scope
- An archived **detail** read-model query (messages/activities for archived threads)
  — `read_thread` accepts degraded report+shell metadata for archived targets instead.
- Migrating the **web** `WorkstreamPanel` onto the shared module (optional
  follow-up; this stage only requires server consumers + the dispatcher).
- Live-resume of a thread (frozen-oracle fork only — decision 3).
- `ask_thread` on non-pi drivers (decision 4).
- D-liveness itself (separate signed doc) — but sequence this **before** its
  investigator.
- Any change to Stage 1's report storage/wake (already merged).

## Acceptance
- **Shared module:** `@t3tools/shared/workstreamGraph` exists with pure structural +
  membership + generation primitives; `WorkstreamDispatcher` imports
  `selectJoinedGenerations`/`isTerminalStatus` from it (private copies deleted).
  **Behavior preserved**, but the pure-fn tests **relocate** to
  `packages/shared/src/workstreamGraph.test.ts` and `WorkstreamDispatcher.test.ts`'s
  direct imports (`:11-19`) are repointed/removed — **no re-export shim** in the
  dispatcher (AGENTS.md).
- **`workstream_list`:** a thread calls it and gets its workstream tree (structure +
  state) including sibling ids/roles/statuses — enough to then target `read`/`ask`
  without hunting for an id.
- **`read_thread`:** returns report + metadata **without filesystem access**; an
  out-of-tree credential is rejected (403); a no-report target still returns
  metadata/last-output (never empty); an **archived/finished** target is still
  readable (degraded: report + shell metadata, recent-activity summary omitted — not
  an error).
- **`ask_thread`:** a thread — including a **sibling** (reviewer→coder) — gets an
  answer from a read-only **fork** of the target's pi session. Verified read-only:
  the target's session file is byte-for-byte unchanged, the target's pi process is
  not resumed, no orchestration command is emitted, and the fork process carries no
  `T3_WORKSTREAM_*` env/extension.
- All tools appear in the pi tool surface with correct env wiring; the system prompt
  teaches the discovery→read→ask flow.
- `vp check` + `vp run typecheck` + server suite green. Cover with focused
  pure-seam/HTTP-handler tests under the canonical `vp` runner: the module's
  `isInSameTree` + structural queries; the **same-tree auth rule** (403 out-of-tree,
  200 sibling/child, 404 missing); the **read-only guarantee** (inject a recording
  `OrchestrationEngineService`, assert `dispatch` never called, assert the source
  session file is unchanged, assert the fork carries no workstream extension). (New
  engine-backed Effect tests are infeasible per the tracked infra gap in
  `provider-intent-startup-reconciliation-design.md`.)
- **Note (not a deterministic test):** "unanswerable → honest not-resolved, not
  fabrication" is LLM-behavioral; validate in the live run, don't list as unit-checkable.
- **Verify with a live pi run** if a server is available: spawn two siblings (a
  coder that files a report and a reviewer); from the reviewer call `workstream_list`
  → `read_thread` → `ask_thread` against the coder and confirm real answers; repeat
  from the parent.

## References
- **Shared-module precedent:** `@t3tools/shared/workstreamDependencies`
  (`packages/shared/src/workstreamDependencies.ts` — minimal node shape both
  `OrchestrationThread` and `OrchestrationThreadShell` satisfy; one pure
  source-of-truth predicate consumed by decider + dispatcher).
- **Graph node + snapshot:** `OrchestrationThreadShell`
  (`packages/contracts/src/orchestration.ts:507`);
  `projectionSnapshotQuery.getShellSnapshot()` (the snapshot source, used at
  `WorkstreamDispatcher.ts:307`).
- **Existing graph walkers being consolidated/relieved:** `selectJoinedGenerations` /
  `isTerminalStatus` (`WorkstreamDispatcher.ts:84`); web
  `groupChildrenByColumn` + edges (`apps/web/src/components/WorkstreamPanel.tsx:220`).
- **Mechanism / oracle pattern:** `consult_manager` (frozen read-only snapshot Q&A);
  the `seek-manager-guidance` skill describes the policy.
- **Session forking:** pi's native `--fork <id-or-path>` CLI flag (`forkSessionOrExit`
  → `SessionManager.forkFrom`, `resolveSessionPath`); `buildSessionContext`.
- **Throwaway `pi --mode rpc` + per-thread session id:** `PiDriver.ts:222`,
  `PiDriver.ts:644`, `createPiRpcProcess` (`apps/server/src/provider/Layers/Pi/RpcProcess.ts`,
  emits `--session-id` today; add `--fork`).
- **Archived read-model:** `getArchivedShellSnapshot` (shells only; no archived
  detail query — drives the degraded-metadata decision).
- **Stage 1 primitives:** `apps/server/src/orchestration/workstreamReport.ts`
  (`readWorkstreamReport`), `apps/server/src/config.ts` (~89 `workstreamReportsDir`).
- **Tool/handler/env pattern to mirror:** `WorkstreamSpawnExtension.ts` (tool
  registry, `callWorkstreamEndpoint`, `T3_WORKSTREAM_*_URL`), `WorkstreamSpawnHttp.ts`
  (`resolveWorkstreamScope`, `authorizationError` @67-83, the report route),
  `PiDriver.ts` (`T3_WORKSTREAM_*_URL` env block ~652-668 + `PI_WORKSTREAM_SYSTEM_PROMPT`
  @83).
- **Read-model context:** `ProjectionSnapshotQuery.getThreadDetailById` →
  `OrchestrationThread` (`orchestration.ts:366`, carries `messages` + `activities`).
