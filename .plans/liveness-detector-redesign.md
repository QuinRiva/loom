---
manager_sessions:
  - id: 2d4d011f-f6fa-46dd-83ef-88d7b59d27fe
    role: architecture
    authored_at: 2026-06-29T03:35:31.045Z
---

# Liveness detection redesign — read the runtime, don't reverse-engineer it

**Status:** agreed end-state design + phased plan. Supersedes the per-symptom
trajectory of `.plans/loop-detector-signature-collapse-fix.md` and the proposed
same-file-edit point fix. Builds on the diagnosis in
`.plans/liveness-detector-architecture-review.md` (the evidence and root-cause
analysis live there; this doc is the destination and the route to it).

**Scope boundary (important):** this work is **detection + response (wake/
surface)** only. It does **not** redefine status semantics. A separate framework
rearchitecture is making `error` a runtime-*derived* lane rather than an
agent-set one; we produce the signals that model needs and use the parent-wake
path for recoverable cases, but we do not change what any status *means*.

---

## 1. Why the current detector keeps failing (one-paragraph recap)

Liveness is reverse-engineered from a *display-oriented* projection of tool
**results** (`deriveToolActivityPresentation` → `summary\u0000detail`), used as an
*identity/equality key*, and wired straight to a terminal `error`. A display
projection compresses for humans (an edit shows the path, not the diff) — the
opposite of preserving discriminators for equality — so legitimate repeated work
(several edits to one file) collapses to one signature and trips a false "loop".
The deeper fault is that **tool-call repetition is the wrong proxy for progress**:
it over-fires on normal coding and under-fires on real spinning (which varies its
args each cycle). The full evidence and proof are in the review doc.

**Why it was built this way (the real lesson):** upstream T3 Code is
**multi-harness**, so the watchdog used the lowest-common-denominator signal
(coarse tool rows) available across every provider. This repo is a **Pi-first
fork**, and Pi exposes a far richer native liveness feed we can build on directly.

## 2. The signal we were ignoring: Pi's native runtime feed

Pi streams a structured event feed over its RPC stdio channel
(`apps/server/src/provider/Layers/Pi/RpcProcess.ts`, `PiRpcStdoutEvent`):

- `agent_start` / `agent_end` — brackets one agent run (= one T3 turn).
- `turn_start` / `turn_end` — internal model rounds.
- `text_delta` / **`thinking_delta`** — token-level streaming of answer *and*
  reasoning. This fires continuously even with no tool calls — the true
  "it's working right now" heartbeat.
- `tool_execution_start / update / end` — every tool call lifecycle.
- `extension_ui_request` (`select|confirm|input|editor`) — the agent is
  **blocked waiting for input** (an explicit, distinct signal).

What the server currently persists into the read model the watchdog reads:
`activeTurnId` (from agent_start/end), `hasPendingUserInput`/`hasPendingApprovals`
(from input-requests), and tool-activity rows. **It discards the continuous
token/reasoning heartbeat for liveness purposes** — the freshness signal
(`getActivityFreshnessByThreadId`) is the newest *activity row's* timestamp, and
"assistant/reasoning deltas don't create rows." So a child reasoning hard for 11
minutes with no tool call looks *silent* to the watchdog while it is visibly
streaming thinking. That gap is the root enabler of stall/loop guesswork.

## 3. The end state

### 3a. Foundation — a real runtime heartbeat

Persist **one lightweight "last runtime activity at" heartbeat per thread that
ticks on ANY runtime event**: token delta, reasoning delta, tool start/end, turn
boundary. Debounced (update at most ~every few seconds) so a token stream does
not hammer the DB. This is the ground-truth "the agent is doing something"
signal; every state below reads off it.

**Coordinate:** the parallel effort is adding `lastActivityAt` to
`workstream_list` nodes and reads freshness in `ProjectionSnapshotQuery.ts`. The
heartbeat should reuse / extend `lastActivityAt` rather than introduce a second
freshness concept. Expect a merge touch-point in `ProjectionSnapshotQuery.ts`.

### 3b. Four distinguishable states (replacing one blunt "error")

This encodes the failed-vs-stalled distinction: **only State A is unrecoverable.**

| State | Detected from | Recoverable? | Response |
|---|---|---|---|
| **A — Dead** | session error / process exit / active turn but binding gone | No | Surface as a real fault to the parent (objective; auto-act). Status mapping left to the status redesign. |
| **B — Waiting for input** | `hasPendingUserInput` / `hasPendingApprovals` set | Yes (answer it) | Wake the parent: "child needs an answer." Never a kill. (Watchdog ignores this today.) |
| **C — Stalled (silent)** | open turn, heartbeat frozen ≥ window, AND not in state B | Usually (re-prompt) | Wake the parent and/or auto-nudge once (force next turn) before escalating. **Not** an immediate terminal kill. |
| **D — Possibly spinning** | heartbeat advancing (busy) BUT work product not progressing | Maybe | Wake the parent with evidence; parent judges. Never a kill. **Behind an easy on/off switch.** |

The heartbeat is what separates **C** ("actually silent") from **D** ("busy but
maybe stuck") — a distinction the current code cannot make. State A is the only
one that auto-acts on its own authority; B/C/D wake the parent.

### 3c. State C — the failed-vs-stalled fix

Your canonical example: an agent issues a malformed tool call, it errors, and
"nothing happens." The process is alive; it just needs a poke. Today C and A both
collapse to terminal `error`. In the end state C is a **recoverable stall**: wake
the parent (and/or auto re-prompt once). The actual "stalled vs failed" *status
lane* is the status-redesign's job; we supply the detection and the recoverable
response, and do not set terminal status ourselves for C.

### 3d. State D — progress, not repetition (the subjective one, isolated)

Detect "busy but not progressing": the heartbeat is advancing but the **work
product is flat** over the window. For a **coder**, that means the checkpoint diff
is unchanged/oscillating across the window (substrate exists:
`getThreadCheckpointContext` / `getFullThreadDiffContext`). Optionally corroborate
with an **identity** key — a hash of the raw tool *input* (`data.rawInput`, now
persisted), NOT the display string — so "same input repeated AND diff flat" is the
trigger. Researchers/reviewers (no files) are **not** covered by the cheap signal;
their spinning is surfaced only if/when the parent notices — acceptable.

**Response:** append an advisory activity (tone `warning`) and wake the parent at
most once per episode with the evidence ("active 15 min, diff unchanged, repeating
`<input>`"). It **MUST NOT** call `thread.status.set`. The thread stays running.

**Disable requirement (explicit):** State D is the highest false-positive risk and
must be **trivially disableable** — a single flag (e.g.
`enableProgressLoopDetection` in `DEFAULT_LIVENESS_THRESHOLDS`) that short-circuits
the entire State-D branch. Flipping one boolean removes it with zero other
changes. Keep the branch self-contained so it can also be commented out cleanly.

### 3e. Parent as judge — two investigation paths, by scenario

The parent holds judgment for B/C/D (we may add a dedicated investigator later;
not now). It has two complementary ways to investigate, used per scenario:

1. **Read the session JSONL directly** (via the new `workstream_list`
   `sessionPath`; grep/jq the transcript). Use when the signal is a *tool error
   the child may be unaware of* — the error sharpens in the JSONL but the child's
   own narrative won't mention it, so asking the child wouldn't surface it.
2. **`consult_thread`** (ask the child, read-only frozen fork). Use when the child
   is *struggling with a hard task* — the child's own account of the difficulty is
   the most useful read.

(`workstream_read_thread` / `workstream_ask_thread` are being removed/merged into
`consult_thread`; do not build on them.)

### 3f. What stays unchanged / out of scope

- **Status semantics**: untouched. No redefining `error`; defer the failed-vs-
  stalled *lane* to the status redesign. We only stop the *loop* path from setting
  `error`, and route B/C/D through the parent-wake path.
- **Dead and the stall freshness rail** keep working; the stall rail simply reads
  the improved heartbeat and becomes input-aware (State B gate).
- **Control-plane marker**: parent wakes ride the existing child-wake path and
  inherit the `[T3 Workstream control plane — automated notice, not from the
  user]` prefix; word them as "investigate", not "killed".

## 4. Thresholds (questioned, not cargo-culted)

- `sweepIntervalMs` 60s, `startupGraceMs` 120s, `failureCap` 3 — fine, keep.
- `staleActivityWindowMs` 600s — keep, but it now measures the *real* heartbeat
  (deltas included), so it stops false-firing on long reasoning.
- `loopWindow 10 / loopRepeat 3` — **retired.** These are AG2 defaults for a
  different signal (conversational action identity); they carry no authority over
  a coding-tool stream. State D replaces them with progress + (optional) input-
  identity, not a bare repeat count. (Note: AutoGPT's analogous rule is 3
  identical *failures*, not 3 identical *calls* — repetition of a failing action
  is a far better proxy than bare repetition, and is subsumed by State C/D.)
- New: a State-D `noProgressWindowMs` (how long the diff must be flat while busy
  before suspicion) — start generous (e.g. 10m) and tune from real runs; behind
  the same disable flag.

## 5. Phased plan

**Phase 1 — Foundation + stop the false kills (low risk).**
1. Persist the runtime-event heartbeat (token/reasoning deltas + tool + turn),
   debounced; reuse/extend `lastActivityAt`. Point the stall rail at it.
2. Make the sweep **input-aware** (State B): a child with pending input/approvals
   is never "stalled"/"dead"; surface "needs input" to the parent instead.
3. **Retire the tool-signature loop detector** (`detectActivityLoop`,
   `normalizeToolSignature`, `hasDiscriminatingDetail`) and its `loop → error`
   edge. No same-file point fix.

**Phase 2 — State D, behind the disable flag.**
4. Diff-based "busy-but-not-progressing" advisory that wakes the parent (never
   sets status), gated by `enableProgressLoopDetection`. Self-contained branch.
5. Optional input-identity corroboration via `hash(rawInput)`.

**Phase 3 — Recoverable-stall response polish (coordinate with status redesign).**
6. State C auto-nudge-once (force next turn) before escalating, IF it can be done
   without touching status semantics; otherwise leave C as a parent-wake and let
   the status redesign own the lane.

**Gates throughout:** `vp check` + `vp run typecheck` green. Validate against the
recorded false-positive shapes in `~/.t3/cockpit/userdata/state.sqlite` (esp.
`48d7345f` same-file edits → must raise nothing) and confirm a genuinely silent
child still trips stall. Ship via the AGENTS.md PR flow only after sign-off.

## 6. Migration / coordination notes

- Different worktree/branch from the framework rearchitecture; rebase carefully,
  expect a conflict in `ProjectionSnapshotQuery.ts` (shared `lastActivityAt`).
- Keep every change in **detection/response**; if a step requires changing what a
  status means, stop and coordinate with the status redesign instead.
