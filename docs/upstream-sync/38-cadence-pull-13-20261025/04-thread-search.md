## 4. Thread search: both sides built it in the same week

### 4.1 What each side's search does

| Aspect | Loom #436 (23 Oct, `origin/main`) | Upstream #24343 (24 Oct, `b76a110aa4`) |
| --- | --- | --- |
| Index | `loom_thread_search`, FTS5 `porter unicode61` with stored text, one row per text unit of **eight kinds**: thread title (every thread), workstream purpose, kick-off brief (framing stripped), user message (not kick-off, not control notice), the **last assistant message of each run**, goal (title + description), task text, report file. Row id = `source.rowid * 8 + kind`. Plus `loom_thread_embeddings`: one vector per root (`ThreadEmbedder.loom.ts`; local, OpenAI-compatible or Vertex provider; `threadSearchEmbedding` setting) | `orchestration_v2_message_search`, **contentless** FTS5 `trigram remove_diacritics` keyed on the message rowid, over **finished user and assistant messages of non-subagent threads** (`messageSearchIndex.ts`'s `indexedMessageCondition`), apostrophes folded. Created by 069 with insert/update/delete triggers on `orchestration_v2_projection_messages` and a backfill; if the SQLite build lacks trigram FTS5 the migration logs a warning and search scans the newest 20,000 messages instead |
| Coverage on the cockpit | 48,069 rows (15,668 assistant, 8,390 user, 5,473 title, 4,901 purpose, 4,571 task, 4,368 report, 4,064 brief, 634 goal) + 777 embeddings, over 5,555 threads | 31,749 messages / 21.8 MB of text, from the 852 top-level threads only: **4,703 subagent threads (every Loom child) are excluded by the index predicate**, and archived threads by the query |
| Ranking | Per-term MATCH, each document scored by term coverage then kind-weighted bm25 (title 4, purpose 3, goal 3, brief 1.5, task 1.5, assistant 0.8, user/report 1); a **root** scores as its best document anywhere in its tree (`lineage.rootThreadId`); reciprocal-rank fusion (k = 60) of the lexical roots whose best document holds every term with the embedder's top-50; no embedder → lexical order with partial matches | Trigram MATCH for 3+ character tokens, substrings for shorter ones; newest 2,000 hits; in JS one best message per thread by `messageMatcher` quality (whole word 1 / word start 0.8 / inside a word 0.3, bonuses for adjacency), user messages first, then newest; `rankMessageMatches` with the user's **palette picks** (`thread.opens`, a new per-thread stat written when the user picks a thread for a query) and recency |
| Scope | Archived roots included unless `includeArchived: false`; `projectId` optional; always returns the **root** with `matchedThreadId`/`matchedThreadTitle` for a sub-thread hit, `title`, `archivedAt`, `updatedAt` so a row draws without a shell | Active, non-subagent threads; `projectId` for agents; match carries `quality`, `hits`, `messageId` (for the jump) |
| Service shape | `ThreadSearch.ts` reduced to `{ search }` delegating to `ThreadSearch.loom.ts` | `ThreadSearch.ts` rewritten (+500 lines): `{ search, searchThreads, searchOlderSettled }` plus `searchThreadsWithOlderSettledRows`, which `ws.ts`'s `orchestration.searchThreads` handler calls so a client that omitted older settled threads (#24723, §6.2) gets their rows back when it searches |
| Web surfaces | Palette and sidebar: local title/PR fallback, content hits ranked on the server; archived-root result rows (`loom/ArchivedSearchResultRow.tsx`), shell-less rows (`useAwaitingShelllessThread.ts`, `state/loom/shelllessThreads.ts`), source labels and per-token highlight (`state/loom/threadSearch.ts`), "Sub-thread:" line | Palette rewritten over `packages/shared/src/paletteSearch.ts` (1,205 lines): titles, branches, PR numbers, project names scored with picks and recency, an "In messages" section, submenu options; `Sidebar.logic.ts` and `SidebarThreadRow.tsx`; settings search; in-thread find (`useThreadFind.ts`, `threadFindActionBus.ts`, unrelated to the index) |
| Mobile | Same hits with archived rows (`ArchivedSearchResultRow.loom.tsx`, `threadListV2SearchArchivedItems`), labels and highlight in `thread-search-match.tsx` | `useThreadListSearchMatches.ts`, **message jump** (`threadMessageJump.ts`: open the thread at the matching message), `threadActivity.ts`, palette items |
| Agent tool | `mcp__t3-code__thread_search` (workstream toolkit, resident for orchestrator/planner/researcher/reviewer): root hit + sub-thread + goal title + report path, rendered for an agent | `t3_thread_search` (thread toolkit, **withheld from Loom roles** by `UPSTREAM_WITHHELD_TOOLS`): `searchThreads` = titles ranked, then a fifth of the slots for message hits, each with a `t3-thread` link |
| Maintenance | Rebuilt by 1062 and by `migrate-dev-db` (the copy renumbers rowids). **Not rebuilt after `t3 doctor --fix`'s VACUUM** (§4.4) | Rebuilt by `rebuildMessageSearch` in `DatabaseMaintenance.ts` after VACUUM and in `migrate-dev-db` |
| Eval | `dev/threadSearchEval.loom.ts` + `threadSearchQueries.json` | none |

### 4.2 Where they collide, file by file

| File | Conflict | Same functionality (doctrine §4.3 baseline = upstream) or Loom-only? |
| --- | --- | --- |
| `apps/server/src/orchestration-v2/ThreadSearch.ts` (4 markers, incl. a 184-line and a 326-line upstream-only region) | Loom replaced the module body with a delegate to `ThreadSearch.loom.ts`; upstream rewrote it with three operations | **Service shape is upstream's** (three callers depend on it: `ws.ts`, `mcp/toolkits/thread/handlers.ts`, the older-settled search). The content index behind `search` is the Loom-only part |
| `ThreadSearch.test.ts` (DU) | Loom deleted it (its subject was gone); upstream rewrote it for the trigram index | Upstream's; it tests upstream's `make`, which still exists under every option |
| `apps/server/scripts/migrate-dev-db.ts` (2) | Both rebuild an FTS index after the copy, both skip shadow tables | Union: upstream's shadow-table and contentless handling + Loom's `rebuildThreadSearchIndex` call |
| `apps/server/src/persistence/DatabaseMaintenance.ts` (silent) | Upstream rebuilds its index after VACUUM | Loom needs the same one line for its index (§4.4) |
| `packages/contracts/src/threadSearch.ts` (1) | Loom widened `source` to eight kinds and added `title`, `archivedAt`, `updatedAt`, `matchedThreadId`, `matchedThreadTitle`, `includeArchived`, `projectId`; upstream added optional `quality`, `hits`, `messageId` and `THREAD_SEARCH_QUERY_MAX_LENGTH` | Union: one match shape with upstream's optional fields and Loom's required ones; `source` is the eight-kind union (upstream's SQL decodes `role` into it, which stays valid) |
| `packages/contracts/src/orchestrationV2.ts` (hunks 3 and 6 of 6) | Loom's `goals` on the snapshot and `loom` opt-in vs upstream's `olderSettled` and `omitIdleSubagents`/`omitOlderSettled` | Union (unrelated features sharing a struct) |
| `apps/web/src/components/CommandPalette.logic.ts` (5), `.logic.test.ts` (5), `CommandPalette.tsx` (4), `CommandPaletteThreadItems.tsx` (silent, new) | Loom's "content hits rank on the server" plus archived rows vs upstream's `paletteSearch.ts` ranking with picks and an "In messages" section | **Upstream's title/branch/PR/project ranking and sections are the baseline** (Carl decided the palette should find the right thread first; which scorer is an agent's choice, and upstream's remembers his picks). Loom-only: archived-root rows, shell-less rows, source labels, sub-thread line, root crediting |
| `Sidebar.logic.ts` (3), `.logic.test.ts` (2), `Sidebar.tsx` (7, the search hunks), `SidebarThreadRow.tsx` (silent, new), `ThreadSearchMatch.tsx` (2), `state/queries.ts` (2) | Same split as the palette; `queries.ts` adds upstream's `olderSettledBefore` wiring | Upstream's wiring and rows; Loom's result row additions re-applied |
| `apps/web/src/components/ThreadRouteView.tsx` (2) | Loom's shell-less archived root opening vs upstream's guest/route changes | Union |
| mobile `HomeScreen.tsx` (2), `keyboard/CommandPalette.tsx` (4), `ThreadNavigationSidebar.tsx` (5), `thread-search-match.tsx` (2), `threadListV2.ts` (1), `state/queries.ts` (2) | Loom's archived rows and labels vs upstream's `useThreadListSearchMatches`, message jump and palette items | Upstream's structure; Loom's archived/label additions re-applied; the message jump needs a `messageId` on Loom's message-kind hits (S2c adds it: the index knows the message rowid) |
| `packages/client-runtime/src/state/threadSearch.ts` (silent, +263 upstream), `state/loom/threadSearch.ts` (Loom-only), `composerThreadItems.ts`, `olderSettledThreads.ts` (new) | Upstream's result atoms and older-settled mounting; Loom's labels/highlight helpers | Union; Loom's helpers keep working on the wider match |
| `packages/shared/src/paletteSearch.ts` (new), `shared/threadSearch.ts` (−31) | upstream only | Take |
| `docs/user/thread-sidebar.md` (1) | both rewrote the search paragraph | Upstream's paragraph plus one Loom sentence on archived and sub-thread hits |
| `Orchestrator.ts`, `ProjectionStore.ts` (the opens stat, `listOlderSettledThreads`), `ws.ts` search handler, `runtimeLayer.test.ts`, `mcp/toolkits/thread/*` | upstream only in these regions | Take (the `ws.ts` handler compiles against the service shape) |

### 4.3 Can the two indexes coexist?

Yes, measured on the schema and on the cockpit data:

- **Different objects.** Upstream: `orchestration_v2_message_search` + three
  triggers named `orchestration_v2_message_search_*`. Loom: `loom_thread_search`,
  `loom_thread_embeddings` + fifteen `loom_ts_*` triggers (three of them on the
  same messages table). Names never collide; both sets fire on a message
  insert/update/delete. Neither trigger set reads the other's table, so
  **neither breaks a write**. The extra cost per finished message is one
  trigram tokenisation of its text (streaming rows are skipped by both).
- **Both keyed on rowids of TEXT-primary-key tables**, so both are invalidated
  by anything that renumbers rowids: VACUUM (`t3 doctor --fix`) and the
  dev-database copy. Upstream rebuilds its index in both places; Loom rebuilds
  only in `migrate-dev-db` and in 1062. §4.4.
- **`migrate-dev-db` rebuilds both** once the union in §4.2 is taken
  (upstream's `rebuildMessageSearch` and Loom's `rebuildThreadSearchIndex`
  after the copy).
- **069 on the cockpit:** 31,749 messages / 21.8 MB of text to tokenise at the
  first boot, inside the migration transaction: seconds, not minutes (S3 times
  it on the `VACUUM INTO` copy). The index exists afterwards whether or not it
  is read.
- **1062 already ran** on the cockpit (ledgers 64 / 1062); it does nothing
  again.

### 4.4 Findings that hold under every option

- **Loom's index silently breaks after `t3 doctor --fix`.** The cockpit has
  `auto_vacuum = 0` and an 11.75 GB file, so pull 12's deploy step 1
  ("compact offline first") was not run; the next time anyone runs
  `t3 doctor --fix`, VACUUM renumbers the rowids `loom_thread_search` encodes
  and every content hit is credited to the wrong thread, with no error. S2a
  adds `yield* rebuildThreadSearchIndex; // loom:` beside upstream's
  `rebuildMessageSearch(sql)` in `DatabaseMaintenance.ts` (one marked line;
  the rebuild is already exported for `migrate-dev-db`). Pre-ruled (§8.2).
- **Upstream's search hides every Loom child.** Upstream's eligible set and
  index predicate exclude `lineage.relationshipToParent = 'subagent'`, which is
  how every `workstream_spawn` child is created. Any resolution that uses
  upstream's rows for Loom's surfaces loses the children, the briefs, the
  reports, goals and tasks, and the archived roots that #436 was built to find.
- **`t3_thread_search` is withheld from Loom roles** (`families.ts`,
  by construction from the thread toolkit's exports), so its new shape changes
  nothing an agent in Loom sees; it must still compile, which pins the service
  shape to upstream's.
- **`searchOlderSettled` is a #24723 dependency, not a search feature.** It
  exists so a client that received a shell without older settled threads can
  still get their rows when a search hits them. Loom's search returns settled
  roots like any other; the client needs the rows, so whichever index serves
  `search`, this operation must exist and `searchThreadsWithOlderSettledRows`
  must be the ws handler.

### 4.5 The resolution, as options for Carl (§8.1 row 1 states what he sees)

- **(a) Upstream's index and ranking as the base; Loom's embeddings and agent
  tool layered on upstream's FTS rows.** S1: upstream's files verbatim, Loom's
  `.loom.ts` search files deleted or rewritten to read
  `orchestration_v2_message_search`. S2c: re-implement root crediting, kinds,
  archived rows and the embedder over a trigram index that has no `thread_id`
  of its own (it joins to the messages table) and holds no briefs, reports,
  goals, tasks or child messages. Most of #436 would be rewritten against a
  smaller corpus; a fork migration would have to drop 1045/1062's objects. Size:
  S2c ≈ 2 days and the result finds less than today.
- **(b) Loom's index for every content search; upstream's service shape,
  surfaces and title ranking.** S1: take upstream's `ThreadSearch.ts`,
  `ThreadSearch.test.ts`, `paletteSearch.ts`, the palette/sidebar/mobile files
  and `CommandPaletteThreadItems.tsx`/`SidebarThreadRow.tsx` verbatim; keep
  every Loom `.loom.ts` search file, `state/loom/*`, `loom/ArchivedSearchResultRow.tsx`,
  the eval harness and migration 1062; union the contract. S2c (server): a
  Loom layer that satisfies upstream's `ThreadSearch` service: `search` =
  Loom's hybrid search (its match shape is a superset; a message-kind hit gains
  `messageId` from its rowid so the mobile jump works), `searchThreads` =
  Loom's hits mapped to `ThreadSearchHit` (agents in Loom never see it, but it
  compiles), `searchOlderSettled` = **upstream's own** (construct upstream's
  `make` inside the Loom layer and forward this one operation, so no SQL is
  duplicated); `runtimeLayer.ts` provides the Loom layer with one marked line.
  S2c (web/mobile): Loom's archived-root rows, shell-less rows, source labels
  and sub-thread line re-applied onto upstream's new `CommandPaletteThreadItems`,
  `SidebarThreadRow`, `useThreadListSearchMatches` and palette sections, with
  upstream's title/branch/PR ranking, picks and "In messages" section kept as
  they are. 069's trigram index stays, unread (keeping it is reversible and
  costs one tokenisation per finished message; dropping it is a fork migration
  on live data). Size: S2c ≈ 1 day server + 1 day web/mobile.
- **(c) Both side by side.** Two indexes, two code paths, two "In messages"
  sections (upstream's for root messages, Loom's for everything). Zero
  integration in S1; duplicate and inconsistent results for Carl; a follow-up
  to converge. Not recommended.

**Recommendation: (b).** Doctrine §4.3 makes upstream the baseline where it
expresses the same functionality: it does for the service shape, the palette's
title ranking and sections, the mobile jump and the older-settled plumbing, and
those are taken. It does not for the content index: upstream's cannot see a
Loom child, a brief or a report, so it is not the same functionality, and
#436 is five days old and Carl's stated priority.
