import * as NodeOS from "node:os";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError } from "effect/http";

import {
  ProviderInstanceId,
  type ProviderUsageSource,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type ServerSettings,
} from "@t3tools/contracts";

import { usageSourceAccounts } from "@t3tools/shared/usageLimits"; // loom
import { encodeUsageWindowId, usageWindowAccountPrefix } from "@t3tools/shared/usageWindowId";

import { ServerSettingsService } from "../serverSettings.ts";
import { UsageLimitSources } from "../usage/UsageLimitSources.ts";
import type { AccountUsageWindow } from "./accountUsage.loom.ts";
import { scopedDisplayNameToModelId } from "./exhaustionMapping.ts";
import { ProviderHealthRegistry } from "./ProviderHealthRegistry.ts";
import { ProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import { type ProviderUsage, fetchAnthropicUsage, fetchCodexUsage } from "./quotas/piQuotas.ts";

export interface SubscriptionUsagePollerShape {
  /**
   * Start the background poller in the given scope: reads provider OAuth tokens and feeds
   * upstream's usage limits and Loom's exhaustion telemetry, driver-independent, so pi sessions
   * (which emit no per-turn rate-limit windows) still light the usage pill.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}

export class SubscriptionUsagePoller extends Context.Service<
  SubscriptionUsagePoller,
  SubscriptionUsagePollerShape
>()("t3/provider/SubscriptionUsagePoller") {}

/**
 * Driver-independent account-usage feeder: pi emits no rate-limit events, so this polls each
 * provider's usage endpoint for upstream's Limits page and Loom's failover telemetry. One fiber per
 * provider polls at start, then every `HEALTHY_INTERVAL`, backing off to `MAX_BACKOFF` (honouring
 * `retry-after`): the endpoint is rate-limited and shared with every pi process.
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
 * While any enabled `cliproxy` source is registered the hub is the authority on Claude quota and
 * every Anthropic arm here stands down: the `auth.json` token is likely the same subscription with
 * no email to match, so polling both draws duplicate Claude rows. Pooled sources use the hub's.
 */
export const hubReportsClaudeQuota = (
  settings: Pick<ServerSettings, "usageLimitSources">,
): boolean =>
  Object.values(settings.usageLimitSources).some(
    (source) => source.kind === "cliproxy" && source.enabled,
  );

/**
 * The published windows the Anthropic arms own, per instance, as account prefixes for
 * `retractUsageLimits`: `claudeAgent` on every pi instance, and each instance's own usage sources.
 * Codex is deliberately absent: standing down for the hub must not take its windows off the card.
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

/**
 * A hub account's published windows (`claudeUsageLimits` shape) in failover's
 * shape, as `fetchAnthropicUsage` would have read them: the model carve-out's
 * display name rides the `Weekly · <name>` label.
 */
const hubLimitsToWindows = (
  limits: ServerProviderUsageLimits,
  modelSlugs: ReadonlyArray<string>,
): ReadonlyArray<AccountUsageWindow> =>
  limits.windows.map((window) => {
    const displayName = window.label.split(" · ")[1];
    return {
      kind: window.kind === "session" ? "primary" : "secondary",
      usedPercent: window.usedPercent,
      resetsAt: window.resetsAt ?? null,
      windowDurationMins: window.windowDurationMins ?? null,
      ...(displayName
        ? {
            scope: {
              displayName,
              modelId: scopedDisplayNameToModelId({
                displayName,
                modelSlugs,
                accountKey: "claudeAgent",
              }),
            },
          }
        : {}),
    };
  });

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
  const usageLimitSources = yield* UsageLimitSources;
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

  // Instances that show this account on the Limits page: the instance itself when the account is
  // instance-scoped, else every pi instance, as pi routes to whichever subscription owns the model.
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
              const targets = yield* limitsTargets(attribution.providerInstanceId);
              for (const instanceId of targets) {
                const instance = yield* instanceRegistry.getInstance(instanceId);
                if (instance)
                  yield* instance.snapshot.applyUsageLimits({ ...limits, checkedAt: observedAt });
              }
              yield* Effect.logDebug(`subscription-usage poller: ${label} limits published`, {
                instances: targets,
                ids: limits.windows.map((w) => w.id),
              });
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

  // loom: the hub stand-down every Anthropic arm checks on its own cycle. Settings are re-read
  // each cycle so a hub change applies on the next poll; transitions log once; the arm seeing the
  // false->true edge first retracts every arm's Anthropic windows, as nothing else removes them.
  const hubOwnsClaudeQuota = yield* Ref.make(false);

  const retractAnthropicLimits = Effect.fn("SubscriptionUsagePoller.retractAnthropicLimits")(
    function* (settings: ServerSettings) {
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
    },
  );

  const standDownForHub = Effect.gen(function* () {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const standDown = settings !== null && hubReportsClaudeQuota(settings);
    if ((yield* Ref.getAndSet(hubOwnsClaudeQuota, standDown)) !== standDown) {
      yield* Effect.logInfo(
        standDown
          ? "subscription-usage poller: Anthropic arms suppressed: an enabled cliproxy usage-limit source is registered, so the hub reports Claude quota"
          : "subscription-usage poller: Anthropic arms resumed: no enabled cliproxy usage-limit source is registered",
      );
      if (standDown && settings !== null) yield* retractAnthropicLimits(settings);
    }
    return standDown;
  });

  const pollAnthropic = Effect.fn("SubscriptionUsagePoller.pollAnthropic")(function* (
    auth: typeof PiAuthSchema.Type,
  ) {
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

  // Instance-scoped usage sources: token files an instance's config declares (e.g. a router proxy
  // pooling subscriptions). Read fresh every cycle, never cached or refreshed (the proxy owns
  // refresh); a missing file fails the poll, which warns with backoff.
  const TokenFileSchema = Schema.Record(Schema.String, Schema.Unknown);
  const readJson = (file: string) =>
    fileSystem
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(TokenFileSchema))));
  // loom: cliproxy renames an auth file on re-login, so a configured file that
  // is gone resolves to the file beside it naming the same account by email.
  const resolveTokenFile = Effect.fn("SubscriptionUsagePoller.resolveTokenFile")(function* (
    tokenFile: string,
  ) {
    if (yield* fileSystem.exists(tokenFile)) return tokenFile;
    const dir = path.dirname(tokenFile);
    const files = yield* Effect.forEach(
      (yield* fileSystem.readDirectory(dir)).filter((name) => name.endsWith(".json")),
      (id) =>
        readJson(path.join(dir, id)).pipe(
          Effect.map((json) => ({
            id,
            email: typeof json.email === "string" ? json.email : undefined,
          })),
          Effect.orElseSucceed(() => ({ id, email: undefined })),
        ),
    );
    const match = usageSourceAccounts(tokenFile, files)[0];
    return match ? path.join(dir, match.id) : tokenFile;
  });
  const readSourceToken = (source: ProviderUsageSource) =>
    resolveTokenFile(expandHome(source.tokenFile)).pipe(
      Effect.flatMap(readJson),
      Effect.map((json) => {
        const value = json[source.tokenField ?? "access_token"];
        return typeof value === "string" && value.length > 0 ? value : null;
      }),
    );

  const pollUsageSource = Effect.fn("SubscriptionUsagePoller.pollUsageSource")(function* (
    instanceId: ProviderInstanceId,
    driver: string,
    source: ProviderUsageSource,
  ) {
    const label = sourceLabel(source);
    const attribution = {
      providerName: driver,
      providerInstanceId: instanceId,
      accountLabel: label,
    };
    // These pooled accounts are the hub's (linked by `usageSourceAccounts` across renames) and a
    // second read doubled load on a 429-ing endpoint, so failover takes the hub's reading stamped
    // with its time, and nothing is published (the hub draws the bar).
    if (yield* standDownForHub) {
      const accounts = usageSourceAccounts(
        source.tokenFile,
        (yield* usageLimitSources.current)
          .flatMap((hub) => hub.accounts)
          .filter((account) => account.driver === "claudeAgent"),
      ).toSorted((a, b) => b.usageLimits.checkedAt.localeCompare(a.usageLimits.checkedAt));
      // loom: a signed-out account is no headroom, however good its last reading.
      const dead = accounts[0];
      if (dead?.login?.status === "dead") {
        yield* health.applyUsage({
          ...attribution,
          windows: [],
          limitReached: true,
          signedOut: true,
          observedAt: dead.usageLimits.checkedAt,
        });
        return;
      }
      const reading = accounts.find((account) => !account.usageLimits.unavailable);
      if (!reading) {
        // loom: clients flag a source no hub account matches (`unlinkedUsageSources`).
        yield* Effect.logDebug(`subscription-usage poller: no hub reading for ${label} yet`, {
          tokenFile: source.tokenFile,
        });
        return;
      }
      yield* health.applyUsage({
        ...attribution,
        windows: hubLimitsToWindows(reading.usageLimits, yield* piModelSlugs),
        observedAt: reading.usageLimits.checkedAt,
      });
      return;
    }
    const token = yield* readSourceToken(source);
    if (!token) return;
    yield* feed(attribution, yield* fetchAnthropicUsage(httpClient, token, yield* piModelSlugs));
  });

  const pollCodex = Effect.fn("SubscriptionUsagePoller.pollCodex")(function* (
    auth: typeof PiAuthSchema.Type,
  ) {
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
  const runProvider = Effect.fn("SubscriptionUsagePoller.runProvider")(function* <E>(
    providerName: string,
    poll: Effect.Effect<void, E>,
  ) {
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

  const start: SubscriptionUsagePollerShape["start"] = Effect.fn("SubscriptionUsagePoller.start")(
    function* () {
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
    },
  );

  return { start } satisfies SubscriptionUsagePollerShape;
});

export const SubscriptionUsagePollerLive = Layer.effect(SubscriptionUsagePoller, make);
