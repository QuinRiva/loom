---
manager_sessions:
  - role: analysis
    authored_at: 2026-06-30
---

# Upstream sync — conflict surface & per-zone resolution

_Phase 1 / Task D. Analysis only; no source changed. Australian English._

Built on baseline `477795697` (per `01-history-baseline.md`), the fork-delta
inventory (`02-fork-deltas.md`) and the upstream drift digest
(`03-upstream-drift.md`). All `up:` / `fork:` figures below are
`git diff --numstat 477795697 <upstream/main|HEAD> -- <file>`, verified live in
this worktree.

## Headline — what actually collides

The 106-file "both-touched" overlap from Task A is **not** uniformly hard. Once
you put real numbers on each file, the surface separates into four mechanically
distinct kinds of conflict, and **two of the three files Task B told us to "open
first" turn out to be the easy ones**:

1. **Delete/modify (the genuinely hard core).** Upstream did not _edit_ several
   files the fork edited — it **deleted them** in two structural rewrites. These
   cannot be 3-way-merged; the fork delta must be **re-expressed onto the new
   layout**:
   - `apps/web/src/store.ts` — **GONE** upstream (−2050), decomposed into many
     per-feature atom modules. Fork added +441 here.
   - `packages/client-runtime/src/{wsTransport,wsRpcProtocol,threadDetailState,index}.ts`
     — **all GONE** (connection-architecture rewrite #2978), replaced by
     `connection/`, `rpc/`, `state/`, `relay/` subtrees. Fork edited every one.
   - `apps/web/src/rpc/serverState.ts` — **GONE** (−305). Fork added +14.

2. **Heavy both-sides rewrite (deep-semantic 3-way).** Both sides moved a file a
   lot; the fork delta has to be re-applied onto a largely-rewritten upstream
   base. Worst offender by far: **`ChatView.tsx` (up:+1956/−1442)**.

3. **Fork-dominant, upstream barely moved (TAKE OURS + tiny graft).** The
   `orchestration.ts` "spine" is here: **upstream changed it by ONE line**, the
   fork by +701. Same for `ProjectionSnapshotQuery.ts` (up:+2/−2, fork:+702).
   These are near-trivial, not high-risk.

4. **Upstream-dominant, fork barely moved (TAKE THEIRS + re-add hook).** e.g.
   `CommandPalette.tsx` (up:+454/−310, fork:+3/−3).

**Correction to Task B's "open first" list:** `orchestration.ts` and
`ProjectionSnapshotQuery.ts` are _low effort_ (take ours, re-graft one upstream
line). The real first-movers are **`store.ts`** (re-engineer onto decomposed
atoms) and the **client-runtime restructure** — plus **`ChatView.tsx`** as the
single largest textual battlefield.

---

## Zone-by-zone map

Severity legend: **Trivial-textual** (line-level, intent never clashes) ·
**Structural** (file moved/renamed/split; mechanical re-expression) ·
**Deep-semantic** (both sides reshaped behaviour; needs judgement).
Resolution: **OURS** · **THEIRS** · **THEIRS+ADD** (take upstream, re-attach the
small Pi hook) · **RE-ENGINEER** (re-express fork capability onto upstream's new
shape).

### Z1 — `orchestration.ts` contract spine — **OURS + 1 line** · Trivial

- `up:+1/−0`, `fork:+701/−2`. The lone upstream change is
  `startFromOrigin: Schema.optional(Schema.Boolean)` on
  `ThreadTurnStartBootstrapPrepareWorktree`.
- **Resolution:** take ours wholesale, cherry-pick that single field.
- Downgraded from Task B's "HIGH, the spine". The union _structure_ upstream
  builds on did **not** move in-window, so the fork's goal/task/workstream/
  attention additions sit on a stable base. Effort: minutes.

### Z2 — `ProjectionSnapshotQuery.ts` (read model) — **OURS** · Trivial

- `up:+2/−2`, `fork:+702/−72`. Upstream effectively untouched.
- **Resolution:** take ours; reconcile the 2 upstream lines by inspection.
  Another Task-B "HIGH" that is in fact trivial.

### Z3 — `apps/web/src/store.ts` — **RE-ENGINEER** · Structural, **HIGH effort**

- **Upstream DELETED store.ts** (−2050) and decomposed web state into per-feature
  atom modules (`diffPanelStore.ts`, `components/ui/sidebarState.ts`,
  `previewSessionState` moves, `rpc/serverState.ts` + `rpc/wsConnectionState.ts`
  deleted, `commandPaletteStore.ts`/`modelPickerOpenState.ts` deleted, plus many
  `*State.ts` removed/added). Fork added +441 of goal/workstream/multi-session
  state here.
- **Resolution:** there is no file to merge into. Identify each fork addition's
  concern and re-home it into the matching upstream atom module (or a new
  Pi-owned `*Store.ts`/`*State.ts` following the new convention).
- **One of the two hardest zones.** Everything in the web shell imports from the
  old `store.ts`, so this gates Z11–Z13.

### Z4 — client-runtime connection rewrite — **RE-ENGINEER** · Structural, **HIGH effort**

- `wsTransport.ts` (fork +62/−8), `wsRpcProtocol.ts` (fork +5/−39),
  `threadDetailState.ts` (fork +37/−1), `index.ts` (fork +1) — **all deleted
  upstream** by #2978; replaced with `connection/{registry,supervisor,resolver,…}`,
  `rpc/client.ts`, `state/`, `relay/managedRelay*`.
- **Resolution:** re-express the fork's transport/protocol/threadDetail edits
  against the new subtrees. The fork's ws protocol extensions (workstream/goal
  RPCs, account-usage push) must be re-registered wherever upstream now defines
  the client RPC surface.
- **The other hardest zone**, and it gates all web work that talks to the server.

### Z5 — `settings.ts` contract — **3-way merge** · Deep-semantic, medium

- `up:+33/−6`, `fork:+57/−3`. Genuinely balanced. Upstream: `diffWordWrap`→
  `wordWrap` (default→true), `autoOpenPlanSidebar` default true→false, new
  `enableProviderUpdateChecks` / `newWorktreesStartFromOrigin`,
  **`ServerSettingsError` restructured** (typed fields + mandatory `cause`),
  env-scoped settings (#3216). Fork: `PiSettings`, `workstreamModelPresets`,
  `reasoningDisplay`.
- **Resolution:** base on upstream's reshaped schema, re-apply the fork's
  additive keys. Watch the `autoOpenPlanSidebar`/"plan sidebar" naming overlap
  with the fork's goal/task right-panel (§Z14 naming risk). Siblings:
  `rpc.ts` (up:+57 / fork:+14), `server.ts` (up:+106-churn / fork:+38) — merge.

### Z6 — PiDriver SPI re-fit — **OURS, re-fit onto drifted SPI** · Deep-semantic, **HIGH effort**

- The PiDriver files are fork-only on their paths (no textual conflict), **but
  the `ProviderDriver`/`ServerProvider` SPI they implement moved across 289
  commits** — the baseline's own headline commit was a provider-state refactor,
  and the Effect error sweep (§Z8) reshaped adapter error types.
- **Resolution:** keep PiDriver, re-fit its method signatures / error
  construction / runtime-event shapes to the _current_ SPI. Preserve the
  load-bearing deterministic per-thread `--session-id` create-or-resume fix.
- The single most important _behavioural_ re-fit. Depends on Z1/Z5/contracts and
  on the current provider interfaces being settled.

### Z7 — `builtInDrivers.ts` (registry) — **THEIRS-equivalent + add Pi** · Trivial

- **Upstream did NOT touch this file** in-window (fork-only: +3/−18, the
  gutting). So "theirs" == baseline == the full 5-driver registry. The other
  drivers (Claude/Codex/Cursor/Grok/OpenCode) all still exist on disk.
- **Resolution:** discard the fork's gutting; restore the full registry union/
  array and simply **add `PiDriver`**. This is the deliberate cheap-hack revert
  (Task B §B) — do **not** preserve the Pi-only registry, and do not over-invest
  re-enabling the others beyond re-registering them. Effort: minutes once Z6
  compiles.

### Z8 — Effect error-model + service-convention sweep — **THEIRS, re-apply behaviour** · Structural, pervasive

- ~203/289 upstream commits. `TaggedError` classes with `cause` chains;
  namespace-import + service-shape conventions now police fork code too.
- **Touchpoints in overlap:** `ClaudeAdapter.ts`, `CodexSessionRuntime.ts`,
  `opencodeRuntime.ts`, `AcpSessionRuntime.ts`, `terminal/Layers/Manager.ts`,
  `McpSessionRegistry.ts`, `AgentAwarenessRelay.ts`, all `*TextGeneration.ts`,
  `config.ts` (up:+83/−76), plus every fork-authored Effect module must conform.
- **Resolution:** take upstream's error shapes; re-apply only the fork's
  _behavioural_ edits on top; bring fork-new code (PiDriver, dispatcher, liveness
  sweep, goal/task layers) into convention so the new lint checks pass. No design
  to adjudicate — but it's broad and touches nearly every server file the fork
  also edited, so expect textual conflicts throughout. Cross-cutting: handle
  per-file as each server zone is resolved, not as a separate pass.

### Z9 — `ws.ts` / `server.ts` (server transport) — **3-way merge** · Deep-semantic, high

- `ws.ts` up:+349/−151, fork:+176/−60; `server.ts` up:+106-churn, fork:+38.
  Both sides heavily edited the WS server wiring (upstream: connection/relay
  evolution + Effect sweep; fork: workstream/goal RPC handlers, account-usage
  push).
- **Resolution:** base on upstream, re-apply fork's RPC handler registrations.
  Pairs with Z4 (client side of the same protocol) — keep wire contracts in sync.

### Z10 — `serverRuntimeStartup.ts` (runtime wiring) — **THEIRS + re-add layers** · Structural, medium

- `up:+57/−49` (restructured), `fork:+9/−3` (layer wiring).
- **Resolution:** take upstream's restructured startup; re-insert the fork's
  layer additions — WorkstreamDispatcher, WorkstreamLivenessSweep,
  ProjectionGoals, ProjectionThreadHeartbeats, ReasoningStreamBus,
  SubscriptionUsagePoller. Low risk but load-bearing: if a layer isn't re-wired,
  the corresponding Pi feature silently dies. Depends on those layers compiling
  (Z6, Z1).

### Z11 — `ChatView.tsx` — **RE-ENGINEER fork delta onto theirs** · Deep-semantic, **HIGHEST textual effort**

- **`up:+1956/−1442`** — upstream essentially rewrote it (file browser, preview
  panel, inline right panel, plan surface, scroll/minimap, env-scoped settings).
  `fork:+233/−36` (multi-session shell, goal header, workstream wiring).
- **Resolution:** take upstream's rewritten ChatView as the base; re-apply the
  fork's multi-session/goal/workstream touchpoints by hand. A line-for-line
  3-way will be almost all conflict — drive it as a deliberate re-apply, not an
  auto-merge. Largest single web file to reconcile; gated by Z3 (store atoms).

### Z12 — `Sidebar.tsx` (+ `.logic.ts`) — **3-way merge, fork-heavy** · Deep-semantic, high

- `up:+575/−353`, `fork:+522/−146`. Both heavy. Upstream: sidebar toggle,
  worktree indicator, double-click rename, archived threads. Fork: multi-session
  thread tree, workstream status, goal surfacing, account-usage pill.
- **Resolution:** genuine 3-way; preserve fork's multi-session/workstream tree,
  adopt upstream's sidebar interaction features where they don't fight it.

### Z13 — `MessagesTimeline.*` + reasoning display — **REDO-CLEAN** · Deep-semantic, high

- `MessagesTimeline.tsx` up:+509/−146, fork:+256/−4; `ChatMarkdown.tsx`
  up:+373/−166, fork:+14/−2. Upstream advanced timeline + markdown substantially.
- **Resolution:** adopt upstream's timeline/markdown; re-attach only the
  Pi-specific reasoning ingestion + the `reasoningDisplay` tri-state setting,
  rather than porting the fork's timeline edits verbatim. Confirm whether
  upstream now renders reasoning blocks natively before re-adding ours
  (`ProviderRuntimeIngestion.ts` is fork-only +311, so the ingestion side stays
  ours regardless). Strong REDO-CLEAN per Task B §H.

### Z14 — Composer / chat UX cluster — **THEIRS+ADD (mostly REDO-CLEAN)** · mixed, medium

- `CommandPalette.tsx` (up:+454/−310, fork:+3/−3 → THEIRS+ADD, trivial),
  `composerDraftStore.ts` (up:+170/−8, fork:+23 → THEIRS+ADD),
  `uiStateStore.ts` (up:+136/−363, fork:+22 → THEIRS+ADD),
  `rightPanelStore.ts` (up:+149/−20, fork:+15 → THEIRS+ADD),
  `RightPanelTabs.tsx` (up:+308/−80, fork:+30 → THEIRS+ADD),
  `composer-editor-mentions.ts` (up:+14/−88, fork:+43/−3 → 3-way),
  `ChatComposer.tsx` (up:+56/−41, fork:+74/−12 → 3-way, fork-leaning).
- **Resolution:** default to upstream; re-attach only Pi-tied behaviour
  (`@thread` mentions feeding the workstream ask, queued-message steering,
  context/cost meter). Generic composer tweaks yield to upstream.
  **Naming-collision watch:** upstream's "plan surface" / "task sidebar" /
  `autoOpenPlanSidebar` occupy the same right-panel/atom/settings namespace as
  the fork's goal/task panel though they are a different concept (agent TODO /
  code-review tasks). Resolve store-atom and settings-key name clashes
  explicitly during Z3/Z5 rather than letting two "task" surfaces silently fight.

### Z15 — `ThreadStatusIndicators.tsx` — **OURS-leaning 3-way** · medium

- `up:+60/−27`, `fork:+168/−69`. Fork-dominant (two-axis plan-lane/attention
  model). Take ours, fold in upstream's small additions. Confirm whether
  `LegacyThreadStatus` scaffolding is still needed on the clean baseline rather
  than porting it reflexively (Task B §F).

### Z16 — Subscription/account-usage visibility — **OURS** · Low (defer-able)

- Poller/registry are fork-only-new; collisions only at the wiring files already
  covered (`Sidebar.tsx` Z12, `serverRuntimeStartup.ts` Z10, client RPC Z4).
- **Resolution:** keep ours; can land _after_ the core sync since it's
  self-contained. Lowest priority.

### Z17 — `useHandleNewThread.ts` + thread-interpretation prompt — **THEIRS+ADD** · medium

- `useHandleNewThread.ts` up:+76/−34, fork:+9/−3; `TextGeneration.ts`
  up:+62/−66 (Effect sweep), fork:+33/−1 (the title+emergent-goal interpretation
  prompt); `TextGenerationPrompts.ts`/`Utils.ts` similar.
- **Resolution:** take upstream's restructured textGeneration + new-thread hook;
  re-add `buildThreadInterpretationPrompt` and its single call site mapping the
  goal objective onto `goal.create`. Author already kept upstream's titling path
  intact, so this re-bases cleanly (Task B §J).

### Z18 — Goal/Workstream engine (server) + role overlays — **OURS** · Low

- WorkstreamDispatcher, LivenessSweep, ask/report, `goalTaskTree.ts`,
  decider/projector goal+lane branches, `commandInvariants.ts`, all migrations
  (033–044), `ProjectionGoals`, `roleOverlay.ts` + `roles/*.md`, shared
  `workstreamGraph.ts`/`workstreamDependencies.ts`, and all Workstream/Goal web
  components — **fork-only files on paths upstream never touched**
  (`apps/server/src/orchestration` moved only +81/−77 in-window, all Effect
  tweaks). `orchestration.ts` itself is Z1.
- **Resolution:** carries through essentially untouched. Only obligations:
  conform new Effect code to §Z8 conventions, re-wire layers in Z10, and rebase
  onto the resolved contract (Z1). No feature here has an upstream competitor
  (Task C §4 confirms: zero upstream delegation/goal/workstream work).

### Z19 — Lockfiles / package.json / vendored `.repos/` — **THEIRS, regenerate** · mechanical

- `pnpm-lock.yaml`, root + `apps/server` + `packages/shared` `package.json`.
- **Resolution:** take upstream's manifests, re-add only the fork's genuine new
  deps (Pi CLI plumbing), then **regenerate the lockfile** rather than merging
  it. Re-sync `.repos/` from upstream tooling; the fork's `.repos/` trim is
  irrelevant to features.

### Z20 — Plans/docs/goals artefacts — **DROP from merge** · none

- `.plans/**`, `docs/{design,plans,research}/**`, `goals/**` (now
  non-authoritative), `progress.md`, `.pi/manager/**`, `AGENTS.md` edits,
  `scripts/bootstrap-worktree.sh`. Fork-only paths, no conflict; not features.
  Carry through or drop freely; keep this `docs/upstream-sync/` set.

---

## Sequencing constraints

A dependency-ordered resolution path (each step should typecheck before the
next leans on it):

1. **Merge substrate** — graft `6c82133`→`477795697` (doc 01) so a real 3-way
   merge attributes correctly. Prerequisite for everything.
2. **Contracts first** — Z1 (`orchestration.ts`), Z5 (`settings.ts`/`rpc`/
   `server`). _Nothing on server or web typechecks until the contract surface is
   settled._ Z1 is trivial; do it first to unblock Z18/Z6.
3. **client-runtime restructure (Z4)** — must precede all web work, because the
   web shell imports the client-runtime transport/protocol that upstream moved.
4. **store.ts decomposition (Z3)** — must precede Z11/Z12/Z14, which import the
   old `store.ts`. Do this immediately after Z4.
5. **Server core** — Z10 (runtime wiring) after Z6 (PiDriver SPI re-fit) and Z18
   layers compile; Z7 (registry) after Z6; Z9 (`ws.ts`/`server.ts`) in lock-step
   with Z4 to keep the wire contract consistent. Z8 (Effect sweep) applied
   per-file _as_ each server zone is touched, not as a separate pass.
6. **Web shell** — Z11 (`ChatView`), Z12 (`Sidebar`), Z13 (timeline/reasoning),
   Z14 (composer cluster), Z15 (status indicators), Z17 (new-thread hook) — all
   after Z3 + Z4.
7. **Defer-able** — Z16 (account usage), Z19 lockfile regen at the end, Z20 drop.

Hard ordering edges: **Z1 → Z18/Z6**; **Z5 → server+web**; **Z4 → web shell &
Z9**; **Z3 → Z11/Z12/Z14**; **Z6 → Z7/Z10**.

---

## Biggest risks

1. **`store.ts` no longer exists upstream (Z3).** The fork's +441 lines of web
   state must be re-homed into upstream's decomposed atom modules. There is no
   merge tool for a delete/modify of this size — it is hand re-engineering, and
   it gates the entire web shell. Mis-homing state risks subtle multi-session
   bugs. **This, not `orchestration.ts`, is the real spine of the web merge.**
2. **client-runtime rewrite (#2978) is a wholesale layout change (Z4).** Every
   flat module the fork edited (`wsTransport`, `wsRpcProtocol`, `threadDetail`,
   `index`, `rpc/serverState`) was deleted. The fork's workstream/goal RPC
   extensions and account-usage push must be re-registered on the new
   `connection/`+`rpc/` surface, kept in sync with the server side (Z9). Wire
   contract drift here breaks reconnect/replay — the project's stated priority.
3. **`ChatView.tsx` upstream rewrite (Z11), up:+1956/−1442.** The single largest
   textual battlefield; auto-merge is hopeless. Must be a deliberate re-apply of
   the fork's multi-session/goal touchpoints onto upstream's rebuilt component.
4. **PiDriver SPI re-fit (Z6).** Files don't conflict, but the provider SPI moved
   under them across 289 commits + the Effect error sweep. The deterministic
   `--session-id` create-or-resume reliability fix must survive the re-fit.
5. **The Effect error-model sweep is pervasive, not localised (Z8).** ~70% of
   upstream commits. Low semantic risk but it will produce textual conflicts in
   nearly every shared server file the fork also edited, and the new convention
   lint checks will fail fork-new code until it conforms — easy to under-budget.
6. **"Plan/task" naming collision (Z14/Z5).** Upstream's plan-surface / task
   sidebar / `autoOpenPlanSidebar` share namespace with the fork's goal/task
   panel despite being a different concept. Unresolved, two "task" surfaces and
   their store atoms/settings keys will silently clash. Decide the namespace
   explicitly during Z3/Z5.

**Reassurances (de-risked by the numbers):** `orchestration.ts` (+1 upstream
line), `ProjectionSnapshotQuery.ts` (+2), and the entire goal/workstream server
engine sit on a baseline upstream barely moved — they are take-ours with trivial
reconciliation. And Task C confirms **no upstream feature competes** with the
fork's Pi-first capabilities, so the merge is "adopt-theirs for plumbing,
keep-ours for product" with no feature to surrender.
