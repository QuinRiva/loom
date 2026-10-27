---
manager_sessions:
  - id: a9023a84-f38c-4c51-99e5-3b15063730c3
    role: plan
    authored_at: 2026-06-30T00:43:22.399Z
---

# Goal/Task mutation as pi tools — Phase A (keep the tree honest)

## Problem

Every workstream agent is instructed (via the orchestrator overlay and the injected
active-goal context) to keep the goal's task tree current using the `t3 goal task …` /
`t3 goal update` CLI. But `t3` is **unreachable** in agent worktree sessions: its bin is
`apps/server/package.json → "t3": "./dist/bin.mjs"`, `dist` is not built in dev, and there
is no `node_modules/.bin/t3` to expose on PATH (verified live: `node_modules/.bin` *is* on
the agent PATH, but no `t3` is linked there). Goals are DB/event-sourced, so there is no
file fallback. Net: a core legibility capability is inert — instructed but impossible.

## Direction (decided with the human)

Expose goal/task mutation as **first-party pi tools** backed by a T3 server HTTP endpoint,
injected into agent sessions via env URL + the pi extension — no PATH/build dependency,
always present in every worktree, per-thread scoped/authorised, structured I/O, legible as
tool-call events. The **human-facing `t3 goal …` CLI stays**; both the CLI and the new
tools dispatch the **same** `goal.*` orchestration commands through the engine/decider —
one source of truth, no duplicated command-building, no second decider path.

This is **Phase A** (keep the tree honest). Phase B (agent-driven handoff: `goal.create` +
provisioning a new root session) is a separate later effort and is **out of scope here**.

## Decisions (locked)

1. **Scope (Phase A):** task add / mark-done / reopen / rename / delete, plus goal **meta
   update** (title + description + slug), all on the agent's **own** goal. Task-delete is
   **in**. Goal create / archive / delete are **out** (human-only via CLI/UI). **Reparent
   is out** — `goal.task.update` deliberately has no `parentTaskId` (MVP cycle-avoidance
   constraint in `packages/contracts/src/orchestration.ts`); do not add a parallel path.
2. **Granularity:** four thin tools mapping 1:1 onto the existing decider commands:
   - `goal_task_add` → `goal.task.create` (text, optional parentTaskId, optional position)
   - `goal_task_update` → `goal.task.update` (optional text / done / position) — covers
     rename, mark-done, reopen, reorder
   - `goal_task_delete` → `goal.task.delete` (taskId)
   - `goal_update` → `goal.meta.update` (optional title / description / slug)
   This matches the `goal.task.*` command grain and the purpose-named style of the existing
   `workstream_*` tools (distinct tools, not one op-switch mega-tool).
3. **Auth / scope:** mirror the workstream tools exactly. The agent passes **no `goalId`**.
   The server resolves the **caller thread** from the injected per-session credential
   (same mechanism as `T3_WORKSTREAM_AUTHORIZATION`), reads that thread's `goalId`, and
   applies the mutation there. Consequences: acting on an arbitrary goal is structurally
   impossible (not merely validated); a thread with **no** `goalId` gets a clean
   "no active goal" error; **any** goal-attached thread — children included — may mutate
   the tree (no hard root-only check). `taskId`s are still passed by the agent for
   update/delete (scoped to the resolved goal; reject ids that don't belong to it).
4. **Injection + prompt guidance:**
   - Inject the new tool URL(s) + reuse the workstream credential into **every** agent
     session, gated on `mcpSession`, exactly like the `T3_WORKSTREAM_*_URL` env vars in
     `PiDriver`. Register the extension the same way as the workstream spawn extension.
   - **Orchestrator overlay** (`roles/orchestrator.md`): keep "you own / drive the task
     tree" as the primary steer, but point it at the **new tools** instead of the dead
     `t3 …` CLI.
   - **Child overlays** (`coder` / `reviewer` / `researcher`): principle, not directive —
     a child may update the status of its **own** assigned task, and if it **discovers
     actionable work outside its scope** it should add it to the tree directly (e.g.
     "evaluate whether to fix pre-existing bug X") rather than relying solely on its report
     (fewer points of failure). The orchestrator is the owner; children are **not
     precluded**.
   - Keep all prompt text principle-based, not absolute directives.

## Reference pattern to MIRROR (take the skeleton, strip what doesn't transfer)

- `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts` — how a pi tool is
  registered (name / description / promptSnippet / promptGuidelines / parameters /
  execute); `execute()` calls a T3 HTTP endpoint with the injected auth header.
- `apps/server/src/mcp/WorkstreamSpawnHttp.ts` — HTTP handlers/routes,
  `resolveWorkstreamScope()` (per-thread credential → caller thread), command dispatch
  through the engine, and the `*UrlFromMcpEndpoint` helpers.
- `apps/server/src/provider/Drivers/PiDriver.ts` — injects `T3_WORKSTREAM_*_URL` +
  `T3_WORKSTREAM_AUTHORIZATION` (gated on `mcpSession`) and registers the extension.

**Do NOT** copy the workstream scope machinery wholesale. Goal-task scoping is simpler
(caller thread → its `goalId`), not full tree-membership. Take the credential/auth +
endpoint + env-injection skeleton; leave the graph/tree-membership logic behind.

## Reuse the existing command path (one source of truth)

Commands already exist in `packages/contracts/src/orchestration.ts`: `GoalTaskCreateCommand`
(`goal.task.create`), `GoalTaskUpdateCommand` (`goal.task.update`), `GoalTaskDeleteCommand`
(`goal.task.delete`), `GoalMetaUpdateCommand` (`goal.meta.update`). They are dispatched
today by the CLI in `apps/server/src/cli/goal.ts` and handled in
`apps/server/src/orchestration/decider.ts`. The new endpoint must dispatch these **same**
commands. If the CLI builds these commands inline, refactor the command-building into a
shared helper both the CLI and the HTTP endpoint call, rather than duplicating it.

## Downstream updates

- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` —
  `activeGoalContextInstruction` currently emits the `t3 goal task …` CLI block to agents
  (lines ~132-137). Update the **agent-facing** text to name the new tools. (The CLI may
  stay documented for humans, but agents must be pointed at the tools.)
- `roles/orchestrator.md` and the child overlays — per Decision 4.

## Constraints / definition of done

- Reliability-first (this exists because CLI-on-PATH is unreliable across worktrees).
- One source of truth: share the decider command path with the CLI; no second mutation path.
- No backward-compat shims (prototype — clean break).
- Gates: `vp run typecheck` and `vp check` must pass.
- **Verify for real**, not just typecheck: with the server running, confirm an agent session
  can `goal_task_add` then `goal_task_update`(done) and the change lands in the goal task
  tree (DB) and renders in the UI. If a real end-to-end run needs resources you lack, say so
  explicitly rather than substituting a synthetic smoke test.
