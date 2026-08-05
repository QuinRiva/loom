# 23 — Sidebar v2 re-home: loom's navigation moves onto upstream's inbox

The decision record for the next cadence pull. Loom's goal/workstream sidebar
has moved off its own goal-nested project tree (v1 + fork) and onto **upstream's
Sidebar v2** — the flat thread inbox with settled/snoozed shelves. V2 is now
loom's **default** surface; v1 survives only as an escape-hatch setting and as
the host of the settings nav. The thread-nesting machinery that made the fork
expensive is **deleted**, deliberately, and must not be restored by a merge.

Read this before resolving any sidebar, settings, or `orchestration.loom.ts`
conflict. Australian English.

## Headline

- **Direction:** adopt upstream v2 wholesale; attach loom's affordances at v2's
  frozen data seams; drop goal-nested thread lists from the sidebar entirely;
  keep durable goals, re-homed on a thread-anchored **Goal panel**.
- **Why it is safe to attach here:** across the 147 upstream commits between our
  merge-base and the last pull, v2's data contracts (row props, list partition,
  the `latestTurnDiff` stub) did not change by a byte while ~75% of its render
  JSX was rewritten. Loom therefore attaches at the contracts, never inside the
  render tree.
- **Five change-sets landed** (all gates green at each): quick wins `89c2abef3`,
  settle semantics `9ed6b9e4c`, chain schema `61ee97353`, goal chip + panel
  `fef9b8443`, and this final package (default flip + deletions + this record).
- **Net −770 lines** across the final package: the deletions are the point, not
  a side-effect.
- The full design, the option study, and the human's decisions live in
  `plans/sidebar-v2-rehome/plan.mdx`. This document is the merge-facing digest.

## A. The decision, and the alternatives that lost

A goal is **never navigated to directly**. A goal is reached _through a thread
that carries it_, and exists to track a larger piece of work — its tasks, and
its handoff chain when the work outgrows one thread's context. Everything below
follows from that.

Three candidate surfaces were designed and mocked:

- **A — thread-anchored chip + popover.** Goal affordances only in a popover off
  a chat-header chip. Rejected as the end-state: cramming the task tree, the
  chain, and CRUD into a popover duplicates what the existing `GoalTasksPanel`
  right-panel already hosts. The chip survives, as the panel's entry point.
- **B-with-switcher — goal panel with a browsable goals list.** A goal-switcher
  dropdown doubling as a per-project goals list, plus ex-nihilo "New goal…".
  **Rejected by the human**: you never select a goal by itself; a goal has no
  standalone interactability, so a goals list is navigation to nowhere. It also
  introduced a panel-goal-versus-open-thread divergence state for no benefit.
- **C — goals in the sidebar chrome.** A browsable goals pane. Rejected for the
  same reason plus the most new scope; loom already retired a thread-less goal
  landing once as a dead end (`_chat.index.tsx` records why).

**What was built:** A's anchoring with B's surface — a goal chip on the chat
header (`◎ goal title · N threads`) that toggles a Goal panel _always anchored
to the open thread's goal_. No goal switcher, no goal browsing, no standalone
goal surface anywhere.

**Rejected direction, recorded so nobody re-proposes it:** goal grouping or tree
drill-ins _inside_ the v2 list. That rebuilds the nesting the human dropped, in
the one region upstream rewrote 75% of in nine days.

## B. What landed where

| Change-set               | Commit       | Seam                                                                                | Convention                                                                                       |
| ------------------------ | ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Quick wins               | `89c2abef3`  | v2 list partition, row props, `resolveSidebarV2Status`, `sidebar/SidebarChrome.tsx` | `// loom:` marked additive hunks inside upstream files                                           |
| Settle semantics         | `9ed6b9e4c`  | `packages/client-runtime/src/state/threadSettled.ts`                                | `// loom:` marked additive blocks (blockers + one trigger); precedence amended post-ship, see §I |
| Chain schema             | `61ee97353`  | Migration 1035, `orchestration.loom.ts`, `GoalHandoffHttp.ts`                       | loom-owned files + loom migration lane (1001+)                                                   |
| Goal chip + panel        | `fef9b8443`  | `apps/web/src/loom/*`, `GoalTasksPanel.tsx`                                         | loom-owned modules, one marked mount point                                                       |
| Default flip + deletions | this package | `useSettings.ts`, `Sidebar.tsx`, contracts settings                                 | see §C, §D                                                                                       |

Conventions used throughout, unchanged from previous cycles:

- Anything loom adds inside an upstream-owned file carries a `// loom:` marker
  on the hunk, so a conflict resolver can see intent without archaeology.
- Anything loom owns outright lives in `apps/web/src/loom/`, `*.loom.ts`, or the
  loom migration lane (`1001+`, `LoomMigrations.ts`); upstream's `Migrations.ts`
  stays byte-identical.
- Loom never edits upstream _test_ files to accommodate a fork field — the
  contract is fixed instead (see §E).

## C. The default flip, and how it reconciles with upstream `c13a021e4`

**Mechanism.** `useSidebarV2Enabled()` in `apps/web/src/hooks/useSettings.ts` is
now the single resolver; `AppSidebarLayout.tsx`, `_chat.tsx` and
`BetaSettingsPanel.tsx` all read through it and none reads
`settings.sidebarV2Enabled` directly. It resolves:

```ts
settings.sidebarV2ConfiguredByUser ? settings.sidebarV2Enabled : true;
```

**The settings-blob trap, and why we pre-adopted upstream's bit.** Loom's client
settings persist as a **whole blob** (`t3code:client-settings:v1`, verified live
at 21 keys after touching a single unrelated setting). Every user who has ever
changed any setting therefore already has `sidebarV2Enabled: false` stored
without ever having touched that toggle — flipping the schema default alone
would have reached nobody. Distinguishing "stored false" from "left alone"
requires a companion bit, so loom added
**`sidebarV2ConfiguredByUser`** — deliberately the _same field name, default,
semantics and comment_ as upstream's unmerged `c13a021e4`, written only by the
Settings → Beta toggle. Choosing an identical shape means the contracts hunks
and the three call-site hunks are **byte-identical on both sides** and merge
without conflict.

**Reconciliation plan for the next cadence pull.** `c13a021e4` ("default sidebar
v2 on for nightly and dev builds") will arrive with:

1. `packages/contracts/src/settings.ts` — adds `sidebarV2ConfiguredByUser` to
   `ClientSettingsSchema` and `ClientSettingsPatch`. **The added text is
   byte-identical to ours, five-line explanatory comment included** — that
   comment is upstream's own, copied deliberately from `c13a021e4` so the hunk
   coincides rather than conflicts (verified by diffing the field's context
   window against `c13a021e4:packages/contracts/src/settings.ts`). Git should
   merge it silently; if a wider context window still reports a conflict (loom
   has its own fields elsewhere in the same struct), take either side — the
   added lines are the same text.
2. `apps/desktop/src/settings/DesktopClientSettings.test.ts` — adds
   `sidebarV2ConfiguredByUser: false` to the literal. **Identical to ours.**
3. `apps/web/src/components/AppSidebarLayout.tsx`, `routes/_chat.tsx`,
   `settings/BetaSettingsPanel.tsx` — switch to `useSidebarV2Enabled()` and pin
   the choice on toggle. **Identical to ours.**
4. `apps/web/src/branding.logic.ts` + `branding.test.ts` — **new** upstream code:
   `resolveSidebarV2Default(stageLabel)` (on for `nightly`/`dev`, off otherwise)
   and `resolveSidebarV2Enabled({enabled, configuredByUser, settingsHydrated,
stageLabel})`. Lands clean (new functions, no loom code there).
5. `apps/web/src/hooks/useSettings.ts` — upstream's `useSidebarV2Enabled()` body
   delegates to `resolveSidebarV2Enabled`. **This is the one real conflict.**

   **Resolution: keep loom's universal default.** The correct merge is to adopt
   upstream's `resolveSidebarV2Enabled` _call shape_ if desired, but make the
   default loom-universal — i.e. a `// loom:` marked
   `resolveSidebarV2Default()` that returns `true` for every stage, or simply
   keep loom's two-line body. Loom's flip is **not** channel-derived: v2 is the
   product decision for all loom builds, deployed cockpit included. Do **not**
   let the stage-derived default through, or the deployed cockpit silently
   reverts to v1 and takes the goal panel's only sane sidebar with it.

   Note one further deliberate divergence: upstream holds **v1** while client
   settings hydrate (its default is off, so that is where both paths start).
   Loom does **not** — our pre-hydration snapshot resolves to v2, which is where
   all but explicitly opted-out users end up, so the common path never remounts
   the tree. If upstream's `settingsHydrated` guard is adopted verbatim, every
   loom page load flashes v1 first. Keep it out.

The human accepted the dev/deployed split posture as interim dogfooding while
milestones 1–5 were in flight; that window is now closed — the flip is
universal, so the split no longer applies.

**Mobile is out of scope.** `apps/mobile`'s `threadListV2Enabled` is a separate
device-local preference with no client-settings sync; loom has not re-homed the
mobile thread list, so upstream's mobile half of `c13a021e4` (the new
`use-thread-list-v2-enabled.ts` hook, `resolveThreadListV2Enabled`) merges as
plain upstream code. Take it as-is.

**Live evidence.** A fresh profile on a seeded dev instance landed on v2 with no
setting written (children hidden, roll-up badge, goal chip + panel, settled
shelf). Toggling Settings → Beta off wrote `{sidebarV2Enabled: false,
sidebarV2ConfiguredByUser: true}` and yielded a functional flat v1 that survived
a reload. Deleting only the companion bit from the persisted blob (the exact
shape of a legacy user) put the browser back on v2 — the trap is handled.

## D. What was deliberately deleted (do not let a merge restore it)

The goal surface no longer depends on sidebar nesting, so the nesting machinery
went. If a future merge reintroduces any of the following, it is a mistake:

- **`apps/web/src/loom/SidebarGoalThreadList.tsx`** (172 lines) — the goal-header
  - grouped-subtree renderer. Deleted.
- **`apps/web/src/loom/sidebarUiStore.ts`** and its test — goal-collapse
  persistence. Deleted. See §F for the orphaned key.
- **`apps/web/src/components/Sidebar.logic.loom.ts`** — the goal-ordering and
  jump-map alignment machinery (`buildSidebarGoalOrderedEntries`,
  `buildSidebarProjectThreadOrdering`, `flattenSidebarOrderedThreads`,
  `isCompactSingleThreadGoal`, the entry-walking preview budget) and its test
  file. The module shrank 235 → 53 lines and now holds exactly three live
  helpers: **`resolveGoalWorktreeSeed`** (the Goal panel's "new session under
  this goal" keeps its top seed precedence — it is what makes a handoff
  successor land in its predecessor's worktree), **`isStagedHandoffThread`** (v2
  row badge + the panel's Threads section). `isVisibleHandoffDrafter` moved back
  to its real home, `apps/web/src/lib/handoffDrafter.ts`.
- **`apps/web/src/loom/useLoomSidebarGoals.ts`** → renamed
  **`apps/web/src/loom/rootThreads.ts`**, holding only `filterRootThreads`.
  `goalsForProject`, `SidebarLoomGoals` and the `useLoomSidebarGoals` hook died
  with the nesting.
- **`useLoomSidebarGoalActions`** in `apps/web/src/loom/sidebarGoalActions.ts` —
  the v1 goal-header context menu. The panel's overflow menu owns goal CRUD now
  (via `useGoalCrudActions`); the v2 row context menu owns create/assign (via
  `buildGoalMenuItems` + `useLoomThreadGoalActions`).
- **Loom's inline sidebar-chrome fork** (`Sidebar.tsx` ~2895–3010:
  `SidebarChromeHeader`, `SidebarBrand`, `T3Wordmark`, `useSidebarStageLabel`,
  `SidebarChromeFooter`). v1 now imports upstream's
  `components/sidebar/SidebarChrome.tsx` — the same module v2 uses, already
  carrying loom's usage pill since the quick wins. **This kills a perennial
  merge-conflict site** (marker-less trap #1 of cycle 21). Do not re-fork it.
- **v1's goal rendering and goal context-menu entries** in `Sidebar.tsx`. v1 is
  now a clean flat per-project list, upstream-shaped: upstream's
  `visibleProjectThreads` / `pinnedCollapsedThread` / `renderedThreads` blocks
  and its jump-map block were **restored verbatim**, so those regions merge as
  no-ops from here on. Only two marked lines remain inside them — the
  `isVisibleHandoffDrafter` filter at each of the two sites — plus the roll-up
  badge lookup on the row map. Measured effect: loom's `Sidebar.tsx` fork
  against upstream `5719e8ac4` fell from **45 hunks to 28**.

> **⚠️ This supersedes a standing entry on the carried-forward Pi-only drop
> list.** `pinnedCollapsedThread` — the upstream convenience that keeps the
> active thread visible while its project is collapsed — is named as a
> deliberate fork drop in the "Intentional prior drops — NOT 'fixed' here"
> section carried through
> [docs 18](18-cadence-pull-v0.0.29-nightly-20260709.md),
> [19](19-cadence-pull-v0.0.29-nightly-20260713.md),
> [20](20-cadence-pull-v0.0.29-nightly-20260719.md) and
> [21](21-cadence-pull-v0.0.29-nightly-20260725.md), and as
> an "intentional drop / known minor" in
> [docs 14](14-final-review.md) and [15](15-final-quality-review.md).
> **That entry is now void: `pinnedCollapsedThread` is restored and v1 is
> upstream-shaped here. Drop it from the Pi-only list at the next cadence
> pull.**
>
> The original justification is what expired, not just the outcome.
> [Doc 11](11-review-2.5b.md) upheld the drop because restoring it "onto the Pi
> goal-grouping model (where the active thread can sit inside a collapsed goal
> _within_ a collapsed project) has ambiguous semantics". **Goal grouping no
> longer exists** — v1 is a flat per-project list — so the ambiguity that
> justified the drop is gone with it, and the upstream behaviour is now simply
> correct. Verified benign against loom's paths: `pinnedCollapsedThread`
> operates only over the flat `filterRootThreads` root list and touches no goal
> path.
>
> A cadence agent that inherits the stale list and "preserves fork behaviour" by
> re-dropping it would re-fork the exact block this section promises will merge
> as a no-op. Do not.

**Deliberately NOT adopted:**

- Goal grouping, goal headers, or tree drill-ins inside the v2 list (§A).
- A goals list, goal switcher, or any goal route. The panel is anchored to the
  open thread's goal, full stop.
- Upstream's stage-derived sidebar default (§C).
- Upstream's pre-hydration v1 hold (§C).
- Task editing in the panel — tasks stay agent-written.
- `WorkstreamPanel` / `WorkstreamGraph` — ChatView-side, untouched by this
  re-home.

## E. Contract fix: `goalId` decodes with a default

`packages/contracts/src/orchestration.test.ts > "defaults settled fields when
decoding historical thread data"` was failing on the sidebar-v2 branch:
upstream's test literal (cycle-21 commit `f795ab6a8`) omits `goalId`, which
loom's `LoomThreadFields` required.

**Fixed on the contract, not the test.** `goalId` is now
`Schema.NullOr(GoalId).pipe(Schema.withDecodingDefault(Effect.succeed(null)))`
— the idiom every _other_ field in `LoomThreadFields` already uses (and the one
upstream uses for `settledOverride`/`settledAt` in the same schema). `goalId`
predates that convention (Migration 1003) and was simply never brought into
line. Thread payloads written before goals existed carry no `goalId`, and an
absent key means exactly "no goal", so the permissive decode is also the
_correct_ one.

The alternative — loom-marking upstream's test literal — was rejected: it puts a
fork marker in an upstream-owned test file, so every future upstream edit to
that literal conflicts, and it leaves the underlying inconsistency in place.
**Rule of thumb for future cycles: when an upstream test fails because a loom
field is required, fix the field, not the test.**

## F. Orphaned localStorage key

Per the "Orphan keys: no automatic sweep (by design)" convention in
[`docs/architecture/loom-ui-state-tiers.md`](../architecture/loom-ui-state-tiers.md):
deleting `sidebarUiStore.ts` leaves **`t3code:loom-sidebar-ui-state:v1`**
stranded in every existing user's `localStorage`. It is inert — nothing reads it
— and it is a few hundred bytes at most, so there is **no sweep**. Recorded here
so a future reader who finds the key knows it is dead, not broken. Do not
resurrect the key name for anything else.

## G. v1's residual role, and its expected end

`Sidebar.tsx` (v1) is **not** deleted, for one reason: it owns the settings nav.
`AppSidebarLayout.tsx` keeps v1 mounted on `/settings` and `/settings/*`
regardless of the flag, and that wiring is unchanged. v1 also remains the target
of the Settings → Beta escape hatch, and it is functional — verified live.

Upstream has an unmerged branch that **deletes v1 outright**
(`sidebar-v2-only`). When it arrives:

1. Take the deletion. Loom's residual hunks in `Sidebar.tsx` are now only the
   three marked lines in §D plus the thread-tabs `openTab` call — nothing worth
   preserving that v2 does not already do.
2. Re-home `SettingsSidebarNav` first, or the settings route loses its nav.
   That is the _only_ blocker, and it is mechanical.
3. Delete the `sidebarV2Enabled` / `sidebarV2ConfiguredByUser` settings pair and
   `useSidebarV2Enabled()` with it.

## H. Breaking change carried in this cycle: `handoff_count` → `handoff_destinations`

Recorded here because a cadence resolver will meet it in the projections.
Migration 1035 (`61ee97353`) **replaced** the `handoff_count` counter with
`handoff_destinations` (JSON `[{goalId, threadId}]`) on `projection_threads`,
and added `continues_thread_id` (nullable, mirroring the `fork_from_thread_id`
precedent of Migration 1023).

This is a **clean break with no compat shim** — prototype policy, and the
counter was a lossy projection of a destination list the
`thread.handoff-recorded` event already carried. Every read site moved to
`handoffDestinations` (`.length` where a count was wanted). If a merge
reintroduces `handoffCount` anywhere, delete it rather than reconciling the two.

## I. Post-ship live-use deviations (three fixes after PR #171)

Three defects surfaced within a day of dogfooding v2 as the default. All three
are behaviour changes **against upstream's v2**, so they are listed here with
their revert paths, not just as bug fixes.

### I1. Active rows sort by last activity, not `createdAt` — PROVISIONAL

> **Status: provisional, revisit deliberately.** Upstream's creation order is
> not a mistake, and it may be the better long-term default here too. This
> deviation is a response to present conditions, not a verdict — see "Why now,
> and what would prompt revisiting" below.

Upstream's `sortThreadsForSidebarV2` orders the active block by `createdAt`
descending, deliberately: a row holds its position from open until settled, so
the screen never jumps. But the row _labels_ activity age
(`threadTimeLabel`), so **the list is sorted by a value it never displays** —
and the timestamp column reads as random. Confirmed against the live cockpit DB:
root threads at creation-age 4.94d / 5.03d / 5.93d carried last-activity ages of
1.01d / 0.5d / 0.04d, so a thread answered an hour ago sat eleven rows below one
answered four days ago.

**Loom sorts the active block by last activity, most recent first**
(`sortActiveThreadsByActivityForSidebarV2` in `apps/web/src/components/Sidebar.logic.ts`),
because loom's sidebar is an orchestration inbox where "what moved" is the
question. Upstream's function is left **intact and unused** beside it, and the
label now reads the same resolver (`resolveActivityTimestamp` — extracted from
`resolveSettledTimestamp`, so settled rows are unchanged), which makes
label/order disagreement structurally impossible.

**Why now, and what would prompt revisiting.** Upstream's no-jump property — a
row holding its position from open until settled, so the screen never moves
under the pointer — is a genuine virtue, and it is worth more the shorter the
list is. It is worth less right now: loom's active block is clogged with stale
unsettled threads carried over from before the workstream-settle migration, and
with a backlog that noisy "what moved" is the only question the list can
usefully answer — creation order buries the one thread that just came back
eleven rows down. **Revisit once the migration has fully landed and the backlog
is cleaned up.** If the active block is small enough to read at a glance by
then, prefer upstream's stability and drop this deviation; the two functions
sitting side by side keep that a one-line choice rather than a rewrite.

- **Revert** = call `sortThreadsForSidebarV2` again at the one call site in
  `SidebarV2.tsx` (`activeThreads:`). Point `threadTimeLabel` at whatever the
  sort keys on so the two still agree — for creation order that means labelling
  `createdAt`, **not** restoring the old `latestUserMessageAt ?? updatedAt`
  label, which is the sort/label mismatch that caused this defect.
- **Known divergence:** `apps/mobile/src/features/threads/threadListV2.ts`
  still mirrors upstream's creation order (`sortThreadsForListV2`). Web and
  mobile now disagree; unify when mobile's v2 list is next touched.

### I2. `SidebarContent` renders visible scrollbars

The thread list had no visible thumb. Cause: `SidebarContent`
(`apps/web/src/components/ui/sidebar.tsx`) wrapped its content in
`<ScrollArea hideScrollbars>`, which both suppresses the base-ui overlay
scrollbar _and_ sets `scrollbar-width: none` on the viewport — **and that
viewport is the element the thread list actually scrolls** (v2's own
`overflow-y-auto` `SidebarGroup` never becomes the scroller). Because
`scrollbar-width` is an inherited property, no descendant could reinstate a
scrollbar either.

Fix: drop `hideScrollbars`, so the sidebar gets the same base-ui overlay thumb
every other long panel in the app uses (idle-transparent, fading in while
hovering or scrolling). Verified in both themes at 760px with a 22-row list.
**Revert** = restore the `hideScrollbars` prop. Note this also affects v1 and
the settings nav, which share `SidebarContent`.

### I3. The rollup popover footer is a real button

The footer of the workstream rollup badge popover read
`"N sub-threads · open row → Workstream panel"` — instructional prose styled
like an action, which did nothing. It is now a button that opens the
`WorkstreamPanel` for that root: `useRightPanelStore.open(threadRef, "workstream")`
(the same thread-scoped surface store `ChatView`'s own openers and the
workstream-participant auto-open use) followed by navigation to the thread, so
it works from any row, not just the active one. `WorkstreamGraphIndicator` takes
a `threadRef` prop for this; the action-node case keeps its "Click a sub-thread
to open it" hint.

## J. Settle precedence, amended: an explicit settle outranks loom's plan blockers

**The regression.** As shipped in `9ed6b9e4c`, loom's three never-settle
blockers (any `attention` entry, `planLane === "yielded"`, any non-terminal
descendant) were applied _alongside_ upstream's activity blockers, i.e. **above**
the `settledOverride === "settled"` check. Server-side `thread.settle` rejects on
none of those conditions, so the command succeeded, stamped the override, and the
client classifier ignored it: **the user clicked Settle and the row did not
move.** Abandoned orchestrations — children left `ready`/`planned`, or a stale
stored `needs_guidance` — became permanently unclearable, where before the
re-home they simply auto-settled on inactivity.

**The split.** Upstream's blockers outrank an explicit settle because they
describe **live runtime**: a running session genuinely is active, and the block
clears itself when the runtime does. Loom's describe **plan state**, which can
stay stale indefinitely with only a human to clear it. Same mechanism, different
character — so the two are now ranked separately in `effectiveSettled`:

| Signal                                                       | Kind         | Blocks auto-settle | Outranks explicit settle |
| ------------------------------------------------------------ | ------------ | ------------------ | ------------------------ |
| pending approval / user input, live session, queued turn     | live runtime | yes                | **yes** (upstream)       |
| attention `awaiting_approval` / `awaiting_input`             | derived      | yes                | **yes**                  |
| attention `error` / `awaiting_acceptance` / `needs_guidance` | stored plan  | yes                | no                       |
| `planLane === "yielded"`                                     | plan         | yes                | no                       |
| non-terminal descendant                                      | plan         | yes                | no                       |

The derived attention reasons are never stored — they are unioned in from the
open approval/input request set — so they mirror the upstream flags checked one
line above them; keeping them ranked as live is deliberate redundancy against a
drift between the two derivations, not a second policy.

**Auto-settle protection is unchanged**, which was the whole point of
`9ed6b9e4c`: an attention-flagged, `yielded`, or still-orchestrating thread never
auto-settles into the shelf on inactivity or a merged PR. Only the user's own
Settle now clears it. `canSettle` deliberately does **not** consult the
workstream context (an abandoned graph must stay a legal settle target), and the
finished-work trigger is untouched: it fires only in the no-override case, so it
never competes with an override in either direction.

**Nothing is hidden by the override.** The server un-settles on real activity —
`thread.turn.start`, a session going `starting`/`running`, an approval or
user-input request — regardless of the override. A settled root whose subtree
later has news is therefore re-opened by the dispatcher's parent wake, which
arrives as a turn start on the root itself (`decider.ts`, `thread.turn.start`
lifecycle reset). A _stale_ flag, by contrast, generates no activity and stays
settled: exactly the wanted asymmetry.

Code: `workstreamAutoSettleBlocked` (renamed from `workstreamSettleBlocked` —
the old name asserted the precedence that was the bug) plus
`workstreamLiveAttentionBlocked`, both in
[`packages/client-runtime/src/state/threadSettled.ts`](../../packages/client-runtime/src/state/threadSettled.ts);
both directions are pinned by tests in `threadSettled.test.ts`.

One consequence beyond the abandoned case, accepted deliberately: a root whose
children are **genuinely still running** can now be settled by hand, which
removes the only inbox row representing that subtree until the dispatcher's next
parent wake re-opens it. That is the requested semantics ("I am done with this"),
the window is bounded by the child's turn, and the row carries its rollup badge
while active — but it is the price of making abandoned graphs clearable.
