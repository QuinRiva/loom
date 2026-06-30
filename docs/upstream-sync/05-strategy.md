---
manager_sessions:
  - id: 1f3f1a78-18ca-4491-86e0-a14e875fb73e
    role: plan
    authored_at: 2026-06-30T04:14:53.047Z
---

# Upstream sync — strategy & execution plan

_Phase 1 / Task E. Decision-support synthesis. No source changed. Australian English._

> **Reading guide.** This document is self-contained — you do **not** need to have
> read the four sub-reports (01 history-baseline, 02 fork-deltas, 03 upstream-drift,
> 04 conflict-surface). It leads with the recommendation, then gives the sequenced
> plan, the risks, and the future pull cadence. Each section cites the underlying
> report if you want to drill in.

---

## TL;DR — the recommendation

1. **Mechanism: graft a synthetic merge-base, then drive a guided 3-way merge — _not_ a from-scratch re-baseline.**
   Run `git replace --graft <fork-root> <baseline>` to give git the common ancestor
   it is missing. This is reversible, costs seconds, and instantly turns a nonsense
   "1772-file diff" into the **real 106-file conflict surface**. Optionally bake it
   into permanent history with `git filter-repo` only at the very end, if a clean
   linear lineage is wanted.

2. **Shape of the work: "adopt-theirs for plumbing, keep-ours for product."**
   Upstream built **no** competing delegation / goals / tasks / workstream / multi-session
   feature in this window, so **nothing the fork built has to be surrendered**. The merge
   is: take upstream's Effect error model, service conventions, client-connection
   rewrite, and web-shell evolution as the new baseline; re-express the fork's small,
   well-isolated Pi delta on top.

3. **The hard part is only two structural rewrites, not the 106 files.**
   Upstream **deleted** `apps/web/src/store.ts` (decomposed into per-feature atom modules)
   and **deleted** the flat `client-runtime` transport modules (replaced by
   `connection/`/`rpc/`/`state/`/`relay/` subtrees). These two can't be 3-way-merged —
   the fork delta must be hand-re-homed onto the new layout — and they gate the whole
   web shell. `ChatView.tsx` (upstream rewrote ~1950 lines) is the largest _textual_
   battle. Everything else is either take-ours-trivially or take-theirs-and-re-attach-a-hook.

4. **The deliberately-disabled other harnesses (Claude/Codex/Cursor/Grok/OpenCode) are a clean revert, deferred.**
   They were only un-registered, never deleted. Resolution is "restore upstream's full
   registry + add `PiDriver`". **Pi-first features take priority and must not be delayed
   or complicated to accommodate cross-harness support** — re-enable the others as a
   late, low-cost step.

5. **Verification bar: `vp check` and `vp run typecheck` green after each phase**, plus a
   real Pi session smoke test (spawn a workstream child, create a goal/task, resume
   across a server restart) before declaring done. The contract surface gates everything,
   so resolve it first and typecheck before leaning on it.

**Rough effort shape:** the surface is far smaller than "289 commits / 1772 files" implies.
The genuine engineering is concentrated in ~5 zones (store decomposition, client-runtime
restructure, ChatView, PiDriver SPI re-fit, the pervasive-but-mechanical Effect sweep).
Everything else is minutes-to-hours of re-attachment or carries through untouched.

---

## 1. Mechanical approach — graft + guided 3-way (the hybrid)

### The problem in one paragraph
The fork shares **no git history** with upstream: it was bootstrapped as a fresh root
commit from a _copy_ of an upstream working tree, not via `clone`/`fork`. So
`git merge-base` is empty and a naïve `git diff HEAD upstream/main` contrasts two whole
trees ~2 weeks of independent drift apart → a meaningless 1772-file delta. (Report 01.)

### Why the baseline is known with very high confidence
The fork tree is **byte-identical (5205/5240 files, same blob SHAs)** to upstream commit
**`477795697`** (2026-06-14, _"resolve host process state through Effect"_). The only
fork-side difference at the root is precisely the Phase 0-3 Pi work plus a vendored-repo
trim — a clean fork-foundation fingerprint. From there it is **289 upstream commits** to
the current nightly `2448212` (v0.0.28, 2026-06-29). (Report 01 §2.)

### The three options, and why hybrid wins

| Option | What it is | Verdict |
|---|---|---|
| **(a) Synthetic graft + 3-way** | `git replace --graft` splices the fork root onto baseline `477795697`; git then computes a correct merge-base and a real 3-way merge. | **Recommended substrate.** Proven live: after the graft, `merge-base HEAD upstream/main → 477795697`; removing the replace ref restores the prior state. Zero commits rewritten, trivially reversible, need never be pushed. |
| **(b) Re-baseline from scratch** | Check out `upstream/main`; replay the fork's feature delta as fresh patches on top. | **Not as a substitute.** Loses fork commit history/attribution, and the per-file re-application work is _identical_ to (a)'s merge but without git's 3-way assistance. |
| **(c) Hybrid** | Use (a) as the analysis+merge substrate; optionally land the _result_ as a clean re-baselined branch via `filter-repo` at the end. | **Recommended end-to-end path.** Get git's help discovering true conflicts; decide at ship time whether to keep grafted merge history or rewrite to a clean lineage. |

**Decision: hybrid (c).** Graft now (reversible, free, correct), drive the merge off the
real merge-base, and defer the "permanent rewrite vs keep graft" decision to the end —
because the rewrite (`git filter-repo --replace-refs`) changes SHAs and needs a
coordinated force-push across the ~10 shared worktrees, which is a cost worth paying only
once, knowingly.

```sh
B=477795697d8546a8db4903bd878a5ad3196423b9
git replace --graft <fork-root-6c82133> $B   # synthetic merge-base; reversible with `git replace -d`
git merge-base HEAD upstream/main             # → 477795697  ✓
```

> **Caveat to remember:** even after the graft, a plain two-tree `git diff HEAD upstream/main`
> still prints 1772 files (it ignores the merge-base by design). Use the 3-way merge, or
> `git diff $B...upstream/main` / `git diff $B HEAD`, to see true attribution.

### The conflict surface, sized

| set | files | meaning |
|---|---|---|
| Changed by fork (`$B..HEAD`) | 319 | mostly fork-only new files → carry through |
| Changed by upstream (`$B..upstream/main`) | 1535 | mostly upstream-only → fast-forward |
| **Changed by BOTH** | **106** | the only true conflict candidates |

And of those 106, only a handful are genuinely hard (see §2). The rest split into
take-ours-trivially or take-theirs-and-re-attach-a-hook. (Reports 01 §"Conflict surface", 04.)

---

## 2. Sequenced execution plan

Resolution is **dependency-ordered**: the contract surface gates server _and_ web, the
client-runtime restructure gates the web shell, and the store decomposition gates the
chat components. Each phase **must `vp check` + `vp run typecheck` green before the next
leans on it.** (Report 04 "Sequencing constraints".)

### Phase 0 — Substrate (minutes)
- Graft the synthetic merge-base (§1). Confirm `merge-base → 477795697`.
- Branch for the merge; keep the graft local.
- **Exit:** real 3-way merge attributes correctly; baseline reproducible.

### Phase 1 — Contracts first (low effort, unblocks everything)
Nothing on server or web typechecks until the contract surface is settled.
- **Z1 `orchestration.ts` (the "spine") — TAKE OURS + 1 line.** Upstream changed this by
  **one line** (`startFromOrigin` flag); the fork added +701 (all goal/task/workstream/
  attention members). Take ours wholesale, cherry-pick the single upstream field.
  _Downgraded from "highest risk" to minutes._
- **Z5 `settings.ts` + `rpc.ts`/`server.ts` — 3-way merge.** Genuinely balanced. Base on
  upstream's reshaped schema (`diffWordWrap`→`wordWrap`, `autoOpenPlanSidebar` default
  flip, restructured `ServerSettingsError`, env-scoped settings); re-apply the fork's
  additive keys (`PiSettings`, `workstreamModelPresets`, `reasoningDisplay`).
  **Resolve the "plan/task" naming collision here** (see Risk 6).
- **Exit:** contracts package typechecks.

### Phase 2 — The two structural rewrites (highest effort; gate the web shell)
- **Z4 client-runtime connection rewrite — RE-ENGINEER.** Upstream's #2978 **deleted**
  `wsTransport.ts`, `wsRpcProtocol.ts`, `threadDetailState.ts`, `index.ts`,
  `rpc/serverState.ts` and replaced them with `connection/`/`rpc/`/`state/`/`relay/`
  subtrees. Re-express the fork's transport/protocol/threadDetail edits and re-register
  the workstream/goal RPCs + account-usage push on the new surface. Keep in lock-step
  with the server side (Z9) so the wire contract stays consistent.
- **Z3 `apps/web/src/store.ts` decomposition — RE-ENGINEER.** Upstream **deleted**
  `store.ts` (−2050) and split web state into per-feature atom modules. Re-home each of
  the fork's +441 lines of goal/workstream/multi-session state into the matching upstream
  atom module (or a new Pi-owned `*Store.ts` following the new convention).
- **Exit:** client-runtime + web state layer typecheck; the web shell has modules to import.

### Phase 3 — Server core (re-fit Pi onto drifted plumbing)
- **Z6 PiDriver SPI re-fit — OURS, re-fit onto drifted SPI (high effort).** The PiDriver
  files don't textually conflict, but the `ProviderDriver`/`ServerProvider` SPI moved
  across 289 commits (the baseline's own headline was a provider-state refactor) and the
  Effect sweep reshaped adapter error types. Re-fit method signatures / error
  construction / runtime-event shapes to the _current_ SPI. **Preserve the load-bearing
  deterministic per-thread `--session-id` create-or-resume fix** (survives server restarts).
- **Z7 `builtInDrivers.ts` registry — restore THEIRS + add Pi (minutes).** Discard the
  fork's gutting; restore the full 5-driver registry and add `PiDriver`. The other drivers
  still exist on disk. _Do not over-invest re-enabling them; Pi-first comes first._
- **Z9 `ws.ts`/`server.ts` — 3-way.** Base on upstream; re-apply the fork's RPC handler
  registrations. Lock-step with Z4.
- **Z10 `serverRuntimeStartup.ts` — THEIRS + re-add layers.** Take upstream's restructured
  startup; re-insert the fork's layer wiring (WorkstreamDispatcher, LivenessSweep,
  ProjectionGoals, ProjectionThreadHeartbeats, ReasoningStreamBus, SubscriptionUsagePoller).
  **Load-bearing:** a missed layer silently kills its Pi feature.
- **Z18 goal/workstream engine + role overlays — OURS (carries through).** The dispatcher,
  liveness sweep, ask/report, goal/task tree, decider/projector branches, all migrations
  (033–044), `roleOverlay.ts` + `roles/*.md`, shared graph libs — all fork-only files on
  paths upstream never touched (orchestration server moved only +81/−77). Only obligations:
  conform new code to Effect conventions (Z8) and rebase onto the resolved Z1 contract.
- **Z8 Effect error/service sweep — THEIRS, re-apply behaviour (pervasive, mechanical).**
  ~70% of upstream commits. Applied **per-file as each server zone is touched**, not as a
  separate pass: take upstream's `TaggedError`/`cause`-chain shapes, re-apply only the
  fork's _behavioural_ edits, and bring fork-new code into convention so the new lint
  checks pass.
- **Exit:** server typechecks; a Pi session can start.

### Phase 4 — Web shell (re-apply Pi UX onto upstream's rebuilt components)
All gated by Z3 + Z4.
- **Z11 `ChatView.tsx` — RE-ENGINEER (highest textual effort).** Upstream rewrote it
  (+1956/−1442: file browser, preview/inline right panel, plan surface, scroll/minimap,
  env-scoped settings). Take upstream's rewritten component as base; **deliberately
  re-apply** the fork's multi-session/goal-header/workstream touchpoints by hand — a
  line-for-line auto-merge is hopeless.
- **Z12 `Sidebar.tsx` (+`.logic.ts`) — 3-way, fork-heavy.** Preserve the fork's
  multi-session/workstream tree + goal surfacing + account-usage pill; adopt upstream's
  sidebar toggle / worktree indicator / double-click rename / archived threads where they
  don't fight it.
- **Z13 `MessagesTimeline.*` + reasoning — REDO-CLEAN.** Adopt upstream's advanced
  timeline/markdown; re-attach only the Pi-specific reasoning ingestion
  (`ProviderRuntimeIngestion.ts`, fork-only) + the `reasoningDisplay` tri-state setting.
  Confirm whether upstream now renders reasoning natively before re-adding ours.
- **Z14 composer/chat UX cluster — THEIRS + ADD (mostly REDO-CLEAN).** Default to upstream
  (`CommandPalette`, `composerDraftStore`, `uiStateStore`, `rightPanelStore`,
  `RightPanelTabs`); re-attach only Pi-tied behaviour (`@thread` mentions feeding the
  workstream ask, queued-message steering, context/cost meter). Generic tweaks yield to
  upstream.
- **Z15 `ThreadStatusIndicators.tsx` — OURS-leaning 3-way.** Keep the two-axis
  plan-lane/attention model; fold in upstream's small additions. Confirm whether
  `LegacyThreadStatus` scaffolding is still needed rather than porting it reflexively.
- **Z17 `useHandleNewThread.ts` + interpretation prompt — THEIRS + ADD.** Take upstream's
  restructured textGeneration + new-thread hook; re-add `buildThreadInterpretationPrompt`
  and its single call site (maps the goal objective onto `goal.create`). Re-bases cleanly.
- **Exit:** web shell typechecks and renders; multi-session + workstream + goals visible.

### Phase 5 — Defer-able tail
- **Z16 subscription/account-usage — OURS, self-contained.** Lowest priority; can land
  after the core sync (collisions only at already-resolved wiring files).
- **Z19 lockfiles / `package.json` / `.repos/` — THEIRS, regenerate.** Take upstream's
  manifests, re-add only the fork's genuine new deps, then **regenerate** `pnpm-lock.yaml`
  (don't merge it). Re-sync `.repos/` from upstream tooling.
- **Z20 plans/docs/goals artefacts — DROP from merge.** `.plans/**`, `docs/{design,plans,
  research}/**`, `goals/**` (now non-authoritative), `progress.md`, `.pi/manager/**`,
  `AGENTS.md` edits — fork-only, no conflict, not features. Carry through or drop freely;
  **keep this `docs/upstream-sync/` set.**
- **Z7 follow-up (later, optional):** verify the re-registered other harnesses actually
  run, as a separate low-priority pass — explicitly _after_ Pi-first is solid.

### Hard ordering edges
`Phase 0 substrate → everything` · `Z1 → Z18/Z6` · `Z5 → server+web` ·
`Z4 → web shell & Z9` · `Z3 → Z11/Z12/Z14` · `Z6 → Z7/Z10`.

### What to take wholesale / re-engineer / redo-clean — at a glance

| Disposition | Zones |
|---|---|
| **Take ours (trivial reconcile)** | Z1 orchestration contract, Z2 ProjectionSnapshotQuery, Z18 goal/workstream engine + roles |
| **Take ours, re-fit onto drift** | Z6 PiDriver SPI, Z15 status indicators |
| **Take theirs + re-attach Pi hook** | Z7 driver registry, Z10 runtime startup, Z14 composer cluster, Z17 new-thread prompt |
| **Re-engineer onto new layout** | Z3 store decomposition, Z4 client-runtime, Z11 ChatView |
| **Redo clean (adopt upstream, re-attach Pi bit)** | Z13 timeline/reasoning |
| **3-way merge** | Z5 settings, Z9 ws/server, Z12 Sidebar |
| **Take theirs / regenerate / drop** | Z8 Effect sweep (per-file), Z19 lockfiles/.repos, Z20 docs |

---

## 3. Risk areas & how to de-risk

| # | Risk | De-risking |
|---|---|---|
| 1 | **`store.ts` no longer exists (Z3)** — +441 fork lines of web state must be hand-re-homed into decomposed atoms; gates the whole web shell; mis-homing causes subtle multi-session bugs. | Do it immediately after Z4, before any chat component. Map each fork addition to its concern and the matching upstream atom; typecheck before touching Z11/Z12/Z14. Smoke-test multi-session switching specifically. |
| 2 | **client-runtime rewrite #2978 (Z4)** — every flat module the fork edited was deleted; wire-contract drift breaks reconnect/replay (the project's stated reliability priority). | Re-register the fork's RPCs on the new `connection/`+`rpc/` surface in lock-step with the server `ws.ts`/`server.ts` (Z9). Explicitly test reconnect, partial-stream replay, and server-restart resume. |
| 3 | **`ChatView.tsx` rewrite (Z11), +1956/−1442** — auto-merge is hopeless. | Treat as deliberate re-apply onto upstream's rebuilt component, not a 3-way. Do it after Z3 so the imports exist. |
| 4 | **PiDriver SPI re-fit (Z6)** — files don't conflict but the SPI moved under them; the `--session-id` create-or-resume reliability fix must survive. | Diff the current `ProviderDriver`/`ServerProvider` interfaces against baseline first; re-fit signatures/error/event shapes; add a smoke test that resumes a Pi thread across a server restart. |
| 5 | **Effect sweep is pervasive, not localised (Z8)** — ~70% of commits; new convention lint checks fail fork-new code; easy to under-budget. | Handle per-file as each zone is touched; budget extra time; run `vp check` (which includes the Effect/oxlint conventions) continuously, not just at the end. |
| 6 | **"Plan/task" naming collision (Z14/Z5)** — upstream's plan-surface / "task sidebar" / `autoOpenPlanSidebar` share namespace with the fork's goal/task panel despite being a different concept (agent TODO / code-review tasks). | Decide the namespace explicitly during Z3/Z5 — rename one side's store atoms/settings keys so two "task" surfaces don't silently fight. |

**General verification protocol (the "done" bar):**
- `vp check` **and** `vp run typecheck` green after _each phase_, not just at the end.
- If native mobile is ever touched (it shouldn't be — out of fork scope), `vp run lint:mobile` too.
- **Canonical-entrypoint smoke test before declaring done:** start a real Pi session,
  spawn a workstream child, create a goal + task, exercise reasoning display, and resume a
  thread across a server restart. A green typecheck alone does **not** prove the layer
  wiring (Z10) re-attached every Pi feature — a silently-unwired layer typechecks fine and
  does nothing.

**Reassurances (de-risked by the numbers):** `orchestration.ts` (+1 upstream line),
`ProjectionSnapshotQuery.ts` (+2), and the entire goal/workstream server engine sit on a
baseline upstream barely moved — take-ours with trivial reconciliation. And **no upstream
feature competes** with any Pi-first capability, so there is no feature to surrender and
no design to adjudicate — only plumbing to adopt and product to re-attach. (Reports 03 §4, 04.)

---

## 4. Future cadence — making daily/weekly pulls cheap

The whole point of this exercise is that the _next_ sync should be hours, not a project.
Three levers:

### 4.1 Keep a permanent, real merge-base
Once this merge lands, **decide the lineage question deliberately:**
- **Option A — bake the graft into real history** with `git filter-repo --replace-refs`
  (one-time SHA rewrite + coordinated force-push across the shared worktrees). Afterwards
  every future `git merge upstream/main` "just works" with a normal merge-base — no graft
  ref to maintain, no replace ref to remember. **Recommended** if the team can absorb one
  coordinated rewrite.
- **Option B — keep the `git replace` graft** as a documented local ref. Cheaper now (no
  rewrite), but every worktree/clone must recreate the replace ref, and it's easy to forget.
  Acceptable as an interim.

Either way, **after this merge the fork and upstream share an ancestor**, so subsequent
pulls are ordinary 3-way merges against a moving `upstream/main` — the no-merge-base
pathology never recurs.

### 4.2 Minimise and isolate the fork surface
The merge cost is proportional to the **overlap** (files both sides touch), not the size
of either delta. Keep overlap small:
- **Prefer fork-only new files over edits to upstream files.** The fork's engine
  (dispatcher, liveness sweep, goal/task layers, role overlays, web workstream components)
  merged essentially for free precisely because it lives on paths upstream never touches.
  Keep new Pi capability in new modules.
- **Shrink the unavoidable touchpoints to "registration seams".** Where Pi must hook into
  upstream code, make the hook a one-liner that calls into a Pi-owned module (e.g. a single
  layer-registration line in `serverRuntimeStartup.ts`, a single call site for the
  interpretation prompt, `PiDriver` added to the registry array). Small, stable seams
  re-apply trivially every pull.
- **Adopt upstream's conventions proactively** (Effect `TaggedError` + `cause` chains,
  namespace imports, service-module shape). Fork code already conforming means the
  convention sweeps never conflict.
- **Don't fork the volatile web shell more than necessary.** `ChatView.tsx`/`Sidebar.tsx`/
  the composer cluster are upstream's most-iterated files; every fork edit there is a
  recurring merge tax. Where possible, express Pi UI as separate panels/components mounted
  via a small seam rather than inline edits to upstream's hottest components.

### 4.3 Upstream-vs-isolate triage for every new fork change
For each future fork change, ask: _is this generally useful, or Pi-specific?_
- **Generally useful (bug fixes, perf, generic UX)** → **upstream it** (PR to
  `pingdotgg/t3code`). Once merged upstream, it arrives via the normal pull and stops being
  fork surface.
- **Pi-specific (delegation, goals/tasks, multi-session)** → **isolate it** in Pi-owned
  modules behind a minimal seam, per §4.2.

### 4.4 Cadence mechanics
- **Weekly (or daily) `git fetch upstream && git merge upstream/main`** on a sync branch;
  run `vp check` + `vp run typecheck`; resolve the (now small) overlap; PR into `main`.
- **Pin and watch the high-tax zones** (`ChatView`, `Sidebar`, `settings.ts`, client-runtime
  connection layer, the driver SPI). A short `docs/upstream-sync/` note per pull recording
  "what moved, what we re-applied" keeps institutional memory and makes the next pull faster.
- **Re-sync `.repos/` vendored subtrees** in the same change whenever a dependency moves, so
  reference material never drifts from installed versions.

The investment in §4.1–§4.2 converts the recurring sync from "re-discover the whole conflict
surface" into "merge a handful of stable seams" — which is exactly what makes a daily/weekly
cadence sustainable.

---

## Appendix — reproduce the key facts

```sh
B=477795697d8546a8db4903bd878a5ad3196423b9
git merge-base HEAD upstream/main                         # empty (no shared history)
git diff --name-status 6c82133 $B                         # 35-file fork-foundation fingerprint
git replace --graft 6c82133 $B && git merge-base HEAD upstream/main   # → 477795697
git rev-list --count $B..upstream/main                    # 289 upstream commits
comm -12 <(git diff --name-only $B HEAD|sort) \
         <(git diff --name-only $B upstream/main|sort) | wc -l        # 106 overlap files
git replace -d 6c82133                                    # undo the graft
```
