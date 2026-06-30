---
manager_sessions:
  - id: a9023a84-f38c-4c51-99e5-3b15063730c3
    role: plan
    authored_at: 2026-06-30T02:09:13.988Z
---

# Agent-driven goal handoff — Phase B (spawn a new goal + staged root session)

## Problem / motivation

While working a goal, an agent (or the human) often discovers a separate, out-of-scope
piece of work that deserves its own goal and its own concurrently-running session — e.g.
"this needs a follow-up migration" surfaced mid-task. Today that handoff is manual and
lossy: the human reads a suggestion, presses cmd+N, names a goal, picks a branch, and
pastes a kickoff prompt. Phase B lets an agent do that setup directly, so the human only
launches it.

This is the follow-on to Phase A (`.plans/goal-task-tool-phase-a.md`, shipped), which made
an *existing* goal's task tree mutable from agent sessions. Phase B is about **creating** a
new goal + a root session pre-loaded with a handoff brief.

## Direction (decided with the human)

A first-party pi tool — call it **`goal_handoff`** — that, scoped to the caller thread,
creates a **new goal** and a **staged (held) root session** pre-loaded with a handoff
brief, then leaves it for the human to launch. The tool does the tedious setup; the human
provides the one human-in-the-loop glance by hitting send. Mirrors the Phase A
tooling/auth pattern (injected URL + reused `T3_WORKSTREAM_AUTHORIZATION` credential,
caller-thread scope, shared decider commands — no parallel mutation path).

## Decisions (locked)

1. **Staged, not autostart.** The tool does NOT boot the agent. It creates the goal + a
   parent-less thread held at `planLane: planned`, carrying the brief. The human opens it
   and sends the first message to launch it. Rationale: the `WorkstreamDispatcher`
   deliberately refuses to autostart root threads (`parentThreadId === null`;
   `WorkstreamDispatcher.ts:63`), so autostart would force the tool to re-implement the
   kickoff/worktree bootstrap headlessly — far more code and a new no-human-in-the-loop
   failure surface. Staged is both simpler and the safer default. (Easy to revisit toward
   autostart later if the launch step proves annoying.)
2. **Fresh worktree, provisioned by the existing bootstrap on first send — NOT by the
   tool.** The handed-off work is independent and meant to run concurrently with the
   creating session, so it needs its own worktree/branch. We get this for free: the tool
   creates the thread **with no worktree, in worktree env-mode**; when the human sends the
   first message, the existing composer bootstrap path fires `prepareWorktree`
   (`git worktree add` + branch + setup script) + kickoff. This path is gated on
   `isFirstMessage && sendEnvMode === "worktree" && !worktreePath` (`ChatView.tsx:3747`) —
   NOT on the thread being a client draft — so a tool-created server thread routes through
   it. The tool therefore does **no** filesystem/git work and needs **no** bootstrap
   refactor.
3. **No provenance.** The new goal is intentionally detached — no `createdBy` /
   `originThreadId` recorded. (Considered and explicitly declined; revisit only if
   goal-spawns-goal legibility later proves needed.)

## Implementation shape

Two parts:

### A. Server tool (`goal_handoff`) — mirror Phase A's pattern
- New extension (mirror `apps/server/src/provider/Drivers/Pi/GoalTaskExtension.ts`) +
  HTTP route (mirror `apps/server/src/mcp/GoalTaskHttp.ts`); inject one more URL in
  `PiDriver.ts` gated on `mcpSession`, reusing the same caller-thread credential
  (`resolveWorkstreamScope` / `resolveActiveMcpCredential`).
- Resolve the caller thread from the credential; read its `projectId` (the new goal
  inherits the caller's project). The agent passes **no goalId/projectId**.
- Tool parameters (agent-supplied): a goal **title**, a **brief** (the handoff/kickoff
  prompt that becomes the session's first turn), and optionally a short goal
  **description**. Slug is **derived from the title** server-side (reuse the same slugify
  as the UI: `toLowerCase().replace(/[^a-z0-9._-]+/g, "-")`); on the decider's
  per-project uniqueness rejection (`requireUniqueGoalSlug`, `decider.ts:240`),
  auto-suffix and retry (e.g. `-2`, `-3`) rather than failing back to the agent.
- Dispatch, through the SAME engine/decider commands the CLI/UI use (one source of truth —
  extend the shared builders from Phase A's `orchestration/goalTaskCommands.ts` rather than
  inlining new command literals):
  1. `goal.create` — new `goalId`, caller's `projectId`, derived `slug`, `title`,
     optional `description`.
  2. `thread.create` — `goalId` = the new goal, `parentThreadId = null`,
     `planLane: planned`, **no worktree** (`worktreePath`/`branch` null), **worktree
     env-mode** (set whatever field makes the composer default to `sendEnvMode === "worktree"`
     on launch), model/runtime inherited from the caller, and the **brief** stored on the
     thread (`brief`/`purpose`).
- Return the created `goalId` + `threadId` so the result is legible.

### B. One UI touch — seed the composer from the staged brief
Nothing currently pre-fills the composer text from a thread's stored brief. Without this,
the human opens the staged thread to an empty composer and must paste the prompt — which
defeats the feature. Add a small change so that opening a **not-yet-launched** thread
(no messages) that carries a handoff brief **seeds the composer** with that brief, so
launching is one send (confirm/pick base branch → send). Keep it minimal; do not change
the bootstrap/launch path itself.

## Things to verify early (contract, not yet confirmed in code)
- That `thread.create`'s `brief`/`purpose` reaches the web read model so the UI can seed
  the composer from it. If a field is missing from the projection, wiring it is part of
  this work.
- The exact field/mechanism that makes a freshly-created server thread come up in worktree
  env-mode (so `sendEnvMode === "worktree"` on first send) without a worktree already set.
Pin these two before building the UI touch; they are the load-bearing assumptions.

## Constraints / definition of done
- Reliability-first; one source of truth (share the decider command path with the CLI/UI —
  extend `goalTaskCommands.ts`; no second mutation path).
- No backward-compat shims (prototype — clean break).
- Gates: `vp run typecheck` and `vp check` must pass.
- **Verify for real**, not just typecheck: with the server running, an agent session calls
  `goal_handoff` → a new goal + a staged root session appear in the UI with the brief
  pre-seeded in the composer; sending it provisions a fresh worktree and the agent kicks
  off on the brief. If a real end-to-end run needs a server restart the agent can't safely
  do, say so explicitly rather than substituting a synthetic smoke test.
- Do NOT commit/ship until the human approves.
