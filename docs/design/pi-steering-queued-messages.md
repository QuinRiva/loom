---
manager_sessions:
  - id: 94f85e64-6c6f-4660-8b30-0e5fe7b0cf51
    role: plan
    authored_at: 2026-06-24T12:20:49.578Z
---

# Pi steering + queued-messages UI

## Problem

Sending a message to a Pi thread while the agent is mid-turn fails with:

> Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.

The error originates in **pi itself** (`agent-session.js`, `prompt()`): when `isStreaming` is
true and no `streamingBehavior` is supplied, pi throws rather than guessing. T3's `PiDriver.sendTurn`
always sends a bare `{ type: "prompt", message }` and never sets `streamingBehavior`, so every
mid-turn send is rejected. The web composer (`ChatView.onSend`) deliberately does **not** block while
`phase === "running"`, so users hit this routinely.

The other adapters already handle mid-turn sends, but with different semantics:

- **ClaudeAdapter** treats a mid-turn `sendTurn` as a **steer** — the message folds into the live
  agent loop and continues the _same_ turn (no new turn boundary).
- **Codex** routes each `sendTurn` to the app-server, which queues it as a new turn (followUp-like).

Pi exposes both modes (`streamingBehavior: "steer" | "followUp"`) and forces the caller to choose.

## Decisions

1. **Default Pi mid-turn sends to `steer`**, matching the Claude adapter so cross-provider behavior is
   consistent and "send while working" means "land now", not "after the turn".
2. **Surface pending queued messages in the web UI.** Pi emits `queue_update` events
   (`{ type: "queue_update", steering: string[], followUp: string[] }`) whenever a queue changes,
   including draining to empty as messages are delivered. T3 currently ignores these. We will thread
   them through to the UI so the user can see what is queued.
3. **Future (out of scope):** let the user _choose_ steer vs followUp per message (e.g. a composer
   toggle / modifier). The plumbing below carries both `steering` and `followUp` queues precisely so
   this is a UI-only addition later. Tracked here as a deliberate future enhancement, not built now.

## Architecture / data flow

Live session state reaches the client as `OrchestrationSession` on `thread.session`:

```
PiDriver (stdout events)
  -> ProviderRuntimeEvent on the events queue
  -> ProviderRuntimeIngestion  (translates to orchestration `thread.session.set` commands)
  -> projector.ts              (in-memory projection: stores full session on thread.session, pushed to client)
  -> store.ts mapSession()     (contract OrchestrationSession -> web ThreadSession)
  -> ChatView                  (renders)
```

`OrchestrationSession` is **not** persisted with queue data (the write-side
`projectionThreadSessionRepository.upsert` has a fixed column list we are _not_ extending). Queued
messages are ephemeral live state only; on reconnect/hydration they default to empty, which is correct
(a stale queue should not survive a reconnect).

## Implementation outline

### Core steer fix (server)

`apps/server/src/provider/Drivers/PiDriver.ts` — `sendTurn`:

- When the session already has an active turn (`session.activeTurnId !== undefined`), this is a
  **steer**: send `{ type: "prompt", message, ...images, streamingBehavior: "steer" }` and do **not**
  mint a new turn id / push a new turn / overwrite `activeTurnId` — the steered message continues the
  running turn (mirror ClaudeAdapter).
- Otherwise (no active turn): today's path unchanged (new turn, no `streamingBehavior`).
- Add a short comment noting the future steer/followUp user-choice option (see Decision 3).

Pi's `prompt` RPC acks quickly via its `preflightResult` callback (not at turn end), so the existing
`request(...)` call stays correct and non-blocking.

### Queued-messages plumbing

- **contracts/providerRuntime.ts**: new event `thread.queue.updated` with payload
  `{ steering: string[]; followUp: string[] }`; add to the type-literal list and the
  `ProviderRuntimeEventV2` union.
- **contracts/orchestration.ts**: add `queuedMessages: { steering: string[]; followUp: string[] }` to
  `OrchestrationSession`, **optional with a decoding default of empty arrays** (so DB-hydrated sessions
  that lack the field decode cleanly).
- **PiDriver.ts** `handleMessage`: add `case "queue_update"` -> emit `thread.queue.updated` with the
  event's `steering`/`followUp` arrays (default to `[]`).
- **ProviderRuntimeIngestion.ts**: handle `thread.queue.updated` -> dispatch `thread.session.set`
  preserving the current session's status/activeTurnId/providerName/runtimeMode/lastError and setting
  `queuedMessages` from the event. Existing lifecycle `thread.session.set` paths must carry
  `queuedMessages` forward from `thread.session?.queuedMessages`, and clear it to empty when the
  session leaves "running" (turn end), since the queue is drained by then.
- **projector.ts / ProjectionPipeline.ts**: store the whole session as today (the new field rides
  along via the schema). Do **not** add it to the persisted session repository.
- **web types.ts / store.ts**: add `queuedMessages` to `ThreadSession`; map it in `mapSession()`;
  include it in the session-equality comparison used for memoization.
- **web ChatView**: render pending queued messages (steering queue) near the composer as lightweight
  ephemeral chips/rows; they disappear as the queue drains. Keep it simple and predictable.

## Follow-up bug: steer detection missed multi-turn (tool-using) runs

The first cut keyed steer detection on `session.activeTurnId`, but pi's agent loop
(`@earendil-works/pi-agent-core/dist/agent-loop.js`) emits **many** `turn_start`/`turn_end`
pairs per agent run — one per model round / tool-call batch — while `isStreaming` stays true for the
whole `agent_start → agent_end` span. PiDriver's `turn_end` handler cleared `activeTurnId`, set the
session to `ready`, and emitted `turn.completed`. So after the first tool call, `activeTurnId` went
undefined mid-run: a message sent during tool execution / later turns took the no-steer path, sent a
bare prompt, and pi rejected it ("Agent is already processing"). It only worked if you sent during the
_first_ turn before any tool call — hence "works sometimes".

**Root cause:** the T3 "turn" was mapped to pi's _internal_ turn, but the correct unit is pi's whole
agent run. Fix — map the T3 turn lifecycle to `agent_start → agent_end`:

- `activeTurnId` (set by `sendTurn`) persists for the whole agent run; it is cleared only at
  `agent_end`. Steer detection (`activeTurnId !== undefined`) is then accurate for the entire run.
- Exactly one `turn.started` per run (at `agent_start`, carrying the active turnId) and exactly one
  `turn.completed` per run (at `agent_end`, settling status to `ready` and clearing `activeTurnId`).
  Do not re-emit `turn.started` per sub-turn — that would re-trigger the proposed-plan-acceptance path
  in `ProviderRuntimeIngestion`.
- pi's internal `turn_start` becomes a no-op; `turn_end` must NOT end the T3 turn / clear
  `activeTurnId` / set `ready`. Per-message completion is already handled by `message_end`
  (`item.completed`) and reasoning display by `pauseReasoningForMessage` (first answer delta), so the
  durable reasoning/message finalization driven by `turn.completed` at `agent_end` covers every
  assistant message in the run (they share the turnId). Verify no intermediate reasoning block sticks
  on "Thinking…"; if a reasoning-only-before-tool-call sub-turn would stick, finalize reasoning at the
  message boundary without ending the T3 turn.
- Abort/interrupt: pi emits `turn_end` + `agent_end` on abort; `agent_end` ends the T3 turn as today.
  Preserve current interrupt semantics.

## Verification

- `vp check` and `vp run typecheck` must pass.
- Manual: start a Pi thread, send a message, then send another while it is working — the second message
  must be accepted (steered into the live turn) and appear as a pending queued message that clears when
  delivered. No "Agent is already processing" error.
