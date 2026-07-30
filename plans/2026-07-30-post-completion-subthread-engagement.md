---
manager_sessions:
  - id: 0b1f1669-e991-41f0-bc8d-3cf2bcb8dad4
    role: plan
    authored_at: 2026-07-30T03:08:40.701Z
---

# Post-completion sub-thread engagement

**Status:** design — **revision 3** after three independent reviews
(`workstream-reports/26a2cd60-cdb0-47a2-8f29-295678d4d68c.md` technical-claims
audit; `workstream-reports/f49abfb3-9500-402f-a4d7-0e421367f9a0.md`
design-coherence critique; `workstream-reports/38d40a98-a52c-453c-96e7-55f53396a398.md`
rev-2 verification, which endorsed the relocation + isolated-Edit architecture
and blocked on four items, all resolved in this revision: occupancy is now an
atomic workspace lease rather than a check-then-act snapshot (§7); Edit mode is
derived from durable state so it survives a server restart (§5.3); a gated
Edit's consequence wake names already-started dependants (§6.3); and test 7's
delivery assertion matches the accepted at-least-once contract (§9). Rev 1 designed around "a pi session's cwd is
immutable" and proposed resuming a completed child "with a fallback to the
parent's worktree". Both reviews falsified that: the fallback was not a
mechanism (empirically it produces **silent context loss**, not an error), the
"diff tracking is isolation-independent" claim was false for concurrent
writers, and — decisively — pi already supports cwd relocation
(`SessionManager.open(path, sessionDir, cwdOverride)`); only the RPC entry
point fails to expose it. Rev 2 rebuilds the design on that capability: **one
thread, one session, forever; the workspace is a per-launch parameter.** A
fork-based "companion session" alternative was considered and rejected — we
are not forking the conversation; there is no divergence point, the human is
simply still talking.
**Date:** 2026-07-30
**Scope:** one small pi patch (expose `cwdOverride` on the RPC/headless resume
path), Loom resume-launch plumbing, `finalCommitSha` on the thread shell,
runtime-truth occupancy shared by the fan-in reactor and the worktree reaper,
a Discuss/Edit engagement split, and wake-copy provenance. No new conversation
model, no new notification rail.

## 1. Motivation

Loom's differentiator over conventional sub-agent systems is that a sub-thread
is a **durable, addressable interlocutor**, not a throwaway. In most systems
the human can only reach a sub-agent through the orchestrator. In Loom the
human should be able to open a completed coder sub-thread and ask "why is this
written this way?" — without spending orchestrator context, and without the
orchestrator mediating.

That capability is currently **broken for isolated children that have
completed and fanned in**.

### 1.1 The observed failure

Re-engaging thread `0ab903d0` ("Native v2 consumption design") produced:

```
Pi RPC process 'pi' exited with code 1.
Stored session working directory does not exist:
  /home/Carl/.t3/cockpit/worktrees/t3code-c99c15a9/ws-t3code-c99c15a9-planner-0ab903d0
```

Event-store timeline (stream `0ab903d0`, independently re-derived by the
technical audit at sequences 555478–555485):

| Time (2026-07-30) | Event |
|---|---|
| 00:44:59.025 | `thread.turn-start-requested` (actor `client`), session → `starting` |
| 00:45:01.311 | `thread.meta-updated` → fresh `ws/…` branch + worktree **re-provisioned** |
| 00:45:01.670 | `setup-script.started`; pi RPC launched with that worktree as cwd |
| **00:45:04.743** | `thread.meta-updated` → reverted to parent's branch/worktree (`finaliseRemoval` ran) |
| 00:45:04.746 | pi exits code 1 — stored session cwd deleted beneath it |
| 00:45:05.355 | `setup-script.failed` |

Two subsystems fought over one worktree inside three seconds.

### 1.2 Two defects, one root cause

**Defect A — the race.** `isOccupied`
(`apps/server/src/orchestration/Layers/WorkstreamFanInReactor.ts:261-273`)
treats every terminal-lane thread as a non-occupant and excludes the child
itself, so "terminal plan lane" is used as a proxy for "no process is using
this directory". A `done` child a human is talking to is terminal *and* live.
The deferred-removal sweep (`WorkstreamFanInReactor.ts:569-593`) therefore
deletes a worktree that turn-start provisioned seconds earlier — and
`thread.session-set`, emitted by the turn start itself, re-arms the sweep
(`WorkstreamFanInReactor.ts:639-648`), so the resume reliably triggers its own
executioner.

**Defect B — provisioning state is inferred, not recorded.** The turn-start
chokepoint (`ProviderCommandReactor.ts:1105-1136`) sniffs the branch name
(`isProvisionedChildBranch`). Fan-in repoints `branch` to the parent's branch
(`WorkstreamFanInReactor.ts:319`), so afterwards the predicate cannot
distinguish "never provisioned" from "provisioned, fanned in, worktree
reaped". It guesses the former: it cuts a **fresh multi-gigabyte worktree plus
a full bootstrap install** to answer a question, sets
`recoveredNeverStartedChild`, and **re-delivers the entire kickoff brief**
(`ProviderCommandReactor.ts:1139-1158`) to a child that already completed its
work.

Defect B is the deeper one: **the only door into a completed thread is the
rework door.**

**Defect A′ — the reaper has its own copy of A.** The six-hour worktree reaper
uses the same terminal-lane occupancy proxy independently
(`worktreeClassification.ts:162-185`) and ignores session runtime entirely. A
fix confined to the fan-in reactor leaves the identical bug on a slower timer.

### 1.3 Scale — corrected from rev 1

Rev 1 claimed the failed resume was "the only resume in the entire event
history taken with lane `done` and actor `client`". The audit's DB replay
showed that is false: there were 29 client turn-starts from terminal lanes by
the plan's authoring time, most of which succeeded because the child's
original cwd still existed or no separate worktree had ever been provisioned.
The correct narrow claim: among the four threads with repeated
provision→fan-in→repoint cycles (`b98d6097`, `b623447d`, `9ac69034`,
`0ab903d0`), every earlier successful re-provision was protected by a prior
lane flip to `ready` (an orchestrator re-dispatch); the failed attempt is the
one taken **with the lane still `done` and the worktree already reaped** — a
human opening a finished thread to ask a question. That is the unprotected
path.

### 1.4 What already works — and must not regress

`consult_thread` works (verified live against `0ab903d0`). It survives because
`pi --fork` writes a *new* session header with a *new* cwd. It remains the
right tool for a one-shot factual question, including from an agent. It is
one-shot and amnesiac by design, which is why it does not satisfy the
interrogation use case on its own. This plan does not touch it.

## 2. Constraints and verified facts

Every item below was verified against installed pi
(`@earendil-works/pi-coding-agent`), this repo, or by live experiment during
review. Items marked **(rev 2)** correct rev 1 errors.

1. **(rev 2) pi CAN relocate a session; the RPC path just doesn't expose it.**
   `SessionManager.open(path, sessionDir, cwdOverride)` is a supported API
   (`core/session-manager.js:1180-1208`). With an override, pi does not even
   read the header cwd — no existence check on the dead path, no rewrite of
   the file; the override is per-launch and runtime-only. Interactive mode
   already uses exactly this as its *official* missing-cwd fallback: it
   prompts "cwd from session file does not exist → continue in current cwd?"
   and reopens the same session with the override
   (`modes/interactive/interactive-mode.js:3975-4000`). The RPC
   `switch_session` command drops the option (`modes/rpc/rpc-mode.js:459-464`),
   and RPC startup hits the hard-exit branch instead of the prompt
   (`main.js:455-466` — there is no one to prompt). Rev 1's "immutable cwd"
   was a property of Loom's launch path, not of pi.

2. **(rev 2) Resuming from the wrong cwd is not an error — it is silent
   amnesia.** Empirically verified: pi derives the session *directory* from
   the slug of the launch cwd, so `pi --mode rpc --session-id X` launched from
   any other directory does not find the session and **silently creates a new
   empty session with the same id**, printing only a stderr warning. An
   amnesiac agent wearing the child's identity is strictly worse than the
   crash. Any resume design must therefore locate the session file explicitly
   rather than relying on cwd-slug derivation.

3. **(rev 2) The symlink workaround fails.** Empirically verified: symlinking
   the reaped path to the canonical tree does not work — pi resolves symlinks
   before computing both the session-dir slug and the cwd filter, so the
   session is again not found (silent amnesia, as in 2).

4. **The child's work survives fan-in as commits.** Verified: the child's tip
   (`118a77d26`) and the merge (`13b2bdba1`) are reachable from the parent
   branch. Only the checkout is destroyed. A worktree is reconstructible; a
   transcript is not.

5. **(rev 2) Diff attribution does NOT survive concurrent shared-worktree
   writers.** Rev 1's claim was false. Baselines exclude sibling edits only
   *between settled turns* (`checkpointing/Utils.ts:12-16`); each checkpoint
   ref snapshots the whole mutable worktree, so overlapping writers are
   cross-attributed and same-file overwrites lose origin unrecoverably
   (`CheckpointReactor.ts:238-286`). There is no snapshot barrier in
   production: checkpoint capture runs on an independent queue
   (`CheckpointReactor.ts:883-907`) and the receipt bus that could order it is
   a no-op (`RuntimeReceiptBus.ts:1-25`). The repo's own migration states that
   isolation is what makes per-thread diff metrics honest
   (`Migrations/1017_ProjectionThreadDiffMetrics.ts:4-11`). Consequence: any
   post-completion **write** path must be single-writer — isolation, not
   co-tenancy.

6. **Re-engagement plumbing exists, with corrected contract wording.** A
   lane-set reopening a terminal child stamps a fresh `spawnGeneration`
   (`decider.loom.ts:538-568`); a later terminal submit records a fresh
   outcome event, and `terminalEpisodeKey` prefers that outcome id
   (`WorkstreamDispatcher.ts:879-889`), so the parent-wake delta rail reports
   the re-run as news. The delivery contract is **one reportable item per
   episode in steady state, at-least-once across the wake→marker crash
   window** (`WorkstreamDispatcher.ts:2176-2183`), often batched into an FYI
   digest rather than a dedicated immediate wake — not "exactly once".

7. **(rev 2) Reopening a terminal lane resets `fanInState` to `none`
   unconditionally** (`projector.loom.ts:321-354`,
   `ProjectionPipeline.ts:1077-1083`). Rev 1's claim that Edit could reopen
   without re-arming fan-in was false. Rev 2 stops fighting this: isolated
   Edit *wants* the re-arm (§5.2).

8. **(rev 2) Projection session-status rows are not a liveness oracle.**
   Observed live during this review: after the review sub-threads' pi
   processes exited, every `provider_session_runtime` row still read
   `running` with a stale `activeTurnId`, and `projection_thread_sessions`
   read `ready` — for processes that no longer existed (zero `pi --mode rpc`
   processes on the machine). Reconciliation runs at startup, not on process
   death. Consequence: runtime-truth occupancy (§6.2) must consult the
   server's **in-memory process registry**, not projections, or it trades a
   destructive race for a permanent worktree leak.

9. **`--session <path>` exists.** pi accepts an explicit session file path at
   startup (`main.js` resolves `--session`/`--resume` before cwd-bound
   services), and Loom already resolves a thread's session file across all
   slug directories (`piSessionFiles.ts:resolveSessionFilePath`). So the
   patched resume path can name the file explicitly, eliminating the
   slug-derivation fragility in (2).

## 3. Design principle

> **One thread, one conversation, forever. A worktree is a lease the
> conversation holds, not a property it has.**

The two halves of a thread have opposite economics:

| | Conversation (pi jsonl) | Workspace (git worktree) |
|---|---|---|
| Size | KBs–MBs | GBs (3.4 GB here, ×152 worktrees) |
| Reconstructible? | **No** — irreplaceable | Yes, from a commit |
| Needed to interrogate? | Yes | No (read access to *some* valid tree suffices) |
| Needed to edit? | Yes | Yes — exclusively (fact 5) |

The ownership split that resolves the collision:

- **pi owns the conversation** — one session file per thread, append-only,
  never forked, never rewritten. The header cwd stays as a faithful historical
  record of where the work originally happened.
- **Loom owns the workspace** — worktrees are leases; Loom already tracks each
  thread's current canonical directory (thread meta, repointed at fan-in).
- **`cwdOverride` is the interface between them** — every resume launch says
  "same conversation, work from *here* now".

Strategic property this buys: the worktree lifecycle can be wrong in arbitrary
ways and the worst case is a stale tree view — never a dead or amnesiac
thread. The conversation stops being hostage to the workspace, which is
exactly the property that protects the differentiator when the next lifecycle
bug slips through.

### 3.1 Why not fork (rev 1's companion session, rejected)

`--fork` copies the transcript into a second session file with a new id. It is
divergence machinery — pi built it so `consult_thread` can spin up a throwaway
oracle that diverges and dies. Re-engagement has no divergence point: the
human is simply still talking. Using fork would fracture thread identity —
every session-resolving path (`consult_thread`, stall context,
`resolveSessionFilePath`, which returns the newest mtime match) would face two
files claiming the same thread, a "current session pointer" would have to be
invented, and each later re-engagement would compound the problem. All of that
is bookkeeping to simulate what `cwdOverride` gives directly: one linear
conversation that continues.

## 4. Core mechanism

### 4.1 The pi patch

Expose the existing override on the headless path. Shape:

- New CLI option `--cwd <dir>` (RPC/headless), valid **only together with an
  explicit `--session <path>` resume** — not with `--session-id`, which can
  create a new session (`main.js:264-271`) and would make the cwd and
  session-directory semantics ambiguous (rev-2 review). The resolved session
  opens via `SessionManager.open(file, sessionDir, cwdOverride)` and the
  missing-session-cwd check is satisfied by the override (it already is —
  `getMissingSessionCwdIssue` reads the manager's cwd, which *is* the
  override). Settings, extensions, and trust context all resolve against
  `sessionManager.getCwd()` after selection (`main.js:479-529`), so they
  follow the override correctly. `--cwd` without `--session`, or with a
  missing target directory, is a usage error. No behaviour change when the
  flag is absent; the `--fork` path `consult_thread` depends on is untouched.
- Optionally the same option on RPC `switch_session` (parity with the
  interactive fallback), not needed for this plan.

This is exposing an existing, tested behaviour on the programmatic surface,
not inventing relocation. It is genuinely upstreamable: "headless resume after
the working directory moved" is needed by any daemon embedding pi, and
interactive mode's prompt proves the semantics are already accepted. Until
upstreamed it is a normal feature commit if pi is effectively our fork, or a
`patchedDependencies`-style patch otherwise (Loom already maintains nine).

**Contract test** (in Loom's suite, against the installed binary): craft a
session whose header cwd does not exist; resume with `--cwd <existing dir>`;
assert the turn runs, the answer reflects prior context, and the session file
gains entries rather than a sibling file appearing. This pins the patched
behaviour and detects upstream drift.

### 4.2 The Loom resume path

On every resume of an existing thread, launch pi with:

- `--session <absolute session file path>` — resolved via
  `resolveSessionFilePath` (fact 9), never via cwd-slug derivation (fact 2);
- `--cwd <canonical cwd>` — the thread's current workspace:
  `resolveThreadWorkspaceCwd` (worktree if provisioned, else the project
  `workspaceRoot`), with an existence check that falls back to
  `workspaceRoot` if the recorded path dangles. By construction something
  valid always exists.

This makes resume deterministic regardless of workspace history: the same
conversation continues wherever the thread's workspace now is. For a
fanned-in child that is the parent's worktree — which contains the child's
merged work.

## 5. Two modes of engagement

The current code has one door — the rework door — which is why it detonates.
Split by what the thread may write. The mode is a property of the **launch**,
not of the conversation: tool surfaces are fixed at process start (`--tools`),
so crossing modes requires a process restart, which makes the boundary
server-enforced rather than prompt-enforced (review G4). Which mode a launch
gets is **derived from durable thread state** — see §5.3 — never from
in-memory UI state, so a server restart cannot strand an episode.

### 5.1 Discuss — the default for a terminal thread

Resume the child's real session, read-only. Launch = §4.2 plus
`--tools read,grep,find,ls` (the same restriction mechanism `consult_thread`
already uses) and **no workstream extension**, so the engagement structurally
cannot mutate orchestration, submit, or spawn.

No lane change, no `spawnGeneration` bump, no fan-in interaction, no worktree
provisioning, no setup script, no kickoff-brief delivery, no parent
notification. The thread stays `done`; the conversation accumulates in its one
session file. Pure Q&A costs the orchestrator nothing — it remains auditable
(the transcript is durable and visible in the UI) without being intrusive.

**Fidelity caveat, stated honestly:** the canonical cwd for a fanned-in child
is the parent's worktree, which has moved on since the child finished. "The
file I edited at line 40" may have shifted. For rationale/intent questions —
the motivating use case — this is nearly always sufficient. The engagement's
opening context should state both identities: "your work was merged as
`<finalCommitSha>`; the tree you see now is the parent's current state." Exact
historical file reads are available from git objects at `finalCommitSha`
without any checkout (`git show <sha>:<path>` from the parent worktree); a
server-side read affordance for that is Phase 3 polish, not a blocker.

**Terminal-case policy (review G5):**

| Thread state | Discuss | Edit |
|---|---|---|
| `done`, fanned in | yes (canonical = parent worktree) | yes (§5.2) |
| `done`, worktree still alive | yes (canonical = own worktree) | yes |
| `cancelled` | yes, labelled (session replayable; branch kept by `doCancelled`) | no — recovery is a new explicit work episode |
| archived | requires explicit unarchive first (archived threads accrue no turns) | same |
| deleted | no | no |
| resolved gate member | yes | allowed, but invalidates the verdict (§6.3) |
| parent gone/cancelled | yes — canonical falls back to project `workspaceRoot` | needs a live parent branch to fan into; otherwise refuse |

### 5.2 Edit — explicit escalation, isolated

For the rare but real case: mid-discussion the child realises it missed the
intent, or finds a bug, and should fix it.

Rev 1 proposed writing into the parent's worktree. Both reviews killed that
(fact 5): without a single-writer boundary, a re-engaged child and a mid-turn
orchestrator in the same tree produce cross-attributed diffs and silently
lost edits. Rather than invent a worktree writer-lease, Edit reuses the
machinery that already exists and is already correct:

**Edit = an isolated rework episode.**

1. Human clicks Edit (or "promote this conversation to Edit") — an explicit,
   visible action. Asking a question must never accidentally become this.
2. Lane `done → ready` — the existing re-engagement path: fresh
   `spawnGeneration` stamped (`decider.loom.ts:538-568`), `fanInState` reset
   to `none` (fact 7 — which Edit *wants*, because its output must fan in).
3. A fresh isolated worktree + `ws/…` branch is cut from the parent's current
   branch — the normal provisioning path, deliberate this time rather than
   accidental.
4. The same session resumes there: `--cwd <new worktree>` (§4.2), full tool
   surface, workstream extension restored. The conversation continues — the
   child remembers the discussion that led here.
5. The child makes the fix and `workstream_submit`s. Normal fan-in merges the
   branch; the existing delta rail wakes the parent with the updated report
   (fact 6).

What this buys over rev 1's parent-tree write:

- **Attribution is exact** — matches the codebase's own invariant.
- **No concurrent-writer hazard** — the orchestrator can be mid-turn in the
  parent tree throughout.
- **Abandonment is safe and visible** — if the human wanders off
  mid-conversation, the work sits on a kept `ws/…` branch and the thread sits
  non-terminal in the graph; the existing idle-liveness backstop nags. Rev 1's
  "uncommunicated edits" marker — which review showed was racy anyway — is
  unnecessary: an edit that never fanned in is *visibly incomplete* rather
  than silently divergent.
- **The provisioning cost lands only on the rare path** (your framing: rare
  but must exist), never on "why is this a dict?".

The kickoff-brief re-delivery bug must still be fixed for this path: step 4 is
a resume of a thread that has provably run, so `recoveredNeverStartedChild`
must be false. The correct "has provably run" guard is **session-file
existence** (a conversation exists to resume), not `finalCommitSha` alone — a
cancelled-before-launch child can carry a branch-tip sha yet have no
replayable session (rev-2 review). `finalCommitSha` remains the historical
source-identity marker.

Edit launches get the same relocation preamble as Discuss (§5.1): the resumed
transcript remembers absolute paths in the deleted original checkout, so the
opening context must state the new worktree path and that old absolute paths
are historical, *before* full tools are granted.

### 5.3 Mode is durable state, not session state

The launch mode is a pure function of durable thread state, evaluated at every
launch (including the startup-reconciliation resume path,
`loom/startup.ts:213-258`):

- **terminal lane** (`done`/`cancelled`) → Discuss launch (read-only tools, no
  workstream extension);
- **non-terminal lane with an open Edit episode** — reopen provenance
  `{mode: edit}` recorded on the shell at the Edit lane-reopen (§6.2) and
  cleared when the episode ends (submit routes to terminal, or explicit
  cancel) → Edit launch (full tools, workstream extension);
- any other non-terminal thread → the normal working launch (unchanged
  behaviour).

This resolves the rev-2 contradiction ("reset to Discuss on restart" vs "a
non-terminal Edit must retain submit"): an interrupted Edit episode resumes as
Edit after a restart because its lane is non-terminal and its provenance says
`edit`; a terminal thread always comes back read-only. No new state machine —
the provenance field §6.2 already adds carries the mode.

## 6. Orchestrator honesty

Principle (upheld by both reviews): **the orchestrator learns about
consequences, not conversations.**

### 6.1 Discuss

No notification. This is the point of interrogation-without-pollution.

### 6.2 Edit + submit

The existing rail carries it (fact 6): fresh `spawnGeneration` at reopen,
fresh outcome event at submit, fresh `terminalEpisodeKey`, one reportable
delta item — at-least-once across crashes, possibly digest-batched. No new
plumbing for delivery.

One addition is required for the copy to be truthful (review: the lane event
payload carries no actor, and `WakeMember` carries neither actor nor mode):
project **reopen provenance** — `{actor: human|agent, mode: edit}` — onto the
lane-set event payload and thread shell, so the wake can say "this child was
re-engaged by the human; its fix has been merged by fan-in" instead of
implying a branch the orchestrator must hunt for. Small contract + projector +
wake-builder change.

### 6.3 Edit on a resolved gate member

An edit invalidates more than the edited thread's own verdict: the verdict
**released dependants**, and some may already be executing against the old
premise (design review G2, re-raised by the rev-2 verification). At
Edit-reopen of a thread that was a gate's rework target:

1. Mark the prior outcome/report stale on the shell (a `staleOutcome` flag the
   UI renders on the old report).
2. Compute the dependants that were gated on this thread (`blockedBy` edges in
   the shell snapshot) and have since started or finished; record them with
   the episode.
3. The eventual consequence wake names them: "this child's approved output was
   edited after release; dependants X, Y started against the previous
   version."

Whether to *re-run* the gate or re-dispatch dependants is the orchestrator's
call — the wake gives it the complete facts. (Blocking re-review automatically
is over-machinery for the stated rarity; revisit if usage proves otherwise.)

### 6.4 Abandoned Edit

Handled structurally by §5.2: non-terminal thread + kept branch + idle
backstop. No marker needed.

## 7. Occupancy — an atomic workspace lease, one authority, both removers

Fixing the race means occupancy must answer "is any process actually using
this directory?" — and fact 8 shows projection rows cannot answer that. The
rev-2 verification added the harder requirement: a *snapshot* predicate is
still check-then-act — a process can start between the check and the `git
worktree remove --force`, which is exactly the three-second window of §1.1.
Occupancy and removal must therefore share **one atomic lease**, not one
predicate evaluated at two times.

1. **`WorkspaceLease` service** (in-memory, server-owned; per resolved
   workspace path):
   - `hold(path, holder)` — acquired by the resume/turn-start path **before**
     the pi process is spawned (closing the registration gap: PiDriver
     registers a child only after spawn, `PiDriver.ts:2101-2131`) and by
     provisioning for the tree it is creating. Released when the process
     exits or the launch fails. Multiple concurrent holds are fine — it is a
     reader/occupant lease, not a mutex.
   - `withExclusive(path, effect)` — the *only* path allowed to run a
     worktree removal. Fails (skips, retried by the next reactor/reaper pass)
     if any hold is outstanding, and blocks new holds for its duration, so
     check+remove is atomic with respect to starts.
   Plan lane appears nowhere — terminal-lane must never imply safe-to-delete.
2. **Registry accuracy:** live-process truth is adapter-owned (each driver
   keeps its in-memory session map, e.g. `PiDriver.ts:900`, `:2439`);
   ProviderService aggregates (`ProviderService.ts:887-901`). The lease
   service is the *authority*; adapters report into it at spawn/exit rather
   than the lease scraping adapters, which is what makes the pre-spawn hold
   possible.
3. **Consumers:** the fan-in reactor's `finaliseRemoval`/`doCancelled`
   removal steps (`WorkstreamFanInReactor.ts:303-319`) and the reaper's
   `reapOne` (`WorktreeReaper.ts:163-204`) both execute inside
   `withExclusive`. The reaper's classifier stays pure — it still takes an
   `occupiedPaths` snapshot for *classification/display*
   (`worktreeClassification.ts:118-130`), but classification is advisory; the
   lease at removal time is what protects. One authority, two removers, so
   the two lifecycles cannot drift apart again (the design review's core
   structural demand).
4. **Reconciliation on death, not just startup:** PiDriver already deletes
   its live-map entry and emits `session.exited` on process death
   (`PiDriver.ts:1844-1877`); ProviderService republishes runtime events
   (`ProviderService.ts:286-300`) but nothing persists the stop. Death-time
   handling must release the lease **and** mark the runtime/session rows
   stopped in the same breath (the ten stale-`running` rows observed live
   during this review, against zero actual pi processes, are this bug).

## 8. Changes, in dependency order

### Phase 1 — resume works, nothing is destroyed (fixes the reported error)

1. **pi patch:** `--cwd` on the RPC/headless path (§4.1) + contract test.
2. **Loom resume launch:** explicit `--session <file>` + `--cwd <canonical>`
   (§4.2).
3. **`finalCommitSha` on the thread shell**, recorded at fan-in (from
   `commitAll`'s sha, falling back to explicit HEAD resolution when the tree
   was clean — `GitVcsDriver.ts:193-197` returns null then) and at
   `doCancelled` (branch tip). This is the durable "has provably run" marker.
4. **Turn-start guard:** a thread whose session file exists has provably run:
   it is never re-provisioned by the chokepoint and never gets
   `recoveredNeverStartedChild` (no brief re-delivery); `finalCommitSha` is
   the historical source-identity marker, not the guard (§5.2). Terminal-lane
   resume without an explicit Edit defaults to the Discuss launch (read-only
   tools, no workstream extension).
5. **Workspace lease + both removers inside it + death-time reconciliation**
   (§7).

Phase 1 is shippable alone and is the minimum safe vertical slice (review G1):
resume cannot crash, cannot go amnesiac, cannot write, cannot destroy a live
worktree (the lease makes that claim true atomically, not merely on a
snapshot), and cannot re-deliver a brief.

### Phase 2 — Edit episode

6. Edit affordance in the UI (explicit action + promote-from-Discuss), wired
   to: lane reopen → isolated provisioning → same-session resume with full
   tools (§5.2).
7. Reopen provenance on the lane event + shell + wake copy (§6.2) — this
   field also carries the durable Edit-episode mode (§5.3) — and the
   stale-verdict flag + started-dependant capture for gate members (§6.3).

### Phase 3 — polish

8. Historical exact-file reads at `finalCommitSha` surfaced to Discuss (git
   objects; no checkout).
9. UI copy for the fidelity caveat (§5.1) and the terminal-case matrix (G5).

### Explicitly out of scope

- `consult_thread` — unchanged; still the right tool for one-shot questions.
- Re-materialising a child's exact historical worktree (git-object reads
  cover the need without the checkout cost).
- Any shared-worktree writer-lease machinery — mooted by isolated Edit.
- The unrouted-yield wedge and the cancel-cascade footgun observed during
  this plan's own review (a sub-agent using a gate verdict token outside a
  gate wedges as `in_progress`; `cancelled` on a working thread destroys
  in-flight work with no warning). Real defects, recorded here for
  ticketing, but they are workstream-control-plane UX, not engagement
  lifecycle.

## 9. Test obligations

Named for capabilities, since the original regression survived every
mechanism-level test:

1. *A human can converse with a fanned-in child* — resume a `done`,
   fanned-in child; assert a successful turn **with prior context present**
   (the answer must reference session history), no worktree created, no setup
   script, no brief re-delivery.
2. *Resume never spawns a same-id sibling session* — after any resume, exactly
   one session file matches the thread id (guards the silent-amnesia mode,
   fact 2).
3. *Conversing does not notify the orchestrator* — no parent wake from a
   Discuss engagement.
4. *Discuss cannot write* — tool surface excludes write/edit/bash and the
   workstream extension is absent (assert on launched argv, the same way
   `workstreamAsk`'s read-only invariants are unit-tested).
5. *A worktree is never removed under a live process* — drive the §1.1
   sequence against the lease; assert survival. Repeat with the **reaper** as
   the remover (guards Defect A′). Include the TOCTOU variant: a hold
   acquired *between* a removal decision and its execution must defeat the
   removal (guards §7's atomicity, not just its predicate).
6. *Occupancy outlives projection staleness* — kill a provider process
   without a clean shutdown; assert the lease releases and the runtime rows
   reconcile (fact 8).
7. *Edit round-trip* — Edit a fanned-in child: isolated worktree cut, same
   session resumed there, submit → fan-in → **one reportable parent delta
   episode in steady state** (duplicates permitted only across the documented
   wake→marker crash window, `WorkstreamDispatcher.ts:2176-2183`) carrying
   reopen provenance; prior report flagged stale and started dependants named
   if gated.
8. *Abandoned Edit is visible, not silent* — Edit, make a commit, never
   submit: branch kept, thread non-terminal, idle backstop fires.
9. *Engagement modes survive a server restart* — restart mid-Discuss: thread
   resumes read-only. Restart mid-Edit (non-terminal, provenance `edit`):
   thread resumes with full tools and can still submit (guards §5.3).
10. *Terminal-case matrix holds* — Discuss on a `cancelled` child works and is
    labelled; Edit on it is refused; an archived thread requires unarchive
    first (guards §5.1's policy table).
11. *pi contract test* — §4.1's pinned-behaviour test against the installed
    binary.

## 10. Open questions

1. **Upstreaming the pi patch** — submit `--cwd` upstream immediately, or run
   on the local patch until the design proves itself? (Recommend: open the
   upstream PR at Phase 1 completion; the patch is small and the interactive
   precedent makes the case.)
2. **Gate re-review on edited gated coders (§6.3)** — is the stale-verdict
   flag + orchestrator discretion enough, or should an Edit on a gated
   coder's output force a review round? (Recommend: flag only, revisit with
   usage.)
3. **Discuss context header** — inject the dual-identity preamble
   ("merged as `<sha>`; tree is parent-current") as a system-prompt suffix on
   every Discuss launch, or only when the canonical cwd differs from the
   session's original? (Recommend: only on difference; zero noise on the
   still-alive-worktree path.)
