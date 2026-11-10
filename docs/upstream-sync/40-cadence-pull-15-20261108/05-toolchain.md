## 5. Toolchain: Effect 4.1.2, `@effect/tsgo`, the `.repos/effect` rename

### 5.1 What moved, and what it means for the host and the VM

| Item | Base → target | Consequence |
| --- | --- | --- |
| Effect, `@effect/*` | 4.0.5 → **4.1.2** (`pnpm-workspace.yaml` catalog; `@effect/platform-bun` added; `@effect/vitest` patch re-cut as `patches/@effect__vitest@4.1.2.patch`) | A dependency bump `vp i` performs; the API breaks are §5.2. **The Slack bridge** (`~/loom-slack-bridge`, declares `effect: 4.0.4`) runs on the cockpit release's `effect` through a symlink (`RUNBOOK.md` "Every bridge release resolves the running release's contracts"), so it runs on 4.1.2 from the flip; its imports (`effect/Effect`, `Layer`, `Stream`, `rpc`, `socket`, `ManagedRuntime`, `Fiber`, `Deferred`, `Exit`, `Cause`, `Scope`) are modules 4.1 did not rename, so the expected outcome is "nothing", and the deploy's bridge restart is the proof (For deploy) |
| TypeScript checker | `typescript: npm:@tsc-rs/typescript@0.8.0` (catalog override, every package's `typecheck: tsc --noEmit`) → **`@effect/tsgo` 0.67.1** as a root devDependency, every package's `typecheck: effect-tsgo tsrs --noEmit`; the `typescript` catalog entry and the `@tsc-rs/*` release-age exclusion are gone; `tsconfig.base.json` now `extends: ./tsconfig.effect.json`, which holds the `@effect/language-service` plugin so `apps/mobile` can extend it beside Expo's base (#31111) | `vp run typecheck` is unchanged as a command (`vp run -r --cache --concurrency-limit 4 typecheck`, still cached per package); what runs underneath is the Rust TypeScript 7 checker with Effect's diagnostics built in. Nothing to install on the host or VM beyond `vp i` (tsgo ships `@effect/tsgo-linux-x64` as an optional dependency). `evals/package.json`'s conflict takes upstream's tsgo line beside Loom's `explainer-density` script. `AGENTS.md` l.135's tsc-rs sentence is replaced by upstream's (§6.9) |
| Effect diagnostics at `error` | 47 → **86** of the `diagnosticSeverity` entries (54 → 93 entries; 40 new names, one replacing `preferSchemaOverJson`, net +39 at `error`) (§5.3) | S2's typecheck is the sweep; the first `vp run typecheck` after `vp i` is the count |
| `.repos/effect-smol` → `.repos/effect` | upstream #30481 renamed the vendored Effect checkout and re-synced it at 4.1.2 (3,007 files; alchemy-effect 21,119) | `scripts/lib/reference-repos.ts` (id `effect`, prefix `.repos/effect`) and `scripts/sync-reference-repos.ts` (+155) are upstream's and auto-merge; `vpr sync:repos` keeps working. `AGENTS.md`'s "`.repos/effect/LLMS.md`" line auto-merged into Loom's file (verified in the trial tree). Loom's older plans that say `effect-smol` are history. The one conflict is `.repos/effect/.envrc` (DU): upstream tracks a `use flake` direnv file Loom's tree has never carried (every pull since 10 resolved it as deleted); S1 `git rm`s it again (Appendix B) |
| Node, pnpm | 26.12.1 / 12.14.0 → same | No host or VM change (DL-1509) |
| React, Vite+, `@pierre/diffs` | 19.3.0 / 1.4.0 / 1.6.1 → same | No change |
| Electron | 44.10.0 → 44.10.1 | Desktop only |
| `alchemy`, `@alchemy.run/*`, `@distilled.cloud/*` | beta.84 → beta.85 (+ `@alchemy.run/test` and its patch), rc.17 → rc.18 | Relay infrastructure, not Loom's |
| pi | `@earendil-works/pi-coding-agent` 1.3.0 (catalog + patch) | Upstream does not depend on it; the catalog line and patch survive in the `pnpm-workspace.yaml` unions (hunks 1 and 3). pi 1.5.0 exists; a bump is the monthly platform update, not this pull. Upstream's adapter now holds prompts during a compaction (§6.1): the hold engages on 1.3.0 (it emits `compaction_start`); only the re-hold after pi 1.4.0's rejection message never fires here. `--offline` and `--session-dir`, which upstream now passes, exist in 1.3.0 (`dist/cli/args.js`) |
| `strictPeerDependencies: true` (new in `pnpm-workspace.yaml`) | | `vp i` refuses an unmet peer instead of warning. pi has no peers; Loom's other fork-only deps (`google-auth-library`, `jsdom`, `zod` 3 in web) are checked by S1's first `vp i`; a refusal is a DL row with the `peerDependencyRules` entry it needs |
| `pnpm-workspace.yaml` hunk 2 | upstream moved `minimumReleaseAgeExclude` below `publicHoistPattern` and added the eight `@effect/tsgo*` entries; Loom's `minimumReleaseAge: 0` and its stale copy of the list sit at the old place | Keep Loom's two comment lines and `minimumReleaseAge: 0` (marked), drop Loom's copy of the exclude list (upstream's moved list auto-merged at l.469 of the trial file). An "A" hunk that is a move, §7.1 |
| `apps/server/package.json` | `@anthropic-ai/claude-agent-sdk` ^0.3.276 → ^0.3.316, `@cursor/sdk` 1.0.38 → 1.2.0; `jose` removed (#30474 replaced it with `effect/jose`) | Hunk 1 union with Loom's pi catalog line; hunk 2 ("ours-only") keeps `google-auth-library` (Loom's Vertex embedder) and drops `jose` (upstream's line, now dead; Loom never imported it) |
| `patches/` | + `@alchemy.run__test@2.0.0-beta.85`, `react-native-enriched-markdown@1.2.0-t3.16`; `@effect__vitest` and `alchemy` re-cut; − the 4.0.5/beta.84 patches | Loom's pi patch stays |

### 5.2 Effect 4.1.2: the API breaks Loom code hits

From `.repos/effect/packages/effect/CHANGELOG.md` 4.1.0 ("Breaking changes")
and upstream's own refactors (#30501 "move HMAC, key, and random work to
effect/crypto", 33 files; #30474 jose; #31218 env):

| Break | Loom exposure | Fix (S2a unless noted) |
| --- | --- | --- |
| **`effect/Crypto` is gone.** `Crypto.Crypto` → `effect/crypto/SecureRandom` (`SecureRandom.SecureRandom`, `random.uuidV4()`), hashing → `effect/crypto/Digest` (`Digest.Digest`, `digest.digestHex(Digest.sha256, bytes)`); crypto is no longer in the `NodeServices`/`*Services` bundles (provide `NodeCrypto.layer`); `effect/testing/TestCrypto` → `Layer.mock` | **8 Loom-only files:** `cli/goal.ts`, `loom/handoff/handoffDraft.ts`, `loom/handoff/retroDraft.ts`, `loom/query/documentQuery.ts`, `loom/workstream/brief.ts`, `loom/wsMethods.ts`, `mcp/toolkits/workstream/idempotency.ts`, `loom/prToolkit.test.ts`. **4 Loom hunks in conflicted files:** `CheckpointService.ts` (hunk 1: Loom's `NodeCrypto` sync digest for `loomBaselineRef` beside upstream's `Digest` import; hunk 2: `Crypto.Crypto` in Loom's env union → `Digest.Digest`), `ProjectSetupScriptRunner.ts` (`crypto.randomUUIDv4()` → `random.uuidV4()` inside Loom's breadcrumb block), `ThreadSettlementService.test.ts` (`Layer.succeed(Crypto.Crypto, testCrypto)` → `SecureRandom.SecureRandom`, upstream's side, with Loom's `LoomStoreV2` mock beside it), `ProviderInstanceRegistryHydration.ts` (type import). Loom test layers that leaned on `NodeServices.layer` for crypto (`mcpHttp.testkit.ts`, `loomOrchestratorLayer.ts`, `AgentContextBudget.test.ts`'s Loom stubs) add `NodeCrypto.layer` as upstream's `AgentContextBudget.test.ts` does | Mechanical, by the first typecheck's list. S1 does the four hunks as part of their files (the Loom hunk takes the new name where upstream's side already shows it); S2a does the eight files and the test layers |
| `McpServer`: registration layers go through `layerHttp({ registrations })`; construction-time handler services are captured by `provideRegistrationServices` middleware (`McpHttpServer.ts` +121/−40) | `LoomToolkitRegistrationLive` (`mcp/toolkits/workstream/registration.ts`) registers with `server.addTool({ tool, annotations, handle })`, which 4.1.2 still exports with that shape (`ai/McpServer.ts` l.982), and its `handle` reads `McpInvocationContext` from the fiber at request time, which the auth middleware still provides per request. `layerTools` keeps Loom's line (the `McpHttpServer.ts` conflict is one import line, union) and `layer = layerMcpTransport(layerTools)` carries it through `registrations` | Compiles by inspection; `registration.test.ts` (hosted/thread-less refusals) and `mcpHttp.testkit.ts` prove it in S2a. `McpHttpServer.test.ts`'s callers changed from `layerMcpTransport.pipe(…)` to `layerMcpTransport(Layer.empty)`: upstream's own tests, auto-merged; Loom's testkit follows if it builds the transport |
| `jose` → `effect/jose` | None: Loom never imported `jose` (`vertex.loom.ts` uses `google-auth-library`) | Drop the dead `jose` line in `apps/server/package.json` (§5.1) |
| `HostProcess.Environment` for env reads (#31218), `Config.String(…)` for single values | 3 Loom reads inside Effect code: `cli/loomMigrate.loom.ts` l.111 (`{ ...process.env, GIT_OPTIONAL_LOCKS }` in a sync `execFileSync` wrapper), `loom/workstream/consult.ts` l.215 (`{ ...process.env, PI_CACHE_RETENTION }` for the consult fork's launch), `apps/server/scripts/migrate-dev-db.ts` (`process.env.T3CODE_HOME`, Loom's `sharedHome` default). The Pi extension sources (`loomExtension.ts`, `loomExtensionParts/*`) read `process.env` in pi's process, outside Effect: not diagnosed | `processEnvInEffect` is at `error` (§5.3): each becomes `yield* HostProcess.Environment` as upstream's `GitVcsDriver.ts` does, or a `Config.String` with default |
| `FileSystem.make` implementations must provide `readDirectoryEntries`; `ChildProcess.TemplateExpression` removed | Loom's test fakes: grep finds no `FileSystem.make` or `TemplateExpression` in Loom-only files | None expected; the typecheck tells |

Grep over the 661 Loom-only files and the 15,612 Loom-added lines in shared
files finds nothing else from the changelog's breaking list; the rest of the
4.1 surface Loom uses (`Effect.fn`, `Schema`, `SqlClient`, `Stream`,
`Layer.mock`, `DateTime`) is unchanged. The catch-all is S2a's first
`vp run typecheck`.

### 5.3 The diagnostics `tsconfig.effect.json` adds at `error`

Compared with pull 14's `tsconfig.base.json` (54 entries), the plugin config
gains **40** names, all at `error`, one of which (`globalJsonInEffect`)
replaces `preferSchemaOverJson`: net **+39** at `error` (54 → 93 entries,
47 → 86 at `error`; nothing changed severity). The ones with a greppable
Loom footprint:

| Diagnostic | What it flags | Loom sites (grep ceiling, non-test Loom-only server/package files + Loom-added lines) | Fix |
| --- | --- | --- | --- |
| `preferSchemaTaggedError`, `extendsNativeError` (#31216) | `Data.TaggedError` and `extends Error` classes | **2:** `EmbeddingError` (`embedding/EmbeddingProvider.loom.ts` l.4), `LoomLedgerReconciliationError` (`persistence/LoomMigrations.ts` l.191); 0 `extends Error` | `Schema.TaggedError<Self>()("Tag", { fields })` as upstream's refactor did (87 files of examples) |
| `effectTryWithoutCatch` (#31217) | `Effect.try(() => …)` without a `catch` | **1:** `loom/prompt/sessionComposerLive.ts` l.263 (`launchStamp`, then `Effect.ignore`); `loomMigrate.loom.ts`'s `attempt` already has a catch | `Effect.try({ try, catch })` with a typed error, or keep the ignore and name the cause |
| `processEnvInEffect` (#31218) | `process.env` inside Effect code | **3** (§5.2) | `HostProcess.Environment` |
| `effectSucceedWithUndefined` | `Effect.succeed(undefined)` | **4:** `loom/userInput/askWaiters.ts` l.86, `Orchestrator.loom.ts` l.1325, `ThreadEmbedder.loom.ts` l.293, `ThreadSearch.loom.ts` l.177 | `Effect.void` |
| `globalJsonInEffect` (replaces `preferSchemaOverJson`; off in tests) | `JSON.parse`/`JSON.stringify` inside Effect code | 14 + 28 Loom-only files use them somewhere; how many are inside Effect code the checker decides. Two Loom files carry `@effect-diagnostics preferSchemaOverJson:off`, a name that no longer exists | Each hit: a `Schema.fromJsonString` decode, or the off-switch renamed to `globalJsonInEffect:off` with its reason |
| Suggestion rules locked in (#31111): `flatMapToMap`, `flatMapToTap`, `mapConstToAs`, `syncToSucceed`, `unnecessaryPipe`, `effectMapVoid`, `catchAllToMapError`, `catchTagToCatchReason`, `matchEffectToMatch`, `matchToResultOrOption`, `timeoutCatchTagToTimeoutOrElse`, `acquireReleaseDisposable`, `redundantOrDie`, `errorPayloadShadowsName`, `unnecessaryTypeofType`, … (the rest of the 40) | Shape rewrites the checker suggests | Not greppable; upstream fixed its own tree in #31111 (43 files), so the count on Loom's 266 files is of the same order as pull 14's 40 (DL-1655) | Mechanical per diagnostic, S2a by package, S2b for `packages/client-runtime` and web (`apps/mobile` now runs the rules too, #31111; Loom's mobile hunks are not Effect code) |

`effectFnOpportunity` stays off in tests and testkits (the override now
lists the directories one by one); `unstableApiUsage`/`experimentalApiUsage`
stay off. A diagnostic whose hits exceed a day gets a reasoned per-site
`@effect-diagnostics <name>:off` as upstream's own files do, with a DL row and
a follow-up (pull 14 §12's rule, unchanged).

### 5.4 Lint rules new this week

`vite.config.ts` (silently merged, Loom's 17 lines intact): the lint config
gains `t3code/max-settings-description-length` at `error` over
`apps/web/src/**` (Loom's `LoomAutoOpenSettingsRows` and the context-viz
settings rows are the candidates) and a mobile import restriction
(`AndroidScreenHeader`/`WorkspaceAppBar` → `AppBar`; Loom's mobile files do
not import either). `oxlint-plugin-t3code/` adds the rule and a
`no-raw-resize-observer` test. The `knip:check` script is now a Vite+ task
(`knip:check:all` → `knip:check:files` + `knip:check:exports`, side by side);
Loom's `knip.jsonc` entries (`provider-fx` DL-1692, the pi ignore) merged
silently.
