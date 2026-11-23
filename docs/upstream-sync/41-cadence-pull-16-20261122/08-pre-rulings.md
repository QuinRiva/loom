## 8. Pre-rulings

### 8.1 Questions for Carl

Fifteen rows, against none in pull 15. Each is here because upstream shipped
something that replaces, duplicates or collides with a Loom feature, changes
what a Loom agent's tools or prompt contain, or needs an action on the host.
Every row has a recommended answer, and **S1 can start under the recommended
answers**: the last column says what it costs to change one afterwards. The
rows are ordered by how much rides on them. "All as recommended" is a complete
ruling.

Which session waits on which row, if Carl has not ruled when it is reached:
S1 resolves six rows' hunks under the recommendation (sender note, context
meter, Pi resume, usage carry-forward, diff highlight, phone file paths);
S2a's tool lists wait on the four tool rows; S2b's lint block waits on the
translation row; S3 waits on the Node row; the ship waits on the deploy-order
row.

| Decision | Options, and what Carl sees or loses under each | Recommendation | Cost of a different ruling after S1 | Ruling |
| --- | --- | --- | --- | --- |
| **Agent PR and CI tools.** Upstream added nine agent tools: read, list, open, update, review, respond to and **merge** a pull request, read failing CI logs, re-run checks (§4.1). With no action every Loom root, orchestrator and shipper thread starts with all nine loaded (about 340 of the 1,560 threads created since 1 Nov), because Loom's PR tool family is "whatever is in upstream's PR toolkit" | **Withhold all nine:** agents' tools are what they are today; `gh pr view` and `gh run view --log-failed` keep doing these jobs; `pnpm ship` stays the only way an agent merges. **Expose the three read-only ones** (read, list, CI logs): shippers get compact PR state and failing-log tails without parsing `gh`; about 1.5 KB more in every PR-role turn. **Expose all nine:** agents can merge by tool, which skips `pnpm ship`'s rebase, `vp check`, typecheck and unmarked-hunk sweep; a project's human-only merge policy (`.t3code/ship.json`) is then enforced only by role prose, since nothing on the server checks it; about 4.7 KB more per PR-role turn | Withhold all nine. One merge path with its gates; no Loom prose changes. The read-only three are a follow-up worth an eval (§8.3) | One list in `families.ts` and its test; minutes | |
| **Upstream's sender note on agent-sent messages.** Upstream now prefixes `[T3 Code: the agent in T3 thread "…" sent this message, not the user.]` (and scheduled-task and MCP variants) to messages that did not come from the human (#39306). Loom already labels every message by author (`[From your parent orchestrator (an agent)]`, `[Scheduled-task prompt, written earlier by the human]`, …), and its addendum tells agents to weigh a message by that first line | **Keep Loom's labels, skip upstream's note:** agents read exactly what they read today. **Take upstream's note and delete Loom's labels:** every role file and the addendum lose the anchor they are written around, and a human's message in a child thread is no longer labelled at all (upstream labels only non-human senders). **Run both:** every agent-sent, scheduled and tool-sent message carries two author lines, one above the other | Keep Loom's labels only. It is the only answer that changes no model-read text, and Loom's labels name every case upstream's note names (§4.3) | Two marked call sites; minutes. The reverse (adopting upstream's note) is a fleet-wide prompt change with evals, not merge work | |
| **The composer context meter.** Upstream deleted the small ring in the composer ("24% · 240k/1m"), its popover and its setting (#33131). Loom's meter is on by default and its popover holds the Compact button and Loom's workstream spend breakdown (own, subtree, per branch). That breakdown was built after Carl wrote, in the Post V2 bug-fixes thread, "We used to have the cost breakdown, including cost breakdowns for subthreads. That's all disappeared." Upstream's replacement is a "Context window" row inside the Thread details popover, off by default; Compact remains at `/compact` | **Keep the meter as a Loom-owned component:** nothing changes in the composer; its switch moves from the deleted Labs section to Loom's Context diagnostics settings rows. **Take upstream's deletion:** no ring; context usage takes a click and a setting; the subtree spend breakdown has no home (per-thread cost stays on workstream cards). **Take the deletion and re-home the spend block** in Thread details with that row on by default: context still takes a click. **Rely on the context-viz rail and tab alone:** pi threads only, only once opened, no spend breakdown | Keep it as a Loom-owned component (§6.1). It is the one place that shows context at a glance and the spend breakdown together; the cost is two Loom files and two marked hunks in composer files | Keep → delete later is a deletion (an hour). Delete → keep after the merge means re-porting the component from pull 15's tree (half a day), which is why S1 starts with "keep" | |
| **Translation lint on Loom's own surfaces.** Upstream translated the app into nine languages (English stays the default, so Carl sees no language change) and added a lint rule at error that rejects any plain English UI string (§5.1). Loom fails it 1,096 times in 121 of its own files plus 42 Loom lines inside upstream files; `vp check` runs it, so nothing commits or ships until it is settled | **Loom's own files stay English and are excluded from the rule; Loom strings inside upstream components are wrapped:** no visible change; a non-English user would see Loom's surfaces in English; nothing extra in future Loom PRs. **Wrap and translate every Loom string:** about 1,100 call sites now, and every future Loom PR with UI text regenerates twenty catalogue files of 0.3 to 1 MB that then conflict at every pull; the translated Loom UI has no reader today. **Turn the rule off:** not workable, because upstream's 78 suppression comments for it would then fail the unused-directive check | English-only, excluded. One marked block of path patterns in the root `vite.config.ts` and about 42 one-token wraps | The exclusion is one block; undoing it later means doing the wrap-everything option then | |
| **Agent issue tools.** Upstream's new Issues page (GitHub issues of the project, linked to threads) comes with eight agent tools: list, read, create, comment, set state, link, unlink, list a thread's issues. With no action they are listed to every Loom thread and every call fails for lack of a capability | **Withhold:** no agent change; Carl still gets the Issues page and linked issues in the UI. **Expose:** agents can read and link issues, but `create_issue` on the Loom project files straight into the public `QuinRiva/loom` repository, past the `report-loom-issue` skill's leak guard, labels and duplicate check, and it needs a new capability phrase (Loom prose, not allowed inside a pull) | Withhold now; decide exposure as a follow-up with the read-and-link subset in mind | One line in `families.ts` | |
| **Agent feedback tool** (`t3_feedback`, "agents can report T3 Code problems when you turn feedback on"). A report goes to the T3 team's analytics endpoint (`ingest.t3.codes`), not to Carl, and telemetry is on in the cockpit. The mode is off by default (Settings → Labs → Agent feedback); while off the tool is hidden | **Withhold and leave the mode off:** nothing changes. **Leave it listed:** if the Labs switch is ever turned on, the tool shows to Loom agents but refuses them (it needs a capability Loom threads do not hold); a `t3 feedback` run from a shell would send a report about a fork to upstream's maintainers | Withhold and leave off. A Loom problem goes through `report-loom-issue` | One line | |
| **Agent theme tools and `send_to_user`.** Upstream lets an agent read and set the app's theme colours and CSS (#35247), and adds `send_to_user` (a workaround for a Claude behaviour pi does not have). With no action `t3_theme_read` and `send_to_user` work for Loom agents; `t3_theme_set` is refused | **Withhold all three:** agents cannot repaint the app; Carl still themes from Settings. **Expose:** an agent can restyle the app mid-session; needs new Loom prose | Withhold. No Loom workflow needs them | One line each | |
| **A Pi session resumed in a different folder.** Rare case: a thread's worktree was moved or reaped and re-made. Loom resumes the same session file in the new folder through a private patch to pi. Upstream now handles it by copying the session into the new folder with pi's own `--fork` (#36586). Of 1,050 pi threads active since 8 Nov, none hit this case | **Take upstream's:** same history after a moved worktree; the thread gets a new session file on that first resume, which `$PI_SESSION_FILE`, context-viz and consults follow; Loom's pi patch 0001 is then unused and retired at the next platform update. **Keep Loom's override:** the same file is kept; the private patch stays. **Both:** upstream forks first, so Loom's line does nothing | Take upstream's and drop Loom's line (§6.3). It removes a dependency on a private pi patch for a case that did not occur in a fortnight | One marked line in `adapter.ts` and Loom's `cwdOverride` back in three recorded transcripts; an hour | |
| **Usage hub: which last-good-reading rule.** Loom carries an account's last good usage reading forward for up to 30 minutes when Anthropic refuses the read, never for a signed-out login, and never stale bars for the one-year token seat. Upstream added its own version with no age limit and no notion of sign-in (#38397). Both are in the merged tree | **Loom's only (plus upstream's identity check):** as today, and a reused auth-file name can no longer show the previous login's bars. **Both:** a signed-out account keeps its old bars and a healthy look, so Loom's "Signed out, log in again" alert never appears; the one-year seat shows bars hours old; an outage past 30 minutes stays invisible. **Upstream's only, with two Loom guards:** bars hold indefinitely under refusals and a browser login loses the windows its traffic headers lack | Loom's only (§6.4). Upstream's does less, and running both is a visible regression | Small: one function and one call | |
| **Opening a Loom child from inside a thread.** Upstream now opens subagent threads beside their parent, as a tab in the right panel with its own composer (#39515). A Loom child is such a thread, so a plain click on a child in Thread details' lineage list, or on "a child needs your input", opens it beside the orchestrator. Loom's own ways in (sidebar badge, workstream panel, control cards, `t3-thread://` chips) still navigate. ⌘-click navigates; Settings → Chat → "Open subagents and side chats in" switches the default | **Take upstream's:** child beside its orchestrator from those two places. **Exempt Loom children:** today's navigation for them, the panel for others; four marked lines. **Loom default "main view":** today's navigation for every side thread; one marked line | Take upstream's (§6.5). The usual ways into a child do not change and one setting reverses it | One to four marked lines | |
| **Node 26.13.1 on this host.** Upstream moved from 26.12.1 because 26.13.1's SQLite stores one JSON pattern differently; upstream fixed its own migration for it. This host is the cockpit machine, so `n 26.13.1` also moves the live cockpit, the Slack bridge and agent shells at their next restart. Nothing in the repo refuses 26.12.1 | **Upgrade before S3** (one command, reversible with `n 26.12.1`): S3 and the deploy build run on upstream's Node. **Download only, activate at deploy:** live services stay on 26.12.1 until then; every S3 command needs an `n exec` prefix. **Stay on 26.12.1:** works today; S3 then tests a runtime upstream no longer runs | Upgrade before S3, as pull 13 did ("Upgrade the host now, the VM at deploy"; they are now the same machine). Loom's migration 1066 gets the same one-line fix either way (§5.3) | None | |
| **Deploy #590 and #591 before this pull lands.** The cockpit runs the build before inline diff editing (#590) and Query author on any line (#591) | **Deploy `main` first:** the pull 16 deploy is then upstream-only, and a rollback returns to a build that has both. **Let them ride with the pull:** one deploy fewer; a rollback loses both features with the pull, and a regression is harder to attribute | Deploy `main` first | None | |
| **Diff changed-word highlight strength.** Loom marks the changed words inside a modified line as a solid block, GitHub-style (Loom #307). Upstream fixed the same underlying bug with a faint 15 to 20 % tint, declared where it overrides Loom's (#28947) | **Keep Loom's:** as today in the Diff panel, PR code tab, whole-file comparison and MDX `<Diff>` blocks; that one colour no longer follows the appearance contrast slider. **Take upstream's:** the faint tint returns; it follows the contrast setting | Keep Loom's: it was a deliberate change to the surface Carl reviews agent work on | Two CSS values | |
| **Phone: tapping a relative file path in a chat.** Loom shows a "Looking for…" toast, checks the folders the message names and says "File not found" in place. Upstream built its own lookup into the same function the same week: it searches the thread's project, then other projects, then the agent's working directories | **Run both, Loom's first:** nothing lost; paths only upstream resolves (a sibling project, a checkout the agent `cd`'d into) now open too. **Upstream's only:** loses the toast, the in-place not-found message and message-folder matching; removes about 280 Loom lines. **Loom's only:** loses upstream's wider search and re-conflicts every pull | Run both; revisit "upstream's only" in a later cleanup | About 15 lines in one file | |
| **Multi-repository projects.** A project can now cover several Git repositories (#35925). It only switches on for a project that has repositories inside its folder or folders added in Settings; no cockpit project qualifies, so the only visible change is an empty Repositories section in Settings → Projects. On such a project four Loom extras would stay single-folder: pi is not told about the other folders, Loom review and authorship cover only the thread's folder, start-of-run baselines cover only the root, and the setup-state file is not written when the project folder is not itself a repository | **Leave it reachable and unsupported:** nothing changes for today's projects. **Hide the entry points:** loses upstream's Repositories settings, `.code-workspace` offers and `--track`; marked lines to carry every pull. **Do the Loom work now:** large, and the pi part is prompt text | Leave it reachable (§6.6). Nothing Carl uses triggers it; the pi folder list is a follow-up | None now | |

### 8.2 Pre-rulings the runbook carries (not questions)

Standing rulings from pull 15's §8.2 are restated as amended; "new" marks a
ruling this pull adds because doctrine or a standing rule already decides it.

- **Lockfile:** take upstream's `pnpm-lock.yaml`, resolve `pnpm-workspace.yaml`
  and the four `package.json` files per B.1 **including the lines the merge
  dropped silently** (§5.4), then `vp i` until a pass leaves the lockfile
  unchanged (DL-1220). Never hand-merge the 56 hunks. The install brings Effect
  4.1.5 and the new mobile and i18n packages; nothing before it typechecks.
- **`Migrations.ts`:** upstream verbatim (it auto-merges and is byte-identical
  in the trial tree). Upstream adds **081 to 108** and edits 026, 064, 071, 072
  and 075 in place; none touches an object the fork lane or Loom runtime reads
  (§5.5). **No fork migration this pull.** One Loom migration file is edited:
  1066 wraps its two subqueries in `json((…))` (§5.3); it has already run on
  the cockpit, so the edit changes fresh and dev databases only.
- **Two-ledger migrator on upstream's new setup shape (new):** `Sqlite.ts`
  threads Loom's `runAllMigrations()` through both of upstream's setup paths
  (server and CLI), and the CLI path's "is anything pending" test also counts
  Loom's ledger, so a CLI from a newer release cannot apply a fork migration
  behind a running server (B.3).
- **Tool exposure (amended, was "unchanged"):** every new upstream toolkit is
  classified in `families.ts`; under the §8.1 recommendations all of them are
  withheld and `PULL_REQUESTS` is pinned to its nine base names (§4.2).
  `t3_submit_output` and upstream's own `tool_search` are withheld by
  construction. Loom threads keep the capability set `["workstream",
  "pull-requests"]`: the `McpSessionRegistry.ts` and
  `ProviderSessionManager.ts` hunks do **not** take upstream's wider union.
- **A Loom child may watch its own PR (DL-471), re-homed (new):** upstream
  moved the refusal into the new `pullRequest/PullRequestWatchService.ts`;
  Loom's exemption follows it there (§4.4). S1 writes it, Gate 1 reads it, S2a
  adds the test.
- **Pi's system prompt gets no orchestration instructions (DL-905), extended
  (new):** upstream's new `<pull_request_linking>` block (#31727) is stripped
  with them; `mcpExtensionSource.ts` hunk 7 is dropped although it is shaped as
  an upstream-only insertion (§4.3). A Loom-withheld tool stays hidden under
  upstream's new `mcp__t3_code__<name>` alias as well.
- **Model-read text:** no role file, addendum or Loom tool prose changes in
  this pull. Upstream's own tool descriptions change as upstream wrote them
  (about 34 existing tools, `request_secret` among them). Upstream's Reply
  action (#33124) is taken as shipped although its projected text names
  `t3_thread_read`, which Loom withholds from pi (§8.3). In `AGENTS.md`,
  upstream's auto-merged "Languages" bullet (translate every new key into
  every locale) is deleted rather than taken, since the merge itself would
  otherwise add a policy that contradicts the §8.1 translation ruling; the
  Loom sentence that replaces it is a follow-up (§8.3).
- **Text generation stays on pi through the hub:** `textGeneration.ts` keeps
  `disableExtensions: false` beside upstream's `shortLived: true`. **New:**
  `status.ts` skips upstream's `discoverPiTextGenerationModelSlugs` probe
  (#24110), which would otherwise mark every `cliproxy/*` model unable to
  generate text and hide it from the Settings picker (§6.4). Upstream's Text
  generators panel (#33147) is taken and stays empty.
- **Standing settings defaults:** `autoResumeLimitedThreads: true`; pi enabled
  by default and never in the disabled-by-default driver list; allow-list model
  fields (DL-913). `followUpBehavior: steer` is upstream's own default and
  needs nothing. **`contextWindowMeterEnabled: true` survives only under the
  §8.1 meter ruling, as a Loom-owned field** in `settings.loom.ts` with the
  same key; under the other answer the default is dropped. New upstream fields
  take upstream's defaults: `keepAwakeWhileAgentsWork: true`,
  `enablePreviewTunnel: true`, `confirmTerminalClose: true`,
  `speechStreaming: true`, `sideThreadOpenTarget: "panel"`,
  `agentFeedback.mode: "off"`, `promptSuggestionsEnabled: false`,
  `usageHistoryRetentionDays: 92`, `fastWorktreeCheckout: false`,
  `requireConnectDeviceApproval: false`, `language: "en"`.
- **`builtInDrivers.ts`:** Pi-only (standing); untouched upstream this
  fortnight. The three new workspace packages (`issue-tracker-linear`,
  `source-control-cursor-origin`, `source-control-tanstack-source`) are
  source-control drivers upstream registers itself; taken.
- **`ClaudeProvider.ts`: upstream's whole file (new).** Loom's eight lines
  there are an old Claude model catalogue nothing reads and a probe-kill hook
  for a driver Loom does not register; they and their two tests go (B.6, a DL
  row).
- **Superseded Loom hunks (doctrine §4.3), each a DL row when S1 deletes it:**
  `hasStrongNativeRef` in `Orchestrator.ts` (upstream's `hasNativeHistory`);
  Loom's re-keyed `defaultBranchCache` in `GitVcsDriverCore.ts` (upstream's
  #28815); HTML previews not reloading after commands (Loom #508, upstream
  #39736; Loom's image and PDF half stays); the diff "reveal these lines"
  request (Loom #581/#582, upstream #33989); `useThreadSyncError` (upstream's
  `useThreadError`); the DT-36 line-break hunk (upstream #33353); Loom's dead
  `noVerify` commit option and its scan-cache line.
- **Not superseded, both kept:** Loom's #527 (a finished Loom root stays
  unsettled while its PR is open) beside upstream's #38926 (an agent-held watch
  with `until: "merged"` keeps its thread Working). They cover different
  threads (§6.5).
- **Loom children settle with their parent (new, upstream's #19665 taken):**
  a child becomes a settlement candidate once its parent is settled, archived
  or deleted, and then settles at once. No carve-out. About five children
  settle on the first sweep after deploy.
- **Files tree folder memory:** both run this pull (Loom's per-thread memory
  and upstream's persisted one); folding Loom's onto upstream's is a follow-up.
- **Launcher protocol 3 → 4 (new):** an ordinary `loom-deploy deploy`. The new
  release accepts an installed protocol-3 launcher; S3 updates
  `launcherSeam.test.ts` to 4 and runs it (§6.7, For deploy).
- **Thread search** keeps Loom's index with upstream's surfaces (1065).
  `ThreadSearch.ts` conflicts this pull (three unions); upstream's new tests
  over its own index are dropped with marked notes (Rule T); 081 does not
  re-create what 1065 dropped (§5.5).
- **Rollup ruling** (DL-1715) and the cold-shell join (DL-1650): unchanged in
  rule; `ShellStream.ts` now conflicts (five unions, B.3).
- **`PreviewView` annotation survives unmount** (DL-1214): Loom's per-tab pick
  stays; upstream's in-page Find is taken, and its new `pickActive` state is
  renamed or rewired onto Loom's pick, since the two names collide (B.10).
- **"Star on GitHub" toast hidden** (DL-1725): `useComposerSend.ts` now
  conflicts; upstream's `recordPromptSent` import is dropped.
- **Mid-turn messages steer** (DL-1463); upstream adds that a slash command
  sent mid-turn waits (#40316) and `/clear` queues, both upstream's own.
- **React Compiler:** no `useMemo`/`useCallback` in web files (DL-1273).
  **Effect reasons:** every Loom `useEffect` keeps its per-site reason
  (DL-1605). **jsdom tests:** Loom's twelve-entry allow-list survived the
  silent merge of the root `vite.config.ts` (verified); `jsdom` stays.
- **`AGENTS.md` and `README.md` are Loom's files:** Loom's side in all seven
  `AGENTS.md` hunks; upstream's factual lines that auto-merged stay; upstream's
  "plain git clone shares `~/.t3/dev`" sentence is not ported (false in Loom).
  `README.md` loses the auto-merged "This installs the `t3` command" line.
- **Files that cannot carry a `// loom:` marker:** the list in pull 15 §8.2
  stands; no addition to `unmarkedsweep.allow` this pull. `routeTree.gen.ts`
  is **regenerated** (upstream added three routes). The three Pi replay
  transcripts take upstream's re-recorded versions under the §8.1 Pi resume
  ruling. `agentContextBudget.json` takes upstream's values and S2a re-measures
  (DL-1654). Loom's hunk in the deleted `@pierre/diffs` 1.6.1 patch moves into
  upstream's `patches/@pierre__diffs@1.7.0-beta.4.patch` (§6.9).
- **Translation catalogues:** upstream's, verbatim, at every pull; Loom never
  runs `i18n:generate` (§5.1).
- **Comment-prune collateral, quarantine, cockpit worktrees trusted via host
  config:** as pull 15.
- **`UPSTREAM_BASE`:** S3 sets it to `a09738fb435120d08707db0142ca55b3b7b5c7ec`.

Two standing rulings are retired because their subject is gone: the
`.repos/effect/.envrc` removal (not in this range) and pull 15's event-prune
guard (Loom moved workstream history into `loom_thread_history`, fork
migration 1070, on 10 Nov; `ProjectionMaintenance.ts` is upstream's file again
and upstream did not touch it).

### 8.3 Findings that need no ruling now

- **Expose the read-only PR and CI tools** (`pull_request_read`,
  `pull_request_list`, `ci_logs`) to shipper and orchestrator roles: a Loom
  prose and eval change after the pull. `ci_logs` is the one with a real edge
  over `gh`.
- **Issue tools for agents** (read and link only), and whether Loom bug filing
  stays on `report-loom-issue` alone.
- **One sentence for Loom's `AGENTS.md` on UI strings** (Loom's own UI text
  stays English, lives in the excluded paths, and a Loom string inside an
  upstream component is wrapped): model-read text, so its own PR under the
  `llm-instruction-change` rules after the pull. Until then the lint error's
  message is what tells an agent to wrap.
- **Reply to an assistant response** names a tool pi does not have. A Loom
  projection for `response` contexts (as DL-752 did for threads) is model-read
  text: a follow-up with evals. Cost today: one dead hint in the prompt.
- **A manual "regenerate title" can now retitle a Loom root** (#33987, #29383)
  although Loom keeps a Loom thread's title on send (DT-67). S4 looks once; a
  marked guard if Carl wants it.
- **Upstream's pull request linking rules for pi agents** (#31727): kept out
  under DL-905; whether Loom wants its own version is the old
  `link_pull_request(s)` prose follow-up.
- **Hub routing for pi threads:** upstream's routed hub pool on the thread card
  (#30778) and hub reset times for limited turns (#36238) apply only to
  providers with a custom endpoint, so pi threads do not get them. Giving the
  pi snapshot the hub's endpoint would.
- **Port `questionSummary` to upstream's Words renderer** so remark leaves the
  main web bundle (it stays in the MDX chunk); move Loom's chip tooltips onto
  upstream's shared tooltip.
- **Multi-repository follow-ups:** the folder list in pi's prompt; change
  review across tracked repositories; a foreign-home guard on
  `TaskFolders.remove`.
- **Search:** let Loom's index read 081's `search_text` (a fork migration and a
  rebuild), so quoted citations are searchable as words; consider dropping
  Loom's `loom_turn_items_tool_calls_idx`, which upstream's 088 mostly
  duplicates.
- **Goals after a socket resume:** a goal edited while a client was away stays
  stale until the next full snapshot. Older than this pull; upstream's cheaper
  resumes (#35071) make it more frequent.
- **Settings → Reclaim database space** (#32941) cannot run on the cockpit
  (the database already shrinks incrementally and the button refuses); hide it
  or leave it.
- **`deploy/README.md`'s "A launcher protocol change" paragraph** describes a
  refusal that does not happen for 3 → 4; S3 rewrites it with the seam test.
- **Loom's CI has cancelled every run since July**, so no CI-only check
  (`i18n:check`, knip, GraphQL generate) protects Loom; three new upstream
  workflows (`pr-limits.yml` with a daily cron, `issue-vouch.yml`,
  `mobile-dev-client.yml`) become active on the fork at merge.
- **`AGENTS.md` says the cockpit database is over 10 GB**; it is 4.73 GB.
  A model-read line to correct after the pull.
- **Pull 15's open follow-ups did not become merge work**, except the
  `link_pull_request(s)` prose one (decided at the `mcpExtensionSource.ts`
  conflict, above). Still open as they were: consult cards folding in runs over
  150 tool calls; the model picker's fixed height (DL-1716); the fast-mode
  draft-pick edge (DL-1720; `composerDraftStore.ts` and `shared/model.ts`
  merged silently again, Gate 2 reads them); jsdom MDX tests to browser tests
  (DL-1474); `scripts/build-npm-launcher.ts`'s migration head; thread tags
  against Loom's sidebar badge; Copy thread's hosted link. The tool-call
  visibility setting moved from Labs to main Settings: S4 checks `zen` as well
  as `hideAll`.
- **Retired by Loom since pull 15:** the workstream-history projection
  follow-up (done, migration 1070).
