/**
 * loom: when each pooled Claude account last logged in, and the staggered
 * re-login schedule that keeps the accounts from expiring together.
 *
 * A Claude browser login dies 27.0–29.8 days after it was made (ten observed
 * lifetimes), and nothing on the hub records when that was: `created_at`
 * resets on a hub restart, and the management `last_refresh` survives a
 * re-login. But every browser OAuth login mints fresh `claude_device_ids`
 * (CLIProxyAPI `internal/auth/claude/anthropic_auth.go`) that refreshes never
 * touch, so a changed device id is exactly "a login happened", and the file's
 * `last_refresh` is then the login instant until the first refresh 4h later.
 * Detection reads that from `auth-files/download`, which also carries tokens:
 * only the facts below leave `cliproxyApi`, and none of them is a token.
 *
 * The schedule is one rule: accounts are due at least `gap` days apart, each
 * by its own last weekday before it may expire; the latest-expiring keeps its
 * date and each earlier one moves to `gap` days before the next if it would
 * otherwise be closer. Judged on server-local calendar days, so clients do no
 * date arithmetic.
 *
 * The record lives in `<stateDir>/hub-logins.json`, keyed by email (the auth
 * file's name changes across re-logins) and outside any release, so it
 * survives a redeploy. Production is seeded once with the known login times.
 *
 * @module usage/hubLogins.loom
 */
import type { UsageLimitSourceRelogin } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const DAY_MS = 86_400_000;
/** The shortest observed browser-login lifetime: an account may expire from here. */
export const OAUTH_LIFETIME_DAYS = 27;
/** `claude setup-token` tokens live a year. */
const TOKEN_LIFETIME_DAYS = 365;
/** Anything that outlives this without a refresh token is a long-lived token, not a login. */
const LONG_LIVED_DAYS = 60;
/** The hub's first refresh after a login is 4h on, so a younger `last_refresh` is the login. */
const LOGIN_WINDOW_MS = 4 * 60 * 60_000;
const TOKEN_LEAD_WEEKDAYS = 10;
const MAX_GAP_DAYS = 14;

export const HubLoginRecord = Schema.Struct({
  /** `claude_device_ids[0]`, else a hash of a long-lived token; changes exactly on a login. */
  fingerprint: Schema.String,
  /** The management `modtime` last inspected; an unchanged one skips the download. */
  modtime: Schema.optional(Schema.String),
  /** The file's own `last_refresh`, which (unlike the management clock) a re-login resets. */
  lastRefresh: Schema.optional(Schema.String),
  /** Absent: the login time is unknown, so the account is asked for now. */
  loggedInAt: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
  lifetimeDays: Schema.optional(Schema.Number),
  /** Weekdays before the due day the reminder starts; 3 for an account someone else logs in. */
  leadWeekdays: Schema.optional(Schema.Number),
});
export type HubLoginRecord = typeof HubLoginRecord.Type;
const HubLoginRecords = Schema.Record(Schema.String, HubLoginRecord);
export type HubLoginRecords = Readonly<Record<string, HubLoginRecord>>;
const decodeRecords = Schema.decodeUnknownEffect(Schema.fromJsonString(HubLoginRecords));

/** What `cliproxyApi.downloadAuthFile` reads from an auth file: no token, only its hash. */
export interface HubAuthFileFacts {
  readonly deviceId?: string;
  readonly tokenHash?: string;
  readonly lastRefresh?: string;
  readonly expired?: string;
  readonly refreshable: boolean;
  readonly setupToken: boolean;
}

/** The management `auth-files` fields detection compares against. */
export interface HubAuthFileStamp {
  readonly modtime?: string | undefined;
  readonly created_at?: string | undefined;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
/** A `claude setup-token` token rather than a browser login. */
export const isLongLived = (record: HubLoginRecord) =>
  (record.lifetimeDays ?? OAUTH_LIFETIME_DAYS) >= LONG_LIVED_DAYS;

/**
 * The record after reading one auth file. A new device id is a login, timed
 * by the file's `last_refresh` only when Loom confirmed the old device id
 * (`confirmedAt`, in memory) less than 4h before that clock: the login came
 * after the confirmation and the hub's first refresh comes 4h after a login,
 * so such a clock can only be the login. Otherwise — Loom was down or not yet
 * started across the login — the hub has refreshed since (every healthy file's
 * `last_refresh` is under 4h old, locked to the login time), so the time is
 * unknown and the account is asked for now. With no record yet, a fresh `last_refresh` is a login only when the hub
 * registered the file at that instant too (`created_at`): otherwise it is a
 * routine refresh of an older login. A long-lived token (`claude setup-token`)
 * is never a login: its expiry is the file's `expired`. Undoing one restores
 * the old login with the same device id, whose time is then unknown.
 */
export function detectLogin(
  previous: HubLoginRecord | undefined,
  stamp: HubAuthFileStamp,
  facts: HubAuthFileFacts,
  now: number,
  confirmedAt: number | undefined,
): HubLoginRecord | undefined {
  const clocks = {
    ...(stamp.modtime ? { modtime: stamp.modtime } : {}),
    ...(facts.lastRefresh ? { lastRefresh: facts.lastRefresh } : {}),
  };
  const expired = Date.parse(facts.expired ?? "");
  if (facts.setupToken || (!facts.refreshable && expired - now > LONG_LIVED_DAYS * DAY_MS)) {
    const fingerprint = facts.deviceId ?? facts.tokenHash;
    return fingerprint === undefined
      ? previous
      : {
          fingerprint,
          ...clocks,
          ...(Number.isFinite(expired) ? { expiresAt: iso(expired) } : {}),
          lifetimeDays: TOKEN_LIFETIME_DAYS,
          leadWeekdays: TOKEN_LEAD_WEEKDAYS,
        };
  }
  // Without a device id a refresh cannot be told from a login: keep what is known.
  if (facts.deviceId === undefined) return previous && { ...previous, ...clocks };
  const wasToken = previous !== undefined && isLongLived(previous);
  if (previous?.fingerprint === facts.deviceId && !wasToken) return { ...previous, ...clocks };
  const refreshed = Date.parse(facts.lastRefresh ?? "");
  const login = previous
    ? previous.fingerprint !== facts.deviceId &&
      confirmedAt !== undefined &&
      // A minute's slack: the hub stamps whole seconds.
      refreshed >= confirmedAt - 60_000 &&
      refreshed - confirmedAt < LOGIN_WINDOW_MS
    : now - refreshed < LOGIN_WINDOW_MS &&
      Math.abs(Date.parse(stamp.created_at ?? "") - refreshed) < 60_000;
  return {
    fingerprint: facts.deviceId,
    ...clocks,
    ...(login
      ? { loggedInAt: iso(refreshed), expiresAt: iso(refreshed + OAUTH_LIFETIME_DAYS * DAY_MS) }
      : {}),
    lifetimeDays: OAUTH_LIFETIME_DAYS,
    ...(previous?.leadWeekdays !== undefined && !wasToken
      ? { leadWeekdays: previous.leadWeekdays }
      : {}),
  };
}

// The schedule, on calendar days numbered from the epoch (UTC midnights).

const dayFormat = new Map<string, Intl.DateTimeFormat>();
/** The calendar day an instant falls on in `timeZone`. */
function localDay(ms: number, timeZone: string): number {
  let format = dayFormat.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dayFormat.set(timeZone, format);
  }
  return Date.parse(format.format(ms)) / DAY_MS;
}
/** Day 0 (1 Jan 1970) was a Thursday. */
const isWeekend = (day: number) => [0, 6].includes((day + 4) % 7);
/** The day itself when a weekday, else the Friday before. */
const weekdayOnOrBefore = (day: number): number =>
  isWeekend(day) ? weekdayOnOrBefore(day - 1) : day;
const weekdayOnOrAfter = (day: number): number =>
  isWeekend(day) ? weekdayOnOrAfter(day + 1) : day;
const weekdaysBefore = (day: number, count: number): number =>
  count <= 0 ? day : weekdaysBefore(weekdayOnOrBefore(day - 1), count - 1);
const dayString = (day: number) => iso(day * DAY_MS).slice(0, 10);

/**
 * Every account's re-login schedule, from the records of the accounts the hub
 * holds now (`undefined`: none yet, so asked for now). Accounts are chained
 * by lifetime class, so a one-year token never pulls a monthly login early.
 */
export function reloginSchedule(
  accounts: ReadonlyArray<readonly [email: string, record: HubLoginRecord | undefined]>,
  now: number,
  timeZone: string,
): ReadonlyMap<string, UsageLimitSourceRelogin> {
  const today = localDay(now, timeZone);
  const schedule = new Map<string, UsageLimitSourceRelogin>();
  const classes = Map.groupBy(
    accounts,
    ([, record]) => record !== undefined && isLongLived(record),
  );
  for (const [longLived, members] of classes) {
    const kind = longLived ? "token" : "login";
    const lifetime = Math.min(
      ...members.map(([, record]) => record?.lifetimeDays ?? OAUTH_LIFETIME_DAYS),
    );
    const gap = Math.min(MAX_GAP_DAYS, Math.floor((0.75 * lifetime) / members.length));
    const dated = members
      .flatMap(([email, record]) => {
        const expires = Date.parse(record?.expiresAt ?? "");
        return record && Number.isFinite(expires)
          ? [{ email, record, expires, mustBy: weekdayOnOrBefore(localDay(expires, timeZone) - 1) }]
          : [];
      })
      .sort((a, b) => a.mustBy - b.mustBy || (a.email < b.email ? -1 : 1));
    let next: number | null = null;
    for (const { email, record, expires, mustBy } of dated.toReversed()) {
      const spread = weekdayOnOrBefore(next === null ? mustBy : Math.min(mustBy, next - gap));
      // Never asked for the past for the spread's sake: an early ask that slips rolls
      // forward to the next weekday, and only an account past its own last day is overdue.
      const due = Math.max(spread, Math.min(mustBy, weekdayOnOrAfter(today)));
      next = due;
      const lead = record.leadWeekdays ?? 1;
      schedule.set(email, {
        phase: today < weekdaysBefore(due, lead) ? "later" : today <= due ? "due" : "overdue",
        kind,
        ...(record.loggedInAt ? { loggedInAt: record.loggedInAt } : {}),
        mayExpireAt: iso(expires),
        dueBy: dayString(due),
        early: due < mustBy,
        leadWeekdays: lead,
      });
    }
    for (const [email, record] of members) {
      if (schedule.has(email)) continue;
      schedule.set(email, {
        phase: "due",
        kind,
        dueBy: dayString(today),
        early: false,
        leadWeekdays: record?.leadWeekdays ?? 1,
      });
    }
  }
  return schedule;
}

// The record file.

/** The record, or none when the file is absent; a corrupt file is logged and replaced. */
export const loadHubLogins = Effect.fn("hubLogins.loadHubLogins")(function* (path: string) {
  const fs = yield* FileSystem.FileSystem;
  if (!(yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false)))) return {};
  return yield* fs.readFileString(path).pipe(
    Effect.flatMap(decodeRecords),
    Effect.tapError((cause) =>
      Effect.logWarning("hub login record unreadable; starting empty", { path, cause }),
    ),
    Effect.orElseSucceed((): HubLoginRecords => ({})),
  );
});

export const saveHubLogins = (path: string, records: HubLoginRecords) =>
  writeFileStringAtomically({
    filePath: path,
    contents: `${JSON.stringify(
      Object.fromEntries(Object.entries(records).toSorted(([a], [b]) => a.localeCompare(b))),
      null,
      2,
    )}\n`,
  });
