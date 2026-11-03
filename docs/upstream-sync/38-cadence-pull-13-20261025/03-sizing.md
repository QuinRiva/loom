## 3. Surface sizing, by zone (measured in S0)

Measured on `b487d4319b` (`origin/main`) against `b76a110aa4`, merge-base
`07d38b8d17`, in the trial worktree with pull 9's tools (`classify.py`,
`automerged.py`, `dangling.py`, `zones.py`) plus three S0 scripts (`hunks.py`,
`imports.py`, `rehome.py`) run against the in-progress merge. Captures:
`/tmp/pull13-measure/` (ephemeral; Appendix A reproduces them). The
orchestrator's numbers (1,238 / 4,932 / 317 / 173 / 418) are confirmed.

| Item | Value | Note |
| --- | ---: | --- |
| Upstream commits since base | 1,238 | 255 `fix(server)`, 231 `fix(web)`, 138 `fix(mobile)`, 74 `refactor(web)`, 43 `fix(desktop)`, 16 `feat(server)`, 16 `test(web)` |
| Upstream files changed | 4,932 | 708 added, 510 deleted, 37 renamed, 3,677 modified |
| Loom files changed vs base (fork delta) | 1,545 | PRs #409–#436 since pull 12 landed (#408); the large ones are #436 search (65 files), #418 (25), #421 (16), #425/#427/#430–#432 change review (≈40), #434 |
| Both sides changed | 317 | 173 conflicted + 144 merged silently |
| Conflicted paths | 173 (161 UU, 11 UD, 1 DU) | 11 UD = upstream deleted a Loom-edited test; 1 DU = Loom deleted `ThreadSearch.test.ts`, upstream rewrote it |
| Conflict markers | 418 | 86 comment-adjacent (Rule A), 7 upstream-only insertions (Rule B), 44 Loom-side-only regions (mostly Rule T), 281 content (Rule D or a read) |
| Touched by the test prune #22557 / comment prune #21514 | 80 / 101 | of the 173 |
| `loom:` lines in conflicted files | 1,091 | |
| Files with a dangling relative import | 5 / 12 specifiers | 4 are DL-922's pre-existing false positives; the fifth is `routeTree.gen.ts` (regenerated, §6.5) |
| Silently merged files that lost a Loom-side export | 24 files / 32 names | all upstream de-exports (#24058) whose consumers upstream deleted; 2 Loom consumers remain (§5.4) |
| Loom-only files with a broken import in the merged tree | 3 | `migrationEntries` ×2, `getProviderInstanceEntry` ×1 (§5.4); every other relative, `~/` and `@t3tools/*` import in 1,116 Loom-only files resolves |
| New lint rules that are errors on Loom files | 12 | §6.9 |

### 3.1 Conflicted paths by zone

| Zone | Files | Markers | `loom:` lines | Character |
| --- | ---: | ---: | ---: | --- |
| D: upstream deletions Loom modified | 11 | 0 | 18 | tests; Rule T (§5.3); the one DU (`ThreadSearch.test.ts`) is counted under server core |
| client-runtime | 4 | 5 | 16 | 3 tests (Rule T), `state/shell.ts` one import line |
| contracts | 11 | 22 | 77 | `threadSearch.ts` (§4), `orchestrationV2.ts` ×6 (guest commands, older-settled, opens), `settings.ts` defaults, permissions scopes |
| lockfile / config | 5 | 53 | 15 | lockfile regenerated (40 markers); `apps/web/package.json`; `dev-runner.ts` + test (Rule D) |
| mobile | 12 | 25 | 34 | 7 of them are #436 vs #24343 (§4); the rest small Loom additions beside upstream edits |
| server core (orchestration-v2, ws, server, cli, startup) | 17 | 53 | 185 | `Orchestrator.ts` ×11 and `ws.ts` ×10 are Rule D plus the Loom seams; `ThreadSearch.ts` ×4 (§4); `serverRuntimeStartup.ts` phase reorder |
| server other (vcs, workspace, project, assets, usage, provider-*) | 44 | 90 | 249 | `GitVcsDriverCore.ts` ×10 and `VcsStatusBroadcaster.ts` ×7 (Loom's repository batch again); many Rule T test files; config and docs |
| server persistence | 1 | 1 | 4 | `Sqlite.ts`: Rule A (two-ledger migrator + cache_size beside pruned comments) |
| server provider / mcp | 5 | 13 | 22 | Pi-only registry test (Rule T + DL-916), Claude probe test (Rule T), `McpSessionRegistry.ts`, hydration |
| shared | 5 | 6 | 13 | `DrainableWorker.ts` Rule D; 4 tests Rule T |
| web chat | 14 | 53 | 160 | `ChatMarkdown` ×10, `ChatView` ×11, `MessagesTimeline` ×8, `ChatComposer` ×5: Rule D with Appendix D's re-homing map |
| web panels / settings / other | 33 | 65 | 208 | `routeTree.gen.ts` ×11 (regenerate), `FilePreviewPanel` ×4, `rightPanelStore` ×2, `index.css` ×3, many Rule T tests, `ThreadSearchMatch` (§4) |
| web sidebar | 11 | 32 | 90 | `Sidebar.tsx` ×7 (Rule D, 22 hunks move to `SidebarThreadRow.tsx`), `CommandPalette*` ×14 (§4), routes |
| **total** | **173** | **418** | **1,091** | |

Appendix B lists every path with its marker and `loom:` counts, its hunk
shapes and its rule.

### 3.2 Silently merged overlap (Gate 2's input)

144 files both sides changed merged without a marker; 140 of them carry a line
mentioning `loom` (555 in total). By zone: web-panels 28, server-core 24,
server-other 18, provider packages 12, client-runtime 9, web-chat 10,
server-provider/mcp 8, contracts 7, shared 7, docs/config 7, root/config 5,
desktop 3, mobile 3, persistence 2, web-sidebar 1. Appendix C lists them. The
ones that matter most are named in §6: `DatabaseMaintenance.ts` (§4.4),
`threadFamilies.ts`/`olderSettledThreads.ts`/`ShellStream.ts` (§6.2, upstream
only), `RpcAuthorization.ts` (§6.3), `McpHttpServer.ts` and
`OrchestratorMcpService.ts` (§6.1), `providerInstances.ts` (§5.4),
`routes/_chat.pull-requests.tsx` (upstream emptied it; Loom had no delta).
