---
manager_sessions:
  - id: fc530ab2-337f-4fa6-804b-a89cf526566b
    role: plan
    authored_at: 2026-07-06T07:44:07.147Z
---

# Provider subscription-exhaustion failover

Design for detecting subscription exhaustion (5h/weekly limits, per-model carve-outs), failing threads over across providers and model families, resuming stalled threads when windows reset, and giving the user visibility and control.

## 1. Intent

Three user-visible failures today:

1. **Threads stall on exhaustion.** When a subscription window hits its limit, the turn dies as `session.status = "error"` with a raw provider string. Nothing retries at window reset; nothing fails over to a healthy provider. Only a same-model Anthropic↔Vertex per-turn retry exists, triggered by a regex on the error string.
2. **New threads inherit exhausted providers.** Spawn resolution (explicit → preset → role preset → parent inheritance) never consults exhaustion state, so children default onto dead accounts.
3. **No visibility or control.** Usage telemetry exists (`AccountUsageRegistry` + `SubscriptionUsagePoller`) but feeds only the usage pill. There is no way to see "Codex is exhausted until 15:40" or to say "stop using this account".

Additional requirement (verified live, §3): subscriptions carve out **per-model limits** alongside account-wide ones — e.g. an Anthropic Team plan with weekly "All models" at 81% but weekly **Fable at 100%**. Fable is exhausted while Opus on the same subscription is fine. Exhaustion state must therefore be keyed at **(account, model)** granularity with an account-wide level as the coarser fallback. This keying is the expensive-to-reverse part and must be right from the start.

### Non-goals for v1

- Cross-model failover for the direct `codex`/`claudeAgent` driver harnesses (§9).
- An "ask before switching" interactive mode (automatic-with-notification only; "ask" is rejected — user decision D1).
- Per-model manual pause (account-level pause only in v1).

## 2. Verified architecture anchors

All verified in this worktree (2026-07-06):

| Concern                           | Anchor                                                                                                                                                                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Spawn model precedence            | `apps/server/src/mcp/WorkstreamSpawnHttp.ts:190-206` (`resolvePresetSelection`), handler `:542-566`, dispatch `thread.create` `:621-648`                                                                                                                                           |
| Existing transient retry/fallback | `apps/server/src/provider/Drivers/PiDriver.ts` — regex `:538-539`, `PI_BACKEND_PARTNERS` `:544-548`, `piBackendFallbackModel` `:556-571`, `settleRetry` `:704-728`, `dispatchTurnRetry` `:820-880` (emits `model.rerouted`), `scheduleTurnRetry` `:888-927`, `failTurn` `:790-815` |
| Error chokepoint                  | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1941-1970` — `runtime.error` → `thread.session.set` `status:"error"`, `lastError` raw string                                                                                                                     |
| Error classes                     | `packages/contracts/src/providerRuntime.ts:99-106` — `RuntimeErrorClass` has no quota class                                                                                                                                                                                        |
| Usage registry                    | `apps/server/src/provider/Services/AccountUsageRegistry.ts` — ephemeral, keyed `providerInstanceId ?? providerName`, **merges windows by `kind` alone** (`mergeWindows`)                                                                                                           |
| Usage poller                      | `apps/server/src/provider/Layers/SubscriptionUsagePoller.ts` — 60s GETs, feeds registry as `providerName: "claudeAgent" / "codex"`                                                                                                                                                 |
| Usage fetchers                    | `apps/server/src/provider/quotas/piQuotas.ts` — decodes only `five_hour`/`seven_day` (Anthropic) and `primary_window`/`secondary_window` (Codex)                                                                                                                                   |
| Claude SDK rate-limit events      | `apps/server/src/provider/Layers/ClaudeAdapter.ts:243-265` — `seven_day_opus`/`seven_day_sonnet` collapsed into `"secondary"`                                                                                                                                                      |
| Availability contract             | `packages/contracts/src/server.ts:158-195` — `ServerProvider.availability` / `unavailableReason`                                                                                                                                                                                   |
| Settings                          | `packages/contracts/src/settings.ts` — sparse JSON, `withDecodingDefault`, whole-map-replace patches; **new optional fields need no data migration**                                                                                                                               |
| Session contract                  | `packages/contracts/src/provider.ts:34-51` — `ProviderSession.lastError` (string only, no class)                                                                                                                                                                                   |
| Turn dispatch command             | `thread.turn.start` (`packages/contracts/src/orchestration.ts:1037`), used by `WorkstreamDispatcher` for kick-off/retry turns                                                                                                                                                      |

Key structural fact: the workstream path is the **pi driver**, where "model" is a `provider/modelId` slug (`openai-codex/gpt-5.5`, `anthropic/claude-fable-5`, `google-vertex-claude/claude-opus-4-8`) and a live thread can be retargeted cross-family via one `set_model` RPC. Cross-provider/cross-model failover is a T3-server capability we already hold.

## 3. Telemetry findings (live-verified)

Both provider usage endpoints were fetched live with the on-disk pi credentials. The findings materially shape the design:

**Anthropic `GET api.anthropic.com/api/oauth/usage`** — the per-model breakdown is **already in the payload we poll every 60s and is being dropped by the decoder**. Alongside the legacy `five_hour`/`seven_day` objects there is a uniform `limits` array:

```json
"limits": [
  { "kind": "session",       "group": "session", "percent": 30,  "severity": "normal",   "resets_at": "…", "scope": null, "is_active": false },
  { "kind": "weekly_all",    "group": "weekly",  "percent": 81,  "severity": "warning",  "resets_at": "…", "scope": null, "is_active": false },
  { "kind": "weekly_scoped", "group": "weekly",  "percent": 100, "severity": "critical", "resets_at": "…",
    "scope": { "model": { "id": null, "display_name": "Fable" }, "surface": null }, "is_active": true }
]
```

Note the wrinkle: `scope.model.id` is `null` — only a **display name** ("Fable") identifies the model. Mapping to a pi slug (`anthropic/claude-fable-5`) needs a normalised-substring heuristic against the pi catalogue, with a display-only degradation when no match is found (§4.2).

**Codex `GET chatgpt.com/backend-api/wham/usage`** — carries **explicit exhaustion booleans** the decoder currently drops: `rate_limit.allowed: false`, `rate_limit.limit_reached: true`, plus `rate_limit_reached_type` (verified against a genuinely exhausted account: primary window 100%, `reset_at` epoch). Per-model carve-outs would presumably arrive in `additional_rate_limits`, which is `null` on this account — **shape unknown; flagged as a risk, not designed against** (§10).

**Claude SDK adapter events** — `rate_limit_event` already delivers `seven_day_opus` / `seven_day_sonnet` types, i.e. model-family-scoped windows, currently collapsed into `kind: "secondary"`.

**Latent bug (fix in scope):** both `claudeRateLimitWindow` and `AccountUsageRegistry.mergeWindows` key windows by `kind` alone, so a model-scoped weekly **clobbers** the all-models weekly (and vice versa). The scoped-window contract change below fixes this by construction.

## 4. Exhaustion state model

### 4.1 Keying

Exhaustion is a property of an **upstream subscription account**, optionally narrowed to a **model scope**:

```
ExhaustionKey = (accountKey, modelScope)
  accountKey : same key space as AccountUsageRegistry — providerInstanceId ?? providerName
               ("claudeAgent", "codex", or a named instance id)
  modelScope : "*" (account-wide)  |  a model identifier within that account
```

Lookup semantics: a model is exhausted iff its **model-scoped mark** is active **or** the account's **`*` mark** is active. A `weekly_scoped` window at 100% exhausts only that model; `session`/`weekly_all` at 100% exhausts the whole account.

The pi driver's slug namespaces map to account keys via a small static table (server-side runtime logic, **not** in the schema-only contracts package):

```
anthropic           → claudeAgent      (Anthropic subscription)
openai-codex        → codex            (ChatGPT/Codex subscription)
google-vertex-claude → (none)          (API-billed; no subscription window)
```

`google-vertex-claude` never registers exhaustion in v1 — API billing has no 5h/weekly window. (Spend caps are future work.)

### 4.2 Contract change: scoped usage windows

Extend `AccountUsageWindow` (`packages/contracts/src/providerRuntime.ts:576-597`) with an **optional** scope — mobile-compatible because absent means account-wide, exactly today's semantics:

```ts
AccountUsageWindow = {
  kind: "primary" | "secondary",
  usedPercent: number,
  resetsAt: string | null,
  windowDurationMins: number | null,
  // NEW — absent ⇒ account-wide window (today's shape)
  scope?: {
    displayName: string,        // e.g. "Fable" (always present when scoped)
    modelId?: string | null,    // resolved pi modelId when mappable, else null
  },
}
```

Feeder changes:

- `fetchAnthropicUsage` decodes the `limits` array (preferred; uniform and severity-tagged), mapping `session → primary`, `weekly_all → secondary`, `weekly_scoped → secondary + scope`. Falls back to the legacy `five_hour`/`seven_day` objects when `limits` is absent.
- `fetchCodexUsage` additionally decodes `allowed` / `limit_reached` and returns them alongside the windows (see 4.4).
- `claudeRateLimitWindow` maps `seven_day_opus`/`seven_day_sonnet` to `secondary + scope { displayName: "Opus"/"Sonnet" }` instead of clobbering the all-models weekly.
- `AccountUsageRegistry.mergeWindows` re-keys by `(kind, scope?.displayName ?? "")` — fixes the latent clobbering bug. Sample buffers (`sampleBufferKey`) get the same key extension so slope projection works per scope.

**Display-name → slug mapping** (server-side, e.g. `apps/server/src/provider/exhaustionMapping.ts`): normalise (`lowercase`, strip non-alphanumerics) and substring-match the display name against the pi catalogue's modelIds within the account's namespace(s) — `"fable"` ⊂ `"claude-fable-5"`. On no match (or ambiguity), `modelId` stays `null`: the window is **shown in the UI but never used for routing**. Conservative by design; a wrong mapping would silently reroute the wrong model.

### 4.3 Where the state lives

**Recommendation: a new, small `ProviderHealthRegistry` service** (`apps/server/src/provider/Services/ProviderHealthRegistry.ts`) rather than growing `AccountUsageRegistry`. The usage registry is a clean telemetry store with one writer; exhaustion state has different concerns — marks from two sources, TTL expiry, manual pauses from settings — and two more consumers (driver routing, resume sweep). Keeping "what the provider reported" separate from "what T3 concluded" keeps both legible. The health registry **subscribes to** `AccountUsageRegistry.streamChanges` rather than duplicating ingestion.

```ts
interface ExhaustionMark {
  accountKey: string;
  modelScope: string; // "*" or pi modelId
  until: string | null; // ISO resetsAt; null ⇒ unknown, use default TTL
  source: "telemetry" | "error" | "manual";
  displayName?: string; // for UI/reason strings
}

interface ProviderHealthRegistryShape {
  // routing queries (synchronous-shaped, Effect-wrapped)
  isExhausted(accountKey: string, modelId?: string, now?: number): Effect<boolean>;
  exhaustedUntil(accountKey: string, modelId?: string): Effect<string | null>;
  // writers
  markExhausted(mark: ExhaustionMark): Effect<void>; // from error classification
  // UI feed
  snapshot: Effect<ReadonlyArray<ExhaustionMark>>;
  streamChanges: Stream<ReadonlyArray<ExhaustionMark>>;
}
```

Ephemeral like the usage registry — it repopulates from the next poll (≤60s after restart), and error-sourced marks are re-derived the next time the error recurs. No persistence.

### 4.4 Mark sources and lifecycle

Marks are derived from three sources, strongest first:

1. **Explicit provider flags** — Codex `limit_reached: true` / `allowed: false` ⇒ account-wide mark with `until = reset_at` of the limiting window. Unambiguous.
2. **Telemetry threshold** — any window with `usedPercent ≥ 99` ⇒ mark (scoped if the window is scoped) with `until = resetsAt`. Proactive: routing avoids the account _before_ burning a failed call. Anthropic's `severity: "critical"` corroborates but the percent threshold is the rule (severity mapping is undocumented).
3. **Classified limit errors** (§5.3) — when a turn dies with a quota-shaped error, `markExhausted` with `until` = the account's known `resetsAt` if telemetry has one, else a **default TTL of 30 minutes** (bounded blast radius for misclassification; telemetry refresh will extend or clear it within 60s anyway).

**Clearing** is automatic and threefold:

- `until` passed ⇒ mark inert (checked at query time; no timers to leak).
- Fresh telemetry showing the same window `< 97%` ⇒ telemetry/error marks for that key are dropped (window reset early, or the percent was wrong).
- Server restart ⇒ clean slate, repopulated by the first poll.

**Manual override interplay:**

- `ProviderInstanceConfig.enabled` (existing switch on `ProviderInstanceCard`) stays the **hard** switch for whole T3 instances. It does not interact with the health registry.
- New: `ServerSettings.providerFailover.pausedAccounts: string[]` — account keys the user has **soft-paused**. The health registry treats a paused account as exhausted account-wide with `until = null` (indefinite). This is the control that lets a user say "stop routing pi turns to my Anthropic subscription", which the instance switch cannot express (disabling the `pi` instance would kill everything; disabling the `claudeAgent` instance only affects the direct driver). Pause/unpause is also the manual escape hatch for a wrong automatic mark (pause + unpause forces re-derivation from current telemetry).

No separate "soft-pause per model" in v1 — account-level pause plus automatic per-model marks cover the observed cases.

## 5. Failover chains

### 5.1 Two tiers, kept distinct

- **Tier 1 (existing, unchanged): transient retry.** Regex-matched capacity/plumbing errors → same-backend retry ladder → same-model other-backend allowance (`PI_BACKEND_PARTNERS`). Per-turn, non-sticky. This tier handles _overload_, not _exhaustion_.
- **Tier 2 (new): exhaustion failover.** Triggered by exhaustion state (proactively at dispatch, or reactively on a quota-classified failure). Cross-provider **and cross-family**. Effective while the exhaustion mark lasts, reverting automatically after reset (§5.4).

Classification order at the pi `agent_end` error handler (`PiDriver.ts:~1120`): quota classification runs **before** the transient regex (quota errors contain "limit"/"429"-adjacent phrasing and would otherwise burn the whole transient ladder against a dead account).

### 5.2 Chain configuration

New sparse settings block (contracts `settings.ts`, `withDecodingDefault` ⇒ no migration; patched whole-object like its siblings):

```ts
ProviderFailoverSettings = {
  enabled: boolean            // default true  — master switch for tier 2 rerouting
  resumeOnReset: boolean      // default true  — §6 sweep
  chains?: Record<string, ReadonlyArray<string>>   // optional overrides; keys are
                              // exact slugs ("anthropic/claude-fable-5") or
                              // namespace wildcards ("openai-codex/*");
                              // values are ordered target slugs
  pausedAccounts: string[]    // default []   — §4.4 soft-pause
}
```

**Built-in default chains** (server constants; `chains` overrides by key, exact-slug before wildcard). Per user decision D1/D3, the `chains` field is user-editable through the settings UI (§8.3) — the defaults below seed the editor; whatever the user configures is authoritative:

| Exhausted                                  | Default chain (in order)                                             | Rationale                                                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `openai-codex/*`                           | `anthropic/claude-opus-4-8` → `google-vertex-claude/claude-opus-4-8` | No other provider hosts GPT — cross-family is the only option. Subscription pool before API-billed pool.                 |
| `anthropic/<m>` (model-scoped, e.g. Fable) | `google-vertex-claude/<m>` → `anthropic/claude-opus-4-8`             | Same model on the API pool preserves capability; falling to Opus keeps the subscription. Order is a decision point (D2). |
| `anthropic/*` (account-wide)               | `google-vertex-claude/<m>`                                           | Same model, separate billing pool.                                                                                       |
| `google-vertex-claude/<m>`                 | `anthropic/<m>`                                                      | Mirror of today's partner map (rarely exhausted — API billed).                                                           |

**Chain resolution** (`resolveFailoverTarget(slug, healthRegistry, catalogue, settings)` — pure module, unit-testable): walk the chain; skip entries whose account/model is exhausted or paused, or whose slug is absent from pi's live catalogue; return the first healthy entry, else `undefined`. `<m>` substitution keeps the exhausted slug's modelId where the target is a namespace-only entry.

### 5.3 Quota-error classification

New `PI_QUOTA_ERROR_RE` alongside the transient regex — phrases observed in subscription-limit errors: `usage limit|weekly limit|quota|limit reached|out of.*(credits|quota)|resets? at|5.?hour limit` (exact list refined during implementation against real strings). Rule at the error handler:

> Classified **exhausted** iff the error matches `PI_QUOTA_ERROR_RE`, **or** it matches the transient regex **while** the health registry already marks the current slug's account exhausted (corroboration — a bare 429 during a known-exhausted window is exhaustion, a bare 429 otherwise is overload).

On exhaustion classification: `markExhausted` (source `"error"`), then reroute per §5.4 if a healthy target exists, else fail the turn with the new error class.

**New `RuntimeErrorClass` literal `"quota_exhausted"`** (`providerRuntime.ts:99`), and a new optional **`lastErrorClass`** on `ProviderSession` (`contracts/src/provider.ts:49`) and the `thread.session.set` command (`orchestration.ts:425` region), populated at the ingestion chokepoint (`ProviderRuntimeIngestion.ts:1941-1970`) from `event.payload.class`. This persisted class is what makes the resume sweep (§6) restart-safe without a new table.

### 5.4 Semantics: intent vs effective model (stickiness)

**The thread's stored `modelSelection` is never rewritten by failover.** It remains the user's/orchestrator's _intent_. The pi driver resolves an **effective** slug at every dispatch:

```
effective(slug) = slug                                   when healthy
                = resolveFailoverTarget(slug, …)          when exhausted (and failover enabled)
```

- Applied in `applyModelSelection` / `sendTurn` (the driver already re-issues `set_model` per turn) and in the reactive error path (`dispatchTurnRetry`-style immediate switch, short delay, re-prompt via the existing control-plane retry prompt).
- **Sticky for exactly as long as the mark lasts**: every turn while exhausted routes to the fallback; the first dispatch after `resetsAt` (or early clear) lands back on the intended model automatically. No return-to-original bookkeeping — the mark's lifecycle _is_ the stickiness. Mid-turn, the switch happens at the failure boundary only; a healthy-again original is picked up at the next turn, never mid-turn.
- Per-session `lastEffectiveModel` tracking dedupes events: **`model.rerouted` is emitted only when the effective slug changes** (both onto the fallback and back onto the original), with a reason naming the exhausted window and reset time, e.g. _“anthropic/claude-fable-5 weekly limit reached (Fable, resets 07 Jul 23:00) — running on google-vertex-claude/claude-fable-5 until then.”_ Ingestion already renders `model.rerouted` as an info row in the work log (`ProviderRuntimeIngestion.ts:394-409`); per user decision D1, the client additionally raises a **toast** when a `model.rerouted` event arrives for a visible/owned thread (both directions: onto fallback and back onto the intended model).
- `enabled: false` disables tier-2 rerouting entirely: exhausted turns fail with `quota_exhausted` and wait for reset (§6).

The existing tier-1 `settleRetry` restore logic is untouched — tier 2 needs no restore because it never mutates the stored selection.

## 6. Reset-aware resume of stalled threads

When no healthy fallback exists (all chain entries exhausted/paused, or failover disabled), the turn fails with `class: "quota_exhausted"` and the session persists `lastErrorClass`. A new **`ExhaustionResumeSweep`** layer (pattern: `SubscriptionUsagePoller` — 60s tick, or subscribed to `ProviderHealthRegistry.streamChanges`) then:

1. Scans the projection for threads with `session.status === "error" && session.lastErrorClass === "quota_exhausted"`.
2. For each, resolves the thread's intended selection → account/model; if now healthy (window reset, mark cleared, or a fallback target has become available with failover on), dispatches **`thread.turn.start`** with a control-plane resume prompt (same framing as `buildPiRetryPrompt`: "provider limit has reset; none of your previous response was delivered; continue from where you left off").
3. Guards: per-thread cooldown (no more than one resume attempt per 5 minutes) so a lying `resetsAt` cannot loop; a resume that fails exhausted again simply re-enters the pool with a fresh mark.

Restart-safe by construction: the trigger state is the persisted session projection, not in-memory timers.

**Workstream children vs standalone threads:** the sweep treats both identically — the stalled turn was legitimately requested and never delivered, so finishing it is the contract (`resumeOnReset: false` opts out globally). The existing `WorkstreamLivenessSweep` error wake still fires when a child stalls; its wake message is enriched (small change at `WorkstreamLivenessSweep.ts:386-394` message construction) for `quota_exhausted` errors: _"provider limit reached; automatic resume at ~15:40"_ — so the parent orchestrator can choose to wait rather than cancel/re-plan. Standalone threads simply resume; the work-log rows explain the gap.

## 7. Exhaustion-aware spawn defaults

Because effective routing (§5.4) is applied at every dispatch, a child spawned with an exhausted intent **already runs on the fallback from its kick-off turn and returns to the intended model after reset** — inheritance stays semantically clean (intent inherits; exhaustion is a transient overlay). Deliberately **no selection rewriting at spawn**: baking a temporary condition into durable thread config would strand children on fallback models after reset.

What the spawn path adds (in `WorkstreamSpawnHttp.ts` after resolution, `:542-566`):

- Consult the health registry for the resolved selection (all four precedence steps, explicit included). If exhausted and failover is enabled with a healthy target, append a **`warnings` entry** to the spawn response (the response already carries `warnings`): _"resolved model anthropic/claude-fable-5 is exhausted (resets 23:00); the child will run on google-vertex-claude/claude-fable-5 until then."_ The orchestrator sees it in the tool result; the kick-off turn's `model.rerouted` row records it on the child.
- If exhausted with **no** healthy target (or failover off), still spawn (the resume sweep will start it at reset) but warn explicitly that the child will not start until ~`resetsAt`.

Role presets need no special handling — they resolve to a selection before the check. (A future refinement — per-role chains, e.g. reviewers preferring a same-capability family — is noted in D3.)

## 8. UI and settings controls

All data reaches the client through existing streams; additions are additive/optional (mobile-safe).

1. **Usage pill / popover** (`SidebarAccountUsagePill.tsx`, `packages/client-runtime/src/accountUsage.ts`): render scoped windows as their own labelled bar + reset time (mirroring the provider's own panel: "Fable — 100% · resets Tue 23:00"), driven by the new `scope` field. Tone logic unchanged (destructive ≥100%). The derive logic in `client-runtime` is shared with mobile — one change serves both.
2. **Exhausted surfacing on provider cards**: the `providerStatuses` stream's builder consults the health registry; an account-wide mark on `claudeAgent`/`codex` sets `status: "warning"` + `message`/`unavailableReason`: _"Subscription limit reached — resets 15:40"_. Rides the existing `ServerProvider.availability` contract; no schema change.
3. **Settings → Failover section** (new card in provider settings): master toggle (`providerFailover.enabled`), resume-on-reset toggle, per-account **Pause** buttons (writes `pausedAccounts`) showing current health ("Codex — exhausted, resets 15:40 · [Pause]"), and — per user decision D1/D3 — a **fallback-chain editor**: for each source (provider namespace or specific model slug), an ordered list of target model slugs chosen from the live catalogue, seeded with the built-in defaults (§5.2), with add/remove/reorder and a "reset to default" affordance. Writes `providerFailover.chains`.
4. **Model picker badges** (nice-to-have, separate chunk): grey/badge pi model slugs whose account/model mark is active, via a small exhaustion summary added to the config WS stream. Deferred if contended.

## 9. Scope boundaries

- **pi driver first.** All tier-2 rerouting is pi-only (it owns `set_model`). Direct `codex`/`claudeAgent` driver threads get: error **classification** (`quota_exhausted` via the same regexes at their adapters' error paths — `CodexAdapter.ts:1276-1291`, `ClaudeAdapter.ts` `emitRuntimeError`), the **resume sweep** (driver-agnostic — `thread.turn.start` works for any driver), and the UI surfacing. They do **not** fail over cross-model in v1 (the harnesses can't retarget cross-family mid-session). Degraded-but-honest: they stall with a classified error and auto-resume at reset.
- **Contracts**: `AccountUsageWindow.scope` (optional), `RuntimeErrorClass += "quota_exhausted"`, `ProviderSession.lastErrorClass` (optional), `ProviderFailoverSettings` (defaulted). All additive; schema-only package stays runtime-free (mapping tables and chain resolution live in the server).
- **Settings migration**: none needed — sparse JSON with decoding defaults.
- **Mobile**: consumes `accountUsage` via `client-runtime`; the optional `scope` field decodes as absent on old clients. No breaking change.

## 10. Implementation plan

Reviewable chunks, each independently landable. Sizes are rough diff estimates.

**A. Telemetry fidelity + scoped windows** _(no behaviour change beyond richer data; ~350 LOC)_
`contracts/providerRuntime.ts` (window `scope`), `piQuotas.ts` (decode `limits[]`, Codex `allowed`/`limit_reached`), `ClaudeAdapter.ts:243-265` (scoped opus/sonnet windows), `AccountUsageRegistry.ts` (merge + sample keys by `(kind, scope)` — fixes the clobbering bug), display-name→slug mapping module. Depends: nothing.

**B. Health registry + error classification** _(~400 LOC)_
New `ProviderHealthRegistry` service + layer (marks, TTLs, pause integration); `RuntimeErrorClass` + `ProviderSession.lastErrorClass` + `thread.session.set` plumbing through `ProviderRuntimeIngestion.ts:1941-1970`; `PI_QUOTA_ERROR_RE` + classification in `PiDriver.failTurn` path and the codex/claude adapters; `ProviderFailoverSettings` in contracts + server settings service. Depends: A.

**C. Effective-model routing + tier-2 failover in PiDriver** _(~350 LOC; riskiest)_
Chain-resolution module (pure, unit-tested); dispatch-time effective resolution in `applyModelSelection`/`sendTurn`; reactive switch on quota-classified `agent_end` (before the transient ladder); `model.rerouted` dedupe/reason. Depends: B.

**D. `ExhaustionResumeSweep`** _(~200 LOC)_
New layer scanning error-stalled `quota_exhausted` sessions, dispatching resume `thread.turn.start`; cooldown guard; `WorkstreamLivenessSweep` wake-message enrichment. Depends: B (parallel with C).

**E. Spawn warnings** _(~80 LOC)_
Health check + `warnings` in `WorkstreamSpawnHttp.ts`. Depends: B (parallel with C/D).

**F. UI/settings** _(~550 LOC)_
Failover settings card incl. fallback-chain editor (per D1/D3), pause controls, reroute toasts on `model.rerouted`, scoped-window bars in pill/popover (`client-runtime` + web), provider-card exhausted state. Depends: A + B (parallel with C/D/E). Model-picker badges as an optional trailing sub-chunk.

**Riskiest parts:** (1) chunk C's interplay with the existing tier-1 retry state machine (`session.retry`, `settleRetry`) — mitigated by keeping tier 2 stateless in the driver (no ladder; a single switch decision per failure) and by the pure chain-resolution module carrying the logic; (2) misclassification marking a healthy account exhausted — mitigated by corroboration rules, the 30-minute error-mark TTL, 60s telemetry self-correction, and pause/unpause as a manual reset; (3) display-name→slug mapping fragility — mitigated by degrading unmapped scopes to display-only; (4) Codex `additional_rate_limits` shape unknown — Codex is account-wide-only in v1; revisit when a specimen payload exists.

## 11. Decisions — RESOLVED by the user (2026-07-06)

- **D1**: automatic switching, no "ask" mode. User controls fallback per provider via a settings-menu chain editor; notification via **toasts** (plus work-log rows).
- **D2**: same model on Vertex first.
- **D3**: cross-family fallback for reviewers acceptable; the user-configured chain is authoritative.
- **D4**: proactive marking from telemetry.
- **D5**: auto-resume both workstream children and standalone threads.
- **D6**: intent/effective split confirmed — stored selections are never rewritten.

Original decision framing preserved below for context.

**D1 — Mid-thread cross-family switch: silent, notify, or ask?**
A GPT-5.5 thread silently continuing on Claude changes behaviour users may notice. _Recommendation: automatic + notify_ — the `model.rerouted` work-log row (both directions) with window + reset time in the reason. An interactive "ask" mode needs a blocking approval surface that doesn't exist for headless workstream children; defer. Silent is rejected — invisible model swaps erode trust in results.

**D2 — Chain order for a model-scoped Anthropic exhaustion (Fable dead, Opus fine): same model on Vertex first, or same subscription (Opus) first?**
Same-model-on-Vertex preserves capability but spends API dollars; Opus-on-subscription is free but a different model. _Recommendation: Vertex-first (same model)_ — the default workstream model already runs on Vertex, so API spend is an accepted baseline here, and capability continuity matters more mid-task. Trivially flippable (one constant) if spend sensitivity wins.

**D3 — Is a GPT-5.5 reviewer falling back to Claude acceptable for review quality?**
Cross-family fallback changes the reviewing model's character mid-workstream. _Recommendation: accept for v1_ — a completed review on a different frontier model beats a stalled gate, and the reroute is recorded on the child. Per-role chains (e.g. pin reviewers to wait-for-reset instead) are a clean future extension of the `chains` keying; not v1.

**D4 — Exhaustion marking: proactive from telemetry (≥99% / explicit flags) or only on a failed call?**
Proactive avoids burning a failed turn against a dead account but trusts poller data (60s stale, percent rounding). _Recommendation: proactive_ — the Codex payload's explicit `limit_reached` boolean is authoritative, the ≥99% threshold is conservative, and the failure mode (rerouting one turn early) is benign compared with the alternative (a visible error on every window edge).

**D5 — Auto-resume standalone threads at reset, or only workstream children?**
A standalone thread resuming itself hours later may surprise a user mid-context. _Recommendation: resume both_ (global `resumeOnReset` toggle, default on) — the turn was explicitly requested and never delivered; completing it is the contract, and the work-log rows explain the gap. The toggle is the escape hatch.

**D6 — Never rewrite stored selections (intent vs effective), confirmed?**
The alternative — rewriting the thread's `modelSelection` onto the fallback — makes state simpler to inspect but strands threads/children on fallback models after reset and pollutes inheritance. _Recommendation: confirm intent/effective split_ (§5.4). This is the design's spine and interacts with D1's notification semantics.
