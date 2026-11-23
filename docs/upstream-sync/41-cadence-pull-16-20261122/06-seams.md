## 6. Other seams, read and recorded

Each subsection says what upstream did, what it meets in Loom, and the
verdict. The per-hunk resolutions are in the Appendix B zone file each names;
a row for Carl is named by its §8.1 title.

### 6.1 The composer context meter and the Labs cleanup

Upstream's Labs cleanup (#33131 `521ac7c218`, 87 files, touches 20 conflicted
paths) deletes three client settings (`planModeEnabled`,
`contextWindowMeterEnabled`, `legacySidebarEnabled`), the legacy Build/Plan
toggle with `/plan`, `/default`, Shift+Tab, the "Plan ready" banner and the
Implement-plan sends, and the composer's context-window ring with its logic
file. It moves tool-call visibility from Labs to Settings → Chat → Activity
(same setting, default Show all).

| Loom thing | Depends on what upstream removed? | Verdict |
| --- | --- | --- |
| Plan lanes (`thread.plan-lane-set`), MDX plans, `plans/` documents, `LoomAutoOpenSettingsRows` | No: they share the word only. The "plan auto-open exception" in `docs/architecture/loom-ui-state-tiers.md` was retired in pull 6 | Nothing to do. `AGENTS.md`'s phrase "the retained plan-auto-open exception" is stale (a model-read line; follow-up, not this pull) |
| Loom's slash commands `/handoff`, `/retro` in `composer-logic.ts` | The type they extend lost `"plan" \| "default"`; upstream deleted `parseStandaloneComposerSlashCommand` | B.11: keep Loom's two members on upstream's shorter list; **drop** the deleted function although it sits on Loom's side of an `o` hunk |
| **The composer context meter** (`ContextWindowMeter.tsx`, deleted upstream, modified by Loom: one of the two UD paths), its default `contextWindowMeterEnabled: true`, and `LoomContextSpend` inside its popover | Yes, wholly | §8.1 "The composer context meter". Under the recommended answer it becomes a Loom-owned component (below) |
| Loom's context-viz rail and Context tab (#515, #525) | No: they read turn items, not the meter | Unaffected |

**The meter kept as a Loom-owned component (the recommended answer), by
session.** S1 lane 6 writes Loom's version of
`apps/web/src/components/chat/ContextWindowMeter.tsx`
(`git show origin/main:<path>`, 184 lines) to
`apps/web/src/loom/ContextWindowMeter.tsx` and takes upstream's empty side of
the `settings.ts` hunk; the lead stages upstream's deletion of the old path
at close (§7.2: only the lead touches the index). S1 lane 4 keeps Loom's meter lines in
`ChatComposer.tsx` (hunks 1 and 2) and `ComposerFooterControls.tsx` (hunks 1
to 3), pointed at `~/loom/ContextWindowMeter`, and restores the import
upstream deleted outside the markers (B.9). S2b finishes it: a
`contextWindowMeter.logic.ts` beside the component with the four functions it
and the composer need (`formatContextWindowCost`, which exists nowhere
upstream; `shouldReserveContextWindowMeter`;
`resolveContextWindowModelDisplayName`; the old two-argument
`formatContextWindowCompactionMessage`, whose upstream replacement in
`compaction.logic.ts` takes `(threshold, resolve, locale)`);
`contextWindowMeterEnabled` (default `true`, same key so existing opt-outs
survive) in `LoomClientSettingsFields` and `LoomClientSettingsPatchFields` in
`packages/contracts/src/settings.loom.ts`; its switch in
`apps/web/src/loom/context-viz/ContextVizSettingsRows.tsx`; the data path
(`deriveLatestContextWindowSnapshot`, now in
`@t3tools/client-runtime/state/contextWindow`, threaded ChatView →
ChatComposer → ComposerFooterControls, about 60 lines); `onCompact` wired to
upstream's surviving `compactThreadContextStable`; the fixture line in
`apps/desktop/src/settings/DesktopClientSettings.test.ts`; and the four user
docs naming the new switch location (B.1). Under the other answer, lanes 4
and 6 take upstream's side throughout, `LoomContextSpend` loses its only
mount, and the DL-1712 sentences in the four docs are replaced by upstream's
paragraphs.

**The other deleted file: the `@pierre/diffs` patch.** Upstream moved
`@pierre/diffs` to 1.7.0-beta.4 with its own patch
(`patches/@pierre__diffs@1.7.0-beta.4.patch`) and deleted the 1.6.1 patch
Loom had edited (#33627, #36974). Loom's one-line edit (PR #590: an edit
session anchors the viewport before dropping measured wrapped-row heights, so
the first keystroke in a wrapped file does not jump the view) is still wanted
on 1.7: the method it patches still drops heights with no anchor on the exit
path. pnpm takes one patch per package version, so **Loom's hunk goes into
upstream's 1.7 patch file** (the S1 lead stages the UD path as deleted at close; S2b
adds the line `this.getAdvancedVirtualizer()?.capturePendingLayoutAnchor();`
at the top of `invalidateEditSessionLayout` in
`dist/components/VirtualizedFileDiff.js`, re-cuts the patch and re-runs
`vp i`; both methods exist in 1.7). S4's inline-editing journey (§9) is the
proof either way.

New settings at the target and their defaults are listed in §8.2. Three act
on the cockpit without anyone touching them: `keepAwakeWhileAgentsWork: true`
(runs `systemd-inhibit` while agents work; harmless on a VM),
`enablePreviewTunnel: true` (the tunnel existed; the switch is new and
defaults to the old behaviour), `usageHistoryRetentionDays: 92` (the Usage
page reads at most 92 days back).

### 6.2 The markdown renderer was replaced

Upstream replaced the chat's whole markdown renderer (#27866 `0fb6ac6e65`,
101 files, 18 conflicted paths). Every assistant message, PR body, notebook
and file preview is now parsed by Words (`@pierre/words`, a tarball in
`apps/web/deps/`), turned into a sanitised tree by
`apps/web/src/markdown/wordsHast.ts`, and painted as static HTML. Only
"islands" are still React components: links, images, code blocks, tables,
file-chip inline code, skill and model chips, alerts, task checkboxes. Chats
scroll and stream visibly cheaper.

| Loom extension in `ChatMarkdown.tsx` | How it attached before | After the merge | Verdict |
| --- | --- | --- | --- |
| File chips with existence checks, in-fence path links, `t3-thread://` mentions (`ThreadMention`), the document-follows-author open, consult cards | `components={{…}}` overrides | Islands upstream still renders through `CHAT_MARKDOWN_COMPONENTS` | Ordinary hunks; Rule D with Appendix D's map |
| **Project ticket and PR links in chat** (`ABC-123`-style, `remarkReferenceLinks`) | a remark plugin | The new renderer has no plugin list | **A port, not a re-apply:** a field on the renderer options and a three-line hook beside upstream's PR autolinks in `wordsHast.ts`; about 40 lines and a unit test. The remark plugin stays for MDX documents. S2b |
| **Loose path links in prose** (bare `apps/web/x.ts` text, `rehypeChatFilePaths`) | a hast transform | No transform list | **A port:** a flag on the renderer options, the transform run after upstream's sanitise step, one new island case; about 25 lines. S2b |
| The MDX `<Code>` block (`files/mdx-plan/blocks/code.tsx`) | `createMarkdownRenderer({ remarkPlugins, rehypePlugins })` and `react-markdown`'s `defaultUrlTransform` | API changed | **A port:** about 15 lines; then `react-markdown` leaves the manifest (§5.4). S2b |

S1 lane 4 resolves `ChatMarkdown.tsx`'s eleven hunks onto upstream's shape.
Loom's two plugin lines have no home there, so lane 4 drops them with a DL
row that hands the two ports to S2b (chat reference links and loose path
links are off between S1's commit and S2b's; nothing else depends on them). The MDX
plan, recap and explainer renderer keeps its own remark pipeline and is
otherwise untouched; the dependencies it needs are §5.4.

**The preview harness** (`apps/web/src/preview/**`, Loom-only) still
reproduces the timeline layout chain: every wrapper and class it copies
(`data-chat-canvas`, `.messages-timeline-scroll`,
`.messages-timeline-row-frame`, `@container/chat-lane`,
`TIMELINE_ROW_CLASS_NAME`) exists in upstream's `MessagesTimeline.tsx` and
`ChatView.tsx`, and `ChatMarkdown` now provides its own tooltip provider. The
screenshot pass S2b owes is in §9; the harness cannot show reference links
(no backend rules), so one `ABC-123` link is checked live.

Other upstream changes behind the web-chat hunks: Reply to an assistant
response (#33124, §4.3), @-mention a model (#31207; `@`, no collision with
Loom's `!` thread menu), next-prompt suggestions (#28047; Labs, off, and inert
for pi), linked-environment thread chips (#39406, #34657; only for threads on
another machine), upstream's fix for line breaks in pending-question text
(#33353, which supersedes Loom's DT-36 hunk), the "Could not sync messages"
line (#24583, which supersedes Loom's `useThreadSyncError`). Zone file:
[B.9](b09-web-chat.md).

### 6.3 The Pi adapter and provider core

Loom is Pi-first, so these hunks get per-hunk care (67 markers in 22 files;
[B.6](b06-providers.md), which also lists all 42 upstream commits to
`packages/provider-pi`). Upstream rebuilt how a pi session starts and resumes
and taught the adapter about pi's newer extension features, without asking
for a newer pi: every feature runs on Loom's bundled pi 1.5.1 (upstream
supports `>=0.84.3`). All 94 `loom` lines of `adapter.ts` survive as text in
the trial tree, but six sit on code upstream moved, so they would merge wrong
rather than missing. Gate 1 reads each of these:

| Trap | File | What goes wrong on the obvious resolution | Resolution |
| --- | --- | --- | --- |
| `reportedError` reads `event` before its declaration | `ProviderSessionManager.ts` (silently merged part, trial l.3020) | upstream renamed the callback parameter to `nativeEvent` and added a later `const event`: a use-before-declaration (TS2448; a runtime error if it compiled) | use `nativeEvent` in Loom's line (DL-1624) |
| The resume sanitiser misses most resumes | `adapter.ts` | Loom's sanitiser (3c-2) runs before `switch_session`, but upstream now resumes by spawning `pi --session <file>` and skips `switch_session`; codex-shaped tool ids reach an Anthropic resume again | run the sanitiser before the spawn as well; Loom's `loom: input.loom` launch option moves into the new `startConnection`. S2a adds a test that a spawn-time resume runs it |
| Every hub model is marked unable to generate text | `status.ts` | upstream #24110 probes with `--no-extensions`; every `cliproxy/*` model is registered by an extension | skip `discoverPiTextGenerationModelSlugs` (§6.4); pass `promptTemplates` through the new `readPiInventory` |
| Orchestration and PR-linking instructions return to pi's prompt | `mcpExtensionSource.ts` hunk 7 | the hunk is shaped as an upstream-only insertion | drop it (DL-905, §4.3) |
| Withheld tools become callable by alias | `mcpExtensionSource.ts` hunk 6 | upstream's alias activation runs before Loom's hidden-tool check | Loom's check first (§4.3) |
| `parsePiModelSlug` is gone (#32585) | `apps/server/src/loom/textGeneration/piOneShot.ts` l.15, l.71 (Loom-only, no marker) | compile break in Loom's one-shot generation (goal titles, handoff and retro drafts) | `resolvePiModelSlug(model, undefined)`, plus `shortLived: true` on its launch. S2a |

Other verdicts: no new capability flag is required on Loom's driver (all new
ones are optional; upstream already sets pi's `supportsNativeResume: false`,
which hides Resume after a stopped run, and `backgroundTasksEndWithProcess:
true`). The three recorded Pi replay transcripts take upstream's re-recorded
versions under the §8.1 "A Pi session resumed in a different folder" answer
(Loom's only change in them was `cwdOverride` on `switch_session` frames, and
upstream's no longer have any); `fixtures/simple/pi_output.ts` takes
upstream's loop plus Loom's `costUsd` strip;
`PiReplayFixtures.integration.test.ts` reads all four. `ClaudeProvider.ts`
takes upstream's whole file (§8.2). `builtInDrivers.ts` is untouched upstream
and still Pi-only. #31207 (@-mention a model) and #26959 (ACP runtime notes)
change nothing a pi agent receives. One interaction to watch after deploy:
Loom's code that ends dangling tool calls when pi dies usually stops
upstream's new "background work was cancelled" note and auto-continue
(#40170) from firing; when upstream's does fire, Loom's error-resume stands
down. S4 kills a pi process mid-tool once and expects exactly one resume.

### 6.4 Text generation and the usage hub

**Titles, commit messages and PR descriptions keep generating through pi and
the hub** (`cliproxy/claude-sonnet-5-5` on the cockpit) with no settings
change. Upstream's "text generators" (#33147: direct OpenAI, Anthropic or
OpenAI-compatible APIs under Settings → Providers → Text generators) are
additive and empty by default; the pi path still exists and is still called.
The catch is #24110 (`817b92f13a`): it marks any pi model that only an
extension registers as unable to generate text, and every `cliproxy/*` model
is registered that way. The server still falls through to the stored model,
but the Settings picker would hide every hub model, show a directly signed-in
pi model instead, and save that one on the first edit, after which titles
silently leave the hub. Pre-ruled (§8.2): one marked line in `status.ts`
skips the probe, which also saves a `pi --no-extensions` process per status
probe. Adopting upstream's direct generators instead would break Loom's goal
titles and handoff duplicate detection, whose one-shot refuses any selection
that is not pi; trying one against the hub is a follow-up.

**The usage hub.** Upstream now builds on the same CLIProxyAPI hub Loom does.
`cliproxyApi.ts` is Rule D again: upstream split hub reads into a
per-provider `HUB_PROVIDERS` table with `readAccount(hub, account, provider)`
and Loom's delta re-applies around it ([B.7](b07-usage.md); hunks 4 and 5 are
mostly base code upstream moved, so keeping Loom's side would duplicate the
Claude and Codex reads). No Loom usage feature is replaced: hub login
detection and notices, the one-year-token rule, the pooled view, the usage
ledger and top-thread spend, the exhaustion marks and auto-resume all stand.
One upstream feature collides and is a row for Carl (§8.1 "Usage hub: which
last-good-reading rule"). Two smaller points: upstream's new per-account
failure notice (#36939) would duplicate Loom's dead-account rows, so one
marked condition suppresses it for signed-out logins; under the recommended
answer the one-year token seat newly shows one true line ("cannot read its
usage, and the hub has seen no traffic for 30 minutes") when idle. Upstream's
routed hub pool on the thread card (#30778) and hub reset times (#36238) key
on a provider's custom endpoint, which pi does not set, so they are inert for
Loom's threads (§8.3). The provider-status stream that `ws.ts` carries only
gained fields; Loom's exhaustion overlay still composes (B.4).

### 6.5 Loom children: opening, settling, delegation, linked environments

Zone file: [B.2](b02-orchestration.md). Re-derived from the code at the
target, not from earlier runbooks:

- **Upstream's delegation machinery is still inert for Loom children.**
  `app_owned` task records come only from `dispatchDelegatedTaskRequest` (the
  `delegate_task` path, withheld). Loom's `makeLoomChildThread` writes
  `forkedFrom: null` and emits no task records. Every new subagent predicate
  in range keys on `forkedFrom.type === "node"`, `delegatedTaskId` or
  `creationSource === "provider"`, except the two below. `callLoomTool` still
  calls `requireWorkstreamCaller` first, and OAuth and thread-less callers
  are still refused (their scopes never carry `workstream`).
- **Opening (#39515):** a Loom child clicked in Thread details' lineage list
  or on the parent's "a child needs your input" item opens as a tab in the
  parent's right panel. §8.1 "Opening a Loom child from inside a thread".
  Mobile is unchanged for Loom children.
- **Settling (#19665, new in range):** a subagent-lineage thread is a
  settlement candidate only once its parent is settled, archived or deleted,
  and then settles at once whatever the auto-settle settings say. Today a
  child settles after five idle days or when its own PR merges. Carl will
  rarely notice: children have no sidebar row and Loom's rollup reads
  outcomes. Taken (§8.2). The clause sits in `ProjectionStore.ts`
  `getSettlementCandidates`, silently merged beside Loom's `loom.blocking`
  line; Gate 2 reads it with `ThreadSettlementService.ts` hunks 3 to 5.
- **#38926 does not supersede Loom's #527.** #38926 shows a thread as Working
  while its agent holds a watch with `until: "merged"`; #527 keeps a finished
  Loom root unsettled while its branch PR is open with no watch at all. Both
  kept. Side effect of the union: #527 now also needs auto-settle configured
  (the cockpit has `sidebarAutoSettleAfterDays: 5`).
- **Typed turn results (#38874, `t3_submit_output`)** are per run and
  schema-validated; Loom's `workstream_submit` is per thread with an outcome
  the control plane routes. Withheld by construction; a follow-up idea only.
- **Linked environments (#39406, #39439, #34721)** sit behind
  `linkedEnvironmentsEnabled`, off by default and unset on the cockpit.

`Orchestrator.ts` has 13 hunks (one row each in B.2): mostly unions; Rule D in
hunks 5 (Loom's `start_if_idle` block re-applied after upstream's
`resolveMessageDispatch`) and 12 (keep Loom's `sourceRun?.status ??
"completed"`); hunk 2 superseded (`hasStrongNativeRef`, with its silently
merged call site at trial l.8624). Pull 15's rulings DL-1805 and DL-1812
stand on the new shape. Two silently merged Loom lines must be edited by
hand: `ThreadDeletion.ts` around l.202 (`stopped || error → continue` undoes
upstream's #34199; make it `stopped` only) and
`LegacyV1ThreadImporter.ts:787` (`messageEvents(message)` needs `importedAt`,
#30823).

### 6.6 Multi-repository projects and the VCS plumbing

Zone file: [B.8](b08-vcs-project-workspace.md). #35925 (`60863edc41`, 236
files) lets a project cover several Git repositories. It is on with no flag,
but only switches on for a project with repositories inside its folder, a
folder added in Settings → Projects → Repositories, a `.code-workspace` file
or a `worktreeLayout`. Every live cockpit project was walked: none qualifies.
`workspaceRoot`, `worktreePath` and the runtime `cwd` stay single strings; a
project gains `trackedFolders` (migration 104) and a worktree thread of a
multi-repository project works in a task folder (migration 105). Loom's 11
non-test readers of `worktreePath ?? workspaceRoot` compile and behave
identically on a single-repository project. §8.1 "Multi-repository projects".

The merge work here is VCS plumbing, and its traps are `B` hunks (Loom's side
empty) that are not upstream-only insertions but **duplicate declarations**:

| File | Trap | Resolution |
| --- | --- | --- |
| `GitVcsDriverCore.ts` | a `B` hunk puts back upstream's `defaultBranchCache`, which Loom had deleted and re-keyed: the trial declares it twice and references a constant Loom's side deleted | upstream's cache; Loom's re-keying is superseded by #28815 (revert Loom's key class, invalidate call and batch lookup; DL row) |
| `VcsStatusBroadcaster.ts` (Loom's per-repository batch poller, DL-1614) | two `B` hunks duplicate `refreshLocalStatus` and `makeRemoteRefreshLoop`; silently merged upstream code calls `refreshRemoteStatus`, which Loom does not define | keep upstream's copies; Loom's batch call goes inside upstream's new `refreshRemoteAndLocalTotals`, so client refreshes keep the branch-list digest |
| `migrate-dev-db.ts` | a `B` hunk redeclares an error class | take only the new legacy-source error class; port the legacy-thread guard (0 of 4,340 legacy threads on the cockpit trip it); replace `wrapPhase`, which would bury the error upstream's test checks |
| `WorkspaceFileSystem.ts` | upstream's `truncated` line merged silently above the markers | point it at Loom's `maxBytes` |
| `WorkspaceSearchIndex.ts` | upstream made `execute` return a Promise (#36273) | wrap Loom's synchronous `finder.glob`; the freeze upstream fixed stays possible on that one path (follow-up) |
| `scripts/dev-runner.ts` | a `B` hunk of 10 upstream lines redeclares `const path` and would unset Loom's port-scoped home | drop them; port upstream's live-home guard to desktop mode only. All 16 `loom` lines in the silently merged parts survive (port derivation, `--no-seed`, `T3CODE_DEV_SEED`, `--share`, the home rules) |

Two silent-merge defects that no conflict lists (Gate 2 reads; S1 lane 3
fixes): in `CheckpointService.ts` Loom's start-of-run baseline capture landed
before upstream's "skip after repeated timeouts" check (#29196), so slow
repositories would delay turn starts again; in `CheckpointStore.ts`
upstream's new `captureHeadCheckpoint` writes refs without Loom's
foreign-home guard. And `task_folders` joins `PER_INSTANCE_TABLES` (§5.5).
`AssetAccess.ts`: keep Loom's file revision on the non-HTML branch (it is
what stops image and PDF previews reloading after every agent command;
upstream's #39736 covers HTML only).

### 6.7 Remote access, auth, the launcher and the Slack bridge

Zone file: [B.4](b04-server-entry.md). **Nobody who reaches the cockpit today
has to do anything after this pull.** Browsers, the phone app and the Slack
bridge stay signed in.

| Upstream change | What it is against the cockpit's setup | Verdict |
| --- | --- | --- |
| #36419 require approval for new T3 Connect devices (migrations 090, 091) | Covers only devices that come in through T3 Connect, upstream's cloud relay. Of the cockpit's 197 sessions and 387 pairing links none is a `cloud-connect` row. Off by default (`requireConnectDeviceApproval: false`) | Inert. Existing rows default to "no approval needed" |
| #37823 restrict relay configuration and token destinations | A new `relay:configure` permission for setting up T3 Connect | Inert; the dev credential and `--share` are unaffected |
| #39415 preview tunnel setting | On by default, as before the switch existed; Loom's `preview_*` agent tools drive the headless browser on the host and do not use it | No change |
| #33196 "use T3 Code in another app (MCP)" | A wizard over the `/mcp` and OAuth endpoints the cockpit already exposes on the tailnet; one new route, `/oauth/mcp/revoke`. Cloud assistants need T3 Connect | New UI only; Loom's refusals of outside callers hold (§6.5) |
| #39921 sign in to an agent's MCP server from its warning | Claude and Codex threads only | Inert for pi |

Lock-out recovery still works: `node apps/server/src/bin.ts pair` mints a
token for the running server, and a token-paired device never waits for
approval.

**Launcher protocol 3 → 4.** Upstream raised
`SERVICE_LAUNCHER_PROTOCOL` to 4 (`apps/server/src/cloud/serviceProtocol.ts`)
and made the new code accept an installed protocol-3 launcher
(`SupportedLauncherProtocol = 3 | 4`). Traced through the old server's
preflight, the old launcher and the new runner: nothing refuses the switch,
`loom-deploy back` runs the previous release's own adopt, and the protocol-4
launcher rewrites the systemd unit only under conditions Loom's unit does not
meet. So the deploy is an ordinary `loom-deploy deploy`, whose failure mode
is the automatic put-back (§8.2), not the hand procedure `deploy/README.md`
describes. **S3** changes `launcherSeam.test.ts`'s assertion to 4, runs it,
rewrites the README paragraph and, if it can, runs the seam once with the
launcher from the running release (`6be88bb`), the pairing the cockpit will
actually hit and no test covers.

**The Slack bridge** needs no deploy first. All 11 names it imports from
contracts and all 6 RPCs it calls exist at the target with the same names and
scopes; the commands it builds gained only optional fields; its session is
not T3 Connect; Effect 4.1.3 to 4.1.5 has no breaking change in the modules
it uses. The runner restarts it after the new server starts.

**Traps in the files:** `http.ts`: upstream dropped the prefix list that kept
signed URLs out of traces and now redacts route parameters; if Loom's APK
line is simply dropped the APK token lands in spans and request logs, so the
redaction moves to the APK route in `loom/http/loomAgentRoutes.ts` as
`{ redactedParams: ["*"] }`. `ws.ts` (five hunks): hunk 2 takes upstream's
`snapshot-required` branch and keeps `enrichmentAndGoals`; hunk 4's Loom side
is only a tombstone comment; hunk 5 keeps Loom's exhaustion overlay and adds
upstream's new third argument `catalogDigests`. Loom's deploy leans on
`serviceLauncher.ts`, `cloud/serviceProtocol.ts`, `cloud/selfUpdate.ts` and
`cloud/pinnedRuntime.ts` without editing them; upstream changed them, hence
the seam test.

### 6.8 Projection store, shell stream and search

Zone file: [B.3](b03-store-shell-search.md). Upstream spent the range making
store reads and the client's connect cheaper: the thread list shows while the
socket opens and a reconnect with fresh cached rows resumes in a few bytes
(#35071); long threads open 2.5 to 10 times faster (082, 094, 095); the cold
shell stops walking finished tool calls and counts items from count tables
(085, 102); the active shell index reads from a covering index (098); writes
move to a worker thread (#35728); a failed thread search says so (#38155).
None of it replaces a Loom feature. Every Loom line in the 11 files survives
as a union or a re-apply: the cold-shell join for flagged children
(DL-1650/DL-1404), the open-question filters, `decodeMessageRows`, the
tool-output-image attachment ids, the goal, consult and cache stream items,
`cache_size`, and the search rebuild after `VACUUM`.

Two traps in `ProjectionStore.ts` (ten hunks, one row each): hunk 9 keeps
upstream's `CASE … pullRequests[0]` and **drops** the old `OR
EXISTS(json_each …)` on Loom's side, or every active thread's payload is
parsed again and 098's covering index is defeated; hunks 5 to 7: upstream
moved the attachment-id read into a fork-aware `runAttachmentIds`, Loom's two
tool-image lines move there, and keeping Loom's side of hunk 6 would run the
guest-files query twice. `ShellStream.test.ts` keeps Loom's payload helper
(upstream's sends no `startedAt`, which crashes Loom's
`isLoomStepBoundary`). `Sqlite.ts` and `DatabaseMaintenance.ts`: §5.5.

**Search: the standing ruling holds.** Loom's index searches titles,
purposes, briefs, reports, goals, tasks and messages (69,471 documents) of
all 7,531 live threads, archived ones included, credits a sub-thread's hit to
its root and fuses a semantic ranking over 1,009 top-level threads.
Upstream's searches messages of about 650 active top-level threads, newest
substring hits first. Every upstream search improvement in range lands in its
own message search, which no Loom user reaches.

For S3: Loom's cold-shell join costs about 4 ms on the live cockpit (22 ms
without, 26 ms with, over 5,269 active threads). S3 times the first trimmed
shell read after boot against pull 15's 2.6 s / 2.83 MB / 474 threads, checks
`EXPLAIN QUERY PLAN` on the shell index query uses the new covering index
with Loom's join, and sees one reconnect come back `resumable`.

### 6.9 Web panels: files, diff, right panel

Zone file: [B.10](b10-web-panels.md) (70 markers, the heaviest web zone; 18
of the fortnight's 28 Loom PRs touch 32 conflicted paths, most of them here,
so these hunks are days old and have no earlier resolution to copy). No
`loom`-marked line was silently dropped in the 19 files. What to act on:

- **Right-panel store version → 17.** Loom and upstream each took versions 15
  and 16 of the same persisted key (`t3code:right-panel-state:v2`) for
  different shape changes. Left at 16, the merged normaliser never runs on
  Carl's saved layout and a saved side-chat tab stays in a kind the merged
  build cannot show. At 17 it runs once: side-chat tabs become thread tabs,
  old graph tabs become the Workstream tab, unknown kinds drop, a closed
  panel stays closed. Loom's seed-not-override openers hold.
- **Superseded, Loom's copy goes (DL rows):** HTML previews not reloading
  after commands (Loom #508 → upstream #39736); the diff "reveal these lines"
  request (Loom #581/#582 → upstream #33989); Loom's unknown-tab drop in the
  saved-layout conversion.
- **Moved hosts:** Loom's guard that keeps a thread's branch in step with its
  own worktree moves into upstream's new `ThreadGitActionsControl`;
  `SingletonSurfaceKind` gains upstream's `issue`, `thread` and
  `linked-thread` and loses `side-chat`; `FileChangeView.tsx:682` (Loom-only)
  drops the deleted `onRevealSearchMatch` prop and passes the now-required
  `onFileCollapsedChange`; the trial `DiffPanel.tsx` declares `latestTurn`
  and `branchDiffPreview` twice (hunks 2 and 4 fix that).
- **Rule D:** `rightPanelStore.ts`, `GitActionsControl.tsx`,
  `markdown-links.ts`, `DiffPanel.tsx` hunks 4, 8 and 13,
  `FilePreviewPanel.tsx` hunks 9 and 14, `FileBrowserPanel.tsx` hunks 6 to 8,
  `diffRendering.ts`.
- **Inline diff editing (#590) should survive a plain resolution:** every
  `@pierre/diffs` API it calls has the same shape in 1.7.0-beta.4 (checked
  against the npm tarballs). The patched behaviour is §6.1.
- **§8.1 rows:** "Diff changed-word highlight strength". Files tree folder
  memory runs both (§8.2).

Upstream's built-in diff find collides with nothing (Loom never had its own);
PR deep links (#33989) likewise. #35247 (agent theming) does not touch
`index.css`; that file's one conflict is upstream deleting a three-line KaTeX
rule beside Loom's 133-line block, and every Loom selector still matches.

### 6.10 Sidebar, thread row, palette and routes

Zone file: [B.11](b11-web-sidebar.md). Upstream did not change how Loom's
workstreams show in the sidebar: subagent threads are still left out of
upstream's lists, so the root badge (`4/9 · 1!`), the flagged-row pill, the
side-thread sub-rows and the goal submenu keep their places and nothing
duplicates them. What Carl notices is upstream's redesign of the row: the
second line shows the machine name instead of the git branch (#40736; the
branch moves to the hover card), rows gain linked-issue chips (#38282),
titles shimmer while they regenerate.

Upstream deletions dressed as Loom hunks (drop them): `ThreadWorktreeIndicator`
in `ThreadStatusIndicators.tsx` (keep only Loom's `export` on
`ThreadStatusLabel`); `parseStandaloneComposerSlashCommand`
(`composer-logic.ts` hunk 2); `{accessibleTitle}` (`SidebarThreadRow.tsx`
hunk 8); the branch line, scratch-machine line and `remoteMachineIcon`
(hunks 3, 4, 6); `<ThreadContextDragGhost/>` (`Sidebar.tsx` hunk 2, moved
into `CommandPalette.tsx`). Rebuilt on upstream's structure: `__root.tsx`
(Loom's three hosts go into upstream's new `appHosts` fragment) and
`_chat.tsx` (state moved into `useShownThreadRouteTarget`). One compile break
in silently merged code: upstream's context-menu call passes a third `source`
argument (#37727) through Loom's `showWithLoomGoalMenu`, which takes two;
`apps/web/src/loom/sidebarGoalActions.ts` forwards it (S2b). The two
`Sidebar.logic.ts` exports the lost-declaration check reports
(`isSidebarHiddenThread`, `resolveSidebarRowThreadId`) were upstream's own;
their replacements are `isShownUnderParent` and
`resolveListedAncestorThreadRef` in `@t3tools/client-runtime/state/threads`,
and the only uses are in conflicted hunks. `useThreadSyncError` is superseded
by upstream's `useThreadError`; its one consumer, `chat/ThreadNow.tsx`, is in
lane 4 (§7.3).

### 6.11 Mobile, and client commands as Effects

Zone file: [B.13](b13-mobile-client.md). Upstream changed `apps/mobile` in
459 commits (an Issues tab, localhost links opening on the phone, selecting
and citing assistant text, guest sharing, @-mentioning a model, a translated
UI, Legend List 3.7.2, platform primitives as iOS files with `.android`
overrides). Loom's mobile features (archived search hits, the workstream
badge and attention statuses, "Asked 3h ago", the MDX document view, the
not-found file screen, the app-is-behind notice) survive with small edits.
One overlap is a row for Carl (§8.1 "Phone: tapping a relative file path").

Breaks no conflict marker shows (S2b): `MdxDocumentView.loom.tsx` and its
test import modals #33173 moved to `components/ui/` (two paths each; props
unchanged); `MdxDocumentView.loom.tsx:213` needs `.catch(() => null)` on
`refreshAssetUrl`, which now throws when the server refuses a URL (#32994;
typecheck does not catch it, and an MDX image whose file is missing would
load forever); `stripRepeatedWorkspacePrefix` was un-exported (#33943) while
mobile `messageFileLinks.loom.ts` and web `loom/verifiedFileChips.tsx` import
it: re-add `export` with a marker in
`packages/client-runtime/src/workspaceBasenameLookup.ts`. In
`HomeRouteScreen`, widen upstream's own `handleSelectThread` rather than
keeping Loom's beside it.

**The native app must be rebuilt.** React Native 0.88.0 → 0.88.1, Expo
58.0.14 → 58.0.23, a new forked `react-native-screens`, two new native
modules (`t3-preview-tunnel`, `t3-web-socket`) and a new config plugin: the
dev-client fingerprint changes. The first deploy after the merge rebuilds the
APK from scratch on this machine (`expo prebuild --clean`, `gradlew
assembleRelease`); whether its Android SDK, NDK and Gradle cache meet the new
modules' needs cannot be known without a build, so the deploy watches
`build.log`. Carl installs the new APK from the in-app notice; the old APK
keeps working against the new server until he does. **S4 still cannot run
mobile:** the Device tools answer now, but this host offers neither iOS nor
an Android emulator. Mobile rests on typecheck, `vp run lint:mobile`, the
unit tests and Carl's own phone, as in pull 15.

**Client commands as Effects (#38912, `73caab68e3`) cost Loom nothing.**
`command.run` now returns an Effect, but Loom never calls `.run` directly:
its 30 call sites go through `useAtomCommand` (18), `useAtomQueryRunner` (1),
`runAtomCommand` (3) and `executeAtomQuery` (8), which keep their Promise
surface, and its three `createEnvironmentRpcCommand` definitions use option
fields that did not change. `clientRpcPermissions.ts` and
`commandPermissions.test.ts` are unions of Loom's guarded methods with
upstream's new ones.

### 6.12 Config, `AGENTS.md` and docs

Zone file: [B.1](b01-config-docs.md). `AGENTS.md`: Loom's side in all seven
hunks (every test lint rule and render pattern it names already matched
upstream at the base, so those sections converged); the factual upstream
lines that auto-merged outside the markers stay (`vp` does not pass SIGTERM
on; do not detach dev servers; `SECURITY.md`); the auto-merged "Languages"
bullet is deleted per §5.1. `README.md`: Loom's side, and delete the
auto-merged l.128 "This installs the `t3` command…" inside Loom's "Running
it" section. `apps/server/package.json`'s `dev` script: upstream's (its new
launcher does what Loom's watch-path change did). The four user docs
(`composer.md`, `providers-acp.md`, `providers-claude.md`, `providers-pi.md`)
turn on the context-meter ruling (§6.1). `docs/operations/development.md`
keeps Loom's dev-credential and home rules. The root `vite.config.ts`,
`knip.jsonc`, root `package.json`, `evals/package.json` and `evals/README.md`
merged silently with every Loom line intact. Upstream's evals grew
(`mcp-tool-use` cases for the new tools, `pr-content`, `thread-titles`);
Loom's `explainer-density` and `loom-handback` still fit the harness.

### 6.13 Seams nobody listed

The brief's sixteen seams came from the 40 largest commits. All 3,335 commit
subjects were then read for what falls between them. Every one of these is
disjoint from Loom except through files a zone already owns; their server
directories (`scheduledTasks`, `scheduling`, `secrets`, `preview`, `device`,
`background`) carry no `loom` line, and every Loom line in the silently
merged files checked is present in the trial tree.

| Area | Upstream this fortnight | Meets in Loom | After a plain merge |
| --- | --- | --- | --- |
| Scheduled tasks (34 commits) | one-time tasks delete themselves after their run (#37991); fresh-session fixes; missed slots show failed | Loom uses upstream's scheduler as is (the `SCHEDULING` carve-out) | The cockpit's three one-time tasks disappear from Settings after they run; one is due **24 Nov 23:00 UTC** and fires on whichever build is live |
| Snooze (7) | labels, no completion toasts for snoozed threads (#27458) | Loom's snooze rail builds on upstream's snooze | Quieter; pull 15's snooze-guard ruling stands |
| Terminals (83) | optional close confirmation, configurable shell, jobs killed on close | Loom's worktree `node_modules/.bin` PATH prepend in `terminal/Manager.ts` (5 `loom` lines, silent, present); `bg_start` jobs do not use upstream terminals | Two new settings; Gate 2 reads that the prepend reaches the new shell-selection path |
| Browser panel and annotation (156) | in-page Find (#22960), duplicate tabs | Loom's per-tab annotation pick (DL-1214) | `PreviewView.tsx`'s name collision (§8.2) |
| Notifications (22) | routine "copied" toasts removed across 28 files (#36527) | Loom's deploy and handoff toasts are Loom files | Fewer toasts |
| Voice and dictation (27), desktop (46) | streaming transcription, Apple Speech, drag file pills to Finder | none | Nothing on the cockpit's web use |
| Secret cards (#31257) | show/hide toggle, multi-value fields; `request_secret` re-described | Loom agents reach `request_secret` through upstream's tool | Upstream's prose, taken as written |
| Keep-awake (#34128) | on by default | none | `systemd-inhibit` runs while agents work |
| Title regeneration (#33987, #29383) | a shortcut and a shimmer | Loom keeps a Loom thread's title on send (DT-67) | A manual regenerate can retitle a Loom root (§8.3) |
| Thread chips with hover cards (#38895) | upstream's chips get the sidebar card on hover | Loom's `ThreadMention` is a separate component | Loom's chips get no hover card |

No commit in range reverts another. Added and removed inside the range (do
not plan around them): the PR saved-views menu, `manualContinuation.ts`,
`connectAgentApproval.ts`, `MathTypeset.logic.ts`,
`WorkspaceFinderThread.ts`, `wslDrivePath.ts`, the `@pierre/diffs`
1.7.0-beta.3 patch.

### 6.14 Lost declarations, dangling imports and Loom-only compile breaks

**The silent merge lost nothing as text.** All 3,749 non-blank lines Loom
added to the 170 silently merged files are in the trial tree, and the 629
lines mentioning `loom` come out at 629 (Appendix C). What breaks is
compile-time, in files with no conflict marker and therefore no lane:

| Break | File | Upstream cause | Fix | Session |
| --- | --- | --- | --- | --- |
| `parsePiModelSlug` | `apps/server/src/loom/textGeneration/piOneShot.ts` | #32585 | `resolvePiModelSlug(model, undefined)` | S2a |
| moved modals | `apps/mobile/src/features/files/MdxDocumentView.loom.tsx` and its test | #33173 | `components/ui/FilePreviewModal`, `components/ui/VideoPreviewModal` | S2b |
| `stripRepeatedWorkspacePrefix` un-exported | `apps/web/src/loom/verifiedFileChips.tsx`, mobile `messageFileLinks.loom.ts` | #33943 | marked `export` in `workspaceBasenameLookup.ts` | S2b |
| `searchableSetting` un-exported | `apps/web/src/loom/LoomDeployRow.tsx:15` | #37893 | `const searchableSetting = useSearchableSetting();` in the component | S2b |
| deleted prop | `apps/web/src/loom/review/FileChangeView.tsx:682` | #33627 | §6.9 | S2b |
| meter logic file | `ContextWindowMeter.tsx` → `./ContextWindowMeter.logic` | #33131 | §6.1 | S2b |
| context-menu `source` | `apps/web/src/loom/sidebarGoalActions.ts` | #37727 | §6.10 | S2b |
| duplicate `Option` import | `packages/client-runtime/src/connection/driver.ts` (silently merged) | merge artefact | delete one | S1 lane 6 |

The nine `lost-ours` names (`lostdecls-automerged.txt`) are all upstream's
own exports that upstream removed or made private: `sortThreadsForListV2`,
`isSidebarHiddenThread`, `resolveSidebarRowThreadId`,
`pendingRuntimeRequestIds`, `MINIMUM_OPENCODE_VERSION`,
`verifyOpenCodeServerVersion`, `parsePiModelSlug`,
`defaultTextGenerationModel` (made module-private by #35391, not deleted),
`withPathDirectoryListings`. Loom consumers: `piOneShot.ts` (above) and the
two conflicted web-sidebar hunks (§6.10). Of the 9 files with a dangling
relative import, 3 are real (the two `MdxDocumentView` files and the meter),
5 are the known false positives (string fixtures, a font, codegen, built
assets) and 1 is a stale `vi.mock` upstream ships itself. The other direction
matters too: 25 Loom-only files need Loom-side exports from 13 conflicted
files, plus Loom's four `export *` lines in `contracts/src/index.ts` (134
names). If a Rule D resolution drops one, typecheck reports it in the
Loom-only importer, not in the conflicted file (B.12, B.7 hold the lists).

### 6.15 What Loom built since pull 15

Pull 15 landed at `1c7adff34d` (PR #537, 10 Nov). Since then: 28 first-parent
merges, #538 to #591, 315 files, +28,483/−1,867. Change review (the Diff
panel and whole-file view name the thread that wrote each block, Query author,
an editable whole-file comparison, right-panel width per workstream);
documents (MDX on the phone, tappable answers, a document link opens its
author thread); deploy (Loom deploys itself from a Deploy control; the phone
app reports when it is behind); the workstream control plane (history in its
own table 1070, a human-led child is not a fault 1071, code-query threads
1072); pi 1.5.1. 18 of the 28 touch 32 of the 193 conflicted paths
(`FilePreviewPanel.tsx` four PRs; `ChatView.tsx`, `AnnotatableCodeView.tsx`
and `index.css` three each) and 24 of the 170 silently merged files. The
cockpit runs `20261120-015646-6be88bb` (#589); #590 and #591 are not
deployed (43 files, no migrations; §8.1).
