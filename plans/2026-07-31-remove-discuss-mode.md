---
manager_sessions:
  - id: fc537094-bc30-48d6-b476-eb045c25dbfe
    role: plan
    authored_at: 2026-08-01T03:24:40.822Z
---

# Remove Discuss mode: terminal threads resume with full capability

**Status:** design — **revision 3**, reviewed: **endorse-with-changes**
(`workstream-reports/5504868c-127b-49d4-93ac-9fc084274bbe.md`; its two
must-fixes M1/M2 are incorporated below and are part of the implementation
spec). Revisions 1–2 proposed
scoping Discuss mode to children (F1) and restarting on mode mismatch (F2);
both were reviewed (`workstream-reports/d3fdfe96-…`, technical audit;
`workstream-reports/1ff3b7c2-…`, design critique — endorse-with-changes).
Carl then challenged the premise: Discuss's read-only cage exists to protect
**diff attribution of post-completion follow-up edits** — a UI nicety — at the
cost of a hard capability limit and a mode-transition state machine (the
predecessor's Phase 2 Edit design) whose complexity is not justified by that
value. Revision 3 therefore **removes Discuss mode entirely** instead of
scoping it. F1/F2 and the predecessor's Phase 2 die with it.
**Date:** 2026-07-31
**Predecessor:** `plans/2026-07-30-post-completion-subthread-engagement.md`
(Phase 1 shipped; this plan removes its §5 engagement-mode split while
keeping its load-bearing fixes)

## 1. Decision and rationale

**Every thread, terminal or not, resumes with its full launch:** role
overlay, goal context, ship policy, skills, full tool surface, and the
workstream extension. There is no read-only engagement mode.

### 1.1 Why the cage existed, and why it goes

The predecessor plan fixed four hard failures and added one policy. The
fixes stand; the policy goes:

| Concern | Fixed by | Fate |
|---|---|---|
| Crash on dead cwd (`0ab903d0`) | `--cwd` override at launch (pi patch §4.1) | **keep** |
| Silent amnesia (same-id empty session) | explicit `--session <path>` resolution | **keep** |
| Kickoff brief re-delivered to a completed child | session-file-exists guard (`shouldReprovisionIsolatedChild`) | **keep** |
| Worktree deleted under a live process | workspace lease (§7) | **keep** |
| Post-completion edits mis-attributed / concurrent writes | **read-only Discuss mode** | **remove** |

Every mechanism that prevents a *broken* thread is orthogonal to the tool
restriction. What read-only bought was: (a) follow-up edits by a fanned-in
child cannot land in the parent's tree under the parent's attribution, and
(b) no same-file clobbering if the parent is mid-turn in the same tree
simultaneously. (a) is cosmetic — the child's *historical* work remains fully
attributed (its own thread diffs, its merged branch, `finalCommitSha`); only
edits made *after* completion attribute to the tree they land in, which is
where fan-in would have put them anyway. (b) is the same risk a human editing
alongside any live agent already carries, accepted everywhere else in the
product.

Against that value stood: a second engagement mode, a durable mode-provenance
state machine (predecessor §5.3), an explicit human-driven mode-promotion
affordance plus per-switch worktree provisioning and process restart
(predecessor §5.2), gate-verdict invalidation machinery (§6.3) — and, as
shipped, a whole class of "thread is mysteriously read-only and cannot free
itself" failures: a re-engaged root orchestrator (observed live, thread
`17063e98`) resumed with no bash, no edits, and no workstream tools, unable
even to reopen its own lane. The mode was re-derived from durable state at
every launch (by design), so restarts changed nothing.

### 1.2 Workstream tools return too (Carl's explicit decision)

A re-engaged terminal thread gets its workstream extension back. The
control plane already handles post-terminal activity sanely:

- **Sticky terminal** (`decider.ts:1313-1317`): a turn-start on a
  `done`/`cancelled` thread changes neither lane nor stored attention.
- **Plain terminal re-submits are rejected** by the decider's terminal-lane
  guard (`decider.loom.ts:875`, review N1) — the guard, not the missing
  extension, is what makes post-terminal submits safe. A re-submit lands only
  after a deliberate lane reopen, which is the intended path:
- **Re-submit after reopen**: a terminal submit records a fresh outcome event;
  `terminalEpisodeKey` prefers the newest outcome id
  (`WorkstreamDispatcher.ts:879-889`), so the parent's delta rail reports the
  re-run as news — at-least-once, possibly digest-batched (predecessor
  fact 6). A child that fixes something post-completion and re-submits
  produces exactly the right consequence signal.
- **Re-engagement epoch**: a lane reopen re-stamps `spawnGeneration`
  (`decider.loom.ts:538-568`) — unchanged, still available for deliberate
  re-runs.

Consequence accepted by this decision: "conversing with a child does not
notify the orchestrator" (predecessor §6.1) weakens from a *structural*
guarantee to a *behavioural* one — a re-engaged child that merely answers
questions still notifies nobody (it submits nothing), but it now *could*
submit. That is the point: whether a follow-up conversation becomes work is
the human's and the agent's call, not a mode's.

## 2. Changes

All in the loom fork; no pi-binary change. This is predominantly a
**deletion**.

### C1 — remove the Discuss branch from the turn-start path

`apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`:

- Delete `isDiscussLaunch` (`:155-159`), `DISCUSS_READONLY_TOOLS` (`:126`),
  `DISCUSS_READONLY_PROMPT` (`:132`), the `discussMode` computation (`:695-698`),
  and the entire `if (discussMode)` branch inside `startProviderSession`
  (`:705-732`). Every launch takes the (previously "normal") full-composition
  path.
- **Keep** `discussRelocationClause` (`:139-142`) but rehome it (C3).
- **Keep** `shouldReprovisionIsolatedChild` (`:171-179`) and the turn-start
  chokepoint guard untouched — that is the brief-redelivery fix, independent
  of engagement modes.

### C2 — remove the `readOnly` plumbing

- `packages/contracts/src/provider.ts:96`: delete `readOnly` from
  `ProviderSessionStartInput` (it was added by Phase 1 and has exactly one
  consumer).
- `apps/server/src/provider/Layers/ProviderService.ts:879-881`: the
  `readOnly ? clearMcpSession : prepareMcpSession` conditional collapses to
  unconditional `prepareMcpSession` (the pre-Phase-1 behaviour). The
  `clearMcpSession` helper itself stays — the session-stop/error paths
  (`:691-694`) still use it.

### C3 — rehome the relocation preamble

The situational-awareness preamble is the one genuinely valuable piece of the
Discuss launch: a fanned-in child's transcript remembers absolute paths in a
deleted checkout, and it must not edit under stale assumptions. Keep it,
detached from any mode:

- On **every** launch of a thread whose recorded workspace moved — trigger:
  **`finalCommitSha != null` alone** (review must-fix M1: the Phase 1
  `worktreePath === null` disjunct is wrong on the universal launch path,
  since every root and every shared child runs with a null worktreePath and
  would receive a false "your work was merged" preamble after any server
  restart; `finalCommitSha` is stamped only by fan-in/cancel on children, so
  it is the clean relocation signal) — append a relocation clause to the
  composed `appendSystemPrompt` (after role overlay/goal context):

  > "Your work here previously happened in a working directory that no longer
  > exists; you are now in `<cwd>` (the parent's current tree / the project
  > workspace). Your merged work is commit `<finalCommitSha>`. Absolute paths
  > you remember are historical; re-verify before editing."

- Reworded from the Phase 1 copy: no "you are read-only" framing, and it must
  instruct *care*, not *incapacity*.
- This composes with the full launch, so it reaches exactly the threads that
  need it (relocated ones) on every resume, root or child, terminal or not.

### C3b — close the resolved-gate re-drive hole (review must-fix M2)

Discuss's missing workstream extension structurally prevented a re-engaged
terminal **reviewer** from re-submitting a loop-routed verdict. With the
extension back, `routeWorkSubmit` → `loop` slips through the decider's
terminal-lane guard exception (`decider.loom.ts:871-874`), letting a done
reviewer reopen an already-done coder and re-drive a gate whose verdict
already released dependants. Tighten the exception to require the submitting
thread to be the pending-rework target:

`planLane === "done" && routing.decision === "loop" && submitThread.pendingRework === true`

`pendingRework` is carried only by the rework target/coder
(`projector.loom.ts:350,578`), so the 2026-07-07 incident case (force-done
coder handing back) still passes while the reviewer hole closes.

### C4 — tests

- **Delete**: the Discuss-decision suite
  (`ProviderCommandReactor.engagement.test.ts` — the `isDiscussLaunch` rows;
  keep the `shouldReprovisionIsolatedChild` rows in that file), the
  read-only-argv test in `RpcProcess.test.ts:90-107` (the generic
  `--tools`/`--skill` plumbing test at `:11-23` stays — role allowlists still
  use it), and the stale §6.1 comment block in
  `WorkstreamDispatcher.test.ts:1430-1440`.
- **Add**:
  1. *Terminal resume is a full launch* — argv-level: a resumed `done`
     fanned-in child carries the workstream extension, no restrictive
     `--tools`, and the relocation clause in its system prompt.
  2. *Terminal root resume is a full launch* — the observed-failure
     regression test (thread `17063e98`'s shape).
  3. *Relocation clause fires on relocation only* — a thread whose own
     worktree still exists resumes with no relocation clause.
  4. *Sticky terminal unchanged* — terminal resume still changes no lane and
     no attention (existing invariant, re-pinned against the new path).
  5. *Post-terminal re-submit reports as news* — already pinned by
     `terminalEpisodeKey` unit tests; verify they survive unchanged.
  6. *Done reviewer's loop-routed re-submit is rejected* (M2 pin); the
     pending-rework coder hand-back still passes.
  7. *(nice-to-have N6)* terminal resume carries the `T3_WORKSTREAM_*` env,
     pinning the prepared-MCP-session path end-to-end.
- **Reword, don't orphan** (review N4): stale Discuss references at
  `orchestration.loom.ts:445,829`, `WorkstreamFanInReactor.ts:207,374`, the
  `discussRelocationClause` name (rename to `relocationClause`), and the
  `engagement.test.ts` header docstring.
- **Keep untouched**: `PiCwdOverride.contract.test.ts` (the `--cwd` pin),
  `WorkspaceLease.test.ts`, all fan-in/reaper tests.

### Explicitly out of scope

- The pi `--cwd` patch, session-file resolution, workspace lease, reaper,
  fan-in — all Phase 1 keepers, untouched.
- `consult_thread` — unchanged; still the cheap one-shot oracle (its
  read-only-ness is *its* correct contract: it is a throwaway fork, not the
  thread).
- Serialising concurrent writers in a shared tree (parent mid-turn + re-engaged
  child). Accepted risk, same as human-alongside-agent editing. Pre-existing.
- UI marker for "terminal-lane thread with live session" (nice-to-have
  observability follow-up from rev-2 review, unchanged by this revision).
- The rev-2 reviews' §6.3 gate-invalidation machinery: with modes gone this
  is no longer *activated* by anything new — a human deliberately asking a
  gate-approved coder to change something post-verdict is the same manual
  override it always was. Recorded as a known gap, not new machinery.

## 3. Behaviour after the change

| Thread, re-engaged in terminal lane | Result |
|---|---|
| Root orchestrator | full launch — works, delegates, manages lanes (fixes `17063e98`) |
| Fanned-in isolated child (worktree reaped) | full launch **in the parent's worktree**, relocation clause in prompt; may read, edit, re-submit |
| Child whose own worktree still exists | full launch in its own worktree, no relocation clause |
| Cancelled thread (root or child) | full launch; lane stays `cancelled` until deliberately changed (sticky terminal) |
| Orphaned child (parent gone) | full launch at project `workspaceRoot` fallback, relocation clause |
| Any thread with a live session when its lane goes terminal | session simply continues if messaged (no mode restart needed — modes no longer exist) |

Follow-up edits attribute to the tree they land in (usually the parent's).
The child thread's own historical diffs are unaffected.

## 4. Risks, stated honestly

1. **Attribution blur on follow-up edits** — accepted by decision (§1.1).
2. **Concurrent same-tree writers** — narrow window (requires the parent
   mid-turn simultaneously); accepted (§1.1b).
3. **A re-engaged terminal child can now re-submit/spawn.** Handled by
   sticky-terminal + fresh-outcome delta rail (§1.2); the residual risk is an
   agent *choosing* to submit when the human only wanted a chat — mitigated by
   the relocation clause's "re-verify before editing" framing and by it being
   visible on the parent's delta rail rather than silent.
4. **Rev-2's non-pi churn-restart finding dissolves** — with no mode compare
   there is no restart trigger; non-pi drivers keep today's reuse behaviour.
5. **Regression surface**: the deletion touches the single turn-start
   chokepoint every launch funnels through. The C4 test set pins the
   invariants that must survive (sticky terminal, no re-provision, no brief
   re-delivery, relocation prompt).
