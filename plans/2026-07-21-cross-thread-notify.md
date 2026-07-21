---
manager_sessions:
  - id: 9ac69034-5f12-4fa9-81e7-1f2fd2985a1e
    role: plan
    authored_at: 2026-07-21T05:04:29.355Z
---

# `notify_thread` — global cross-thread push messaging

**Status:** design — revision 2 after independent review
(`workstream-reports/c29535b0-e7f4-4692-a4c2-43e7401ae657.md`). Rev 1 built
delivery on pi's `streamingBehavior: "followUp"` and assumed a queued follow-up
produces a fresh `agent_start` to adopt as a new T3 turn; installed pi
(0.80.10) drains follow-ups **inside** the running agent loop
(`pi-agent-core/dist/agent-loop.js:83,161-165,171` — one
`agent_start → agent_end` spans them; the true settled signal is
`agent_settled`, which T3 neither types nor handles), pi keeps draining the
queue after an agent abort (`agent-session.js:750-761,785-787,1171-1174`), the
sole pending-turn-start projection row cannot represent two queued sends
(`ProjectionTurns.ts:267-272`), and five active non-pi drivers share
`ProviderSendTurnInput`, making a driver-advisory flag unenforceable. Rev 2
replaces all of that with an **orchestration-layer durable defer queue**: no
driver is touched, delivery is always a plain fresh `thread.turn.start` on an
idle recipient. Rev 2 also makes the loop cap authoritative (decider-enforced),
makes framing relationship-aware, fixes the ambiguity renderer and the id/name
contract, and re-words the delivery disposition honestly.
**Date:** 2026-07-21
**Scope:** new provider tool + HTTP handler, one new `MessageOrigin` value,
three new events + a shell edge + a dispatcher delivery rail. No changes to
`workstream_prompt`, its D3 authorisation invariant, or ANY provider driver.

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
`workstream_prompt` variant; fully global authorisation (any thread to any
thread — including a parent to its own child); never interrupt a busy
recipient; fire-and-forget baseline with a loop guard; a recorded message edge
mirroring consults.

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
the name is the first line of that defence, the framing wrapper (D5), the
`message` parameter's anti-delegation guard (§3), and the loop guard (D7) the
rest.

### D2 — New origin value: `notify` (neutral, not "peer")

`MessageOrigin` (`packages/contracts/src/orchestration.loom.ts:562`) gains a
fifth literal:

```ts
export const MessageOrigin = Schema.Literals([
  "human",
  "kickoff",
  "orchestrator",
  "control_notice",
  "notify", // another thread pushed this via notify_thread (any relationship)
]);
```

Rev 1 called this `peer` and framed every send "not from your parent
orchestrator" — but authorisation is fully global, so the sender can be the
target's *actual parent* (or one of its children). Review finding #7: the
provenance value and UI label must not assert a relationship the send may not
have. `notify` states the *channel* neutrally; the relationship is carried in
the framing wrapper instead (D5), computed per send.

The axis stays clean: *who composed the words* = another agent thread, via the
notify channel (distinct from `orchestrator`, which is specifically a parent's
`workstream_prompt` steer/resume). Spoofing is impossible by the same
construction as the existing values: the origin is stamped server-side from
the authenticated scope (`scope.threadId`); `ClientThreadTurnStartCommand`
carries no `origin` field on the wire.

UI: `MESSAGE_ORIGIN_LABELS` in
`apps/web/src/components/chat/MessagesTimeline.tsx:898` gains
`notify: "Thread notification"` — the message renders with the existing info
tint + provenance chip.

### D3 — Authorisation: global, with sanity rejections (not ownership checks)

The handler does **not** call `authorizationError`
(`WorkstreamSpawnHttp.ts:199`) — that D3 "own thread or direct child"
invariant stays intact for `workstream_prompt` and the other mutating tools
(review-verified as structurally sound). `notify_thread` resolves its target
from `collectGraphThreads()` (`WorkstreamSpawnHttp.ts:1729` — active +
archived shells, the same universe `consult_thread` reaches).

What it rejects is not ownership but nonsense sends:

| Condition | Response |
| --- | --- |
| target is the caller itself | 400 — "You cannot notify your own thread." |
| target not found | 404 |
| both `threadId` and `name` supplied | 400 — exactly one identifies the target (D10) |
| target `planLane` is `done` or `cancelled` | 409 — sticky-terminal, mirroring `workstream_prompt` (the decider otherwise permits silent terminal re-engagement, `decider.ts:911-922`). Message names the lane and suggests the target's parent as the recipient instead. |
| target is archived | 409 — an archived thread must not accrue new turns. Consult reaches archived threads because it is read-only; a push is not. (Flagged as an open question in case the user wants delivery-on-unarchive instead.) |
| target is a workstream child whose kickoff was never delivered | 409 — "Target has not started yet; its kickoff belongs to its parent. Notify the parent, or wait for the target to launch." A peer message must never become a child's first turn: kickoff composition (role framing + brief) is exclusively the parent/dispatcher's. **Implementation note (review):** shells carry no `messages` (`orchestration.ts:430-452`), so after shell resolution the handler must fetch detail via `projection.getThreadDetailById` and apply the same predicate `handleWorkstreamPrompt` uses at `WorkstreamSpawnHttp.ts:2719-2723` (`isKickoffDelivered(...) || any assistant message`). |
| message over the size cap (D8) | 400 |
| ordered-pair send cap exceeded (D7) | 429 — surfaced from the decider rejection of the record command |

### D4 — Delivery: durable defer queue, delivered by the dispatcher on idle

**No driver changes. No `midTurnDelivery` field. No pi follow-up usage.**
Delivery is an orchestration-layer concern, reusing three proven pieces
verbatim: the atomic `requireIdle` gate, the receipt-dedup rail pattern, and
the dispatcher's event-driven pass.

**The flow:**

1. **Record first (durable enqueue).** After the D3 rejections pass, the
   handler dispatches `thread.peer-message.record` through the engine. The
   decider validates (including the D7 cap), appends
   `thread.peer-message-recorded`, and the projection inserts a pending row.
   This single event is simultaneously the delivery-queue entry, the
   observability edge (D9), and the cap ledger (D7) — one durable fact, three
   consumers. A record failure fails the tool call; **nothing is ever sent
   un-recorded** (inverting rev 1's best-effort recording, which review
   finding #5 showed is only acceptable when the record is pure
   observability).

2. **Immediate delivery attempt.** The handler then dispatches the delivery
   turn-start itself:

   ```ts
   yield* engine.dispatch({
     type: "thread.turn.start",
     commandId: CommandId.make(`server:notify-deliver:${recordEventId}`), // deterministic
     threadId: targetThreadId,
     message: {
       messageId, role: "user",
       origin: "notify",
       text: framedText,           // D5 wrapper, composed + persisted at record time
       attachments: [],
     },
     requireIdle: true,            // existing atomic gate, unchanged
     runtimeMode: target.runtimeMode,
     interactionMode: target.interactionMode,
     createdAt: now,
   } satisfies OrchestrationCommand);
   ```

   The `requireIdle` re-check runs **inside the serialized command boundary**
   (`OrchestrationEngine.ts:188-213`): accepted means the message-sent event
   is committed to the target's transcript and its turn is starting; a busy
   target raises `OrchestrationCommandDeferredError` **without writing a
   receipt**, so the deterministic command id stays redeliverable. The handler
   therefore knows the true disposition atomically — no advisory shell-read
   race (review finding #8): the tool result is either
   `delivered — committed to the target's transcript; its next turn is starting`
   or `queued — will be delivered when the target next goes idle`. (Provider
   failures *after* commit are the existing turn-start-fail machinery's job,
   identical to any human send; the result wording never claims the model
   acted on it.)

3. **Deferred delivery rail.** A new dispatcher rail,
   `deliverPendingNotifications`, joins `runPass` in
   `WorkstreamDispatcher.ts` (beside the digest flush, whose
   `deliverStandaloneDigest` at line 1995 is the exact pattern: `requireIdle`
   dispatch, deferral = retry next pass, `deliverOnce` receipt dedup). For
   each pending row, oldest-first per target:

   - target lane now `done`/`cancelled` (or thread archived) →
     dispatch `thread.peer-message.expire`
     (`server:notify-expire:<recordEventId>`) — sticky-terminal holds even for
     queued messages; the edge survives marked `expired`.
   - `wasDelivered(deliveryCommandId)` (receipt exists but row still pending —
     crash between turn-start accept and the mark) → dispatch
     `thread.peer-message.mark-delivered` (reconciliation; idempotent).
   - otherwise → `dedup.deliverOnce(deliveryCommandId, turn-start as above)`;
     on `delivered`, dispatch `thread.peer-message.mark-delivered`.

   Only the **oldest** pending message per target is attempted per pass: the
   accepted delivery makes the target busy, and the next `thread.session-set`
   (already in the dispatcher's trigger subscription, line 2944) re-runs the
   pass for the next one — strict FIFO with one notification per turn, clean
   per-message attribution, no batching ambiguity. This resolves review
   finding #3 (the single pending-turn-start row never has to represent two
   queued sends: at most one notify turn-start is in flight per target, by
   construction).

   Trigger wiring: add `thread.peer-message-recorded` to the dispatcher's
   event subscription filter (`WorkstreamDispatcher.ts:2919-2947`) so a fresh
   queue entry runs a pass promptly even when the handler's immediate attempt
   deferred; `thread.session-set` and the startup reconciliation
   `worker.enqueue()` (line 2954) already cover drain-on-idle and
   crash/restart.

**Why this beats the rev 1 pi-followUp design on every review axis:**

- **#1 (false lifecycle):** no reliance on pi's follow-up event shape at all;
  no `agent_settled` typing; no turn adoption. `followUpMode` (one-at-a-time
  vs `all`, `pi docs/settings.md` "Message Delivery") becomes irrelevant.
- **#2 (abort semantics):** interrupt/stop/crash of the target never
  interacts with delivery — the queue is event-sourced server state, not pi
  process state. A target that is aborted simply goes idle (session-set) and
  the rail delivers.
- **#3 (queue representability):** FIFO and multi-sender queueing live in the
  projection table; the turns system only ever sees one ordinary turn-start
  at a time.
- **#4 (driver independence):** delivery is a plain fresh turn-start on an
  idle thread — semantically identical for Claude/Codex/Cursor/OpenCode/Grok
  and pi. "Never interrupt" is enforced by the orchestration layer for every
  driver, unconditionally.

**Trade-off, stated honestly:** rev 1's pi follow-up would have delivered
into a *busy* recipient at its next internal turn boundary (sub-minute);
the defer queue delivers when the recipient's whole T3 turn ends. For an
unsolicited notification this latency is acceptable by design — the user's
"never interrupt" decision already accepts that a busy recipient reads it
later; "later" being turn-end rather than round-boundary is the price of
driver independence and correct accounting, and it buys strict FIFO for free.

### D5 — Recipient framing wrapper (relationship-aware)

Composed server-side at **record time** from the authenticated sender's shell
and the resolved target shell (so the persisted bytes are stable regardless of
when the rail delivers), and stored on the recorded event alongside the raw
message. The relationship line is computed from `parentThreadId` on both
shells:

- sender is target's parent → `your parent orchestrator`
- target is sender's parent → `one of your sub-threads`
- otherwise → `no parent/child relationship to you`

```
Notification from thread «{senderTitle}» ({senderRole ?? "thread"}, {senderThreadId}; {relationship}), sent via notify_thread:

{message}

No reply is owed. If this needs no action from you, absorb it and continue your work. If the sender asked for something back, reply with notify_thread (threadId: {senderThreadId}).
```

Properties: the recipient can tell at a glance which thread this is and what
it is to them (fixing review #7 without rejecting parent→child sends, which
would violate the fixed any-to-any decision); reply symmetry is explicit and
carries the exact id (no name-resolution round trip); the no-reply-owed
default is stated at the binding moment — in the recipient's context, where
the acknowledge-reply loop would otherwise start (D7).

The framed text is what lands in the recipient's transcript
(`thread.message-sent` with `origin: "notify"`), so provenance is durable and
visible; the recorded edge event (D9) stores both raw and framed text.

### D6 — Fire-and-forget contract

The tool result confirms disposition only — `delivered` (committed to the
target transcript, turn starting) or `queued` (durably pending, delivered at
the target's next idle) — and never carries a reply. A caller that needs an
answer has two honest options, both named in the tool description:
`consult_thread` (synchronous read-only Q&A, no engagement of the target's
real session) or asking the recipient to `notify_thread` back (asynchronous,
arrives as a future inbound message, not as this call's result).

### D7 — Loop safety: decider-enforced durable cap

Two layers:

1. **Register**: the framing (D5) states "no reply is owed" and gives the
   recipient an explicit condition for replying. This kills the politeness
   ping-pong at the source.
2. **Authoritative rate cap, enforced in the decider** (review finding #5:
   a handler-side projection count is check-then-record and fails open under
   concurrency or a failed record; here the ledger is load-bearing, not
   observability). The thread read model gains a small pruned send log —
   `notifySendLog: ReadonlyArray<{ targetThreadId, at }>` in
   `LoomThreadFields` (`orchestration.loom.ts:~360`, decode-defaulted `[]`)
   — maintained by the projector from `thread.peer-message-recorded` events
   (pruned to the rolling window on each append, so it stays bounded). The
   decider's `thread.peer-message.record` case counts window entries for the
   ordered pair (sender → target) and rejects at
   `NOTIFY_PAIR_HOURLY_CAP = 10`. The decider runs serially inside the
   command boundary, so check-then-append is atomic; the log is event-sourced,
   so it is replay- and restart-safe. **A recorded-but-expired or
   recorded-but-not-yet-delivered message counts as an attempt** — the cap
   meters send pressure, not delivery success (a runaway loop must not get
   free retries because its target was busy).

Rationale for 10/hour: legitimate uses are sparse (completion notices,
occasional info handoffs — a few per pair per session); a runaway A↔B loop is
turn-paced, so even a slow loop hits the cap within the hour and both
directions get told to stop. No round counter, no conversation state.

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

### D9 — Observability: recorded/delivered/expired events + shell edge

Mirrors the consult pipeline (command → decider → projection row → shell
aggregation → graph overlay; the analogue is review-verified real:
`decider.loom.ts:986-1014`, `ProjectionPipeline.ts:1390-1408`, migration 048),
extended with a delivery lifecycle because the row is also the queue:

- **Commands** (`orchestration.loom.ts`, beside `ThreadConsultRecordCommand`
  ~line 907):
  - `thread.peer-message.record` — `{ commandId, threadId /* sender =
    aggregate */, targetThreadId, targetTitle, message, framedMessage,
    createdAt }`. Dispatched by the handler; decider validates + enforces the
    D7 cap.
  - `thread.peer-message.mark-delivered` / `thread.peer-message.expire` —
    `{ commandId, threadId /* sender */, recordEventId, createdAt }`.
    Server-only (rejected on non-`server:` command ids, mirroring the `reopen`
    guard at `decider.ts:844-853`); dispatched by the handler (immediate
    delivery) or the dispatcher rail.
- **Events**: `thread.peer-message-recorded` (full raw + framed text, status
  `pending`), `thread.peer-message-delivered`, `thread.peer-message-expired`
  — registered in the event/command enums (`orchestration.loom.ts:~1401/1461`).
- **Projection**: migration `064_ProjectionThreadPeerMessages.ts` (registry
  currently ends at 063 — verified free) + repository
  `ProjectionThreadPeerMessages` (Layers + Services), shaped on
  `ProjectionThreadConsults` (048) plus queue columns: eventId (idempotency),
  senderThreadId, targetThreadId, targetTitle, message, framedMessage,
  messagePreview (bounded), status (`pending | delivered | expired`),
  createdAt, deliveredAt. Projected in `ProjectionPipeline.ts` beside the
  consult case (~line 1394), with `refreshThreadShellSummary(sender)` on each
  status change. The rail's pending-scan is one indexed query
  (`status = 'pending'` by target, oldest first).
- **Read model**: `notifySendLog` on the thread aggregate (D7), maintained in
  `projector.loom.ts`; fall-through comments extended
  (`projector.ts:216`, `projector.loom.ts:113`).
- **Shell**: `OrchestrationThreadPeerMessageSummary`
  (beside `OrchestrationThreadConsultSummary`, ~line 319):
  `{ targetThreadId, targetTitle, count, pendingCount, lastMessageAt,
  lastMessagePreview }`; shell field `peerMessages` (decode-defaulted `[]`,
  beside `consults` at ~line 486); aggregation in
  `ProjectionSnapshotQuery.ts` (~line 998 pattern).
- **Graph**: `WorkstreamGraph.tsx` draws a message-edge overlay from
  `peerMessages` as the consult overlay does (~line 137), distinct colour,
  pending edges dashed. The event + shell edge ship with the tool; the
  overlay may land as a fast-follow.

### D10 — Target resolution: exactly one of id or name

Reuse `rankThreadsByName` / `isUnambiguousMatch` exactly as
`handleWorkstreamConsultThread` (`WorkstreamSpawnHttp.ts:3161-3184`), with two
corrections from review finding #6:

- **Exactly one of `threadId` or `name`; both present is a 400.** (Rev 1
  contradicted itself: prose said threadId-wins, the param said not-both. For
  a side-effectful send, silent precedence hides a caller bug; consult's
  lenient precedence stays as-is.)
- **A notification-specific candidate renderer.** The existing
  `renderConsultCandidates` (`workstreamRender.ts:239-256`) hard-codes "call
  consult_thread again" — reusing it would instruct the caller to invoke the
  wrong tool. Parameterise it (`renderThreadCandidates(candidates, { toolName,
  action })`) with consult passing its current strings, or add a sibling
  `renderNotifyCandidates`; either way one shared line-format, two follow-up
  instructions.

An ambiguous name returns ranked candidates and **sends nothing** (a
misdelivered push engages the wrong thread's session — worse than a
misdelivered consult).

## 3. Tool definition (the deliverable wording)

Authored to `docs/architecture/tool-def-authoring.md` (the delegation-thread
rubric). Entry in
`apps/server/src/provider/Drivers/Pi/providerToolDefs.ts`; route in
`toolPaths.ts`. Shipped prose avoids em dashes per the rubric's agreed style
(this plan document uses them; the tool text below does not).

```ts
{
  name: "notify_thread",
  label: "Notify Thread (cross-thread push)",
  description:
    "Push a markdown message into ANY other thread the server knows, across orchestration trees, worktrees, and projects: the write counterpart of the read-only consult_thread. Delivery never interrupts. An idle recipient starts its next turn with your message (it will spend tokens acting on it); a busy recipient has it queued durably, then delivered as a fresh turn when it next goes idle. The recipient sees it framed as a notification from your thread (title, id, and your relationship to it, if any) and owes no reply: this call is fire-and-forget, and its result reports 'delivered' or 'queued', never an answer. Use it to tell a thread something it is waiting to hear, e.g. \"the extraction run you depend on is complete; results at <path>\". It is NOT for getting information back (consult_thread asks a read-only question and returns the answer), not for directing your own children (workstream_prompt), not for reporting to your parent (workstream_submit), not for creating work (workstream_spawn), and not for reaching non-T3 pi sessions on this machine (intercom); notify_thread addresses durable T3 threads and leaves transcript and graph provenance. Identify the target by threadId, or by name (fuzzy sidebar-title match); an ambiguous name sends nothing and returns ranked candidates.",
  promptSnippet:
    "push a fire-and-forget message into any other thread, by id or name; it never interrupts the recipient.",
  promptGuidelines: [
    "notify_thread's result is the end of the exchange; no reply arrives through it. Need an answer? consult_thread the target, or ask it (in your message) to notify_thread you back and carry on until that arrives.",
    "An unresolved name returns candidates and sends nothing: confirm the intended target, then call again with its threadId. A push engages the recipient's session, so never guess.",
  ],
  parameters: {
    type: "object",
    properties: {
      threadId: {
        type: "string",
        description:
          "Exact id of the target thread, preferred when known (from workstream_list, a prior consult, or an @-mention [Title](thread://<id>)). Provide exactly one of threadId or name; supplying both is rejected.",
      },
      name: {
        type: "string",
        description:
          "Fuzzy sidebar title of the target thread, used when you do not have an exact id. An ambiguous match returns ranked candidates without sending; supplying name together with threadId is rejected.",
      },
      message: {
        type: "string",
        description:
          "The markdown message the recipient receives, framed as a notification from your thread. It lands in another agent's context with none of yours, so write it self-contained: state what you are informing it of, reference your outputs by absolute path instead of pasting bulk content, and say plainly if you are asking for anything back (the framing tells the recipient the default is nothing). A notification informs; it must never re-task, steer, or covertly delegate. To direct work, prompt your own child (workstream_prompt) or spawn a new one (workstream_spawn).",
      },
    },
    required: ["message"],
    additionalProperties: false,
  },
  errorMode: "throw",
  fallbackText: "Notification accepted.",
}
```

### Why this wording obeys the rubric

- **Register**: second person, imperative, addressed to the calling agent at
  the selection moment; every sentence is behaviour-shaping ("an ambiguous
  name sends nothing", "the result reports 'delivered' or 'queued', never an
  answer"), not API reference.
- **When/when-not with named alternatives**: the description routes every
  rejected branch to its sibling (`consult_thread`, `workstream_prompt`,
  `workstream_submit`, `workstream_spawn`, `intercom`). The `intercom`
  boundary is included because the tools DO co-occur in real T3 tool surfaces
  (review corrected rev 1's contrary claim): intercom addresses live pi
  sessions on the machine; notify_thread addresses durable T3 threads with
  transcript/graph provenance.
- **`promptSnippet` is capability discovery only** (review punch-list):
  what exists and its one defining property (never interrupts); the idle/busy
  mechanics live in the description, read at selection time.
- **Recipient characterised at composition time**: `message` is an
  artefact-crossing parameter; its description names the reader (another
  agent with none of the caller's context) and the register (self-contained,
  paths not bulk, expectation-explicit) — the rubric's recipient-blindness
  guard applied where it binds.
- **The covert-delegation failure mode is guarded explicitly on the
  parameter** (review punch-list): "must never re-task, steer, or covertly
  delegate", with the legitimate channels named. Rev 1's "what the recipient
  needs to know or do" invited exactly that misuse; "do" is gone.
- **Honest disposition**: "delivered" is used only for the committed-to-
  transcript case the handler can atomically know (D4); nothing claims the
  recipient acted. `fallbackText` says "accepted", not "delivered" — the
  fallback fires precisely when the server's rendered disposition is missing.
- **No schema restatement**: the one handler-enforced conditional JSON schema
  cannot express (exactly-one-of threadId/name) is correctly in prose, stated
  identically on both parameters.
- **Guidelines carry only post-call duties** (2 bullets), binding after the
  call when schema salience is gone; neither contradicts the parameter text.
- **No paraphrase-drift coupling**: "the write counterpart of the read-only
  consult_thread" references consult_thread's *contract* (read-only), not a
  restatement of its definition.
- **No em dashes in any shipped string** (description, snippet, guidelines,
  parameter texts, fallback).

### Companion wording edits (same change, no drift)

- `consult_thread.description` gains one clause at its tail: "It never
  resumes or mutates the target; to push a message the target acts on, use
  notify_thread." (Makes the sibling fork symmetric at selection time.)
- `workstream_prompt` needs **no edit**: its scope sentence ("DIRECT child …
  you spawned") already excludes non-children, and a cross-reference would
  couple it to this def for no selection value. If implementation review
  disagrees, the one acceptable addition is "for a thread you do not parent,
  use notify_thread" appended to its direct-children guideline.

Before shipping, run the rubric's generative probe: give a model 4-5
scenarios (peer completion notice; wants-an-answer; ambiguous name; tempted
to re-task a stranger's thread via the message body; choosing between
notify_thread and intercom) with the full tool array and check selection and
composition; adjust wording only on evidence.

## 4. File-by-file change list

| # | File | Change |
| --- | --- | --- |
| 1 | `packages/contracts/src/orchestration.loom.ts` | `MessageOrigin` += `"notify"`; `notifySendLog` in `LoomThreadFields` (decode-defaulted `[]`); `ThreadPeerMessageRecordCommand` / `MarkDeliveredCommand` / `ExpireCommand`; `ThreadPeerMessageRecordedPayload` / `DeliveredPayload` / `ExpiredPayload`; `OrchestrationThreadPeerMessageSummary`; shell field `peerMessages`; event/command name enums. |
| 2 | `apps/server/src/mcp/toolPaths.ts` | `notify_thread: "/provider-tools/thread/notify"`. |
| 3 | `apps/server/src/mcp/WorkstreamSpawnHttp.ts` | `handleNotifyThread`: scope → resolve target (exactly-one-of id/name, consult-style ranking) → D3 rejections (incl. detail fetch for the kickoff-delivered predicate) → compose + persist framing via `thread.peer-message.record` (decider may 429) → immediate `thread.turn.start` attempt (`requireIdle: true`, deterministic `server:notify-deliver:<recordEventId>`) → on accept, `thread.peer-message.mark-delivered`; on `OrchestrationCommandDeferredError`, report `queued`. Route layer; constants `NOTIFY_MESSAGE_MAX_CHARS`, `NOTIFY_PAIR_HOURLY_CAP`. |
| 4 | `apps/server/src/mcp/workstreamRender.ts` | Parameterise the candidate renderer (tool name + follow-up action); notify disposition rendering (`delivered` / `queued` texts). |
| 5 | `apps/server/src/orchestration/decider.loom.ts` | `thread.peer-message.record` case: validate, enforce the pair cap against `notifySendLog` (serial, atomic), append recorded event. `mark-delivered` / `expire` cases: server-only guard (mirror `decider.ts:844-853`), passthrough. |
| 6 | `apps/server/src/orchestration/projector.loom.ts` (+ fall-through comments in `projector.ts:216` / `projector.loom.ts:113`) | Maintain `notifySendLog` (append + prune-to-window) from recorded events. |
| 7 | `apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts` | New rail `deliverPendingNotifications` in `runPass` (pattern of `deliverStandaloneDigest`, line 1995): per target oldest-first pending row → expire (terminal/archived) / reconcile (`wasDelivered`) / `deliverOnce` + mark-delivered. Add `thread.peer-message-recorded` to the trigger subscription (~line 2919). |
| 8 | `apps/server/src/persistence/Migrations/064_ProjectionThreadPeerMessages.ts` + `Layers/ProjectionThreadPeerMessages.ts` + `Services/ProjectionThreadPeerMessages.ts` | Projection table + repository (queue + edge + preview columns, status lifecycle, indexed pending-by-target scan). |
| 9 | `apps/server/src/orchestration/Layers/ProjectionPipeline.ts` | Project the three events (idempotent by eventId; status transitions; `refreshThreadShellSummary(sender)`), beside ~line 1394. |
| 10 | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` | `peerMessages` shell aggregation (pattern of `consults`, ~line 998). |
| 11 | `apps/server/src/provider/Drivers/Pi/providerToolDefs.ts` | The §3 tool def + the consult_thread companion clause. |
| 12 | `apps/web/src/components/chat/MessagesTimeline.tsx` | `MESSAGE_ORIGIN_LABELS.notify = "Thread notification"` (~line 898). |
| 13 | `apps/web/src/components/WorkstreamGraph.tsx` (+ `lib/forkJoinLayout.ts` if edge routing needs it) | Peer-message edge overlay from `peerMessages` (consult-overlay pattern, ~line 137); pending edges dashed. May land as fast-follow. |

Explicitly **not** touched (rev 1 items removed): `packages/contracts/src/provider.ts`,
`apps/server/src/orchestration/decider.ts` (no new turn-start field),
`ProviderCommandReactor.ts`, `PiDriver.ts`, `RpcProcess.ts` — no
`midTurnDelivery`, no follow-up lifecycle, no driver changes of any kind.

## 5. Test surfaces

- `apps/server/src/mcp/WorkstreamSpawnHttp.test.ts` — handler: cross-tree
  target accepted (no D3 ownership error); self-send 400; both-id-and-name
  400; terminal-lane 409; archived 409; unstarted-child 409 (predicate reads
  thread *detail*, not the shell); fuzzy-name unambiguous send vs ambiguous
  candidates-no-send with the notify renderer text; size cap 400; cap
  rejection surfaces as 429; idle target → `delivered` + mark-delivered
  dispatched; busy target → deferred, row stays pending, result says
  `queued`; framing contains sender title/role/id and the correct
  relationship line for parent/child/unrelated; `origin: "notify"` on the
  dispatched command; a failed record fails the call and delivers nothing.
- `apps/server/src/orchestration/decider.peerMessage.test.ts` (new, beside
  `decider.handoffRecord.test.ts`) — recorded/delivered/expired event
  derivation; cap enforced at the boundary (10th accepted, 11th rejected;
  window pruning; per-ordered-pair isolation; serial atomicity);
  `mark-delivered`/`expire` rejected on non-`server:` command ids.
- `apps/server/src/orchestration/Layers/WorkstreamDispatcher.test.ts` — rail:
  delivers oldest pending on idle target via `deliverOnce`; busy target
  deferred with nothing recorded (redeliverable); two pending from different
  senders delivered FIFO across successive passes; terminal/archived target →
  expired; crash-window reconciliation (receipt exists, row pending → marked
  delivered without re-delivery); `thread.peer-message-recorded` triggers a
  pass.
- `projector.loom` tests — `notifySendLog` append + prune; replay rebuilds
  the same log.
- `ProjectionPipeline` / snapshot-query tests — row idempotency, status
  transitions, preview bounding, `peerMessages` aggregation with
  `pendingCount`.
- `apps/server/src/provider/Drivers/Pi/providerToolDefs.test.ts` +
  `toolPaths.test.ts` — def present, route registered, name↔path coherence;
  assert no em dash in any `notify_thread` string (cheap drift guard for the
  style rule).
- `apps/web/src/components/chat/MessagesTimeline.test.tsx` — notify label
  renders.
- One end-to-end-ish handler test asserting the recipient's persisted
  `thread.message-sent` carries the framed text with `origin: "notify"`.

## 6. Open questions

1. **Archived targets** — this design rejects them (409): a push engages a
   session, and an archived thread should not accrue turns. Alternative:
   accept + queue, delivering only if the thread is unarchived (the expire
   rail would need an unarchive-aware predicate). Rejecting is simpler and
   reversible; escalate if the user has a live archived-notify case.
2. **Queue-jumping by the target's own human/parent** — a pending
   notification delivers at the *next* idle; if a human sends first, the
   notification waits for the following idle window (the `requireIdle` gate
   defers it). This is correct by the never-interrupt decision but means a
   chatty target can starve delivery for a while. Accept, or add a
   max-pending-age nudge (dispatcher raises a parent-visible notice when a
   pending notification exceeds e.g. 30 min)? Proposed: accept for v1; the
   pending edge is visible in the graph.
3. **Attention-flag interaction** — a delivered notification that resumes an
   idle `needs_guidance` thread clears its flag (turn-start clears
   attention). Proposal: accept (identical to a human send resuming it; the
   thread re-raises if still stuck) — review agreed this is tune-later.
4. **Cap values** — `NOTIFY_MESSAGE_MAX_CHARS = 16_000` and
   `NOTIFY_PAIR_HOURLY_CAP = 10` are justified knobs (D7/D8), tune on
   evidence. Also decide whether the cap should additionally have a global
   per-sender ceiling (e.g. 30/hour across all targets) — cheap to add in the
   same decider case; proposed: not in v1.
5. **Graph overlay timing** — the events + shell edge ship with the tool; the
   `WorkstreamGraph` overlay may land as a fast-follow if the first PR is
   getting large. "Recorded edge" is satisfied on day one at the data level.
6. **Delivery guarantee wording** — the design gives at-most-once transcript
   delivery per message (deterministic command id + receipt), with
   crash/restart recovery via the startup reconciliation pass and the
   `wasDelivered` reconciliation leg. A message can end `expired` without the
   sender ever learning (fire-and-forget). If senders turn out to need a
   delivery signal, a future `notify_thread` result-query or a sender-side
   control notice can read the row status — out of scope for v1.
7. **pi follow-up mode** — considered and rejected as the delivery mechanism
   (see revision note). If T3 later wants sub-turn-boundary delivery into
   busy pi recipients, that is an additive optimisation of the rail's
   delivery leg for the pi driver only, and would require typing
   `agent_settled` and pinning `followUpMode`; nothing in this design
   forecloses it.
