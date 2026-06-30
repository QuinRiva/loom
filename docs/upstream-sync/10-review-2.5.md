---
manager_sessions:
  - id: 8f3ecfc0-6cf5-4f8e-8a26-3136b0b8c258
    role: review
    authored_at: 2026-06-30T09:10:03.480Z
---

# Review — Phase 2.5 web-shell Pi-UX re-apply

_Independent reviewer audit of `git diff fdca4d3e5..HEAD` (HEAD = `880ed6182`,
8 commits `dfcf4d8be`…`880ed6182`). Scope: lost-UX audit against doc 08(d),
correctness of the Pi touchpoints grafted onto upstream's rewritten web shell,
the two deferred parent-decisions (DiffPanel, goal-CRUD menus), cross-package
edits, and convention/cleanliness. Read with doc 06 (plan-vs-goal convergence)
and the 2.5 coder report. Australian English._

---

## Verdict: **SHIP** — with one MAJOR follow-up to track before final "done"

The web-shell re-apply is **faithful, idiomatic and substantially complete**.
Every load-bearing Pi web capability I traced is genuinely re-applied AND
functionally wired — not merely typechecking: the goal/workstream right-panel
surfaces render real components, the reasoning tri-state honours all three
modes, spawn cards group by turn causality with live child-status reads, the
`@thread` mention path and subtree cost meter are end-to-end, and the Sidebar's
roots-only + goal-grouping model drives **one** ordering shared by both the
rendered list and the Ctrl+N jump map (so they cannot drift). `apps/web`
typecheck **verifies at 0**; `apps/desktop` has exactly the one known
`reasoningDisplay` fixture error (Phase 2.6/m2). No compat shims or dual-shape
cruft were introduced.

It is SHIP, not RETHINK, because the foundation is sound and the Pi-first
experience works. The one material gap is a **genuinely lost fork feature** —
the Sidebar **goal-CRUD context menus** (create-from-thread / assign / archive /
delete) — which the report honestly flagged as deferred. It is degraded, not
fatal (goals still display, navigate, are created by agents, and are renamed via
the new header), and re-homing it needs _new_ client-runtime command wrappers
(real work beyond a re-home), so it is an acceptable tracked follow-up rather
than a 2.5 blocker. There is also one minor regression to an _upstream_ feature
(`pinnedCollapsedThread`) and a documentation correction for doc 08(d).

On the two deferrals: **DiffPanel → ACCEPT-DROP** (upstream genuinely subsumes
it); **Goal-CRUD menus → RE-HOME** as a tracked follow-up (major, not a blocker).

---

## Build state — verified, not taken on trust

| Package        | Claimed | **Measured** | Notes                                                                                                |
| -------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| `apps/web`     | 0       | **0** ✓      | `npm run typecheck` clean                                                                            |
| `apps/desktop` | 1 (2.6) | **1** ✓      | `DesktopClientSettings.test.ts(15,7) TS2741` missing `reasoningDisplay` — Phase 2.6/m2, out of scope |

Compat-shim scan over the code diff: **clean** (the only `backward-compat`
matches are in the prose of review doc 09, not in code).

---

## Lost-UX audit (highest priority) — walked doc 08(d) item by item

| Pi feature                                                        | Status         | Evidence                                                                                                                                                                                                             |
| ----------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Right-panel `tasks`→GoalTasksPanel / `workstream`→WorkstreamPanel | ✓ wired & real | `rightPanelStore` kinds; `RightPanelTabs` add-menu/empty-state/icons/titles; `ChatView` content branches + availability gating; both panels are real (GoalTasksPanel reads `useGoalById`; WorkstreamPanel 704 lines) |
| Panel labelled **"Goal tasks"** not bare "Tasks"                  | ✓ per doc 06   | `SURFACE_DISABLED_REASONS.tasks`, menu label, `surfaceTitle` all say "Goal tasks"                                                                                                                                    |
| Editable goal header (title/desc/progress → `goal.meta.update`)   | ✓ functional   | `ChatHeader.GoalHeaderBody`: controlled inputs, blur/Enter commit, Escape revert, `useEffect` resync, popover description                                                                                            |
| Thread-lineage breadcrumb (orchestrator→sub-thread nav)           | ✓ functional   | `ThreadLineageBreadcrumb` + `buildThreadLineage` (cycle guard, depth cap, missing-parent segment); `navigateToThread` wired from ChatView                                                                            |
| Sidebar roots-only filter (children via badge)                    | ✓ re-added     | `parentThreadId === null` filter at top-level **and** per-project; rollups built from the _unfiltered_ shells                                                                                                        |
| Sidebar workstream rollup badge                                   | ✓              | `WorkstreamGraphIndicator` + `buildGraphRollupByThreadKey`/`collectDescendantThreads`; two-axis badge with act-state popover                                                                                         |
| Sidebar goal tree (headers, progress, collapse, compact-single)   | ✓              | `buildSidebarProjectThreadOrdering` drives render **and** jump map (single source); goal headers, `collapsedGoalIds` lifted to top-level                                                                             |
| Account-usage pill                                                | ✓              | `SidebarAccountUsagePill` in `SidebarChromeFooter`                                                                                                                                                                   |
| New-session-in-goal affordance                                    | ✓              | `createGoalSession` → `createThreadForProjectMember(member,{goalId})`                                                                                                                                                |
| Reasoning trace honouring `reasoningDisplay` tri-state            | ✓ correct      | `ReasoningBlock`: off=suppressed, collapsed=closed after stream, expanded=open; streaming force-opens with timer; empty-response placeholder suppressed when reasoning-only                                          |
| Workstream spawn cards                                            | ✓              | `SpawnCardSection` groups `workstream_spawn` by `turnId`; child status/role/click-through; `spawnChildStatus` reads attention/lane/session                                                                           |
| `thread://` chips                                                 | ✓              | `ChatMarkdown` adds `thread` sanitize protocol, preserves href in urlTransform, renders `ThreadTagChipContent`                                                                                                       |
| `@thread` mentions → workstream ask                               | ✓              | `matchThreadMentionItems` in composer menu → `serializeComposerThreadLink` `[Title](thread://id)`; shared `composerInlineTokens` thread branch                                                                       |
| Context/cost meter (subtree rollup)                               | ✓              | `deriveContextCostSummary(activeThreadId, threadShells)` → `ContextWindowMeter cost=`                                                                                                                                |
| `goalId` draft threading                                          | ✓              | `composerDraftStore` (persisted `optionalKey` + null default, equality, hydrate), `useHandleNewThread`, `buildLocalDraftThread`                                                                                      |
| Goal-overview route                                               | ✓              | `_chat.index.tsx` renders goal cards + TaskTree when goals exist, else `NoActiveThreadState`                                                                                                                         |
| New-thread interpretation prompt (goal objective → `goal.create`) | ⚠ phantom item | `buildThreadInterpretationPrompt` **never existed** in the fork (`6150362cf`) — see m3. What the fork actually did (thread `goalId` through) **was** re-applied. No feature lost; doc 08(d) is wrong.                |
| Two-axis plan-lane/attention status model                         | ✓              | `ThreadStatusIndicators.logic` + `lib/workstreamGraph` (pre-existing, 162/235 lines); badge consumes them                                                                                                            |
| `reasoningDisplay` settings UI                                    | ✓              | `SettingsPanels` tri-state Select + restore handling                                                                                                                                                                 |

---

## Findings by severity

### BLOCKER — none

### MAJOR

**M1 — Goal-CRUD context menus are a genuinely lost Pi-first feature (deferred).**
The pre-merge fork (`6150362cf:apps/web/src/components/Sidebar.tsx`) shipped a
full goal lifecycle from the GUI:

- **create-goal-from-thread** — prompt title/slug/description → `goal.create` +
  `thread.meta.update` (assign the thread to the new goal);
- **assign-to-goal / clear-goal** — `thread.meta.update` with `goalId`;
- **goal rename / archive / delete** — `goal.meta.update` / `goal.archive` /
  `goal.delete`, the delete behind a cascade-aware confirm dialog that counts the
  full thread blast radius.

After 2.5 only **rename** survives (recovered via the editable header →
`goal.meta.update`). The client-runtime wraps **only** `goal.meta.update`;
`goal.create`/`archive`/`delete` and goal-assignment have **no GUI path**. The
server decider already handles all of them, so this is purely client wiring, but
it needs _new_ command wrappers — genuine work beyond a re-home, which is why
deferring it was reasonable.

- **Impact:** a human cannot create, archive, delete or (re)assign a goal from
  the GUI. Goals still appear (agent `goal_handoff`/MCP + new-session-in-goal),
  navigate, show progress, and rename — so the experience is **degraded, not
  killed**. But GUI goal _creation_ and _lifecycle_ are real Pi-first
  affordances now absent.
- **Recommendation: RE-HOME, tracked, before the merge is declared finally
  "done" — not a 2.5 blocker.** Add `goal.create`/`goal.archive`/`goal.delete`
  client-runtime wrappers (mirroring the new `goal.meta.update` + the
  thread-command pattern) and re-attach the Sidebar context-menu actions +
  delete-confirm. The orchestrator already has a sub-task for this; this review
  rates it **major** and recommends it lands in Phase 2.6/2.7, not be dropped.

### MINOR

**m1 — `pinnedCollapsedThread` dropped (regression to an UPSTREAM feature).**
Upstream v0.0.28 (`2448212367`, 9 refs) kept the active thread pinned/visible in
the Sidebar even when its project node is collapsed. The fork never had this, and
the 2.5 ordering rewrite removed it (`shouldShowThreadPanel = projectExpanded`
only; the jump map returns `[]` for collapsed projects). Net: collapse a project
while viewing a thread in it and you lose that thread's visual anchor in the
sidebar. Small convenience, but it _is_ a deliberate upstream feature lost during
a re-apply that was supposed to preserve upstream gains. Re-homing it onto the
goal-grouping ordering is fiddly (the active thread may sit inside a collapsed
goal). Recommend the orchestrator decide: restore on the new model, or record as
an intentional drop.

**m2 — `/api/vcs/diff` server endpoint is now dead web code (see DiffPanel
deferral).** Harmless, but a cleanup opportunity once the DiffPanel drop is
confirmed (below).

**m3 — Doc 08(d) names a phantom function.** The punch-list item
"`buildThreadInterpretationPrompt` + call site (goal objective → `goal.create`)
from `hooks/useHandleNewThread.ts`" describes a function that exists in **neither**
the fork nor HEAD. The fork's `useHandleNewThread` only threaded `goalId`; the
actual `goal.create` lived in the Sidebar thread context menu (now M1). No code
defect — but doc 08(d) should be corrected so future pulls don't chase a ghost,
and the 2.5 report's "interpretation prompt" phrasing overstates what was (and
should have been) re-applied.

### Assessed and accepted (not findings)

- **`goal.meta.update` client-runtime wrapper — sound.** `updateGoalMeta` op +
  `createGoalEnvironmentAtoms` mirror the 2.3 thread-command pattern exactly
  (serial scheduler keyed on `[environmentId, goalId]`). Minimal, correct.
- **`CostGraphNode.cumulativeCostUsd` → optional — correct, not a widening hack.**
  The contract already declares it `Schema.optional(NonNegativeNumber)`
  (`orchestration.ts:453/604`); the shared interface was _stricter_ than the wire
  shape. The change aligns the type with the contract; every consumer already
  uses `?? 0`. Right call for `exactOptionalPropertyTypes`.
- **`@thread`/file-link token disambiguation — correct.** `thread://` matches
  `URI_SCHEME_REGEX`, so the file-link branch skips it as an external scheme; the
  dedicated thread branch claims it. No double-classification.
- **Plan-sidebar + goal-panel coexistence — correct per doc 06.** Both _add_ a
  right-panel tab via independent auto-open effects (`autoOpenedTasksByThreadKey`
  ref vs the plan-sidebar effect); neither owns an exclusive slot. The
  goal-tasks auto-open is once-per-thread-key and won't clobber a user's later
  surface choice.
- **`autoOpenPlanSidebar` default = `false` — reasonable.** Matches the contract
  default (`settings.ts:50`) and upstream's #2421 flip; goal-panel auto-open
  already covers goal-linked threads, so plan-on-every-thread would be noise.

---

## The two deferred parent-decisions — explicit recommendations

### 1. DiffPanel HEAD working-tree diff → **ACCEPT-DROP** ✅

The fork's DiffPanel added `fetchHeadDiff` calling `GET /api/vcs/diff` and, when
no turn was selected, rendered the working-tree-vs-HEAD diff. Upstream's current
DiffPanel **already subsumes this**: it has a `selectedGitScope` with a
**"Working tree"** source (`kind === "working-tree"`, shows uncommitted changes)
_and_ a richer **branch-range** base-ref selector (`buildBaseRefChoices`,
`filterBaseRefChoices`, arbitrary `baseRef`) layered on top of checkpoint turn
diffs. The fork's generic single-mode HEAD diff is a strict subset of upstream's
working-tree + branch-range model.

- **No real capability is lost** — upstream offers the same uncommitted-changes
  view plus more. The `/api/vcs/diff` server endpoint survives but is now unused
  by the web client (m2 cleanup). The deferral's premise ("generic, non-Pi,
  conflicts with checkpoint design") holds. **Do not re-home.**

### 2. Goal-CRUD context menus → **RE-HOME (tracked, major)** — see M1

The fork **did** have these (confirmed in `6150362cf`). This is a real lost
Pi-first capability, not a generic-yields-to-upstream case like the DiffPanel.
Rate **major**; recommend re-homing in Phase 2.6/2.7 before the merge is declared
finally done, but it does **not** block Phase 2.5 sign-off (server decider
already supports the commands; only client wrappers + menu wiring remain; the
core goal experience is intact).

---

## Top issues to fix (in order)

1. **M1 (major, tracked)** — re-home Sidebar goal-CRUD: add
   `goal.create`/`goal.archive`/`goal.delete` client-runtime wrappers + the
   context-menu actions (create-from-thread, assign/clear, archive, delete+confirm).
   Before final merge "done", not a 2.5 blocker.
2. **m1 (minor)** — decide on `pinnedCollapsedThread`: restore on the goal-grouping
   model or record as an intentional drop.
3. **m3 (minor, docs)** — correct doc 08(d)'s phantom `buildThreadInterpretationPrompt`
   item; it was never a real fork feature.
4. **m2 (minor, cleanup)** — remove/retire the now-unused `/api/vcs/diff` web path
   once the DiffPanel ACCEPT-DROP is confirmed.

Runtime verification (live Pi-session smoke test of reasoning rendering,
spawn-card child-status, goal/workstream panels, `@thread`/cost meter) is owed in
Phase 2.6 — it could not be exercised here without a running server; all wiring
above was assessed statically and is consistent.
