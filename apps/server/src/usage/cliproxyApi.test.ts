import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi, trafficUsageLimits } from "./cliproxyApi.ts";

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Api = Effect.Success<typeof makeCliproxyApi>;
const readAll = (api: Api, previous: Parameters<Api["readAccounts"]>[1]) =>
  api
    .listAccounts(config)
    .pipe(Effect.flatMap((files) => api.readAccounts(config, previous, files)));

function fixture(
  options: {
    accounts?: Array<
      (typeof accounts)[number] & {
        disabled?: boolean;
        id_token: { chatgpt_account_id: string; plan_type?: string; chatgpt_plan_type?: string };
        // loom: hub account status fields
        status?: string;
        status_message?: string;
        last_refresh?: string;
        model_quotas?: Parameters<typeof trafficUsageLimits>[0];
      }
    >;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({ files: options.accounts ?? accounts }),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json({}, { status: options.cooldownStatus ?? 200 }),
        );
      expect(path).toMatch(/\/v0\/management\/api-call$/);
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
    Effect.provide(NodeCrypto.layer),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.listAccounts(config)); // loom: listing moved out of `readAccounts`
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  // regression: #18168 Limits hub failures name their TLS, HTTP, or timeout cause
  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.listAccounts(config)); // loom: listing moved out of `readAccounts`
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.listAccounts(config)); // loom: listing moved out of `readAccounts`
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );
});

describe("CLIProxyAPI built-in management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* readAll(api, []);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("resolves a missing usage plan from current, then legacy, token plans", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          { ...accounts[0]!, id_token: { chatgpt_account_id: "account-a", plan_type: "free" } },
          {
            ...accounts[1]!,
            id_token: {
              chatgpt_account_id: "account-b",
              plan_type: "go",
              chatgpt_plan_type: "plus",
            },
          },
          {
            ...accounts[1]!,
            id: "third.json",
            auth_index: "c",
            id_token: { chatgpt_account_id: "account-c", chatgpt_plan_type: "free" },
          },
        ],
        upstream: (request) => ({
          status: 200,
          body: {
            ...(request.auth_index === "a" ? { plan_type: "plus" } : {}),
            rate_limit: { primary_window: { used_percent: 12 } },
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result.map((account) => [account.plan, account.usageLimits.windows[0]?.kind])).toEqual(
        [
          ["ChatGPT Plus Subscription", "session"],
          ["ChatGPT Go Subscription", "monthly"],
          ["ChatGPT Free Subscription", "monthly"],
        ],
      );
    }),
  );

  it.effect("keeps the path of a hub served under a prefix", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      // loom: listing moved out of `readAccounts`.
      const prefixed = { ...config, url: "https://tools.test/cliproxy" };
      yield* api
        .listAccounts(prefixed)
        .pipe(Effect.flatMap((files) => api.readAccounts(prefixed, [], files)));
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* readAll(api, []);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* readAll(api, []);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  // loom: Anthropic 429s most per-account reads, so a failed read keeps the
  // account's last good reading rather than dropping it off the meter.
  it.effect("carries a failed account's last good reading forward for 30 minutes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-09-30T12:00:00.000Z"));
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 429, body: {} }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const good = (id: string, checkedAt: string) => ({
        id,
        driver: ProviderDriverKind.make("codex"),
        usageLimits: {
          checkedAt,
          windows: [{ id: "primary", kind: "session" as const, label: "5h", usedPercent: 40 }],
        },
      });
      const recent = good("first.json", "2026-09-30T11:35:00.000Z");

      const carried = yield* readAll(api, [
        recent,
        good("gone.json", recent.usageLimits.checkedAt),
      ]);
      expect(carried[0]).toEqual({ ...recent, login: { status: "healthy" } });
      // Only the failed account is carried; the other is read fresh, and a
      // previous account the hub no longer lists is not resurrected.
      expect(carried.map((account) => account.id)).toEqual(["first.json", "second.json"]);
      expect(carried[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);

      const old = good("first.json", "2026-09-30T11:29:00.000Z");
      const expired = yield* readAll(api, [old]);
      expect(expired[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
    }),
  );

  // loom: the hub's real reason, not the generic probe failure, and no reading
  // (fresh or carried) for an account that cannot serve a request.
  it.effect("reports a signed-out account with the hub's reason and does not read it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-19T02:16:00.000Z"));
      const test = fixture({
        accounts: [
          {
            ...accounts[0]!,
            provider: "claude",
            status: "error",
            status_message: "token expired",
            last_refresh: "2026-10-18T22:26:29+11:00",
          },
        ],
      });
      const api = yield* test.api;
      const [account] = yield* readAll(api, [
        {
          id: "first.json",
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: { checkedAt: "2026-10-19T02:10:00.000Z", windows: [] },
        },
      ]);
      expect(account?.login).toEqual({
        status: "dead",
        expiresAt: "2026-10-18T19:26:29.000Z",
        reason: "token expired",
      });
      expect(account?.usageLimits.unavailable?.message).toContain("token expired");
      expect(test.requests.filter((request) => request.body?.url)).toEqual([]);
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        // The usage endpoint answers 429 to requests without a Claude Code user agent.
        upstream: (request) => ({
          status: request.header?.["User-Agent"]?.startsWith("claude-code/") ? 200 : 429,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* readAll(api, []);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  // loom: Anthropic's rate-limit headers as the hub saw them on real traffic.
  const signals = (fiveHour: string, sevenDay: string, fable?: string) => ({
    "Anthropic-Ratelimit-Unified-5h-Utilization": fiveHour,
    "Anthropic-Ratelimit-Unified-5h-Reset": "1792395000",
    "Anthropic-Ratelimit-Unified-7d-Utilization": sevenDay,
    "Anthropic-Ratelimit-Unified-7d-Reset": "1792440000",
    ...(fable
      ? {
          "Anthropic-Ratelimit-Unified-7d_oi-Utilization": fable,
          "Anthropic-Ratelimit-Unified-7d_oi-Reset": "1792440000",
        }
      : {}),
  });
  const quotas = {
    "claude-fable-5-1": {
      observed_at: "2026-10-19T16:50:00+11:00",
      signals: signals("0.26", "0.64", "1.0"),
    },
    "claude-opus-5-5": {
      observed_at: "2026-10-19T17:14:14+11:00",
      signals: signals("0.34", "0.65"),
    },
    "claude-opus-5": { observed_at: "2026-10-14T20:52:32+11:00", signals: signals("0.99", "0.99") },
  };

  it("maps the freshest traffic headers to windows, dated when the hub saw them", () => {
    const limits = trafficUsageLimits(quotas, Date.parse("2026-10-19T17:15:00+11:00"));
    expect(limits?.checkedAt).toBe("2026-10-19T06:14:14.000Z");
    expect(
      limits?.windows.map((window) => [
        window.id,
        window.label,
        window.usedPercent,
        window.resetsAt,
      ]),
    ).toEqual([
      ["five_hour", "Session", 34, "2026-10-19T07:30:00.000Z"],
      ["seven_day", "Weekly", 65, "2026-10-19T20:00:00.000Z"],
      ["seven_day_fable", "Weekly \u00b7 Fable", 100, "2026-10-19T20:00:00.000Z"],
    ]);
    // Over 30 minutes on, a window is dropped unless it was exhausted: that
    // holds until its reset; after that there is no reading.
    const later = trafficUsageLimits(quotas, Date.parse("2026-10-19T19:00:00+11:00"));
    expect(later?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["seven_day_fable", 100],
    ]);
    expect(later?.checkedAt).toBe("2026-10-19T05:50:00.000Z");
    expect(trafficUsageLimits(quotas, Date.parse("2026-10-20T08:00:00+11:00"))).toBeUndefined();
  });

  it.effect("falls back to traffic headers, and never asks for a one-year token's usage", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-10-19T17:15:00+11:00"));
      const test = fixture({
        accounts: [
          { ...accounts[0]!, provider: "claude", model_quotas: quotas },
          { ...accounts[1]!, provider: "claude" },
        ],
        upstream: () => ({ status: 429, body: {} }),
      });
      const api = yield* test.api;
      const [login, token] = yield* api
        .listAccounts(config)
        .pipe(
          Effect.flatMap((files) =>
            api.readAccounts(config, [], files, (email) =>
              email === "second@example.com"
                ? { fingerprint: "hash", lifetimeDays: 365 }
                : undefined,
            ),
          ),
        );
      expect(login?.usageLimits.checkedAt).toBe("2026-10-19T06:14:14.000Z");
      expect(login?.usageLimits.windows.map((window) => window.usedPercent)).toEqual([34, 65, 100]);
      expect(token?.usageLimits.unavailable?.message).toContain("one-year token");
      expect(test.requests.flatMap((request) => request.body?.auth_index ?? [])).toEqual(["a"]);

      // A browser login's traffic with no Fable reading keeps the carried Fable weekly.
      const opusOnly = yield* fixture({
        accounts: [
          {
            ...accounts[0]!,
            provider: "claude",
            model_quotas: { "claude-opus-5-5": quotas["claude-opus-5-5"] },
          },
        ],
        upstream: () => ({ status: 429, body: {} }),
      }).api;
      const [merged] = yield* readAll(opusOnly, [
        {
          id: "first.json",
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: {
            checkedAt: "2026-10-19T06:00:00.000Z",
            windows: [
              { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 60 },
              {
                id: "seven_day_fable",
                kind: "weekly",
                label: "Weekly \u00b7 Fable",
                usedPercent: 80,
              },
            ],
          },
        },
      ]);
      expect(merged?.usageLimits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["five_hour", 34],
        ["seven_day", 65],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* readAll(api, [])).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(test.requests.every((request) => request.path.endsWith("/auth-files"))).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});
