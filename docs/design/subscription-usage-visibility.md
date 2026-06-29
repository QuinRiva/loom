---
manager_sessions:
  - id: f1a139cd-fcc9-4323-9d04-74e780039641
    role: plan
    authored_at: 2026-06-29T12:00:14.815Z
---

# Subscription usage visibility

## Problem

When you drive Claude or Codex on a **subscription** (Claude Pro/Max, ChatGPT
Plus/Pro), the account is governed by rolling usage limits — typically a **5-hour
window** and a **weekly window**. Hitting one mid-task throttles the agent with
little warning. Today T3 Code surfaces **none** of this: there is no indication
of how much of either window you have consumed, nor when it resets.

The notable part is that the data already arrives at the server and is then
**dropped on the floor**:

- **Codex** emits `account/rateLimits/updated`. `CodexAdapter` re-emits it as the
  runtime event `account.rate-limits.updated`. The payload
  (`V2AccountRateLimitsUpdatedNotification`) carries a `primary` and `secondary`
  window, each `{ usedPercent, resetsAt (epoch seconds), windowDurationMins }`,
  plus a credits snapshot and `planType`. `primary` ≈ the 5h window, `secondary`
  ≈ the weekly window. Codex also exposes an `account/rateLimits/read` **request**
  RPC, so limits can be fetched on demand when idle — not only observed during a
  turn.
- **Claude** (`ClaudeAdapter`) maps the Agent SDK's `rate_limit_event` message to
  the same `account.rate-limits.updated` runtime event.
- The contract `ProviderRuntimeAccountRateLimitsUpdatedEvent` already exists in
  `packages/contracts/src/providerRuntime.ts`, but its payload is
  `rateLimits: Schema.Unknown` — an opaque passthrough.

The gap is purely **plumbing + UI**: `ProviderRuntimeIngestion` does not handle
`account.rate-limits.updated` (verified — no match), and nothing in `apps/web`,
`apps/mobile`, or `packages/client-runtime` references it. The event is emitted by
both adapters and never consumed.

A defining property: this data is **account-scoped**, not thread-scoped. It is
true for a logged-in provider account regardless of which thread or session you
are in. That scope drives every design decision below — it must **not** be
modelled like the per-thread context-window meter.

## Scope decision (where in the UI)

T3 Code has **no global top bar**. The only always-visible, cross-thread chrome
is the **left sidebar** (`AppSidebarLayout` → `Sidebar.tsx`). Its footer
(`SidebarChromeFooter`) already hosts exactly this class of widget — the
`SidebarProviderUpdatePill`, `SidebarUpdatePill`, and the Settings button: global,
always-visible, account/app-level status pills.

**Chosen home (Option A): a per-provider usage pill in `SidebarChromeFooter`**,
in the existing pill stack just above Settings. It is persistent regardless of
which thread/session is open (matching the account scope of the data) and reuses
an established footer-pill idiom rather than inventing new chrome. Hover/click →
popover with the 5h + weekly breakdown and reset countdowns, reusing the
`ContextWindowMeter` popover visual pattern.

**Threshold nudge (Option D)** layers on top: the pill's resting state is quiet,
but when a window crosses a high-usage threshold (~80%) or the provider reports
throttling, the pill switches to a warning/destructive tone. Loud only when it
matters.

Rejected alternatives:

- **Composer footer / `BranchToolbar`** (per-thread regions) — wrong scope;
  account-wide data would read as thread-scoped and be duplicated per thread.
- **Settings/provider-auth screen only** — semantically tidy but low visibility;
  you would only see usage when you went looking, which is the opposite of what a
  limit warning needs. It is fine as a _secondary mirror_ later, not the primary
  home.

## Architecture (how the data flows)

### 1. Type the payload in `contracts`

Replace the opaque `rateLimits: Schema.Unknown` with a normalised, provider-neutral
shape. Each adapter maps its provider-specific form into this common contract **at
the adapter boundary** (the established pattern — token-usage normalisation already
lives in the adapters):

```
AccountUsageWindow = {
  kind: "primary" | "secondary"   // primary ≈ 5h, secondary ≈ weekly
  usedPercent: number             // 0..100
  resetsAt: IsoDateTime | null    // when the window rolls over
  windowDurationMins: number | null
}

AccountUsageSnapshot = {
  providerName: string
  providerInstanceId: string | null   // the account/credential identity
  windows: ReadonlyArray<AccountUsageWindow>
  planType: string | null
  observedAt: IsoDateTime
}
```

- **Codex** maps `primary`/`secondary` directly; `resetsAt` epoch-seconds →
  `IsoDateTime`.
- **Claude** decodes `rate_limit_event` into the same windows (best-effort; unknown
  fields ignored). Whatever Claude cannot supply is left `null` rather than faked.

### 2. Ingest as an account-scoped projection slice (ephemeral)

`account.rate-limits.updated` arrives as a runtime event carrying a `threadId`.
`ProviderRuntimeIngestion` resolves that thread's session → `(providerName,
providerInstanceId)` and writes the snapshot into a **new top-level projection
field**, keyed by provider instance:

```
accountUsage: Record<providerInstanceId, AccountUsageSnapshot>
```

This is **ephemeral, in-memory, not persisted to the DB** — following the exact
precedent of `OrchestrationSession.queuedMessages` ("Ephemeral live queue …
DB-hydrated sessions never persist it"). On server restart it simply repopulates
on the next turn (or via the active fetch below). It rides the **existing
orchestration snapshot + delta transport** — no new WebSocket channel.

**Why the projection and not a config-style global push?** The data originates
from runtime events already flowing into `ProviderRuntimeIngestion`, and the
orchestration delta stream is the one transport that already carries
session-derived state to the client. Bridging runtime events into the
config/lifecycle channel (which is about provider _installation/update_ status,
not live usage) would be a second, parallel mechanism for no benefit. Keying by
`providerInstanceId` makes the slice naturally account-global; if the same
instance appears across multiple environment projections, the client selector
(below) dedupes by taking the latest `observedAt`.

### 3. Client store + global selector

Mirror `apps/web/src/lib/contextWindow.ts`: a small selector reads the projection's
`accountUsage` map across all environments, picks the latest snapshot per provider
instance, and derives per-window remaining % and a formatted reset countdown
("resets in 2h 14m"). Lives in `client-runtime` so web and mobile share it.

### 4. Active refresh (avoid staleness while idle)

Runtime events only fire during a turn, so a purely passive pill goes stale while
idle. For **Codex**, call `account/rateLimits/read` on session start / reconnect to
refresh without waiting for a turn. If the Claude SDK exposes no equivalent
on-demand read, the Claude pill shows "as of last turn" using `observedAt`. (The
active-fetch wiring can land as a fast-follow; the passive path is the MVP.)

### 5. Render — `SidebarAccountUsagePill`

A new component in `apps/web/src/components/sidebar/`, rendered in
`SidebarChromeFooter` alongside the existing pills. Reads the selector; renders one
compact pill per active provider account showing the **tighter** of the two windows
(e.g. "Claude 62%"). Hover/click opens a popover with both windows, their
percentages, and reset countdowns. Tone follows usage: quiet by default, warning
≥80%, destructive when throttled (Option D). Clicking can deep-link to
`/settings/providers`.

## Surface-area summary

| Layer                     | Change                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts`      | Replace `rateLimits: Unknown` with typed `AccountUsageSnapshot`; add `accountUsage` map to the projection snapshot + delta. |
| `apps/server` adapters    | Normalise Codex/Claude payloads into `AccountUsageSnapshot`.                                                                |
| `apps/server` ingestion   | Handle `account.rate-limits.updated`; resolve session → provider instance; update ephemeral `accountUsage` slice.           |
| `packages/client-runtime` | Selector: latest-per-instance + remaining % + reset countdown.                                                              |
| `apps/web`                | `SidebarAccountUsagePill` in `SidebarChromeFooter`; threshold tones.                                                        |
| (fast-follow)             | Codex `account/rateLimits/read` active refresh on connect.                                                                  |

The expensive part of features like this — _acquiring_ the data — is already done:
both providers emit it in-process and the contract event already exists. The real
work is typing the payload, one ephemeral projection slice, a selector, and a
footer pill.

## Implementation note (transport — as built)

The implementer was given the transport as an explicit judgement call (§2 proposed an
ephemeral orchestration-projection slice; the alternative was a global
config/lifecycle-style push). **As built, it chose the config/lifecycle push**, and
review confirmed it as the lighter, better-fitting option:

- Account usage is live, global, account-scoped, non-persisted server state — exactly
  the category the config stream (`subscribeServerConfig`) already serves (provider
  statuses, settings, keybindings). The projection is event-sourced, per-environment,
  sequence-numbered and replayed; bolting an ephemeral non-event-sourced map + synthetic
  delta onto it is a mismatch and touches far more load-bearing machinery.
- Server side is a small `AccountUsageRegistry` (Ref + PubSub, mirroring
  `ProviderRegistry.streamChanges`) merged into the existing config stream and emitting
  its current snapshot to each new subscriber (so reconnects don't wait for the next
  turn). Client side reuses `serverState.ts`'s atom + `applyServerConfigEvent` plumbing
  (one new atom + one case).

Everything else landed as specified: normalised `AccountUsageSnapshot`, account-scoped
keying by `providerInstanceId ?? providerName`, shared `client-runtime` selector, and the
sidebar-footer pill.

## Non-goals

- No new persisted history of usage over time (the slice is ephemeral).
- No mobile UI in the first cut (selector is shared; mobile surface is a
  fast-follow).
- No hard enforcement / blocking of turns near a limit — visibility only.
