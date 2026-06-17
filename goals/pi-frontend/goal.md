# Personal pi-only goal-centric frontend

## Goal
A personal, single-user web frontend for the pi coding agent, forked from T3 Code, talking to pi over its RPC wire. Organize work as Project → Goal → Session so the north-star intent and progress stay visible and navigable across many sessions. Goals are file-based (`goals/<slug>/goal.md`) and the agent keeps the task list current as work proceeds.

## Tasks
- [x] Phase 0 — fork, build, pi-only provider registration
- [x] Curated model picker (Opus 4.8 Vertex default; openai-codex/gpt-5.5; gemini-3.1-pro-preview)
- [x] Phase 1 — pi over RPC, verified end-to-end
- [x] Phase 2 — file-centric backend (remove DB goal aggregate; goalSlug; GoalsService; GET /api/goals)
- [x] Phase 3 — goal UI
  - [x] sidebar Project → Goal → Session (mixed tree)
  - [x] create-goal-from-session / assign / clear
  - [x] goal overview (paragraph + task tree + progress)
  - [x] @pierre/diffs HEAD diff
- [x] Sidebar expand/collapse fixes
  - [x] goal-node caret toggles its sessions (per-goal collapse keyed by slug)
  - [x] project caret collapses the goal subtree
- [x] Dot-only slug guard (POST /api/goals)
- [x] Agent-participation layer (goal context injected once per session via pi `--append-system-prompt`)
- [x] Goal-UI redesign (header goal section; Tasks right-panel surface; new-session-under-a-goal; shared goalIndex + hoisted TaskTree)
- [ ] **BUG (reliability): PiDriver has no session resume** — one UI thread silently rebinds to fresh, *parentless* pi sessions after any server restart (`node --watch` restarts on `apps/server` edits) or dropped/aged WS connection; the UI replays the persisted thread events so it *looks* continuous, but the live pi process has zero memory of prior turns. Diagnosed 2026-06-17. Fix: capture + persist pi's session file per thread and pass `--session <file>` on (re)start, mirroring `CodexSessionRuntime`'s resume-cursor pattern (the pi RPC layer already supports `--session`; `RpcProcess.ts:216`).
- [ ] Subagent launches from a pi-backed thread should be dispatched `async` — a foreground worker blocks the UI turn and a `--watch` restart orphans it mid-launch (the `gpt55-worker` left an empty run dir; UI froze on "Working 30:00").
- [ ] Verify agent maintains goal.md on a real task
- [x] Self-hosted dogfood: develop this tool inside the tool (in progress — this session runs inside it)
- [x] Fix Tasks-panel checkbox rendering: `[ ]` marker wraps/splits across lines (needs `shrink-0 whitespace-nowrap`)
- [ ] Explore: surface subagent progress in the UI (scout/subagent runs show only "Working for Ns" with no streaming feedback) — not urgent
- [ ] Backlog: per-session diff baseline; Tailscale remote; dedicated goal route; stale-test cleanup
- [ ] Optional polish: persist per-goal collapse state to uiStateStore (currently in-memory useState)
