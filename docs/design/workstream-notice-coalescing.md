---
manager_sessions:
  - id: 64e6ab8b-47ce-4bc0-b3b6-fd221fd2df64
    role: plan
    authored_at: 2026-07-08T00:18:49.347Z
---

# Workstream control-plane notice coalescing + two-tier urgency

**Status:** design (no code in this doc)
**Author:** planner sub-thread (T3 Code Workstream), 2026-07-08
**Scope:** stop the orchestrator being woken once per terminal event with
uniform boilerplate. Coalesce gate pairs into one notice, split notices into an
action-required tier (immediate, unchanged) and an FYI tier (digested), and
scale the instruction copy to what is actually being asked — without weakening
the losslessness or crash-safety discipline the dispatcher already has.

Vocabulary follows `docs/design/workstream-review-gates.md`: _gate source_ (the
reviewer carrying the loop route), _loop target_ (the coder), _resolve_ /
_loop_ / _cap-breach_ / _yield_ decisions, the _delta rail_
(`wakeEligibleParents`), the _per-child rails_ (`wakeIdleAndErroredChildren`),
the _yield rail_, _episodes_, _receipt-deduped delivery_, and
_wake-before-markers_.

---

## 1. Problem

An orchestrator running a multi-child workstream is woken by the control plane
once per event that concerns it. Every wake costs a full turn on the
orchestrator's (typically expensive) model, and today every wake wears the same
shape: one-or-more per-child sections, a bounded report excerpt each, and an
identical closing instruction block ("Review these results. Decide what
genuinely warrants human escalation… reconcile the task tree and continue
orchestrating."). Three failure modes follow:

1. **Pair splitting.** A review gate resolving cleanly produces two wakes — the
   reviewer's verdict, then the coder's own terminal notice minutes later —
   even though the second carries no new decision (the verdict wake already
   routed the report).
2. **Zero-decision wakes.** Terminal notices whose routing is already complete
   ("update the scoreboard") arrive with the same urgency and the same
   review-deliberation instructions as a stalled child needing intervention.
3. **Copy-induced waste.** The uniform boilerplate actively invites the
   orchestrator to deliberate over echoes; the report excerpts on
   already-routed items are pure token cost.

The rails that carry genuine action — idle backstop, error, attention, yield,
fan-in conflict — are correct and must not lose immediacy.

---

## 2. Field evidence

From the 2026-07-07 fork-seam campaign orchestrator (thread
`2c161919-209f-4008-aeac-d178f39a581f`), corroborated by a read-only consult of
that thread:

- **30** control-plane wake-ups over the campaign: 27 terminal-lane notices
  plus 3 idle-backstop notices. (The original brief's `~24` was an earlier,
  under-counted snapshot; the counts here are from the consult and supersede
  it.)
- **Gate pairs always arrived as two separate wakes**, reviewer's verdict
  first, the coder/planner's own terminal echo in a later wake — all **11**
  echo pairs, across coders and planners. Gaps were minutes-to-tens-of-minutes
  of wall clock.
- Those 11 echoes were near-zero-value, including the distinct subclass of a
  coder's round-N rework report arriving after the reviewer's clean
  re-verification.
- ~10 gate-verdict wakes were valuable but zero-decision.
- The genuinely-action-required remainder: the 3 idle-backstop stalls (all
  true positives), a plan-gate clear that unblocked wave-2 spawning,
  integration/shipper completions needing human relay, and 2 gate verdicts
  carrying follow-up work.
- **Three coder echoes never arrived at all** — an exact correlation with the
  three coders that had earlier tripped the idle backstop and been
  re-prompted. So the echo behaviour was not even uniform: under the code of
  the day it correlated with prior per-child-rail delivery. (See §3.3 — the design here makes the
  question moot by making per-terminal-episode delivery an explicit invariant.)
- No duplicate notices for the same event; rework rounds correctly ran
  silently.
- The notices carry **no timestamps**, which made this forensics harder than
  it should have been (§5.4 adds them).

**Caveat on vintage.** Commit `5c4850352` (delta-based parent notices) landed
2026-07-07 11:15. Whether the _running server_ included that commit during the
campaign **cannot be established from the orchestrator's session** — the
notices are untimestamped and the server's deploy/restart times are
unrecorded, so no claim about the running server's vintage should lean on that
session. The analysis below therefore separates what the current code
demonstrably already fixes (verified by reading it) from what demonstrably
remains (also verified by reading it), rather than leaning on the field
evidence for either.

---

## 3. Current state: what `5c4850352` already fixed, and what remains

All code references are to
`apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts` unless noted.

### 3.1 Already fixed by the delta rail

- **Whole-generation replays are gone.** `wakeEligibleParents` reports only
  newly-terminal, not-yet-reported children, keyed by durable per-child
  `child-reported` marker receipts (`childReportedCommandId`, keyed
  `(childId, terminalEpisodeKey)`).
- **Same-pass batching exists.** The delta rail batches every newly-reportable
  terminal child of one parent into ONE wake per pass.
- **Gate members are held until resolution.** `isMemberOfUnresolvedGate`
  (`packages/shared/src/workstreamGraph.ts`) keeps both parties out of the
  batch mid-loop, and the decider's `resolve` completes both parties in one
  transaction (`decider.loom.ts`, `thread.work.submit`, `resolveWith`) — so
  both go terminal in the same event batch and _should_ be picked up by the
  same dispatcher pass. This also kills the rework-report-after-clean-verdict
  echo subclass: a mid-loop coder's lane is untouched by the `loop` decision,
  so it only ever becomes reportable at resolution.
- **Cross-rail echo suppression exists.** `alreadyNoticedByPriorRail`
  suppresses a delta report for a child whose current state the parent already
  heard through the yield/error/attention/idle rails, on exact episode keys.

### 3.2 What remains (the gaps this design closes)

1. **The fan-in pair split.** In the delta batch loop, an isolated coder that
   reached `done` is held back while its fan-in is unsettled
   (`isFanInPending`, `packages/shared/src/workstreamIsolation.ts`) — but its
   attached reviewer has no fan-in and is reportable immediately. A cleanly
   resolved gate over an isolated coder (the default: writers are isolated)
   therefore splits into exactly the observed two wakes: reviewer now, coder
   after the fan-in reactor merges. Since almost every gated coder is
   isolated, "the delta rail batches resolved pairs" is true only for shared
   coders — in practice the pair split survives.
2. **No pair-aware rendering.** Even when both parties do land in one batch,
   `buildParentWakeMessage` renders two independent full sections (two
   excerpts, no verdict, no round count, no linkage).
3. **One tier, one copy.** Every delta wake is immediate and carries the full
   first-pass-review instruction block, regardless of whether anything is
   being asked. There is no digest, no quiet-window flush, no way for a
   zero-decision completion to ride along with the next real wake.

### 3.3 The three missing echoes, explained away

Whether those three non-deliveries were pre-`5c4850352` barrier behaviour or a
suppression interaction cannot be settled from the surviving evidence. It does
not need to be: this design states delivery as an explicit invariant (§6.1 —
every terminal episode appears in exactly one delivered notice, immediate or
digest, recomputable across restarts) and the test plan pins it (§7). Under
that invariant the missing-echo class is a test failure, not an anecdote.

---

## 4. Design

Three coordinated changes, all inside the existing dispatcher pass structure:

1. **Pair coherence** — hold a resolved gate's source until its loop target's
   fan-in settles, so the pair is always reportable together; render the pair
   as one combined section.
2. **Two-tier delivery** — classify every parent notice as _action-required_
   (immediate wake, semantics unchanged) or _FYI_ (withheld into a per-parent
   digest); deliver the digest by piggyback on the next action-required wake,
   by quiet-window flush, or immediately when the workstream goes quiet.
3. **Scaled copy** — the instruction block matches the tier: digest items get
   scoreboard-and-follow-up copy, not first-pass-review deliberation; resolved
   pairs drop the coder's excerpt (a reviewer already verified that work).

### 4.1 Gate-pair coalescing

#### Holdback: pair fan-in coherence

New rule in the delta batch loop (alongside the existing per-child holdbacks):

> A terminal gate **source** whose loop **target** is fan-in-pending is held
> back too.

Pure predicate, next to its siblings in
`packages/shared/src/workstreamGraph.ts`:

```ts
/** A terminal gate source held back so its resolved pair reports together:
 *  its loop target is a done isolated child whose fan-in has not settled. */
export const isHeldForCounterpartFanIn = (thread, threadsById): boolean => {
  const loopTo = gateLoopTargetOf(thread);
  if (loopTo === null || !isTerminalForJoin(thread)) return false;
  const target = threadsById.get(loopTo);
  return target !== undefined && isFanInPending(target);
};
```

Consequences, case by case:

- **Fan-in completes** (`completed`): both parties become reportable on the
  `thread.fanin-set` pass (already a dispatcher trigger) and land in one batch
  → one notice. The delay equals the fan-in merge time (normally seconds) —
  and the notice is _better_: it can truthfully say the coder's branch is
  already merged and its dependents released, instead of reporting a coder
  whose output is not yet in the parent's tree.
- **Fan-in conflicts** (`conflicted`): `isFanInPending` is false for
  `conflicted` (it is settled-for-wake), so the holdback releases and the pair
  is reportable together, carrying the existing conflict block. The fan-in
  reactor's dedicated conflict notice (`WorkstreamFanInReactor.ts`) has
  already fired as its own action-required wake — that rail is untouched. The
  pair item is FYI (§4.2): the conflict notice carries the action, the pair
  item carries the verdict bookkeeping. Note the conflict notice is emitted by
  the fan-in **reactor**, a separate rail from the dispatcher passes that
  carry the digest — piggybacking the pair item onto that exact message would
  require reactor-side digest plumbing, which is not worth the coupling. The
  pair item is instead delivered by the normal flush conditions (§4.3):
  piggybacked on the next dispatcher-side action wake, or by the quiet-window
  flush — worst case `FYI_DIGEST_FLUSH_MS + IDLE_WAKE_REPASS_INTERVAL_MS`
  after the conflict notice, which is fine because the conflict notice already
  carries everything actionable.
- **No new liveness class.** The holdback only ever waits on exactly the
  condition the coder's own report already waits on (`isFanInPending`); a
  wedged fan-in wedges both parties' reports today and continues to wedge both
  — surfaced, as today, by the fan-in reactor's retry/notice machinery, not by
  the delta rail.
- **Reviewer forced terminal by the parent** (set_lane done/cancelled
  mid-round, gate dissolved): the holdback still applies while the coder's
  fan-in is pending — coherent, and the parent performed the action itself so
  no urgency is lost.
- **Counterpart already reported** (edge: a parent force-`done` coder whose
  terminal episode was already delivered before the gate resolved): the pair
  grouper (below) simply finds no unreported counterpart and renders a
  source-only verdict section. No double mention — the coder's marker receipt
  already exists.

#### Rendering: one section per resolved pair

`buildParentWakeMessage` is a tested pure export — extend its input, don't
fork it. The delta rail currently maps each batch member to a flat child
record; insert a pure grouping step:

```ts
/** Partition a parent's batch into resolved gate pairs and singles. A pair is
 *  a batch member carrying a loop route whose target is also in the batch. */
export const groupBatchForWake = (members, threadsById):
  { pairs: Array<{ source; target }>; singles: Array<member> }
```

(lives beside the builders in `WorkstreamDispatcher.ts`; pure, tested). The
builder renders a pair as ONE section:

- header: gate verdict (the source's `lastOutcome.outcome` — `clean` /
  `fixed_inline`), both parties' roles + ids + lanes;
- rounds used (`source.gateRounds`) and whether rework happened
  (`gateRounds > 0`);
- fan-in status for the target (merged / conflicted, with the conflict block
  when conflicted);
- dependents released (names of siblings whose `blockedBy` the target/source
  appear in — computable from the snapshot; omit when none);
- **one** report reference each, but an excerpt only for the source's verdict
  report. The target's round report was already consumed by the gate protocol
  (the reviewer verified it); its reference suffices. This is the single
  biggest token saving per pair.

Copy sketch (§5.1) shows the exact shape.

### 4.2 Two-tier classification

The boundary rule: **a notice is action-required iff the control plane cannot
proceed without an orchestrator (or human) decision, or a rail exists solely
to surface a liveness problem.** Everything whose routing is already complete
is FYI.

| Notice                                                                                           | Tier                                                          | Rationale                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle backstop (`idle`, forgot-to-finish)                                                         | **Immediate**                                                 | All three field occurrences were true positives; the child is halted with no resumer. Unchanged.                                                                                                                                                                                                                                                                                                 |
| `error`                                                                                          | **Immediate**                                                 | Liveness verdict; child did not report success. Unchanged.                                                                                                                                                                                                                                                                                                                                       |
| Paused `attention` (`needs_guidance`, `awaiting_acceptance`, frozen-executing, provision-failed) | **Immediate**                                                 | A human/orchestrator decision is the only path forward; `awaiting_acceptance` explicitly asks the parent to act as first-pass reviewer. Unchanged.                                                                                                                                                                                                                                               |
| Yield (unknown outcome, gate cap-breach)                                                         | **Immediate**                                                 | Turn handed to the orchestrator by definition; dependents gated. Unchanged.                                                                                                                                                                                                                                                                                                                      |
| Fan-in conflict notice (reactor)                                                                 | **Immediate**                                                 | Blocks dependents until a merge lands. Unchanged.                                                                                                                                                                                                                                                                                                                                                |
| Wake-rate park-and-escalate                                                                      | **Immediate** (human surface)                                 | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                       |
| Terminal delta: resolved gate pair                                                               | **FYI**                                                       | See below.                                                                                                                                                                                                                                                                                                                                                                                       |
| Terminal delta: plain completion (ungated child)                                                 | **FYI**                                                       | Routing complete; nothing gated on the orchestrator. Excerpt retained — nobody has reviewed this report (§5.2).                                                                                                                                                                                                                                                                                  |
| Terminal delta: cancellation echoes                                                              | **FYI**                                                       | The parent (or cascade) performed the cancellation; the delta item is bookkeeping.                                                                                                                                                                                                                                                                                                               |
| `recovered` (error→done supersession)                                                            | **FYI**                                                       | Purely corrective information; the child is done and dependents already released.                                                                                                                                                                                                                                                                                                                |
| Fan-in _resolved_ notice (conflicted→completed, reactor)                                         | **Immediate** (reactor-side; rare, deliberately NOT digested) | Confirmation of an action the orchestrator already took. Left as an immediate reactor-side wake because digesting it would require reactor→dispatcher digest plumbing the design forbids (§4.1) — and the transition is tracked only in the reactor's process-scoped `conflictedChildren` set, so the dispatcher cannot re-derive it from `thread.fanin-set` alone. Rare, best-effort ephemeral. |
| `slow-tool` informational notices                                                                | **FYI**                                                       | See below.                                                                                                                                                                                                                                                                                                                                                                                       |

**Why gate verdicts are FYI (the contested boundary).** The field evidence
shows verdict wakes sometimes carry real follow-up: dependents the
orchestrator is watching, and follow-up work extracted from findings. Neither
needs an immediate wake:

- _Dependent release is not the orchestrator's job._ The promote rail starts
  released dependents autonomously in the same dispatcher pass family; the
  orchestrator watching a dependent learns about it when _that_ thread
  produces a notice. The one real case where release requires orchestrator
  action — the released work does not exist yet (the campaign's plan-gate →
  wave-2 spawning) — is covered by the quiet-workstream flush: if nothing else
  is running, the digest flushes immediately (§4.3), so the wave-2 decision is
  not delayed at all; if other children are still running, the spawn decision
  is delayed by at most the flush window (default 120 s, §4.3) against child
  task durations measured in tens of minutes.
- _Follow-up extraction is not latency-sensitive._ Reading a clean verdict for
  nice-to-have follow-ups tolerates minutes of delay by construction.

Classifying verdicts as immediate would preserve ~10 of the campaign's 30
wakes for zero decision on arrival — exactly the waste this design exists to
remove. The cost of FYI is bounded (flush window) and collapses to zero when
the workstream is otherwise quiet.

**Why `slow-tool` is FYI.** It is documented as informational-only (no flag,
never interrupted, parent judgement optional). Its urgency case — a wedged
call the parent may want to interrupt — is self-covering under the digest: a
wedged call means the workstream is producing no other events, so the
quiet-window flush delivers the notice within `flush window` of its 5-minute
first step. The escalating repeat steps continue to enter the digest and each
flush carries the latest. Net effect: first notice at ~7 min instead of ~5 min
in the worst case, in exchange for never waking an orchestrator mid-burst for
a build that is merely slow.

**But `slow-tool` is best-effort ephemeral, not lossless.** Unlike terminal
episodes, a `slow-tool` item is derived entirely from transient live state —
the active turn, the in-flight tool row, the quiet duration, and a schedule
step index (`WorkstreamDispatcher.ts`, the slow-tool branch of
`wakeIdleAndErroredChildren`). If a withheld slow-tool item is pending when
the server restarts and the tool call has completed by then, nothing can — or
should — reconstruct it: the notice would be reporting a condition that no
longer exists. So `slow-tool` (and the fan-in reactor's _resolved_
confirmation, which is already process-scoped today and already forgoes
delivery across a restart by design) sit **outside the losslessness invariant
(§6.1)**: they may evaporate on restart, and that is the correct behaviour.
A call that is _still_ slow after restart re-derives itself on the next pass
(fresh quiet measurement, same episode-key scheme) and re-enters the digest.
The losslessness machinery applies only to the recomputable set: terminal
episodes and `recovered` (which is derived from the durable error-wake receipt
plus the durable `done` lane, so it survives restarts).

### 4.3 Digest delivery: withhold in the delta rail, no new persistence

**Decision: no persisted queue.** The _lossless_ pending-FYI set is
_recomputable_: it is exactly the set the delta rail already computes every
pass — terminal children without a delivered marker receipt, plus `recovered`
(recomputable from the durable error-wake receipt + `done` lane). "Digesting"
is therefore nothing more than **not delivering yet**: the batch loop computes
the same members, then applies a flush condition before delivering. Durability
across restarts falls out of what already exists — lanes, outcome events,
fan-in state, and marker receipts are all durable, so a fresh process
recomputes the identical pending set and the flush clock (below) from event
timestamps. The ephemeral FYI kinds (`slow-tool`, fan-in-resolved) join the
same in-memory pending set but are explicitly exempt from the restart-safety
claim (§4.2): they describe transient conditions, evaporate harmlessly on
restart, and self-re-derive if the condition persists. The alternative — a
persisted digest queue table — would duplicate the durable state, need
migration, create a second source of truth that can disagree with the
receipts, and _still_ have to decide whether to replay stale slow-tool notices
about tool calls that have since returned. Rejected.

**Flush conditions.** A parent's pending FYI items are delivered when the
first of these holds:

1. **Piggyback** — an action-required wake for this parent is being delivered
   this pass (per-child, yield, or a standalone digest already flushing). The
   digest is appended to that wake's message (action first, FYI after — the
   decision the parent must make leads; see §5.3 on why "appended" rather than
   the brief's "prepended").
2. **Quiet window** — the oldest pending item is older than
   `FYI_DIGEST_FLUSH_MS` (default **120 000 ms**, exported constant beside
   `DEFAULT_IDLE_WAKE_GRACE_MS`). Age is computed from the item's durable
   event time (`lastOutcome` event / `updatedAt` on the lane set), so it
   survives restarts without any new state. 120 s is chosen to be: longer than
   intra-burst gaps (a resolve transaction, its fan-in, and sibling
   completions land within one or two passes), and negligible against child
   task durations (minutes to hours) — so bursts coalesce but no decision is
   materially delayed. The existing 60 s periodic re-pass
   (`IDLE_WAKE_REPASS_INTERVAL_MS`) is the timer that re-evaluates it; actual
   delivery lands within `flush + 60 s` worst case.
3. **Quiet workstream** — after this pass's events, the parent has no child in
   lane `ready` or `in_progress`. Nothing is running or about to run, so the
   orchestrator's next move is due _now_: flush immediately. This is the
   last-child rule from the acceptance sketch, and it generalises: it also
   fires when the only remaining children are `planned` (deliberately held —
   the orchestrator may be waiting on exactly this digest to release them) or
   `yielded`/flagged (those raised their own immediate wakes).

**Delivery mechanics** (unchanged discipline):

- One digest delivery = one `thread.turn.start` with `requireIdle` (or a
  section appended to the action-required wake's turn-start). A busy parent
  defers; the pending set survives untouched and retries next pass.
- Wake-before-markers: per-item `child-reported` markers (and
  `recovered`/`slow-tool` receipt ids) are written only after real delivery,
  exactly as today. A crash in between risks a rare duplicate mention on the
  next pass — the same, accepted, strictly-better-than-loss trade the delta
  rail already documents.
- A standalone digest flush charges the parent's wake-rate budget
  (`recordDelivery`); a piggyback rides the carrying wake's single charge.
- Pass-level plumbing: the pass computes each parent's pending-FYI batch once
  (delta rail position, after gate traversals), stashes it in a per-pass map,
  and the later per-child/yield rails consult it when composing their wakes.
  Rails stay ordered and serial on the drainable worker, so no synchronisation
  is needed.

### 4.4 What does NOT change

Explicitly out of scope, semantics preserved verbatim:

- The **per-child rails** (`error`, paused `attention`, idle backstop with its
  `needs_guidance` raise, `recovered` detection, `slow-tool` detection and
  scheduling) — classification, episode keys, grace windows, and suppression
  logic all unchanged; only the _delivery tier_ of `recovered`/`slow-tool`
  moves to the digest.
- The **yield rail** and **gate traversal pass** — untouched.
- The **promote rail** and dependency release — untouched (dependents release
  on `done` regardless of when the parent hears).
- The **fan-in reactor** — its conflict notice stays an immediate, dedicated
  wake, AND its _resolved_ confirmation also stays an immediate reactor-side
  wake (resolved 2026-07-08: NOT moved to the digest — the "no reactor-side
  digest plumbing" decision in §4.1 wins over the earlier draft that listed it
  as a digest entrant; the transition is only knowable inside the reactor).
- **Receipt-dedup discipline** — `deliverOnce` / `wasDelivered` /
  `markSuppressed`, deterministic `server:` ids, the delivered/suppressed set
  separation, and `alreadyNoticedByPriorRail`'s exact-episode checks.
- The **wake-rate budget** and park-and-escalate.
- `requireIdle` deferral semantics on every parent-directed turn-start.
- The decider's `routeWorkSubmit` and the single-transaction `resolve` — the
  coalescing lives entirely in the dispatcher's delivery layer, no new events,
  no contract changes. (One optional additive contract touch: §5.4
  timestamps.)

---

## 5. Message copy

### 5.1 Resolved gate pair (digest item)

```markdown
### ✅ Gate resolved `clean` — coder `95a8d647` + reviewer `dc92ddb0` (2 rework rounds)

_2026-07-07 14:32Z_ · coder branch merged into yours · released: `integration-tail` (`f83f1494`)

Verdict report: `…/dc92ddb0.md` — excerpt:

> Clean. Both round-1 findings resolved; the contested naming finding was
> withdrawn after the coder's rationale. …

Coder round report: `…/95a8d647-r2.md` (reference only — verified by the gate).
```

One section, one excerpt, verdict + rounds + fan-in + released dependents on
one line. A `fixed_inline` verdict says so in the header; a conflicted fan-in
replaces the "merged" clause with the existing conflict block.

### 5.2 Plain completion (digest item)

```markdown
### ☑️ researcher `a1b2c3d4` — done

_2026-07-07 14:35Z_

Report reference: `…/a1b2c3d4.md` — excerpt:

> [bounded excerpt as today — no reviewer has seen this report, so the
>
> > first-look excerpt is retained]
```

Ungated completions keep their excerpt: the digest changes _when_ the parent
reads it, not what it gets. `recovered`, `cancelled` echoes, `slow-tool`, and
fan-in-resolved items render as one-to-three-line entries with references and
timestamps, no excerpts.

### 5.3 The instruction block, by shape

- **Standalone digest flush** (quiet window / quiet workstream):

  ```markdown
  [T3 Workstream control plane — automated notice, not from the user]

  FYI digest — the following items completed and were fully routed by the
  control plane since you last heard. Nothing below is blocked on you.

  <items>

  No first-pass review is owed on gate-resolved items (their reviewers
  verified the work). Update your task tree / scoreboard, pull anything
  useful from the reports (follow-up work, findings worth acting on), and
  continue orchestrating. Unreviewed completions (marked ☑️) deserve the
  usual first look.
  ```

- **Piggyback**: the action-required wake keeps its existing copy verbatim,
  followed by a separator and the digest under the header
  `--- \n\n**Also, FYI since you last heard** (no action required):` with the
  same closing line about gate-resolved items. Action first, FYI after — the
  brief suggested prepending, but the wake's job is to get the decision made;
  burying "your child is stalled" beneath a scoreboard update invites exactly
  the misprioritised deliberation this design removes. The digest's losslessness
  does not depend on its position.
- **Immediate wakes**: existing copy untouched, except the delta-rail
  standalone wake (which can still occur for immediate-flush cases) adopts the
  pair-aware sections and drops the review-deliberation paragraph for items
  that are gate-resolved.

### 5.4 Timestamps

Every rendered item carries the event time of the state change it reports
(from the durable event, already in the read model as `updatedAt` /
`lastOutcome`). Zero-cost, and the missing-timestamp forensics gap from §2
closes. No contract change needed — it is rendering-only.

---

## 6. Invariants and safety argument

### 6.1 Losslessness (the load-bearing invariant)

> **Every terminal episode `(childId, terminalEpisodeKey)` — and every
> `recovered` episode — appears in exactly one delivered parent notice: an
> immediate wake, a digest flush, or a piggybacked digest — unless a prior
> rail's episode-exact receipt already delivered the same state
> (`alreadyNoticedByPriorRail`, unchanged).**

The invariant deliberately covers only the recomputable kinds. `slow-tool` and
fan-in-resolved items are best-effort ephemeral (§4.2): withheld ones may
evaporate on a restart, by design, because they describe transient conditions
that either no longer hold (nothing to report) or still hold (re-derived and
re-digested on the next pass).

Mechanism, unchanged from today: the `child-reported` marker receipt is the
durable "delivered" truth, written only after the carrying turn-start
succeeds. Withholding into the digest writes _nothing_, so a restart at any
point recomputes the identical pending set from lanes + receipts and the flush
clock from event timestamps. The only new code between "pending" and
"delivered" is the flush condition — a pure predicate with no state to lose.

### 6.2 What replaces the echo insurance

Today's coder echo doubles as insurance: if the reviewer's verdict wake were
lost, the coder's separate notice would still surface the pair. Under
coalescing there is no second notice — the replacement insurance is:

1. **The resolve transaction is atomic** (one decider command emits both lane
   events), so there is no partial-resolution state to miss.
2. **The pair notice itself is crash-safe** the same way every delta wake is:
   wake-before-markers means a crash before markers re-delivers the whole pair
   on the next pass (worst case: one duplicate pair mention, never a loss).
3. **A wedged gate still surfaces** through rails this design does not touch:
   `isWaitingInGate`'s un-suppression on a cancelled counterpart, the idle
   backstop for a party halted outside protocol, and the fan-in reactor for a
   wedged merge.

So the redundancy is not removed — it is moved from "send a second, noisy
notice" to "the first notice cannot be silently lost".

### 6.3 Immediacy of the action tier

Action-required rails bypass the digest entirely — their classification,
episode keys, and delivery paths are byte-identical to today. A stalled child
wakes the parent exactly as fast as before (plus, usually, a free digest).

### 6.4 Bounded delay of the FYI tier

Worst-case FYI latency = `FYI_DIGEST_FLUSH_MS + IDLE_WAKE_REPASS_INTERVAL_MS`
(180 s at defaults) while other children are running, and ~0 when the
workstream is quiet (condition 3 fires on the same pass as the terminal
event). Configurable via the exported constant; a deployment that wants
today's behaviour sets it to 0.

---

## 7. Test plan

Extend `WorkstreamDispatcher.test.ts` (pure builders + pass behaviour, the
existing harness) and `workstreamGraph` tests:

**Pure units**

- `isHeldForCounterpartFanIn`: source held while target fan-in `none`;
  released on `completed` and `conflicted`; false for non-terminal source, no
  loop route, shared target, cancelled target.
- `groupBatchForWake`: pair identified via loop route; source-only when the
  target is absent from the batch (already reported); singles pass through.
- `buildParentWakeMessage` pair section: verdict, rounds, reworked flag,
  fan-in clause, released dependents, source excerpt present, target excerpt
  absent, conflict block when conflicted.
- Digest builders: standalone copy, piggyback separator copy, per-item
  timestamps, excerpt policy per item kind.
- Flush predicate: piggyback / age / quiet-workstream conditions, including
  planned-only and yielded-only children counting as quiet.

**Pass behaviour (dispatcher harness)**

- Gate resolves clean, isolated coder, fan-in pending → no wake; fan-in
  `completed` event → ONE wake containing the pair section. (The acceptance
  headline.)
- Gate resolves, fan-in conflicts → reactor conflict notice (unchanged) and
  the pair item delivered (piggybacked or flushed) with the conflict block.
- Plain terminal child while siblings run → withheld; delivered by (a) a
  sibling's idle-backstop wake carrying the digest, (b) age flush after the
  window, (c) immediately when it was the last running child — three tests.
- Idle-backstop / error / attention / yield wakes still fire immediately with
  a pending digest appended and its markers written.
- Restart mid-window: rebuild dispatcher with empty caches → pending set
  recomputed, age computed from event time, flush proceeds; no duplicates for
  already-markered items.
- Restart with a withheld `slow-tool` item, tool since returned → the item is
  NOT re-delivered (nothing pending on the fresh pass) and nothing errors;
  tool still in flight and quiet → the item re-derives and re-enters the
  digest with the same episode-key scheme.
- Crash between digest wake and markers → next pass re-delivers (duplicate
  mention, never loss) — mirror of the existing delta-rail test.
- Exactly-once sweep: drive a multi-child scenario end-to-end (gates, an
  idle-backstopped child, a cancellation, a slow-tool episode) and assert
  every terminal episode's marker exists and every marker was preceded by
  exactly one containing delivery.
- Wake-rate budget: standalone flush charges it; piggyback charges once.
- `slow-tool` step receipts written on digest delivery; repeat steps re-enter.

**Acceptance (from the brief, restated)**

- Gate resolving clean → exactly one orchestrator notice. ✔ (holdback + pair
  grouping)
- Stalled child still wakes the orchestrator immediately. ✔ (§6.3)
- No terminal event silently dropped; a quiet workstream's completion surfaces
  within the flush window — in fact immediately, via condition 3. ✔
- Comparable-campaign wake-ups drop by roughly a third to a half: 30 →
  ~14–18 (all 11 pair echoes eliminated structurally; the ~10 zero-decision
  verdict wakes coalesced into piggybacks and flushes, of which some fraction
  survive as standalone digest deliveries). ✔ (projection, to be validated on
  the next instrumented campaign)

---

## 8. Implementation outline (coder-ready)

Ordered so each step lands green independently:

1. **Shared predicates** (`packages/shared/src/workstreamGraph.ts`):
   `isHeldForCounterpartFanIn` + tests. Wire into the delta batch loop's
   holdbacks (one line beside `isFanInPending`). _This alone fixes the pair
   split and is the highest-value smallest change._
2. **Pair-aware rendering**: `groupBatchForWake` + the pair section in
   `buildParentWakeMessage` (extend the child record with `lastOutcome`,
   `gateRounds`, released-dependent names, event timestamps; all already on or
   derivable from the shell snapshot). Tests per §7.
3. **Tier classification + digest withholding**: flush-condition predicate +
   `FYI_DIGEST_FLUSH_MS`; delta rail withholds non-flushing batches; standalone
   digest flush delivery (turn-start + budget + markers). `recovered` and
   `slow-tool` deliveries in `wakeIdleAndErroredChildren` redirect into the
   pending set instead of dispatching (their episode keys and receipts
   unchanged, and explicitly exempt from the losslessness invariant per
   §4.2). The fan-in reactor's _conflict_ notice is untouched; its _resolved_
   confirmation is left as an immediate reactor-side wake too (NOT digested) —
   digesting it would need reactor→dispatcher plumbing §4.1 forbids, and the
   reactor is the only layer that knows a completion followed a conflict
   (process-scoped `conflictedChildren`). Resolved 2026-07-08.
4. **Piggyback**: per-pass pending-digest map; per-child + yield rails append
   the digest section and write its markers on delivery.
5. **Copy**: digest instruction blocks, timestamps on all items, drop the
   review-deliberation paragraph for gate-resolved items in any delta wake.
6. **Docs**: update `docs/design/workstream-review-gates.md` §6's delta-rail
   paragraph to reference this doc's tiering.

Steps 1–2 are shippable without 3–5 (immediate wakes, but coherent pairs);
3–5 deliver the tiering. No contract or migration work anywhere.

---

## 9. Open questions

1. **Flush window default** — 120 s is argued, not measured. Worth revisiting
   after one instrumented campaign (the timestamps from §5.4 make that
   measurement possible).
2. **Digest size cap** — a very large pending set (mass cancellation) could
   build a long digest. The wake-rate park already bounds pathological cases;
   a simple item cap with "and N more — see the board" copy is a cheap
   follow-up if it ever bites.
3. **The three missing echoes** (§3.3) — if someone wants the forensic answer,
   the campaign threads' session logs carry real timestamps to correlate
   against `5c4850352`'s deploy time (the orchestrator's own session cannot
   settle it). Not needed for this design.
