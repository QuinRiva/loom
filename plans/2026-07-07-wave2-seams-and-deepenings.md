---
manager_sessions:
  - id: d2fe0abd-4dd3-4046-9eaa-f168f48d4f39
    role: plan
    authored_at: 2026-07-07T23:18:39.166Z
---

# Wave 2 — Sidebar/ChatView seam-narrowing + residual deepenings

_Loom (fork of `pingdotgg/t3code`, remote `upstream`) keeps merging upstream with
minimal conflicts. Wave 1 (see `plans/2026-07-07-fork-seam-campaign.md`,
`plans/2026-07-07-loom-deepening-pair.md`, `plans/2026-07-07-web-chat-evacuation.md`,
all landed and rebased in commit `5a48186b1`) relocated fork additions out of
upstream-owned contracts, decider/projector, server wiring, MCP bridge and chat
timeline files. Wave 2 extends the same goal to the two remaining large upstream-file
deltas (`Sidebar.tsx`, `ChatView.tsx`) and clears the residual small deepenings.
Merge-base with `upstream/main`: `600972084`._

## How to read this document

Five slices, each executable by a separate coder without reading the others in depth:

- **Slice A** — `SidebarGoalThreadList` seam (`apps/web/src/components/Sidebar.tsx`, `Sidebar.logic.ts`)
- **Slice B** — `useLoomThreadExtensions` + chat hooks (`apps/web/src/components/ChatView.tsx`)
- **Slice C** — web tidy: `rootOf` export, `workstreamRollup` rename, chip-style move — **runs after Slice A**
- **Slice D** — `PiTurnRetryPolicy` extraction (`apps/server/src/provider/Drivers/PiDriver.ts`) — **runs after Slice E**
- **Slice E** — server smalls: `classifyChildWakeFull`, MCP scope dedup, `piSessionFiles` seam

Shared rules are §0. §7 has the parallelisation map and conflict analysis. §8 is the
reconciliation record for the candidate items (including the one dropped, with rationale).

---

## 0. Non-negotiables (all slices)

Identical to wave 1 §0; restated for coders who have not read it:

1. **No behavioural or visual change anywhere.** Pure code relocation and
   fork-internal restructure. Every render, command, event, retry decision and route
   behaves identically. (One sanctioned exception, scoped and named: Effect span
   labels in Slice E item E2 — see there.)
2. **Never refactor upstream-only logic.** Only fork additions move. Fork edits that
   must remain inside an upstream-owned file are "residuals" and stay put, marked
   with a `// loom:` comment on or immediately above the edited line(s). One-word
   `export` additions to an upstream declaration count as residuals and get the
   marker.
3. **Fork file conventions:** upstream-file splits use a `.loom.ts` sibling
   (`Sidebar.logic.loom.ts`); new fork web modules live in `apps/web/src/loom/`
   (created by wave 1); new fork server modules live next to their consumers in
   already-fork-owned directories (no marker needed inside fork-owned files).
4. **No renaming of exported identifiers consumed elsewhere** unless the slice says
   so explicitly (Slice C item C2 is a deliberate file rename with import updates).
5. **No compat shims.** When a declaration moves, every importer is updated in the
   same commit. Do not leave "re-export kept for backward compatibility" lines
   (deliberate re-export *seams* specified below are design, not compat).
6. **Verification bar per slice:** `vp check` and `vp run typecheck` green, existing
   tests green (`vp test` for the affected packages), plus the slice's manual smoke
   list, run live via the dev-verify recipe (`docs/dev-site-testing.md`) for
   UI-affecting slices.
7. **Hunk-inventory acceptance:** after the slice, run
   `git diff 600972084 -- <upstream file>` and confirm the remaining hunks match the
   slice's residual inventory. Anything extra is scope creep; anything missing means
   behaviour probably changed.
8. **Out of scope entirely** (flagged UPSTREAM-ENTANGLED in the wave-1 review):
   `ProjectionSnapshotQuery.ts` assembly, `ProviderRuntimeIngestion.ts` hooks,
   `RightPanelTabs.tsx` / `rightPanelStore.ts`, and `useHandleNewThread` braiding.

## Fresh measurements (this tree, vs merge-base `600972084`)

| File | Hunks | Delta | Ownership |
|---|---|---|---|
| `apps/web/src/components/Sidebar.tsx` | 41 | +499/−162 | upstream |
| `apps/web/src/components/Sidebar.logic.ts` | — | +252/−3 | upstream |
| `apps/web/src/components/Sidebar.logic.test.ts` | — | +56/−2 | upstream |
| `apps/web/src/components/ChatView.tsx` | 29 | +231/−21 | upstream (note: moved under `components/` — the scout-era path `apps/web/src/ChatView.tsx` is stale) |
| `apps/server/src/provider/Drivers/PiDriver.ts` | n/a | fork-added, 2,250 LOC | fork |

The wave-1 scout reports referenced by the campaign brief no longer exist on disk
(their worktree was recycled); this plan was derived from fresh diffs and code
reading, not from those reports.

---

## Slice A — `SidebarGoalThreadList` seam

### A.1 Outcome

`Sidebar.tsx` drops from **+499/−162 across 41 hunks** to roughly **≤15 residual
hunks / ≤~140 added lines**, and `Sidebar.logic.ts` drops from +252 to **one splice
residual** (a handful of lines at most). Fork-owned rendering and logic move to:

- `apps/web/src/components/Sidebar.logic.loom.ts` (+ `Sidebar.logic.loom.test.ts`)
- `apps/web/src/loom/SidebarGoalThreadList.tsx` — goal-grouped list rendering
- `apps/web/src/loom/useLoomSidebarGoals.ts` — goal state (goals, collapse set, roots filter helper)
- `apps/web/src/loom/sidebarGoalActions.ts` — goal context-menu + create/assign-goal handlers

> The campaign brief targeted ~10 residual hunks. Fresh measurement shows the
> irreducible residuals (ordering call-site rework, thread-context-menu braiding,
> row-prop insertions, draft-clear loop, `createThreadForProjectMember` seed changes)
> land nearer 15 small hunks. That is the honest floor without refactoring upstream
> lines; the coder should not chase 10 by distorting upstream code.

### A.2 The row-render callback contract (the amber-card risk, resolved)

The reason this card was amber: `SidebarThreadRow` takes ~25 props, and a naïve
extraction would re-list them across the seam. **The contract that avoids this:**

```tsx
// apps/web/src/loom/SidebarGoalThreadList.tsx
export interface SidebarGoalThreadListProps {
  orderedEntries: readonly SidebarOrderedEntry<SidebarThreadSummary>[];
  projectGoals: readonly GoalShell[];
  memberProjects: readonly SidebarProjectGroupMember[]; // environmentId resolution
  allProjectThreads: readonly SidebarThreadSummary[];   // UNFILTERED shells (delete-confirm counts)
  collapsedGoalIds: ReadonlySet<string>;
  onToggleGoalCollapse: (goalId: string) => void;
  onNewGoalSession: (goalId: GoalId, goalProjectId: ProjectId) => void;
  /** Row rendering stays entirely upstream-side. The fork component treats a row
   * as an opaque node; upstream row-prop changes never touch this file. */
  renderThreadRow: (
    thread: SidebarThreadSummary,
    options?: { keyOverride?: string; goalNewSessionAction?: React.ReactNode },
  ) => React.ReactNode;
}
```

Design rules, deliberate:

1. **`renderThreadRow` is a render prop, not a props bag.** The ~25-prop closure
   stays inside `SidebarProjectThreadList` in `Sidebar.tsx` (it already exists there
   as the fork's `renderThreadRow`). When upstream adds/removes a row prop, the merge
   conflict is confined to that closure — one self-identifying block — and the fork
   component is untouched. Do NOT move the closure into the fork file; that would
   just relocate the 25-prop coupling across a package boundary.
2. **Goal context-menu handling moves INSIDE the component.** `handleGoalContextMenu`
   (~55 lines: rename/archive/delete with cascade-count confirm) is consumed only by
   goal headers. The fork component owns it outright, calling
   `useAtomCommand(goalEnvironment.updateMeta / archive / delete)` itself (via
   `sidebarGoalActions.ts`), fed by `memberProjects` + `allProjectThreads` from
   props. This removes it — and its `goalEnvironment` imports and plumbing — from
   `Sidebar.tsx` entirely.
3. **One `loom` bundle prop per plumbing level.** Every upstream interface and JSX
   call-site that today gains 3–7 fork props gains exactly ONE:
   - `SidebarProjectThreadListProps` gains `loomGoalList: {...}` (the inputs above
     minus `renderThreadRow`, which is built locally);
   - `SidebarProjectItemProps`, `SidebarProjectsContentProps` and
     `SidebarProjectListRow` gain `loomGoals: { goals, collapsedGoalIds, onToggleGoalCollapse }`.
   Each plumbing site is then a 1-line marked residual.

### A.3 What moves where

**A.3.1 `Sidebar.logic.ts` → `Sidebar.logic.loom.ts`.** All fork-added exports move:
`resolveGoalWorktreeSeed`, `isStagedHandoffThread`, `SidebarGoalSortInput`,
`SidebarThreadOrderInput`, `SidebarOrderedEntry`, `buildSidebarGoalOrderedEntries`,
`buildSidebarProjectThreadOrdering`, `isCompactSingleThreadGoal`,
`flattenSidebarOrderedThreads`. They are generic over `TThread` and standalone
(verify: type-only imports of upstream types are fine; no value imports of
`Sidebar.logic.ts` from the loom file). The +56 fork lines in
`Sidebar.logic.test.ts` move to `Sidebar.logic.loom.test.ts`. Inventory the 3
deleted upstream lines in `Sidebar.logic.ts` — if they are genuine fork
modifications they stay as marked residuals; if they were incidental churn, restore
upstream's text.

**A.3.2 Goal-grouped rendering → `loom/SidebarGoalThreadList.tsx`.** The
`orderedEntries.map(...)` body in `SidebarProjectThreadList` (goal headers with
chevron/progress/title, collapse toggle, compact single-thread goal branch, hover
new-session pencil, expanded `SidebarMenuSub` nesting) moves wholesale. The upstream
file's map is replaced by one mount:
`<SidebarGoalThreadList {...loomGoalList} renderThreadRow={renderThreadRow} />`.
The component imports `SidebarMenuSub`/`SidebarMenuSubItem` from `../components/ui/…`
and the icons directly. `SIDEBAR_ICON_ACTION_BUTTON_CLASS` is a module-private const
in `Sidebar.tsx` — export it (one-word `export` residual, `// loom:` marked; same
precedent as the wave-1 chat evacuation's one-word exports).
`renderGoalNewSessionButton` moves with the component.

**A.3.3 Goal state → `loom/useLoomSidebarGoals.ts`.** From the root `Sidebar()`
component: `useGoals()`, the `collapsedGoalIds` state + `toggleGoalCollapse`
callback move into one hook returning `{ goals, collapsedGoalIds, toggleGoalCollapse }`.
Also export a helper `filterRootThreads(shells)` (the `parentThreadId === null`
filter used twice) so the two roots-only filter residuals become one-liner calls.
Also move the per-project goal filtering (`projectGoals`/`knownGoalIds` memo shape,
used in both `SidebarProjectItem` and `visibleSidebarThreadKeys`) here as a pure
helper `goalsForProject(goals, memberProjects)` — it is currently duplicated.

**A.3.4 Thread-context-menu goal actions → `loom/sidebarGoalActions.ts`.** The
`create-goal` branch (~45 lines: three `window.prompt`s, `createGoal`, error toast,
`updateThreadMetadata`) and the `assign-goal:` branch become exported async
functions taking their deps (`{ createGoal, updateThreadMetadata, thread }`-shaped
parameter objects). A companion `buildGoalMenuItems(projectGoals, thread)` returns
the `create-goal` / `assign-goal` submenu items. Residual in upstream's
`handleThreadContextMenu`: the two spread/insert lines in the menu-items array and
two short delegating branches (~8 lines total, marked). The `useAtomCommand`
instances for `goalEnvironment.create` stay wherever the hooks rules require — if
only the handlers need them, create them inside a small
`useLoomSidebarGoalActions()` hook in the same file and thread the returned handlers.

### A.4 Residual inventory for `Sidebar.tsx` (target ≤15 hunks)

1. Import additions, compressed to ~3–4 grouped one-liners (loom component/hook
   imports; `WorkstreamGraphIndicator`; `GoalShell`/`GoalId` types where still
   needed). Several current import hunks disappear outright (goalEnvironment,
   useGoals/countGoalTasks, newGoalId move to fork files).
2. `SidebarThreadRowProps`: `graphRollup?` + `goalNewSessionAction?` (one block) +
   destructure line.
3. `SidebarThreadRow` body: `isStagedHandoff` + Staged badge; `WorkstreamGraphIndicator`
   mount; `goalNewSessionAction` overlay block. (3 small hunks — these are the
   per-row insertions the campaign brief says stay.)
4. `SIDEBAR_ICON_ACTION_BUTTON_CLASS` one-word export.
5. `SidebarProjectThreadListProps` + destructure + `renderThreadRow` closure +
   `SidebarGoalThreadList` mount (the closure is the one deliberate block residual).
6. `SidebarProjectItem`: roots-only filter + `graphRollupByThreadKey` memo +
   `loomGoals`/`loomGoalList` plumbing; ordering call-site
   (`buildSidebarProjectThreadOrdering` + `orderedProjectThreadKeys` +
   status-pill rework) — this replaced upstream's ordering `useMemo` and cannot
   shrink further without touching upstream logic; draft-clear loop; 
   `createThreadForProjectMember` seed additions (goalId/worktree seed/contextMode).
7. Footer: `SidebarAccountUsagePill` mount (1 line).
8. `SidebarProjectsContent` / `SidebarProjectListRow` plumbing: 1 line each site.
9. Root `Sidebar()`: `useLoomSidebarGoals()` call + roots filter +
   `visibleSidebarThreadKeys` rework (already delegates to the loom logic module).

Every residual gets the `// loom:` marker.

### A.5 Verification

- `vp check`, `vp run typecheck`, `vp test` (web) green; `Sidebar.logic.loom.test.ts`
  passes with the moved tests unchanged.
- Hunk-inventory acceptance per §0.7.
- Manual smoke (dev-verify recipe; seeded workstream gives goals + sub-threads):
  1. Goal groups render with header (chevron, title, task progress `n/m`); collapse
     and expand toggle correctly and Ctrl+N jump numbering follows the visible rows
     (collapsed goals' threads excluded).
  2. A single-thread goal renders compact (thread row stands in); hovering shows the
     new-session pencil; clicking it seeds a goal-scoped draft.
  3. Goal header hover pencil creates a session under the goal; goal context menu
     rename/archive works; delete shows the thread-count confirm and cascades.
  4. Thread context menu: "Create goal from thread" (three prompts) and
     "Assign to goal"/"Clear goal" work.
  5. Sub-threads stay hidden in the list; orchestrator rows show the graph rollup
     badge; staged handoff threads show the "Staged" chip.
  6. Footer shows the account usage pill; "Show more"/"Show less" preview slice and
     its hidden-status dot behave as before.

---

## Slice B — `useLoomThreadExtensions` + chat hooks

### B.1 Outcome

`ChatView.tsx` drops from **+231/−21 across 29 hunks** to roughly **≤18 small
residual hunks / ≤~80 added lines** — almost all 1–3-line mounts, prop insertions
and the deliberate Pi default swaps. Hoisted logic lands in:

- `apps/web/src/loom/useLoomThreadExtensions.ts` — lineage, panel surfaces, tasks auto-open
- `apps/web/src/loom/useLoomThreadActivities.ts` — older-activities pagination
- `createStagedKickoffHandlers` added to the existing fork-owned
  `apps/web/src/components/chat/StagedKickoffCard.tsx`

Wave 1's `apps/web/src/loom/` directory is the home for the new hooks (do NOT move
the existing fork-owned `hooks/useRerouteToasts.ts` / `useSustainedConnectionOutage.ts`
— they are already fork files; relocation is churn with no merge benefit).

### B.2 What moves where

**B.2.1 `useLoomThreadExtensions`** (one hook; inputs
`{ activeThread, activeThreadRef, activeThreadKey }`; calls `useNavigate` itself):

- Thread lineage: `useThreadShells()` + `threadShellById` memo + `threadLineage`
  memo (`buildThreadLineage`/`EMPTY_LINEAGE`) + `navigateToThread` callback.
- Right-panel surfaces: `addTasksSurface` + `addWorkstreamSurface` callbacks.
- Tasks auto-open effect: the `autoOpenedTasksByThreadKey` `useRef` seen-set +
  effect (preserve the eslint-disable and the behaviour comments verbatim — the
  once-per-thread-key semantics are subtle and load-bearing).

Returns `{ threadLineage, navigateToThread, addTasksSurface, addWorkstreamSurface }`.
Residual: one destructuring call line.

**B.2.2 `useLoomThreadActivities`** (inputs `{ activeThread }`): the
`loadThreadActivities` atom command, `loadOlderActivitiesPage` callback, and the
`useOlderThreadActivities` composition. Returns
`{ threadActivities, hasMoreOlderActivities, loadingOlderActivities, loadOlderActivities }`.
Residual: one call line replacing upstream's
`const threadActivities = activeThread?.activities ?? EMPTY_ACTIVITIES;` (marked).
Keep this a separate hook from B.2.1 — different concern, different inputs, and the
activities value feeds upstream derivations (`deriveWorkLogEntries`,
`derivePendingApprovals`) directly below the call site.

**B.2.3 Sustained-outage glue.** The transient-phase test +
`useSustainedConnectionOutage` call + the 3-line `activeEnvironmentUnavailable`
modification move into a wrapper hook `useEnvironmentUnavailability(activeEnvironment)`
exported from the existing `hooks/useSustainedConnectionOutage.ts`, returning the
final boolean. Residual: one call line replacing upstream's 2-line computation
(marked). Move the behaviour comment into the hook.

**B.2.4 Staged-kickoff handlers.** `onLaunchStagedKickoff` / `onEditStagedKickoff`
(~28 lines with their comments) become a plain factory in `StagedKickoffCard.tsx`:

```ts
export const createStagedKickoffHandlers = (deps: {
  getBrief: () => string | undefined;
  promptRef: React.MutableRefObject<string>;
  setDraftPrompt: (target: ScopedThreadRef | DraftId, prompt: string) => void;
  target: ScopedThreadRef | DraftId;
  onSend: () => Promise<void> | void;
  focusComposerAtEnd: () => void;
}) => ({ onLaunch: ..., onEditFirst: ... });
```

Not a hook (no hook calls inside), so it can be created after `onSend` is defined.
The `requestAnimationFrame` focus-ordering comment moves with it. Residual: the
factory call (~6 lines) + the existing JSX mount.

### B.3 Residuals that stay in `ChatView.tsx` (all `// loom:` marked)

- The three `PI_DEFAULT_MODEL` swaps and the import swap (deliberate default change).
- `routeThreadShell`/`routeThreadSyncError` reads + the `ThreadHydratingState`
  early-return branch (modifies upstream's empty-state return).
- `composerDraftPrompt` store subscription (feeds `shouldShowStagedKickoff`).
- The `offerSignIn` banner variant (modifies upstream's Reconnect button JSX inline).
- `useRerouteToasts(...)` mount (1 line).
- `envMode` default change (`derivedEnvMode` → `settings.defaultThreadEnvMode`).
- Two `goalId: activeThread.goalId ?? null` optimistic-update payload lines.
- JSX/prop mounts: `GoalTasksPanel` + `WorkstreamPanel` right-panel branches,
  `StagedKickoffCard` block, `ChatHeader` lineage props (3 lines),
  `MessagesTimeline` pagination props (3 lines), `RightPanelTabs` tasks/workstream
  props (×2 call-sites).
- Import lines for the above (several current import hunks disappear as their only
  consumers move into the hooks).

### B.4 Verification

- `vp check`, `vp run typecheck`, `vp test` (web) green.
- Hunk-inventory acceptance per §0.7.
- Manual smoke (dev-verify recipe):
  1. Open a goal-bound thread → tasks panel auto-opens once; switch to another
     surface, navigate away and back → no re-open clobber.
  2. Workstream and Tasks tabs addable from the right-panel controls; lineage
     breadcrumb renders in the header for a sub-thread and navigates on click.
  3. A long thread offers "load older" and pagination merges seamlessly.
  4. A staged handoff thread shows the kickoff card; **Edit first** seeds the
     composer (card hides, draft survives reload); **Launch** sends the brief
     through the normal send path.
  5. New draft thread defaults to the Pi provider/model.
  6. Sub-thread opened straight from the workstream graph shows the hydrating
     state (not the empty state) until detail arrives.

---

## Slice C — web tidy (runs after Slice A)

Three S-sized items, all fork-owned files except one rename-touched import line.
Sequenced after Slice A because item C2 edits an import line in `Sidebar.tsx`.

**C1 — export `rootOf` from `packages/shared/src/workstreamGraph.ts`.** The private
`rootOf(id, index)` becomes exported with the array signature the module's other
helpers use: `rootOf<T extends GraphLineageNode>(id: ThreadId, threads: ReadonlyArray<T>): ThreadId`
(build the index internally, as `childrenOf` does; keep a private index-taking
variant if the existing internal caller at `:415` cares about reuse). Then delete
`WorkstreamPanel.tsx`'s hand-rolled ancestor walk: `selectWorkstreamSubtree`
collapses to `subtreeOf(rootOf(activeThreadId, shells), shells).toSorted(...)`.
Semantics are identical (same visited-guard cycle handling, same dangling-parent
behaviour — verify against the walk being deleted).

**C2 — rename `apps/web/src/lib/workstreamGraph.ts` → `workstreamRollup.ts`.**
Navigability: the file computes sidebar rollups and shadows the name of the shared
graph module. `git mv` (plus its test file if one exists); update the three
importers: `ThreadStatusIndicators.tsx`, `ThreadStatusIndicators.logic.ts`,
`Sidebar.tsx`. Those import lines are already fork residuals, so no new hunks
appear in upstream files.

**C3 — move `FAN_IN_CHIP_STYLES` from `WorkstreamPanel.tsx` into
`lib/workstreamPresentation.ts`.** Both fork-owned; pure navigability (the
presentation module already owns the panel's other style/format helpers).

Verification: `vp check` + `vp run typecheck` + web tests green; smoke: workstream
panel renders the subtree with unchanged fan-in chip styling; sidebar rollup badges
unchanged.

---

## Slice D — `PiTurnRetryPolicy` (runs after Slice E)

### D.1 Intent

`PiDriver.ts` is fork-added (2,250 LOC) — zero upstream merge risk — but its
retry/failover machinery is spread across the session runner: transient-error
regexes, two delay ladders, backend-partner tables, attempt maths inside
`scheduleTurnRetry`, and classification ordering inside `classifyAndHandleError`.
The deepening: extract the **pure decisions** into
`apps/server/src/provider/Drivers/piTurnRetryPolicy.ts`, leaving the driver with
the effectful orchestration (timers, `process.request`, `emit`, session mutation,
health-registry corroboration). Behaviour preservation is the whole game.

### D.2 What moves (pure, verbatim where possible)

- Constants: `T3_RETRY_DELAYS_MS`, `T3_FALLBACK_RETRY_DELAYS_MS`,
  `T3_QUOTA_FAILOVER_DELAY_MS`, `PI_BACKEND_PARTNERS`.
- Regexes: `PI_TRANSIENT_PROVIDER_ERROR_RE`, `PI_NON_RETRYABLE_REQUEST_ERROR_RE`,
  `PI_QUOTA_ERROR_RE` (locate — it lives in the driver or `exhaustionMapping.ts`;
  if the latter, leave it there and import).
- Functions: `piBackendFallbackModel`, `buildPiRetryPrompt`, `formatResetTime`,
  `piRunOutcome` (pure message-shape helpers that belong with the policy).
- **New pure function** `nextRetryStep`, encoding the ladder maths currently inline
  in `scheduleTurnRetry`:

  ```ts
  export interface RetryStep {
    readonly attempt: number;
    readonly delayMs: number;
    /** Set exactly on the first fallback-tier attempt; undefined otherwise. */
    readonly switchToModel?: string;
  }
  /** undefined ⇒ ladder exhausted (or no fallback backend exists) ⇒ terminal failure path. */
  export const nextRetryStep = (
    previousAttempt: number,            // session.retry?.attempt ?? 0
    currentModel: string | undefined,
    availableModels: Iterable<string>,
  ): RetryStep | undefined => ...
  ```

- **New pure function** `classifyPiProviderError(errorMessage)` returning
  `"non_retryable_request" | "quota_shaped" | "transient" | "other"` — the regex
  layer only. The ordering contract (non-retryable → quota → transient → other) is
  documented on the function; the *corroborated* quota branch
  (`transient` + health-registry-exhausted ⇒ quota) stays in the driver because it
  is effectful.

### D.3 What stays in the driver

`scheduleTurnRetry` (now: call `nextRetryStep`, set the timer, mutate
`session.retry`, emit the warning), `dispatchTurnRetry`, `rerouteAndReprompt`,
`settleRetry`, `classifyAndHandleError` (now delegating classification to the
policy), `failTurn`. The `session.retry` state shape does not change.

### D.4 Verification

- `PiDriver.test.ts` already unit-tests `PI_TRANSIENT_PROVIDER_ERROR_RE`,
  `piBackendFallbackModel` and `piRunOutcome` — update the imports for everything
  D.2 moves (including `piRunOutcome`) to the policy module (no re-export shim) and
  keep every assertion identical.
- Add a table test for `nextRetryStep` covering attempts 1..8 against the current
  inline maths: 5 primary steps at `[15,30,45,60,90]s`, fallback step 1 at `15s`
  with `switchToModel` resolved (and `undefined` result when no partner slug
  exists), fallback step 2 at `60s` without a switch, then exhaustion. This is the
  behaviour-preservation pin — write it against the OLD code's observable decisions
  before refactoring if that helps confidence.
- `vp check` + `vp run typecheck` + server tests green. No live smoke is required
  beyond a normal dev-verify turn (the retry paths need provider failures to
  exercise; the tests carry that weight).

---

## Slice E — server smalls

Three S-sized items in disjoint areas (one shared single-line touch on
`PiDriver.ts`, which is why Slice D waits for this slice).

### E1 — `classifyChildWakeFull` extraction (`WorkstreamDispatcher.ts`)

Wave 1's receipt-dedup move landed (sites adopted, `receiptDedup.ts` exists) but
the **optional §A.5 sub-move was not implemented** — the wake loop at
`wakeIdleAndErroredChildren` still derives episode keys and skip reasons inline.
Execute `plans/2026-07-07-loom-deepening-pair.md` **§A.5 as written** (it was
review-approved): a two-phase `classifyChildWakeFull` composing the existing pure
`classifyChildWake`, with the loop body becoming needs → fetch (queries identical
to today's, including the `wasDelivered` lookups) → classify → delivery tail, and
the previously comment-only suppressions (idle-wake-already-surfaced, gate-waiting,
never-errored recovery) becoming assertable skip-reason variants. Unit tests per
that plan's §"4". The existing harness tests in `WorkstreamDispatcher.test.ts`
(90+) must pass unchanged — they are the behaviour pin.

### E2 — MCP scope-resolution dedup

`resolveGoalScope` / `resolveWorkstreamScope` are byte-identical 3× in the
fork-owned `GoalTaskHttp.ts`, `GoalHandoffHttp.ts`, `WorkstreamSpawnHttp.ts`.
**Correction to the campaign brief:** do NOT put the shared helper in
`McpSessionRegistry.ts` — that file is upstream-owned (+24/−28 fork delta already)
and adding fork lines there moves against the campaign. Create fork-owned
`apps/server/src/mcp/httpScope.ts` exporting one
`resolveWorkstreamScope = Effect.fn("McpHttp.resolveWorkstreamScope")(...)`; the
three files import it. **Sanctioned deviation from §0.1:** the Effect span label
unifies from three per-file names to one — telemetry-only, no behavioural change;
call it out in the coder report.

### E3 — `piSessionFiles` seam

`orchestration/threadResolve.ts` re-exports and `orchestration/stallContext.ts`
imports pi session-file mechanics from `provider/Layers/Pi/Cli.ts` — a layering
smell (orchestration reaching into a provider CLI-invocation module). All files
involved are fork-owned. Move `piSessionIdForThread`, `defaultSessionsRoot`,
`resolveSessionFilePath` (~45 lines, verbatim with comments) into new
`apps/server/src/provider/piSessionFiles.ts`. Update all five importers in the same
commit: `threadResolve.ts` (its deliberate public re-export now points at the new
module), `stallContext.ts`, `WorkstreamSpawnHttp.ts`,
`provider/Layers/Pi/SessionIdSanitiser.ts` (imports `piSessionIdForThread` +
`resolveSessionFilePath` from `./Cli.ts`), and `PiDriver.ts` (one import line — the
Slice D dependency). No re-export shim in `Cli.ts` (§0.5). The other same-directory
importers of `Cli.ts` (`RpcProcess.ts`, `OneShotCompletion.ts`) consume only CLI
invocation concerns and are untouched. `Cli.ts` keeps only CLI invocation concerns;
if it uses none of the three internally, it ends with no import from the new module.

### E4 — Verification

`vp check` + `vp run typecheck` green; `WorkstreamDispatcher.test.ts`,
`receiptDedup.test.ts`, MCP HTTP tests, and any `threadResolve`/`stallContext`
tests pass unchanged (plus E1's new classification unit tests). Live smoke via
dev-verify: exercise one goal-task tool call and one workstream spawn through the
MCP HTTP path (proves E2), and open a consult on a cross-worktree thread if the
seed supports it (proves E3's path resolution).

---

## 7. Parallelisation map

```
A (web: Sidebar)            ──┐
B (web: ChatView)           ──┼── independent, run in parallel
E (server smalls)           ──┘
C (web tidy)                ─── blockedBy A   (shares Sidebar.tsx import line)
D (PiTurnRetryPolicy)       ─── blockedBy E   (shares PiDriver.ts import line)
```

File-conflict analysis:

| Slice | Files touched | Overlaps |
|---|---|---|
| A | `Sidebar.tsx`, `Sidebar.logic.ts(+test)`, new `Sidebar.logic.loom.ts(+test)`, new `loom/SidebarGoalThreadList.tsx`, `loom/useLoomSidebarGoals.ts`, `loom/sidebarGoalActions.ts` | C (Sidebar.tsx import) |
| B | `ChatView.tsx`, new `loom/useLoomThreadExtensions.ts`, `loom/useLoomThreadActivities.ts`, `chat/StagedKickoffCard.tsx`, `hooks/useSustainedConnectionOutage.ts` | none |
| C | `packages/shared/src/workstreamGraph.ts`, `WorkstreamPanel.tsx`, `lib/workstreamGraph.ts`→`workstreamRollup.ts` (+ importers `ThreadStatusIndicators.tsx`, `.logic.ts`, `Sidebar.tsx`), `lib/workstreamPresentation.ts` | A (Sidebar.tsx) |
| D | `PiDriver.ts(+test)`, new `provider/Drivers/piTurnRetryPolicy.ts` | E (PiDriver.ts import line) |
| E | `WorkstreamDispatcher.ts(+test)`, `mcp/{GoalTaskHttp,GoalHandoffHttp,WorkstreamSpawnHttp}.ts`, new `mcp/httpScope.ts`, `provider/Layers/Pi/Cli.ts`, `provider/Layers/Pi/SessionIdSanitiser.ts`, new `provider/piSessionFiles.ts`, `orchestration/{threadResolve,stallContext}.ts`, `PiDriver.ts` (1 line) | D (PiDriver.ts) |

A and B both create files under `apps/web/src/loom/` with disjoint names — no
conflict. Nothing in wave 2 touches contracts, decider/projector, or server
composition (wave-1 territory) — no interaction with the landed seams.

## 8. Reconciliation record (campaign-brief residual items vs wave 1)

| # | Item | Status | Disposition |
|---|---|---|---|
| 1 | `classifyChildWakeFull` | **Not landed** — dedup adoption shipped; §A.5 skipped silently by the Move A coder | Slice E1 (design already review-approved in the wave-1 plan) |
| 2 | MCP scope dedup | Not landed (3 identical copies remain) | Slice E2 — with target-file correction (fork-owned module, not upstream `McpSessionRegistry.ts`) |
| 3 | `PiTurnRetryPolicy` | Not landed (bridge coder touched env wiring only) | Slice D |
| 4 | Export `rootOf` / delete panel walk | Not landed (`rootOf` still private, hand-rolled walk remains) | Slice C1 |
| 5 | `piSessionFiles` seam | Not landed | Slice E3 |
| 6 | `lib/workstreamGraph.ts` → `workstreamRollup.ts` | Not landed | Slice C2 |
| 7a | Unify `formatContextPercent`/`formatPercentage` into `lib/contextWindow.ts` | — | **Dropped**: `formatPercentage` is upstream's own code inside upstream `ContextWindowMeter.tsx`, and `lib/contextWindow.ts` is upstream-owned; unification would refactor upstream logic and grow fork deltas in upstream files — the opposite of this campaign. `formatContextPercent` stays in fork-owned `workstreamPresentation.ts` with its "mirrors the chat-header meter" comment. |
| 7b | `FAN_IN_CHIP_STYLES` → `workstreamPresentation.ts` | Not landed | Slice C3 |

## 9. Risks

- **Slice A ordering rework residual.** `buildSidebarProjectThreadOrdering` replaced
  upstream's ordering/pinning `useMemo` wholesale (including removing
  `pinnedCollapsedThread`). That replacement is wave-0 fork behaviour, not this
  slice's doing — Slice A must move rendering only and leave that call-site residual
  exactly as-is. If a coder finds the residual tempting to "simplify", stop: that is
  upstream-entangled behaviour change.
- **Slice B hook extraction and hook-order stability.** The hoisted hooks must be
  called unconditionally at the same component depth (they already are in the inline
  form). The tasks auto-open ref semantics and the staged-kickoff
  focus-after-sync `requestAnimationFrame` are the two subtle behaviours — both move
  with their comments verbatim.
- **Slice D is behaviour-critical.** The ladder table test is mandatory before the
  move is trusted. Any observable difference in retry timing, fallback selection, or
  classification ordering is a defect, not a cleanup.
- **Residual-hunk targets are estimates.** The acceptance check is the §0.7
  inventory match, not the raw count; coders justify any inventory deviation in
  their report rather than force-fitting.
