import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

// loom: hub login health (`apps/server/src/usage/cliproxyLogin.loom.ts`).
/**
 * The pre-emptive re-login schedule for one hub account
 * (`apps/server/src/usage/hubLogins.loom.ts`), judged on the server's local
 * calendar. `later` until `leadWeekdays` weekdays before `dueBy`, `due` through
 * `dueBy`, `overdue` after. `mayExpireAt` absent: no login date on record, so
 * the account is due now. `early`: `dueBy` was pulled before the account's own
 * last safe day to keep the pool's expiries spread out. `kind: "token"` is a
 * long-lived `claude setup-token` token, re-minted rather than logged in.
 */
export const UsageLimitSourceRelogin = Schema.Struct({
  phase: Schema.Literals(["later", "due", "overdue"]),
  kind: Schema.Literals(["login", "token"]),
  loggedInAt: Schema.optional(IsoDateTime),
  mayExpireAt: Schema.optional(IsoDateTime),
  /** A calendar day, `2026-10-30`. */
  dueBy: TrimmedNonEmptyString,
  early: Schema.Boolean,
  leadWeekdays: NonNegativeInt,
});
export type UsageLimitSourceRelogin = typeof UsageLimitSourceRelogin.Type;

/**
 * Whether the source can still sign in to an account. `refreshFailing`
 * is the warning: the hub's refreshes are failing but the current access token
 * still works until `expiresAt`. `dead` means requests on the account fail
 * until it is logged in again; `expiresAt` is then when it stopped, when known.
 * `reason` is the hub's own status text (`token expired`, `unauthorized`).
 */
export const UsageLimitSourceLogin = Schema.Struct({
  status: Schema.Literals(["healthy", "refreshFailing", "dead"]),
  expiresAt: Schema.optional(IsoDateTime),
  reason: Schema.optional(TrimmedNonEmptyString),
  relogin: Schema.optional(UsageLimitSourceRelogin),
});
export type UsageLimitSourceLogin = typeof UsageLimitSourceLogin.Type;

/**
 * `usageLimitSource.login.start`: a sign-in URL minted on the hub. The URL is
 * account-agnostic; whoever signs in is the account that gets logged in.
 */
export const UsageLimitSourceLoginStartInput = Schema.Struct({ sourceId: UsageLimitSourceId });
export type UsageLimitSourceLoginStartInput = typeof UsageLimitSourceLoginStartInput.Type;
export const UsageLimitSourceLoginStartResult = Schema.Struct({
  url: TrimmedNonEmptyString,
  state: TrimmedNonEmptyString,
  expiresAt: IsoDateTime,
});
export type UsageLimitSourceLoginStartResult = typeof UsageLimitSourceLoginStartResult.Type;

/**
 * `usageLimitSource.login.finish`: what claude.ai showed after sign-in — the
 * `code#state` text or the whole address-bar URL. `loggedIn` is the account
 * whose login the hub saved, when Loom could tell which one it was.
 */
export const UsageLimitSourceLoginFinishInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  state: TrimmedNonEmptyString,
  pasted: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type UsageLimitSourceLoginFinishInput = typeof UsageLimitSourceLoginFinishInput.Type;
export const UsageLimitSourceLoginFinishResult = Schema.Struct({
  loggedIn: Schema.NullOr(TrimmedNonEmptyString),
});
export type UsageLimitSourceLoginFinishResult = typeof UsageLimitSourceLoginFinishResult.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
  // loom: absent when the source says nothing about the account's login.
  login: Schema.optional(UsageLimitSourceLogin),
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

// loom: beside `error`, and in place of an account whose own read failed, the
// accounts' last good readings carry forward (with their old `checkedAt`) for a
// bounded time; the account list is empty only once none is left.
export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({ instanceId: ProviderInstanceId }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
