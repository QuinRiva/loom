## Appendix B.7: usage hub and limits (server, shared, web, mobile) (9 files, 21 markers, 76 `loom:` lines) · lane 2 providers and usage

Read with §7 (the rules), §8 (the rulings) and the cross-lane table in §7.3. Written from a read of both sides of every hunk in the trial merge; "trial" line numbers are lines of the mid-merge file and move as hunks resolve. A row marked for Gate 1 is on the Gate 1 reviewer's list (§7.5).

**Decision labels used below.** "T1" (text generation) is carried in §8.2; "U1" is §8.1 "Usage hub: which last-good-reading rule"; "U2" (per-account failure notices) is carried in §8.2.

**Other zones are named by their research key:** `toolchain-config` = B.1 · `orchestration-delegation` = B.2 · `store-shell` = B.3 · `remote-auth-deploy` = B.4 · `mcp-tools` = B.5 · `pi-adapter` = B.6 · `textgen-usage` = B.7 · `multirepo-vcs` = B.8 · `markdown-chat` = B.9 · `web-panels-files-diff` = B.10 · `web-sidebar-shell` = B.11 · `labs-settings` = B.12 · `mobile-client` = B.13 · `i18n` = §5.1 · `migrations` = §5.5 · `overlap-audit` = Appendix C · `upstream-digest` = §6.13 and §0.

**Section numbers inside the text below** are this zone's research notes, not the runbook: "section 3" or "§3.x" is the per-hunk doctrine in this file, "section 4" the silently merged list, "section 5" the list for S2; "section 2" (decisions) is mapped to §8.1 above, "section 6" (deploy) is folded into For deploy, "section 7" into §0, "section 8" (follow-ups) into §8.3, and "section 9" (commands) into Appendix A.

### Paths in this zone

- `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` · 2m · 2L · [2/0o] [7/3c]
- `apps/mobile/src/features/usage/usageProviders.ts` · 1m · 3L · [12/1c]
- `apps/server/src/usage/UsageLimitSources.test.ts` · 2m · 2L · [1/0o] [119/314c]
- `apps/server/src/usage/UsageLimitSources.ts` · 2m · 12L · [13/2c] [6/14c]
- `apps/server/src/usage/cliproxyApi.test.ts` · 2m · 12L · [11/9c] [2/5c]
- `apps/server/src/usage/cliproxyApi.ts` · 6m · 21L · [11/9c] [8/1c] [18/3c] [141/14c] [56/2c] [14/29c]
- `apps/server/src/usage/usageScanCache.test.ts` · 1m · 1L · [22/17c]
- `apps/web/src/components/usage/UsageLimitsPooled.tsx` · 3m · 4L · [2/0o] [1/1c] [5/2c]
- `packages/shared/src/usageLimits.ts` · 2m · 19L · [2/2c] [5/6c]

### Per-hunk doctrine

Upstream PRs behind these files: #33800 (`44ebb2fe57`, xAI/Antigravity hub accounts, `HUB_PROVIDERS` table), #30778 (`c436409da0`, per-account routed models, `hubRoutes`, thread card), #36238 (`a09e54a363`, `origin`, `hubPoolResetAt`, `UsageLimitResetFallback`), #38397 (`724f5c6bec`, `keepLastGoodReadings`), #36561 (`4192234c34`, `endpoint`, `hubIdentity`), #36939 (`dcd8df806d`, `unshownFailedHubAccounts`), #31748 (`fd985e0985`), #37893 (`055b44919e`, i18n: `usageLimitsCopy.ts`), #34390 (`e30a27bd20`, `providerColors.ts`), #34030/#35497/#36367 (usage-scan cache). Loom's side throughout is the hub login seam and carry-forward (DL-1806, DL-1813).

#### `apps/server/src/usage/cliproxyApi.ts` (6 hunks, 21 `loom` lines; Rule D; Gate 1 reads)

Target shape: upstream's whole file, then Loom's delta. Loom's `management` (`hubText`, `hubRefusal`, status-aware error) and module-level helpers (`CARRY_FORWARD_MS`, `carriedAccounts`, `trafficUsageLimits`, `hubRefusal`, `fresherClock`) and the trailing `listAccounts` plus return object already merged silently and are correct as they stand.

| Hunk | Shape | Upstream change | Loom's side | Rule | Resolution |
| --- | --- | --- | --- | --- | --- |
| 1 @26 | [11/9c] | #33800 imports (`antigravity*`, `makeUsageLimits`) | `cliproxyLogin`, `hubLogins.loom` imports; `ModelQuota` schema | U | Both import sets (upstream's `makeUnavailableUsageLimits, makeUsageLimits` block replaces Loom's single-name line), then Loom's `ModelQuota`/`ModelQuotas` |
| 2 @62 | [8/1c] | #33800 `project_id` on `AuthFile` | `status`, `status_message`, `last_refresh`, `modtime`, `created_at`, `model_quotas` | U | Upstream's `project_id` line plus Loom's seven lines |
| 3 @83 | [18/3c] | #30778 `AuthFileModels` schema | `CliproxyAuthFile` export, `DownloadedAuthFile`, `decodeAuthUrl`, `decodeAuthStatus` | U | Both. `CliproxyAuthFile` can stay `typeof AuthFile.Type` (upstream later adds a private `type AuthFile` alias; no clash) |
| 4 @640 | [141/14c] | #33800 moved `credits` to module scope taking a `HubCall`; new `readAccount(hub, account, provider)` with `provider.read` and `listedIdentity` | Base's `credits` (unchanged base code), Loom's `downloadAuthFile`/`authUrl`/`oauthCallback`/`authStatus`, and Loom's whole old `readAccount` with the inline Claude/Codex reads | D | Take upstream's: drop Loom's copy of `credits` and of the inline Claude/Codex read bodies (now `HUB_PROVIDERS`). Keep Loom's four login functions inside `makeCliproxyApi`. Rewrite `readAccount(hub, account, provider, carried, record)`: compute `login` with `cliproxyLogin({ ...account, last_refresh: fresherClock(…) }, now)`; `base = { id: account.id, driver: provider.driver, ...listedIdentity(account), login }`; Loom's `dead` early return; then `provider.read(…)` preceded, when `account.provider === "claude" && record && isLongLived(record)`, by Loom's one-year-token `UsageLimitSourceError`; return `{ ...base, ...reading }` |
| 5 @805 | [56/2c] | Closing of upstream's inline `Effect.catch` | Tail of Loom's old Codex read (base code) and Loom's catch: traffic reading vs carried reading, freshest wins, else the hub's reason | D | In the new `readAccount`, Loom's catch replaces upstream's: on failure take the fresher of `trafficUsageLimits(account.model_quotas, now)` (with `plan: "Claude Subscription"` and the kept carried windows, as now) and `{ ...carried, login }`, else `makeUnavailableUsageLimits` with `error.detail` (upstream's message rule). Keep upstream's `Effect.provideService(Digest.Digest, digest)` on `provider.read` |
| 6 @876 | [14/29c] | #30778 `routedModels` per account alongside the reads; #33800 `HUB_PROVIDERS` filter | Loom's split signature `readAccounts(hub, previous, accounts, record)` (listing moved to `listAccounts`), `carried`, per-account `carried.find`/`record(email)` | D | Upstream's body minus its `authFiles` listing: `readable` from the passed `accounts` via `HUB_PROVIDERS` (no longer Loom's `codex`/`claude` filter); `Effect.all` of `readAccount(hub, account, provider, carried.find(…), record(account.email))` and `routedModels`; upstream's `models` merge. Per U1(a), `carried.find` also requires `candidate.email === account.email && candidate.workspaceId === account.workspaceId` with one of them listed |

Every `loom` line of Loom's version is present after this, except the old `driver` ternary (replaced by `provider.driver`) and the inline `apiCall(hub, account, url)` calls (upstream's `apiCall` now takes a header; Loom's login functions use `management`, not `apiCall`). Trap: Loom's side of hunks 4 and 5 is mostly base code upstream moved, not Loom code; keeping it duplicates `credits` and the Claude/Codex reads.

#### `apps/server/src/usage/cliproxyApi.test.ts` (2 hunks, 12 `loom` lines; Rule T)

| Hunk | Shape | Upstream | Loom | Resolution |
| --- | --- | --- | --- | --- |
| 1 @58 | [11/9c] | #33800 explicit account type with `project_id`, optional `id_token` | `status`, `status_message`, `last_refresh`, `model_quotas` | Upstream's explicit type plus Loom's four optional fields and `// loom` note |
| 2 @385 | [2/5c] | #36939 asserts the exact refusal message | `readAll(api, [])` | `const result = yield* readAll(api, []);` with upstream's `toEqual({ reason: "probeFailed", message: "The provider refused the hub request (HTTP 401)." })`: Loom's catch returns `error.detail` when there is no traffic or carried reading, so it holds |

Trap: 12 more `api.readAccounts(config)` calls from upstream's new tests merged silently into this file (count in §9); each becomes `readAll(api, [])`. Gate 1: no.

#### `apps/server/src/usage/UsageLimitSources.ts` (2 hunks, 12 `loom` lines; Gate 1 reads)

| Hunk | Shape | Upstream | Loom | Rule | Resolution |
| --- | --- | --- | --- | --- | --- |
| 1 @42 | [13/2c] | #36238 `windowLimitsModel` import (for `hubPoolResetAt`) | `carriedAccounts`, `CliproxyAuthFile`, `CliproxyHub` imports; `hubLogins.loom` import | U | Both |
| 2 @246 | [6/14c] | #36238/#36561 `base` gains `origin` and `endpoint` | `now`, `checkedAt` from `now`, Loom's `previous` (carry-forward source) | D | Upstream's `base` with `origin`/`endpoint` (needed by `hubIdentity`, `layerResetFallback` and, if kept, `keepLastGoodReadings`), built from Loom's `const now = yield* DateTime.now`, plus Loom's `previous` line and comment |

Silently merged remainder (trial): Loom's "one listing" block, `carriedAccounts` on a failed listing, login dialog, and the no-`BackgroundPolicy` refresh loop all survived. Upstream's `keepLastGoodReadings` (l.123) and its call (l.330) also merged in: per U1(a), the publish line becomes `yield* publish(snapshots); // loom: …` and the function goes. `hubPoolResetAt`, `UsageLimitResetFallback`, `layerResetFallback` stay (inert for pi, §5).

#### `apps/server/src/usage/UsageLimitSources.test.ts` (2 hunks, 2 `loom` lines; Rule T)

| Hunk | Shape | Resolution |
| --- | --- | --- |
| 1 @16 | [1/0o] | Keep Loom's `import * as FileSystem` (Loom's hub-login test reads `hub-logins.json`; upstream deleted nothing here, its `Fiber` import is already merged above) |
| 2 @194 | [119/314c] | Both blocks: Loom's hub-login dialog test and paste-shape test; upstream's "keeps an account's last good reading…" (#38397) and "the reset fallback refreshes its hub…" (#36238) plus helpers. Under U1(a), upstream's first test stays as a test of Loom's carry with the identity guard, and needs a marked `ServerConfig.layerTest(process.cwd(), …).pipe(Layer.provideMerge(NodeServices.layer))` (Loom's `make` reads `stateDir`, DL-1813's precedent); its `BackgroundPolicy` mock is harmless. Under U1(c) it stays as is |

#### `packages/shared/src/usageLimits.ts` (2 hunks, 19 `loom` lines in Loom's version, 23 in the trial file; Gate 1 reads hunk 2)

| Hunk | Shape | Upstream | Loom | Rule | Resolution |
| --- | --- | --- | --- | --- | --- |
| 1 @16 | [2/2c] | `UsageLimitSourceAccount`, `UsageLimitSourceSnapshot` types (#36561, #36939) | `UsageLimitSourceId` (marked), `UsageLimitSourceLogin` | U | All four |
| 2 @438 | [5/6c] | #36561 `hubIdentity`/`hubRowKey` keys | Dead accounts stay as rows | D | Upstream's `resolved`/`hub`/`key`/`hubRowKey` lines, with Loom's `dead` line and `if (limitsNotice(…) !== null && !dead) continue;` in place of upstream's skip |

Silently merged remainder, two problems:

1. **Compile break.** Loom's `loginAlertText` (trial l.786, l.790) calls `formatDuration`, which upstream (#37893) moved to `packages/shared/src/usageLimitsCopy.ts` and deleted here with `HOUR`/`DAY`. `usageLimitsCopy.ts` imports `usageLimits.ts`, so importing back is a cycle. Resolution: a `// loom:` module-private `formatDuration` (the base's 7 lines plus `HOUR`/`DAY`) beside `loginAlertText`.
2. **Duplicate notice.** Upstream's new `unshownFailedHubAccounts` (#36939) counts a row as shown only when `limitsNotice(...) === null`, so a dead account, which Loom keeps as a row, also gets a "hub · email: Signed out…" notice under the pools (web and mobile), on top of Loom's login alert. Add `|| account.login?.status === "dead"` (marked) to its hub `shownRows` condition.

Every other Loom export is present and its consumers resolve (checked every name imported from `@t3tools/shared/usageLimits` in the trial tree; §9).

#### `apps/web/src/components/usage/UsageLimitsPooled.tsx` (3 hunks, 4 `loom` lines)

| Hunk | Shape | Resolution |
| --- | --- | --- |
| 1 @6 | [2/0o] | Trap (`o` is an upstream move): drop `formatResetsIn` (base line; upstream imports it from `usageLimitsCopy` at l.53–57 now), keep `loginAlerts, // loom` |
| 2 @17 | [1/1c] | Union: `unlinkedUsageSources, // loom` and `type ResetCreditChoice,` |
| 3 @697 | [5/2c] | Upstream's `collectLimitNotices(presentations, m)` and `collectExternalUsageLinks(presentations, m)`, plus Loom's comment, `logins` and `unlinked` lines |

#### `apps/mobile/src/features/usage/UsageLimitsPooled.tsx` (2 hunks, 2 `loom` lines)

| Hunk | Shape | Resolution |
| --- | --- | --- |
| 1 @10 | [2/0o] | Trap: drop `formatResetsIn` (upstream deleted it; nothing in the merged file calls it), keep `loginAlertNotices,` and mark it `// loom` (it is unmarked today) |
| 2 @491 | [7/3c] | Upstream's `const m = useMessages();`, `collectLimitNotices(selected, m)`, `collectExternalUsageLinks(selected, m)`, plus Loom's `loginAlerts` block |

#### `apps/mobile/src/features/usage/usageProviders.ts` (1 hunk, 3 `loom` lines)

[12/1c], #34390: upstream replaced the inline colour map with `providerColors(scheme)` in the new `apps/mobile/src/features/usage/providerColors.ts`, which the Android widget also reads (`apps/mobile/src/widgets/subscriptionUsageSnapshot.ts` l.226). Rule D: take upstream's one-line body; Loom's pi colour moves to its new home, `providerColors.ts`: `pi: scheme === "dark" ? "#7aa2ff" : "#3d5afe", // loom: …` in place of `pi: "#4d9f8a"`. The widget then shows Loom's pi blue too. Loom's pi-first `PROVIDER_ORDER` and label merged silently.

#### `apps/server/src/usage/usageScanCache.test.ts` (1 hunk, 1 `loom` line)

[22/17c]. Loom's side: the pull-10 test "drops pi entries without parse state…" plus base's v9 advisor test, which upstream deleted. Upstream's side: a v14 Codex test. The Loom line it guards (`usageScanCache.ts` l.290, "remove at pull 11") is dead: it drops pre-October stateless pi entries, and the cache (now version 17) has been rewritten on every scan since. **Superseded by time, not by upstream**: take upstream's side, drop Loom's test, and delete the Loom line in `usageScanCache.ts` (silently merged). If kept instead, the test must call upstream's `parse(...)` because `makeScanCacheWriter` now returns chunks (#34030).

### Silently merged files Gate 2 reads in this zone

| File | Why |
| --- | --- |
| `packages/provider-pi/src/server/textGeneration.ts` (+ test) | Loom's three `loom` lines survived (extensions on, no `--no-extensions` hint, dialog cancel). New upstream behaviour: a model option `thinking` triggers `pi --version` (4 s) and a compatibility check before every generation (#26069, #39434). The cockpit's stored option id is `thinkingLevel`, which pi's capabilities do not define (`id: "thinking"`), so neither the old nor the new code applies it; a fresh pick in Settings writes `thinking` and turns the version probe on |
| `packages/shared/src/serverSettings.ts` | `defaultTextGenerationModel` was made module-private by #35391 (`c5f5efdbd2`), not removed; its one consumer was upstream's `TextGeneration.ts`. No Loom consumer in `HEAD`, Loom-only files or the trial tree |
| `apps/server/src/textGeneration/TextGeneration.ts` | No Loom lines; carries the #24110 fall-through described in §2 T1 |
| `apps/web/src/components/usage/UsagePage.tsx` | Loom's `TopThreadSpend` wrapper (seam 11) survived; `window` and `selectedEnvironmentIds` are still in scope; upstream added a `limits` metric, and `TopThreadSpend` stays on the cost tab only. Read once |
| `packages/contracts/src/providerUsageLimits.ts` | Loom's `login` fields survived beside upstream's `models`, `origin`, `endpoint`, `modelIds`, `providerIds`, reset-credit `options`, `zeroSpendCap` |
| `packages/provider-core/src/server/usageLimits.ts` | Loom's `removeUsageLimitWindows` survived; upstream's changes (#35341, #34146) are 11 additive lines |
| `apps/server/src/usage/usageScanCache.ts` | The dead Loom line, §3 |
| `docs/user/usage.md` | Loom's hub-login section survived beside upstream's new hub-routing text |
| `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts` | Upstream-only (#35397, one line); Loom does not modify it. Not a Gate 2 read |

Already lost or wrong in the trial tree: `formatDuration` in `usageLimits.ts` (compile break) and the dead-account duplicate notice (§3).

### Left for the integration tracks (S2)

- Typecheck: `usageLimits.ts` `formatDuration` (2 call sites); `apps/server/src/loom/textGeneration/piOneShot.ts` imports `parsePiModelSlug`, removed by #32585 (`c7a0931537`): use `resolvePiModelSlug(model, undefined)` (or request `get_available_models` first as `textGeneration.ts` does, which handles provider ids containing `/`), and add `shortLived: true` to its `buildPiRpcLaunch` for parity with #30187 (a stop mid-request no longer loses a rotated OAuth token).
- Tests: 12 `api.readAccounts(config)` calls in `cliproxyApi.test.ts` → `readAll(api, [])`; one upstream test in `UsageLimitSources.test.ts` needs `ServerConfig.layerTest`; drop Loom's scan-cache test.
- For the `ws.ts` reader (`remote-auth-deploy`): the provider-status stream's payload grew, with nothing renamed: `ServerProvider.supportsTextGeneration` and per-model `supportsTextGeneration` (#24110), `ServerProviderAuth.endpoint` (#36238), usage windows' `modelIds`/`providerIds` (read by `exhaustedUsageWindow`), reset-credit `options` and `zeroSpendCap`; on `usageLimitSources`, `origin`/`endpoint` per source and `models` per account (#30778). `overlayProviderExhaustion` only sets `status`/`message`, so it composes; Loom's pi windows set no `modelIds`, so `exhaustedUsageWindow` behaves as before for pi.
- Lint: the mobile `loginAlertNotices` import gets its `// loom` marker.
