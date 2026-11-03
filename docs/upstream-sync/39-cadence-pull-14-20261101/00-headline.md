## 0. Headline

Pull 14 is **a routine-shaped pull with one structural seam.** Upstream has
shipped **1,374 commits** since pull 13's target `b76a110aa4` (3,763 files,
+276k/−83k; 778 added, 131 deleted, 14 renamed), and the trial merge gives
**123 conflicted paths / 299 conflict markers** (121 content, 2 upstream
deleted a Loom-edited file). More commits than pull 13's 1,238 but a quarter
of its deletions: upstream ran no test prune and no module split this week, so
the hunks are small and local (254 of 299 are "content" hunks where both sides
edited the same lines; the giant Loom-side regions that made pull 13 a Rule D
pull are down to six A hunks, all of them upstream deletions, §7.1). Loom's `origin/main` moved 51 PRs (#446–#508) since
pull 13 landed, most of them the comprehensive audit's deletions, and the
branch starts from the build that is live on the cockpit (`fe75bb6833`).

What makes it more than routine, in order of how much work each costs:

1. **The cold shell is now built from an index, and Loom's badge rule is not
   in it (§4).** Upstream #27106 ("sidebar shell loads 3x faster") stopped
   trimming the shell after reading every row: a client that opts out of idle
   children and older settled roots now gets a lightweight index
   (`listActiveShellIndex`, one SQL row per thread with a `may_be_live` bit),
   the trims pick the ids to keep from that index, and only those shells are
   read and decoded. Pull 13's `keepsLoomChildInColdShell` (DL-1404/DL-1453)
   runs on decoded shells, so after this merge it would see no idle Loom
   child to keep: a root whose child finished holding `needs_guidance` would
   show no Loom badge until its family loads, which is exactly what pull 13
   fixed. The fix is pre-ruled (§8.2): one marked sidecar join in the index
   SQL and one marked clause in `shellSubscriberThreadIds`. It is S2a's main
   piece and Gate 2a's main read.
2. **Upstream renamed and merged MCP tools (#25423) and one Loom list names a
   dead one (§5).** `update_scheduled_task` was folded into `schedule_task`
   (pass `scheduledTaskId` to update); Loom's `SCHEDULING` family in
   `families.ts` still names it, `families.test.ts` asserts every SCHEDULING
   name exists, and `registration.test.ts` calls it. Nothing leaks: the
   withheld list is built from upstream's toolkit exports, so the three new
   `t3_environment_*` tools and the merged `preview_act`, `t3_queue`,
   `t3_pending_request`, `t3_thread_transfer` are withheld by construction.
   No role file or skill names a renamed tool, so no model-read text changes.
3. **Side chats (#26901) land beside Loom's side-thread class (#501): different
   features that share three files (§6.2).** Upstream's side chat is a
   `lineage.sideChat` fork with its own right-panel pane, `/side` and `/btw`,
   and "Bring back"; Loom's side thread is a presentation rule over the
   workstream sidecar (`role` + `forkFromThreadId`) for query threads and
   `/handoff` drafters. They collide in `Sidebar.logic.ts`,
   `CommandPalette.logic.ts` and `useComposerMenuItems.ts` as unions, not as
   the same feature. Whether Loom's query threads should later ride upstream's
   side-chat lineage is a follow-up, not merge work (§8.3).
4. **Every React effect now states its reason (#26161) and 22 Effect
   diagnostics became errors (§6.8).** `scripts/effect-budget.json` is gone
   (one of the two UD files) and `t3code/no-unreasoned-state-sync` requires a
   reasoned `oxlint-disable-next-line` above every `useEffect`: 54 effects in
   37 Loom-only files plus 2 Loom-added effects in shared files need a reason
   line each; upstream wrote 505 of its own. tsc-rs now enforces
   `effectFnOpportunity`, `preferSucceedSomeOrNone` and twenty more
   `@effect/language-service` diagnostics at `error`; grep finds few Loom
   candidates, the first `vp run typecheck` gives the count. About fourteen
   oxlint rules are newly at error (`react/purity` and the other `react/*`
   rules, `eslint/no-unused-vars`, `no-inline-schema-compile`, …); the first
   `vp check` gives the count.
5. **Dead-code deletion (#26238, 876 files) is behind 54 of the 123 conflicts
   and both UD files (§6.3).** Where git shows a large Loom-side region
   against nothing (`ProjectionStore.ts`'s 914-line `layerMemory`,
   `providerRuntime.ts`'s 921 lines of V1 runtime schemas,
   `TimelineV2EventRow.tsx`'s 84, `CommandPalette.tsx`'s 130) the region is
   upstream's deleted code with one Loom comment inside it: take the deletion
   and keep only Loom's own lines. One such hunk is not a deletion but a
   hoist: upstream moved the `ask_user_question` answer validation above the
   event emission and now accepts multi-select itself, so Loom's
   `loomAskAnswer` is superseded and only `loomAskTakesAnswer` (a live waiter
   takes the answer as its tool result) is re-homed (§6.1). No Loom-only file
   consumes any of the 53 `lost-ours` names except
   `ThreadSettlementService.layer` (one Loom test) and `encodeScanCache` (one
   Loom test hunk).
6. **Toolchain unchanged.** Node 26.12.1, pnpm 12.14.0, Effect 4.0.5, React
   19.3.0, `@tsc-rs/typescript` 0.8.0 and Vite+ 1.4.0 are the same on both
   sides, so there is no host or VM change and no bridge check this pull.
   Electron 44.9.3 → 44.10.0; `alchemy` and `@distilled.cloud` bumps are
   relay infrastructure.

**What Carl will see change on deploy** (no ruling needed, but he should know
before approving):

- **The new design is the only design** (#25778). Pull 13 shipped it as an
  off-by-default client beta (`redesignEnabled`); the toggle is gone and every
  surface uses it. S4's visual pass covers Loom's chips, MDX plan, workstream
  panel and graph on it.
- **Side chats** (§5.3, §8.1): `/side`, `/btw`, a **Side chat** entry in the
  right panel's **+** menu, a "Side chats" row in thread details, a row above
  the mobile composer.
- **Stop always completes, and Force stop appears** when an agent ignores a
  stop (#27252, §6.1).
- **Thread state moves to the end of the timeline** instead of stacking on the
  composer (#25401); "Loading messages…" and Loom's sync-error diagnostic go
  with it (Appendix D).
- **Long threads load in pages** as you scroll up (#26240).
- **Settings regrouped by concern** (#25651), **projects can be pinned and
  archived** (#26154), **Linked environments** appears as a Labs toggle, off
  (§5.2).

Carl decides nothing before S1 starts (§8.1 has one row whose recommended
answer is doctrine and applies unless he says otherwise). Everything else is
pre-ruled here (§8.2) or follows doctrine.
