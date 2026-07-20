---
manager_sessions:
  - id: bd585687-c2c3-4e22-9db8-d4c6559a3d5a
    role: plan
    authored_at: 2026-07-19T11:30:24.995Z
---

# `/handoff` — fork-then-handoff with a throwaway drafter

_Revision 2 — amended after plan review (report:
`/home/Carl/.t3/cockpit/userdata/workstream-reports/65399b64-ed1e-4d86-9215-05ec83286941.md`).
Rev 1's D4 targeted the wrong reuse seam (the dispatcher kickoff is child-only);
rev 2 routes the drafter launch through the existing WS bootstrap
(`thread.turn.start` + `bootstrap.createThread`), names the real turn-end signal
(`thread.session-set` leaving `running`), makes settlement a convergent
sequence with session-stop before archive, and pins the composer intercept to
`ChatView.onSend` (the actual send authority), with typed parse and no
fall-through._

## 1. Motivation

Today, when the human discovers out-of-scope work mid-thread, they instruct the
thread to `goal_handoff`. The handoff itself is cheap, but the *drafting* turn
pollutes the source thread: a comprehensive description of an out-of-scope issue
now lives in the transcript, and the model keeps re-attending to it — tracking
the handed-off work, asking about it, spending attention on something that
should hold none. This compounds across multiple handoffs.

The fix: the handoff must **never appear in the source thread at all**.
`/handoff <explanation>` in the composer is intercepted client-side (the message
never becomes a turn in the source thread), the session is natively forked, and
the **fork** — a throwaway "drafter" with the full source context — composes the
brief and calls `goal_handoff`. The drafter terminates immediately after and is
auto-archived; it persists only as a frozen consult target for the receiving
agent. Fire-and-forget: the human never interacts with the drafter (confirmed
preference); the rare brief edit happens on the staged destination thread's
kickoff card, which is a better edit surface anyway.

## 2. Design summary

```
human composer: "/handoff the retry logic in FooService is broken, out of scope here"
        │  (client-side intercept — NO turn-start on the source thread)
        ▼
ws application operation `thread.handoff-draft` { sourceThreadId, explanation }
        │  (internal `thread.turn.start` with `bootstrap.createThread`:
        │   ROOT fork of source — forkFromThreadId=source, parentThreadId=null,
        │   role="handoff-drafter" — drafter prompt as the first turn,
        │   origin:"kickoff", setInProgress:true)
        ▼
drafter (full source context via native pi fork)
        │  drafts brief, calls goal_handoff
        ▼
drafter calls goal_handoff — once, or N times for N separate issues
        │  each call: brief += consult pointer to the drafter (frozen snapshot)
        ▼
staged destination goal(s)/thread(s) (existing StagedKickoffCard, one-send launch)
        ▼
drafter turn ENDS (session-set leaves `running`) ⇒ settlement reactor:
        ├─ ≥1 handoff recorded → done → session stop → thread.archive
        └─ 0 handoffs → needs_guidance (visible failure)
```

Source transcript is byte-identical to a world where the handoff never
happened. The only visible artefact is the staged destination.

## 3. Decisions

### D1 — Loom feature, not a pi extension

The earlier "pi extension" framing dissolves once the design requires (a) a
client-side composer intercept so the message never becomes a turn, and (b) UI
invisibility/auto-archive rules. Both live in loom. The drafter uses the
existing `goal_handoff` provider tool; no new pi-side surface is needed beyond
the generated extension loom already ships.

### D2 — Composer intercept (`apps/web`)

(Amended per review must-fix 5: `ChatComposer` merely calls `onSend`; the send
authority that creates optimistic messages and dispatches `thread.turn.start`
is `ChatView.onSend` — that is where the intercept must live.)

- Add a built-in `/handoff` slash-command item next to `/model`/`/plan`/`/default`
  in `ChatComposer.tsx` (~line 972). Unlike those, selecting it inserts
  `/handoff ` into the prompt (the provider-slash-command insertion pattern,
  ~line 1646) because it takes free-text input.
- Typed parse in `composer-logic.ts`: `parseHandoffDraft(text)` returning
  `not-handoff | empty-error | handoff(explanation)` — unit-testable.
- Branch on it in `ChatView.onSend` BEFORE `beginLocalDispatch`, optimistic
  source-message insertion, context expansion, and `startThreadTurn`; every
  recognised `/handoff` branch returns — fall-through to a normal turn-start is
  structurally impossible.
- Attachments/terminal contexts/element/preview/review comments present with a
  recognised `/handoff` ⇒ reject inline for MVP, preserving the draft (never
  silently discard, never fall through). Deliberate MVP restriction, not
  settled design — attaching e.g. a screenshot to a handoff is a legitimate
  follow-up.
- Transport: a dedicated WS RPC/application handler — NOT a new member of the
  client command union, which would route through normalisation into the
  decider (`orchestration.loom.ts:963-988`, `ws.ts:790-802`) where no handler
  exists for this compound operation.
- Clear the composer only after the handoff-draft RPC succeeds; preserve the
  draft on failure. Empty explanation ⇒ inline composer error, no send.
- The item is hidden when the active thread is not pi-backed (D7) or is
  currently running a turn (D8).

### D3 — Drafter thread shape: ROOT fork, never a workstream child

The obvious alternative — spawn the drafter as a workstream child of the source
— is **rejected**: child lifecycle events wake/digest into the parent
(`WorkstreamDispatcher` parent-wake rails), which would re-pollute the source
thread through the control plane instead of the transcript. Instead the drafter
mirrors `ThreadForkHttp.ts`:

- `parentThreadId: null` (out of every delegation rail: dispatcher, wake,
  digest, fan-in all skip roots),
- `forkFromThreadId: sourceThread.id` (native `pi --fork` at first launch,
  fork-once, handled in `PiDriver`/`ProviderCommandReactor.ensureSessionForThread`),
- `role: "handoff-drafter"` — the marker every special-casing keys off,
- inherits source worktree/branch/model/runtime (drafter is read-mostly; the
  shared-worktree MVP note in `ThreadForkHttp.ts` applies even more weakly here),
- title: `Handoff: <explanation truncated ~50 chars>` at creation; the drafter
  may `set_thread_title` to the final goal title once known.

### D4 — Launch path: WS bootstrap turn-start, NOT the dispatcher kickoff

(Reworked per review must-fix 1.) The dispatcher kickoff is child-only: its
selection rejects roots, and its prompt wrapper (`workstreamChildPrompt.ts`)
tells the actor it is a sub-thread that must `workstream_submit` — a false
completion contract that contradicts the throwaway-root design. Do NOT reuse
it, and do NOT store a kickoff-brief file.

Instead, handle `thread.handoff-draft` as an application-level WS operation
that constructs an internal `thread.turn.start` with `bootstrap.createThread`
(`packages/contracts/src/orchestration.ts:618-670`; existing bootstrap
dispatcher with compensating deletion at `apps/server/src/ws.ts:689-787`):
`parentThreadId: null`, `role: "handoff-drafter"`, `forkFromThreadId: source`,
inherited goal/worktree/runtime, the drafter prompt as the turn's message,
`origin: "kickoff"`, `setInProgress: true`, curated drafter title (not
bootstrap's seed title).

Atomicity, stated honestly: the turn + lane transition is one engine
transaction; create + turn is the bootstrap's compensating two-step (deletion
on failure), not atomic — acceptable, no new compound decider command for MVP.

**Model policy:** strongly prefer reading the source's captured launch-identity
record and seeding the drafter with the captured instance/model/options (the
dispatcher's analogous re-seed: `WorkstreamDispatcher.ts:1835-1848,1932-1946`;
pi applies `startInput.modelSelection` on a fork-first launch,
`PiDriver.ts:1873-1888,1911-1941`) — the projected `sourceThread.modelSelection`
can be stale after rerouting. If extraction proves disproportionate, copying
the projected selection (what `thread_fork` ships today) is an acceptable
degraded fallback — flag it in review. Source-captured model is the MVP
policy; a cheaper drafter model is a later experiment.

The kickoff prompt template (server-side constant):

> You are a handoff drafter forked from the preceding session with its full
> context. The human has flagged out-of-scope work: `<explanation>`. Draft a
> focused brief for it and call `goal_handoff` (title, brief, description; name
> a `project` if the work belongs elsewhere). If the human flags multiple
> separable issues, use your judgment: one goal if they belong together, one
> `goal_handoff` call per goal if they should proceed independently. Do NOT do
> the work itself, and do not write exhaustive briefs — omissions are
> recoverable because the receiving agent can consult this frozen session. End
> your turn once every handoff is placed; you are then archived automatically.

### D5 — Termination at TURN END, not at the first `goal_handoff` call

A drafter may legitimately place **multiple** handoffs in one turn (the human
flags two separable issues; the drafter splits them into two goals). Archiving
on the first `goal_handoff` call would terminate it mid-task, so termination is
settled once, at turn end, by a single authority:

1. **Per-call, in `GoalHandoffHttp.ts`** when the caller's
   `role === "handoff-drafter"`: append to the brief (same pattern as
   `goal_continue`'s predecessor pointer): *"Context snapshot: thread
   `<drafterId>` holds a frozen fork of the originating session at handoff
   time; `consult_thread` it for anything this brief omits."* This is the
   pressure-release valve that lets briefs be focused rather than exhaustive.
   Also stamp a durable handoff marker on the drafter thread: a
   `thread.handoff-recorded` event projecting to `handoffCount` on the read
   model (durable because settlement must survive restart; no `lastHandoffAt`).
   Stamp it only AFTER the staged destination thread is created, and include
   the destination goal/thread ids in the payload. NO lane change or archive
   here.
2. **At turn end, in the settlement reactor** (the same authority as D6's
   backstop — one reactor, several branches). There is no `turn.completed`
   domain event: provider ingestion converts turn completion into
   `thread.session-set`, and the projection treats *leaving `running`* as the
   authoritative turn-end (`ProviderRuntimeIngestion.ts:1629-1716`,
   `ProjectionPipeline.ts:1661-1689`). The reactor therefore subscribes to
   `thread.session-set`, re-reads the projected thread, and acts only when
   `role === "handoff-drafter"`, a real latest turn exists for the kickoff,
   that turn is terminal, and the session is no longer running it — it MUST
   ignore the initial ready session-set emitted before `turn.started`
   (misclassifying a normal first launch as zero-handoff failure would raise
   attention on every healthy handoff — goal-defeating).
   - ≥1 recorded handoff ⇒ convergent success sequence: lane `done` → request
     `thread.session.stop` → `thread.archive`. The session stop is mandatory:
     decider-level archive is projection-only metadata, and the WS client
     archive handler's teardown (`ws.ts:860-925`) is client-side and must NOT
     be the reactor's path — without an explicit stop every settled drafter
     leaks a live pi process.
   - zero ⇒ raise `needs_guidance` (drafter waffled, errored, or stopped short).
   - Deterministic receipt ids keyed by drafter id + settled turn id, plus the
     same reconciliation scan at reactor startup, so a crash between done /
     stop / archive converges safely and settlement survives restarts.

Don't trust the model to clean up after itself — it ends its turn; the server
settles. Kept-but-archived is exactly the agreed semantics: the session file
persists as a consult target (all N destination briefs point at the same frozen
fork — `consult_thread` explicitly resolves archived threads,
`WorkstreamSpawnHttp.ts:3063-3115`); the UI forgets it. Archive may race the
final assistant-text projection; benign, since archive is metadata-only.
Destination deletion is user-authoritative: it never decrements `handoffCount`
nor retro-fails the drafter — the marker records that a handoff was placed.

### D6 — Visibility: invisible when healthy, visible when broken

- `Sidebar.logic.loom.ts` already filters `archivedAt !== null`; a clean drafter
  archives within one turn and is barely seen.
- While alive, suppress the drafter unless it is "broken" — via ONE shared
  predicate `isVisibleHandoffDrafter(thread, now)` used by the sidebar, command
  palette (`CommandPalette.logic.ts:122-140` today includes every non-archived
  thread), and thread-mention candidates; a sidebar-only rule would make the
  invisibility claim only partially true.
- Failure surfacing has THREE legs, all in D5's settlement authority (review
  must-fix 3 — no existing rail covers roots: the liveness sweep skips them,
  `WorkstreamLivenessSweep.ts:654-665`, and `thread.turn-start-failed` resets
  the session without raising attention,
  `ProviderCommandReactor.ts:320-340,1184-1213`):
  1. zero-handoff turn end ⇒ `needs_guidance` (D5);
  2. `thread.turn-start-failed` on a drafter ⇒ `needs_guidance` immediately
     (catches the D8 fork-source-busy race and missing launch identity);
  3. periodic reconciliation with a GENEROUS grace window (~5 min): unarchived
     drafter roots whose kickoff has not reached a terminal turn ⇒
     `needs_guidance`. Timer-driven, not a render-time age comparison. Legs
     1–2 cover the common failures; this leg only catches hung turns — keep it
     cheap.
- Surfaced drafters need an explicit own-thread attention pill/banner: the
  normal sidebar status pill ignores the `attention` array
  (`Sidebar.logic.ts:386-450`), so merely re-inserting an ordinary row would
  show no failure badge.
- Deferred (phase 3, optional): "N handoffs" indicator on the source thread's
  card (lineage from `forkFromThreadId` + role) and a "context snapshot" chip on
  the destination's kickoff card. Human-visible lineage with zero model-visible
  pollution.

### D7 — Pi-only

Fork relies on pi's native session fork (`ThreadForkHttp.ts` already refuses
non-pi sources). The composer hides `/handoff` for non-pi threads; the server
handler re-checks and rejects, mirroring the existing guard.

### D8 — Busy-source handling: reject at intake

The lazy fork launch refuses a mid-turn source (`shouldRefuseForkLaunch`,
enforced in `ProviderCommandReactor.ts`). Unlike agent-called `thread_fork`
(always mid-turn, hence lazy), `/handoff` is sent by the human, normally while
the source is idle. MVP: the composer disables `/handoff` while the source is
running, and the server rejects a busy source with a clear error. No
parking/retry machinery. The tiny create-then-source-starts race is caught by
the existing launch-time guard and surfaces via D6's backstop.

### D9 — Existing behaviour superseded, nothing decommissioned

`goal_handoff` remains unchanged for agent-initiated handoffs (workstream
children, inbox roles). What retires is the human *pattern* of instructing a
thread to hand off — no code removal.

## 4. Implementation phases

**Phase 1 — server core**
- Contracts: additive `thread.handoff-recorded` event + `handoffCount` on the
  read model (destination goal/thread ids in the payload). `"handoff-drafter"`
  role needs no schema change (role is a free trimmed string — verified).
- `thread.handoff-draft` WS application operation: validate scope + pi-only +
  source-idle, read/validate source launch identity, then internal
  `thread.turn.start` with `bootstrap.createThread` (D4). No kickoff-brief
  file.
- `GoalHandoffHttp.ts`: drafter-caller branch (consult pointer + marker stamp
  after destination creation).
- Settlement reactor (D5/D6): session-set turn-end settlement, turn-start-failed
  attention, startup + periodic reconciliation, convergent done→stop→archive.
- Tests (per review): bootstrap initial-ready does NOT settle; completed and
  errored turns DO settle; startup reconciliation; captured model/options
  seeding; turn-start-failed raises attention; archive stops the session;
  decider/projector coverage for the new event.

**Phase 2 — web client**
- Composer: `/handoff` item, insert-then-free-text, `parseHandoffDraft` in
  `composer-logic.ts`, intercept branch in `ChatView.onSend`, disabled states
  (non-pi, busy), attachment rejection, draft preservation on failure.
- Visibility: shared `isVisibleHandoffDrafter` predicate across sidebar,
  command palette, and thread mentions; own-thread attention pill for surfaced
  drafters.
- Tests: parse cases; no-fall-through; failure-preserves-draft; visibility
  predicate; attention pill.

**Phase 3 — optional polish (separate follow-up)**
- Source-card handoff-count indicator; destination kickoff "context snapshot"
  chip; drafter self-titling.

## 5. Resolved by review (rev 1 open questions)

- Kickoff-helper reuse: dispatcher kickoff is child-only (false completion
  contract for roots); use the WS bootstrap instead (D4). Fork mechanics
  compose with a server-injected first turn — `ProviderCommandReactor` treats
  all turn-start-requests uniformly (`ProviderCommandReactor.ts:1029-1043`).
- Archive-while-running: archive is projection-only metadata; the real issue
  was the leaked pi process, fixed by the explicit session stop (D5).
- Attention on roots: valid in the decider, but no existing rail raises it and
  the sidebar pill ignores it — both now explicit in D6.
- Settlement signal: durable `thread.handoff-recorded`/`handoffCount` (survives
  restart), not an in-memory tally.
- Turn-end detection: `thread.session-set` leaving `running` (D5).
