## 3. Surface sizing, by zone (measured in S0)

Measured on `02a2297b61` (`origin/main`) against `07d38b8d17`, merge-base
`737192594f`, in the trial worktree with pull 9's tools (`classify.py`,
`automerged.py`, `dangling.py`, `zones.py`) run against the in-progress merge.
Captures: `/tmp/pull12-measure/` (ephemeral; Appendix A reproduces them).
The orchestrator's earlier numbers (101 / 178 / 268 overlap) are confirmed.

| Item | Value | Note |
| --- | ---: | --- |
| Upstream commits since base | 850 | 284 `perf(web)`, 117 `fix(server)`, 102 `fix(web)`, 63 `refactor(web)`, 49 `fix(mobile)` |
| Upstream files changed | 3,969 | 309 added, 104 deleted, 139 renamed |
| Loom files changed vs base (fork delta) | 1,445 | PRs #400–#406 since pull 11 landed; 19 of them under `apps/`/`packages/` |
| Both sides changed | 273 | 101 conflicted + 172 merged silently |
| Conflicted paths | 101 (96 UU, 5 UD) | 5 UD = upstream deleted web tests Loom edited |
| Conflict markers | 178 | 51 comment-adjacent (rule A), 4 upstream-only insertions, 123 need a read |
| `loom:` lines in conflicted files | 711 | |
| Files with a dangling relative import | 5 / 14 specifiers | 4 are pre-existing false positives (DL-922's set + a mobile `node_modules` fixture); 1 is UD #5 |
| Silently merged files that lost a Loom-side export | 3 | all upstream renames; consumers follow (§5.6) |
| Loom-only files importing a name upstream no longer exports | 1 | `WorkstreamLivenessSweep.ts` → `isNativeMaintenanceCommand` (moved to `CommandPolicy.ts`) |

### 3.1 Conflicted paths by zone

| Zone | Files | Markers | `loom:` lines | Character |
| --- | ---: | ---: | ---: | --- |
| D — upstream deletions Loom modified | 5 | 0 | 7 | web tests moved to `*.browser.test.tsx` |
| client-runtime | 1 | 2 | 5 | auth probe import + comment |
| contracts | 9 | 11 | 65 | 8 comment-adjacent; `settings.ts` defaults; `rpc.ts` group union |
| lockfile / config | 5 | 19 | 10 | lockfile regenerated; `package.json` unions; pi 1.3.0 catalog + patch |
| mobile | 5 | 5 | 15 | all Loom additions beside upstream edits |
| server core (orchestration-v2, ws, server, cli) | 13 | 21 | 156 | all comment-adjacent / import unions except `cli/server.ts`, `cli/project.ts`, `ThreadSettlementService.ts` |
| server other (vcs, workspace, relay, terminal, provider-core/-pi) | 15 | 22 | 96 | `GitVcsDriverCore` + `VcsStatusBroadcaster` are the real ones |
| server persistence | 1 | 1 | 4 | `Sqlite.ts`: two-ledger migrator vs upstream's planner-stats change |
| server provider / mcp | 4 | 6 | 23 | Pi-only registry; `ClaudeProvider` probe spawn; `McpSessionRegistry` comment |
| shared | 2 | 3 | 8 | comment-adjacent |
| web chat | 14 | 38 | 149 | React Compiler shape changes around Loom hunks; `ChatMarkdown` chip pipeline |
| web panels / settings / other | 22 | 39 | 116 | same, plus `rightPanelStore` surfaces and `PreviewView` annotation |
| web sidebar | 5 | 11 | 57 | same |
| **total** | **101** | **178** | **711** | |

Appendix B lists every path with its marker and `loom:` counts.

### 3.2 Silently merged overlap (Gate 2's input)

172 files both sides changed merged without a marker; 167 of them carry
`loom:` lines (560 in total). By zone: server-other 38, server-core 28,
web-panels 28, web-chat 16, provider packages 13, client-runtime 10, shared 9,
server-provider/mcp 8, contracts 6, root/config 5, web-sidebar 4, mobile 3,
desktop 2, persistence 1, docs 1. Appendix C lists them. The silently merged
`Orchestrator.ts`-adjacent files (`EffectWorker.ts`, `ProviderTurnControlService.ts`,
`ThreadManagementService.ts`, the reactors) are the orchestration reviewer's
set (§8, Gate 2d).
