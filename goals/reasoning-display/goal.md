# Reasoning (thinking) trace display

## Goal

Surface model reasoning/thinking traces in the web chat as an inline collapsible
block above each assistant answer (Option A), controlled by a tri-state
`reasoningDisplay` setting (`off` / `collapsed` / `expanded`). Reasoning is
currently emitted by every driver as `content.delta { streamKind: "reasoning_text" }`
but dropped at the ingestion layer; this goal wires it through ingestion →
orchestration contract → projector → web, mirroring the existing assistant-text
pipeline. Affects all providers (Codex/Claude/Pi-Opus 4.8) uniformly.

See `plan.md` for the detailed scope.

## Tasks

- [x] Contract: `reasoningText`/`reasoningStreaming` on `OrchestrationMessage` + reasoning commands & `thread.message-reasoning` event
- [x] Contract: `reasoningDisplay` tri-state in `ClientSettingsSchema` + `ClientSettingsPatch`
- [x] Ingestion: consume `reasoning_text`/`reasoning_summary_text` deltas → dispatch reasoning delta/complete
- [x] Decider: reasoning commands → `thread.message-reasoning` event
- [x] Projector: accumulate reasoning onto the turn's assistant message
- [x] Persistence (scope addition): migration 034 + projection layer so reasoning survives reload
- [x] Web: `ReasoningBlock` in `MessagesTimeline` gated by `reasoningDisplay`
- [x] Web: tri-state setting control in `SettingsPanels`
- [x] Critical review pass (`review.md`) — verdict keep-with-fixes
- [x] Fix #2 (reasoning delta coalescing, perf) + #4 (cache cleanup)
- [x] `vp run typecheck` green (independently verified, 15/15)
- [ ] Decide buffered-vs-always-stream for reasoning (review #3) — awaiting user
- [ ] Live run against Opus 4.8 / GPT 5.5 (canonical entrypoint — needs running server + creds)
