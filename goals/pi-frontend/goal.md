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
- [ ] Sidebar expand/collapse fixes
  - [ ] goal-node caret toggles its sessions
  - [ ] project caret collapses the goal subtree
- [ ] Dot-only slug guard (POST /api/goals)
- [ ] Agent-participation layer (inject active goal + task-maintenance rule into session seed)
- [ ] Verify agent maintains goal.md on a real task
- [ ] Self-hosted dogfood: develop this tool inside the tool
- [ ] Backlog: per-session diff baseline; Tailscale remote; dedicated goal route; stale-test cleanup
