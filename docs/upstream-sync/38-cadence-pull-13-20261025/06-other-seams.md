## 6. Other seams, read and recorded

### 6.1 Orchestration and MCP: pull 12 §4.2's seam table, re-checked

226 upstream commits touch `orchestration-v2/` and `mcp/` (+53k/−71k, mostly the
two prunes and the `Effect.fn` sweep). Row by row:

| Loom seam | What changed this week | Finding | Verdict |
| --- | --- | --- | --- |
| Delegated-task question reactor inert for Loom children | #20037 "return delegated waits on pending approvals", #22581, #22653, #23886 "Stop stops a thread's subagents again", #19759 | All keyed on `app_owned` task records and `delegatedTaskId`, which `workstream_spawn` never creates. The reactor's early returns are in auto-merged regions | No change; Gate 2a re-reads the early returns |
| `UPSTREAM_WITHHELD_TOOLS` (built from toolkit exports) | **One tool added**: `t3_background_wait` in the orchestrator toolkit. No other toolkit gained or lost a tool; `t3_thread_search` changed shape (§4) | Withheld by construction. Loom's own background waiting is pi's `bg_start`/`bg_wait` (#421), unrelated | No change; `capabilities.test.ts` gains the new name to its expectation if it enumerates (S2a) |
| `requireWorkstreamCaller` / `hosted` gate | `McpHttpServer.ts` +394 (#24809 `request_secret` to a private file, #24287 analytics), `OrchestratorMcpService.ts` ±2,709 (`Effect.fn` sweep + prune), `McpInvocationContext.ts` carries Loom's `"workstream"` toolkit name (silent) | Loom's authorisation does not import `threadAccess`/`McpToolAccess`; `LoomToolkitRegistrationLive` registration line in `McpHttpServer.ts` auto-merged | No change; Gate 1's `hosted` check; `registration.test.ts` (Loom's) must still pass |
| `joinLoomShellFields` / `joinLoomThreadShell` | `Orchestrator.ts` hunks 10–11: upstream added `listActiveSubagentThreadIds`, `listOlderSettledThreads`, `findGuestShareThreadId` beside the two join sites; `readShellSnapshot` now takes `familyOf`/`worktreePath`/`threadIds` options | Both joins survive as unions. **Every new on-demand read** (`getThreadFamily`, `getOlderSettledThreads`, the search's older-settled rows) goes through `threadManagement.readShellSnapshot` = `orchestrator.readShellSnapshot`, which carries the join, and `joinLoomShellFields` spreads `...snapshot`, so `olderSettled` survives | Union; Gate 2a: a paged-in root still carries `workstream` (S4 proves it on a seeded instance) |
| Cold-connect omission (new) | #24648 `omitIdleSubagentShells`, #24723 `omitOlderSettledShells` in `ShellStream.ts`, applied in `ws.ts` and `orchestration-v2/http.ts` **after** the Loom join | §6.2: a Loom child with a stored attention flag is "idle" and dropped from the cold shell | **Pre-ruled** (§8.2): one marked predicate keeps Loom-flagged children |
| Loom's `thread.spawn`/`thread.scaffold` and the internal command union | `orchestrationV2.ts` hunk 5: upstream added `thread.guest-share.*` commands at Loom's `makeLoomInternalCommandMembers` site | Union | Union |
| `isLoomCommand` receipted no-ops (`Orchestrator.ts` hunk 9) | Upstream added "a second `thread.guest-share.close` is not an error" at the same site | Union (`isLoomCommand(command) \|\| command.type === "thread.guest-share.close"`) | Union |
| `loomAskAnswer` multi-select (hunk 7) | Upstream renamed `command.answers` destructuring | Keep Loom's call on upstream's variable | Rule D |
| Loom's steer-into-run, human-stop raise, kickoff message fields (hunks 2–6, 8) | `Effect.fn` re-indentation of `dispatchMessage`, `startRun`, `handleUsageLimitRecovery`, the queued-adapter block, `cancelSend` (+ guest cancel) | Rule D (§7.1): take upstream's shape, re-apply the 79 `loom` lines from `git diff 07d38b8d17 origin/main -- Orchestrator.ts` | Rule D; **Gate 1 reads every re-applied hunk** |
| `serverRuntimeStartup.ts` phases (hunks 2–3) | `runOrderedV2StartupPhases` was already at the base; upstream re-indented the `startup` body (hunks 2–3 are that shift) and un-exported `getAutoBootstrapThreadModelSelection` (hunk 1), which Loom's kept Pi-default test still calls: keep that `export`, marked | Loom's `home.provenance` (before everything), `loom.recovery` (after `recover`), the Loom V1 workstream importer (after `importLegacyShells`), `projects.auto-pull` placement re-applied into or around the ordered call | Rule D; Gate 1 reads the order; `serverRuntimeStartup.test.ts` (2 Rule A hunks) keeps Loom's phase mocks |
| `ws.ts` seam 21 (Loom's ws methods in their own handler layer) | **Upstream hit the same limit** ("RpcGroup.toLayer … near 200 methods crosses TypeScript's instantiation limit") and split its handlers with `Layer.effectContext` (hunks 3, 7) | Loom's `UpstreamServerWsRpcGroup = ServerWsRpcGroup.omit(...LOOM_WS_METHODS)` and `LoomWsRpcs` layer re-applied onto upstream's new split; if upstream's split already keeps each `toLayer` small enough, Loom's omit may become a plain union (S2a decides, DL row) | Rule D; Gate 1 |
| `ws.ts` provider status fold (hunks 9–10), `loadServerConfig` (hunk 8), goals on the shell stream (5–6) | `Effect.fn` and a `workspaceSnapshotsOnDemand` option; the shell snapshot now spreads `forSubscriber.snapshot` | Rule D; Loom's `...goals` spread onto `forSubscriber.snapshot` | Rule D |
| `ProjectionStore.ts` (6) | `pendingRuntimeRequest` is now `OrchestrationV2PendingRuntimeRequestSummary` (upstream added `blocking`; Loom adds `header`); `pendingGuestMessageCount`; `apply` and a 43-line read block re-shaped | Loom's `pendingQuestionHeader` rides upstream's summary type (contract hunk 2 union); import union; Rule D for the two blocks | Rule D |
| Pi adapter hooks and `loomShell` fields (`adapter.ts` 3, `driver.ts` 1, `mcpExtensionSource.ts` 2, `mcpInjection.ts` 1, `mcpBridge.testkit.ts` 2) | 7 `fix(pi)` + #18933 "T3's orchestration guidance no longer overrides other extensions' prompt changes", #15368/#15791 extension notifications, #21511 persisted sessions, #23052/#20521 fork | `driver.ts` is an `Effect.fn` re-shape around Loom's bundled-pi path (Rule D; the DL-938 hooks binding is the thing to keep); `mcpExtensionSource.ts` hunk 2 (6/10) is at the instruction-injection site: Loom's "no upstream orchestration instructions for Pi" (DL-905) must hold after #18933's rewrite | Rule D; **Gate 1 reads `mcpExtensionSource.ts` and `driver.ts`**; `mcpExtensionSource.loom.test.ts` stays the proof |
| Consult / notify / attention / report hand-back | `#24784` thread tools return a ready `t3-thread` link; `#18194` `t3_thread_read` names the sender | Loom's tools dispatch Loom commands; unaffected | No change |
| `ThreadSettlementService.ts` (2) | `loomFinishedRootAt` early return vs upstream's guest-aware activity time | Keep Loom's early return above upstream's expression | Union |

### 6.2 Cold connects omit threads (#24648, #24723): what Loom loses and the fix

Mechanism (read in `ShellStream.ts`, `contracts/orchestrationV2.ts`,
`client-runtime/state/shell.ts`, `threadFamilies.ts`, `olderSettledThreads.ts`):
a client that advertises `shellThreadFamilies` (and `shellOlderSettled`) gets a
shell without (1) subagent-lineage threads that are not live, where live means
`activityRunStatus`, a live `status`, a `pendingRuntimeRequest` or background
tasks (`isLiveSubagentShell`), unless they are the parent of a kept child; and
(2) top-level threads with `settledOverride = "settled"` older than the 25th
newest settled one, unless pinned, snoozed or an ancestor of a kept child.
Omitted rows are read on demand (`getThreadFamily` when a thread's family is
needed, `getOlderSettledThreads` as the user pages the sidebar's shelf, and the
search returns rows for older settled hits). On the cockpit this drops 415 of
440 settled roots and most of the 4,703 children from the cold shell: the 93%
upstream measured.

What is joined is fine: every path reads through the Orchestrator's joined
`readShellSnapshot` (§6.1), so a paged-in root carries `workstream`. What is
**not** fine is the liveness test: Loom's child threads finish their turn and
then hold a stored flag (`needs_guidance`, `awaiting_acceptance`,
`awaiting_orchestrator`, `error`, and the derived `brief-needed`), and Loom's
`rollup.ts` computes the root's badge, `loomAttentionOf` and the goal chips from
the descendants' `workstream.attention` on the client. A flagged child is idle
by upstream's test, so after a cold connect the root shows no Loom badge until
something loads its family. DL-1312 (a persisted question after a restart) was
the one-restart version of this; this is every cold connect.

**Fix (pre-ruled, §8.2):** a Loom predicate `keepsLoomChildInColdShell(thread, roots)`
in `loom/projection/loomShellJoin.ts`, true when **either** (i) the child's
root is unarchived and not settled, **or** (ii) `thread.workstream?.attention`
is non-empty, or the thread's outcome is null and its status is `failed` (S2a
checks `rollup.ts`'s reason list so nothing the rollup reads is omitted). It is
called with one marked `||` in `omitIdleSubagentShells` and one in
`omitOlderSettledShells`. The join runs before the filter, so the field is
there. Gate 2a verifies; S4 proves it with a child that submitted
`needs_guidance` before a fresh browser connects, and with an active root whose
finished children are counted on its sidebar badge before the root is opened.

_Orchestrator's review amendment (DL-1404):_ clause (i) was added after S0.
The rollup badge on a sidebar row shows plan counts (`N done`, `N blocked`)
over every descendant, not only the flagged ones, so a flagged-only predicate
leaves an unopened active root under-counting after a cold connect until
`useThreadFamily` loads its family. Keeping every child of a live root costs
**238 of the cockpit's 4,713 children** (92 unsettled, unarchived roots), so
upstream's saving on the 4,475 children of settled or archived roots stands;
those roots load their family when opened, as upstream intends.

### 6.3 Guest sharing (#24104): a new principal that cannot reach Loom

A guest redeems a signed link into a cookie scoped to one share
(`apps/server/src/guest/http.ts`: redeem, submit, stream, session, render, item,
command-output, attachment routes under `GUEST_ROUTE_PREFIX`; `GuestShareService.ts`
verifies tokens against the thread's `guestShare` record). The guest holds **no
auth session, no scope, no ws connection and no MCP credential**: the only
authenticated ws method is the owner's `guestShare.create` (`AuthAccessWriteScope`,
`clientRpcPermissions.ts` hunk 2, union with Loom's hub-login scopes). A guest
message waits in `thread.guestShare.messages` until the owner approves it, then
dispatches as `message.dispatch { guestMessageId }`; `ThreadMessageIntake.ts`
attaches the guest's files. The feature is behind `guestSharingEnabled`
(default `false`, Settings → Beta). Loom's tools and ws methods are therefore
unreachable to a guest by construction, not by a check; nothing to prove beyond
`registration.test.ts`'s thread-less-scope refusal, which still holds. Gate 2a
reads `GuestShareDecider.ts` once for the lineage walks (a guest share on a Loom
root is just a share).

### 6.4 Source-control refactor and other module moves

Forges now parse their own URLs, own their services and media (#23992–#23998),
definitions moved to `packages/shared/src/sourceControl*` (#24181), GitHub-named
settings became SourceControl/PullRequest, `pullRequestEditing` and
`threadReference` moved into `client-runtime`. The Loom-only import check
(§5.4) found **no** Loom file importing a moved module: Loom's ship tooling
(`scripts/ship.ts`), `link_pull_request`/`watch_pull_request` (workstream
toolkit handlers over `PullRequestWatchReactor`), and the #424/#425/#427
change-review panels import nothing that moved. `GitVcsDriverCore.ts` hunk 1
is upstream's new `sourceControlDefinitions` import beside Loom's foreign-home
comment (union). `routes/_chat.pull-requests.tsx` (2,507 → 77 lines upstream,
the page moved under `components/pullRequest/PullRequestsPage.tsx`) auto-merged
to upstream's: Loom had no delta there.

### 6.5 Settings routes and `routeTree.gen.ts`

Upstream renamed `routes/settings.*.tsx` → `routes/_chat.settings.*.tsx`
(14 renames), added `_chat.settings.archived.tsx`, `_chat.settings.beta.tsx`,
`_chat.usage.tsx`, `guest.tsx`, and deleted `settings.archived.tsx`, `usage.tsx`.
**Loom does add one route of its own**: `routes/preview.tsx` (the preview
harness, doc `web-component-preview.md`); the brief's "Loom adds no routes" was
wrong. `routeTree.gen.ts` (11 markers, all Loom-side-only regions) is generated:
S1 takes upstream's (`git checkout --theirs apps/web/src/routeTree.gen.ts`)
and regenerates so `/preview` returns:

```sh
cd apps/web && node --input-type=module -e "
import { Generator, getConfig } from '$(ls -d ../../node_modules/.pnpm/@tanstack+router-generator@*/node_modules/@tanstack/router-generator)/dist/esm/index.js';
const config = getConfig({ routesDirectory: './src/routes', generatedRouteTree: './src/routeTree.gen.ts', autoCodeSplitting: true });
await new Generator({ config, root: process.cwd() }).run();"
git status --short apps/web/src   # only routeTree.gen.ts may change; DL-166 saw it byte-identical to the plugin's output
```

(`@tanstack/router-generator` 1.167.12 is the plugin's dependency and not a
direct one of `apps/web`, hence the `.pnpm` path; `vp run dev` in `apps/web`
regenerates it too, at the cost of starting Vite.) `dangling.py`'s fifth hit
(`./routes/settings`, `./routes/usage` in Loom's stale generated file) goes away
with the regeneration.

### 6.6 Migrations 065–069 against the fork lane and Loom's runtime

| Upstream migration | What it does | Touches a table a fork migration or Loom reads? |
| --- | --- | --- |
| 065 `CodexUsageNativeTurnIndex` | `CREATE INDEX` on `orchestration_v2_provider_turns` | Additive |
| 066 `RepairClientSettlementTimestamps` | Finds V1 `thread.settled` client events from app versions 0.0.35–0.0.38 before 2026-09-05 written in bursts, re-derives each thread's activity time from `projection_thread_messages` and the thread's retained V1 events, and repairs the settlement timestamp | Reads `orchestration_events` (V1 rows only: 40,150 remain on the cockpit after the DL-1300 guard, 34k of them Loom history), `projection_thread_messages` (V1, still present). No DROP/ALTER. Probably a no-op on the cockpit (Loom never shipped those upstream versions); S3's ledger boot records its time |
| 067 `WebhookDedupe` | `ALTER TABLE scheduled_tasks ADD COLUMN last_run_webhook_delivery_id`; two new `scheduled_task_webhook_*` tables + indexes | Additive; Loom's scheduled-task hunks read `scheduled_tasks` columns by name |
| 068 `ShellStopRequestIndex` | `CREATE INDEX` on `orchestration_v2_projection_turn_items` | Additive |
| 069 `ThreadMessageSearch` | §4.1: contentless trigram FTS5 + three triggers on `orchestration_v2_projection_messages` + backfill; tolerates an SQLite without trigram FTS5 | Coexists with Loom's `loom_ts_messages_*` triggers (§4.3). The Node SQLite build is 3.53.4 (trigram present); the host's `sqlite3` CLI is 3.34.1 and cannot read the index, which only matters for S3's manual checks |

No upstream migration drops or renames anything the fork lane (1001–1062) or
Loom's runtime reads. `Migrations.ts` is byte-identical in the trial tree.

### 6.7 Mobile

12 conflicts, 25 markers, 34 `loom:` lines. Seven files are the #436/#24343
collision (§4.2). The remaining Loom hunks are small and sit beside upstream
edits: `ThreadFilesRouteScreen.tsx` (markdown opens rendered),
`AdaptiveWorkspaceLayout.tsx` (open by id so archived hits open: #436 again),
`PendingUserInputCard.tsx` ("Asked 3h ago", computed on render),
`UsageLimitsPooled.tsx` (failing logins and unlinked sources lead, #407),
`usageProviders.ts` (pi first, DL-918: three Rule B hunks, check for a
duplicate key after the merge), `use-composer-drafts.ts` (drop the draft's
model once the thread holds it; the 18/63 hunk is Rule D).
Upstream added `apps/mobile/modules/` (48 files) and reworked draft/thread
navigation (#23467): take verbatim. Two new mobile lint rules
(`no-ambiguous-detail-navigation`, `require-registered-list-scroll`) may hit
Loom's mobile hunks; S2b runs `vp lint apps/mobile/src` (§6.9).

### 6.8 Config, scripts and docs

| File | Markers | Resolution |
| --- | ---: | --- |
| `AGENTS.md` | 4 | Loom's file is Loom's (it was rewritten for the fork). Port from upstream's side only the rules that bind Loom code after this pull: browser tests use `apps/web/test/render.tsx` with `using` (hunk 3's paragraph), "React effects are a last resort" with the budget file, `vp run check:changed`, and the `.t3/setup-running` note if the setup script exists in Loom's `t3.json` (check). Drop upstream's GitCafe and "never make a PR" lines. DL row listing what was ported |
| `vite.config.ts` (root) | 3 | Union: upstream's new rule table and `TEST_EXCLUDE` + Loom's `quarantine/**` and MDX lines; the `DOM_TEST_ENVIRONMENT_ALLOWLIST` gains Loom's 18 jsdom tests behind `// loom:` (§6.9); the em-dash `excludeFiles` gains the §8.1 row 2 entries if ruled |
| `apps/web/vite.config.ts`, `apps/server/vite.config.ts` | 1 + 1 | Union (Loom's one line each + upstream's `typecheck` task and Node-26 SEA check) |
| `scripts/dev-runner.ts` (3), `dev-runner.test.ts` (7) | 10 | Rule D: upstream's `Effect.fn` shape, Loom's IPv4 loopback default, busy-port fallback and worktree `.t3` home inside it; the test keeps Loom's marked cases (Rule T for the rest) |
| `.gitignore` | 1 | Union (Loom's `lint-plan` render outputs + upstream's `artifacts/mobile-e2e/`) |
| `docs/operations/development.md` | 1 | Upstream's `vp`/Node 26 paragraph, then Loom's git ≥ 2.41 prerequisite block |
| `docs/user/thread-sidebar.md` | 1 | §4.2 |
| `apps/web/package.json` | 2 | Drop Loom's `typecheck` script (upstream moved web typecheck into `apps/web/vite.config.ts`'s `run.tasks.typecheck`), keep `lint:plan`; deps union (`remark-mdx`, `@mdx-js/mdx` + upstream's `remark-math`, `remark-parse: catalog:`); **`jsdom` stays** (DL-1301; it auto-merged this time, check it is still there) |
| `pnpm-workspace.yaml` | 1 | Patches list union: upstream's (Expo 58 re-cuts, `@pierre/diffs@1.6.1`, `react-native-reanimated`, …) + Loom's `@earendil-works/pi-coding-agent@1.3.0` line and comment; catalog auto-merged (Loom's pi line and `@huggingface/transformers` `onlyBuiltDependencies` entry survive; check) |
| `pnpm-lock.yaml` | 40 | `git checkout --theirs`, then `vp i` until unchanged (DL-1220: three passes last time); `vp` itself upgrades from 1.0.0 to 1.4.0 on the first pass, so the second pass runs the new `vp` |
| `scripts/lib/cli-external-packages.test.ts` | 1 | Rule A (Loom's `@huggingface/transformers` entry) |

### 6.9 The twelve new lint rules, sized against Loom's files

`vp check` must pass before ship. Rules that are errors at `b76a110aa4` and
were not at the base, with what they hit in Loom's code (measured by grep; the
exact counts come from `vp lint` in S2):

| Rule | Scope | Loom hits (estimate) | Fix |
| --- | --- | --- | --- |
| `t3code/no-em-dash-copy` | string literals and JSX text in `apps/*/src`, `packages/*/src`, tests excluded | **277 lines in 87 Loom-side files**; the top ones are `mdx-plan/planLint.ts` 26, `preview/fixtures.tsx` 25, `preview/workstreamFixtures.tsx` 18, then the **agent-read** files `loom/orchestration/dispatcher/{wakes,yield,gateLegs,briefNeeded,digest}.ts` (45), `loom/prompt/{prose,goalContext}.ts` (15), `mcp/toolkits/workstream/{render,prose}.ts` (12), `handlers/childNode.ts` 5 | **§8.1 row 2**: UI strings and fixtures are replaced in S2b; the agent-read files are either replaced now or exempted with a marked `excludeFiles` entry and a Fable follow-up |
| `t3code/react-effect-budget` | `apps/web/src`, `apps/mobile/src`, `packages/*/src` | A file not in `scripts/effect-budget.json` may hold **zero** effects. Loom-only files with effects: **38 files / 61 effects** (`MdxPlanAnnotationLayer` 6, `WorkstreamGraph` 5, `MdxPlanRenderer` 3, `canvas.tsx` 3, `SearchableModelList` 3, …). Shared files where Loom's hunks add effects: 4 (`use-thread-composer-state.ts`, `ChatComposer.tsx`, `ChatMarkdown.tsx`, `FileBrowserPanel.tsx`, +1 each) | **Pre-ruled** (§8.2): add entries with the current counts, raise the four shared entries by one; no effect refactoring in this pull. The JSON cannot carry a marker: the next pull keeps Loom's entries (DL-1301's rule) |
| `t3code/no-dom-test-environment` | all `src` tests, minus `DOM_TEST_ENVIRONMENT_ALLOWLIST` | **18 Loom tests** with `@vitest-environment jsdom`: 12 web (`mdx-plan/**` 10, `loom/chatPathScan.test.ts`, `preview/questionPeek.test.tsx`), 6 mobile (4 Loom-only, 2 Loom-edited upstream files) | Upstream's own escape hatch: list them in the allowlist behind `// loom:`. Converting the MDX ones to browser tests is a follow-up |
| `t3code/require-disposable-render` | `apps/web/**/*.test.{ts,tsx}` | 1 Loom browser test + the re-homed marked blocks (§5.5); any Loom jsdom test that calls `render` | Port to `apps/web/test/render.tsx` |
| `t3code/prefer-effect-fn` | non-test `src` | Unknown until lint runs; Loom's services already use `Effect.fn` widely. Candidates are variable-bound `(args) => Effect.gen(...)` wrappers in `Orchestrator.loom.ts`, `SubscriptionUsagePoller.ts`, `LoomStore.ts`, `pendingSteering.ts`, `ReviewSnapshotService.ts`, `loomAgentRoutes.ts` (≤ 98 sites, most of them inline callbacks the rule ignores) | Mechanical: `Effect.fn("Service.operation")(function* (args) { … })` |
| `t3code/no-real-time-wait-in-tests`, `no-polling-loop-in-tests`, `no-wall-clock-in-tests`, `no-test-timeout-or-unreasoned-skip` | test files | grep: ≈ 41 Loom-only test files with `setTimeout`/`Effect.sleep`/`waitFor`, 7 with counted loops, 7 with `Date.now()`, 7 with a timeout or bare skip (overlapping); the rules exempt fake timers and `TestClock`, so the real count is lower | Fake timers / `TestClock.adjust`; a reasoned `skip`; event-driven waits. S2a/S2b by package; a DL row with the count |
| `t3code/no-frame-waits-in-browser-tests` | `*.browser.test.tsx` | 1 Loom file | as above |
| `t3code/no-ambiguous-detail-navigation`, `require-registered-list-scroll` | `apps/mobile/src` | Loom's mobile hunks are small (§6.7); the archived-result rows render a list item, not a list | S2b runs mobile lint |

Also enforced upstream but already satisfied by Loom at the base: `no-manual-memo`,
`no-low-value-comments`, `no-hookless-use-function`, the compiler bailout rules.

### 6.10 Versions and toolchain

| Item | Base → target | Consequence |
| --- | --- | --- |
| Effect | 4.0.5 → 4.0.5 | No change; **no Slack-bridge check needed** this pull |
| React | 19.3.0 → 19.3.0 | No change |
| Node (`engines.node`) | `^24.13.1` → **`26.12.1`** (#23165, exact) | Host and cockpit run 24.21.0 via `n`; nothing fails on 24 by itself (no `engine-strict`), but upstream builds, tests and ships on 26 and its SEA build refuses any other version. **§8.1 row 3** |
| pnpm (`packageManager`) | 11.10.0 → **12.14.0** (#22738) | Host `pnpm` is 11.10.0 (corepack 0.36 present). pnpm warns on the version mismatch and continues; `vp i` is the install path. Install pnpm 12 for `pnpm ship`/`pnpm cockpit` (`corepack enable && corepack prepare pnpm@12.14.0 --activate`), S1 tooling note |
| Vite+ | 1.0.0 → 1.4.0 (`vp` from `node_modules/.bin`) | The first `vp i` runs the old `vp`; the second runs 1.4.0. Three passes (DL-1220). `vp run typecheck` now caches per package (`--cache`) |
| TypeScript | 7.0.2 + `tsc-rs` → `typescript: npm:@tsc-rs/typescript@0.8.0` | `tsc` **is** tsc-rs; `apps/server`'s `typecheck` script is `tsc --noEmit`; web's is a Vite+ task. S1 observes typecheck with `vp run typecheck`, not `tsc-rs --noEmit` by hand |
| pi | `@earendil-works/pi-coding-agent` 1.3.0 (Loom catalog + patch) | Upstream does not depend on it; the catalog line and patch survive as in pull 12 |
| `@pierre/diffs` | 1.5.2 → 1.6.1 (+ `@pierre/highlights` 0.2.0 replaces Shiki, #23178) | Loom's #424 diff-view redesign imports `@pierre/diffs` in `DiffPanel.tsx`, `DiffWorkerPoolProvider.tsx` (conflicted: 11/13 Rule D), `HighlightedCodeLines.tsx`, `MessagesTimeline.tsx`; S2b typecheck tells whether 1.6.1 changed an API Loom calls |
| Clerk, Electron 44.9.3, Expo 58 patches, `pele` (Mermaid), KaTeX | upstream bumps | Take; Loom's `components/files/mdx-plan/blocks/mermaid.tsx` renders Mermaid itself and is unaffected by `pele` unless it imported the chat's Mermaid block (check in S2b) |
| UI design overhaul behind a Beta toggle (#24865, 59 files, `components/ui/*`, `index.css`) | new look, off by default | Loom's `index.css` (19 `loom:` lines, 3 conflicts: the wide-block bleed budget and scanned-path link exclusions) is unioned; S4 toggles the beta once and screenshots a chip, a table bleed and an MDX plan |
