## Appendix B.6: Pi adapter, provider core, provider session manager (22 files, 67 markers, 185 `loom:` lines) · lane 2 providers and usage

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" is §8.1 "Upstream's sender note on agent-sent messages"; "D2" is §8.1 "A Pi session resumed in a different folder". "T1" from the usage zone is carried in §8.2 (text generation stays on pi through the hub).

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` · 1m · 3L · [45/42c]
- `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` · 7m · 3L · [2/1c] [0/6B] [1/1c] [3/3c] [1/1c] [1/1c] [66/58c]
- `apps/server/src/orchestration-v2/ProviderSessionManager.ts` · 5m · 23L · [2/2c] [1/1c] [3/1c] [1/2c] [20/23c]
- `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` · 1m · 6L · [9/13c]
- `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` · 1m · 3L · [2/10c]
- `apps/server/src/orchestration-v2/testkit/fixtures/provider_thread_resume/pi_transcript.ndjson` · 1m · 0L · [2/1c]
- `apps/server/src/orchestration-v2/testkit/fixtures/simple/pi_output.ts` · 1m · 1L · [25/22c]
- `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback/pi_transcript.ndjson` · 1m · 0L · [4/0o]
- `apps/server/src/orchestration-v2/testkit/fixtures/thread_rollback_after_stop/pi_transcript.ndjson` · 2m · 0L · [4/5c] [4/0o]
- `apps/server/src/provider/ClaudeCapabilitiesProbe.test.ts` · 2m · 4L · [34/2c] [98/22c]
- `apps/server/src/provider/ClaudeProvider.ts` · 4m · 8L · [6/4c] [6/4c] [1/0o] [61/28c]
- `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` · 1m · 6L · [5/2c]
- `apps/server/src/provider/ProviderRegistry.test.ts` · 1m · 15L · [4/148c]
- `packages/provider-core/src/server/IdAllocator.ts` · 3m · 7L · [1/5c] [1/1c] [1/2c]
- `packages/provider-core/src/server/managedProvider.test.ts` · 2m · 2L · [5/11c] [20/64c]
- `packages/provider-core/src/server/managedProvider.ts` · 8m · 12L · [1/1c] [2/3c] [30/9c] [1/2c] [8/7c] [9/3c] [5/1c] [9/34c]
- `packages/provider-core/src/server/snapshot.ts` · 1m · 1L · [14/2c]
- `packages/provider-pi/src/server/adapter.ts` · 10m · 52L · [2/1c] [7/14c] [5/0o] [4/1c] [24/2c] [120/2c] [2/2c] [1/1c] [6/1c] [9/1c]
- `packages/provider-pi/src/server/driver.ts` · 1m · 8L · [12/4c]
- `packages/provider-pi/src/server/mcpExtensionSource.test.ts` · 1m · 3L · [2/43c]
- `packages/provider-pi/src/server/mcpExtensionSource.ts` · 7m · 17L · [1/2c] [2/1c] [2/1c] [1/3c] [2/10c] [6/4c] [0/8B]
- `packages/provider-pi/src/server/status.ts` · 6m · 11L · [2/1c] [2/2c] [1/4c] [7/33c] [1/1c] [2/6c]

### Per-hunk doctrine

Rules per pull 15 `07-doctrine.md` §7.1. "G1" = the Gate 1 reviewer must read it.

#### `packages/provider-pi/src/server/adapter.ts` (10 markers, 52 `loom` lines in markers)

| # | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [2/1c] | #36429 `commandOutputBytes` field on `ActivePiTurn` (shell output no longer stored per update) | `openTools` field (`ffbf5234e5`: a tool call open when pi dies is ended by `finalizeTurn`) | U | Keep both fields | no |
| 2 | [7/14c] | #21512/#36586/#31870/#39007: `openSession` now builds `sessionHeaderNamesCwd`, `initialSessionPath` and a `startConnection(sessionPath?)` that can respawn pi; the `buildPiRpcLaunch` call moved inside `startConnection` | `...(input.loom === undefined ? {} : { loom: input.loom }), // loom: Area G` on the old top-level `buildPiRpcLaunch` | D | Take upstream's side. Put Loom's `loom` spread into the `buildPiRpcLaunch` inside `startConnection` (trial l.~589), so the failed-spawn retry (`recoverSpawnSession`, which calls `startConnection()` again) also carries Loom's prompt, skills, extensions and env. **Add**, before `let started = yield* startConnection(initialSessionPath)`: `if (initialSessionPath !== undefined) yield* loomHooks.sanitiser(initialSessionPath, input.modelSelection.model); // loom: pi loads the file at spawn now (3c-2)` | yes |
| 3 | [5/0o] | #40758 deleted the per-update `inputTokens`/`cachedInputTokens`/`outputTokens` locals (moved into `piMessageTokenUsage` → `turn.lastMessageUsage`) | Those three lines plus Loom's `costUsd` comment and line (DR-8) | A (trap: upstream deletion) | Keep only Loom's two `costUsd` lines (`// loom: the turn's spend so far…` and `const costUsd = turn.costUsd + …`); drop the three token lines | yes |
| 4 | [4/1c] | #40758 `...turn.lastMessageUsage` | Loom's three token spreads + `...(costUsd > 0 ? { costUsd } : {}), // loom: live spend` | D | `...turn.lastMessageUsage,` then Loom's `costUsd` spread | no |
| 5 | [24/2c] | #34489 `...(turn.reportedModel === undefined ? {} : { model: turn.reportedModel })` | Terminal `tokenUsage` with `costUsd` (DR-8) and `turnTokenUsage` from `turn.loomTokens` (3c-3; `UsageLedgerReactor.ts` reads it) | U | Loom's two spreads, then upstream's `model` spread. Upstream still emits no `turnTokenUsage` for pi, so Loom's stays | no |
| 6 | [120/2c] | #21512, #36586, #38582, #37472, #26322, #32585: `registerThread` moved below `discoverModels`/`forkSessionIntoCwd`/`findHistoricalForkSession`/`sessionFileInCwd`, gained the `alreadyOnResumeFile` skip, `registrationInProgress` guard and `supersededSessionFiles` | Loom's copy of the old `registerThread`; its only Loom lines are the sanitiser (3c-2) and `cwdOverride: cwd` (DR-3) | D | Take upstream's side (the `discoverModels` head here, upstream's `registerThread` further down). In upstream's `registerThread`, inside `if (!alreadyOnResumeFile && …)`, just before `const result = yield* lifecycleRequest(`, add `if (resumeId != null) yield* loomHooks.sanitiser(resumeId, threadInput.modelSelection.model); // loom: … (3c-2)` so the fork in `sessionFileInCwd` copies sanitised content. `cwdOverride` per D2 (recommended: dropped) | yes |
| 7 | [2/2c] | #38582 `backgroundTasksEndWithProcess: true` | `hasPendingBackgroundWork: … \|\| loomJobs.running > 0` | U | Both lines. True for Loom's jobs too: they die with pi | no |
| 8 | [1/1c] | #36429 `commandOutputBytes: new Map()` | `openTools: new Map(), // loom` | U | Both | no |
| 9 | [6/1c] | #38315 renamed the source file `currentFile`, added `targetFile`, and computes `sourceFile = targetFile ?? boundaryFile ?? currentFile` after the boundary | `forkCallPath = piThreadForkPath(read(sourceFile), targetThreadId)` (O3) | D | Upstream's `targetFile` line, then Loom's `forkCallPath` reading **`currentFile`** (`sourceFile` is now declared later: TS2448). Make the fork source the caller's file when the cut applies: `const sourceFile = forkCallPath !== undefined ? currentFile : (targetFile ?? boundaryFile ?? currentFile); // loom: (O3)` | yes |
| 10 | [9/1c] | #38315 fork launch moved into `forkSessionIntoCwd`, which provides the spawner itself | `.pipe(Effect.provideService(ChildProcessSpawner…))` plus the O3 header-keeping rewrite | D | Upstream's `);`, then Loom's `if (forkCallPath !== undefined) { … }` rewrite block; drop Loom's `.pipe(provideService)` | yes |

Interactions now that both sides act on the same events: upstream's held prompts during compaction and #28798's `pendingPromptResponses` both feed Loom's `writeLoomSteerStash` (lines present at trial l.790, 2493, 2850, 3030); upstream's `clearNativeQueue` on Stop makes pi report an empty `queue_update`, which empties Loom's stash, as a Stop should. Loom's `openTools` ends dangling tool calls inside `finalizeTurn`, which runs before the session release that #29036/#40170 use to find "lost work"; so for a pi death mid-tool, upstream's provider-exit note and auto-continuation (`message:restart-continuation:<run>`, labelled `[Automated resume by T3 Code…]` by Loom) will usually not fire and Loom's liveness `errorResume` resumes instead; when it does fire (an async pi-subagent was running), Loom's `errorResume` stands down because a later run exists. Gate 2b reads this; S4 kills a pi process mid-tool once and expects exactly one resume.

#### `packages/provider-pi/src/server/mcpExtensionSource.ts` (7 markers)

| # | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [1/2c] | #31727 imports `T3_CODE_ORCHESTRATION_INSTRUCTIONS` and `PULL_REQUEST_LINKING_INSTRUCTIONS` | `// loom: no T3_CODE_ORCHESTRATION_INSTRUCTIONS import … (DL-905)` | ours | Keep Loom's comment, naming both constants; take neither import | yes |
| 2 | [2/1c] | #33177 `export const PI_T3_SERVICE_TIER_COMMAND` (imported by `adapter.ts`) | `T3_LOOM_HIDDEN_TOOLS_ENV` + comment | U | Both | no |
| 3 | [2/1c] | #34528 `import * as NodeCrypto` (approval summary hash) | `import { request as httpRequest } from "node:http"` (Loom's `post()`) | U | Both | no |
| 4 | [1/3c] | `ORCHESTRATION_INSTRUCTIONS`, `PULL_REQUEST_LINKING_INSTRUCTIONS`, `SERVICE_TIER_COMMAND` consts | `LOOM_HIDDEN_TOOLS_ENV` const | U minus DL-905 | Loom's const and `SERVICE_TIER_COMMAND`; drop the two instruction consts | yes |
| 5 | [2/10c] | #26845 `isDeferred`, `followsPublicTool` | `loomHiddenTools` set | U | Both | no |
| 6 | [6/4c] | #26845 `toolName`, `isAlias`, alias exposure `"model-only"` with hidden declaration | Withheld tools and the alias registered `"hidden"`; `_meta` prose (P3-2) | D | Upstream's `toolName`/`isAlias`, then `const exposure = loomHiddenTools.has(name) ? "hidden" : isAlias ? "model-only" : isDeferred(name) ? "deferred" : "direct"; // loom: withheld tools unreachable under both names`, then Loom's three `_meta` lines. **Order matters**: with `isAlias` tested first, a role-withheld tool becomes callable as `mcp__t3_code__<name>` (its alias `execute` passes `followsPublicTool` because the public tool is deferred) | yes |
| 7 | [0/8B] | #31727 re-adds the orchestration section plus PR linking rules in `before_agent_start` (sections path and `systemPrompt` fallback) | Handler only calls `reconcileDiscovery(ctx)` | ours (trap: a B that is a Loom deletion) | Keep Loom's empty side; take none of the 8 lines (DL-905) | yes |

New model-read text upstream added here: only the pull request linking block (`runtimeInstructions.ts` `PULL_REQUEST_LINKING_INSTRUCTIONS`, "Link each PR you create, take over, or push to: link_pull_request…") and the re-asserted orchestration section, both dropped by hunks 1, 4, 7. The alias tools add no text (pi 1.5.1 leaves hidden declarations' guidelines out of the prompt, `types.d.ts` l.457). The approval-summary hash suffix (#34528) is shown to the user, not the model. The `t3-service-tier` command is a pi slash command, not model-visible. #26959 (ACP runtime notes) and #39921 (MCP sign-in) do not touch this file. Loom's suppression proof `mcpExtensionSource.loom.test.ts` calls the handler with `{ systemPrompt: "BASE" }` only, which catches the fallback path but not the `systemPromptOptions.sections` path that pi 1.5.1 actually takes (`types.d.ts` l.744); see §5.

#### `packages/provider-pi/src/server/mcpExtensionSource.test.ts` (1 marker, [2/43c])

Upstream re-adds "Pi orchestration prompt section" tests asserting the guidance and PR rules; Loom's side is the retirement comment. Rule T: keep Loom's comment, drop upstream's block **and** its silently merged `import { PULL_REQUEST_LINKING_INSTRUCTIONS }` (trial l.8). Upstream's alias tests (`model-only`) pass under hunk 6's resolution. G1: no.

#### `packages/provider-pi/src/server/status.ts` (6 markers)

| # | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [2/1c] | #33177 `thinkingCapabilitiesForPiModel` → `piModelCapabilities` (file renamed `modelCapabilities.ts`) | `isDefault` for `LOOM_PI_DEFAULT_MODEL` (DR-9) | E | Loom's `isDefault` line, then `capabilities: piModelCapabilities(` | no |
| 2 | [2/2c] | #24110 `makePiDiscoveryConnection(…, cwd?: string, textGenerationLaunch = false)` | `cwd: string \| undefined, promptTemplates` | U | `(…, cwd: string \| undefined, textGenerationLaunch = false, promptTemplates: ReadonlyArray<string> = [], // loom:)`; inside, pass Loom's `loom: { promptTemplates }` only when `!textGenerationLaunch` | no |
| 3 | [1/4c] | #33275 probe timeout; #24110 forks `discoverPiTextGenerationModelSlugs` | `makePiDiscoveryConnection(` call | D | Take upstream's. **Neutralise #24110 for Loom**: replace the text-generation probe with `Effect.succeed(undefined)` (marked: "Loom's pi text generation keeps extensions on, so every listed model can generate"), so no model is marked `supportsTextGeneration: false` and one `pi --no-extensions` spawn per probe is saved (same fix as `textgen-usage`) | yes |
| 4 | [7/33c] | #24110/#28557 `readPiInventory(…)` with the `--no-approve` retry | Direct `get_state`/`get_available_models`/`get_commands` with `promptTemplates` | D | Take upstream's. Add a `promptTemplates` parameter to `readPiInventory` (trial l.201), pass it to its `makePiDiscoveryConnection` call, and pass it at both `readPiInventory` call sites (first try and `--no-approve` retry). Without this the trial compiles but the slash menu loses Loom's templates | yes |
| 5 | [1/1c] | #39434 `compatibility: ProviderCompatibilityLookup = noCompatibilityPolicy` | `promptTemplates: ReadonlyArray<string> = []` | U | Keep upstream's 4th, Loom's 5th (upstream's `status.test.ts` l.187 passes compatibility 4th). Update `status.loom.test.ts` l.99 to `(settings, {}, undefined, noCompatibilityPolicy, ["/p/catchup.md"])` | no |
| 6 | [2/6c] | #33275 `resolveProviderProbeTimeoutMs` | `promptTemplates, // loom:` | U | Both | no |

#### `packages/provider-pi/src/server/driver.ts` (1 marker, [12/4c])

Upstream (#39434) passes `host.compatibility` to `makePiTextGeneration`; #37654 moved the probe into `probeCwd` (`providerStatusCacheDir/pi-status-probe`) with a `makeDirectory` wrapper (outside the marker). Loom's side: `const { promptTemplates } = yield* LoomPiAdapterHooks` and the old `checkPiProviderStatus(…, cwd, promptTemplates)`. Rule D: upstream's `makePiTextGeneration(effectiveConfig, processEnv, host.compatibility)`; keep Loom's `LoomPiAdapterHooks` line; change upstream's call below to `checkPiProviderStatus(effectiveConfig, processEnv, probeCwd, host.compatibility, promptTemplates /* loom: */)`; drop Loom's old `checkProvider` block. No new capability flag is needed. G1: no.

#### `packages/provider-core/src/server/managedProvider.ts` (8 markers)

| # | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [1/1c] | #33800 `makeUsageLimits` import | `removeUsageLimitWindows` import (usage feeder retraction) | U | Both | no |
| 2 | [2/3c] | #33800 `usageAuthLabel`, #34678 `checked` state fields | `usageLimitsFed` | U | All three | no |
| 3 | [30/9c] | #34885/#39114 `FAILED_CHECK_RECHECK_DELAY`, `DeferringFailedCheck` | `EnrichableField` + `carryForwardEnrichment` (palette never blanks on a base refresh) | U | Both. Upstream's covers a failed check over a ready provider; Loom's also covers enrichment-owned fields on a successful probe, so it is not superseded (follow-up §8) | no |
| 4 | [1/2c] | init `usageAuthLabel: undefined, checked: false` | `usageLimitsFed: false` | U | All | no |
| 5 | [8/7c] | #33800: keep limits that changed during a silent probe (`usageBeforeProbe`) | `keepOnSilentProbe: state.usageLimitsFed && auth !== "unauthenticated"` (pi's probe never reads quota) | D | Upstream's outer conditional, with Loom's `keepOnSilentProbe` argument inside its `resolveUsageLimitsAfterProbe({…})` call (`usageLimits.ts` still carries the parameter, merged silently) | yes |
| 6 | [9/3c] | #33800 `labeledProbe` | `carryForwardEnrichment({ base, previous, enrichmentOwnedFields })` | D | `carryForwardEnrichment({ base: workspaceId && !probedSnapshot.auth.workspaceId ? { ...labeledProbe, auth: { ...labeledProbe.auth, workspaceId } } : labeledProbe, previous: state.snapshot, enrichmentOwnedFields: input.enrichmentOwnedFields ?? [] })` | no |
| 7 | [5/1c] | `{ snapshot, enrichmentGeneration, usageAuthLabel, checked: true }` | `usageLimitsFed: usageLimits === state.snapshot.usageLimits && state.usageLimitsFed` | U | One object with all five | no |
| 8 | [9/34c] | #33800 `applyUsageLimits` rewritten (complete readings replace, auth relabel) | Shared `updateUsageLimits` envelope for `applyUsageLimits` and `retractUsageLimits` | D | Take upstream's `applyUsageLimits` and add `usageLimitsFed: true` to its new state. Re-add Loom's `retractUsageLimits` as its own `Ref.modify` (fold `removeUsageLimitWindows({ ...input, previous })`, republish only if changed, set `usageLimitsFed: true`); drop the `updateUsageLimits` helper | yes |

#### `packages/provider-core/src/server/managedProvider.test.ts` (2 markers)

Hunks [5/11c] and [20/64c] are one region: Loom's "keeps fed usage windows through a silent probe until the probe signs out" against upstream's `.each` "keeps the live plan and limits after $name" and "drops an earlier plan override…". Rule T: keep both tests whole. G1: no.

#### `packages/provider-core/src/server/snapshot.ts` (1 marker, [14/2c])

Upstream #33800 `applyUsageLimits: (update: ProviderUsageLimitsReport)` (new fields optional, so Loom's poller compiles). Loom adds `retractUsageLimits`. Rule U: upstream's `applyUsageLimits` line and doc, then Loom's `retractUsageLimits` block. G1: no.

#### `packages/provider-core/src/server/IdAllocator.ts` (3 markers)

| # | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [1/5c] | #36525 `DELEGATED_TASK_THREAD_PREFIX` + `isDelegatedTaskThread` (only `CodexAdapterV2.ts` reads it) | `// loom: every derive entry is deriveId` | U | Both | no |
| 2 | [1/1c] | #36525 delegated-task thread id keeps a readable prefix (`joinId`) | `deriveId("thread", "delegated-task", …)` | ours | Keep Loom's digest. Consequence: `isDelegatedTaskThread` is always false in Loom, which matters only to Codex, which Loom does not register; Loom children cannot reach `delegate_task` | no |
| 3 | [1/2c] | #34877 `subagentThread: makeDeriveSubagentThread(new Set())` and `run` via `joinId` | `run` via `deriveId` | U | Upstream's `subagentThread` line, Loom's `run` line. Pi async subagents (#36599) then get `thread:subagent:<16 hex>` ids; existing ones keep theirs through `legacyThreadIds` | no |

#### `packages/provider-core` driver capability question (#31186, #39502, #39229, #38874, #38348)

No new required capability. Every capability field added in range is `Schema.optional` (`canForkWhileSourceRunning`, `supportsNativeGoals`, `supportsNativeResume`, `activeSteeringDuringCompaction`, `supportsBackgroundWait`). Upstream already sets `supportsNativeResume: false` and `backgroundTasksEndWithProcess: true` for pi (merged). #31186 wraps `openSession` in `ProviderInstallationGate` (PSM hunk 5; inert for Loom's bundled, manual-only pi). #39502 touches none of these three files. #38874 appends `outputInstructions` only when a caller sets `run.outputSchema`. #38348 adds a `background-wait` MCP capability only for adapters with `supportsBackgroundWait` (pi has none; Loom's `bg_start`/`bg_wait` live in the pi extension and are unaffected).

#### `apps/server/src/orchestration-v2/ProviderSessionManager.ts` (5 markers)

| # | Shape | Upstream change | Loom side | Rule | Resolution | G1 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | [2/2c] | #41055 `idleThreadUnloads` keyed by `ProviderThreadId` | `idleTimeoutMs?` (per-thread idle release, 1-hour roots) + old `ThreadId` key | U | Loom's `idleTimeoutMs` line, upstream's re-keyed map with its comment | no |
| 2 | [1/1c] | #19270 adds `"issues"` | `["workstream", "pull-requests"]` (P3-6) | ours | Keep Loom's line (aligned with `mcp-tools` D2) | yes |
| 3 | [3/1c] | #33152 `const retryStalls = makeRetryStallWatch(entry)` | `let reportedError` + comment (DL-1624) | U | Both. **Plus the silent line below it (trial l.3020)**: `reportedError = nativeEvent.type === "provider_session.updated" && nativeEvent.providerSession.status === "error" ? nativeEvent.providerSession.lastError : null; // loom` (upstream renamed the parameter; `event` is now a later `const`) | yes |
| 4 | [1/2c] | #40170 `eventStreamCause: cause` | `detail: reportedError ?? …` | U | `detail: reportedError ?? makeProviderFailure({ cause }).message, // loom: …` and `eventStreamCause: cause` | no |
| 5 | [20/23c] | #31186 `installationGate.execute(instanceId, adapter.openSession({…, promptSuggestions: promptSuggestionsEnabled, …}))` | `loom, // loom: … (Area G)` in the open input | D | Upstream's wrapper and fields, plus Loom's `loom,` line | no |

#### `apps/server/src/orchestration-v2/ProviderSessionManager.test.ts` (7 markers)

Hunks 1, 3, 4 [2/1c][1/1c][3/3c]: U, Loom's `failEventStreamAfterError` beside upstream's `normalizeThreadLoadModelSelection`. Hunk 2 [0/6B]: B, upstream's `Stream.ensuring(eventStreamsEnded…)`. Hunks 5, 6: follow PSM hunk 2, keep Loom's expected sets. Hunk 7 [66/58c]: T/D, take upstream's test body (awaits a `releaseRecorded` Deferred instead of `Effect.yieldNow`) and re-apply Loom's `.each` over `reportedError` (`undefined` and `"Pi process exited unexpectedly."`), passing `releaseRecorded` in both layer variants. G1: no.

#### `apps/server/src/orchestration-v2/ProviderTurnStartService.ts` (1 marker, [9/13c])

Upstream #29239: `sourceBusy`, `nativeForkFailure`, and a guard requiring `sourceRun.status` completed/waiting or `canForkBusySourceNatively`. Loom: a run-less (V1-imported) fork source has no `sourceRun`. Rule D: upstream's block with `sourceRun !== undefined && // loom: run-less source` on `sourceBusy` and `(sourceRun === undefined || sourceRun.status === "completed" || sourceRun.status === "waiting") && // loom:` on the guard (otherwise TS18048 and a run-less fork never forks natively). G1: yes. The silent `withMessageSenderNote` lines in this file are D1.

#### `apps/server/src/orchestration-v2/ProviderEventIngestor.test.ts` (1 marker, [45/42c])

Upstream re-indented the test and gave the fake snapshot a hub `getSnapshot` (#33800). Rule T: upstream's side plus Loom's `retractUsageLimits: () => Effect.die("unused"), // loom:`. G1: no.

#### `apps/server/src/orchestration-v2/testkit/ProviderReplayHarness.ts` (1 marker, [2/10c])

Upstream (#35925) provides `WorkspaceFolders` (over `layerStores`) to `CheckpointService`. Loom adds `Layer.provide(layerStores)` (LoomStoreV2 for the Loom turn baseline, P3-17). Rule U: upstream's `mergeAll`, then Loom's line. G1: no.

#### The three Pi replay transcripts and `simple/pi_output.ts`

| File | Shape | Upstream | Loom | Resolution | Read by |
| --- | --- | --- | --- | --- | --- |
| `fixtures/provider_thread_resume/pi_transcript.ndjson` | [2/1c] | #21512 re-recorded: `process_start` carries `--session /pi-sessions/session-1.jsonl`, no `switch_session` | `"cwdOverride":"<any>"` on the `switch_session` frame (DL-251) | theirs (Loom's only delta rode a frame that no longer exists) | `PiReplayFixtures.integration.test.ts` via `ProviderReplayFixtures.ts` / `fixtures/index.ts` |
| `fixtures/thread_rollback/pi_transcript.ndjson` | [4/0o] | `switch_session` and its notifies removed | same `cwdOverride` frame | theirs | same |
| `fixtures/thread_rollback_after_stop/pi_transcript.ndjson` | [4/5c] [4/0o] | `get_state` probe added, spawn-time `--session`, `switch_session` removed | `cwdOverride` frames | theirs | same |
| `fixtures/simple/pi_output.ts` | [25/22c] | #40758 expected breakdown from the last streamed message usage (input includes cache) | strip `costUsd` before the deep-equal (DL-251) | D: upstream's loop; in the `turns.map` destructuring add `costUsd: _costUsd, // loom: asserted in the Loom adapter test` | same; also `multi_turn/pi_output.ts` imports `assertPiSettledTokenUsage` |

None of upstream's eight pi transcripts contains a `switch_session` frame any more (command in §9), so the transcripts are theirs under either D2 option. They stay in `unmarkedsweep.allow`.

#### `apps/server/src/provider/ClaudeProvider.ts` (4 markers) and `ClaudeCapabilitiesProbe.test.ts` (2)

Loom's lines are (i) a stale Claude model catalogue (`CLAUDE_MODEL_CATALOG`, `isLegacyClaudeModel`, `getClaudeModelCapabilities`, `resolveClaudeEffort`, `normalizeClaudeCliEffort`, `isClaudeUltracodeEffort`, `resolveClaudeContextWindow`, `resolveClaudeApiModelId`), which upstream replaced with `ClaudeModelCatalog.ts` and `model-manifest.json`; none of these names is used anywhere outside the file except `isLegacyClaudeModel` in the Loom test; and (ii) `spawnClaudeCapabilitiesProbeProcess`, a force-kill exit hook for the capability probe (`de68687e15`, July). Loom registers only pi (`builtInDrivers.ts` `BUILT_IN_DRIVERS = [PiDriver]`); `ClaudeDriver` is imported only for its usage reader (`UsageService.ts` l.77/81), so the probe never spawns. Neither is needed.

| # | Shape | Upstream | Resolution |
| --- | --- | --- | --- |
| 1 | [6/4c] | `NodeChildProcess` import, `resolveProviderProbeTimeoutMs` | theirs |
| 2 | [6/4c] | `envTrampoline`, `HostProcess`, `SpawnWorker` imports | theirs |
| 3 | [1/0o] | (none) | drop Loom's `type SpawnedProcess` import (only Loom's spawn function used it) |
| 4 | [61/28c] | `spawnClaudeProbeThroughEnv` / `spawnClaudeProbeOffThread` (frozen-mount safety) | theirs |

Take **upstream's whole blob** (`git show a09738fb43:apps/server/src/provider/ClaudeProvider.ts`), not per hunk: the silently merged catalogue imports the helpers hunk 2 removes. `ClaudeCapabilitiesProbe.test.ts` [34/2c] [98/22c]: theirs (Rule T, Loom tests of deleted Loom code). Two `loom`-marked hunks deleted on purpose; name them in the marker audit. G1: yes (a deliberate drop).

#### `apps/server/src/provider/ProviderInstanceRegistryHydration.ts` (1 marker, [5/2c])

Loom adds `ProviderEventLoggers | ServerSecretStore | Digest` to the env (the Pi-only registry's env no longer carries them); upstream #34877 adds `SqlClient.SqlClient`. Rule U: all four. G1: no.

#### `apps/server/src/provider/ProviderRegistry.test.ts` (1 marker, [4/148c], 16 `loom` lines in file)

Loom's lines: `retractUsageLimits` stubs (×8), retirement notes for Codex/Cursor registry tests (codex is not registered), and two Claude manifest-minimum tests. Upstream adds "update results across refreshes" (built on `buildRegistryOverSnapshot`, a fake codex instance independent of `BUILT_IN_DRIVERS`) and re-adds "re-probes when settings change the codex binaryPath". Rule T: keep Loom's retirement comment; take upstream's "update results across refreshes" block; drop the re-added "re-probes … codex binaryPath" test (Loom deleted it deliberately, see the `loom:` note at HEAD l.2717). Add `retractUsageLimits: () => Effect.void, // loom:` to the silently merged `buildRegistryOverSnapshot` helper (trial l.508). G1: no.

### Silently merged files Gate 2 reads in this zone

| File | Why |
| --- | --- |
| `apps/server/src/orchestration-v2/ProviderSessionManager.ts` (silent part) | `reportedError` uses `event` (trial l.3020–3023), now a later `const`: rename to `nativeEvent`. #40170 provider-exit note and auto-continue now apply to pi (`backgroundTasksEndWithProcess`); read against Loom's `openTools` and `errorResume` (§3 adapter interactions) |
| `apps/server/src/orchestration-v2/ProviderTurnStartService.ts`, `ProviderTurnControlService.ts` | `withMessageSenderNote` double-labels pi messages (D1) |
| `packages/provider-pi/src/server/rpc.ts` | `parsePiModelSlug` removed by #32585 (`c7a0931537`), replaced by `resolvePiModelSlug(slug, reportedModels)` and `findReportedPiModel`. Loom consumer: `apps/server/src/loom/textGeneration/piOneShot.ts` l.15 and l.71 (the only one; `adapter.ts` and `textGeneration.ts` already call the new function in the trial). Fix: `resolvePiModelSlug(model, undefined)` keeps today's first-slash split; for a provider id containing a slash, first `request({ type: "get_available_models" })` and pass its `models` |
| `packages/provider-pi/src/server/textGeneration.ts` | Loom's `disableExtensions: false` survives (l.83); its comment premise is why status hunk 3 neutralises #24110 |
| `packages/provider-pi/src/server/adapter.test.ts`, `mcpBridge.testkit.ts` | Loom's `loom-jobs` test (l.1678) and `loomHiddenTools` testkit option survive; run them |
| `packages/provider-core/src/server/usageLimits.ts` | Loom's `keepOnSilentProbe` and `removeUsageLimitWindows` survive; managedProvider hunks 5/8 depend on them |
| `packages/provider-core/src/server/ProviderAdapter.ts` | Loom's `loom?: LoomOpenSessionFields` on the open input survives beside upstream's `initialNativeThreadId` and `backgroundTasksEndWithProcess` |
| `apps/server/src/orchestration-v2/ProviderEventIngestor.ts` | #33982 steer status (`steer.updated` pending/completed) lands beside Loom's `ToolOutputImageStore` lines |

`builtInDrivers.ts` is untouched upstream in range and identical to Loom's in the trial (`BUILT_IN_DRIVERS = [PiDriver]`); `DEFAULT_DISABLED_PROVIDER_DRIVERS` in `packages/contracts/src/settings.ts` (trial l.1658) still lists every non-pi driver with Loom's comment. No Loom line was found already lost in these files; the breaks above are wrong lines, not missing ones.

### Left for the integration tracks (S2)

- Typecheck breaks to expect: `piOneShot.ts` (1); PSM `event` (TS2448, 1 site); adapter `sourceFile` before declaration (hunk 9); PTSS `sourceRun` possibly undefined (hunk); `retractUsageLimits` missing from new upstream fakes: `apps/server/src/secrets/SecretCheck.test.ts` (1), `ProviderRegistry.test.ts` (18 `applyUsageLimits:` against 12 `retractUsageLimits` in the trial, so about 6), `ProviderEventIngestor.test.ts` (hunk); `status.loom.test.ts` l.99 argument order; unused `PULL_REQUEST_LINKING_INSTRUCTIONS` import in `mcpExtensionSource.test.ts`.
- Tests to run (S2a): `packages/provider-pi` (adapter, mcpExtensionSource + `.loom`, status + `.loom`, textGeneration + `.loom`, rpc `.loom`), `packages/provider-core` managedProvider, `ProviderSessionManager.test.ts`, `ProviderRegistry.test.ts`, `PiReplayFixtures.integration.test.ts`, `PiCwdOverride.contract.test.ts` (stays green either way; it tests the patch, not the adapter).
- Loom test additions worth making in S2 (Loom tests, no model-read text): in `mcpExtensionSource.loom.test.ts`, also call `before_agent_start` with `{ systemPrompt: "BASE", systemPromptOptions: { sections: {} } }` and assert `sections` stays empty (the path pi 1.5.1 takes); in `mcpExtensionSource.test.ts` "hides the tools named in T3_LOOM_HIDDEN_TOOLS", also assert `mcp__t3_code__preview_snapshot` is `"hidden"`; one adapter test that a spawn-time `--session` resume runs the sanitiser before spawn.
- Marker audit: two Loom-marked hunks deliberately dropped (`ClaudeProvider.ts` catalogue and probe spawn; their test), plus `cwdOverride` if D2 (a). `adapter.ts` markers otherwise net unchanged.
