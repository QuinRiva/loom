/**
 * loom: a CLIProxyAPI account's login health, from its management
 * `auth-files` entry alone — pure, so the usage poller and anything else that
 * watches the hub (an out-of-band alert) derive it the same way.
 *
 * The hub refreshes a Claude access token `refreshLead` before it expires and
 * the token lives `lifetime` from `last_refresh` (CLIProxyAPI
 * `sdk/auth/claude.go`, and `expired` = `last_refresh + 8h` in every auth file).
 * When the refresh token has died, every refresh fails, yet the hub keeps the
 * account `active` until the access token itself runs out; only then does it
 * flip to `status: "error"`. So `last_refresh` standing still past the refresh
 * point is the one early signal: the account still works, and stops at
 * `last_refresh + lifetime`. The management API does not expose `expired`, so
 * the clock is the provider's known lifetime. Providers with no known clock
 * (Codex) get only the hub's own verdict.
 *
 * @module usage/cliproxyLogin.loom
 */
import type { UsageLimitSourceLogin } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const HOUR = 60 * 60_000;

const TOKEN_CLOCKS: Partial<
  Record<string, { readonly lifetimeMs: number; readonly refreshLeadMs: number }>
> = {
  claude: { lifetimeMs: 8 * HOUR, refreshLeadMs: 4 * HOUR },
};

/**
 * The hub retries a failed refresh every 5 minutes and checks every few
 * seconds, so a healthy refresh lands within moments of falling due.
 */
const REFRESH_GRACE_MS = 10 * 60_000;

/**
 * The hub's status texts for a credential it cannot sign in with. Others
 * (`quota exhausted`, `transient upstream error`, …) are cooldowns, not logins.
 */
const SIGNED_OUT = new Set(["token expired", "unauthorized", "invalid_grant"]);

export interface CliproxyAuthFileLogin {
  readonly provider: string;
  readonly status?: string | undefined;
  readonly status_message?: string | undefined;
  readonly last_refresh?: string | undefined;
}

export function cliproxyLogin(file: CliproxyAuthFileLogin, now: number): UsageLimitSourceLogin {
  const clock = TOKEN_CLOCKS[file.provider];
  const refreshed = file.last_refresh ? Date.parse(file.last_refresh) : Number.NaN;
  const expiresMs = clock && Number.isFinite(refreshed) ? refreshed + clock.lifetimeMs : null;
  const expiresAt =
    expiresMs === null ? {} : { expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiresMs)) };
  const reason = file.status_message?.trim() ?? "";
  const signedOut = file.status === "error" && SIGNED_OUT.has(reason);
  if (signedOut || (expiresMs !== null && now >= expiresMs))
    return { status: "dead", ...expiresAt, ...(signedOut ? { reason } : {}) };
  if (clock && expiresMs !== null && now > expiresMs - clock.refreshLeadMs + REFRESH_GRACE_MS)
    return { status: "refreshFailing", ...expiresAt };
  return { status: "healthy" };
}
