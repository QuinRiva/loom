---
manager_sessions:
  - id: 9ac69034-5f12-4fa9-81e7-1f2fd2985a1e
    role: plan
    authored_at: 2026-07-21T04:36:10.307Z
---

# `notify_thread` — global cross-thread push messaging

**Status:** design — ready for implementation
**Date:** 2026-07-21
**Scope:** new provider tool + HTTP handler, one new `MessageOrigin` value, one new
recorded event + shell edge, a `followUp` delivery seam through the turn-start
pipeline into `PiDriver`. No changes to `workstream_prompt` or its D3
authorisation invariant.

## 1. Motivation

The only push path today is `workstream_prompt`, restricted to a thread's
*direct children*; the only cross-graph reach is `consult_thread`, which is
read-only. A working thread that finishes therefore cannot tell an arbitrary
peer "I'm done" — humans copy-paste between threads, or the waiting thread
burns turns polling `consult_thread`. The fix: let the *working* thread push.

`notify_thread` is the symmetric **write counterpart of `consult_thread`**:
same global reach (any thread the server knows, across orchestration trees,
worktrees and projects), same id-or-fuzzy-name target resolution, but instead
of forking the target's session read-only, it delivers a message into the
target's real conversation.

Decisions fixed by the user (not relitigated here): new tool rather than a
`workstream_prompt` variant; fully global authorisation; follow-up (never
mid-turn steer) delivery; fire-and-forget baseline with a loop guard; a
recorded message edge mirroring consults.

## 2. Design decisions

### D1 — Tool name: `notify_thread`

`notify_thread`, route `POST /provider-tools/thread/notify` (sibling of
`consult_thread`'s `/provider-tools/workstream/consult-thread`; placed under
`/thread/` because, like `set_thread_title` and `thread_fork`, it is not
scoped to the caller's workstream tree).

Rejected alternatives:

- `message_thread` — reads as the noun "message thread", and "message"
  imports a conversational register that undermines the fire-and-forget
  contract (D6).
- `workstream_notify` — the `workstream_` prefix signals tree-scoped
  ownership tools; this tool's defining property is that it escapes the tree.

"Notify" deliberately biases the register toward one-shot, no-reply-owed
pushes. The message body can still carry substantive content (findings,
artefact paths); what it must not become is a delegation or steering channel —
the name is the first line of that defence, the framing wrapper (D5) and loop
guard (D7) the second and third.

### D2 — New origin value: `peer`

`MessageOrigin` (`packages/contracts/src/orchestration.loom.ts:562`) gains a
fifth literal:

```ts
export const MessageOrigin = Schema.Literals([
  "human",
  "kickoff",
  "orchestrator",
  "control_notice",
  "peer", // notify_thread: another thread (not this thread's parent) authored it
]);
```

A peer message is none of the existing four: not a human, not the kickoff, not
this thread's parent orchestrator, not control-plane machinery. The axis stays
clean: *who composed the words* = an unrelated agent thread.

Spoofing is impossible by the same construction as the existing values: the
origin is stamped server-side in the handler from the authenticated scope
(`scope.threadId`); `ClientThreadTurnStartCommand` carries no `origin` field on
the wire.

UI: `MESSAGE_ORIGIN_LABELS` in
`apps/web/src/components/chat/MessagesTimeline.tsx:898` gains
`peer: "Peer thread"` — the message renders with the existing info tint +
provenance chip, same as orchestrator steers.

### D3 — Authorisation: global, with sanity rejections (not ownership checks)

The handler does **not** call `authorizationError`
(`WorkstreamSpawnHttp.ts:199`) — that D3 "own thread or direct child"
invariant stays intact for `workstream_prompt` and the other mutating tools.
`notify_thread` resolves its target from `collectGraphThreads()`
(`WorkstreamSpawnHttp.ts:1729` — active + archived shells, the same universe
`consult_thread` reaches).

What it rejects is not ownership but nonsense sends:

| Condition | Response |
| --- | --- |
| target is the caller itself | 400 — "You cannot notify your own thread." |
| target not found | 404 |
| target `planLane` is `done` or `cancelled` | 409 — sticky-terminal, mirroring `workstream_prompt`: a turn-start on a terminal thread silently re-engages it without changing its lane. Message names the lane and suggests the target's parent as the recipient instead. |
| target is a workstream child whose kickoff was never delivered (`!isKickoffDelivered(...)` and no assistant message — the same predicate `handleWorkstreamPrompt` uses at `WorkstreamSpawnHttp.ts:2717`) | 409 — "Target has not started yet; its kickoff belongs to its parent. Notify the parent, or wait for the target to launch." A peer message must never become a child's first turn: kickoff composition (role framing + brief) is exclusively the parent/dispatcher's. |
| message over the size cap (D8) | 400 |
| ordered-pair rate cap exceeded (D7) | 429 |

### D4 — Delivery: same `thread.turn.start` primitive, new `followUp` timing seam

The handler dispatches the SAME command `handleWorkstreamPrompt` does
(`WorkstreamSpawnHttp.ts:2783`) — no new delivery path:

```ts
yield* engine.dispatch({
  type: "thread.turn.start",
  commandId: CommandId.make(`server:notify-thread:${uuid}`),
  threadId: targetThreadId,
  message: {
    messageId, role: "user",
    origin: "peer",
    text: framedText,            // D5 wrapper around the sender's message
    attachments: [],
  },
  midTurnDelivery: "followUp",   // NEW field, see below
  runtimeMode: target.runtimeMode,
  interactionMode: target.interactionMode,
  createdAt: now,
} satisfies OrchestrationCommand);
```

No `requireIdle`, no `setInProgress`, no `reopen`: a peer message must not
gate on idleness (it queues instead), must not flip lanes, and can never
reopen a terminal thread (D3 rejects those).

**Idle recipient** → exactly today's behaviour: the message starts the
target's next turn.

**Busy recipient** → today `PiDriver.sendTurn` folds any mid-run send as a
steer (`streamingBehavior: "steer"`, `PiDriver.ts:2154`). A peer message is
unsolicited, so it must not interrupt: it goes into pi's existing `followUp`
queue (the lane already surfaced by `QueuedMessages`
(`orchestration.loom.ts:231`) and pi's `queue_update` events) and is delivered
at the next turn boundary. Concretely, `streamingBehavior: "followUp"` on the
prompt request (`RpcProcess.ts:54` already types it).

The timing preference travels as one new server-only optional field,
`midTurnDelivery: "followUp"`, threaded through the existing pipeline:

1. `LoomTurnStartFields` (`orchestration.loom.ts:691`) gains
   `midTurnDelivery: Schema.optional(Schema.Literal("followUp"))`, with the
   same server-only posture as `requireIdle` (never set by clients; the
   decider rejects it on non-`server:` command ids, mirroring the `reopen`
   guard at `decider.ts:849`). Absent ⇒ today's steer fold — every existing
   caller is untouched.
2. `ThreadTurnStartRequestedPayload` (`orchestration.ts:1003`) carries it
   through (optional, loom-commented).
3. `ProviderCommandReactor.processTurnStartRequested` passes it into
   `buildSendTurnRequestForThread` (`ProviderCommandReactor.ts:782`), which
   includes it in the returned `ProviderSendTurnInput`.
4. `ProviderSendTurnInput` (`packages/contracts/src/provider.ts:85`) gains
   `midTurnDelivery: Schema.optional(Schema.Literal("followUp"))` — advisory;
   drivers that cannot honour it ignore it (see Open questions).
5. `PiDriver.sendTurn` (`PiDriver.ts:2069`): when `activeTurnId` is set AND
   `midTurnDelivery === "followUp"`, send the prompt with
   `streamingBehavior: "followUp"` instead of `"steer"`.

**Turn accounting for the follow-up run** — the one genuinely new driver
mechanism. A steer joins the current T3 turn (same `turnId`); a followUp does
not: pi queues it and starts a NEW agent run after the current one ends. Today
`agent_start` with no `activeTurnId` is ignored (no `turn.started`,
`PiDriver.ts:1533`), which would leave the followUp turn invisible and its
pending turn-start row permanently uncleared (blinding the idle gate). Design:

- `sendTurn` on the followUp branch mints the `turnId` up front, pushes it
  onto a new per-session `pendingFollowUpTurnIds: TurnId[]`, sends the
  prompt, and returns that `turnId` (satisfying `ProviderTurnStartResult`).
- `agent_start` with `activeTurnId === undefined` shifts
  `pendingFollowUpTurnIds`: if one exists, adopt it as the active turn, push
  the turn record, emit `turn.started` — the normal lifecycle resumes from
  there (the pending turn-start row clears at `turn.started` as usual).
- Backstop: if the session stops or is interrupted while
  `pendingFollowUpTurnIds` is non-empty (pi may drop its queue on abort —
  verify at implementation), settle each pending id through the existing
  `thread.turn-start.fail` path (`orchestration.loom.ts:971`) so no pending
  row lingers. This mirrors the Fix-A discipline every other turn-start
  failure already follows.

### D5 — Recipient framing wrapper

Composed server-side in the handler from the authenticated sender's shell
(title, role, id — unforgeable), wrapping the raw message:

```
Message from peer thread «{senderTitle}» ({senderRole ?? "thread"}, {senderThreadId}) — an unsolicited peer notification, not from your parent orchestrator and not from a human:

{message}

No reply is owed. If this needs no action from you, absorb it and continue your work. If the sender needs something back, reply with notify_thread (threadId: {senderThreadId}).
```

Properties: the recipient can tell at a glance this is a peer (not its parent,
not a human, not machinery); reply symmetry is explicit and carries the exact
id (no name-resolution round trip for the reply); the no-reply-owed default is
stated at the binding moment — in the recipient's context, where the
acknowledge-reply loop would otherwise start (D7).

The framed text is what lands in the recipient's transcript
(`thread.message-sent`), so provenance is durable and visible; the recorded
edge event (D9) stores the raw message.

### D6 — Fire-and-forget contract

The tool result confirms delivery disposition only —
`started the target's next turn` / `queued as a follow-up behind its open turn`
— and never carries a reply. A caller that needs an answer has two honest
options, both named in the tool description: `consult_thread` (synchronous
read-only Q&A, no engagement of the target's real session) or asking the
recipient to `notify_thread` back (asynchronous, arrives as a future inbound
message, not as this call's result).

### D7 — Loop safety

Two layers, both cheap:

1. **Register**: the framing (D5) states "no reply is owed" and gives the
   recipient an explicit if-and-only-if condition for replying. This kills the
   politeness ping-pong ("acknowledged!" → "you're welcome!") at the source.
2. **Rate cap**: the handler counts recorded peer-message events for the
   ordered pair (sender → target) in a rolling window via the projection
   table (D9) and rejects beyond `NOTIFY_PAIR_HOURLY_CAP = 10` with a 429
   naming the guard. Rationale for the number: legitimate uses are sparse
   (completion notices, occasional info handoffs — a few per pair per
   session); a runaway A↔B loop is turn-paced, so even a slow loop hits 10
   within the hour and both directions get told to stop. No round counter, no
   conversation state — the cap is derivable from the same table the graph
   edges use.

No forced-reply mechanics, no reply-to threading, no round cap between
specific messages: fire-and-forget is the baseline per the accepted decision,
and anything conversational should escalate to a human or a consult.

### D8 — Message size cap

`NOTIFY_MESSAGE_MAX_CHARS = 16_000` (≈4k tokens). Justification rather than an
arbitrary budget: the transport ceiling is
`PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000` (`orchestration.ts:171`), but a
peer message is an *unsolicited injection into another agent's context window*
— the recipient never budgeted for it. 16k comfortably fits a completion
notice with a results summary and artefact paths, while making "paste the
whole report inline" impossible; the message parameter's description tells the
sender to pass paths for bulk content. Knob, not architecture — flagged in
Open questions.

### D9 — Observability: `thread.peer-message-recorded` + shell edge

Mirrors the consult pipeline end to end (command → decider passthrough →
projection row → shell aggregation → graph overlay):

- **Command** `thread.peer-message.record`
  (`orchestration.loom.ts`, beside `ThreadConsultRecordCommand` at ~line 907):
  `{ commandId, threadId /* sender = aggregate */, targetThreadId,
  targetTitle, message, delivery: "turn" | "followUp", createdAt }`.
  Dispatched by the handler after the turn-start dispatch succeeds,
  best-effort exactly like the consult recording (a recording failure logs a
  warning and never fails the notify response, `WorkstreamSpawnHttp.ts:3138`).
- **Decider** (`decider.loom.ts`, beside `thread.consult.record` at ~line 990):
  pure passthrough → event `thread.peer-message-recorded` with payload
  `{ senderThreadId, targetThreadId, targetTitle, message, delivery,
  createdAt }`. Registered in the event/command type enums
  (`orchestration.loom.ts:~1401/1461`).
- **Projection**: new table via migration
  `064_ProjectionThreadPeerMessages.ts` + repository
  `ProjectionThreadPeerMessages` (Layers + Services), shaped like
  `ProjectionThreadConsults` (048): eventId (idempotency), senderThreadId,
  targetThreadId, targetTitle, bounded `messagePreview`, createdAt. Projected
  in `ProjectionPipeline.ts` beside the `thread.consult-recorded` case
  (~line 1394), with `refreshThreadShellSummary(sender)`. The named
  distinction from the existing `ProjectionThreadMessages` (chat messages) is
  deliberate — "peer messages" are edges, not transcript rows.
- **Shell**: `OrchestrationThreadPeerMessageSummary`
  (`orchestration.loom.ts`, beside `OrchestrationThreadConsultSummary` at
  ~line 319): `{ targetThreadId, targetTitle, count, lastMessageAt,
  lastMessagePreview }`; shell field `peerMessages` (decode-defaulted `[]`,
  beside `consults` at ~line 486); aggregation query in
  `ProjectionSnapshotQuery.ts` (~line 998 pattern).
- **Graph**: `WorkstreamGraph.tsx` draws a message-edge overlay from
  `peerMessages` exactly as the consult overlay does (~line 137), in a
  distinct colour. The projector fall-through comments
  (`projector.ts:216`, `projector.loom.ts:113`) note the new event. UI overlay
  can land as a fast-follow; the event + shell edge are the contract and ship
  with the tool.

### D10 — Target resolution: id or fuzzy name, consult-style

Reuse `rankThreadsByName` / `isUnambiguousMatch` / candidate rendering exactly
as `handleWorkstreamConsultThread` (`WorkstreamSpawnHttp.ts:3161-3184`):
`threadId` wins when present; a `name` with one clear match sends; an
ambiguous name returns ranked candidates and **sends nothing** (a misdelivered
push engages the wrong thread's session — worse than a misdelivered consult).

## 3. Tool definition (the deliverable wording)

Authored to `docs/architecture/tool-def-authoring.md` (the delegation-thread
rubric). Entry in
`apps/server/src/provider/Drivers/Pi/providerToolDefs.ts`; route in
`toolPaths.ts`.

```ts
{
  name: "notify_thread",
  label: "Notify Thread (cross-thread push)",
  description:
    "Push a markdown message into ANY other thread the server knows — across orchestration trees, worktrees, and projects — the write counterpart of the read-only consult_thread. Delivery never interrupts: an idle recipient starts its next turn with your message (it will spend tokens acting on it); a busy recipient receives it as a queued follow-up at its next turn boundary, never folded into the running turn. The recipient sees it framed as a peer message carrying your thread's title and id, and owes no reply — this call is fire-and-forget (the result confirms started/queued delivery and never carries an answer). Use it to tell a thread something it is waiting to hear, e.g. \"the extraction run you depend on is complete; results at <path>\". It is NOT for getting information back (consult_thread asks a read-only question and returns the answer), not for directing your own children (workstream_prompt), not for reporting to your parent (workstream_submit), and not for creating work (workstream_spawn). Identify the target by threadId, or by name (fuzzy sidebar-title match) — an ambiguous name sends nothing and returns ranked candidates.",
  promptSnippet:
    "push a fire-and-forget message into any thread by id or name (idle target → starts its next turn; busy target → queued follow-up, never interrupts).",
  promptGuidelines: [
    "notify_thread's result is the end of the exchange — no reply arrives through it. Need an answer? consult_thread the target, or ask it (in your message) to notify_thread you back and carry on until that arrives.",
    "An unresolved name returns candidates and sends nothing: confirm the intended target, then call again with its threadId — a push engages the recipient's session, so never guess.",
  ],
  parameters: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        description:
          "Exact id of the target thread. Preferred when known (from workstream_list, a prior consult, or an @-mention [Title](thread://<id>)). Provide threadId OR name, not both.",
      },
      name: {
        type: "string",
        description:
          "Fuzzy sidebar title/name of the target thread, used when you don't have an exact id; an ambiguous name returns ranked candidates without sending.",
      },
      message: {
        type: "string",
        description:
          "The markdown message the recipient receives, framed as coming from your thread. It lands in another agent's context with none of yours, so write it self-contained: lead with what the recipient needs to know or do with it, reference your outputs by absolute path instead of pasting bulk content, and say whether anything is expected back (the default the framing states for you: nothing — the recipient owes no reply).",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  errorMode: "throw",
  fallbackText: "Message delivered.",
}
```

### Why this wording obeys the rubric

- **Register**: second person, imperative, addressed to the calling agent at
  the selection moment; every sentence is behaviour-shaping ("an ambiguous
  name sends nothing", "the result … never carries an answer"), not API
  reference.
- **When/when-not with named alternatives, symmetric**: the description
  routes each rejected branch to its sibling (`consult_thread`,
  `workstream_prompt`, `workstream_submit`, `workstream_spawn`). The
  companion edit (below) makes the fork visible from the other side too.
- **Recipient characterised at composition time**: `message` is an
  artefact-crossing parameter — its description names the reader (another
  agent with none of the caller's context) and the register (self-contained,
  paths not bulk, expectation-explicit). This is the rubric's root-defect
  guard (recipient-blindness) applied where it binds: while the model
  generates that field.
- **Blast radius is capability, not plumbing**: "it will spend tokens acting
  on it" and the global reach are selection-relevant (they change whether you
  call), so they live in the description; the recorded edge event, the
  origin value, and route paths are plumbing the caller cannot act on —
  omitted.
- **No schema restatement**: no "Required."/"Optional." prose; the one
  handler-enforced conditional JSON schema cannot express ("threadId OR name,
  not both") is correctly in prose.
- **Guidelines carry only post-call duties** (2 bullets): what to do after a
  fire-and-forget send when you wanted an answer, and after an unresolved
  name. Both bind outside the call, when schema salience is gone. Nothing in
  them contradicts the parameter text.
- **No paraphrase-drift coupling**: "the write counterpart of the read-only
  consult_thread" references consult_thread's *contract* (read-only), not a
  restatement of its definition, so future edits to consult_thread's def
  cannot silently change this one's meaning.
- **Both tails guarded** on `message`: self-containedness guards
  under-specification; "reference outputs by path instead of pasting bulk"
  guards the over-stuffed twin.

### Companion wording edits (same change, no drift)

Per the rubric's "land shared-field rewrites on every carrying def in one
change":

- `consult_thread.description` gains one clause at its tail: "It never
  resumes or mutates the target — to push a message that the target acts on,
  use notify_thread." (Makes the sibling fork symmetric at selection time.)
- `workstream_prompt` needs **no edit**: its scope sentence ("DIRECT child …
  you spawned") already excludes peers, and adding a cross-reference would
  couple it to this def for no selection value. If implementation review
  disagrees, the one acceptable addition is "for a thread you do not parent,
  use notify_thread" appended to its guideline about direct children.
- Distinction from `intercom` (a pi-session-level user tool, not a provider
  tool in this array): no cross-reference from `notify_thread` — the two never
  co-occur in the same selection surface, so the reference would be ambient
  cost with no binding moment. If a skill doc ever compares them: intercom
  reaches *pi sessions on the machine* outside T3's thread graph;
  notify_thread reaches *T3 threads* with durable provenance and graph edges.

Before shipping, run the rubric's generative probe: give a model 3–4
scenarios (peer completion notice; wants-an-answer; ambiguous name; tempted to
steer a stranger's child) with the full tool array and check it selects and
composes correctly; adjust wording only on evidence.

## 4. File-by-file change list

| # | File | Change |
| --- | --- | --- |
| 1 | `packages/contracts/src/orchestration.loom.ts` | `MessageOrigin` += `"peer"`; `midTurnDelivery` in `LoomTurnStartFields`; `ThreadPeerMessageRecordCommand`; `ThreadPeerMessageRecordedPayload`; `OrchestrationThreadPeerMessageSummary`; shell field `peerMessages` (decode-defaulted `[]`); event/command name enums. |
| 2 | `packages/contracts/src/orchestration.ts` | `ThreadTurnStartRequestedPayload` += optional `midTurnDelivery` (loom-commented). |
| 3 | `packages/contracts/src/provider.ts` | `ProviderSendTurnInput` += optional `midTurnDelivery: "followUp"` (advisory; loom-commented). |
| 4 | `apps/server/src/mcp/toolPaths.ts` | `notify_thread: "/provider-tools/thread/notify"`. |
| 5 | `apps/server/src/mcp/WorkstreamSpawnHttp.ts` | `handleNotifyThread` (scope → resolve target by id/name → D3 rejections → D7 cap check → D5 framing → `thread.turn.start` dispatch with `origin: "peer"` + `midTurnDelivery: "followUp"` → best-effort `thread.peer-message.record` → rendered delivery disposition) + route layer; constants `NOTIFY_MESSAGE_MAX_CHARS`, `NOTIFY_PAIR_HOURLY_CAP`. |
| 6 | `apps/server/src/orchestration/decider.ts` | Carry `midTurnDelivery` from command into `thread.turn-start-requested` payload; server-only guard mirroring `reopen` (`decider.ts:849`). |
| 7 | `apps/server/src/orchestration/decider.loom.ts` | `case "thread.peer-message.record"` passthrough beside the consult case (~line 990). |
| 8 | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` | Thread `midTurnDelivery` through `processTurnStartRequested` → `buildSendTurnRequestForThread` (~line 782) → `ProviderSendTurnInput`. |
| 9 | `apps/server/src/provider/Drivers/PiDriver.ts` | `sendTurn` followUp branch (`streamingBehavior: "followUp"`, minted turnId, `pendingFollowUpTurnIds`); `agent_start` adoption of a pending followUp turn (~line 1533); stop/interrupt backstop settling pending ids via `thread.turn-start.fail`. |
| 10 | `apps/server/src/persistence/Migrations/064_ProjectionThreadPeerMessages.ts` + `Layers/ProjectionThreadPeerMessages.ts` + `Services/ProjectionThreadPeerMessages.ts` | New projection table + repository, shaped on `ProjectionThreadConsults` (048). |
| 11 | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` | Project `thread.peer-message-recorded` (idempotent by eventId, bounded preview, `refreshThreadShellSummary(sender)`), beside ~line 1394. |
| 12 | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` | `peerMessages` shell aggregation (pattern of `consults`, ~line 998); ordered-pair windowed count for the D7 cap. |
| 13 | `apps/server/src/orchestration/projector.ts` / `projector.loom.ts` | Extend the "events with no case fall through" comments (~lines 216 / 113). |
| 14 | `apps/server/src/provider/Drivers/Pi/providerToolDefs.ts` | The §3 tool def + the consult_thread companion clause. |
| 15 | `apps/web/src/components/chat/MessagesTimeline.tsx` | `MESSAGE_ORIGIN_LABELS.peer = "Peer thread"` (~line 898). |
| 16 | `apps/web/src/components/WorkstreamGraph.tsx` (+ `lib/forkJoinLayout.ts` if edge routing needs it) | Peer-message edge overlay from `peerMessages` (consult-overlay pattern, ~line 137). May land as fast-follow. |

## 5. Test surfaces

- `apps/server/src/mcp/WorkstreamSpawnHttp.test.ts` — handler: cross-tree
  target accepted (no D3 ownership error); self-send 400; terminal-lane 409;
  unstarted-child 409; fuzzy-name unambiguous send vs ambiguous
  candidates-no-send; size cap 400; pair cap 429; framing wrapper contains
  sender title/role/id and the raw message; `origin: "peer"` +
  `midTurnDelivery: "followUp"` on the dispatched command; recording is
  best-effort (a failing record still returns 200).
- `apps/server/src/orchestration/decider.*.test.ts` (new
  `decider.peerMessage.test.ts` beside `decider.handoffRecord.test.ts`) —
  passthrough event derivation; `midTurnDelivery` rejected on non-`server:`
  command ids; carried into `thread.turn-start-requested`.
- `apps/server/src/provider/Drivers/PiDriver.test.ts` — busy +
  `midTurnDelivery: "followUp"` sends `streamingBehavior: "followUp"` and
  returns a fresh turnId (not the active one); subsequent bare `agent_start`
  adopts the pending id and emits `turn.started`; idle send ignores the flag
  (plain turn); interrupt with pending followUps settles them (no lingering
  pending turn-start row); steer path byte-identical without the flag.
- `ProjectionPipeline` / snapshot-query tests — edge row idempotency, preview
  bounding, `peerMessages` aggregation, windowed pair count.
- `apps/server/src/provider/Drivers/Pi/providerToolDefs.test.ts` +
  `toolPaths.test.ts` — def present, route registered, name↔path coherence.
- `apps/web/src/components/chat/MessagesTimeline.test.tsx` — peer label
  renders.
- One end-to-end-ish handler test asserting the recipient's persisted
  `thread.message-sent` carries the framed text with `origin: "peer"`.

## 6. Open questions

1. **pi's followUp queue across abort/interrupt** — does pi still run queued
   followUps after an abort, or drop them? The D4 backstop (settle pending ids
   on stop/interrupt) is designed to be correct either way, but the
   implementation must verify the actual behaviour and, if pi *runs* them
   post-abort, ensure the adopted-turn path (not the backstop) wins. Verify
   with a live pi RPC probe before wiring the backstop's trigger points.
2. **Non-pi recipients** — `ProviderSendTurnInput.midTurnDelivery` is
   advisory; a busy recipient on a driver without a followUp lane would fold
   the message as a steer (violating the never-interrupt decision) or need a
   handler-side reject. All workstream/loom threads are pi today, so the
   proposal is: ignore-with-log in other drivers, note the limitation in
   `docs/architecture/providers.md`, and revisit if a non-pi recipient becomes
   real. Escalate if the user wants a hard reject instead.
3. **Attention-flag interaction** — a peer message that resumes an idle
   `needs_guidance` thread clears its flag (turn-start clears attention),
   potentially hiding a still-needed human. Proposal: accept (identical to a
   human send resuming it, and the thread will re-raise if still stuck), but
   this is a judgement call worth a reviewer's eye.
4. **Cap values** — `NOTIFY_MESSAGE_MAX_CHARS = 16_000` and
   `NOTIFY_PAIR_HOURLY_CAP = 10` are justified knobs (D7/D8), not
   architecture; tune freely on evidence.
5. **Graph overlay timing** — the event + shell edge ship with the tool; the
   `WorkstreamGraph` overlay may land as a fast-follow if the first PR is
   getting large.
