# Personal pi-only goal-centric frontend

## Goal
A personal, single-user web frontend for the pi coding agent, forked from T3 Code,
talking to pi over its RPC wire. Organize work as Project -> Goal -> Session so the
north-star intent and progress stay visible and navigable across many sessions.

## Tasks
- [x] Phase 0: fork, build, pi-only registration
- [x] Phase 1: pi over RPC end-to-end
  - [x] PiDriver + RPC transport
  - [x] real-pi e2e verification
- [ ] Phase 2: goal aggregate + 3-tier navigation
  - [x] goal aggregate (contracts/decider/projector/migration)
  - [ ] worktree ownership relocation
  - [ ] sidebar goal tier
- [ ] Phase 3: goal package files + spine
  - [x] goal.md discovery + parser
  - [ ] diff view
