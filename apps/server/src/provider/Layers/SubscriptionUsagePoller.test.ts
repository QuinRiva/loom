import { it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { decodeUsageWindowId } from "@t3tools/shared/usageWindowId";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { describe, expect } from "vite-plus/test";

import type { AccountUsageSnapshot, AccountUsageWindow } from "../accountUsage.loom.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { applyUsageLimitsUpdate, removeUsageLimitWindows } from "../providerUsageLimits.ts";
import { ProviderHealthRegistry } from "../Services/ProviderHealthRegistry.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { SubscriptionUsagePoller } from "../Services/SubscriptionUsagePoller.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  anthropicAccountPrefixes,
  hubReportsClaudeQuota,
  SubscriptionUsagePollerLive,
  toLimitsWindows,
} from "./SubscriptionUsagePoller.ts";

const windows: ReadonlyArray<AccountUsageWindow> = [
  {
    kind: "primary",
    usedPercent: 41.2,
    resetsAt: "2026-09-21T12:00:00.000Z",
    windowDurationMins: 300,
  },
  {
    kind: "secondary",
    usedPercent: 100,
    resetsAt: null,
    windowDurationMins: null,
    scope: { displayName: "Opus" },
  },
];

describe("hubReportsClaudeQuota", () => {
  const sources = (enabled: boolean) => ({
    [UsageLimitSourceId.make("local")]: {
      kind: "cliproxy" as const,
      url: "http://127.0.0.1:8317",
      managementKey: "k",
      enabled,
    },
  });

  it("stands the Anthropic arm down only while an enabled hub is registered", () => {
    expect(hubReportsClaudeQuota({ usageLimitSources: {} })).toBe(false);
    expect(hubReportsClaudeQuota({ usageLimitSources: sources(true) })).toBe(true);
    expect(hubReportsClaudeQuota({ usageLimitSources: sources(false) })).toBe(false);
  });
});

describe("toLimitsWindows", () => {
  it("gives every pooled account of one instance its own window ids", () => {
    const pooled = ["carl@", "caaarl@", "carl3@", "carl4@", "jacob@"].flatMap((accountLabel) =>
      toLimitsWindows({ accountKey: "pi", accountLabel }, accountLabel, windows),
    );
    expect(new Set(pooled.map((w) => w.id)).size).toBe(10);
    // Upstream merges by id; the failover card reads the account back off it.
    expect(decodeUsageWindowId(pooled[0]!.id)).toEqual({
      accountKey: "pi",
      accountLabel: "carl@",
      kind: "primary",
    });
  });

  it("settles after one poll: a repeat reading republishes nothing and drops no account", () => {
    const accounts = ["carl@", "caaarl@", "carl3@", "carl4@", "jacob@"];
    const poll = (previous: ReturnType<typeof applyUsageLimitsUpdate>) =>
      accounts.reduce(
        (limits, accountLabel) =>
          applyUsageLimitsUpdate({
            previous: limits,
            update: {
              windows: toLimitsWindows({ accountKey: "pi", accountLabel }, accountLabel, windows),
            },
            checkedAt: "2026-09-21T10:00:00.000Z",
          }),
        previous,
      );
    const first = poll(undefined);
    expect(first?.windows).toHaveLength(accounts.length * windows.length);
    // Same object back ⇒ makeManagedServerProvider skips the publish.
    expect(poll(first)).toBe(first);
  });

  it("maps loom's window shape onto upstream's", () => {
    expect(toLimitsWindows({ accountKey: "codex" }, "Codex", windows)).toEqual([
      {
        id: "codex::primary",
        kind: "session",
        label: "Codex 5-hour",
        usedPercent: 41.2,
        resetsAt: "2026-09-21T12:00:00.000Z",
        windowDurationMins: 300,
      },
      { id: "codex::secondary:Opus", kind: "weekly", label: "Codex Opus weekly", usedPercent: 100 },
    ]);
  });
});

// ── The cliproxy hub stand-down, end to end ─────────────────────────────────
//
// A registered hub is the authority on Claude quota, so both Anthropic arms of
// this poller must stop publishing limits AND take back what they published —
// while the pooled accounts keep feeding loom's failover telemetry, which has
// no other source.

const PI = ProviderInstanceId.make("pi");
const POOLED = ["carl@", "jacob@"];
const HUB_ID = UsageLimitSourceId.make("local");
const HUB = { kind: "cliproxy" as const, url: "http://127.0.0.1:8317", managementKey: "k" };

/** One pi instance pooling the hub's accounts through their token files. */
const PI_INSTANCE = {
  driver: ProviderDriverKind.make("pi"),
  usageSources: POOLED.map((label) => ({
    kind: "anthropic-oauth" as const,
    tokenFile: `/pooled/${label}.json`,
    label,
  })),
};

const anthropicBody = {
  five_hour: { utilization: 41.2, resets_at: "2026-09-21T12:00:00.000Z" },
  seven_day: { utilization: 12 },
};
const codexBody = {
  rate_limit: { primary_window: { used_percent: 7, limit_window_seconds: 18000 } },
};

/** Which accounts the pi instance currently draws bars for. */
const accountsOf = (limits: ServerProviderUsageLimits | undefined) =>
  [
    ...new Set(
      (limits?.windows ?? []).map((window) => {
        const identity = decodeUsageWindowId(window.id);
        return identity?.accountLabel ?? identity?.accountKey ?? window.id;
      }),
    ),
  ].toSorted();

const EVERY_ACCOUNT = ["carl@", "claudeAgent", "codex", "jacob@"];

/**
 * Runs the real poller layer over a stubbed disk, HTTP, health registry and
 * instance registry, so the body can step whole poll cycles and watch what
 * reaches the pi instance's published limits.
 */
const withPoller = (
  body: (ctx: {
    /** One healthy-cadence step: every arm polls once. */
    readonly cycle: Effect.Effect<void>;
    readonly limits: Effect.Effect<ServerProviderUsageLimits | undefined>;
    /** Accounts that reported to the health registry since the last cycle. */
    readonly telemetry: Effect.Effect<ReadonlyArray<string>>;
    readonly setHub: (config: { readonly enabled: boolean } | null) => Effect.Effect<void>;
  }) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const limitsRef = yield* Ref.make<ServerProviderUsageLimits | undefined>(undefined);
    const telemetryRef = yield* Ref.make<ReadonlyArray<AccountUsageSnapshot>>([]);
    const instance = {
      snapshot: {
        applyUsageLimits: (update: { readonly checkedAt: string; readonly windows: never }) =>
          Ref.update(limitsRef, (previous) =>
            applyUsageLimitsUpdate({ previous, update, checkedAt: update.checkedAt }),
          ),
        retractUsageLimits: (input: {
          readonly accountPrefixes: ReadonlyArray<string>;
          readonly checkedAt: string;
        }) => Ref.update(limitsRef, (previous) => removeUsageLimitWindows({ ...input, previous })),
      },
    } as unknown as ProviderInstance;

    const dependencies = Layer.mergeAll(
      ServerSettingsService.layerTest({ providerInstances: { [PI]: PI_INSTANCE } }),
      Layer.mock(ProviderHealthRegistry)({
        applyUsage: (snapshot) => Ref.update(telemetryRef, (all) => [...all, snapshot]),
      }),
      Layer.mock(ProviderInstanceRegistry)({
        getInstance: (instanceId) => Effect.succeed(instanceId === PI ? instance : undefined),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([
          { driver: "pi", instanceId: PI, models: [] },
        ] as unknown as ReadonlyArray<ServerProvider>),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(request.url.includes("anthropic.com") ? anthropicBody : codexBody),
            ),
          ),
        ),
      ),
      FileSystem.layerNoop({
        readFileString: (path) =>
          Effect.succeed(
            String(path).endsWith("auth.json")
              ? JSON.stringify({
                  anthropic: { access: "anthropic-token" },
                  "openai-codex": { access: "codex-token", accountId: "codex-account" },
                })
              : JSON.stringify({ access_token: "pooled-token" }),
          ),
      }),
      Path.layer,
    );

    yield* Effect.gen(function* () {
      const settings = yield* ServerSettingsService;
      yield* (yield* SubscriptionUsagePoller).start();
      yield* TestClock.adjust(Duration.zero);
      yield* body({
        cycle: Ref.set(telemetryRef, []).pipe(
          Effect.andThen(TestClock.adjust(Duration.minutes(5))),
        ),
        limits: Ref.get(limitsRef),
        telemetry: Ref.get(telemetryRef).pipe(
          Effect.map((all) => all.map((s) => s.accountLabel ?? s.providerName).toSorted()),
        ),
        setHub: (config) =>
          settings
            .updateSettings({
              usageLimitSources: { [HUB_ID]: config ? { ...HUB, ...config } : null },
            })
            .pipe(Effect.asVoid, Effect.orDie),
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        SubscriptionUsagePollerLive.pipe(
          Layer.provideMerge(dependencies),
          Layer.provideMerge(TestClock.layer()),
        ),
      ),
    );
  });

describe("the cliproxy hub stand-down", () => {
  it.effect("retracts both Anthropic arms' windows while failover telemetry keeps flowing", () =>
    withPoller(({ cycle, limits, telemetry, setHub }) =>
      Effect.gen(function* () {
        yield* cycle;
        expect(accountsOf(yield* limits)).toEqual(EVERY_ACCOUNT);

        yield* setHub({ enabled: true });
        yield* cycle;

        // Only Codex is left on the pi card; the hub draws every Claude account.
        expect(accountsOf(yield* limits)).toEqual(["codex"]);
        // The pooled accounts still report to the health registry — loom's only
        // per-account exhaustion signal, and the reason they stay in settings.
        expect(yield* telemetry).toEqual(["carl@", "codex", "jacob@"]);
      }),
    ),
  );

  it.effect("republishes both arms once the hub is disabled, and again once removed", () =>
    withPoller(({ cycle, limits, setHub }) =>
      Effect.gen(function* () {
        yield* setHub({ enabled: true });
        yield* cycle;
        expect(accountsOf(yield* limits)).toEqual(["codex"]);

        yield* setHub({ enabled: false });
        yield* cycle;
        expect(accountsOf(yield* limits)).toEqual(EVERY_ACCOUNT);

        yield* setHub({ enabled: true });
        yield* cycle;
        expect(accountsOf(yield* limits)).toEqual(["codex"]);

        yield* setHub(null);
        yield* cycle;
        expect(accountsOf(yield* limits)).toEqual(EVERY_ACCOUNT);
      }),
    ),
  );
});

describe("anthropicAccountPrefixes", () => {
  it("covers the direct-auth arm and every pooled Anthropic source, and nothing else", () => {
    expect([
      ...anthropicAccountPrefixes(
        { providerInstances: { [PI]: PI_INSTANCE } },
        [PI],
        (source) => source.label ?? source.tokenFile,
      ),
    ]).toEqual([[PI, ["claudeAgent::", "pi:carl@:", "pi:jacob@:"]]]);
  });
});
