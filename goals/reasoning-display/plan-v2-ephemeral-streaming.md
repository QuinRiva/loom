---
manager_sessions:
  - id: 019ef264-2f9f-747d-a4f0-2dca61bca76a
    role: plan
    authored_at: 2026-06-23T03:47:20.724Z
---

# Plan v2: Reasoning trace as an ephemeral stream (the "Level 3" rebuild)

> Revised after a GPT-5.5 plan review (see "Revisions" at the end). The review
> caught a factual error (production `RuntimeReceiptBus` is a no-op), an ordering
> race, undefined segment lifetime, and subscription-plumbing seams the first
> draft missed. Those are now pinned below.

## Why this exists

v1 (`plan.md`) shipped reasoning by **mirroring the assistant-text pipeline end
to end**: every streaming reasoning chunk becomes a persisted
`thread.message-reasoning` domain event, dispatched through the command queue,
written to the event store inside a SQL transaction, run through the full
projection pipeline, then broadcast. Correct, but pathological for reasoning's
volume:

- **Per-delta projection amplification.** `ProjectionPipeline.ts:718-734` puts
  `thread.message-reasoning` in the same fall-through group as user messages, so
  every reasoning chunk calls `refreshThreadShellSummary` (`:547`), which issues
  **four full `listByThreadId` reads + an upsert** — recomputing
  `latestUserMessageAt`, `pendingApprovalCount`, `pendingUserInputCount`,
  `hasActionableProposedPlan`. **None of those fields can change on a reasoning
  chunk.** Cost scales as `deltas × thread_size`, trending quadratic over a
  session. This is the observed sustained ~100% CPU on long reasoning turns.
- **Event-store doubling** (v1 review NIT #7): every chunk is a persisted event.
- **Per-delta SQL transaction** through the single-worker command queue
  (`OrchestrationEngine.ts` `processEnvelope`).

The root error: streaming chunks are a **transient view concern**, not durable
facts. The durable truth is the _final accumulated reasoning text_. This plan
rebuilds reasoning so chunks stream ephemerally over WS and reasoning is
**persisted exactly once per assistant segment, at turn finalization**.

## Objective (the contract this plan pins)

1. A streaming reasoning chunk produces **no** domain event, **no** event-store
   write, **no** projection pass. It is pushed to subscribed clients over a new
   transient channel only.
2. Reasoning is persisted **once per assistant segment**, at segment
   finalization, as a single `thread.message-reasoning` domain event carrying the
   full accumulated text (`reasoningStreaming: false`).
3. Net effect: a reasoning-heavy turn emits ~1 reasoning event per segment (was
   hundreds). `refreshThreadShellSummary` never runs for reasoning. Live display
   is unchanged for connected clients; reloaded threads show the persisted final
   reasoning.

## Scope decision (locked, flag for reviewer)

**Reasoning only.** Assistant _answer_ text keeps its per-delta persisted-event
model. Rationale: the answer is the product — mid-turn durability (recover the
answer-so-far after a crash) matters, and answers are short so the per-delta cost
is tolerable. Reasoning is auxiliary, high-volume, low durability need. The
transient bus is built generically so assistant text _could_ migrate later; that
migration is an explicit **follow-up, not done now**.

## Tradeoffs accepted (document in code + report)

- **Mid-stream reasoning is not durable.** A client connecting mid-turn sees no
  reasoning until the segment finalizes; a server crash mid-stream loses partial
  reasoning. Acceptable — reasoning is transient thinking, and v1 review
  Deviation #1 ("reasoning survives reload") is still met because the _final_
  text is persisted at finalization.
- This **fixes** v1 review #5 (stuck "Thinking…" spinner on crash) and #8
  (turnless reasoning never completes) for the persisted path: nothing is ever
  persisted with `reasoning_streaming = 1`, so a reload can never show a stuck
  spinner.

## The transient channel contract (the load-bearing wire shape)

A single transient message type carried on a new bus AND surfaced as a new
`subscribeThread` stream kind. Tagged union so live UX (Thinking… ⟷ Thought for
Xs) is driven entirely by the transient channel, with no durable write per chunk:

```
ReasoningStreamItem =
  | { threadId, messageId, turnId?, kind: "delta", text }
  | { threadId, messageId, kind: "complete", reasoningCompletedAt }
```

`subscribeThread` output union gains a third variant:
`{ kind: "reasoning-delta", payload: ReasoningStreamItem }` (name kept for the
client dispatch site; payload carries the tagged union above).

## Ordering & segment lifetime contract (resolves review CRITICAL #1, #2)

The durable full-text event is **authoritative**; transient items drive live
display only. Concretely:

- **Server accumulates** all reasoning for a `messageId` across bursts (an array
  of chunks, joined once — never per-chunk string concat; review #7). The buffer
  is retired only when the message id is retired at turn finalization, _after_
  the durable event is dispatched.
- **Transient `delta`** → client appends to `reasoningText`, sets
  `reasoningStreaming: true`, stubs the assistant message if absent.
- **Transient `complete`** → client flips to "Thought for Xs"
  (`reasoningStreaming: false`, capture `reasoningCompletedAt`) **without** a
  durable write. Emitted at the existing live completion points (first answer
  delta, etc.) so the live UX is unchanged.
- **A later `delta` for a `complete`d message reopens it** (clear finalized,
  streaming true again) — this is how interleaved reasoning across tool calls
  works. Multiple `complete`s per message are allowed.
- **Durable `thread.message-reasoning` event** is dispatched **once per messageId
  at segment/turn finalization** (the existing `getAssistantMessageIdsForTurn`
  close loop / session-exit), carrying the full accumulated text. The client
  reducer treats it as **REPLACE** (set full text, `reasoningStreaming: false`),
  never append. Because it replaces, a transient `delta` that arrives _after_ the
  durable event is **dropped** by the client (message reasoning already finalized
  for this turn). This removes the merge-order race: live order only matters
  among transient items (single-producer, naturally ordered); the durable event
  is idempotent replace.

This means **at most one durable reasoning event per segment**, not per burst —
O(segments), not O(deltas) or O(bursts).

## Architecture

Current flow (every client update is a persisted domain event):
`producer → dispatch(command) → [txn: eventStore.append + projectionPipeline.projectEvent] → PubSub.publish → ws subscribeThread liveStream`.

New flow for reasoning:
`producer → (per chunk) ReasoningStreamBus.publish(delta|complete)  ⟶  ws subscribeThread merges transient stream (ephemeral)`
`producer → (at finalization) dispatch(reasoning.complete, fullText) → one durable event → projection → snapshot/reload`.

### Server

1. **`ReasoningStreamBus` service + layer (new).** A **production** PubSub-backed
   service — do **NOT** copy `RuntimeReceiptBusLive`, whose production impl is a
   deliberate no-op (`RuntimeReceiptBus.ts:4-5,22-25`; only its _test_ layer has a
   PubSub). Use a **bounded sliding `PubSub`** to bound memory under slow clients
   (reasoning is high-volume; an unbounded buffer is a memory-pressure risk).
   API: `publish(item)` and a per-subscriber `stream` (`Stream.fromPubSub`).
   Provide a test layer too. Wire `ReasoningStreamBusLive` into the server layer
   graph and into both `ProviderRuntimeIngestion` and `ws.ts`.

2. **Producer — `ProviderRuntimeIngestion.ts`** (`handleReasoningDelta` ~`:847`,
   `completeReasoningForMessage` ~`:871`, turn-end close loop ~`:1653-1670`):
   - Accumulate reasoning per `messageId` as an **array of chunks** (generalize
     `bufferedReasoningTextByMessageId`), in both delivery modes.
   - **Streaming mode:** each chunk → `ReasoningStreamBus.publish({kind:"delta"})`.
     No command dispatch.
   - **Buffered mode** (`enableAssistantStreaming = false`): accumulate only; no
     transient publish.
   - At each existing live-completion point: `ReasoningStreamBus.publish(
{kind:"complete"})` (transient, both modes).
   - **At segment/turn finalization** (the `getAssistantMessageIdsForTurn` close
     loop + session-exit): dispatch **one** `thread.message.reasoning.complete`
     carrying the full joined text, then clear the buffer + active state. The
     `reasoningActiveByMessageId`/finalized guard ensures exactly one durable
     event per messageId per turn.
   - Co-location still hinges on the message id from `getOrCreateAssistantMessageId`
     (active-segment / `turnId`) — unchanged, still the dependency in v1 review
     SHOULD-FIX #1; the live run must confirm it.

3. **Contracts — `packages/contracts/src/orchestration.ts`** (pin exact shapes;
   resolves review #6):
   - **Remove** `ThreadMessageReasoningDeltaCommand` and its decider/event path.
   - **Redefine** `ThreadMessageReasoningCompleteCommand` to carry the full text:
     `{ type, commandId, threadId, messageId, turnId?, reasoningText, createdAt }`
     (today it has no `reasoningText`, `:747-754`).
   - **Redefine** `ThreadMessageReasoningPayload` to
     `{ threadId, messageId, turnId, reasoningText, reasoningStreaming: false, createdAt, updatedAt }`
     (today it carries `reasoningDelta`, `:938-947`). Persisted reasoning is
     always complete; keep the `reasoning_streaming` column nullable (no
     migration) and write `false`/`0`.
   - **New transient WS variant**: extend the `subscribeThread` output union
     (`:1165-1174`, currently only `snapshot`/`event`) with
     `{ kind: "reasoning-delta", payload: ReasoningStreamItem }`, and export
     `ReasoningStreamItem`.

4. **`decider.ts`** (`:685-706`): drop the reasoning-delta case; `reasoning.complete`
   → single `thread.message-reasoning` event with full text (replace semantics).

5. **`projector.ts` (in-memory) + `ProjectionPipeline.ts` (DB):**
   - **Remove `thread.message-reasoning` from the per-delta shell-refresh group**
     (`ProjectionPipeline.ts:718-734`). Core perf fix.
   - The reasoning case in `applyThreadMessagesProjection` / `projector.ts` now
     **sets** the full `reasoningText` once (replace, not accumulate). Keep the
     `message-sent` COALESCE that preserves reasoning columns.
   - Persistence layer + migration 034: unchanged (columns stay; written once).

6. **`ws.ts` `subscribeThread`** (`:956-1012`): **acquire the `ReasoningStreamBus`
   subscription (filtered to `input.threadId`) BEFORE loading the snapshot**
   (resolves review #5 connect gap), then `Stream.merge` it into the returned
   stream as `{ kind: "reasoning-delta" }`, alongside the snapshot + domain-event
   `liveStream`. Same auth scope as the existing thread-detail stream. Document
   that pre-subscription in-flight deltas are reflected only at durable
   finalization (acceptable per Tradeoffs).

### Client

7. **Subscription dispatch seams (resolves review CRITICAL #3 — first draft only
   named reducers):** both places that currently treat every non-snapshot item as
   `item.event` must branch on the new kind:
   - `apps/web/src/environments/runtime/service.ts` subscription handler (`:406-414`).
   - `packages/client-runtime/src/threadDetailState.ts` (`:246-272`).

8. **Reducers — `apps/web/src/store.ts` + `packages/client-runtime/src/threadDetailReducer.ts`:**
   - transient `delta` → append, `reasoningStreaming: true`, stub if absent.
   - transient `complete` → `reasoningStreaming: false`, capture
     `reasoningCompletedAt`; mark finalized for the turn.
   - later `delta` after `complete` → reopen (clear finalized, streaming true).
   - durable `thread.message-reasoning` event → **REPLACE** `reasoningText` with
     full text, `reasoningStreaming: false`; **drop** stale transient deltas for
     an already-finalized message.

9. **`apps/web/src/environments/runtime/service.ts` `coalesceOrchestrationUiEvents`**
   (`:910`+): move the reasoning coalescing branch to batch consecutive transient
   `reasoning-delta` items per `messageId` (it currently coalesces the soon-to-be-
   removed domain event).

10. **`MessagesTimeline.tsx` `ReasoningBlock`:** no behavioral change — same
    `reasoningText` / `reasoningStreaming` / `reasoningCompletedAt` inputs.

### Cleanup (prototype rules — delete, don't shim)

Remove the now-dead per-delta reasoning command, its decider case, and any
streaming-vs-buffered branching that existed only to emit per-delta events. No
"kept for compatibility" duplicate paths.

## Verification

- `vp check` and `vp run typecheck` pass.
- Unit: update `orchestration.test.ts`, `ProviderRuntimeIngestion.test.ts`,
  `projector.test.ts`, `store.test.ts`, `MessagesTimeline.test.tsx` for the new
  contract. Add a test asserting N reasoning chunks produce **zero**
  `thread.message-reasoning` events until finalization, then exactly one.
- **Stream-plumbing tests (resolves review #8):** add one web subscription test
  (`service.threadSubscriptions.test.ts`) and one client-runtime test
  (`threadDetailState.test.ts`) for the `{ kind: "reasoning-delta" }` variant,
  including the completion-before-stale-delta drop and the reopen case.
- **Mandatory live run** (canonical entrypoint, per AGENTS.md) with a
  reasoning-capable model (Opus 4.8 via the pi extension):
  - reasoning streams live, collapses to "Thought for Xs";
  - during a long reasoning turn, server CPU stays low and
    `SELECT count(*) FROM orchestration_events WHERE event_type='thread.message-reasoning' AND stream_id=<thread>`
    grows by ~1 per segment, not per chunk;
  - reload shows the persisted final reasoning; tri-state behaves as before.

## Out of scope / follow-ups

- Migrating assistant _answer_ text onto the same transient bus.
- Incremental (non-recomputing) `refreshThreadShellSummary` for events that
  legitimately call it.
- Persisting a precise `reasoningCompletedAt` column (v1 review #6).

## Revisions from the GPT-5.5 plan review

- **CRITICAL #1 (merge ordering):** added the "durable event = authoritative
  REPLACE; transient drives live; drop stale post-finalize" contract.
- **CRITICAL #2 (segment lifetime / interleaving):** defined one durable event
  per segment at finalization; transient `complete`/reopen for live bursts.
- **CRITICAL #3 (subscription plumbing):** named `service.ts:406-414` and
  `threadDetailState.ts:246-272` explicitly.
- **SHOULD-FIX #4 (bus):** corrected — production PubSub-backed, bounded sliding;
  do not mirror the no-op `RuntimeReceiptBusLive`.
- **SHOULD-FIX #5 (connect gap):** subscribe to the bus before snapshot load.
- **SHOULD-FIX #6 (payload):** pinned the exact command/event schemas.
- **SHOULD-FIX #7 (quadratic buffer):** accumulate as an array, join once.
- **NICE #8:** added subscription-plumbing tests.
