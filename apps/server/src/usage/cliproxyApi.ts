import {
  ProviderDriverKind,
  UsageLimitSourceError,
  type ProviderConsumeResetCreditResult,
  type UsageLimitSourceAccount,
  type UsageLimitSourceConfig,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import { codexPlanLabel } from "../provider/CodexProvider.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import { cliproxyLogin } from "./cliproxyLogin.loom.ts"; // loom
import { isLongLived, type HubAuthFileFacts, type HubLoginRecord } from "./hubLogins.loom.ts"; // loom

// loom: the hub's latest `Anthropic-Ratelimit-Unified-*` response headers per
// model, from real traffic (`trafficUsageLimits`).
const ModelQuota = Schema.Struct({
  observed_at: Schema.optional(Schema.String),
  signals: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});
type ModelQuotas = Readonly<Record<string, typeof ModelQuota.Type>>;

const AuthFile = Schema.Struct({
  id: Schema.String,
  auth_index: Schema.String,
  provider: Schema.String,
  email: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
  // loom: the hub's login state, for `cliproxyLogin`.
  status: Schema.optional(Schema.String),
  status_message: Schema.optional(Schema.String),
  last_refresh: Schema.optional(Schema.String),
  // loom: for the login record (`hubLogins.loom.ts`).
  modtime: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  model_quotas: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, ModelQuota))), // loom
  id_token: Schema.optional(
    Schema.Struct({
      chatgpt_account_id: Schema.optional(Schema.String),
      chatgpt_plan_type: Schema.optional(Schema.String),
    }),
  ),
});
const AuthFiles = Schema.Struct({ files: Schema.Array(AuthFile) });
export type CliproxyAuthFile = typeof AuthFile.Type; // loom
// loom: the fields of a downloaded auth file the login record reads. The file
// carries live tokens: only these are decoded, and the access token only to hash.
const DownloadedAuthFile = Schema.Struct({
  claude_device_ids: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
  last_refresh: Schema.optional(Schema.String),
  expired: Schema.optional(Schema.String),
  is_setup_token: Schema.optional(Schema.Boolean),
});
const decodeDownloadedAuthFile = Schema.decodeUnknownEffect(DownloadedAuthFile);
const decodeAuthUrl = Schema.decodeUnknownEffect(
  Schema.Struct({ url: Schema.String, state: Schema.String }),
);
const decodeAuthStatus = Schema.decodeUnknownEffect(
  Schema.Struct({ status: Schema.String, error: Schema.optional(Schema.String) }),
);
const ApiResponse = Schema.Struct({ status_code: Schema.Number, body: Schema.String });
const CodexWindow = Schema.Struct({
  used_percent: Schema.Number,
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  limit_window_seconds: Schema.optional(Schema.Number),
});
const CodexUsage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.NullOr(
    Schema.Struct({
      primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
      secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    }),
  ),
});
const ClaudeWindow = Schema.Struct({
  utilization: Schema.Number,
  resets_at: Schema.NullOr(Schema.String),
});
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(ClaudeWindow)),
  seven_day: Schema.optional(Schema.NullOr(ClaudeWindow)),
  limits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        kind: Schema.String,
        percent: Schema.optional(Schema.NullOr(Schema.Number)),
        resets_at: Schema.optional(Schema.NullOr(Schema.String)),
        scope: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              model: Schema.optional(Schema.NullOr(Schema.Struct({ display_name: Schema.String }))),
            }),
          ),
        ),
      }),
    ),
  ),
});
const CreditList = Schema.Struct({
  credits: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      status: Schema.String,
      reset_type: Schema.String,
      expires_at: Schema.String,
    }),
  ),
});

const decodeAuthFiles = Schema.decodeUnknownEffect(AuthFiles);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeApiResponse = Schema.decodeUnknownEffect(ApiResponse);
const decodeCreditList = Schema.decodeUnknownEffect(Schema.fromJsonString(CreditList));
const decodeClaudeUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(ClaudeUsage));
const decodeCodexUsage = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexUsage));
const isUsageLimitSourceError = Schema.is(UsageLimitSourceError);

// Codes that mean the certificate chain is not trusted, which an extra CA can fix. Expired or
// mismatched certificates are reported by code only.
const UNTRUSTED_CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/** The Node error code under a failed fetch, which wraps it in a generic `TypeError`. */
const nodeErrorCode = (cause: unknown) => {
  for (let error = cause, depth = 0; error instanceof Error && depth < 3; depth += 1) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
    error = error.cause;
  }
  return undefined;
};

// Hub responses and nested error messages can carry keys or tokens, so only the failure's kind,
// HTTP status, or Node error code reaches the client.
const describeManagementFailure = (error: unknown) => {
  if (Cause.isTimeoutError(error)) return "The hub did not answer within 15 seconds.";
  if (HttpClientError.isHttpClientError(error)) {
    const reason = error.reason;
    if (reason._tag === "StatusCodeError") {
      return `The hub answered with HTTP ${reason.response.status}.`;
    }
    const code = reason._tag === "TransportError" ? nodeErrorCode(reason.cause) : undefined;
    if (code !== undefined && UNTRUSTED_CERTIFICATE_CODES.has(code)) {
      return `The hub's TLS certificate is not trusted (${code}). If it comes from a private CA, add that CA to NODE_EXTRA_CA_CERTS.`;
    }
    if (code !== undefined) return `The hub request failed (${code}).`;
  }
  return "The hub management request failed.";
};
const decodeConsumeResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      code: Schema.Literals(["reset", "nothing_to_reset", "no_credit", "already_redeemed"]),
    }),
  ),
);

// loom: how long an account's last good reading stands in for reads that fail.
// Six 5-minute refreshes: Anthropic 429s roughly half of the per-account usage
// reads, so a gap longer than that is a real outage worth showing, and it stays
// well inside the 5-hour window the reading describes.
const CARRY_FORWARD_MS = 30 * 60_000;

/** loom: the previous accounts whose reading is good and young enough to carry forward. */
export const carriedAccounts = (
  previous: ReadonlyArray<UsageLimitSourceAccount>,
  now: number,
): ReadonlyArray<UsageLimitSourceAccount> =>
  previous.filter(
    (account) =>
      !account.usageLimits.unavailable &&
      now - Date.parse(account.usageLimits.checkedAt) < CARRY_FORWARD_MS,
  );

/**
 * loom: an account's usage from the hub's own readings of Anthropic's
 * rate-limit headers on real traffic (`model_quotas`), for when `oauth/usage`
 * refuses: always for a one-year token, and for about half the reads of a
 * browser login. Each window comes from the freshest model reading that
 * carries it; the per-model weekly (`7d_oi`) is named for its model
 * (`claude-fable-5-1` is `Fable`). A reading older than `CARRY_FORWARD_MS` is
 * dropped, as a carried one would be, so a quiet account shows no usage rather
 * than hours-old usage — except a window it shows exhausted, which stays so
 * until its reset however long the account then goes without traffic.
 * `checkedAt` is when the hub took the freshest reading used. Undefined when
 * there is none.
 */
export const trafficUsageLimits = (quotas: ModelQuotas | null | undefined, now: number) => {
  const readings = Object.entries(quotas ?? {})
    .map(([model, quota]) => ({ model, at: Date.parse(quota.observed_at ?? ""), quota }))
    .filter((reading) => Number.isFinite(reading.at))
    .toSorted((left, right) => right.at - left.at);
  const pick = (claim: string) =>
    readings.flatMap(({ model, at, quota }) => {
      const header = (field: string) =>
        Number(quota.signals?.[`Anthropic-Ratelimit-Unified-${claim}-${field}`] ?? Number.NaN);
      const used = Math.round(header("Utilization") * 100);
      const reset = header("Reset") * 1000;
      return Number.isFinite(used) && (now - at < CARRY_FORWARD_MS || (used >= 100 && reset > now))
        ? [
            {
              model,
              at,
              window: {
                utilization: used,
                resets_at: reset > 0 ? DateTime.formatIso(DateTime.makeUnsafe(reset)) : null,
              },
            },
          ]
        : [];
    })[0];
  const [fiveHour, sevenDay, scoped] = [pick("5h"), pick("7d"), pick("7d_oi")];
  const picked = [fiveHour, sevenDay, scoped].flatMap((entry) => (entry ? [entry.at] : []));
  if (picked.length === 0) return undefined;
  const family = scoped?.model.split("-")[1] ?? "";
  return claudeUsageResponseToLimits({
    checkedAt: DateTime.formatIso(DateTime.makeUnsafe(Math.max(...picked))),
    response: {
      rate_limits_available: true,
      rate_limits: {
        five_hour: fiveHour?.window ?? null,
        seven_day: sevenDay?.window ?? null,
        model_scoped: scoped
          ? [
              {
                display_name: `${family.charAt(0).toUpperCase()}${family.slice(1)}`,
                ...scoped.window,
              },
            ]
          : [],
      },
    },
  }).limits;
};

/**
 * loom: a hub refusal as one line, with the hub's own `error` text when it gave
 * one and the caller passed it. Only the login calls do: other refusals can
 * echo keys or tokens, so they name the status alone, as upstream's
 * `describeManagementFailure` does.
 */
const hubRefusal = (status: number, body: unknown) => {
  const error =
    typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error.trim().slice(0, 200)
      : "";
  return error ? `The hub refused the request: ${error}.` : `The hub answered with HTTP ${status}.`;
};

/** loom: the later of two ISO clocks, either possibly absent. */
const fresherClock = (left: string | undefined, right: string | undefined) =>
  left === undefined || (right !== undefined && Date.parse(right) > Date.parse(left))
    ? right
    : left;

const CODEX_BASE = "https://chatgpt.com/backend-api/wham";
const CREDIT_URL = `${CODEX_BASE}/rate-limit-reset-credits`;

const CREDIT_REDEEM_NAMESPACE = new Uint8Array([
  0x6f, 0x1c, 0x2a, 0x9e, 0x2d, 0x4b, 0x4c, 0x1e, 0x9a, 0x7f, 0x3b, 0x8d, 0x5e, 0x0c, 0x1a, 0x42,
]);

// UUIDv5 per account and credit also deduplicates retries across T3 environments.
const creditRedeemRequestId = Effect.fn("CliproxyApi.creditRedeemRequestId")(function* (
  accountId: string,
  creditId: string,
) {
  const crypto = yield* Crypto.Crypto;
  const name = new TextEncoder().encode(`${accountId}:${creditId}`);
  const input = new Uint8Array(CREDIT_REDEEM_NAMESPACE.length + name.length);
  input.set(CREDIT_REDEEM_NAMESPACE);
  input.set(name, CREDIT_REDEEM_NAMESPACE.length);
  const bytes = (yield* crypto.digest("SHA-1", input).pipe(Effect.orDie)).slice(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Hex.encode(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
});

export const makeCliproxyApi = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const crypto = yield* Crypto.Crypto;

  const management = Effect.fn("CliproxyApi.management")(function* (
    config: UsageLimitSourceConfig,
    path: string,
    body?: unknown,
    hubText = false, // loom: see `hubRefusal`
  ) {
    const url = yield* Effect.try({
      try: () =>
        new URL(
          `v0/management/${path}`,
          config.url.endsWith("/") ? config.url : `${config.url}/`,
        ).toString(),
      catch: () => new UsageLimitSourceError({ detail: "The hub URL is not valid." }),
    });
    const request = (
      body === undefined ? HttpClientRequest.get(url) : HttpClientRequest.post(url)
    ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${config.managementKey}`));
    const response = yield* client
      .execute(body === undefined ? request : request.pipe(HttpClientRequest.bodyJsonUnsafe(body)))
      .pipe(
        // loom: a refusal names its HTTP status, and on the login calls
        // (`hubText`) the hub's own `error` text, which the login dialog shows.
        Effect.flatMap(
          (
            response,
          ): Effect.Effect<unknown, UsageLimitSourceError | HttpClientError.HttpClientError> =>
            response.status >= 200 && response.status < 300
              ? response.json
              : response.json.pipe(
                  Effect.orElseSucceed(() => undefined),
                  Effect.flatMap((reply) =>
                    Effect.fail(
                      new UsageLimitSourceError({
                        detail: hubRefusal(response.status, hubText ? reply : undefined),
                      }),
                    ),
                  ),
                ),
        ),
        Effect.timeout("15 seconds"),
        Effect.mapError((error) =>
          isUsageLimitSourceError(error)
            ? error
            : new UsageLimitSourceError({ detail: describeManagementFailure(error) }),
        ),
      );
    return response;
  });

  const authFiles = Effect.fn("CliproxyApi.authFiles")(function* (config: UsageLimitSourceConfig) {
    const response = yield* management(config, "auth-files");
    return (yield* decodeAuthFiles(response)).files;
  });

  const apiCall = Effect.fn("CliproxyApi.apiCall")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
    url: string,
    data?: unknown,
  ) {
    const header =
      account.provider === "codex"
        ? {
            Authorization: "Bearer $TOKEN$",
            "Content-Type": "application/json",
            "OpenAI-Beta": "codex-1",
            Originator: "Codex Desktop",
            ...(account.id_token?.chatgpt_account_id
              ? { "Chatgpt-Account-Id": account.id_token.chatgpt_account_id }
              : {}),
          }
        : { Authorization: "Bearer $TOKEN$", "anthropic-beta": "oauth-2025-04-20" };
    const raw = yield* management(config, "api-call", {
      auth_index: account.auth_index,
      method: data === undefined ? "GET" : "POST",
      url,
      header,
      ...(data === undefined ? {} : { data: yield* encodeJson(data) }),
    });
    const response = yield* decodeApiResponse(raw);
    if (response.status_code < 200 || response.status_code >= 300) {
      return yield* new UsageLimitSourceError({
        detail: `The provider refused the hub request (HTTP ${response.status_code}).`,
      });
    }
    return response.body;
  });

  const credits = Effect.fn("CliproxyApi.credits")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
  ) {
    const body = yield* apiCall(config, account, CREDIT_URL);
    const response = yield* decodeCreditList(body);
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    return response.credits
      .filter(
        (credit) =>
          credit.reset_type === "codex_rate_limits" &&
          credit.status === "available" &&
          Date.parse(credit.expires_at) > now,
      )
      .toSorted((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  });

  // loom: the login record's reads and cliproxy's OAuth flow (`hubLogins.loom.ts`).
  const downloadAuthFile = Effect.fn("CliproxyApi.downloadAuthFile")(function* (
    config: UsageLimitSourceConfig,
    id: string,
  ): Effect.fn.Return<HubAuthFileFacts, UsageLimitSourceError> {
    const file = yield* management(
      config,
      `auth-files/download?name=${encodeURIComponent(id)}`,
    ).pipe(
      Effect.flatMap(decodeDownloadedAuthFile),
      Effect.mapError(
        () => new UsageLimitSourceError({ detail: "The hub could not return an auth file." }),
      ),
    );
    const tokenHash = file.access_token
      ? Hex.encode(
          new Uint8Array(
            yield* crypto
              .digest("SHA-256", new TextEncoder().encode(file.access_token))
              .pipe(Effect.orDie),
          ),
        )
      : undefined;
    return {
      ...(file.claude_device_ids?.[0] ? { deviceId: file.claude_device_ids[0] } : {}),
      ...(tokenHash ? { tokenHash } : {}),
      ...(file.last_refresh ? { lastRefresh: file.last_refresh } : {}),
      ...(file.expired ? { expired: file.expired } : {}),
      refreshable: Boolean(file.refresh_token),
      setupToken: file.is_setup_token === true,
    };
  });

  const authUrl = Effect.fn("CliproxyApi.authUrl")(function* (config: UsageLimitSourceConfig) {
    return yield* management(config, "anthropic-auth-url").pipe(
      Effect.flatMap(decodeAuthUrl),
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub returned no sign-in URL." }),
      ),
    );
  });

  const oauthCallback = Effect.fn("CliproxyApi.oauthCallback")(function* (
    config: UsageLimitSourceConfig,
    body: Readonly<Record<string, string>>,
  ) {
    yield* management(config, "oauth-callback", { provider: "anthropic", ...body }, true);
  });

  const authStatus = Effect.fn("CliproxyApi.authStatus")(function* (
    config: UsageLimitSourceConfig,
    state: string,
  ) {
    return yield* management(config, `get-auth-status?state=${encodeURIComponent(state)}`).pipe(
      Effect.flatMap(decodeAuthStatus),
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub returned an unreadable login status." }),
      ),
    );
  });

  const readAccount = Effect.fn("CliproxyApi.readAccount")(function* (
    config: UsageLimitSourceConfig,
    account: typeof AuthFile.Type,
    carried: UsageLimitSourceAccount | undefined, // loom: last good reading
    record: HubLoginRecord | undefined, // loom: the login record (`hubLogins.loom.ts`)
  ) {
    const now = yield* DateTime.now;
    const checkedAt = DateTime.formatIso(now);
    // loom: the fresher of the hub's in-memory refresh clock and the file's own,
    // which a re-login resets.
    const login = cliproxyLogin(
      { ...account, last_refresh: fresherClock(account.last_refresh, record?.lastRefresh) },
      DateTime.toEpochMillis(now),
    );
    const base = {
      id: account.id,
      driver: ProviderDriverKind.make(account.provider === "codex" ? "codex" : "claudeAgent"),
      ...(account.email ? { email: account.email } : {}),
      ...(account.id_token?.chatgpt_account_id?.trim()
        ? { workspaceId: account.id_token.chatgpt_account_id.trim() }
        : {}),
      login, // loom
    };
    // loom: a signed-out account cannot be read, and its last reading must not
    // stand in for it: it has no quota to offer until it is logged in again.
    if (login.status === "dead") {
      return {
        ...base,
        usageLimits: makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: `Signed out${login.reason ? ` (the hub reports "${login.reason}")` : ""}. Log in to this account again.`,
        }),
      } satisfies UsageLimitSourceAccount;
    }
    const read = Effect.gen(function* () {
      if (account.provider === "claude") {
        // loom: a one-year token's usage read always fails (403, then 429).
        if (record && isLongLived(record)) {
          return yield* new UsageLimitSourceError({
            detail:
              "A one-year token cannot read its usage, and the hub has seen no traffic on this account for 30 minutes.",
          });
        }
        const body = yield* apiCall(config, account, "https://api.anthropic.com/api/oauth/usage");
        const usage = yield* decodeClaudeUsage(body);
        const model_scoped = (usage.limits ?? []).flatMap((limit) =>
          limit.kind === "weekly_scoped" && limit.scope?.model && typeof limit.percent === "number"
            ? [
                {
                  display_name: limit.scope.model.display_name,
                  utilization: limit.percent,
                  resets_at: limit.resets_at ?? null,
                },
              ]
            : [],
        );
        return {
          ...base,
          plan: "Claude Subscription",
          usageLimits: claudeUsageResponseToLimits({
            checkedAt,
            response: {
              rate_limits_available: true,
              rate_limits: {
                five_hour: usage.five_hour ?? null,
                seven_day: usage.seven_day ?? null,
                model_scoped,
              },
            },
          }).limits,
        };
      }
      const body = yield* apiCall(config, account, `${CODEX_BASE}/usage`);
      const usage = yield* decodeCodexUsage(body);
      const toWindow = (window: typeof CodexWindow.Type | null | undefined) =>
        window
          ? {
              usedPercent: window.used_percent,
              resetsAt: window.reset_at ?? null,
              ...(window.limit_window_seconds === undefined
                ? {}
                : { windowDurationMins: window.limit_window_seconds / 60 }),
            }
          : null;
      const available = yield* credits(config, account).pipe(Effect.orElseSucceed(() => undefined));
      const next = available?.[0];
      return {
        ...base,
        plan: codexPlanLabel(usage.plan_type ?? account.id_token?.chatgpt_plan_type),
        usageLimits: {
          ...codexRateLimitsToLimits({
            checkedAt,
            snapshot: {
              planType: usage.plan_type ?? null,
              primary: toWindow(usage.rate_limit?.primary_window),
              secondary: toWindow(usage.rate_limit?.secondary_window),
            },
          }),
          ...(available
            ? {
                resetCredits: {
                  availableCount: available.length,
                  ...(next
                    ? {
                        nextCreditId: next.id,
                        nextExpiresAt: DateTime.formatIso(DateTime.makeUnsafe(next.expires_at)),
                      }
                    : {}),
                },
              }
            : {}),
        },
      };
    });
    return yield* read.pipe(
      // loom: a failed read takes the fresher of the hub's traffic reading and
      // the account's last good reading (checkedAt and all), under the current
      // login; with neither, the hub's reason when it gave one. A browser
      // login's traffic reading keeps the carried windows it lacks (the Fable
      // weekly, when the account had no Fable traffic lately) rather than
      // blanking them for a poll; a token seat's traffic is its only reading,
      // so its stale windows drop as `trafficUsageLimits` says.
      Effect.catch((error) => {
        const traffic = trafficUsageLimits(account.model_quotas, DateTime.toEpochMillis(now));
        const keep =
          carried && !(record && isLongLived(record))
            ? carried.usageLimits.windows.filter(
                (window) => !traffic?.windows.some((fresh) => fresh.id === window.id),
              )
            : [];
        const fallback = [
          ...(traffic
            ? [
                {
                  ...base,
                  plan: "Claude Subscription",
                  usageLimits: { ...traffic, windows: [...traffic.windows, ...keep] },
                },
              ]
            : []),
          ...(carried ? [{ ...carried, login }] : []),
        ].toSorted(
          (left, right) =>
            Date.parse(right.usageLimits.checkedAt) - Date.parse(left.usageLimits.checkedAt),
        )[0];
        return Effect.succeed<UsageLimitSourceAccount>(
          fallback ?? {
            ...base,
            usageLimits: makeUnavailableUsageLimits({
              checkedAt,
              reason: "probeFailed",
              message: isUsageLimitSourceError(error)
                ? error.detail
                : "The hub could not read this account's usage.",
            }),
          },
        );
      }),
    );
  });

  const readAccounts = Effect.fn("CliproxyApi.readAccounts")(function* (
    config: UsageLimitSourceConfig,
    previous: ReadonlyArray<UsageLimitSourceAccount>, // loom: carry-forward source
    accounts: ReadonlyArray<typeof AuthFile.Type>, // loom: listed once by the caller
    record: (email: string | undefined) => HubLoginRecord | undefined = () => undefined, // loom
  ): Effect.fn.Return<ReadonlyArray<UsageLimitSourceAccount>, UsageLimitSourceError> {
    const carried = carriedAccounts(previous, DateTime.toEpochMillis(yield* DateTime.now)); // loom
    return yield* Effect.forEach(
      accounts.filter(
        (account) =>
          !account.disabled && (account.provider === "codex" || account.provider === "claude"),
      ),
      (account) =>
        readAccount(
          config,
          account,
          carried.find((candidate) => candidate.id === account.id), // loom
          record(account.email), // loom
        ),
      { concurrency: 4 },
    );
  });

  const consume = Effect.fn("CliproxyApi.consume")(function* (
    config: UsageLimitSourceConfig,
    accountId: string,
    creditId: string,
  ): Effect.fn.Return<ProviderConsumeResetCreditResult, UsageLimitSourceError> {
    const operation = Effect.gen(function* () {
      const account = (yield* authFiles(config)).find((account) => account.id === accountId);
      if (!account || account.disabled || account.provider !== "codex") {
        return yield* new UsageLimitSourceError({
          detail: "The Codex hub account is missing or disabled.",
        });
      }
      const body = yield* apiCall(config, account, `${CREDIT_URL}/consume`, {
        redeem_request_id: yield* creditRedeemRequestId(
          account.id_token?.chatgpt_account_id ?? account.id,
          creditId,
        ).pipe(Effect.provideService(Crypto.Crypto, crypto)),
        credit_id: creditId,
      });
      const response = yield* decodeConsumeResponse(body);
      const outcome = (
        {
          reset: "reset",
          nothing_to_reset: "nothingToReset",
          no_credit: "noCredit",
          already_redeemed: "alreadyRedeemed",
        } as const
      )[response.code];
      if (outcome !== "reset" && outcome !== "alreadyRedeemed") return { outcome };
      const cleared = yield* management(config, "reset-quota", {
        auth_index: account.auth_index,
      }).pipe(Effect.result);
      return {
        outcome,
        ...(cleared._tag === "Failure"
          ? {
              warning:
                "Credit redeemed, but the hub cooldown could not be cleared. Routing may resume after its cooldown expires.",
            }
          : {}),
      } as const;
    });
    return yield* operation.pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({
              detail: "The hub returned an unexpected reset-credit response.",
            }),
      ),
    );
  });
  // loom: `listAccounts` and the login calls for `UsageLimitSources`.
  const listAccounts = (config: UsageLimitSourceConfig) =>
    authFiles(config).pipe(
      Effect.mapError((error) =>
        isUsageLimitSourceError(error)
          ? error
          : new UsageLimitSourceError({ detail: "The hub could not list accounts." }),
      ),
    );
  return {
    listAccounts,
    readAccounts,
    consume,
    downloadAuthFile,
    authUrl,
    oauthCallback,
    authStatus,
  };
});
