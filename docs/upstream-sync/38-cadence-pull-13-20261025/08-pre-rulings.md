## 8. Pre-rulings

### 8.1 Questions for Carl (answer before S1)

Each row states what Carl sees under each option. The recommendation is the
runbook's; the ruling is his. Row 1 changes what search finds and how it ranks;
row 2 touches his "no model-read text changes in a pull" rule; row 3 is a host
and VM change.

| # | Decision | Options and what Carl experiences | Recommendation | Ruling |
| --- | --- | --- | --- | --- |
| 1 | **Which index serves thread search, and what Loom keeps of #436** (§4) | **(a) Upstream's trigram index and ranking as the base; Loom's embeddings and agent tool rebuilt on top of it.** Cmd+K and the sidebar search behave exactly as upstream's: titles, branches, PR numbers and project names ranked with his past picks and recency, then an "In messages" section with the best message per thread, whole-word matches first; mobile jumps to the matching message. **What he loses:** no hit from any workstream child (every `workstream_spawn` thread is excluded by upstream's index), no brief, report, goal, task or purpose hits, no archived roots, no "Sub-thread:" line; `mcp__t3-code__thread_search` finds only root messages; the semantic ranking is rebuilt over that smaller corpus. ≈ 2 days of S2c work for a search that finds less than today. **(b) Loom's index for every content search; upstream's service shape, palette ranking and surfaces around it.** Cmd+K ranks titles, branches, PRs and projects as upstream now does (picks remembered, recency), and the "In messages" section is Loom's: child, brief, report, goal, task and archived-root hits credited to the root, labelled by source with the sub-thread line, semantic fusion when the embedder is on; mobile jumps to the message for message-kind hits; the `thread_search` tool is unchanged; the in-thread find is upstream's new one. Upstream's trigram index is built at the first boot (seconds) and stays unread. ≈ 1 day server + 1 day web/mobile in S2c. **(c) Both side by side.** Two "In messages" sections with different answers, duplicates for root messages, and a follow-up to converge. Nothing he has today is lost, nothing upstream added is lost, and the palette is confusing until the follow-up | **(b)**: upstream is the baseline for the parts that are the same functionality (service shape, title ranking, sections, the mobile jump, older-settled plumbing); its index is not the same functionality, because it cannot see a Loom child, brief or report, and #436 is Carl's stated priority five days old | **(b), amended** — Carl, 26 Oct: Loom's index with upstream's surfaces; the **default human scope** (Cmd+K, sidebar, mobile) is top-level threads' own text plus reports, archived included, sub-thread content behind an "include sub-threads" toggle ("if I'm looking for something it's almost certainly something I've seen before: a root message or a report/plan I've read"); the agent tool keeps full scope ("it's possible that when an agent uses the tool, it may get value from finding/searching sub-threads"); the **ranker is chosen from an eval** ("I think my ranking system is better, but we should test it before just making that assumption"): Loom lexical, Loom hybrid and upstream's trigram on the same cockpit copy and the 57-query set, numbers to Carl before S2c integrates |
| 2 | **Em dashes in Loom's agent-read strings** (new lint error `no-em-dash-copy`, §6.9, vs the standing "no model-read text changes in a pull" rule) | **(a) Replace them everywhere in S2 (277 lines, 87 files).** User-visible strings (plan lint messages, preview fixtures, chips) lose their em dashes now, which matches his own prose rule; the ≈ 80 lines in control-plane notices, kick-off prose, digest and gate texts that agents read change punctuation (an em dash becomes a comma or a colon) in the merge, with a DL row listing the files but without the `llm-instruction-change` evaluation. Agents never see a wording change beyond punctuation. **(b) Replace the user-visible ones now; exempt the agent-read files with a marked `excludeFiles` entry and a Fable follow-up.** Same for him; agents see no change this pull; a short exemption list in `vite.config.ts` until the follow-up lands (then deleted). **(c) Exempt every Loom file.** Fastest; Loom's UI keeps its em dashes; permanent fork surface | **(b)**: the standing rule says prompt text is a Fable child's job with the evaluation protocol, not a merge coder's find-and-replace; the exemption is small and temporary | **(a)** — Carl, 26 Oct: "Replace them everywhere in this pull" |
| 3 | **Node 26.12.1 on the dev host and the cockpit VM** (upstream's exact pin, §6.10; both run 24.21 via `n`) | **(a) Upgrade:** `n 26.12.1` on the host before S3 (user-level, no sudo; `~/.n/bin/node` is what the deploy daemon and `pnpm cockpit` use), and on the VM at deploy. S3's fresh install, tests and the cockpit-copy boot run on the version upstream ships on; nothing visible changes. **(b) Stay on 24 and relax Loom's `engines.node`** to `^24.13.1 \|\| 26.12.1`: no host change; S3 proves the server runs on 24 (nothing enforces the pin at runtime) but any Node-26-only behaviour upstream relies on is found late, and the SEA/native builds refuse to build. **(c) Upgrade the host, defer the VM:** S3 runs on 26; the deploy note carries the VM step | **(a)**: a one-command, reversible host change; upstream tests on 26 and so should the gates | **(a)** — Carl, 26 Oct: "Upgrade the host now, the VM at deploy" |

### 8.2 Pre-rulings the runbook carries (not questions)

- **Lockfile:** take upstream's `pnpm-lock.yaml`, keep Loom's catalog and patch
  lines in `pnpm-workspace.yaml`, regenerate with `vp i` until a pass leaves it
  unchanged (DL-1220: three passes; the first upgrades `vp` to 1.4.0). Never
  hand-merge the 40 hunks.
- **pnpm 12 on the host** for `pnpm ship`/`pnpm cockpit`: `corepack enable &&
  corepack prepare pnpm@12.14.0 --activate` (user-level). Recorded in S1's DL row.
- **`builtInDrivers.ts`:** Pi-only (standing). It auto-merged this time; S2a
  confirms the registry is still `[PiDriver]`.
- **`Migrations.ts`:** upstream verbatim (auto-merges). `migrationEntries` is
  gone: Loom's two migration tests use `migrationManifest`, `runMigrations({
  toMigrationInclusive })` and direct module imports (§5.4).
- **069's objects stay** (table, three triggers, backfill), unread under row 1
  (b). Dropping them would be fork migration 1063 on live data; keeping them
  costs one trigram tokenisation per finished message and ≈ 30 MB on the
  cockpit. Revisit when upstream's search moves again. **Reversed by Loom
  1065 `DropUpstreamMessageSearch`** (convergence audit, 26 Oct): upstream 069
  still runs, then 1065 drops its triggers and table. Upstream's
  `ThreadSearch.search` falls back to its scan (only the dev eval calls it)
  and `rebuildMessageSearch` becomes a no-op.
- **Loom's index is rebuilt after `t3 doctor --fix`:** one marked line in
  `DatabaseMaintenance.ts` beside `rebuildMessageSearch(sql)` (§4.4). Lands in
  S2a; S3's doctor dry-run on the cockpit copy proves both rebuilds run.
- **Children of live roots, and Loom-flagged children, stay in cold shells:**
  `keepsLoomChildInColdShell` (§6.2, as amended by DL-1404), two marked `||`s
  in `ShellStream.ts`. S2a; Gate 2a; S4.
- **Standing settings defaults:** `contextWindowMeterEnabled: true`,
  `autoResumeLimitedThreads: true`, pi enabled by default (DL-84/DL-934),
  allow-list model fields (DL-913). New upstream fields (`guestSharingEnabled`)
  take upstream's defaults.
- **`textGeneration.ts`:** `disableExtensions: false` stays (cliproxy).
- **Pi orchestration instructions:** still none (DL-905) after #18933's rewrite
  of the injection site; `mcpExtensionSource.loom.test.ts` keeps proving it.
- **Tool exposure:** unchanged from pull 10's adopted role-resident arm
  (DL-990); `t3_background_wait` is withheld by construction.
- **`PreviewView` annotation survives unmount:** Loom's rule over upstream's
  unmount cancel (pull 12 §5.3, DL-1214).
- **React Compiler:** no `useMemo`/`useCallback` in web files, no exemptions
  (DL-1273). Rule C still applies to any Loom hunk re-homed into a new module.
- **Effect budget:** `scripts/effect-budget.json` gains Loom's 38 files at
  their current counts and +1 on the four shared files (§6.9); no effect is
  refactored in this pull. **The JSON cannot carry a marker: next pull, keep
  Loom's entries** (as DL-1301 says for `jsdom`). A follow-up may burn the
  Loom entries down.
- **jsdom tests:** the 18 Loom files go into `DOM_TEST_ENVIRONMENT_ALLOWLIST`
  behind `// loom:`; converting the MDX ones to browser tests is a follow-up.
- **`jsdom` in `apps/web`** (DL-1301): keep the devDependency line.
- **`V1ImportBoundary.test.ts`** becomes a Loom-only file (§5.3).
- **The V1 Loom-history guard in `ProjectionMaintenance.ts`** (DL-1300) must
  survive: the file is in the silent overlap with one `loom:` line; Gate 2b
  reads it and S3's cockpit-copy boot counts the history rows before and after
  the first compaction (DL-1300's method: 33,696 rows across 3,874 threads
  last time).
- **Rollup ruling** (pull 12 §7.1 row 1): upstream's indicator for approvals
  and questions, Loom's badge for Loom-only reasons. Unchanged; §6.2's
  predicate exists to keep it true on a cold connect.
- **Comment-prune collateral:** as pull 12: S1 may delete a Loom narration
  comment whose neighbours upstream pruned; it must not restore anything
  upstream pruned.
- **Model-read text:** no role file, addendum or tool prose changes in this
  pull beyond what row 2 rules for punctuation. Anything else is a DL row and
  a Fable follow-up.
- **Quarantine:** untouched.
- **`UPSTREAM_BASE`:** S3 sets it to `b76a110aa4cf011345ec9d63d37c2dcdf4b751ad`.

### 8.3 Findings that need no ruling (recorded so Gate 2 reads them once)

- The delegated-task reactor and the new delegated-wait/stop fixes are inert
  for Loom children (§6.1).
- Guest sharing cannot reach a Loom tool or ws method; off by default (§6.3).
- `t3_background_wait` is withheld by construction (§6.1).
- Every on-demand shell read carries Loom's join (§6.1); the `olderSettled`
  field survives `joinLoomShellFields`'s spread.
- Upstream now splits its ws handler layers for the same type-instantiation
  reason Loom's seam 21 exists; S2a may simplify seam 21 onto it (§6.1).
- `migrate-dev-db` rebuilds both search indexes after the copy (§4.3).
- Upstream's `#23902` routes many persistence reads through
  `NodeSqliteClient.readOnly`; Loom's `LoomStore.ts` reads could follow in a
  follow-up (not merge work).
- #23783 `shouldPublishShellApplicationEvent`: shell updates no longer refetch on a subagent's message, turn-item, node or provider-turn events; Loom's sidecar events are other types and pass through (review nice-to-have).
- #23900 `storageCleanup.ts`: a deleted thread can own and clean the worktree its remaining subagents share; Loom children run in the parent's worktree, so **Gate 2b reads it against the location rule** (review nice-to-have).
- §6.5's `ls -d …router-generator@*` glob breaks if two versions are installed after `vp i`; S1 picks the one `vite.config.ts`'s plugin resolves.
- `routes/_chat.pull-requests.tsx` is upstream's 77-line route; Loom's PR
  panel work (#424–#432) lives under `loom/review/` and did not touch it.
