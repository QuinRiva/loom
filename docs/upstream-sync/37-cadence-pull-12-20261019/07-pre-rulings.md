## 7. Pre-rulings

### 7.1 Questions for Carl (answer before S1)

Each row states what Carl sees under each option. The recommendation is the
runbook's; the ruling is his. Rows 1 and 4 change product behaviour; rows 2 and
3 change the pull's scope and the host.

| # | Decision | Options and what Carl experiences | Recommendation | Ruling |
| --- | --- | --- | --- | --- |
| 1 | **How a workstream root shows that a child waits on a human** (upstream #19630 vs Loom's rollup, §4.2) | **(a) Upstream's for approvals and questions; Loom's rollup only for Loom's own reasons.** A root whose child asks a question or needs an approval shows upstream's "Subagent needs input/approval" in the sidebar Working section, status badge, notification and composer banner, on web and mobile, and cannot be snoozed while it waits; Loom's badge still shows `needs_guidance`, `awaiting_acceptance`, `awaiting_orchestrator`, `error` and brief-needed, in Loom's tone. One badge per reason. **(b) Keep both.** Same as (a) plus Loom's own "awaiting input/approval" badge beside upstream's: two indicators and two notifications for one event. **(c) Keep Loom's; neutralise upstream's for Loom lineage.** Nothing changes from today on web; mobile never gains the roll-up; a marked exclusion in `threadShell.ts` becomes permanent fork surface | **(a)** — doctrine §4.3: Carl decided the functionality, an agent chose the rollup mechanism; upstream's covers mobile and snooze too. S2b deletes `awaiting_input`/`awaiting_approval` from `rollup.ts` and the surfaces that render them, keeps the rest | **(a)** — Carl, 19 Oct: "Upstream's indicator; Loom's rollup only for Loom-only reasons" |
| 2 | **How far the React Compiler sweep goes into Loom's web files** (§5.3) | **(a) Full sweep in S2b:** every `useMemo`/`useCallback` removed from the 47 fork-only files and every compiler bailout fixed; `vp check` and the coverage test green with no Loom exemption. Carl sees nothing change, except where a bailout fix alters a component (the MDX plan canvas and annotation layer are the risk); S2b grows by roughly a day. **(b) Sweep the easy files, exempt the hard ones:** same, but a file whose bailout needs a redesign gets a marked lint override and a coverage-test exclusion (DL row each); those components stay un-memoised by the compiler, so they re-render as they do today. **(c) Exempt all of `apps/web/src/loom/**` and `mdx-plan/**`:** fastest; Loom's components never get the compiler's memoisation; permanent fork surface in `vite.config.ts` and the coverage test; the sweep becomes a follow-up | **(b)** — (a)'s end state with a bounded escape hatch, so the merge is never held on a canvas rewrite. Every exemption is a DL row and a follow-up task | **(b)** — Carl, 19 Oct: "Sweep in this pull; exempt only where a bailout needs a redesign". He noted he never chose `useMemo`/`useCallback`; the hooks were the implementing agent's mechanism |
| 3 | **Install Playwright Chromium on the host** so the 134 web browser tests and the server's `ServerBrowserPage.test.ts` (failing since pull 10, DL-975) run in S3 | **(a) Install** (`pnpm exec playwright install chromium`, ~300 MB under `~/.cache/ms-playwright`, no system packages if `--with-deps` is not needed); S3's web gate then covers every test upstream runs. **(b) Don't:** S3 runs `--project unit` only; 134 upstream tests and the five re-homed Loom assertions (§5.4) go unrun on this host, and `apps/web`'s `test` script would be marked back to unit-only | **(a)** — the browser project is now where upstream's component tests live; without it the web gate proves little. Carl's call because it is a host install | **(a)** — Carl, 19 Oct: "Install it" |
| 4 | **SQLite planner statistics on the cockpit's 8.8 GB database** (upstream #21122, §5.2) | **(a) Take upstream:** on first boot after deploy the server deletes `sqlite_stat1` (and no longer runs `PRAGMA optimize`); upstream's reason is that stats taken while a table was small made the planner scan it once it grew, and that collecting them read every page of the large tables at startup. Query plans change on the cockpit DB; upstream fixed the two queries that needed an index with `INDEXED BY`. **(b) Keep stats:** keep DL-1100's `PRAGMA optimize` behind a marker and skip the delete; the cockpit behaves as today; permanent fork surface in a file upstream iterates | **(a)**, with a gate: S3's ledger boot (DL-978's method, on a `VACUUM INTO` copy of the cockpit DB) records startup time and times a shell snapshot and a thread read before and after, and Gate 2 compares. If a plan regresses visibly, S3 raises it before ship | **(a)** — Carl, 19 Oct: "Take upstream, gated by a timing comparison" |

### 7.2 Pre-rulings the runbook carries (not questions)

- **Lockfile:** take upstream's `pnpm-lock.yaml`, keep Loom's catalog/patch
  lines in `pnpm-workspace.yaml`, regenerate with `vp i`; never hand-merge the
  14 hunks. A second `vp i` must leave it unchanged (DL-1003's lesson: commit
  `pnpm install --lockfile-only` output).
- **`builtInDrivers.ts`:** registry stays Pi-only (standing since pull 7).
- **`Migrations.ts`:** upstream verbatim (auto-merges).
- **Standing settings defaults:** `contextWindowMeterEnabled: true`,
  `autoResumeLimitedThreads: true`, pi enabled by default (DL-84/DL-934),
  allow-list model fields (DL-913). New upstream fields take upstream's
  defaults.
- **DL-973 retired:** `ThreadLaunchService.ts` upstream verbatim (§4.2).
- **`t3 project` live path:** upstream's `withProjectCliSessionToken`; Loom's
  DL-1102 resolver deleted if Gate 1's check passes (§4.3).
- **`textGeneration.ts`:** `disableExtensions: false` stays (cliproxy).
- **Tool exposure:** unchanged from pull 10's adopted role-resident arm
  (DL-990); upstream changed no exposure code.
- **Pi orchestration instructions:** still none (DL-905); `mcpExtensionSource.loom.test.ts`
  keeps proving it.
- **`PreviewView` annotation survives unmount:** Loom's rule over upstream's
  unmount cancel (§5.3).
- **Comment-prune collateral:** where the merge leaves a Loom narration
  comment (no `loom:` marker, no code) whose neighbours upstream pruned, S1
  may delete it; it must not restore anything upstream pruned.
- **`ClaudeProvider.ts` probe spawn:** keep and mark (`// loom:`); Gate 2b
  decides whether it is dead code.
- **Model-read text:** no role file, addendum or tool prose changes in this
  pull. If a resolution seems to need one, it is a DL row and a follow-up for
  a Fable child (pull 10's rule), not an S1/S2 edit.
- **Quarantine:** untouched.
- **`UPSTREAM_BASE`:** S3 sets it to `07d38b8d17167c8d17fba1184dbe13a307fada74`.

### 7.3 Findings that need no ruling (recorded so Gate 2 reads them once)

- The delegated-task question reactor is inert for Loom children (§4.2 row 1).
- Storage cleanup's group ownership (#19748) reaches finished workstreams only
  when a cleanup rule is on; all are off (§4.2 row 3).
- `isLiveCallerShell`'s wider "live" definition (#19751) affects upstream's
  tools only.
- `sidebarAutoSettleKeepPullRequests` (new): auto-settle can keep threads
  with open PRs; default off; take.
- `DelegatedTaskQuestionReactor` is wired in upstream's `runtimeLayer.ts`
  (auto-merged region); Loom's `serverLayers.ts` provides nothing it needs.
