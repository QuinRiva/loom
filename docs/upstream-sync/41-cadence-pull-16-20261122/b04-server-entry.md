## Appendix B.4: server entry, websocket, startup, connection presentation (11 files, 18 markers, 97 `loom:` lines) · lane 1 server core

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "D1" (launcher protocol 3 to 4) is carried in §8.2 and For deploy; "D2" is §8.1 "Node 26.13.1 on this host"; "D3" is §8.1 "Deploy #590 and #591 before this pull lands".

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/server/src/binCli.ts` · 1m · 4L · [2/1c]
- `apps/server/src/cli/server.ts` · 1m · 1L · [8/12c]
- `apps/server/src/http.ts` · 1m · 2L · [8/2c]
- `apps/server/src/server.ts` · 1m · 15L · [6/2c]
- `apps/server/src/serverRuntimeStartup.autoPull.test.ts` · 1m · 5L · [24/20c]
- `apps/server/src/serverRuntimeStartup.test.ts` · 1m · 9L · [66/57c]
- `apps/server/src/serverRuntimeStartup.ts` · 1m · 7L · [7/4c]
- `apps/server/src/ws.test.ts` · 2m · 15L · [72/27c] [6/1c]
- `apps/server/src/ws.ts` · 5m · 35L · [2/9c] [7/2c] [2/15c] [2/17c] [13/12c]
- `packages/client-runtime/src/connection/presentation.test.ts` · 1m · 1L · [1/2c]
- `packages/client-runtime/src/connection/presentation.ts` · 3m · 3L · [2/5c] [7/1c] [7/3c]

### Per-hunk doctrine

`ws.ts` is one row per hunk. Every other file has one or three hunks, given one row each.

| File / hunk | Shape | Upstream change | Loom side | Rule | Resolution | Gate 1 |
| --- | --- | --- | --- | --- | --- | --- |
| `ws.ts` h1 @753 | [2/9c] | #19259/#19274 issues and issue trackers add `"issues"`, `"issueTrackers"` to `SPLIT_WS_RPC_PREFIXES` | `type ServerWsRpc = RpcGroup.Rpcs<typeof UpstreamServerWsRpcGroup>; // loom: … (seam 21)` | U | Loom's `type ServerWsRpc` line, then upstream's six-prefix `SPLIT_WS_RPC_PREFIXES` | no |
| `ws.ts` h2 @1400 | [7/2c] | #32287: with `httpSnapshotFallback` a resume that cannot replay returns `{kind:"snapshot-required"}` instead of a full snapshot | `fromSnapshot` built with `enrichment: enrichmentAndGoals, // loom:` | D | Take upstream's `snapshotRequired` plus the conditional `fromSnapshot`. Inside its `Effect.gen` branch, replace `enrichment: enrichmentRefreshes` with `enrichment: enrichmentAndGoals, // loom:`. Goals still reach a fallback client: the HTTP shell snapshot carries them (seam 15, DL-420/421) and the follow-up resume path already merges `enrichmentAndGoals` (trial L1461) | yes |
| `ws.ts` h3 @2053 | [2/15c] | #19259/#19274 handlers `issues*`, `issueTrackers*` | `const handlers = UpstreamServerWsRpcGroup.of({ // loom: every non-Loom method (seam 21)` | U | Loom's opening line (the `Upstream…` group and its comment), then upstream's 14 issue handlers | no |
| `ws.ts` h4 @3379 | [2/17c] | #35925: `vcsCreateWorktree` makes a task folder for multi-repo projects, falling back to `gitWorkflow.createWorktree` | Base's `createWorktree(...).pipe(refresh)` plus the tombstone `// loom: detached in pull 9, ledger DT-59 (the workspace-lease gate on this remover).` | D | Take upstream's `vcsCreateWorktree` body. Keep Loom's DT-59 comment on the line above `[WS_METHODS.vcsRemoveWorktree]`, which now holds upstream's `taskFolders.removeIfTaskFolder` body. **Trap:** Loom's side looks like a code edit but carries no Loom behaviour, only the comment | no |
| `ws.ts` h5 @3634 | [13/12c] | #35072 adds a third argument `catalogDigests` to `withoutWorkspaceSnapshots`. Upstream's source is `zipLatestWith(providers, sources)` | Pull 15's Rule D: Loom's `Stream.scan` source and `overlayProviderExhaustion(…, state.marks, now)` (§6.4, Appendix D) | D | Keep Loom's `Effect.gen` body. Change its last call to `withoutWorkspaceSnapshots(commandProviders, yield* currentCatalogsPerCwd, catalogDigests)`. `catalogDigests` is already in scope (trial L~3580, used by `loadServerConfig`). Keep `layerLoomWsRpc` (auto-merged, trial L747/L3936) | yes |
| `ws.test.ts` h1 @351 | [72/27c] | #35868 hoisted the test into a top-level `resumeSkipsUnknownTypes(scope)`, one indent less, `it.effect`/`it.live` | Same body plus 4 `Effect.provideService(LoomStoreV2 / LoomGoalBroadcast / LoomThreadConsult / LoomCacheBroadcast, {} as never)` with the comment `// loom: the shell's goal items are opt-in` | T/D | Take upstream's shape. Append Loom's comment and 4 `provideService` lines at the end of upstream's `subscription.pipe(…)`, after `ProjectEnrichment` (trial L~470) | no |
| `ws.test.ts` h2 @1008 | [6/1c] | #40594 `FeatureFlags.layerTest()` | Loom's 4 `Layer.succeed(Loom…)` plus `Layer.mock(ProviderHealthRegistry)` | U | Keep both | no |
| `server.ts` @785 | [6/2c] | #31723 adds `Layer.provideMerge(SecretCheck.layer)` | `Layer.merge(ProjectStore.layer, ThreadSearchLoom.layer.pipe(Layer.provide(ThreadEmbedderLive)))` replacing `ThreadSearch.layer` (Loom's own index) | U | Loom's `provideMerge(Layer.merge(… ThreadSearchLoom …))` block, then upstream's `Layer.provideMerge(SecretCheck.layer)`. The thread-search owner must confirm `ThreadSearchLoom` still satisfies the target's `ThreadSearch` service | no |
| `http.ts` @432 | [8/2c] | #40133: signed-URL routes are no longer exempted from tracing by prefix; they register with `SIGNED_URL_ROUTE_OPTIONS = { redactedParams: ["*"] }` (Effect 4.1.5 `HttpRouter` `redactedParams`) | Base's prefix list plus `path.startsWith("/loom/mobile/apk/") // loom: the phone app's signed APK links` | Superseded + move | Take upstream's two-line `UNTRACED_REQUEST_PATHS.has(…)`. **Trap:** dropping Loom's line puts the APK token into spans and request logs. Re-apply at the new home: give the route in `apps/server/src/loom/http/loomAgentRoutes.ts:316-327` (`HttpRouter.route("GET", \`${MOBILE_APK_ROUTE}/:token/:name\`, …)`) the option `{ redactedParams: ["*"] } // loom: the APK token is the credential`. `SIGNED_URL_ROUTE_OPTIONS` is not exported, so write the literal. Check that `HttpRouter.route` takes the options argument as `HttpRouter.add` does | yes |
| `serverRuntimeStartup.ts` @211 | [7/4c] | #39915: the startup auto-pull reads `statusDetails` with `GitVcsDriver.AwaitStatusFetch` | DL-81 foreign-home guard `refuseForeignHomeSideEffect("autoPullProjects.pullCurrentBranch", cwd)` | U | Loom's 3-line comment and guard first, then upstream's `statusDetails(cwd).pipe(Effect.provideService(GitVcsDriver.AwaitStatusFetch, true))` | no |
| `serverRuntimeStartup.test.ts` @194 | [66/57c] | #35993 one indent less. #14875 `ServiceLauncherClient` mock `{ managed:false, protocol: undefined, prepareTrial: () => Effect.undefined }`. #36366 new `project-refused` scenario. `record: () => Effect.succeed(true)` | DL-85 `instanceId` assertion (`scenario === "disabled-default" ? instanceId : ProviderInstanceId.make("pi")`), plus Loom's layers (`NodeSqliteClient` memory, `FileSystem.layerNoop`, `LoomStoreV2`, `WorkstreamDispatcher`) | T | Take upstream's block. Re-apply the DL-85 assertion inside `launch` and append Loom's 6 layer lines before the closing `)`. Drop Loom's duplicate `FileSystem.layerNoop({})`, since upstream already provides one | no |
| `serverRuntimeStartup.autoPull.test.ts` @157 | [24/20c] | #35993 indent; `record: () => Effect.succeed(true)` | Loom's `LoomStore.layer.pipe(provideMerge(SqlitePersistence.layerMemory), orDie)`, `NodeFileSystem.layer`, `WorkstreamDispatcher` (DL-81, DL-199) | T | Upstream's block plus Loom's 4 lines (comment and 3 layers) before `)` | no |
| `binCli.ts` @23 | [2/1c] | #35871 `feedbackCommand` import | `goalCommand` (DT-26) and `loomMigrateCommand` imports | U | All three imports. The subcommand list auto-merged with all three (trial L99-102) | no |
| `cli/server.ts` @31 | [8/12c] | #34524 races `runServer` with `awaitServiceLauncherStop()` (a Windows-only IPC stop; `stopChildOverIpc` defaults to `win32`). #32941 `ensuring(DatabaseMaintenance.runRequestedReclaim(config.dbPath))` | DL-87 `resolveServerConfig(…, { …options, selectAutomaticPort, refuseWhenHomeIsLive: true })` with a 2-line comment | U | Loom's comment and `resolveServerConfig` call, then upstream's `const run = Effect.raceFirst(…).pipe(Effect.ensuring(…))`. `refuseWhenHomeIsLive` survives in auto-merged `cli/config.ts` (trial L282, L372) | no |
| `presentation.ts` h1 @26 | [2/5c] | #36419 `awaitingApproval?: true` | `needsSignIn?: boolean` (Loom's "Sign in required.", commit 7005bb89ce) | U | Both fields | no |
| `presentation.ts` h2 @96 | [7/1c] | #30639 `...failureError(state.lastFailure)` (adds `i18nError`) | `error`/`traceId` plus the `needsSignIn` spread on `ConnectionBlockedError` reason `authentication` | D | `...failureError(state.lastFailure),` then Loom's `needsSignIn` spread. `ConnectionBlockedError` and `"authentication"` still exist at the target (`model.ts:126`, `errors.ts:32`) | no |
| `presentation.ts` h3 @146 | [7/3c] | i18n: `resolve(msg("Connection failed. Reason: {error}", …))` | `if (connection.needsSignIn) return "Sign in required.";` before the plain strings | D | Upstream's i18n return. Put Loom's `needsSignIn` check above it, as a plain literal with `// loom:`. A new `msg()` key would need entries in every locale catalog, which `i18n:check` enforces | no |
| `presentation.test.ts` @18 | [1/2c] | #36419 imports `connectionStatusTitle` | `connectionStatusText, // loom` | U | Both imports. Loom's "Sign in required." case auto-merged (L165-185) | no |

Loom-adjacent files upstream changed that Loom's deploy relies on: `serviceLauncher.ts` (+869/−54), `cloud/serviceProtocol.ts` (+130/−6), `cloud/selfUpdate.ts` (+62/−88), `cloud/pinnedRuntime.ts` (+310/−33), `cli/serviceLauncher.ts` (+20/−3). All changed. **S3 must run `apps/server/src/loom/deploy/launcherSeam.test.ts`.** Expected: its protocol assertion (`:672`, `assert.equal(SERVICE_LAUNCHER_PROTOCOL, 3)`) fails, so set it to 4 under D1. Its prune case should still pass, because the target's `prunePinnedRuntimes` still skips symlinked version folders (`!isLink`, `pinnedRuntime.ts:843-850`) and Loom's `runtime/versions/*` are symlinks. What changed, in the parts Loom touches:
- Protocol 4, which accepts protocol-3 state and context.
- A `stop` IPC message, Windows only.
- Unit repointing, inert for Loom (D1).
- A serving lock file (`service-serving.lock`).
- The update preflight also checks `skippedV2Migrations`.
- Runtime prune removes the runtime a committed update replaced (#40817; symlinks are still skipped).

### Silently merged files Gate 2 reads in this zone

| File | Why read it | Loom lines HEAD/trial |
| --- | --- | --- |
| `packages/client-runtime/src/connection/driver.ts` | Upstream +79/−34 (reconnect-loop fixes #39420, #39431, approval-pending). Loom's cookie-auth probe `reclassifyEstablishmentFailure` (re-classifies a transport failure as `ConnectionBlockedError`) must still be called (trial L291) and must not swallow the new `approval-pending` reason | 5/5 |
| `apps/server/src/auth/RpcAuthorization.ts` | Upstream added scopes for issues, peer links and MCP sign-in, plus `providerSignOutPrompt` scope escalation for `dispatchCommand`/`launchThread` (#39027). Check that Loom's 25 lines (seam 21 Loom method scopes) still sit in the scope map | 25/25 |
| `apps/server/src/cli/config.ts` | DL-87 `refuseWhenHomeIsLive` and Loom's worktree-home rule beside upstream's unchanged `rejectRunningServer` | 6/6 |
| `apps/server/src/auth/SessionStore.ts`, `cloud/ManagedEndpointRuntime.ts`, `http.test.ts` | `Cause.pretty` log hunks and test lines; low risk | 3/3, 3/3, 2/2 |

No Loom line in this area is lost in the trial tree.

### Left for the integration tracks (S2)

- `launcherSeam.test.ts:672` → 4, `runner.ts:62` log text, and the README "A launcher protocol change" paragraph (D1). S3 runs the seam test, ideally once more with 6be88bb's launcher.
- `1066_DropHumanMessageDigestItems.ts:12,25`: wrap the subquery in `json((…))` as #34576 did for 026. Any Loom test that runs 1066 on a fresh database fails on 26.13.1 without it. A wide grep found no other Loom SQL passing a subquery into `json_set`/`json_object` (`LoomStore.ts:669` is a plain select column).
- The APK route redaction (`loomAgentRoutes.ts`), with a typecheck that `HttpRouter.route` accepts the options.
- Typecheck after `ws.ts` h5. `withoutWorkspaceSnapshots` has three call sites; trial L1901 and L2639 auto-merged.
- `presentation.ts`: if the coder chooses `msg("Sign in required.")` instead of a literal, run `vp run i18n:generate` and fill every locale catalog.
