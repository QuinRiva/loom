---
manager_sessions:
  - id: b6619fe7-74e7-4b18-b97a-b6efe199590a
    role: plan
    authored_at: 2026-06-26T05:10:01.250Z
---

# Plan: fix the loop-detector signature collapse on the pi provider

## Symptom

Workstream sub-threads doing perfectly normal, varied work get marked `error`
with the verdict **"Stuck loop: the same tool call repeated ≥3× without
progress."** Observed live ≥3 times this session on coder threads (all running
the **pi provider**, model `claude-opus-4-8`) while they were genuinely
progressing (distinct reads / greps / edits / typecheck runs). The `error` is a
false positive and it terminates otherwise-healthy threads.

## Mechanism (recap)

`apps/server/src/orchestration/Layers/WorkstreamLivenessSweep.ts`, every 60s,
while a turn is active (after a startup grace):

1. Pulls the thread's last 10 `tool.completed` rows, most-recent-first
   (`getRecentToolActivityByThreadId`, `loopWindow: 10`).
2. Reduces each to a signature `summary\u0000detail` via
   `normalizeToolSignature`, where summary/detail come from
   `deriveToolActivityPresentation` (`packages/shared/src/toolActivity.ts`).
3. `detectActivityLoop` trips on either a **leading run of ≥3 identical
   signatures** (`loopRepeat: 3`) or an **A,B,A,B,A,B alternation** over the most
   recent 6.
4. A `loop` verdict sets the thread to `error` — a single sweep is enough.

It is blind to everything between tool calls (reasoning, file edits). "Without
progress" means only "without a change in the tool **signature**."

## Root cause (confirmed against `state.sqlite`)

For the **pi provider**, the stored `tool.completed` activity payload carries
only the tool *result*, not the *input*. Verified rows:

```
summary:"bash" itemType:"command_execution" detail:undefined data keys:[content]
summary:"read" itemType:"dynamic_tool_call"  detail:undefined data keys:[content,details]
summary:"edit" itemType:"file_change"        detail:undefined data keys:[content,details]
```

`deriveToolActivityPresentation` recovers the discriminating content
(command line / path / query) by reading `data.item.command`,
`data.rawInput.command/args`, path fields, or a backtick in the title. **None of
those exist in the pi payload** (`data` is just `{content}`; the title is the
bare tool name; `detail` is absent). So it falls through to the generic branch:

- `command_execution` (bash, and all rg/grep/find run via bash) → `"Ran command\u0000"`
- `dynamic_tool_call` (read) → `"read\u0000"`
- `file_change` (edit) → `"Changed files\u0000"`

Every call of a given tool type collapses to **one identical signature**. The
loop detector therefore sees the pi tool stream as a handful of generic tokens,
and **any 3 same-type calls in a row trip it** — which is most real work. The
collapsed stream for one errored thread was literally `Ran command`×5 in a row.

**Why PR #12 didn't fix this.** PR #12 (`session 4c93b0ad`) fixed the identical
collapse for the **codex** payload shape, whose payloads *do* carry
`data.item.command`. For the pi provider there is nothing to recover, so PR #12's
fix is a no-op and the original bash-collapse bug is fully present for every
pi-driven thread. This is the same bug class, re-manifested per-provider.

## Phase 1 — Where the discriminating input lives (RESOLVED by review)

The seam is **`PiDriver`**, not `ProjectionPipeline`. Review verified that args
are dropped *before* any persisted row, so read-model/ProjectionPipeline
correlation is **impossible**:

- pi args live on `tool_execution_start.args` / `tool_execution_update.args`
  (`RpcProcess.ts:93-105`), keyed by `toolCallId`.
- `PiDriver.ts:544-575` maps `tool_execution_end → item.completed` with
  `data: message.result` (`{content, details?}`) and **drops `args`**. The
  `item.started`/`item.updated` projector (`ProviderRuntimeIngestion.ts:604-622`)
  omits `data` entirely, so args never reach a persisted row by that path either.
- ⇒ The only layer holding both halves in one stream is **`PiDriver`**. It
  already keeps per-thread mutable `ActivePiSession` state (e.g.
  `currentAssistantMessageId`, `PiDriver.ts:111-118`). Stash `args` by
  `toolCallId` on `tool_execution_start`/`update`, then merge them into the
  `item.completed` payload on `tool_execution_end`. **~10 lines in one driver —
  cheap, not structural.**

**Pin the pi arg-key contract before coding (the one spec-tight item).** The repo
never asserts pi's `args` shape. Verify the real key names against a live pi
`tool_execution_start` — bash (`{command}`?), read (`{path|file|filePath}`?),
edit (`{path}`?). A wrong key silently re-collapses the signature with no error,
so this is the one place a guess corrupts output invisibly.

## Phase 2 — Fix (two parts; the guard is mandatory, the signal fix is the real cure)

**A. Restore a discriminating signature for the pi provider (the real fix).**
Carry pi's tool args into the `item.completed` payload at the `PiDriver` seam
(Phase 1) so the loop signature reflects the actual command/path/query (this also
improves the timeline/UI presentation, not just the loop signature).

**Critical: a single "stuff args into `data`" shape only HALF-fixes it.** Review
proved the branches in `classifyToolAction`/`deriveToolActivityPresentation`
(`toolActivity.ts`) honor different fields:
- `command_execution` (bash) → honors only `data`-derived `command`.
- `file_change` (edit) → honors only `extractPrimaryPath(data)`.
- `read` → pi maps it to `dynamic_tool_call` (`PiDriver.ts:337,352`), and
  `classifyToolAction` routes title `"read"` to the **`"other"` branch**, which
  honors **only the top-level `detail`** field and ignores `data` entirely.

So putting args only in `data` discriminates bash + edit but leaves **`read`
still collapsed** — a re-run of PR #12's fix-one-shape-blind-on-another mistake.
The fix must make **bash, read, AND edit** each yield distinct signatures. Either
(a) set the top-level `detail` from args (covers the read/"other" path) *and*
`data.command`/path (covers command/file_change), or (b) teach
`classifyToolAction` to recognise pi's `read`. Either is acceptable; the test
**must cover all three classes with real pi fixtures** (not just bash).

**B. Refuse to declare a loop with no discriminating detail (the safety guard).**
Regardless of A, the detector must not trip when the signatures it is comparing
carry **no detail** (a bare generic token like `"Ran command\u0000"`). A run of
detail-less signatures is *unprovable* as a loop — it only means the detector
can't see the args — so it must not be treated as one. This makes a missing-detail
provider fail safe for any provider, present or future, even if A regresses.

**The guard must cover BOTH detector branches** (`WorkstreamLivenessSweep.ts:79-97`):
the leading identical-run AND the **A,B,A,B,A,B alternation** path. A pi thread
alternating read/edit yields `"read\u0000","Changed files\u0000"` — distinct but
detail-less — which trips the alternation branch; gating only the identical-run
leaves that hole open. Gate the verdict on "the tripping signatures carry
distinguishing detail" in both paths.

*Implementation note (optional):* `detectActivityLoop` currently takes pre-joined
`summary\u0000detail` strings. Prefer passing the structured `{summary, detail}`
signals (push the join inside the detector) so the guard reads `detail`
explicitly rather than relying on the fragile "string ends in `\u0000`" check.

*Accepted blind spot:* a genuinely stuck agent hammering a residual detail-less
tool (only the `"other"` class after Fix A) becomes undetectable — far smaller
than the current epidemic of false `error`s, and the stall rail is no backstop
(a looping agent keeps emitting rows). Conservative trade, accepted.

Recommendation: **ship A + B together.** Review established A is ~10 lines in one
driver (not structural), so the "B-first" split buys little — and B alone *fully
disables* loop detection for pi (every current pi signature is detail-less). A
restores real detection; B makes it fail-safe. Fallback stands: if A slips,
B-alone is the right interim (a false kill is far worse than no detection).

Do NOT instead just widen the thresholds (`loopRepeat`/`loopWindow`) — that masks
the symptom without fixing the collapse and weakens real loop detection.

## Tests

- Detector guard (pure, deterministic), **covering BOTH branches**: ≥3 identical
  *detail-less* signatures must NOT trip; a read/edit-alternating *detail-less*
  run (`"read\u0000","Changed files\u0000"`×3) must NOT trip; ≥3 identical
  *detailed* signatures still trips. Mirror `WorkstreamLivenessSweep.test.ts`.
- Presentation: `deriveToolActivityPresentation` over **bash, read, AND edit** pi
  fixtures each yields distinct detail (not just bash — the gap that let PR #12
  regress on the read/"other" branch).
- Driver correlation: a **`PiDriver`** test that `item.completed` carries the
  command/path after `tool_execution_start`→`end` arg correlation. (Re-pointed
  from `ProjectionPipeline`, where the args are proven not to be in scope.)

## Verification

- `vp run typecheck` and `vp check` green; `vp test` passes incl. new cases.
- Replay/representative check: a pi-driven thread issuing several distinct
  bash/read calls in a row no longer earns a `loop` verdict; a thread genuinely
  hammering the identical command still does.
- Ship via the AGENTS.md PR flow only after user approval; leave uncommitted
  otherwise.

## Coordination / context

- This is a **distinct bug** from the idle false-positive
  (`.plans/idle-detection-false-positive-fix.md`). Both are liveness-by-narrow-
  signal false positives biting the same pi-driven sub-threads; they can ship
  independently.
- It is the same bug class PR #12 addressed for codex; reference that PR's
  signature/query changes as the codex-side precedent.
- Both bugs were reproduced *on this project's own workstream threads* this
  session — those incidents are the canonical evidence.
