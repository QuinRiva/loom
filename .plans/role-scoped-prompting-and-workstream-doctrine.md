---
manager_sessions:
  - id: 24389ccb-e89f-4d23-a172-8a19fe8f5c12
    role: intent
    authored_at: 2026-06-27T12:36:47.797Z
---

# Intent Brief — Role-scoped prompting + accurate workstream doctrine

**Status:** intent (first pass, approved for planning)
**Audience:** the architect/planner and implementers of the role-overlay change
**Date:** 2026-06-27

## Business objective
Two coupled pains, both pulling the user back into manual work:

- **A — Autonomy/trust:** orchestrator threads violate the designed division of
  labour (they implement instead of delegate, misread child liveness, treat
  status as a control lever, ignore the goal/task tree), forcing the user to
  babysit execution instead of *reviewing finished work*.
- **B — Legibility / low re-orientation cost:** when the user checks in on a
  thread they can't cheaply recall **why it was launched** or **where it's up
  to**, or tell **actively-worked** from **merely-outstanding**.

**Coupling insight (the lever):** the orchestrator *produces* the very signals
(a meaningful `purpose`, a current task tree, honest status/reports) that make
re-orientation cheap. Sloppy agent bookkeeping is simultaneously an autonomy bug
and a legibility bug.

## Required system capability
1. **Role-scoped prompting (the founding intent, finally realised):** each
   thread carries role-appropriate doctrine — coder/reviewer carry coding/review
   principles, the orchestrator carries orchestration doctrine and is *not*
   polluted with coding principles.
2. **Accurate shared mechanics**, role-agnostic: status is a cosmetic label
   **except** the spawn-time `blockedBy` gate; `error` is **server-authoritative**
   (set by the liveness sweep, not the agent); a `read_thread` is a **point-in-time
   snapshot, not a liveness probe**.
3. **Orchestrator doctrine:** delegate substantial implementation/investigation;
   don't do it inline; drive off and keep current the goal's task tree; trust the
   sweep (`error`/terminal are the real signals) rather than re-polling; collapse
   the job to plan → spawn → review.
4. **Worker doctrine:** execute the brief directly; only sub-delegate if it
   genuinely decomposes.
5. **Control-plane attribution:** automated orchestration notices (child
   completion, went-quiet nudges, child-wake) must be distinguishable from
   messages from the user, so a thread acts on them as control-plane signals
   rather than replying to the user or treating them as the user's directive.
6. **Brief-over-goal precedence for children:** a spawned child inherits the
   parent's goal as *background context only*; its authoritative task is its
   spawn brief. The inherited goal Objective must never override the brief.

## Local objective (what changes in the repo)
- **New role-overlay mechanism:** role-keyed system-prompt overlays, stored as
  **in-repo files**, injected via the existing `appendSystemPrompt` seam by the
  child's `role`; the **root/un-roled thread defaults to `orchestrator`**.
- **Rewrite `PI_WORKSTREAM_SYSTEM_PROMPT`** → mechanics-only (move role doctrine
  into overlays; correct the status/liveness/snapshot semantics).
- **Trim Part-1 tool guidelines** in `WorkstreamSpawnExtension.ts`: strip the
  redundant `"<toolname>:"` prefix from every `promptSnippet`, dedupe against each
  tool's `description`, and drop bullets now owned by the overlays/mechanics.
- **Seed overlays** for `orchestrator`, `coder`, `reviewer`, `researcher`;
  unknown roles get **no overlay** (permissive spawning).
- **Control-plane message framing (`WorkstreamDispatcher.ts`):** wrap the
  dispatcher-built wake/notice texts (`buildParentWakeMessage` ~L455, the
  went-quiet nudge ~L313/322, `buildChildWakeMessage` ~L607 — all currently
  delivered as `role:"user"`) in an explicit control-plane marker (e.g.
  `[T3 Workstream control plane — automated notice, not from the user]`). Keep
  `role:"user"` (pi's turn model has no separate channel); the in-band marker is
  the load-bearing fix, with a one-line prompt rule (in the mechanics prompt)
  explaining it.
- **Child goal-context reframing (`ProviderCommandReactor.ts` `buildGoalSystemPrompt`):**
  branch on `parentThreadId` — for a child, inject the goal as *"overall
  objective provided to your parent for background context"*, explicitly
  subordinate to the spawn brief, rather than as the child's own `Objective:`.
  Do **not** stop inheriting the goal (sub-threads are meant to be
  goal-constrained); only reframe + subordinate it.

## Key constraints
- **Inject-once, not per-turn** (per-turn goal prepending was explicitly rejected
  as a "terrible" idea).
- **Permissive spawning:** a free-string/unknown role must still spawn (just no
  overlay).
- **Prototype-simple, file-centric, minimal surface;** stays **fork-local** (base
  T3 has no workstream concept).
- **Non-prescriptive briefs** preserved (workers exercise judgement).

## Important non-goals
- **No new liveness/heartbeat product work** — the existing sweep is sufficient;
  issue #4 (parent can't tell if a child is running) is now a *prompt* fix (teach
  the agent the sweep exists and that a single read is a snapshot, not a probe).
  *In scope, by exception:* the minimal control-plane **message-framing** change
  in `WorkstreamDispatcher.ts` and the **goal-context reframing** in
  `buildGoalSystemPrompt` (above) — neither touches the sweep, adds liveness
  detection, or changes UI; reviewers must NOT reject them as non-goal
  violations.
- **No global-`AGENTS.md` migration here** — the user migrates generic coding
  principles out of `~/.pi/agent/AGENTS.md` into the coder/reviewer overlays
  later, as pi-frontend is adopted for fathom work.
- **No new UI / no role-specific *model* changes** beyond the existing role→preset
  behaviour.
- **Don't touch the liveness sweep itself.**

## Relevant existing code/docs
- `apps/server/src/provider/Drivers/PiDriver.ts` — `PI_WORKSTREAM_SYSTEM_PROMPT`,
  the `appendSystemPrompt` seam (gated on `mcpSession`).
- `apps/server/src/provider/Drivers/Pi/WorkstreamSpawnExtension.ts` — Part-1 tool
  descriptions/snippets/guidelines (the per-tool injected text).
- `apps/server/src/orchestration/workstreamChildPrompt.ts` — child first-turn
  message (carries the `role` label + brief today).
- `apps/server/src/orchestration/Layers/WorkstreamDispatcher.ts` — sole start
  authority; calls `workstreamChildPrompt`.
- `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts` —
  `activeGoalContextInstruction` (goal/task injection, once-per-session; uses the
  same `appendSystemPrompt` seam).
- `apps/server/src/orchestration/Layers/WorkstreamLivenessSweep.ts` —
  `dead/stalled/loop` → `error` (server-authoritative status).
- Founding signed docs (author session `86c158b7-7422-42ee-abb0-c9065deaa1ec`):
  `.plans/workflow-subagent-sessions-research.md`,
  `.plans/sub-agent-workstreams-implementation.md`,
  `.plans/phase-c-status-and-dependencies.md`,
  `.plans/phase-d-core-dispatcher-design.md`; goals model
  `goals/pi-frontend/plans/db-goals-and-tasks-migration.md`.

## Resolved terminology
- **Orchestrator** = root/un-roled workstream thread (delegates, reviews).
  **Worker/sub-thread** = spawned child with a role.
- **Role overlay** = role-keyed system-prompt append carrying role doctrine.
- **Status** = cosmetic workflow label (agent-set) *except* `error`
  (server-authoritative) and the `blockedBy` gate.
- **Liveness sweep** = server safety net that flips genuine dead/stalled/loop
  children to `error`.

## Open questions (for the planning phase, not blockers)
1. Exact overlay location/format (e.g. `.t3/roles/<role>.md` vs a repo `roles/`
   dir) and how the loader resolves them.
2. Mechanism for the root thread to receive the `orchestrator` overlay
   (default-role when `parentThreadId === null` / role unset).
3. Whether the `reviewer` overlay duplicates coder principles or references a
   shared fragment.
4. Overlay vs `workstreamChildPrompt`: keep role *doctrine* in the overlay
   (system prompt) and leave `workstreamChildPrompt` as the brief-carrying
   first-turn message.
5. Operating rule (not code): **the goal must be accurate before spawning
   children**, since children inherit it. A stale goal Objective actively
   derailed sub-threads in the authoring session — keep the goal current as a
   prerequisite to delegation.

## Revision note (2026-06-27, post-approval)
Added requirements 5–6 (control-plane attribution; brief-over-goal precedence)
and their two in-scope code touch-points, after the authoring session directly
observed spawned children executing the inherited (stale) goal Objective instead
of their spawn briefs. Scope widens from "prompts + overlays" to also include two
small, contained server changes (dispatcher message framing; child goal-context
reframing). All original non-goals otherwise stand.

## Architecture recommendation
**Role-keyed system-prompt overlays loaded from in-repo files, injected through
the existing `appendSystemPrompt` seam**, with `orchestrator` as the default when
no role is assigned. This reuses the seam already used for
`PI_WORKSTREAM_SYSTEM_PROMPT` and `activeGoalContextInstruction` (so it inherits
inject-once semantics), keeps overlays editable without a rebuild, and contains
the change to prompt-construction + a small loader.

**Rejected alternatives:**
- One role-agnostic prompt with self-limiting language — leaves the
  leaf-coder-told-to-delegate bug and never realises role-specific prompting.
- Orchestrator-vs-worker split via `workstreamChildPrompt` only — half-measure
  that can't carry coder/reviewer principles.
- Storing overlays in T3 config or pi agent-defs — less editable and not
  version-controlled per-project.

**Evidence that would change the recommendation:** if role overlays need to vary
per-spawn dynamically (not static per role), a file-per-role model is too rigid
and we'd move to a parameterised template.

## Suggested next step
Hand this brief to an architect/planner to produce the implementation plan
(loader + injection point in `PiDriver`/dispatcher, overlay file layout, the
rewritten `PI_WORKSTREAM_SYSTEM_PROMPT`, the trimmed Part-1, and the four seed
overlays), then a coder, then a reviewer.
