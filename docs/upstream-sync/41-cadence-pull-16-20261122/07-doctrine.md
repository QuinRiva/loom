## 7. Resolution doctrine

Doctrine §4.3 (`05-strategy.md`): where upstream now expresses the same
functionality, upstream's mechanism is the baseline and Loom's variant is
deleted. Otherwise upstream wins verbatim and Loom's seam is re-applied behind
`// loom:`. The per-hunk application is in the thirteen Appendix B zone files;
this section holds what every lane needs to read first.

### 7.1 The rules, as they apply this pull

`tools/hunks.py` counts 513 hunks: 472 `c` (both sides have content), 27 `o`
(upstream's side empty), 13 `B` (Loom's side empty), 1 `A`. 56 of the `c`
hunks are `pnpm-lock.yaml`. 98 hunks in 64 files have a side of 20 lines or
more.

- **The kind of a hunk is not its rule.** This pull's `o` and `B` hunks are
  mostly not what their shape suggests, and the zone files say which:
  - **An `o` hunk is usually an upstream deletion or move.** Loom's side holds
    base code upstream removed (with or without a Loom line inside it), and
    keeping it resurrects dead code. Named cases: the 32-line watch body in
    `pullRequests/handlers.ts` (moved to a new service, §4.4);
    `parseStandaloneComposerSlashCommand`, `{accessibleTitle}`,
    `ThreadWorktreeIndicator` (§6.10); the `MarkdownMath` block in
    `ChatMarkdown.tsx` hunk 5; `remark-math`, `remark-rehype`, `vfile` in
    `apps/web/package.json` (§5.4). Before keeping any line of an `o` or `A`
    hunk, grep upstream's blob (`git show :3:<path>`) for each non-`loom`
    code line: a line upstream deleted is dropped; one it moved gets Loom's
    change at its new home (Appendix D).
  - **A `B` hunk can be a duplicate declaration.** Upstream re-adds something
    Loom had deleted or renamed, and taking it declares the thing twice:
    `defaultBranchCache`, `refreshLocalStatus`, `makeRemoteRefreshLoop`,
    `MigrateDevDbServerRunningError`, `const path` in `dev-runner.ts` (§6.6).
    Or it re-adds text Loom strips on purpose: `mcpExtensionSource.ts` hunk 7
    (§4.3). DL-1203's warning from pull 12 holds.
- **Rule U (union)**: two unrelated edits on the same lines; both, Loom's
  lines marked. Most `c` hunks.
- **Rule D (re-apply onto upstream's shape)**: upstream restructured the
  region. Method unchanged (DL-1222): resolve to upstream's side, re-apply
  Loom's delta for the region from `git diff 3fa57b92a2 origin/main --
  <file>` where the code now sits, then confirm per file that every
  `loom`-bearing line of `origin/main`'s version is present in the resolved
  file or named in a DL row. Where it applies is named per zone; the heaviest
  are `ChatMarkdown.tsx`, `cliproxyApi.ts`, `rightPanelStore.ts`,
  `GitVcsDriverCore.ts`, `VcsStatusBroadcaster.ts`, `ProjectionStore.ts`
  hunks 5 to 7, `adapter.ts`, `__root.tsx`, `_chat.tsx`.
- **Superseded**: upstream now does what a Loom hunk did; Loom's variant is
  deleted with a DL row. The list is in §8.2.
- **Rule T (tests)**: pull 13 §5.2's five rules
  ([`../38-cadence-pull-13-20261025/05-test-prune.md`](../38-cadence-pull-13-20261025/05-test-prune.md)).
  Keep Loom cases that guard Loom behaviour and compile on upstream's
  harness; take upstream's new tests beside them; drop a Loom test of
  something upstream deleted or superseded. Eleven conflicted test files are
  mostly #35993's re-indentation: use a whitespace-blind view (§5.6).
- **Rule C (React Compiler)**: no `useMemo`/`useCallback` in a web file
  (DL-1273).
- **Rule I18N (new)**: §5.1's six cases. A Loom string inside an upstream
  component is wrapped like its neighbours (`gt("…")`, `<T>`, `msg("…")`);
  Loom's English goes inside upstream's wrapper where upstream wrapped a
  string Loom had changed; a Loom string that is not UI copy gets a reasoned
  disable; Loom-only files stay plain.
- **Rule E**: no toolchain rename reaches a Loom hunk this pull (Effect
  4.1.5 has no exposure, §5.6). Kept for upstream's own renames met inside a
  hunk: write Loom's line with the new name (for example `nativeEvent` in
  `ProviderSessionManager.ts`).
- **Model-read text**: where a hunk carries prose an agent reads (tool
  descriptions, prompt blocks, `AGENTS.md`), upstream's own prose is taken as
  written and Loom's is left as it is; the exceptions are §4.3's three paths
  and the auto-merged `AGENTS.md` bullet §5.1 deletes.

### 7.2 How S1 works on one uncommitted merge

S1 is one merge and one merge commit, resolved by a lead and six lane coders
(§2 says why). The merge stays uncommitted while the lanes work, so these
rules bind every S1 thread:

**The lead opens.** In this worktree: confirm `origin/main` is still
`7305fc654e` (if it moved, merge it in first, never rebase, DL row); run the
merge command (§1); confirm `git diff --name-only --diff-filter=U` equals the
193 paths of Appendix B (a path in no zone stops S1 and goes to the
orchestrator); resolve zone B.1's `pnpm-workspace.yaml` and the four
`package.json` files per B.1 and §5.4; `git checkout --theirs pnpm-lock.yaml`;
`vp i` until a pass leaves the lockfile unchanged. Then the lanes start.

**A lane coder:**

- edits only the paths of its zones (Appendix B) and the unmarked files §7.3
  assigns to it; anything else it finds broken goes in its hand-back for S2;
- **never runs a git command that writes the index or the tree**: no `git
  add`, `rm`, `checkout`, `restore`, `stash`, `reset`, `merge`, `commit`.
  Reading is free: `git show :1:<path>` (base), `:2:` (Loom), `:3:`
  (upstream), `git diff 3fa57b92a2 origin/main -- <path>`. To take a side
  whole: `git show :3:<path> > <path>`, or `sideresolve.py`, which rewrites
  the file and nothing else;
- leaves the two upstream-deleted paths (`ContextWindowMeter.tsx`, the
  `@pierre/diffs` 1.6.1 patch) for the lead;
- when a file is done: no marker left (`rg -n '^(<<<<<<<|=======|>>>>>>>)'`),
  `node docs/upstream-sync/pull7-tools/parsesweep.mjs <files>` clean,
  `vp fmt <files>`, and for a Rule D file the per-file `loom`-line check;
- copies each finished file to `.artifacts/pull16-s1/resolved/<path>` (the
  working tree is the only copy of the work until the lead commits);
- writes its decision-log rows to `.artifacts/pull16-s1/dl-<lane>.md` in its
  own number range (§11), not into `decision-log.md`, which six threads would
  otherwise edit at once;
- does not run installs, typecheck or tests (the tree is half-merged);
- hands back: files resolved, new files created, unmarked files edited, DL
  rows, anything left for S2.

**The lead closes** when every lane has handed back: resolves the rest of
B.1; marker sweep over the whole tree; `parsesweep.mjs` over every changed
TS file; `dangling.py`; `git rm` the two upstream-deleted paths; regenerates
`apps/web/src/routeTree.gen.ts`; `vp i` again if a manifest changed; stages
every resolved, edited and new file; `vp fmt` on what it staged; the
unmarked sweep gate against `origin/main` evaluated against the new base
(DL-921's method); `Migrations.ts` byte-identical to upstream's; appends the
lanes' DL rows to `decision-log.md`; commits once (`--no-verify`); checks the
commit has the two parents of §1; removes the trial worktree and
`.artifacts/pull16-s1/resolved/`; then runs `vp run typecheck` per package
and records the counts for S2 (observed, not gated).

If a lane's work is lost (a tree-writing command ran after all), the lead
restores that lane's files from `.artifacts/pull16-s1/resolved/` and the
lane's unfinished paths with `git checkout -m -- <path>`, which re-creates
their conflict markers, and adds a DL row.

### 7.3 Cross-lane contracts

Lanes are disjoint by file, not by meaning. Each row is a resolution two
lanes must agree on, or an unmarked file that S1 edits and that therefore
needs an owner.

| Subject | Lanes | The agreement |
| --- | --- | --- |
| Context meter kept as a Loom component (§6.1, §8.1) | 6, 4, lead, then S2b | Lane 6 writes `apps/web/src/loom/ContextWindowMeter.tsx` from Loom's version and takes upstream's empty side in `settings.ts`. Lane 4 keeps Loom's meter lines in `ChatComposer.tsx` and `ComposerFooterControls.tsx`, imported from `~/loom/ContextWindowMeter`. The lead `git rm`s the old path and resolves the four user docs for "kept". If Carl rules the other way before the lanes reach these files, all three take upstream's side instead |
| A Loom child watches its own PR (§4.4) | 1 | Lane 1 drops Loom's side in `pullRequests/handlers.ts` and writes the marked exemption in `apps/server/src/pullRequest/PullRequestWatchService.ts` (an unmarked new upstream file, assigned to lane 1) |
| Loom threads' capability set | 1, 2 | `McpSessionRegistry.ts` (lane 1) and `ProviderSessionManager.ts` l.479 (lane 2) both keep Loom's exact set; neither takes upstream's union with `orchestration`, `worktree`, `issues` |
| Sender note (§4.3) | 2 | Lane 2 writes both call sites: `ProviderTurnStartService.ts` (its zone) and the silently merged `ProviderTurnControlService.ts` |
| Text generation probe (§6.4) | 2 | `status.ts` skips `discoverPiTextGenerationModelSlugs`; nothing in the usage zone depends on its result |
| `useThreadSyncError` superseded (§6.10) | 5, 4 | Lane 5 drops the hook from `state/entities.ts` **and** lane 4 imports upstream's `useThreadError` in `chat/ThreadNow.tsx`. If lane 4 keeps Loom's import, lane 5 keeps the hook: decide once, lane 5's hand-back names which |
| `ComposerTriggerKind` keeps `"thread"` | 5, 4 | `composer-logic.ts` (lane 5) keeps Loom's member; `ComposerCommandMenu.tsx` (lane 4) needs it |
| Search-match rows | 5, 6 | Web `ThreadSearchMatch.tsx` and mobile `thread-search-match.tsx` resolve the same way: Loom's shape (`threadSearchExcerptLabel`, the "Sub-thread:" line), strings wrapped per Rule I18N |
| File previews reloading (§6.6, §6.9) | 3, 5 | Lane 5 takes upstream's #39736 for HTML in `FilePreviewPanel.tsx` (Loom's #508 HTML half superseded); lane 3 keeps Loom's revision on the non-HTML branch in `AssetAccess.ts` |
| Contracts exports | 6, all | `contracts/src/index.ts` keeps Loom's four `export *` lines; every Loom schema addition in `orchestrationV2.ts` stays (26 `loom` lines, verified present in the trial). Server and web lanes rely on them |
| Usage payload on the provider-status stream | 1, 2 | `ws.ts` hunk 5 (lane 1) keeps Loom's exhaustion overlay with upstream's new third argument; the usage zone (lane 2) only adds fields |
| Settlement | 1 | `ThreadSettlementService.ts` (B.2) and `ProjectionStore.ts` `getSettlementCandidates` (B.3, silently merged region) are read together; both are lane 1's |
| Manifest dependencies (§5.4) | lead, 4, 5 | The lead applies §5.4 before `vp i`; lanes 4 and 5 do not edit `package.json` |
| Unmarked files S1 edits | as named | Lane 1: `PullRequestWatchService.ts`; `apps/server/src/loom/http/loomAgentRoutes.ts` (the APK route's `{ redactedParams: ["*"] }`, §6.7). Lane 2: `ProviderTurnControlService.ts`. Lane 3: `checkpointing/CheckpointStore.ts` (foreign-home guard on `captureHeadCheckpoint`), the silently merged body of `CheckpointService.ts` (baseline capture after the timeout check), `persistence/threadTreeSlice.loom.ts` (`task_folders`). Lane 6: `packages/client-runtime/src/connection/driver.ts` (duplicate `Option` import). Lead: `AGENTS.md`'s auto-merged Languages bullet (deleted), `README.md` l.128, `routeTree.gen.ts`. Every other unmarked break is S2's (§6.14) |

### 7.4 New upstream files and directories: take verbatim

Migrations 081 to 108 and the five edited ones; `apps/server/src/issue/`,
`apps/server/src/feedback/`, `apps/server/src/peer/`,
`apps/server/src/pullRequest/` (with the one marked line of §4.4), the new
MCP toolkits under `apps/server/src/mcp/` (issues, feedback, theme, message,
tool search; withheld in `families.ts`, not edited);
`apps/server/src/background/KeepAwake.ts`; `apps/web/src/markdown/` and
`apps/web/deps/` (Words); `apps/{web,mobile,desktop,marketing}/src/i18n/`
with every catalogue; `apps/web/src/speech/`;
`packages/issue-tracker-linear`, `packages/source-control-cursor-origin`,
`packages/source-control-tanstack-source` and the other source-control
packages' additions; `packages/shared/src/FeatureFlags.ts`,
`usageLimitsCopy.ts`; the mobile native modules
(`modules/t3-preview-tunnel`, `t3-web-socket`, `t3-native-controls`), the
vendored `highlights.c` and the new config plugin; `scripts/scenarios/`,
`evals/mcp-tool-use/` and the other eval additions; `.agents/skills/`
additions; `.github/` additions; the `patches/` additions
(`@cursor__sdk@1.4.2`, `@effect__platform-node-shared@4.1.5`,
`electron-updater@6.8.9`, `@legendapp__list@3.7.3`,
`@pierre__diffs@1.7.0-beta.4`, `react-native-svg`,
`react-native-pdf-jsi@6.1.0` and the re-cuts); `.repos/` (1,005 entries,
merges clean).

### 7.5 What Gate 1 reads

Gate 1 is two reviewers (server lanes 1 to 3 with the lead's zone; client
lanes 4 to 6), each read-only on the merge commit. In every zone file the
rows whose last column says **yes** or **reads** are theirs: 116 rows across
B.1 to B.6, B.8 to B.10, B.12 and B.13, 12 in B.11, and in B.7 the three
files its headings name (`cliproxyApi.ts`, `UsageLimitSources.ts`,
`usageLimits.ts` hunk 2). On top of those rows, each of these is read
whatever its row says:

| Reviewer | Must read |
| --- | --- |
| Server | `PullRequestWatchService.ts` l.120 and `handlers.ts` (§4.4); `McpSessionRegistry.ts` and `ProviderSessionManager.ts` l.479 (capability set); `mcpExtensionSource.ts` hunks 6 and 7; the two sender-note call sites; `status.ts` (the probe skip); `adapter.ts` (sanitiser before spawn; `startConnection`); `ProviderSessionManager.ts` `reportedError`; `ProjectionStore.ts` hunks 5 to 7 and 9; `Sqlite.ts` (both setup paths and the pending test); `Orchestrator.ts` hunks 2, 5 and 12; `ThreadDeletion.ts` l.202; `ThreadSettlementService.ts` with `getSettlementCandidates`; `ws.ts` hunks 2 and 5; `http.ts` and the APK route's redaction; `cliproxyApi.ts` and `UsageLimitSources.ts` (one carry-forward mechanism, not two); `GitVcsDriverCore.ts` and `VcsStatusBroadcaster.ts` (no duplicate declarations; the batch inside `refreshRemoteAndLocalTotals`); `CheckpointService.ts` and `CheckpointStore.ts`; `threadTreeSlice.loom.ts`; `dev-runner.ts`; `apps/web/package.json` against §5.4; `AGENTS.md` (Loom's side in all seven hunks, the Languages bullet gone, no other upstream policy line taken); `Migrations.ts` byte-identical |
| Client | `ChatMarkdown.tsx` (all eleven hunks against Appendix D) and the DL row handing the two ports to S2b; `MarkdownThreadLink.tsx`; `ChatComposer.tsx` and `ComposerFooterControls.tsx` (meter lines) with `apps/web/src/loom/ContextWindowMeter.tsx`; `useComposerSend.ts` (no `recordPromptSent`); `rightPanelStore.ts` (version 17, the normaliser, `SingletonSurfaceKind`); `DiffPanel.tsx` (no duplicate consts) and `diffRendering.ts` (the highlight ruling); `FilePreviewPanel.tsx` hunks 4, 9 and 14; `PreviewView.tsx` (`pickActive`); `SidebarThreadRow.tsx`, `Sidebar.tsx`, `CommandPalette.logic.ts` (the replaced exports); `__root.tsx` and `_chat.tsx`; `state/entities.ts` with `ThreadNow.tsx`; `settings.ts` and `orchestrationV2.ts` (every Loom field in its struct); mobile `ThreadFeed.tsx` (both lookups, Loom's first); `HomeRouteScreen.tsx`; every hunk the i18n table of §5.1 lists, for the wrapped form |

Both also check: 0 markers; the two upstream-deleted paths are gone and
Loom's meter lives under `loom/`; every Superseded deletion of §8.2 has its
DL row; no Loom-only file was edited beyond §7.3's list.
