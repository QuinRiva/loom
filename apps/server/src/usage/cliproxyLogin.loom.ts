/**
 * loom: a hub account's login health, pure. A dead refresh token shows only as `last_refresh` stalling
 * past `refreshLead` (the hub stays `active` until `last_refresh + lifetime`); `dead` comes only from
 * the hub. `last_refresh` is the fresher of the management list's and the auth file's, so a re-login
 * clears the warning and it survives a hub restart. Codex has no known clock: hub verdict only.
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
  if (signedOut) return { status: "dead", ...expiresAt, reason };
  if (
    clock &&
    expiresMs !== null &&
    now > expiresMs - clock.refreshLeadMs + REFRESH_GRACE_MS &&
    now < expiresMs
  )
    return { status: "refreshFailing", ...expiresAt };
  return { status: "healthy" };
}
