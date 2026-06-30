---
manager_sessions:
  - id: a9023a84-f38c-4c51-99e5-3b15063730c3
    role: plan
    authored_at: 2026-06-30T06:12:08.967Z
---

# Thread self-retitle tool

## Problem

A thread's sidebar title is set in only two ways today, neither agent-driven: the
orchestrator supplies a `title` at `workstream_spawn` (fixed at creation), and the web
composer auto-titles a server thread from its first message (`ChatView.tsx`,
`isFirstMessage && isServerThread`, via `thread.meta.update`). A *running* thread cannot
rename itself — a root stuck with an unhelpful auto-from-first-message title, or a child
whose scope has sharpened, has no way to fix its own sidebar label. The underlying
`thread.meta.update` command already supports a `title`; it is simply not exposed as a
tool. (`goal_update` renames the *goal*, not the thread — a common conflation.)

## Direction

A first-party pi tool — **`set_thread_title`** — that renames the **calling thread's own**
title, scoped to the caller thread via the injected credential, dispatching the existing
`thread.meta.update` command. Mirrors the Phase A goal-tool pattern
(`.plans/goal-task-tool-phase-a.md`): injected URL + reused `T3_WORKSTREAM_AUTHORIZATION`,
caller-thread scope resolution, structured I/O, legible as a tool-call event.

## Decisions (locked)

1. **Own-thread only.** The agent passes no thread id; the server resolves the caller
   thread from the credential and updates *that* thread's title. Renaming an arbitrary
   thread is structurally impossible. A child sharpens its own title; an orchestrator names
   children at spawn (and can still rename itself). No "rename a child" capability in this
   tool.
2. **One param:** `title` — a required, non-empty, trimmed string (mirror `goal_update`'s
   title validation; reject empty/blank with a clean 400).
3. **Backing command:** dispatch the existing `thread.meta.update` (`title` field) through
   the engine/decider. No new command, no shared-builder needed (there is no CLI
   counterpart to dedupe against; dispatch inline, matching how the workstream tools
   dispatch `thread.*` commands directly).
4. **Injection:** into every agent session, gated on `mcpSession`, reusing
   `T3_WORKSTREAM_AUTHORIZATION` and the same caller-thread scope resolver as the goal
   tools. Add one env URL in `PiDriver.ts` the same way.
5. **Light prompt guidance** (principle, not directive): note in the role overlays that a
   thread may set its own title to keep the sidebar legible — e.g. when a root's
   auto-from-first-message title is unhelpful, or a child's scope clarifies. Keep it brief
   and principle-based, consistent with the existing overlay style.

## Implementation shape (mirror Phase A, strip what doesn't apply)

- HTTP handler mirroring `apps/server/src/mcp/GoalTaskHttp.ts`'s caller-thread resolution
  (`resolveWorkstreamScope` / `resolveActiveMcpCredential`); no goal lookup needed — just
  resolve the caller thread id and dispatch `thread.meta.update { threadId, title }`.
- Register the `set_thread_title` tool (placement: alongside the existing thread/workstream
  tools is most natural since it is a thread-node operation, but the coder may choose the
  cleanest home — a new small handler/extension or an existing one — so long as it does not
  bloat surface).
- Inject the new URL in `PiDriver.ts` gated on `mcpSession`.
- Update the role overlays per Decision 5.

## Non-goals
- No renaming of other threads / children.
- No change to the auto-title-from-first-message behaviour (the tool just lets a later
  rename win, which it does naturally since auto-title only fires on the first message).
- No goal/slug changes (that's `goal_update`).

## Constraints / definition of done
- One source of truth: reuse `thread.meta.update`; no parallel mutation path.
- No backward-compat shims (prototype).
- Gates: `vp run typecheck` and `vp check` must pass.
- Verify for real if possible: an agent session calls `set_thread_title("…")` and the
  sidebar title updates (DB + UI). If the live round trip needs a server restart the agent
  can't safely do, say so explicitly rather than substituting a synthetic smoke test.
- Do NOT commit/ship until the human approves.
