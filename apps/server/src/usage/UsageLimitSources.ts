/**
 * UsageLimitSources — quota from places this environment cannot run turns
 * on, today a CLIProxyAPI hub pooling several subscription accounts.
 *
 * Each configured `settings.usageLimitSources` entry is polled on the
 * provider health-check interval and on every settings change, then
 * published as one snapshot per source over `subscribeServerConfig`. A source
 * that fails keeps its row with `error` set so the user can see it is
 * configured but unreachable. Like provider status, the readings are live
 * state that re-derives on boot.
 *
 * loom: the one exception is when each Claude account last logged in, which
 * the hub does not keep: `hubLogins.loom.ts` detects logins on every read,
 * persists them in `<stateDir>/hub-logins.json` and stamps each account's
 * re-login schedule on `login.relogin`. The in-app login (`loginStart` /
 * `loginFinish`) drives the hub's own OAuth flow.
 *
 * @module usage/UsageLimitSources
 */
import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  UsageLimitSourceError,
  type UsageLimitSourceConsumeResetCreditInput,
  type ProviderConsumeResetCreditResult,
  type ServerSettings,
  type UsageLimitSourceConfig,
  type UsageLimitSourceId,
  type UsageLimitSourceLoginFinishInput, // loom
  type UsageLimitSourceLoginFinishResult, // loom
  type UsageLimitSourceLoginStartInput, // loom
  type UsageLimitSourceLoginStartResult, // loom
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Path from "effect/Path"; // loom
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as FileSystem from "effect/FileSystem"; // loom
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule"; // loom
import * as Schema from "effect/Schema"; // loom
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerConfig } from "../config.ts"; // loom
import * as Settings from "../serverSettings.ts";
import {
  carriedAccounts, // loom
  type CliproxyAuthFile, // loom
  makeCliproxyApi,
} from "./cliproxyApi.ts";
import {
  detectLogin,
  type HubLoginRecords,
  loadHubLogins,
  reloginSchedule,
  saveHubLogins,
} from "./hubLogins.loom.ts"; // loom

export class UsageLimitSources extends Context.Service<
  UsageLimitSources,
  {
    readonly current: Effect.Effect<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** The current set followed by every change, with repeats dropped. */
    readonly streamChanges: Stream.Stream<ReadonlyArray<UsageLimitSourceSnapshot>>;
    /** Re-read every source now. Never fails; failures land on the snapshot. */
    readonly refresh: Effect.Effect<void>;
    readonly consumeResetCredit: (
      input: UsageLimitSourceConsumeResetCreditInput,
    ) => Effect.Effect<ProviderConsumeResetCreditResult, UsageLimitSourceError>;
    // loom: the hub login dialog.
    readonly loginStart: (
      input: UsageLimitSourceLoginStartInput,
    ) => Effect.Effect<UsageLimitSourceLoginStartResult, UsageLimitSourceError>;
    readonly loginFinish: (
      input: UsageLimitSourceLoginFinishInput,
    ) => Effect.Effect<UsageLimitSourceLoginFinishResult, UsageLimitSourceError>;
  }
>()("t3/usage/UsageLimitSources") {}

const isUsageLimitSourceError = Schema.is(UsageLimitSourceError); // loom

// loom: the hub's OAuth flow waits 5 minutes for the callback after minting the URL.
const LOGIN_CALLBACK_WINDOW_MINUTES = 5;

/**
 * loom: what claude.ai showed after sign-in, as the hub's `oauth-callback`
 * body (the same shapes `cli-proxy/account finish` accepts): the address-bar
 * URL; `code#state`, which claude.ai displays; or a `code&state=…` snip of the
 * URL. A bare code takes the state the dialog started with.
 */
export function oauthCallbackBody(pasted: string, state: string): Record<string, string> {
  const text = pasted.trim().replace(/^['"]|['"]$/g, "");
  if (/^https?:\/\//i.test(text)) return { redirect_url: text };
  const query = text.replace("#", "&state=");
  const params = new URLSearchParams(query.split("&")[0]!.includes("=") ? query : `code=${query}`);
  return { code: params.get("code") ?? "", state: params.get("state") || state };
}

/** loom: the enabled Claude auth files that name an account, one per email (the latest written). */
const claudeFiles = (files: ReadonlyArray<CliproxyAuthFile>) => [
  ...new Map(
    files
      .filter((file) => file.provider === "claude" && !file.disabled && file.email)
      .toSorted((a, b) => Date.parse(a.modtime ?? "") - Date.parse(b.modtime ?? ""))
      .map((file) => [file.email!, file]),
  ).values(),
];

function sourceLabel(id: string, config: UsageLimitSourceConfig): string {
  if (config.label) return config.label;
  const fallback = id.trim() || "Usage limit source";
  try {
    return new URL(config.url).host || fallback;
  } catch {
    return fallback;
  }
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  // loom: the login record, loaded once and written back on every change.
  const path = yield* Path.Path;
  const recordsPath = path.join((yield* ServerConfig).stateDir, "hub-logins.json");
  const fileSystem = yield* FileSystem.FileSystem;
  const records = yield* Ref.make<HubLoginRecords>(
    yield* loadHubLogins(recordsPath).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    ),
  );
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  /**
   * loom: re-read every Claude auth file whose `modtime` moved, record what
   * changed, and persist. A failed download keeps the account's last record.
   */
  const detectLogins = Effect.fn("UsageLimitSources.detectLogins")(function* (
    config: UsageLimitSourceConfig,
    files: ReadonlyArray<CliproxyAuthFile>,
  ) {
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const known = yield* Ref.get(records);
    const updates = yield* Effect.forEach(
      claudeFiles(files),
      (file) => {
        const email = file.email!;
        const previous = known[email];
        if (previous && file.modtime !== undefined && previous.modtime === file.modtime)
          return Effect.succeed([] as const);
        return api.downloadAuthFile(config, file.id).pipe(
          Effect.map((facts) => {
            const next = detectLogin(previous, file, facts, now);
            return next ? ([[email, next]] as const) : ([] as const);
          }),
          Effect.tapError((cause) =>
            Effect.logDebug("hub auth file download failed", { id: file.id, cause }),
          ),
          Effect.orElseSucceed(() => [] as const),
        );
      },
      { concurrency: 4 },
    );
    const changed = updates.flat().filter(([email, next]) => !Equal.equals(known[email], next));
    if (changed.length === 0) return known;
    const next = yield* Ref.updateAndGet(records, (current) => ({
      ...current,
      ...Object.fromEntries(changed),
    }));
    yield* saveHubLogins(recordsPath, next).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.tapError((cause) =>
        Effect.logWarning("hub login record not saved", { path: recordsPath, cause }),
      ),
      Effect.ignore,
    );
    return next;
  });
  const settingsService = yield* Settings.ServerSettingsService;
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const stateRef = yield* Ref.make<ReadonlyArray<UsageLimitSourceSnapshot>>([]);
  const changes = yield* Effect.acquireRelease(
    PubSub.unbounded<ReadonlyArray<UsageLimitSourceSnapshot>>(),
    PubSub.shutdown,
  );

  const readSource = Effect.fn("UsageLimitSources.readSource")(function* (
    id: UsageLimitSourceId,
    config: UsageLimitSourceConfig,
  ) {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    const base = { id, kind: config.kind, label: sourceLabel(id, config), checkedAt } as const;
    // loom: Anthropic 429s most per-account usage reads, so each account's last
    // good reading carries forward (see `carriedAccounts`) instead of flickering out.
    const previous = (yield* Ref.get(stateRef)).find((source) => source.id === id)?.accounts ?? [];
    if (config.managementKey.length === 0) {
      return { ...base, accounts: [], error: "No management key configured." };
    }
    // loom: one listing feeds login detection and the usage reads.
    const accounts = yield* Effect.gen(function* () {
      const files = yield* api.listAccounts(config);
      const known = yield* detectLogins(config, files);
      const read = yield* api.readAccounts(config, previous, files, (email) =>
        email === undefined ? undefined : known[email]?.lastRefresh,
      );
      const schedule = reloginSchedule(
        claudeFiles(files).map((file) => [file.email!, known[file.email!]] as const),
        DateTime.toEpochMillis(now),
        timeZone,
      );
      return read.map((account) => {
        const relogin =
          account.driver === "claudeAgent" && account.email
            ? schedule.get(account.email)
            : undefined;
        return relogin && account.login
          ? { ...account, login: { ...account.login, relogin } }
          : account;
      });
    }).pipe(Effect.result);
    if (accounts._tag === "Failure") {
      yield* Effect.logDebug("usage limit source read failed", { id, cause: accounts.failure });
      return {
        ...base,
        accounts: carriedAccounts(previous, DateTime.toEpochMillis(now)), // loom
        error: accounts.failure.detail,
      };
    }
    return { ...base, accounts: accounts.success };
  });

  const publish = (next: ReadonlyArray<UsageLimitSourceSnapshot>) =>
    Effect.gen(function* () {
      const changed = yield* Ref.modify(stateRef, (previous) =>
        Equal.equals(previous, next) ? [false, previous] : [true, next],
      );
      if (changed) yield* PubSub.publish(changes, next);
    });

  // One refresh at a time: a slow hub read started before a settings change
  // must not publish after the change's own refresh and resurrect a removed
  // source. Callers queue behind the in-flight run and see current settings.
  const refreshLock = yield* Semaphore.make(1);
  const refresh = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed((): ServerSettings | null => null),
    );
    const entries = Object.entries(settings?.usageLimitSources ?? {}).filter(
      ([, config]) => config.enabled,
    );
    const snapshots = yield* Effect.forEach(
      entries,
      ([id, config]) => readSource(id as UsageLimitSourceId, config),
      { concurrency: 4 },
    );
    yield* publish(snapshots);
  }).pipe(refreshLock.withPermits(1), Effect.ignoreCause({ log: true }));

  // Shares the refresh lock so a stale in-flight read cannot overwrite a redemption.
  const consumeResetCredit = (input: UsageLimitSourceConsumeResetCreditInput) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.mapError(
          () => new UsageLimitSourceError({ detail: "Could not read hub settings." }),
        ),
      );
      const config = settings.usageLimitSources[input.sourceId];
      if (!config?.enabled || !config.managementKey) {
        return yield* new UsageLimitSourceError({
          detail: "The usage limit source is missing or disabled.",
        });
      }
      const result = yield* api.consume(config, input.accountId, input.creditId);
      const snapshot = yield* readSource(input.sourceId, config);
      const previous = yield* Ref.get(stateRef);
      yield* publish(previous.map((source) => (source.id === input.sourceId ? snapshot : source)));
      return result;
    }).pipe(refreshLock.withPermits(1));

  // loom: the hub login dialog. Both share the refresh lock only for the
  // re-read that records the login, never across the wait for the hub.
  const enabledSource = (sourceId: UsageLimitSourceId) =>
    settingsService.getSettings.pipe(
      Effect.mapError(() => new UsageLimitSourceError({ detail: "Could not read hub settings." })),
      Effect.flatMap((settings) => {
        const config = settings.usageLimitSources[sourceId];
        return config?.enabled && config.managementKey
          ? Effect.succeed(config)
          : Effect.fail(
              new UsageLimitSourceError({
                detail: "The usage limit source is missing or disabled.",
              }),
            );
      }),
    );

  const loginStart = (input: UsageLimitSourceLoginStartInput) =>
    Effect.gen(function* () {
      const config = yield* enabledSource(input.sourceId);
      const { url, state } = yield* api.authUrl(config);
      const expiresAt = DateTime.add(yield* DateTime.now, {
        minutes: LOGIN_CALLBACK_WINDOW_MINUTES,
      });
      return { url, state, expiresAt: DateTime.formatIso(expiresAt) };
    });

  const loginFinish = (input: UsageLimitSourceLoginFinishInput) =>
    Effect.gen(function* () {
      const config = yield* enabledSource(input.sourceId);
      const body = oauthCallbackBody(input.pasted, input.state);
      if (!body.redirect_url && !body.code) {
        return yield* new UsageLimitSourceError({
          detail: "That paste has no sign-in code in it.",
        });
      }
      // The hub stamps the login (`last_refresh`, whole seconds) after this instant.
      const startedAt = DateTime.toEpochMillis(yield* DateTime.now) - 2_000;
      yield* api.oauthCallback(config, body);
      // The exchange runs on the hub after the callback is accepted.
      const status = yield* api.authStatus(config, input.state).pipe(
        Effect.flatMap((reply) =>
          reply.status === "wait" ? Effect.fail("wait" as const) : Effect.succeed(reply),
        ),
        Effect.retry({
          while: (error) => error === "wait",
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.timeout("90 seconds"),
        Effect.mapError((error) =>
          isUsageLimitSourceError(error)
            ? error
            : new UsageLimitSourceError({
                detail: "The hub did not finish the login within 90 seconds.",
              }),
        ),
      );
      if (status.status !== "ok") {
        return yield* new UsageLimitSourceError({
          detail: `The hub could not finish the login${status.error ? `: ${status.error}` : ""}.`,
        });
      }
      yield* refresh;
      const loggedIn = Object.entries(yield* Ref.get(records)).find(
        ([, record]) =>
          record.loggedInAt !== undefined && Date.parse(record.loggedInAt) >= startedAt,
      );
      return { loggedIn: loggedIn?.[0] ?? null };
    });

  // Settings edits re-read straight away so a new hub shows up without
  // waiting for the interval, and a removed one leaves the list.
  yield* settingsService.streamChanges.pipe(
    Stream.map((settings) => settings.usageLimitSources),
    Stream.changes,
    Stream.runForEach(() => refresh),
    Effect.forkScoped,
  );

  const interval = settingsService.getSettings.pipe(
    Effect.map(
      (settings) => resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
    ),
    Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
  );
  yield* Effect.forever(
    interval.pipe(
      Effect.flatMap((wait) =>
        Effect.sleep(Duration.toMillis(Duration.fromInputUnsafe(wait)) <= 0 ? "60 seconds" : wait),
      ),
      // loom: no foreground-client gate (upstream's `shouldRunScopeWork`):
      // failover health is fed from these readings while a hub owns Claude
      // quota (SubscriptionUsagePoller), so they must stay fresh unattended.
      Effect.andThen(refresh),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* refresh.pipe(Effect.forkScoped);

  return {
    current: Ref.get(stateRef),
    consumeResetCredit,
    loginStart, // loom
    loginFinish, // loom
    refresh,
    get streamChanges() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(changes);
          const snapshot = yield* Ref.get(stateRef);
          return Stream.concat(Stream.make(snapshot), Stream.fromSubscription(subscription)).pipe(
            Stream.changes,
          );
        }),
      );
    },
  } satisfies UsageLimitSources["Service"];
});

export const layer = Layer.effect(UsageLimitSources, make);
