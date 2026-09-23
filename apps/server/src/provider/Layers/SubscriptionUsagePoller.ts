import * as NodeOS from "node:os";

import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError } from "effect/unstable/http";

import {
  ProviderInstanceId,
  type ProviderUsageSource,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";

import { encodeUsageWindowId, usageWindowAccountPrefix } from "@t3tools/shared/usageWindowId";

import { ServerSettingsService } from "../../serverSettings.ts";
import type { AccountUsageWindow } from "../accountUsage.loom.ts";
import { ProviderHealthRegistry } from "../Services/ProviderHealthRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { type ProviderUsage, fetchAnthropicUsage, fetchCodexUsage } from "../quotas/piQuotas.ts";
import {
  SubscriptionUsagePoller,
  type SubscriptionUsagePollerShape,
} from "../Services/SubscriptionUsagePoller.ts";

/**
 * SubscriptionUsagePoller — driver-independent account-usage feeder.
 *
 * Upstream's Usage → Limits page is fed by per-driver adapters that translate
 * provider rate-limit events into `limits` updates on the provider instance.
 * pi-driven sessions (loom's only path) never emit those events, so without
 * this poller the page stays empty. It goes straight to each provider's
 * account-usage endpoint on a timer and feeds two consumers from one reading:
 *
 *   1. **upstream's Limits page** — the normalised `limits` windows, folded
 *      into the pi instance's published snapshot (`applyUsageLimits`), which is
 *      what `ProviderUsageLimitsIngestion` does for adapter-emitted events.
 *   2. **loom's failover** — the richer per-account telemetry
 *      ({@link AccountUsageSnapshot}: account keying, Codex `limitReached`,
 *      per-model carve-outs) that `ProviderHealthRegistry` derives exhaustion
 *      marks and spawn headroom from. Server-internal; never crosses the wire.
 *
 * Cadence: each provider runs its own self-scheduling fiber that polls
 * immediately at startup (so the pill lights as soon as the server is up) and
 * then every {@link HEALTHY_INTERVAL} while healthy. The account endpoints are
 * single cheap GETs and the 5h/weekly windows only move in whole-percent steps
 * over many minutes, so a multi-minute base interval keeps the pill effectively
 * live at negligible load. Crucially, `/api/oauth/usage` is aggressively rate-
 * limited and shared across every co-running pi process plus the server, so a
 * tight fire-and-warn loop just hammers a 429-ing endpoint and spams the log.
 *
 * Failure handling per provider: on any failure the fiber backs off
 * exponentially from {@link HEALTHY_INTERVAL} up to {@link MAX_BACKOFF} (reset on
 * the next success), respecting a `retry-after` header when the server sends a
 * positive one. Rate-limit (429) and auth-shaped (401/403 — token expired/absent
 * until pi refreshes `auth.json`) failures are *expected* and logged at debug;
 * only unexpected shapes (5xx, transport, parse) warn — and even those are
 * de-noised by the same backoff rather than a per-cycle drumbeat. The two
 * providers are fully isolated: independent fibers, backoff, and schedules.
 *
 * Key reconciliation: the health-registry key is `providerInstanceId ?? providerName`.
 * Adapter-emitted `account.rate-limits.updated` events ARE stamped with the bound
 * instance id by `ProviderService` (`correlateRuntimeEventWithInstance`), but for a
 * built-in driver the *default* instance id IS the driver kind
 * (`defaultInstanceIdForDriver(kind) === kind`) — i.e. "claudeAgent"/"codex", the
 * same string as `providerName`. This poller emits `providerInstanceId: null`, which
 * also keys by `providerName`. So for the default instance an adapter update and a
 * poller update collapse into one registry entry, and `deriveAccountUsageViews`
 * renders exactly one pill. (A user-configured NON-default named instance keys by its
 * own id and would render its own pill — see the single-default-account caveat.)
 */

/**
 * Base cadence while a provider is healthy, and the exponential-backoff floor on
 * failure. A usage pill does not need minute-level freshness (the underlying 5h/
 * weekly windows crawl in whole-percent steps), so a multi-minute interval keeps
 * pressure off the shared, rate-limited usage endpoints.
 */
const HEALTHY_INTERVAL = Duration.minutes(5);
/** Cap on the exponential backoff applied after consecutive failures. */
const MAX_BACKOFF = Duration.minutes(30);

const PiAuthSchema = Schema.Struct({
  anthropic: Schema.optional(
    Schema.NullOr(Schema.Struct({ access: Schema.optional(Schema.String) })),
  ),
  "openai-codex": Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        access: Schema.optional(Schema.String),
        accountId: Schema.optional(Schema.String),
      }),
    ),
  ),
});

/**
 * One account's windows in upstream's shape. Upstream merges an instance's
 * windows by id and several accounts (global + pooled) feed one pi instance,
 * so the id carries the account — see `@t3tools/shared/usageWindowId`.
 */
export const toLimitsWindows = (
  account: { readonly accountKey: string; readonly accountLabel?: string },
  accountName: string,
  windows: ReadonlyArray<AccountUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> =>
  windows.map((window) => ({
    id: encodeUsageWindowId({
      ...account,
      kind: window.kind,
      ...(window.scope ? { scope: window.scope.displayName } : {}),
    }),
    kind: window.kind === "primary" ? ("session" as const) : ("weekly" as const),
    label: `${accountName}${window.scope ? ` ${window.scope.displayName}` : ""} ${
      window.kind === "primary" ? "5-hour" : "weekly"
    }`,
    usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
    ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    ...(window.windowDurationMins !== null
      ? { windowDurationMins: Math.max(0, Math.round(window.windowDurationMins)) }
      : {}),
  }));

/**
 * Is a CLIProxyAPI hub registered as a usage-limit source?
 *
 * Every Claude turn loom runs is routed through the hub, and `UsageLimitSources`
 * reports each pooled account there with its email, plan and reset credits. The
 * `anthropic` token in `~/.pi/agent/auth.json` is a second path to the same
 * vendor — very likely the same subscription — and the poller knows no email for
 * it (the OAuth usage endpoint returns none), so there is no way to match the two
 * readings up. Polling both would therefore draw a duplicate Claude row on the
 * Limits page and a duplicate session bar in the subscription meter.
 *
 * Configuration is the rule: while any enabled `cliproxy` source is registered,
 * the hub is the authority on Claude quota and *every* Anthropic arm of this
 * poller stands down — the `auth.json` one above and the instance-scoped
 * `usageSources`, which read the same pooled accounts the hub pools. Removing or
 * disabling the entry brings them back on the next poll.
 */
export const hubReportsClaudeQuota = (
  settings: Pick<ServerSettings, "usageLimitSources">,
): boolean =>
  Object.values(settings.usageLimitSources).some(
    (source) => source.kind === "cliproxy" && source.enabled,
  );

/**
 * Which published windows the Anthropic arms own, per instance, as account
 * prefixes for `retractUsageLimits`. The direct-auth arm feeds every pi
 * instance under the `claudeAgent` account key (`limitsTargets(null)`); an
 * instance's own usage sources feed that instance keyed by its id and the
 * source's label. Codex — the `codex` account key, and any instance usage
 * source of a future non-Anthropic kind — is deliberately absent: standing down
 * for the hub must not take Codex's windows off the card.
 */
export const anthropicAccountPrefixes = (
  settings: Pick<ServerSettings, "providerInstances">,
  piInstanceIds: ReadonlyArray<ProviderInstanceId>,
  sourceLabelOf: (source: ProviderUsageSource) => string,
): ReadonlyMap<ProviderInstanceId, ReadonlyArray<string>> => {
  const byInstance = new Map<ProviderInstanceId, Array<string>>(
    piInstanceIds.map((instanceId) => [
      instanceId,
      [usageWindowAccountPrefix({ accountKey: "claudeAgent" })],
    ]),
  );
  for (const [id, instance] of Object.entries(settings.providerInstances)) {
    const instanceId = ProviderInstanceId.make(id);
    const prefixes = (instance.usageSources ?? [])
      .filter((source) => source.kind === "anthropic-oauth")
      .map((source) =>
        usageWindowAccountPrefix({ accountKey: instanceId, accountLabel: sourceLabelOf(source) }),
      );
    if (prefixes.length > 0)
      byInstance.set(instanceId, [...(byInstance.get(instanceId) ?? []), ...prefixes]);
  }
  return byInstance;
};

/** Account display names for the Limits page's window labels. */
const ACCOUNT_DISPLAY_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

const make = Effect.gen(function* () {
  const health = yield* ProviderHealthRegistry;
  const instanceRegistry = yield* ProviderInstanceRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const homeDir = NodeOS.homedir();
  const piAuthPath = path.join(homeDir, ".pi", "agent", "auth.json");
  const expandHome = (p: string): string =>
    p === "~" ? homeDir : p.startsWith("~/") ? path.join(homeDir, p.slice(2)) : p;

  const readPiAuth = fileSystem
    .readFileString(piAuthPath)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PiAuthSchema))));

  const piModelSlugs = providerRegistry.getProviders.pipe(
    Effect.map((providers) =>
      providers.flatMap((provider) =>
        provider.driver === "pi" ? provider.models.map((model) => model.slug) : [],
      ),
    ),
  );

  // Which instances show this account's windows on upstream's Limits page: the
  // instance itself when the account is instance-scoped (a pooled router's
  // usage source), otherwise every pi instance — pi routes turns to whichever
  // subscription the chosen model belongs to, so both accounts' windows belong
  // on its card, labelled by account.
  const limitsTargets = (providerInstanceId: ProviderInstanceId | null) =>
    providerInstanceId !== null
      ? Effect.succeed([providerInstanceId])
      : providerRegistry.getProviders.pipe(
          Effect.map((providers) =>
            providers.flatMap((provider) =>
              provider.driver === "pi" ? [provider.instanceId] : [],
            ),
          ),
        );

  const feed = (
    attribution: {
      readonly providerName: string;
      readonly providerInstanceId: ProviderInstanceId | null;
      readonly accountLabel?: string;
    },
    usage: ProviderUsage,
    // loom: false while the hub owns this account's quota — the reading still
    // feeds the health registry (failover reads exhaustion and headroom off
    // it) but never reaches the instance's published limits, where it would
    // draw a second bar beside the hub's.
    publishLimits = true,
  ) => {
    const label = attribution.accountLabel ?? attribution.providerName;
    const accountKey = attribution.providerInstanceId ?? attribution.providerName;
    return usage.windows.length === 0
      ? Effect.logDebug(`subscription-usage poller: ${label} returned no rolling windows`)
      : DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.flatMap((observedAt) =>
            Effect.gen(function* () {
              yield* health.applyUsage({
                ...attribution,
                windows: usage.windows,
                observedAt,
                // Explicit provider exhaustion flag (Codex `limit_reached`) so the
                // health registry can mark account-wide even if the window percent
                // undershoots the ≥99% threshold (§4.4 mark source 1).
                ...(usage.limitReached === true ? { limitReached: true } : {}),
              });
              // Same reading in upstream's shape, folded into the instance
              // snapshot exactly as ProviderUsageLimitsIngestion folds an
              // adapter's event — the poller is pi's feeder for the Limits page.
              const limits = {
                windows: toLimitsWindows(
                  {
                    accountKey,
                    ...(attribution.accountLabel ? { accountLabel: attribution.accountLabel } : {}),
                  },
                  attribution.accountLabel ??
                    ACCOUNT_DISPLAY_NAMES[attribution.providerName] ??
                    attribution.providerName,
                  usage.windows,
                ),
              };
              const targets = publishLimits
                ? yield* limitsTargets(attribution.providerInstanceId)
                : [];
              for (const instanceId of targets) {
                const instance = yield* instanceRegistry.getInstance(instanceId);
                if (instance)
                  yield* instance.snapshot.applyUsageLimits({ ...limits, checkedAt: observedAt });
              }
              yield* Effect.logDebug(
                `subscription-usage poller: ${label} ${publishLimits ? "limits published" : "health-only (hub owns Claude quota)"}`,
                { instances: targets, ids: limits.windows.map((w) => w.id) },
              );
            }),
          ),
          Effect.andThen(
            Effect.logDebug(`subscription-usage poller: ${label} usage updated`, {
              windows: usage.windows.map((w) => `${w.kind}=${Math.round(w.usedPercent)}%`),
            }),
          ),
        );
  };

  const sourceLabel = (source: ProviderUsageSource): string =>
    source.label ?? path.basename(source.tokenFile);

  // loom: the hub stand-down, shared by every Anthropic arm (the direct-auth
  // one and each instance usage source), each of which asks on its own cycle.
  // Settings are re-read per cycle rather than at startup, so registering or
  // removing a hub takes effect on the next poll without a restart. The state
  // is logged once per transition — the cycle repeats every HEALTHY_INTERVAL
  // and a per-cycle line would just be a drumbeat — and whichever arm sees the
  // false→true edge first retracts the Anthropic windows every arm published,
  // because nothing else ever removes a window from an instance's limits.
  const hubOwnsClaudeQuota = yield* Ref.make(false);

  const retractAnthropicLimits = (settings: ServerSettings) =>
    Effect.gen(function* () {
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const byInstance = anthropicAccountPrefixes(
        settings,
        yield* limitsTargets(null),
        sourceLabel,
      );
      for (const [instanceId, accountPrefixes] of byInstance) {
        const instance = yield* instanceRegistry.getInstance(instanceId);
        if (instance) yield* instance.snapshot.retractUsageLimits({ accountPrefixes, checkedAt });
      }
      yield* Effect.logInfo(
        "subscription-usage poller: retracted the Anthropic windows the hub now reports",
        { instances: [...byInstance.keys()] },
      );
    });

  const standDownForHub = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const standDown = settings !== null && hubReportsClaudeQuota(settings);
    if ((yield* Ref.getAndSet(hubOwnsClaudeQuota, standDown)) !== standDown) {
      yield* Effect.logInfo(
        standDown
          ? "subscription-usage poller: Anthropic arms suppressed — an enabled cliproxy usage-limit source is registered, so the hub reports Claude quota"
          : "subscription-usage poller: Anthropic arms resumed — no enabled cliproxy usage-limit source is registered",
      );
      if (standDown && settings !== null) yield* retractAnthropicLimits(settings);
    }
    return standDown;
  });

  const pollAnthropic = (auth: typeof PiAuthSchema.Type) =>
    Effect.gen(function* () {
      // The hub reports this subscription too, and with no email on the OAuth
      // usage endpoint there is no way to match the two readings up — so the
      // whole arm, health telemetry included, defers to the hub.
      if (yield* standDownForHub) return;
      const token = auth.anthropic?.access;
      if (!token) {
        yield* Effect.logDebug("subscription-usage poller: no Anthropic token on disk; skipping");
        return;
      }
      yield* feed(
        { providerName: "claudeAgent", providerInstanceId: null },
        yield* fetchAnthropicUsage(httpClient, token, yield* piModelSlugs),
      );
    });

  // Instance-scoped usage sources (§Option B): an instance's config can declare
  // its own token files (e.g. a router proxy pooling several subscriptions, each
  // kept fresh on disk). We read the token FRESH every cycle — never cache it,
  // never attempt OAuth refresh; the external proxy owns refresh. A missing or
  // unreadable token file is a quiet debug-level skip.
  const TokenFileSchema = Schema.Record(Schema.String, Schema.Unknown);
  const readSourceToken = (source: ProviderUsageSource) =>
    fileSystem.readFileString(expandHome(source.tokenFile)).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TokenFileSchema))),
      Effect.map((json) => {
        const value = json[source.tokenField ?? "access_token"];
        return typeof value === "string" && value.length > 0 ? value : null;
      }),
    );

  const pollUsageSource = (
    instanceId: ProviderInstanceId,
    driver: string,
    source: ProviderUsageSource,
  ) =>
    Effect.gen(function* () {
      const label = sourceLabel(source);
      const token = yield* readSourceToken(source).pipe(
        Effect.catch(() =>
          Effect.logDebug(
            `subscription-usage poller: ${label} token file missing/unreadable; skipping`,
            { tokenFile: source.tokenFile },
          ).pipe(Effect.as(null)),
        ),
      );
      if (!token) return;
      // loom: these pooled accounts ARE the hub's accounts, so while it is
      // registered they keep polling for failover telemetry (this is loom's
      // only per-account exhaustion signal) but stop publishing limits.
      yield* feed(
        {
          providerName: driver,
          providerInstanceId: instanceId,
          accountLabel: label,
        },
        yield* fetchAnthropicUsage(httpClient, token, yield* piModelSlugs),
        !(yield* standDownForHub),
      );
    });

  const pollCodex = (auth: typeof PiAuthSchema.Type) =>
    Effect.gen(function* () {
      const codex = auth["openai-codex"];
      if (!codex?.access || !codex.accountId) {
        yield* Effect.logDebug("subscription-usage poller: no Codex token on disk; skipping");
        return;
      }
      yield* feed(
        { providerName: "codex", providerInstanceId: null },
        yield* fetchCodexUsage(httpClient, codex.access, codex.accountId),
      );
    });

  // Pull the first HttpClientError out of a failure cause, so we can read its
  // HTTP status and headers for rate-limit/auth classification.
  const httpErrorOf = (
    cause: Cause.Cause<unknown>,
  ): HttpClientError.HttpClientError | undefined => {
    for (const reason of cause.reasons) {
      if (Cause.isFailReason(reason) && HttpClientError.isHttpClientError(reason.error)) {
        return reason.error;
      }
    }
    return undefined;
  };

  // A positive `retry-after` (seconds) is respected as a wait floor; the observed
  // 429s send `retry-after: 0`, which we ignore in favour of our own backoff.
  const retryAfterOf = (
    error: HttpClientError.HttpClientError | undefined,
  ): Duration.Duration | null => {
    const raw = error?.response?.headers["retry-after"];
    const seconds = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(seconds) && seconds > 0 ? Duration.seconds(seconds) : null;
  };

  // One self-scheduling fiber per provider: poll, then sleep for a delay derived
  // from the outcome (healthy cadence on success, exponential backoff on
  // failure). Isolated per provider so one endpoint's rate limiting never
  // touches the other's cadence.
  const runProvider = <E>(providerName: string, poll: Effect.Effect<void, E>) =>
    Effect.gen(function* () {
      const failures = yield* Ref.make(0);
      const step = poll.pipe(
        Effect.matchCauseEffect({
          onSuccess: () => Ref.set(failures, 0).pipe(Effect.as(HEALTHY_INTERVAL)),
          onFailure: (cause) => {
            // Let scope teardown interrupt the fiber instead of "handling" it.
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            return Effect.gen(function* () {
              const attempt = yield* Ref.updateAndGet(failures, (n) => n + 1);
              const error = httpErrorOf(cause);
              const status = error?.response?.status;
              const expected = status === 429 || status === 401 || status === 403;
              const retryAfter = status === 429 ? retryAfterOf(error) : null;
              const backoff = Duration.min(
                Duration.times(HEALTHY_INTERVAL, 2 ** (attempt - 1)),
                MAX_BACKOFF,
              );
              const delay = retryAfter ? Duration.max(retryAfter, backoff) : backoff;
              const detail = {
                attempt,
                status: status ?? null,
                retryAfterMs: retryAfter ? Duration.toMillis(retryAfter) : null,
                nextPollMs: Duration.toMillis(delay),
              };
              yield* expected
                ? Effect.logDebug(
                    `subscription-usage poller: ${providerName} expected failure (rate-limit/auth); backing off`,
                    detail,
                  )
                : Effect.logWarning(`subscription-usage poller: ${providerName} poll failed`, {
                    ...detail,
                    cause: Cause.pretty(cause),
                  });
              return delay;
            });
          },
        }),
        Effect.flatMap(Effect.sleep),
      );
      return yield* Effect.forever(step);
    });

  // Each provider reads pi's auth for itself so the two fibers stay independent.
  const pollProvider = <E>(select: (auth: typeof PiAuthSchema.Type) => Effect.Effect<void, E>) =>
    readPiAuth.pipe(Effect.flatMap(select));

  // Enumerate configured instance usage sources once at startup. Adding/removing
  // sources takes effect on next server start (no hot-reload), matching the
  // poller's fork-once-per-provider model.
  const configuredSources = serverSettings.getSettings.pipe(
    Effect.map((settings) =>
      Object.entries(settings.providerInstances).flatMap(([instanceId, instance]) =>
        (instance.usageSources ?? []).map((source) => ({
          instanceId: ProviderInstanceId.make(instanceId),
          driver: instance.driver as string,
          source,
        })),
      ),
    ),
    Effect.catch(() =>
      Effect.logWarning(
        "subscription-usage poller: could not read settings; usage sources off",
      ).pipe(
        Effect.as(
          [] as ReadonlyArray<{
            instanceId: ProviderInstanceId;
            driver: string;
            source: ProviderUsageSource;
          }>,
        ),
      ),
    ),
  );

  const start: SubscriptionUsagePollerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(runProvider("Anthropic", pollProvider(pollAnthropic)));
      yield* Effect.forkScoped(runProvider("Codex", pollProvider(pollCodex)));
      const sources = yield* configuredSources;
      for (const { instanceId, driver, source } of sources) {
        yield* Effect.forkScoped(
          runProvider(
            `${instanceId}/${sourceLabel(source)}`,
            pollUsageSource(instanceId, driver, source),
          ),
        );
      }
      yield* Effect.logInfo("subscription-usage poller: started", {
        healthyIntervalMs: Duration.toMillis(HEALTHY_INTERVAL),
        maxBackoffMs: Duration.toMillis(MAX_BACKOFF),
        usageSources: sources.length,
      });
    });

  return { start } satisfies SubscriptionUsagePollerShape;
});

export const SubscriptionUsagePollerLive = Layer.effect(SubscriptionUsagePoller, make);
