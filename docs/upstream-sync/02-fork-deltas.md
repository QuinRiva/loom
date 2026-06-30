---
manager_sessions:
  - id: 2e1828df-7fad-4035-9293-2fd2904765c1
    role: analysis
    authored_at: 2026-06-30T04:07:52.994Z
---

# Upstream sync — fork-delta inventory

_Phase 1 / Task B. Analysis only; no source changed._

Comparison point: baseline upstream commit **`477795697`** (per
`01-history-baseline.md`). All "vs baseline" figures below are
`git diff 477795697 HEAD` on `origin/main`.

## Headline

- The fork is now **319 files / +37 410 / −3 108** versus baseline — far beyond
  the 35-file "Phase 0-3 foundation" the history analysis fingerprinted at the
  root commit. ~40 feature commits have since landed.
- **The collision surface is small and well-isolated.** Of the heavy new
  subsystems (Workstream dispatcher, decider/projector growth, goal/task
  aggregate, Pi provider layers, all Workstream/Goal web components, the
  migrations, the `roles/` overlays), **almost none are in the 106-file
  both-touched overlap** — they are fork-only files on paths upstream never
  touched, so they carry through a 3-way merge essentially untouched.
- **The danger is concentrated in a handful of shared touchpoints** that both
  sides edited: the `orchestration.ts` contract, `ProjectionSnapshotQuery.ts`,
  `ProviderRuntimeIngestion.ts`, `settings.ts`, the web `store.ts` / `Sidebar` /
  `ChatView` / `MessagesTimeline` cluster, the ws transport/protocol files, and
  the shared `textGeneration/*`. These are where Task D must do real work.
- **One deliberate cheap hack to redo cleanly:** the other (non-Pi) harnesses
  were _disabled by deletion from the driver registry_ (`builtInDrivers.ts`).
  Per the user this was a quick test, **not** the long-term design and **not** a
  feature to preserve.

Legend for the verdict column:

- **PRESERVE** — load-bearing Pi-first functionality; must survive the merge.
- **REDO-CLEAN** — keep the capability but re-engineer onto upstream's newer
  baseline rather than porting our hacked version verbatim.
- **DROP/REVERT** — not a feature to carry; undo it on the new baseline.

Coupling = collision risk for Task D: **HIGH** if the file is in the 106-file
both-touched overlap or implements an upstream SPI that drifted; **LOW** if it's
a fork-only new file on a path upstream left alone.

---

## A. Pi harness integration (the provider driver) — **PRESERVE**

The reason the fork exists. A full `ProviderDriver` implementation for the Pi
CLI, talking to Pi over its JSON-RPC wire, plus one-shot completion and quota
plumbing.

**Files (~2 250 LOC, almost all fork-only-new):**

- `apps/server/src/provider/Drivers/PiDriver.ts` (1 125) + `PiDriver.test.ts`
- `apps/server/src/provider/Layers/Pi/{Cli.ts (68), RpcProcess.ts (392), OneShotCompletion.ts (201)}`
- `apps/server/src/provider/quotas/piQuotas.ts` (152)
- contracts: `PiSettings`, `PI_DEFAULT_MODEL`, `PI_THINKING_LEVEL_OPTIONS`
  (`settings.ts`, `model.ts`, `provider.ts`, `providerRuntime.ts`)
- registration in `builtInDrivers.ts` (see §B)

**Coupling: HIGH on the SPI, LOW on the file paths.** PiDriver imports a large
surface from `@t3tools/contracts` — `AnyProviderDriver`, `ProviderDriverKind`,
`ServerProvider`, `ProviderSession`, `ProviderTurnStartResult`,
`ProviderRuntimeEvent`, `ThreadTokenUsageSnapshot`, `ModelCapabilities`, etc.
The _files_ are fork-only (no merge conflict), but the **driver SPI shape is
upstream's and moved across 289 commits** (note the baseline's headline commit
was itself a provider-state refactor). Task D must diff the current
`ProviderDriver`/`ServerProvider` interfaces against baseline and re-fit
PiDriver to them — this is the single most important re-fit in the whole sync.
Includes a load-bearing reliability fix: deterministic per-thread Pi
`--session-id` for create-or-resume across server restarts (goal.md documents
the bug). That behaviour must survive.

`providerRuntime.ts` (+69) and `model.ts` (+14) additions feed this and are
likewise additive but ride on upstream-owned schema.

---

## B. Disabling the other harnesses — **DROP/REVERT (redo cleanly)**

`builtInDrivers.ts` was gutted: the Claude/Codex/Cursor/Grok/OpenCode driver
imports, the `BuiltInDriversEnv` union, and the `BUILT_IN_DRIVERS` array were
all replaced with **Pi only**.

```
BuiltInDriversEnv = PiDriverEnv;            // was a 5-driver union
BUILT_IN_DRIVERS = [PiDriver];              // was [Codex, Claude, Cursor, Grok, OpenCode]
```

**Crucially, the other drivers were NOT deleted** — `ClaudeDriver.ts`,
`CodexDriver.ts`, `CursorDriver.ts`, `GrokDriver.ts`, `OpenCodeDriver.ts` (and
their `Services/*Adapter.ts`, `*TextGeneration.ts`) all still exist on disk.
Only the _registry wiring_ was cut, so re-enabling is a near-trivial revert.

**Per the user (frontloaded steer):** this was a cheap test to get a Pi-only
build up, **not** the intended long-term solution and **not** a feature to
preserve. **Redo cleanly on the new baseline** — ideally the other harnesses
work again eventually, but **Pi-first features take priority and must not be
delayed or complicated to accommodate cross-harness support.** Practical
implication for the merge: take **upstream's** `builtInDrivers.ts` (which will
re-register all upstream drivers) and simply _add_ `PiDriver` to the union and
array, rather than porting our gutted version. `builtInDrivers.ts` is fork-only
in the overlap sense (upstream may also have touched it — verify), but the right
resolution is "theirs + add Pi", not "ours".

---

## C. Goal & Task orientation system — **PRESERVE**

Project → Goal → Task-tree, fully event-sourced and DB-authoritative (the
file-based `goals/<slug>/goal.md` approach was superseded — see goal.md's own
"NON-AUTHORITATIVE" banner; the markdown goals are now historical artefacts).

**Files:**

- contracts: goal/task commands + events + aggregates in `orchestration.ts`
  (`OrchestrationGoal`, `OrchestrationGoalTask`, `OrchestrationGoalShell`,
  `Goal{Create,MetaUpdate,Archive,Unarchive,Delete}Command`,
  `GoalTask{Create,Update,Delete}Command` + matching `*Payload` events,
  `OrchestrationAggregateKind` extended to include `"goal"`).
- server: `orchestration/goalTaskTree.ts` (93), `goalTaskCommands.ts` (98);
  decider/projector branches; `persistence/{Layers,Services}/ProjectionGoals.ts`;
  migration `035_GoalsAndTasks.ts` (+ `033_ProjectionThreadsGoalSlug.ts`).
- MCP/HTTP tool endpoints: `mcp/GoalTaskHttp.ts`, `mcp/GoalHandoffHttp.ts`;
  Pi extension `provider/Drivers/Pi/GoalTaskExtension.ts` (189).
- CLI: `cli/goal.ts`, `cli/orchestrationMutation.ts`.
- web: `components/GoalTasksPanel.tsx` (36), `goals/goalState.tsx` (57),
  goal surfacing in `ChatHeader`, `RightPanelTabs`, `Sidebar`.

**Coupling: mostly LOW, one HIGH node.** The aggregate/command/event additions
are _additive_ members of the `orchestration.ts` unions — but that file is in
the overlap set (§G), so the additions must be re-applied onto upstream's
current union definitions. `decider.ts`/`projector.ts`/`ProjectionGoals` are
fork-only-touched (LOW). `ProjectionSnapshotQuery.ts` (which assembles the read
model the UI consumes) **is** in the overlap and grew +774 — HIGH.

---

## D. Workstream = sub-thread delegation — **PRESERVE**

The headline Pi-native capability: an orchestrator thread spawns child threads
(coder/reviewer/researcher), gated by dependencies, with liveness sweeping,
ask/report hand-backs, and a fork–join graph view. This is the largest single
subsystem.

**Files (~5 000+ LOC, overwhelmingly fork-only-new):**

- server orchestration layers: `WorkstreamDispatcher.ts` (826) +`.test` (837),
  `WorkstreamLivenessSweep.ts` (672) +`.test` (319), plus `Services/*` for both;
  `workstreamAsk.ts` (182), `workstreamReport.ts` (54),
  `workstreamChildPrompt.ts` (24), `threadResolve.ts` (147),
  `threadIdle.ts` (30), `stallContext.ts` (120).
- contracts: `ThreadPlanLane`, `AttentionReason`/`ThreadAttention`,
  thread plan-lane/attention/dependencies/report commands + events,
  `QueuedMessages`, in `orchestration.ts`.
- MCP/HTTP: `mcp/WorkstreamSpawnHttp.ts` +`.test`; Pi extension
  `provider/Drivers/Pi/WorkstreamSpawnExtension.ts` (334).
- shared: `workstreamGraph.ts` (305), `workstreamDependencies.ts` (36) (+tests).
- web: `components/WorkstreamGraph.tsx` (413), `WorkstreamPanel.tsx` (745),
  `lib/workstreamGraph.ts` (235), `lib/forkJoinLayout.ts` (324),
  `lib/workstreamPresentation.ts` (318), `lib/threadMention.ts`,
  `threadRouteLineage.ts` (61).
- persistence: migrations `037_*WorkstreamFields`, `038_*StatusAndDependencies`,
  `039_*Brief`, `040_*NotifyFields`, `042_*PlanLaneAndAttention`,
  `043_*Heartbeats`; `ProjectionThreadHeartbeats` layer+service.
- config: `workstreamReportsDir` (durable per-thread report storage, kept out of
  the reclaimed worktree) in `config.ts`.

**Coupling: LOW for the engine, HIGH at the edges.** The dispatcher, liveness
sweep, ask/report, shared graph libs and all web components are fork-only files
on paths upstream never touched — they merge cleanly. The collision points are
the _shared_ files these hook into: `orchestration.ts` (union additions),
`ProjectionSnapshotQuery.ts` (read model), `serverRuntimeStartup.ts` (wiring the
dispatcher/sweep layers into the runtime), `server.ts`/`ws.ts`, and the web
`store.ts`/`Sidebar.tsx`/`ChatView.tsx` cluster — all in the overlap set.

---

## E. Role-scoped prompting & workstream doctrine — **PRESERVE (low cost)**

System-prompt overlays per child role, read fresh from `roles/<role>.md` at
session start (editable without rebuild).

**Files:** `orchestration/roleOverlay.ts` (33) +`.test`; `roles/{orchestrator,
coder,reviewer,researcher}.md`.

**Coupling: LOW.** Self-contained fork-only files; consumed by the Pi spawn
path. Cheap to carry as-is. (The `roles/*.md` content is also product copy the
user iterates on — preserve verbatim.)

---

## F. Thread status / plan-lane / attention / dependencies model — **PRESERVE**

The two-axis thread state (plan lane: planned/ready/in_progress/done/cancelled;
attention: awaiting_acceptance/needs_guidance) plus dependency edges and a
`LegacyThreadStatus` compatibility literal. Underpins both the Workstream board
and the sidebar indicators.

**Files:** `orchestration.ts` contract additions (see §D); projector branches;
migrations `038`/`042`; `commandInvariants.ts` (197) + decider guard tests
(`decider.attentionTerminal`, `decider.cancelCascade`, `decider.errorGuard`);
web `ThreadStatusIndicators.tsx` + `.logic.ts`.

**Coupling: LOW for server logic (decider/projector/invariants are
fork-only-touched), HIGH for `ThreadStatusIndicators.tsx` and the contract.**
Note `LegacyThreadStatus` exists as our own migration scaffolding — on a clean
re-baseline confirm it's still needed rather than porting it reflexively.

---

## G. The orchestration contract (`packages/contracts/src/orchestration.ts`) — **PRESERVE, HIGH RISK**

Not a feature per se but the **single highest-collision file** and the spine of
§C/§D/§F. +703 lines, and it **is in the 106-file overlap** (both sides edited
it). All the goal/task/workstream/attention commands, events and aggregates are
additive members of upstream's discriminated unions.

**Coupling: HIGH.** Resolution strategy for Task D: take upstream's union
_structure_ as the base and re-graft the fork's additional command/event/payload
members onto it, rather than taking "ours" wholesale. If upstream restructured
how commands are tagged or how the event store decodes them, every fork addition
must be reshaped to match. Sibling high-risk contract files in the overlap:
`settings.ts` (+60; `PiSettings`, `workstreamModelPresets`, `reasoningDisplay`),
`rpc.ts` (+14), `server.ts` (+19), `baseSchemas.ts` (+5).

---

## H. Reasoning / thinking-block display — **PRESERVE (consider REDO-CLEAN if upstream now does it)**

Streaming + persisted display of model reasoning blocks, with a tri-state
visibility setting (`reasoningDisplay`).

**Files:** `orchestration/Layers/ReasoningStreamBus.ts` (39) + `Services/*`;
`ReasoningStreamItem` contract; migrations `034_ProjectionThreadMessageReasoning`,
`036_CanonicalizeReasoningEvents`; `ProviderRuntimeIngestion.ts` (+322),
`ProjectionThreadMessages` layer+service; web `ChatMarkdown.tsx`,
`MessagesTimeline.{tsx,logic.ts,browser.tsx}`, settings panel.

**Coupling: HIGH.** `ProviderRuntimeIngestion.ts`, `MessagesTimeline.*`,
`ChatMarkdown.tsx`, `ProjectionSnapshotQuery.ts` and `settings.ts` are all in
the overlap. Upstream has its own reasoning/thinking rendering that has likely
advanced over 289 commits — **strong REDO-CLEAN candidate**: prefer adopting
upstream's reasoning display and re-attaching only the Pi-specific ingestion +
the `reasoningDisplay` setting, rather than porting our timeline edits verbatim.
Task D should diff upstream's current reasoning handling before deciding.

---

## I. Subscription / account usage visibility — **PRESERVE (self-contained)**

Polls Claude/Codex 5h + weekly subscription limits and surfaces them in the
sidebar.

**Files:** `provider/Layers/SubscriptionUsagePoller.ts`,
`provider/Services/{SubscriptionUsagePoller,AccountUsageRegistry}.ts`,
`piQuotas.ts`; client `accountUsage.ts` +`.test`; web
`sidebar/SidebarAccountUsagePill.tsx`; wiring in `serverRuntimeStartup.ts`,
`Sidebar.tsx`, `wsRpcProtocol.ts`.

**Coupling: LOW core, HIGH wiring.** The poller/registry are fork-only-new; the
collision is only at `Sidebar.tsx`, `serverRuntimeStartup.ts`, `wsRpcProtocol.ts`
(all overlap). Low-priority to merge — could even be re-added after the core
sync lands.

---

## J. Thread interpretation: title + emergent goal — **PRESERVE (small, REDO-CLEAN-friendly)**

Replaces upstream's plain thread-titling with a combined "title + emergent goal"
interpretation on first turn (`buildThreadInterpretationPrompt`), wired so the
goal objective maps onto the `goal.create` field. Upstream's
`buildThreadTitlePrompt` is retained but call-less (kept close to upstream
deliberately).

**Files:** `textGeneration/TextGenerationPrompts.ts` (+49),
`TextGeneration.ts` (+34), `TextGenerationUtils.ts` (+8),
`useHandleNewThread.ts`.

**Coupling: HIGH** — the whole `textGeneration/*` cluster is in the overlap
(every per-harness `*TextGeneration.ts` was lightly edited too, +23 each). Since
the author already kept upstream's titling path intact, this re-bases cleanly:
take upstream's `textGeneration` and re-add the interpretation prompt + its single
call site.

---

## K. Composer / chat UX deltas — **mixed: PRESERVE the Pi-tied, REDO-CLEAN the rest**

Queued-message steering (`ComposerQueuedMessages.tsx`, `QueuedMessages`
contract, `composerDraftStore`), context-window/cost metering
(`ContextWindowMeter.tsx`, `lib/contextWindow.ts`, migrations
`041_*CumulativeCost`, `044_*ContextMetrics`), mention/`@thread` plumbing
(`composer-editor-mentions`, `lib/threadMention`), command-palette and
right-panel-tabs additions.

**Coupling: HIGH** — almost all of these files (`ChatComposer`, `ChatView*`,
`CommandPalette`, `MessagesTimeline`, `store.ts`, `uiStateStore`,
`rightPanelStore`, `composer-*`) are in the overlap and are exactly the files
upstream iterates on most. **Treat as REDO-CLEAN by default**: re-apply the
Pi-specific behaviour (queued steering, `@thread` mentions feeding the workstream
ask, context-cost surfacing) on top of upstream's current composer/chat, rather
than porting our versions. Only the parts wired to Pi-only contracts must be
preserved; generic composer tweaks should yield to upstream.

---

## L. Non-code artefacts — **DROP from the merge (keep in fork history)**

`.plans/**`, `docs/design/**`, `docs/plans/**`, `docs/research/**`,
`goals/**` (markdown, now non-authoritative), `progress.md`,
`.pi/manager/**`, `scripts/bootstrap-worktree.sh`, `AGENTS.md` edits.

These are planning/working artefacts, not product. They don't conflict
(fork-only paths) and can carry through harmlessly, but they are **not features
to defend** — if any collide or clutter the re-baseline, drop them freely. The
vendored-repo deletions under `.repos/` (alchemy-effect release scripts,
effect-smol scratchpad) are part of the original fork trim and are irrelevant to
feature preservation; re-sync `.repos/` from upstream's tooling regardless.

---

## Quick reference — verdict × coupling

| Area                            | Verdict             | Collision risk for Task D                  |
| ------------------------------- | ------------------- | ------------------------------------------ |
| A. Pi provider driver           | PRESERVE            | HIGH (upstream SPI drift; files fork-only) |
| B. Other harnesses disabled     | DROP/REVERT         | resolve as "upstream + add Pi"             |
| C. Goal & Task system           | PRESERVE            | LOW core; HIGH at contract + SnapshotQuery |
| D. Workstream delegation        | PRESERVE            | LOW engine; HIGH at shared edges           |
| E. Role-scoped prompting        | PRESERVE            | LOW                                        |
| F. Thread status/lane/attention | PRESERVE            | LOW server; HIGH indicators+contract       |
| G. orchestration.ts contract    | PRESERVE            | **HIGH (the spine; in overlap)**           |
| H. Reasoning display            | PRESERVE/REDO-CLEAN | HIGH                                       |
| I. Subscription usage           | PRESERVE            | LOW core; HIGH wiring                      |
| J. Thread interpretation prompt | PRESERVE            | HIGH (textGeneration overlap)              |
| K. Composer/chat UX             | REDO-CLEAN (mostly) | HIGH                                       |
| L. Plans/docs/goals artefacts   | DROP                | none                                       |

**The three files Task D should open first** (highest blast radius, all in the
106-overlap): `packages/contracts/src/orchestration.ts`,
`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts`, and the web
`apps/web/src/store.ts`. Everything else is either fork-only (carries through) or
a deliberate REDO-CLEAN where upstream's newer version should win.
