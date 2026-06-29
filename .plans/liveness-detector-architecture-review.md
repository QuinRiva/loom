---
manager_sessions:
  - id: 9578f72f-c0df-4404-b5f6-3ddb547c2250
    role: architecture
    authored_at: 2026-06-28T03:58:40.898Z
---

# Liveness detector architecture review — stop the whack-a-mole

**Status:** decision-grade architecture review. Self-contained; read the cited
code/rows before implementing. Supersedes the per-symptom trajectory of
`.plans/loop-detector-signature-collapse-fix.md` and the current same-file-edit
point fix.

**Scope:** Stage-1 D-liveness, specifically the **loop rail**
(`apps/server/src/orchestration/Layers/WorkstreamLivenessSweep.ts`). The stall
and dead rails are evaluated for contrast but are **not** the problem (see
evidence).

---

## TL;DR (the decision)

The loop rail has a **100% false-positive rate and zero true positives** over its
entire recorded history (18/18 verdicts were healthy threads; all 18 kept doing
real work after being flagged and all 18 reached a healthy terminal state). The
recurring "the signal lost information, patch the signal" fixes are treating
symptoms of one root cause:

> **Root cause:** liveness is reverse-engineered from a *display-oriented*
> projection of tool **results**, and "≥3 identical display-signatures = stuck"
> is used as a **terminal `error` verdict**. The projection's job
> (`deriveToolActivityPresentation`) is to *compress tool calls for a human
> timeline* — the exact opposite of *preserving the discriminators needed for an
> identity/equality key*. We keep re-enriching a projection that is structurally
> the wrong thing to compare, and we wire its cheap, lossy guess straight to a
> thread-killing `error`.

**Primary recommendation (decisive):**

1. **RIGHT NOW — sever the `loop → error` edge.** Demote the loop verdict from a
   terminal `error` to a **non-terminal advisory** (warning activity row + at
   most one parent nudge). This neutralises *all* observed false positives in
   one ~5-line change, is strictly safer and broader than the same-file point
   fix, and loses nothing real (0 true positives to date). **Do NOT ship the
   same-file-edit point fix** — it is one more turn of the same crank on a proxy
   that has never once been right.
2. **NEXT — when loop *suspicion* is wanted at all, rebuild it on an identity
   key + a progress corroboration**, not on the presentation string: hash the
   raw tool **input** (`data.rawInput`, already persisted) for identity, and only
   raise suspicion when a heartbeat/work-product signal *also* shows no progress.
   Keep it advisory/escalating, never auto-killing.
3. **DEFER** the full Stage-2 LLM investigator until there is evidence of real
   loops to justify its cost (currently: none).

Keep the stall and dead rails as-is (0 false positives; they cover the
genuinely-no-signal cases cooperative self-report cannot).

---

## 1. Evidence (ground truth, not the brief)

Source: `~/.t3/cockpit/userdata/state.sqlite`, `projection_thread_activities`.

### 1a. The verdict history is 100% loop, 100% false

- **18 liveness verdicts ever. All 18 are `workstream.liveness.loop`.** Zero
  `stalled`, zero `dead` have *ever* fired.
- **18 distinct sub-threads flagged out of 77 total sub-threads ≈ 23%.** Nearly
  one in four sub-threads was falsely flagged.
- **Final status of the 18 flagged threads: 17 `done`, 1 `review`.** Not one was
  actually stuck.
- **Every flagged thread kept doing real tool work *after* the flag** — between
  2 and 126 further `tool.completed` rows, then settled cleanly. Examples:
  `08ff4b2f` +126 rows; `81ad8183` +118; `59ad2153` +56; the current trigger
  `48d7345f` +8 rows before reaching `done`.

The loop rail is not "mostly right with some false positives." On the recorded
evidence it has **negative expected value as a terminal authority**: it has only
ever killed healthy work.

### 1b. Two eras, one root cause

Reduced each flagged thread's preceding `tool.completed` rows to what the agent
was really doing:

- **Era 1 — args dropped at the provider seam (rows 00:20–10:01 on 2026-06-26).**
  `data.rawInput` is empty (`raw_keys=[]`). Every same-type call collapses to a
  generic token: `bash×6 → "Ran command\u0000"`, `read×6 → "read\u0000"`. This is
  the bug `.plans/loop-detector-signature-collapse-fix.md` / the PiDriver arg-
  correlation fix targeted. Typical flagged streams were just `bash,bash,bash,…`
  — i.e. **normal coding** (a coder running a sequence of shell commands).

- **Era 2 — args present, projection still discards them (10:43 onward,
  including the current trigger).** After the PiDriver fix, `data.rawInput` *is*
  populated, e.g. `read` carries `{path, offset, limit}`, `edit` carries
  `{path, edits:[{oldText,newText}]}`. **And the rail still false-fires**, because
  `deriveToolActivityPresentation` reduces a `file_change` to its **path only**
  (`extractPrimaryPath`) and a `read` to its **path only** — throwing the
  discriminating args away again *downstream of persistence*.

  Verified for the current trigger `48d7345f` (architect editing one `.plans`
  file): four edits with **distinct `oldText`/`newText` and different edit
  counts** all collapse to one signature
  `"Changed files\u0000…/role-scoped-prompting-implementation.md"`. `0f704e9f`
  (10:43) is the same shape for reads: 5 reads of `Sidebar.tsx` at different
  `offset/limit` → one `"Read file\u0000…/Sidebar.tsx"`. `ababf649` (12:36): 5
  distinct edits to `Sidebar.tsx` → one signature.

**The decisive datum:** Era 2 proves the seam is **the projection, not
persistence.** The args now reach the row; the presentation layer deletes them.
Re-plumbing more args into the payload cannot fix a layer whose contract is to
*forget* them.

### 1c. Why `hasDiscriminatingDetail` cannot save it

`WorkstreamLivenessSweep.ts` added a fail-safe: don't declare a loop unless the
tripping signals carry non-empty `detail`. But in Era 2 the detail is a non-empty
**path** — "present" detail, not "discriminating" detail. The guard is itself an
artefact of the category error: it patches *detail-less* collapse and is blind to
*detail-present-but-collapsed*. You cannot guard your way out of using a display
string as an identity key.

---

## 2. Root cause, stated crisply

There is a **single shared root cause** with two compounding faults:

**Fault A — wrong signal projection (the identity-vs-display category error).**
The loop signature is `normalizeToolSignature = summary \u0000 detail`
(`WorkstreamLivenessSweep.ts`), where `summary`/`detail` come from
`deriveToolActivityPresentation` (`packages/shared/src/toolActivity.ts`). That
helper is a **human-timeline renderer**: brevity is its *feature* — a file edit
shows the path (not the diff), a read shows the path (not the byte range), a bash
shows the command. Reusing it as an **equality key** for "did the agent repeat
itself" is using a lossy compressor as a hash. Every prior fix re-enriched this
projection for one more tool/provider; none questioned that a *display* projection
is the wrong source for an *identity* comparison. This is why the fixes never end:
the blind spot is structural, not per-tool.

**Fault B — wrong proxy, wired to a terminal verdict.** Even with a perfect
full-args signature, "≥3 identical `(tool,args)` calls = stuck" is a weak proxy.
It is simultaneously:

- **over-sensitive** to legitimate work — 3 reads of one big file, or 3 edits to
  one file, or 3 shell commands in a row, is the *normal shape* of coding, not a
  pathology; and
- **under-sensitive** to real "stuck" — an agent thrashing (re-deriving the same
  wrong answer, oscillating between two approaches, retrying with *tweaked* args)
  emits **distinct** signatures every time and is invisible to signature-equality.

Signature-equality measures **tool-call surface identity, not progress.** The
design doc's own research section already names the fix
(`.plans/phase-d-liveness-design.md`: *"Counters can't separate slow-work from
spinning … make any judge read work-product deltas … not just counts/names"*) —
but Stage 1 shipped the counts/names proxy as a **standalone auto-`error`
authority**, when the design intended it only as a **cheap gate that escalates to
a Stage-2 investigator** (*"Bias false-positives to nudge, not kill"*). Stage 2
was never built, so the deliberately-cheap, lenient-by-design gate became the
hanging judge. **The architecture inverted its own safety principle.**

Root cause in one sentence: *we compare a display projection (not an identity
key) of tool results (not progress) and treat a match as a terminal kill (not a
suspicion to escalate).*

---

## 3. Current-architecture evaluation and its blind-spot asymptote

The status-quo trajectory is "harden the signal": PR #12 (codex args) → PiDriver
arg correlation (pi args) → same-file point fix (edit content). Each narrows one
blind spot. Where does it asymptote?

Even a *perfect* args-hash signature still:

- **cannot tell slow-real-work from spinning** — Fault B is independent of the
  signature quality; this is the permanent ceiling.
- **leaves "other"/MCP tools collapsed** — the Layer's own comment
  (`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`,
  `getRecentToolActivityByThreadId`) admits generic MCP calls with no
  distinguishing detail still collapse. New providers re-open the gap.
- **requires per-provider/per-tool enrichment forever** — every new tool shape is
  a new way for display ≠ identity to bite.
- **catches only verbatim repetition** — near-zero real incidence (0/18 here).

So the harden-the-signal asymptote is *"a signature that rarely false-positives
but also catches essentially nothing real"* — maximal maintenance, minimal value.
The evidence already sits at the value floor: zero true positives.

By contrast the **stall rail** (no activity row for 10m during an open turn,
measured off `getActivityFreshnessByThreadId`'s `maxCreatedAt` heartbeat) and the
**dead rail** (`failureCap` consecutive failed-session sweeps) have produced **0
false positives and 0 false negatives we can see** — because they read *real
absence of activity* and *real session failure*, not a lossy proxy of activity
*content*. This is the contrast that points at the redesign: **freshness/effect
signals are robust; content-signature equality is not.**

---

## 4. Options

| # | Option | Fixes Fault A? | Fixes Fault B? | Removes false-kill harm? | Cost | Verdict |
|---|--------|:---:|:---:|:---:|------|---------|
| A | Keep hardening presentation (ship same-file point fix) | partial (one more tool) | no | no | trivial | **Reject** — whack-a-mole; proxy still wrong; still auto-kills |
| B | Identity key = hash of `data.rawInput` (bypass presentation) | **yes** | no | no | small | Good *half*; needed eventually, insufficient alone |
| C | **Demote verdict: loop → advisory, not `error`** | n/a | n/a | **yes (all of it)** | trivial | **Primary — do now** |
| D | Progress-sourced signal (heartbeat + work-product/checkpoint deltas) corroborates repetition | yes | **yes** | yes | medium | **Primary — structural target** |
| E | Build Stage-2 LLM investigator (gate → judge → verdict) | yes | yes | yes | high | **Defer** — no real loops to justify cost yet |

Notes:

- **A is the trap.** It feels like "the fix" because it resolves the *visible*
  incident (`48d7345f`), but it leaves the auto-`error` harm and the proxy intact,
  and the very next collapse shape (an MCP tool, a new provider, two edits to two
  files in a 2-cycle) re-opens it. It also fixes *less* than C while touching the
  same rail.
- **B alone** still treats verbatim repetition as a kill, and still collapses
  `other`/MCP tools. It's the right *identity* mechanism but must be paired with
  C (advisory) and ideally D (progress corroboration).
- **C is the highest-leverage, lowest-risk move:** it removes 100% of observed
  harm in one edit and is reversible. It does not weaken dead/stall detection.
- **D is the principled destination** the design doc already argued for: judge
  *progress*, not call-name repetition. The substrate exists — the stall rail
  already consumes `maxCreatedAt`, and checkpoints/diffs are available
  (`getThreadCheckpointContext` / `getFullThreadDiffContext`).

---

## 5. Recommendation (primary, with migration path)

### Move 1 — NOW: sever `loop → error` (Option C)

In `WorkstreamLivenessSweep.ts`, the loop branch of `classifyLiveness` must no
longer return a verdict that `markError` turns into a terminal `error`. Make the
loop signal **advisory**:

- On a loop *suspicion*, append a `thread.activity.append` with **tone
  `warning`** and kind `workstream.liveness.loop` (so the board can surface "may
  be looping"), and **do not** call `thread.status.set error`. The thread stays
  live; the parent is not handed a false terminal child.
- Optionally, at most **one** parent nudge per episode (reuse the per-child wake
  rail / episode-key dedup from `.plans/phase-d-liveness-design.md` §1e) worded as
  *"child X may be looping on `<signature>`; investigate via
  `workstream_read_thread`/`workstream_ask_thread`"* — investigate, not kill.
- **Keep** the dead rail (`failureCap`) and the stall rail
  (`staleActivityWindowMs`) returning real `error`/stall verdicts unchanged.

This is the genuine fix to the user's "stop the whack-a-mole" ask: it removes the
false-kill mechanism wholesale rather than narrowing it once more. ~5 lines,
reversible, blast radius = the loop rail only.

**On the same-file point fix specifically:** do **not** ship it. If a zero-risk
stopgap is wanted *today* before any redesign, Move 1 *is* that stopgap and is
strictly better: it neutralises every false-positive shape (Era 1 generic
collapse, Era 2 same-file reads *and* edits, future MCP collapse) at once, where
the point fix only addresses same-file edits and leaves the auto-kill live.

### Move 2 — NEXT: identity key + progress corroboration (Options B+D)

When we want loop *suspicion* to be trustworthy (it currently is not), rebuild it:

- **Identity, not display:** compute the loop signature from a stable hash of the
  raw tool input — `data.rawInput` (now persisted) — e.g.
  `hash(itemType + canonical(rawInput))`, falling back to the presentation string
  only when `rawInput` is absent. This makes the four `48d7345f` edits four
  distinct signatures and is provider/tool-general. Drop `hasDiscriminatingDetail`
  in favour of "has `rawInput` to hash" (no `rawInput` ⇒ unprovable ⇒ no
  suspicion).
- **Corroborate with progress (the real lever):** only raise suspicion when
  repetition coincides with **no progress** — e.g. the activity heartbeat is
  advancing but the **checkpoint/work-product diff is unchanged** across the
  window, or for read/research threads the unique-signature ratio collapses
  *and* no new distinct artefacts/messages appear. This is what separates "slow
  real work" (diffs growing) from "spinning" (diffs flat). Substrate already
  present: `getActivityFreshnessByThreadId`, `getFullThreadDiffContext`.
- **Stay advisory/escalating**, never auto-killing, until there is evidence the
  combined signal is precise.

### Move 3 — DEFER: Stage-2 investigator (Option E)

Build the LLM investigator only once Move 2's advisory signal demonstrates real
loops exist and need disambiguation. Spending LLM budget to adjudicate a
phenomenon observed zero times is premature; revisit when the warning rail starts
firing on genuinely flat-diff threads.

### Migration path

1. Ship Move 1 (advisory demotion) behind the existing sweep — no contract
   change; `error` rail logic for dead/stall untouched. Verify with `vp check` +
   `vp run typecheck` and by replaying a same-file-edit thread (no `error`).
2. Land Move 2 incrementally: first the `rawInput` identity hash (kills Era-2
   collapse generally), then the progress corroboration. Keep the rail advisory
   throughout; watch the warning-row rate against real threads.
3. Only promote any loop verdict back to terminal `error` once it is gated by
   progress corroboration *and* (per the design) ideally a Stage-2 judge — and
   only with recorded true positives to justify it.

---

## 6. Every threshold, questioned

From `DEFAULT_LIVENESS_THRESHOLDS`:

- **`sweepIntervalMs` 60s** — fine; responsiveness vs read-model load. Not
  implicated. Keep.
- **`startupGraceMs` 120s** — gates active-turn detectors so a slow first tool
  call can't trip them. Not implicated (every false positive fired well into
  turns). Keep; generous is correct here.
- **`staleActivityWindowMs` 600s (10m)** — stall rail. 0 false positives, 0
  observed true positives. Conservative and robust (reads real activity absence).
  Keep; no evidence to lower it.
- **`loopWindow` 10 / `loopRepeat` 3** — the **load-bearing wrong numbers**, but
  the *number* is not the bug, the *signal* is. `repeat = 3` declares "3
  same-signature calls = stuck"; in coding, 3 same-type calls is routine, so 3 is
  far too twitchy *for this signal*. The design cites "AG2 LoopDetector defaults
  (window10/repeat3)" — that is **cargo-culted from a system with a different
  signal** (conversational action/message identity), not a lossy display
  projection of coding tools; the borrowed constant carries no authority here.
  Note also AutoGPT's cited rule is 3-identical-**failure**, not 3-identical-call
  — repetition of a *failing* action, which is a far better proxy than bare
  repetition. Under Move 2, drop reliance on a bare count: require identical
  identity-hash **and** flat progress (and ideally failing) before suspicion.
- **`failureCap` 3** — dead rail. Never fired; untestable from evidence. Leave
  as-is; it is the cheap, correct backstop for genuinely failed sessions.

---

## 7. Does this weaken catching genuinely stuck/dead threads?

No — and that constraint is honoured by design:

- **Dead** (crashed session / failed-state sweeps) → still auto-`error` via
  `failureCap`. Unchanged.
- **Stalled** (open turn, no activity for 10m) → still auto-`error` via the
  freshness heartbeat. Unchanged. This is the real "wedged agent" catch, and it
  reads *absence of activity*, which is robust.
- **Looping** (alive, emitting rows, not progressing) → moves from a false-firing
  auto-kill to an advisory that escalates to a human/parent, and (Move 2) becomes
  reliable by reading *progress*, not call-name repetition. We lose a detector
  that caught nothing real and gain one that can actually distinguish spinning
  from slow work.

The design's own thesis — *completion/kill authority outside the cheap detector;
judge work-product deltas; surface, don't strand* — is satisfied: cheap rail
suspects and surfaces; it never kills on its own.
