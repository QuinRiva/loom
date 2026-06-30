import * as NodeOS from "node:os";

import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { AccountUsageRegistry } from "../Services/AccountUsageRegistry.ts";
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
 * Cadence: 60s, with an immediate poll at startup (`repeat` runs the effect
 * before its first delay) so the pill lights as soon as the server is up. The
 * account endpoints are single cheap GETs and the 5h/weekly windows only move in
 * whole-percent steps over many minutes, so 60s gives a near-live pill with
 * negligible load. Each provider poll is isolated: a missing/expired token or a
 * failing fetch logs and leaves that pill quiet without killing the other
 * provider or the schedule.
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

const POLL_INTERVAL = Duration.seconds(60);

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
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const piAuthPath = path.join(NodeOS.homedir(), ".pi", "agent", "auth.json");

  const readPiAuth = fileSystem
    .readFileString(piAuthPath)
    .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(PiAuthSchema))));

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
      yield* feed("claudeAgent", yield* fetchAnthropicUsage(httpClient, token));
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

  // Isolate each provider so one failing fetch/credential read neither aborts
  // the other provider nor breaks the repeat schedule.
  const isolate = <E>(providerName: string, poll: Effect.Effect<void, E>) =>
    poll.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(`subscription-usage poller: ${providerName} poll failed`, { cause }),
      ),
    );

  // Read pi's auth once per cycle and feed both provider polls.
  const pollOnce = readPiAuth.pipe(
    Effect.flatMap((auth) =>
      Effect.andThen(isolate("Anthropic", pollAnthropic(auth)), isolate("Codex", pollCodex(auth))),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("subscription-usage poller: failed to read pi auth", { cause }),
    ),
  );

  const start: SubscriptionUsagePollerShape["start"] = () =>
    Effect.gen(function* () {
      yield* Effect.forkScoped(pollOnce.pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));
      yield* Effect.logInfo("subscription-usage poller: started", {
        intervalMs: Duration.toMillis(POLL_INTERVAL),
      });
    });

  return { start } satisfies SubscriptionUsagePollerShape;
});

export const SubscriptionUsagePollerLive = Layer.effect(SubscriptionUsagePoller, make);
