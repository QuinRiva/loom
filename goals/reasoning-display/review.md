# Reasoning-display implementation review

Skeptical static review of the `throwaway-pi-frontend` reasoning-trace feature
(23 changed files + migration 034). Typecheck-green and git-surface were
pre-confirmed by the requester and not re-verified here. No code was edited.

A live end-to-end run was **not** performed (no pi binary / provider creds), and
the implementer could not run it either. Per `AGENTS.md` ("verify with the
canonical entrypoint"), this feature is **not yet "done"** until a reasoning-
capable model is driven through the real pipeline once. That gap underlies the
top finding below.

---

## Findings (prioritized)

### CRITICAL

None proven by static inspection. The one mechanism that _could_ be a critical
correctness bug is unverifiable without a live run — see SHOULD-FIX #1.

### SHOULD-FIX

**1. Reasoning↔answer co-location is unverified and hinges on `turnId` being
present on `content.delta` events.**
`ProviderRuntimeIngestion.ts:1538-1569` resolves the reasoning message id via the
same `getOrCreateAssistantMessageId` (793-816) as the answer. Co-location works
**only** through the active-segment path: when `input.turnId` is present,
`getActiveAssistantMessageIdForTurn` returns the turn's active segment so reasoning
and answer share one id (790-816). If `event.turnId` is _absent_ on reasoning
`content.delta`s, the function falls back to
`assistantSegmentMessageId(baseKeyFromEvent, 0)` where
`baseKey = itemId ?? turnId ?? eventId` (196-204). Reasoning's `itemId` is almost
certainly different from the answer's `itemId`, so reasoning would orphan into a
_separate_ message instead of rendering above the answer — the feature's core
premise silently broken.
This is the same dependency the existing assistant-text streaming already relies
on, so `turnId` is _probably_ present — but the entire feature's correctness rides
on it and nobody has watched a real trace.
_Fix:_ run the canonical entrypoint against a reasoning model (Opus 4.8 / GPT 5.5
via pi) and confirm a single message shows the thinking block above its answer.
If `turnId` can be absent, key reasoning resolution off the answer's `itemId`
explicitly rather than the reasoning event's.

**2. Reasoning deltas are not coalesced client-side → per-delta re-render in
streaming mode (perf-first project).**
`apps/web/src/environments/runtime/service.ts:910-944` (`coalesceOrchestrationUiEvents`)
merges consecutive streaming `thread.message-sent` deltas into one store update,
but has no branch for `thread.message-reasoning`. Long reasoning traces (many
chunks) therefore produce one store update + `MessagesTimeline` re-render +
`ChatMarkdown` re-parse **per delta**, whereas the answer text is batched. Given
`AGENTS.md` priority #1 ("Performance first"), this parity gap is worth closing.
_Fix:_ add a coalesce branch merging consecutive `thread.message-reasoning`
events by `messageId` (concatenate `reasoningDelta`, carry the latest
`reasoningStreaming`/`updatedAt`), mirroring the message-sent branch.

**3. Buffered mode (`enableAssistantStreaming = false`) shows "Thought for 0s".**
In buffered delivery, reasoning deltas accumulate in `bufferedReasoningTextByMessageId`
with no event dispatched, so no projected message exists yet. The first dispatch
is the flush in `completeReasoningForMessage` (ingestion ~898-960) with
`createdAt = now`; the stub message is therefore created at _completion_ time, and
the immediately-following complete event sets `reasoningCompletedAt = now`. Web
duration = `now − now ≈ 0` (`MessagesTimeline.tsx:663-668`, `store.ts:191-197`).
Confined to the non-default buffered mode and not a correctness bug, but the
header is actively misleading there.
_Fix:_ in buffered mode stamp the stub's `createdAt` from the first buffered
delta's timestamp (capture it when the buffer is first populated) rather than the
flush time.

### NICE-TO-HAVE

**4. New reasoning caches are excluded from session-exit cleanup.**
`clearAssistantMessageState` (ingestion) only invalidates
`bufferedAssistantTextByMessageId`; the new `bufferedReasoningTextByMessageId` and
`reasoningActiveByMessageId` are _not_ cleared by `clearTurnStateForSession`
(1207+) on `session.exited`. They survive only until TTL — bounded, not a true
leak, but a divergence from the assistant buffer's lifecycle that this change
introduced.
_Fix:_ add `Cache.invalidate(bufferedReasoningTextByMessageId, messageId)` and
`reasoningActiveByMessageId` to `clearAssistantMessageState`.

**5. Stuck "Thinking…" spinner on crash mid-turn.**
On `session.exited` / `runtime.error` (ingestion 1758-1789), no
`reasoning.complete` (and no assistant finalize) is dispatched, so a persisted
reasoning row keeps `reasoning_streaming = 1` and the reload shows a spinning
"Thinking…" forever. This is **parity** with assistant text (which stays
`streaming: true` on the same path), but the reasoning spinner is more visually
prominent. Optional: flush+complete reasoning (and finalize assistant) in the
session-exit path.

**6. Reloaded-thread reasoning duration is overstated.** `store.ts:191-197`
derives `reasoningCompletedAt = updatedAt` on reload, but `updatedAt` is later
overwritten by answer completion, so "Thought for Xs" overstates thinking time
for reloaded threads. Documented as deviation #4; acceptable best-effort given no
persisted reasoning-end timestamp. (Could persist `reasoningCompletedAt` if
accuracy matters, at the cost of one more column.)

### NIT

**7. Per-delta domain events in the event store.** Every streaming reasoning
delta is persisted as its own `thread.message-reasoning` event (decider 659-710),
roughly doubling event volume on reasoning-heavy turns. This is parity with
assistant `message-sent` streaming events and replays correctly (always-concat),
so it's only an event-store growth observation.

**8. Turnless reasoning with no answer never completes.** If `turnId` is absent
_and_ no answer text arrives, neither the first-answer-delta nor the
`turn.completed` fallback (guarded on `turnId`) fires completion, leaving
`reasoningStreaming` true. Narrow edge; only reachable if SHOULD-FIX #1's
turnless path is real.

---

## What is correct (verified from the diff)

- **Migration 034** is additive and NULL-safe: two nullable `ADD COLUMN`s, no
  default; existing rows read back as absent fields. Loader/registration wired
  (`Migrations.ts:34`).
- **COALESCE accumulation matches the `text` model.** Accumulation is done by
  read-modify-write in `ProjectionPipeline.applyThreadMessagesProjection`
  (`reasoningText: \`${prev}${delta}\``, line 870), exactly mirroring how `text`is concatenated (817-833); the layer's`ON CONFLICT … reasoning_text =
  COALESCE(excluded, existing)` (`ProjectionThreadMessages.ts:99-108`) is a
REPLACE-with-full-value, consistent with `text = excluded.text`. `message-sent`passes reasoning columns as`undefined → null`, so COALESCE preserves prior
reasoning — verified. `reasoning_streaming` 0/1 COALESCE is correct (0 ≠ NULL).
- **`ProjectionSnapshotQuery.ts` is ~95% reindentation** (the `Effect.flatMap`
  arrow was collapsed onto one line, reflowing a large block). The only
  functional edits are reasoning columns in the two message SELECTs (421-426,
  787-792) and the two `OrchestrationMessage` mapping sites (1061-1070,
  2008-2015). The shell-snapshot projection (projects/threads fields) is byte-for-
  byte unchanged in content — **no column or field loss**.
- **In-memory projector merge preserves reasoning.** `thread.message-sent`'s
  existing-message branch spreads `...entry` first (projector 416-432), so
  `reasoningText`/`reasoningStreaming` survive when the answer arrives.
- **Completion is idempotent.** `completeReasoningForMessage` early-returns unless
  `reasoningActiveByMessageId` is true, then invalidates it; safe across all three
  call sites (first answer delta, `assistantCompletion`, `turn.completed`).
  Re-opened interleaved reasoning is re-closed at turn end via the
  `getAssistantMessageIdsForTurn` loop (1726-1745). `turn.completed` covers
  _failed_ turns too (state can be "failed"), so normal interrupts still complete.
- **Buffered mode flushes exactly once** (no loss/dup): spill path caps memory and
  the final `takeBufferedReasoningText` drains the remainder.
- **Stub sharing is collision-free.** Reasoning-first creates a stub under the
  active segment id; the answer reuses the same id (active-segment lookup) and
  merges by id — no phantom/duplicate, no `hasAssistantMessageForTurn` breakage
  (the stub _is_ the turn's assistant message).
- **Consumer fan-out is complete and correct:** `ws.ts` broadcast filter includes
  the event (load-bearing); `AgentAwarenessRelay` returns `false` (correct — not a
  turn-state change); `ProjectionPipeline` shell-refresh group updated.
  `CheckpointReactor` correctly ignores reasoning (only `role: "user"` triggers
  baselines, 554-565). Turn-settlement (`ProjectionPipeline:1180`) correctly
  excludes reasoning.
- **Deviation #5 (`Effect.gen` sequencing) is a faithful equivalent.** The
  `turn.completed` fallback runs `completeReasoning` then `finalizeAssistant` via
  `yield*` inside `Effect.forEach({concurrency: 1})`; errors propagate, order is
  preserved, nothing is swallowed.
- **Settings default materializes at runtime.** `DEFAULT_CLIENT_SETTINGS =
decodeSync(ClientSettingsSchema)({})` applies the `withDecodingDefault`, so
  `DEFAULT_UNIFIED_SETTINGS.reasoningDisplay === "collapsed"` at runtime — no
  blank Select / false dirty state.
- **Web open-state logic is sound.** `useState(mode === "expanded" || streaming)`
  - the `[streaming, mode]` effect auto-expands while streaming and collapses on
    completion only in `collapsed` mode; manual toggles during streaming persist
    (effect deps don't change per delta). `(empty response)` is correctly suppressed
    for reasoning-only in-flight messages (`MessagesTimeline.tsx:590-597`).
- **Prototype-rule compliance:** all additions are new optional fields / a new
  additive migration. No "kept for backward compatibility" fields, no dual-shape
  output, no compat shim. Clean.

---

## Verdict

**Keep-with-fixes.** No proven correctness blocker in static review; the
persistence scope addition (deviation #1) is justified ("reliability first" —
reasoning would otherwise vanish on reload) and mechanically faithful to the
existing `text` path. Before declaring done: (a) perform the mandatory live run to
discharge SHOULD-FIX #1 (the co-location premise is untested), and (b) close the
streaming coalescing gap (SHOULD-FIX #2) given the project's performance-first
priority. The buffered-mode duration, cache-cleanup, and crash-spinner items are
lower-stakes and can follow.
