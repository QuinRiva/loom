# Reasoning re-home — upstream's durable rows replace loom's ephemeral v2

Post-pull-7 stack, stage 2. Pull 7's mechanical resolution kept loom's
"ephemeral reasoning v2" because upstream's `thread.message.reasoning.complete`
and loom's re-homed one were two structs with the same tag in one union
(sync note 25, §Semantic resolutions). The human's ruling on that: the fork's
mechanism was a workaround, not a feature, so **upstream's model is adopted end
to end and loom's is deleted**.

## The two models

**Loom's v2 (deleted).** Streaming chunks rode a transient `ReasoningStreamBus`
and never became events; one durable `thread.message-reasoning` event per
assistant segment carried the whole trace, and the projector wrote it onto the
_assistant_ message row's `reasoning_text` column. The web painted it as a
`ReasoningBlock` above the answer, gated by a `reasoningDisplay` client setting.

**Upstream's (adopted).** A thinking trace is an ordinary message row with
`role: "reasoning"`, produced by the same segmenting/buffering machinery as
assistant text: `thread.message.reasoning.delta` / `.complete` commands →
`thread.message-sent` events → projection rows. The trace therefore gets
ordering, pagination, retention, snapshot/resume, the `reasoningMessages` wire
opt-in (older clients see the row downgraded to `system`) and search exclusion
for free, rather than a parallel channel that has to re-implement each one.

What loom loses with the workaround: the per-message "Thought for Xs" duration
(`reasoning_ms`, populated only by loom's burst accounting) and the
`reasoningDisplay` off/collapsed/expanded setting. What it gains back:
upstream's whole-block **snapshot fallback** for providers that report a
reasoning block without streaming it, which loom's mechanism had no equivalent
for and pull 7 recorded as a cost.

## Deleted

`ReasoningStreamBus` (service + layer), `ReasoningStreamItem`, the
`reasoning-delta` variant of `ThreadLiveInput` / `OrchestrationThreadStreamItem`
and its fork in `ws.ts`, loom's `thread.message.reasoning.complete` command and
its `decider.loom.ts` arm, the `thread.message-reasoning` projector arms
(`projector.loom.ts`, `ProjectionPipeline`), the `reasoning_text` /
`reasoning_streaming` / `reasoning_ms` read-write path through
`ProjectionThreadMessages` and `ProjectionSnapshotQuery`, the
`reasoningText`/`reasoningStreaming`/`reasoningMs` fields on
`LoomMessageFields`, `applyReasoningStreamItem` plus the client-runtime
`reasoningFinalized` de-duplication, `ReasoningBlock.tsx`, and the
`reasoningDisplay` setting (contracts, web, desktop fixture).

`ThreadDetailRetentionLimits` / `DEFAULT_THREAD_DETAIL_LIMITS` went with them:
after the reasoning cases were removed, nothing in the thread-detail reducer
read the caps and no caller ever passed them.

## Migration 1038

`1038_ReasoningTextToReasoningMessages` copies every non-empty `reasoning_text`
into its own `role: "reasoning"` row, id `reasoning:legacy:<assistant id>`,
stamped one millisecond before its assistant message so it sorts above the
answer under `ORDER BY created_at, message_id`. `INSERT OR IGNORE` on the
derived id makes it idempotent.

## Migration 1041

The human verified the copy against real data on the deployed build, which was
the gate for the two follow-ups this change closes:

- `reasoning_text`, `reasoning_streaming` and `reasoning_ms` are **dropped**
  from `projection_thread_messages`. No index, trigger or view referenced them,
  so SQLite drops each in place.
- The 79,133 legacy `thread.message-reasoning` rows are **deleted** from
  `orchestration_events`, and with them the event-type literal and
  `ThreadMessageReasoningPayload` in `orchestration.loom.ts` (plus the
  `orchestration/Schemas.ts` re-export and the `AgentAwarenessRelay` arm). Those
  only ever survived the re-home so a replay across the historical event store
  could still decode; one change has to do both, since neither is safe alone.

Deleting events leaves gaps in `stream_version`, which the event store tolerates
— it appends at `max(stream_version) + 1` and reads in `sequence` order.
