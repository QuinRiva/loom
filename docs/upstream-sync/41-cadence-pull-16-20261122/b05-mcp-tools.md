## Appendix B.5: MCP server, toolkits, PR watch reactor (9 files, 17 markers, 34 `loom:` lines) · lane 1 server core

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "Agent PR and CI tools"; "D2" is §8.1 "Agent issue tools"; "D3" is §8.1 "Agent feedback tool"; "D4" is §8.1 "Agent theme tools and `send_to_user`"; "D5" (#38926 against #527) is carried in §8.2. "Option A" in D1 means all nine withheld.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/server/src/mcp/McpHttpServer.ts` · 1m · 2L · [1/1c]
- `apps/server/src/mcp/McpInvocationContext.ts` · 1m · 1L · [1/2c]
- `apps/server/src/mcp/McpSessionRegistry.test.ts` · 3m · 8L · [1/3c] [10/2c] [1/14c]
- `apps/server/src/mcp/McpSessionRegistry.ts` · 1m · 4L · [13/9c]
- `apps/server/src/mcp/OrchestratorMcpService.ts` · 7m · 12L · [6/5c] [1/1c] [1/1c] [1/1c] [1/1c] [1/1c] [2/5c]
- `apps/server/src/mcp/toolkits/orchestrator/handlers.ts` · 1m · 2L · [3/2c]
- `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` · 1m · 1L · [32/0o]
- `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` · 1m · 4L · [11/94c]
- `apps/server/src/provider/agentContextBudget.json` · 1m · 0L · [3/3c]

### Per-hunk doctrine

| Path | Hunk | Upstream change | Loom side | Rule | Resolution | Gate 1 reads |
| --- | --- | --- | --- | --- | --- | --- |
| `apps/server/src/mcp/McpHttpServer.ts` | [1/1c] | #35871/#36384/#19270/#35247 add `layerFeedbackToolkit`, `layerThemeToolkit`, `layerIssuesToolkit`, `layerMessageToolkit` to `layerTools` | `LoomToolkitRegistrationLive` (pull 9 3a-1) | U | Keep both lines: Loom's (marked) and `layerMessageToolkit`. The import (line 104) auto-merged | no |
| `apps/server/src/mcp/McpInvocationContext.ts` | [1/2c] | #19270 `"issues"`, background wait `"background-wait"` capabilities | `"workstream"` capability | U | List all three: `"workstream", // loom: …`, `"issues"`, `"background-wait"` | no |
| `apps/server/src/mcp/McpSessionRegistry.ts` | [13/9c] | #19270 adds `"issues"` to the always-added set; liveness rework uses `issuedAlive.wallMs` | P3-6: issue exactly the requested set, `client: request.client` for consult and query forks | D | Keep Loom's block (`client: request.client`, `request.capabilities ?? [default]`). Add `"issues"` to the default list (used only when a request names nothing). Take upstream's `issuedAt: issuedAlive.wallMs`. **Do not take upstream's union**: it would hand every Loom thread `orchestration` and `worktree` | yes |
| `apps/server/src/mcp/McpSessionRegistry.test.ts` | 1 [1/3c] | expectation includes issues etc. | exact set `["preview"]` | T | Keep Loom's line | no |
| same | 2 [10/2c] and 3 [1/14c] | upstream's union expectations | Loom's exact-set block and default case | T | Keep Loom's block; change the default case to `["issues","orchestration","preview","pull-requests","worktree"]`. Drop upstream's three union expectations | no |
| `apps/server/src/mcp/OrchestratorMcpService.ts` | 1 [6/5c] | #33295/#15622 wait timeouts to 30 s/45 s; new secret-request constants | `SCHEDULING_CAPABILITIES` (P3-6); Loom's timeout lines are the base's | U | Keep Loom's 3 marked lines; take upstream's four constants | no |
| same | 2 [1/1c] | #33295 `loadCaller(scope, fields)` | `accepted?` parameter | D | Signature `(scope, fields: ReadonlyArray<K>, accepted?: ReadonlyArray<McpCapability>) // loom:` | yes |
| same | 3 [1/1c] `scheduleTask` | `loadCaller(scope, ["runs"])` | `loadCaller(scope, SCHEDULING_CAPABILITIES)` | D | `loadCaller(scope, ["runs"], SCHEDULING_CAPABILITIES); // loom:` | no |
| same | 4 [1/1c] `listScheduledTasks` | `const { parent } = loadCaller(scope, [])` | `{ parent, limits }` | D | `const { parent } = yield* loadCaller(scope, [], SCHEDULING_CAPABILITIES); // loom:` (`limits` is unused in the body) | no |
| same | 5 [1/1c] `updateScheduledTask`, 6 [1/1c] `deleteScheduledTask` | `["runs"]` | as 3 | D | `loadCaller(scope, ["runs"], SCHEDULING_CAPABILITIES); // loom:` | no |
| same | 7 [2/5c] | #40604: only a `live` pending request holds the caller | `hasBlockingPendingRequest` (an open, non-blocking question does not hold) | U | `ownedTask && !childRequests.some((r) => r.status === "pending" && r.responseCapability.type === "live" && r.loom?.blocking !== false)`, marked; or `hasBlockingPendingRequest` over the `live` ones. Only the withheld `delegate_task` wait path uses it | yes |
| `apps/server/src/mcp/toolkits/orchestrator/handlers.ts` | [3/2c] | #34801 `freshSession` on update | `writesWithCapability` (a Loom credential has `workstream`, not `orchestration`) | U | Keep `McpToolAccess.writesWithCapability(` with Loom's comment; take upstream's destructure including `freshSession` | no |
| `apps/server/src/mcp/toolkits/pullRequests/handlers.ts` | [32/0o] | #33389/#38926: the watch body moved into `PullRequestWatchService.setWatching` | DL-471 child exemption plus the old body | **o is an upstream move** | Drop the whole Loom side (upstream deleted the block). **Re-apply DL-471 at the new home**, `apps/server/src/pullRequest/PullRequestWatchService.ts:120` (trial): `if (watching && thread.lineage.relationshipToParent === "subagent" && thread.workstream === undefined /* loom: DL-471 … */)`. Same `engine.getThreadShell`, so `workstream` is present | **yes** |
| `apps/server/src/orchestration-v2/PullRequestWatchReactor.ts` | [11/94c] | #38926/#39116: `sendTogether`, `sendHeld`, `finished`; `endsWithoutRead` drops the merged-snapshot branch ("a merged snapshot still gets one read") | DL-474 `loomChild` parameter | D | Take upstream's 94 lines. Change its `endsWithoutRead` to `({ thread }: WatchTarget, loomChild = false /* loom: DL-474 */)` and its subagent test to `… === "subagent" && !loomChild // loom:`. Do not keep Loom's `"merged"` branch. Delete the now-duplicate Loom definition at trial line 494. The call site (trial 818–831) auto-merged | yes |
| `apps/server/src/provider/agentContextBudget.json` | [3/3c] | upstream's tools and prompt growth | pull 15's measured 48,202 (DL-1837) | theirs, then re-measure (DL-1654) | Take upstream's 6245 / 7639 / 60374, then let the server track re-run `AgentContextBudget.test.ts` and record Loom's measured figure (expected about 60,460: upstream plus Loom's 86-byte `t3_thread_search` delta). No marker possible | no |

### Silently merged files Gate 2 reads in this zone

- `apps/server/src/pullRequest/PullRequestWatchService.ts` (new upstream file, `A`): Loom's DL-471 is absent (see §3). This is the only Loom line in this area already lost in the trial tree.
- `apps/server/src/mcp/toolkits/workstream/families.ts` (Loom-only, unchanged): unchanged is the problem. `PULL_REQUESTS = namesOf(PullRequestsToolkit)` now covers 18 tools, and five new toolkits are unclassified. Apply D1–D4 here.
- `apps/server/src/mcp/toolkits/thread/tools.ts`: Loom's `t3_thread_search` `source` union (trial line 212) survived beside upstream's new `t3_submit_output`; check it still compiles against upstream's schema.
- `apps/server/src/provider/AgentContextBudget.test.ts`: Loom's `loomToolkitServiceStubs()` and its filter on `LOOM_TOOL_DEFS` survived. The merged `layerTools` now also needs FeedbackService, IssueService, PullRequestWatchService and theme deps; check upstream's mocks cover them next to Loom's stubs.
- Cross-area, in pi-adapter's conflicted `packages/provider-pi/src/server/mcpExtensionSource.ts`:
  - (a) keep DL-905 at trial line 597, so no `PULL_REQUEST_LINKING_INSTRUCTIONS` for pi;
  - (b) **exposure trap**: upstream turns the `mcp__t3_code__` alias from `hidden` into `model-only`, and `reconcileDiscovery` activates the alias of every deferred tool (`followsPublicTool` → `isDeferred`). A Loom-withheld tool is registered hidden but still counts as deferred, so its alias would become active and callable. Resolve with `loomHiddenTools.has(name) ? "hidden"` checked before `isAlias`, and `followsPublicTool` returning false for `loomHiddenTools`. Otherwise Loom's `toolProfile.apply` and the bridge's reconcile fight over the active set every turn;
  - (c) `ProviderSessionManager.ts:479`: keep Loom's `["workstream","pull-requests"]`, not upstream's `["orchestration","worktree","pull-requests","issues"]`.

### Left for the integration tracks (S2)

- `families.test.ts`: the partition test fails with 13 unclassified tools (`t3_feedback`, `send_to_user`, `t3_theme_read`, `t3_theme_set`, `tool_search`, and 8 issue tools). "withholds exactly upstream's six" becomes eleven toolkits. "PULL_REQUESTS is upstream's PR toolkit" must change if `PULL_REQUESTS` is pinned (A or B).
- `McpSessionRegistry.test.ts`: one test (§3).
- `capabilities.test.ts` ("… and links a PR"): upstream's link path now calls `projects.listShells()` (`locateAll`); the test mocks only `getShell`. Likely re-point.
- New Loom test case (Rule T): a Loom child (`subagent` lineage with a workstream row) may `setWatching` through `PullRequestWatchService`, and an upstream subagent may not. The DL-471 line moved silently once, and today's guard (`prToolkit.test.ts:204`) covers the orchestrator path only.
- Re-measure `agentContextBudget.json` (DL-1654).
- No Loom prose (`CAPABILITIES` phrases, `prose.ts`) changes under D1-A, D2–D4.
