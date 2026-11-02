## 4. The cold shell is built from an index, and Loom's keep rule must follow

### 4.1 What upstream changed (#27106, 8bf4822f5e)

Before this week (pull 13 §6.2), `ShellStream.ts` read every active shell,
joined Loom's sidecar fields, then filtered: `omitIdleSubagentShells` dropped a
subagent child unless it was live or a parent, and `omitOlderSettledShells`
dropped settled roots older than the 25th newest. Loom's
`keepsLoomChildInColdShell(thread, roots)` (`loom/projection/loomShellJoin.ts`)
is called inside both filters (DL-1453) and keeps a child whose root is
unarchived and unsettled, or that holds stored attention, or that failed with
a classed error, or that is an un-started unheld child; `inLiveLoomGoal` keeps
an older settled root of a live goal.

Now (`ShellStream.ts` at `fa31b66bbb`, `loadSubscriberShellSnapshot`):

1. When the subscriber opts in to either trim, the server first reads
   `listShellIndex` = `ProjectionStore.listActiveShellIndex()`: one SQL row
   per active thread with `lineage`, `settledOverride`, `settledAt`,
   `pinnedAt`, `snoozedUntil` and a `may_be_live` bit computed by five
   `EXISTS` subqueries (live run, pending runtime request, unfinished
   command/tool/subagent item, waiting `link_request`, pending background
   tasks, a watched PR).
2. `shellSubscriberThreadIds(index, options)` picks the ids a trimmed snapshot
   can contain: a subagent entry only if `mayBeLive` or a parent of a kept
   child; a top-level entry unless it is older-settled and not pinned, snoozed,
   live or an ancestor.
3. Only those shells are read and decoded (`readThreads(ids)` →
   `Orchestrator.readShellSnapshot`, which still carries Loom's
   `joinLoomShellFields`).
4. `trimShellSnapshot` then applies `omitIdleSubagentShellsWith` and
   `omitOlderSettledShellsWith` on the decoded shells with facts
   (`shellTrimFacts`) computed from the index.

Both call sites (`ws.ts` `subscribeShell`, `orchestration-v2/http.ts` the
HTTP shell) use the new path. The trial merge's two `ShellStream.ts` conflicts
are Loom's two marked `||`s and `inLiveLoomGoal` on the old function bodies
against upstream's new `…With` shape.

### 4.2 What Loom loses without a change

A Loom child that finished its turn holding `needs_guidance`,
`awaiting_acceptance` or `error` has no live run, no pending runtime request,
no unfinished item and no background task, so its index entry is
`mayBeLive: false` and step 2 drops its id. Step 3 never reads it, so step 4's
`keepsLoomChildInColdShell` never sees it. Likewise every finished child of an
active root (DL-1404's clause (i)) and every older settled root of a live goal.
The sidebar badge of an active root with finished children under-counts, a
flagged child's `!` is missing until something opens the family, and the goal
panel loses its older sessions. At measurement the cockpit had 34 sidecar rows
with stored attention, 494 active rows with no outcome and 5,139 subagent
threads; the roots affected are the ones Carl looks at most (active
workstreams).

The on-demand reads are unaffected: `getThreadFamily`, `getOlderSettledThreads`
and search rows still go through the joined `readShellSnapshot`.

### 4.3 The fix (pre-ruled, §8.2)

Keep the index path (it is the point of #27106) and teach the index about
Loom's rows:

- **`ProjectionStore.listActiveShellIndex`** gains, behind `// loom:`, a `LEFT
  JOIN loom_thread_workstream w ON w.thread_id = t.thread_id` and two
  columns: `loom_keep` = `w.attention <> '[]' OR w.outcome IS NULL`, and
  `loom_goal_id` = `w.goal_id`. The index step only has to be a **superset** of
  what the trims keep (upstream's own doc comment on
  `shellSubscriberThreadIds`), so the SQL stays coarse (494 active sidecar
  rows have no outcome at measurement, a small superset) and the exact
  predicate (failed with a classed error, un-started unheld child) stays in
  TypeScript in `keepsLoomChildInColdShell`, which runs on the decoded shells
  in the two `…With` filters. No SQL/TS disagreement is possible: SQL
  over-keeps, TS decides. `ActiveShellIndexEntry` gains the two optional
  fields (marked). The join is over 6k sidecar rows keyed by primary key; S3
  times the index read before and after.
- **`shellSubscriberThreadIds`** keeps a subagent entry when `entry.loomKeep`,
  or when its `rootThreadId`'s entry is in the index, unarchived (the index is
  already `archivedAt IS NULL`) and `settledOverride !== "settled"` (DL-1404's
  clause (i), computed from the index alone); it keeps an older-settled
  top-level entry when `entry.loomKeep` or when another entry with the same
  `loom_goal_id` is unsettled (`inLiveLoomGoal` over index entries). One
  marked helper in `loomShellJoin.ts`, `keepsLoomEntryInColdShell(entry,
  index)`, called with one marked `||` in each branch. **This is S2a's work:**
  S1 cannot do it, because index entries carry no sidecar fields until the
  SQL changes.
- **`omitIdleSubagentShellsWith` and `omitOlderSettledShellsWith`** keep
  pull 13's marked `keepsLoomChildInColdShell`/`inLiveLoomGoal` clauses, now
  over `input.threads` (the decoded set), so the full-shell path (no opt-in,
  `omitIdleSubagentShells` exported for tests) behaves as before and the two
  halves agree.
- **Tests:** `ShellStream.loom.test.ts` gains the index case (an entry with
  `loomKeep` and a `mayBeLive: false` child of an unsettled root both survive
  `shellSubscriberThreadIds`); `ProjectionStore` has no Loom test, so the SQL
  is proven by S3's cockpit-copy boot (count of `loom_keep` rows equals the
  sidecar query) and S4's cold-connect journey (pull 13's: a fresh browser
  shows `N/M · 1!` on an active root before it is opened).

Gate 2a reads the SQL and the helper; S4 proves it on a seeded instance and on
the cockpit copy.
