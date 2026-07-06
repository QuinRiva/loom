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

import { AccountUsageRegistry } from "../Services/AccountUsageRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { type ProviderUsage, fetchAnthropicUsage, fetchCodexUsage } from "../quotas/piQuotas.ts";
import {
  SubscriptionUsagePoller,
  type SubscriptionUsagePollerShape,
} from "../Services/SubscriptionUsagePoller.ts";

/**
 * SubscriptionUsagePoller — driver-independent account-usage feeder.
 *
 * The shipped usage pill is fed by per-driver adapters that translate provider
 * rate-limit events into {@link AccountUsageSnapshot}s. pi-driven sessions (the
 * main path) never emit those events, so the registry stays empty and the pill
 * never appears. This poller closes that gap by going straight to each
 * provider's account-usage endpoint on a timer and feeding the same registry.
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
 * Key reconciliation: the registry/derive key is `providerInstanceId ?? providerName`.
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

const make = Effect.gen(function* () {
  const registry = yield* AccountUsageRegistry;
  const providerRegistry = yield* ProviderRegistry;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const piAuthPath = path.join(NodeOS.homedir(), ".pi", "agent", "auth.json");

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

  const feed = (providerName: string, usage: ProviderUsage) =>
    usage.windows.length === 0
      ? Effect.logDebug(`subscription-usage poller: ${providerName} returned no rolling windows`)
      : DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.flatMap((observedAt) =>
            registry.update({
              providerName,
              providerInstanceId: null,
              windows: usage.windows,
              planType: usage.planType,
              observedAt,
              // Explicit provider exhaustion flag (Codex `limit_reached`) so the
              // health registry can mark account-wide even if the window percent
              // undershoots the ≥99% threshold (§4.4 mark source 1).
              ...(usage.rateLimit?.limitReached === true ? { limitReached: true } : {}),
            }),
          ),
          Effect.andThen(
            Effect.logDebug(`subscription-usage poller: ${providerName} usage updated`, {
              windows: usage.windows.map((w) => `${w.kind}=${Math.round(w.usedPercent)}%`),
            }),
          ),
        );

  const pollAnthropic = (auth: typeof PiAuthSchema.Type) =>
    Effect.gen(function* () {
      const token = auth.anthropic?.access;
      if (!token) {
        yield* Effect.logDebug("subscription-usage poller: no Anthropic token on disk; skipping");
        return;
      }
      yield* feed(
        "claudeAgent",
        yield* fetchAnthropicUsage(httpClient, token, yield* piModelSlugs),
      );
    });

  const pollCodex = (auth: typeof PiAuthSchema.Type) =>
    Effect.gen(function* () {
      const codex = auth["openai-codex"];
      if (!codex?.access || !codex.accountId) {
        yield* Effect.logDebug("subscription-usage poller: no Codex token on disk; skipping");
        return;
      }
      yield* feed("codex", yield* fetchCodexUsage(httpClient, codex.access, codex.accountId));
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

  const start: SubscriptionUsagePollerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(runProvider("Anthropic", pollProvider(pollAnthropic)));
      yield* Effect.forkScoped(runProvider("Codex", pollProvider(pollCodex)));
      yield* Effect.logInfo("subscription-usage poller: started", {
        healthyIntervalMs: Duration.toMillis(HEALTHY_INTERVAL),
        maxBackoffMs: Duration.toMillis(MAX_BACKOFF),
      });
    });

  return { start } satisfies SubscriptionUsagePollerShape;
});

export const SubscriptionUsagePollerLive = Layer.effect(SubscriptionUsagePoller, make);
