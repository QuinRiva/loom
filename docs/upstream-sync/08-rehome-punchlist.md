---
manager_sessions:
  - role: plan
    authored_at: 2026-06-30
---

# Upstream sync — re-home punch-list (skeleton merge landed)

_Phase 2.1. The skeleton merge is **committed** with no conflict markers. This
document is the precise worklist for the later re-home phases (2.2–2.6). It does
**not** re-engineer anything — it records exactly what fork capability was set
aside to clear each conflict, where the fork logic still lives, and the upstream
module/layout it must be re-homed onto. Australian English._

> **Read this with** `07-substrate-and-real-conflicts.md` (the measured 62-conflict
> ground truth) and `05-strategy.md` (the zone map + disposition table). This doc
> is the bridge from "merge committed" to "fork features re-applied".

---

## The two SHAs you need

| What | SHA |
|---|---|
| **Pre-merge fork SHA** (merge's **first parent**) | **`6150362cfbf4623b3864a0a3426d966963d2c04f`** |
| Upstream merged (second parent, v0.0.28) | `2448212367b4348f39eaf5c2635eea6896218cba` |
| **Skeleton merge commit** | **`777bd20f82a6a4813d3ee09745428b8a64567e7a`** |
| Synthetic graft merge-base | `477795697d8546a8db4903bd878a5ad3196423b9` |

**Every re-home recovers fork logic from the pre-merge SHA:**

```sh
git show 6150362cf:<path>          # the fork version of any taken-upstream/deleted file
git diff 477795697 6150362cf -- <path>   # just the fork's delta over baseline (cleanest)
```

Local commit only — **nothing pushed**, graft intact (`git replace -l` →
`6c82133…`). Undo the whole merge if ever needed with `git reset --hard 6150362cf`.

---

## How the 62 conflicts were resolved

| Disposition | Count | Mechanic |
|---|---|---|
| **Accept upstream deletion** (UD) | 19 | `git rm` — fork delta re-homed later |
| **Take upstream wholesale** (UU, real re-engineering) | 41 | `git checkout --theirs` — fork capability on punch-list |
| **Resolved properly now** (UU, small/gating) | 2 | hand-merged — see below |

The two resolved-now:

- **`packages/contracts/src/settings.ts` (Z5).** Based on upstream's reshaped
  schema; re-applied the fork's additive keys. Both collisions were pure additions
  to the same struct — kept **both** `reasoningDisplay` (fork) and `wordWrap`
  (upstream). Verified present after merge: `PiSettings`, `PiSettingsPatch`,
  `workstreamModelPresets`, `ReasoningDisplayMode` + `DEFAULT_REASONING_DISPLAY_MODE`,
  `reasoningDisplay`. `autoOpenPlanSidebar` kept at **upstream's** value (default
  decision deferred to the web phase, per brief).
- **`apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (Z2).** The
  body auto-merged onto upstream's `RepositoryIdentityResolver` **namespace** import
  (the fork's `…/project/Services/RepositoryIdentityResolver.ts` was deleted
  upstream and replaced by `…/project/RepositoryIdentityResolver.ts`). Kept
  upstream's namespace import + re-applied the fork's two **additive** Pi imports
  (`ProjectionGoal`/`ProjectionGoalTask`, `buildGoalTaskTree`/`FlatGoalTask`);
  dropped the fork's dead Services-path import. The goal/task-tree helper and
  Result mappings auto-merged into the body and are intact.

---

## (a) SERVER core re-home  → Phase 2.2

Target: server typecheck green. All these files were **taken upstream wholesale**
(UU, `--theirs`) or **deleted** (UD); the fork capability must be re-attached onto
upstream's drifted layout.

| Fork capability lost | Pre-merge source path | Re-home target (upstream layout) |
|---|---|---|
| **Runtime layer wiring** — WorkstreamDispatcher, LivenessSweep, ProjectionGoals, ProjectionThreadHeartbeats, ReasoningStreamBus, SubscriptionUsagePoller registrations | `apps/server/src/serverRuntimeStartup.ts` (UU→theirs) | Re-insert each layer into upstream's restructured startup (Z10). **Load-bearing: a missed layer silently kills its Pi feature.** |
| **RPC handler registrations** — goal/task, workstream (spawn/set-lane/report/attention/dependencies/release/stop), account-usage push | `apps/server/src/ws.ts`, `apps/server/src/server.ts` (UU→theirs) | Re-register on upstream's reshaped ws/server handler surface (Z9), lock-step with client-runtime (b). |
| **`*TextGeneration` Effect behaviour** — fork's behavioural edits to the text-generation family | `apps/server/src/textGeneration/{TextGeneration,ClaudeTextGeneration,CodexTextGeneration,CursorTextGeneration,GrokTextGeneration,OpenCodeTextGeneration}.ts` (UU→theirs) | Re-apply fork's behavioural deltas onto upstream's `TaggedError`/`cause`-chain shapes (Z8/Z17). Adapters/config/relay already auto-merged. |
| **PiDriver SPI re-fit** — deterministic per-thread `--session-id` create-or-resume (survives server restarts) | `apps/server/src/provider/Drivers/PiDriver.ts` *(no conflict; SPI drifted under it — 5 typecheck errors)* | Re-fit method signatures / error construction / runtime-event shapes to the **current** `ProviderDriver`/`ServerProvider` SPI (Z6). |
| **Driver registry** — fork gutted it to Pi-only | `apps/server/src/provider/.../builtInDrivers.ts` *(no conflict; restore needed)* | Restore upstream's full 5-driver registry **+ add PiDriver** (Z7). Pi-first; don't over-invest re-enabling the others. |
| **CLI `project.ts`** — both heavily rewrote (fork +17/−202, upstream +203/−65) | `apps/server/src/cli/project.ts` (UU→theirs) | Re-apply any fork-specific CLI behaviour onto upstream's rewrite (surprise conflict; verify what the fork edit actually added). |
| **terminal Manager layer** — fork modified; upstream **deleted** (terminal layer restructure) | `apps/server/src/terminal/Layers/Manager.ts` (UD) | Re-home fork edit onto upstream's new terminal layer structure, or confirm obsolete. |
| **Server test files** (travel with their zones) | `server.test.ts`, `mcp/McpSessionRegistry.test.ts`, `orchestration/Layers/ProviderRuntimeIngestion.test.ts`, `textGeneration/TextGeneration.test.ts` (UU→theirs); `checkpointing/Layers/CheckpointDiffQuery.test.ts`, `project/Layers/ProjectSetupScriptRunner.test.ts` (UD) | Reconcile/restore fork test assertions as each server zone is re-homed. |

**Effect-convention debt (Z8/Z18, fork-new code):** the bulk of the 554 server
errors are `TS377030`/`TS377004` ("unknown in the requirements channel" / Effect
convention) on **fork-only** engine code that upstream never touched (the
goal/workstream dispatcher, decider/projector branches, integration harness). These
don't conflict — they are a **conformance** task: bring fork-new Effect code into
upstream's current convention so the new lint/typecheck passes.

---

## (b) CLIENT-RUNTIME re-home  → Phase 2.3

Target: client-runtime typecheck green (currently 24 errors). Upstream's #2978
rewrite **deleted** every flat module the fork edited and replaced them with
`connection/` / `rpc/` / `state/` / `relay/` subtrees (Z4).

| Fork capability lost | Pre-merge source path | Re-home target |
|---|---|---|
| WS transport edits | `packages/client-runtime/src/wsTransport.ts` (+`.test.ts`) (UD) | New `connection/` subtree |
| WS RPC protocol edits | `packages/client-runtime/src/wsRpcProtocol.ts` (UD) | New `rpc/` subtree |
| Thread-detail state + **retention limits** (`ThreadDetailRetentionLimits`, `DEFAULT_THREAD_DETAIL_LIMITS`) | `packages/client-runtime/src/threadDetailState.ts` (+`.test.ts`) (UD) | New `state/` subtree — `state/threadReducer.ts` already references these names (3 `TS2304` errors confirm the gap). |
| Package barrel exports | `packages/client-runtime/src/index.ts` (UD) | New `index.ts` (re-export the new subtrees + Pi additions). |
| `goals` field on shell snapshot; goal/workstream entity fields (`goalId`, `parentThreadId`, `role`, `purpose`, …); `queuedMessages` on thread runtime | flat state modules (UD) + `state/threadReducer.test.ts` (UU→theirs) | Add the fork's goal/workstream fields to upstream's `state/entities` + snapshot types (the `goals`-missing / 12-fields-missing errors). |
| Archived-threads / shell-snapshot state tests | `archivedThreadsState.test.ts`, `shellSnapshotState.test.ts`, `threadDetailState.test.ts` (UD) | Reconcile onto new `state/` tests. |

---

## (c) WEB store decomposition re-home  → Phase 2.4

Target: web state layer typechecks. Upstream **deleted** `apps/web/src/store.ts`
(−2050) and split web state into per-feature atom modules (Z3).

| Fork capability lost | Pre-merge source path | Re-home target |
|---|---|---|
| **+441 lines of goal / workstream / multi-session web state** | `apps/web/src/store.ts` (+`store.test.ts`) (UD) | Re-home each fork addition into the matching upstream per-feature atom module, or a new Pi-owned `*Store.ts` following the new convention. Gates the whole web shell. |
| Server-state RPC sibling | `apps/web/src/rpc/serverState.ts` (UD) | New `rpc/` layout (matches client-runtime b). |
| Web runtime service edits | `apps/web/src/environments/runtime/service.ts` (+`.threadSubscriptions.test.ts`) (UD — surprise: deleted upstream) | Re-home onto upstream's reshaped environment runtime. |
| Goal/workstream **types** (`GoalTask`, `GoalShell`, …) | fork additions to `apps/web/src/types.ts` (UU→theirs) | Re-add to upstream's reshaped `types.ts` (web errors: `'../types' has no exported member 'GoalTask'/'GoalShell'`). |
| Browser-test harnesses | `ChatView.browser.tsx`, `chat/MessagesTimeline.browser.tsx`, `KeybindingsToast.browser.tsx` (UD) | Re-home onto upstream's component layout if still wanted. |

---

## (d) WEB shell Pi-UX re-apply  → Phase 2.5

Target: web shell typechecks + renders multi-session/workstream/goals. All taken
upstream wholesale (UU→theirs); re-apply the Pi UX **by hand** onto upstream's
rebuilt components (gated by b + c).

| Fork capability lost | Pre-merge source path | Re-home target / zone |
|---|---|---|
| Multi-session / goal-header / workstream touchpoints in the main chat view | `apps/web/src/components/ChatView.tsx`, `ChatView.logic.ts` (UU→theirs) | Re-apply onto upstream's rewritten ChatView (Z11, +1956/−1442 — deliberate re-apply, not auto-merge). |
| **Goal header / multi-session** (fork +249) | `apps/web/src/components/chat/ChatHeader.tsx` (UU→theirs) | Re-apply onto upstream ChatHeader (Z11 cluster). |
| Multi-session/workstream tree + goal surfacing + account-usage pill | `apps/web/src/components/Sidebar.tsx` (UU→theirs) | Re-apply onto upstream Sidebar (Z12). `Sidebar.logic.ts` auto-merged. |
| `@thread` mentions → workstream ask, queued-message steering, context/cost meter | `chat/ChatComposer.tsx`, `composerDraftStore.ts`, `composer-editor-mentions.ts`, `uiStateStore.ts`, `rightPanelStore.ts`, `components/RightPanelTabs.tsx`, `components/CommandPalette.tsx`, `components/DiffPanel.tsx` (UU→theirs) | Re-attach only Pi-tied behaviour; generics yield to upstream (Z14). |
| Pi reasoning ingestion + `reasoningDisplay` tri-state | `chat/MessagesTimeline.tsx`, `MessagesTimeline.logic.ts`, `ChatMarkdown.tsx` (UU→theirs) | Adopt upstream timeline; re-attach Pi reasoning (Z13). `ProviderRuntimeIngestion.ts` is fork-only. |
| Two-axis plan-lane/attention status model | `components/ThreadStatusIndicators.tsx` (UU→theirs) | Fold Pi model into upstream additions (Z15). |
| `reasoningDisplay` settings UI + Pi settings panels | `components/settings/SettingsPanels.tsx` (UU→theirs) | Re-add Pi settings controls (Z5 web side). |
| Multi-session route wiring (fork +55) | `routes/_chat.index.tsx` (UU→theirs) | Re-apply route hook (Z11 surprise). |
| `buildThreadInterpretationPrompt` + call site (goal objective → `goal.create`) | `hooks/useHandleNewThread.ts` (UU→theirs) | Re-add onto upstream's restructured new-thread hook (Z17). |
| Web test files | `ChatView.logic.test.ts`, `Sidebar.logic.test.ts`, `environmentGrouping.test.ts`, `localApi.test.ts` (UU→theirs) | Reconcile as each web zone is re-homed. |

---

## (e) Tail — out-of-scope drops & regen  → Phase 2.6

- **`apps/desktop/src/settings/DesktopClientSettings.test.ts`** (UU→theirs): the
  out-of-scope fork edit (+1) was **dropped**, taking upstream. No re-home; the
  fork delta leaked into desktop and is intentionally discarded.
- **`pnpm-lock.yaml`** (UU→theirs): took upstream to clear. **Must be regenerated**
  after re-home (`pnpm install`) once dep changes settle — do **not** hand-edit
  (Z19). Web errors `Cannot find module '@t3tools/client-runtime'` will clear once
  client-runtime (b) typechecks and the workspace links resolve.
- `packages/client-runtime/src/state/threadReducer.test.ts` (UU→theirs): the
  rename-detection surprise; reconciles with (b).

---

## Post-merge typecheck — the worklist as a number

`vp run typecheck` is **red as expected** (re-homed fork code is missing). The
workspace runner stops at the first failing dependency (`client-runtime`), which
**gates** apps/server + apps/web (they are skipped, not run). Running each package's
`typecheck` directly reveals the full surface:

| Package | TS errors | Dominant kind | Maps to phase |
|---|---|---|---|
| `packages/client-runtime` | **24** | missing goal/workstream fields; `ThreadDetailRetentionLimits`/`DEFAULT_THREAD_DETAIL_LIMITS` (`TS2304`) | (b) |
| `apps/server` | **554** | mostly `TS377030`/`TS377004` Effect-convention on fork-new engine code + `TS2375` missing `goals` field; some missing moved modules | (a) |
| `apps/web` | **92** | `Cannot find module '../store'` / `'@t3tools/client-runtime'`; `types` missing `GoalTask`/`GoalShell`; deleted `@pierre/*` & `serverState` | (c)+(d) |

Top offenders (per `npm run typecheck` in each package; logs at
`/tmp/tc-{client-runtime,server,web}.log`):

- **server** — `server.test.ts` (324, mostly Effect-convention), `bin.test.ts` (53),
  `server.ts` (25), `cli/orchestrationMutation.ts` (21), `cli/goal.ts` (14),
  `workspace/*` (~45), `provider/Drivers/PiDriver.ts` (5).
- **web** — `components/files/FilePreviewPanel.tsx` (16),
  `components/WorkstreamPanel.tsx` (13), `ChatView.logic.test.ts` (10),
  `diffs/AnnotatableCodeView.tsx` (8), `Sidebar.logic.test.ts` (7),
  `goals/goalState.tsx` (5).
- **client-runtime** — `state/entities.test.ts` (7), `state/threadReducer.test.ts`
  (5), `state/threads.ts` (4), `state/threadReducer.ts` (3).

This error surface **is** the re-home worklist. Clearing it in dependency order —
**(b) client-runtime → (c) web store → (a) server core → (d) web shell** — with
`vp run typecheck` green after each, plus the lockfile regen and a real Pi-session
smoke test, is Phases 2.2–2.6.

### Reproduce

```sh
git rev-parse HEAD                                   # 777bd20f8 (merge)
git log -1 --format='%P'                             # 6150362cf 2448212367 (parents)
(cd packages/client-runtime && npm run typecheck)    # 24 errors
(cd apps/server && npm run typecheck)                # 554 errors
(cd apps/web && npm run typecheck)                   # 92 errors
git show 6150362cf:apps/web/src/store.ts             # recover any fork file
```
