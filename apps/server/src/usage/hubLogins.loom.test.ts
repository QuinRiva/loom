import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { detectLogin, type HubLoginRecord, reloginSchedule } from "./hubLogins.loom.ts";

const SYDNEY = "Australia/Sydney";
const DAY = 86_400_000;
const at = (local: string) => Date.parse(local);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const login = (loggedInAt: string, extra: Partial<HubLoginRecord> = {}): HubLoginRecord => ({
  fingerprint: `device-${loggedInAt}`,
  loggedInAt: iso(at(loggedInAt)),
  expiresAt: iso(at(loggedInAt) + 27 * DAY),
  lifetimeDays: 27,
  ...extra,
});
const scheduleOf = (
  records: Record<string, HubLoginRecord | undefined>,
  today: string,
): Record<string, { phase: string; dueBy: string; early: boolean }> =>
  Object.fromEntries(
    [...reloginSchedule(Object.entries(records), at(today), SYDNEY)].map(
      ([email, { phase, dueBy, early }]) => [email, { phase, dueBy, early }],
    ),
  );

// The plan's worked example: today's five logins (19 Oct 2026, AEDT).
const seed = {
  "carl@unseen.id": login("2026-10-19T13:34:04+11:00"),
  "caaarl@unseen.id": login("2026-10-19T13:33:11+11:00"),
  "carl3@unseen.id": login("2026-10-19T13:37:33+11:00"),
  "carl4@unseen.id": login("2026-10-19T13:35:02+11:00"),
  "jacob@unseen.id": login("2026-10-06T13:19:46+11:00", { leadWeekdays: 3 }),
};

describe("reloginSchedule", () => {
  it("un-clusters today's four in one cycle, four days apart, each by a weekday", () => {
    expect(scheduleOf(seed, "2026-10-19T15:00:00+11:00")).toEqual({
      "jacob@unseen.id": { phase: "later", dueBy: "2026-10-26", early: true },
      "caaarl@unseen.id": { phase: "later", dueBy: "2026-10-30", early: true },
      "carl3@unseen.id": { phase: "later", dueBy: "2026-11-05", early: true },
      "carl4@unseen.id": { phase: "later", dueBy: "2026-11-09", early: true },
      "carl@unseen.id": { phase: "later", dueBy: "2026-11-13", early: false },
    });
  });

  it("starts the reminder the lead's weekdays before the due day, and is overdue after it", () => {
    expect(scheduleOf(seed, "2026-10-20T23:00:00+11:00")["jacob@unseen.id"]?.phase).toBe("later");
    expect(scheduleOf(seed, "2026-10-21T00:30:00+11:00")["jacob@unseen.id"]?.phase).toBe("due");
    // caaarl@ (due Fri 30 Oct, one-weekday lead) starts on Thu 29 Oct.
    expect(scheduleOf(seed, "2026-10-28T12:00:00+11:00")["caaarl@unseen.id"]?.phase).toBe("later");
    expect(scheduleOf(seed, "2026-10-29T08:00:00+11:00")["caaarl@unseen.id"]?.phase).toBe("due");
    // An early ask that slips stays due, by today, until the account's own last day.
    expect(scheduleOf(seed, "2026-10-27T09:00:00+11:00")["jacob@unseen.id"]).toEqual({
      phase: "due",
      dueBy: "2026-10-27",
      early: true,
    });
    // A slip onto a weekend asks for the next weekday, still inside the account's own days.
    expect(scheduleOf(seed, "2026-10-31T09:00:00+11:00")["caaarl@unseen.id"]).toEqual({
      phase: "due",
      dueBy: "2026-11-02",
      early: true,
    });
    expect(scheduleOf(seed, "2026-11-02T09:00:00+11:00")["jacob@unseen.id"]).toEqual({
      phase: "overdue",
      dueBy: "2026-10-30",
      early: false,
    });
  });

  it("asks nothing more than a day early once the logins land on their due days", () => {
    const cycle2 = {
      "jacob@unseen.id": login("2026-10-26T10:00:00+11:00", { leadWeekdays: 3 }),
      "caaarl@unseen.id": login("2026-10-30T10:00:00+11:00"),
      "carl3@unseen.id": login("2026-11-05T10:00:00+11:00"),
      "carl4@unseen.id": login("2026-11-09T10:00:00+11:00"),
      "carl@unseen.id": login("2026-11-13T10:00:00+11:00"),
    };
    // A Saturday: the calendar, not the weekday, decides the phase.
    expect(scheduleOf(cycle2, "2026-11-14T12:00:00+11:00")).toEqual({
      "jacob@unseen.id": { phase: "later", dueBy: "2026-11-20", early: false },
      "caaarl@unseen.id": { phase: "later", dueBy: "2026-11-25", early: false },
      "carl3@unseen.id": { phase: "later", dueBy: "2026-11-30", early: true },
      "carl4@unseen.id": { phase: "later", dueBy: "2026-12-04", early: false },
      "carl@unseen.id": { phase: "later", dueBy: "2026-12-09", early: false },
    });
  });

  it("asks for an account with no login date now, without a date to show", () => {
    const [entry] = reloginSchedule(
      [["carl5@unseen.id", undefined]],
      at("2026-10-19T15:00:00+11:00"),
      SYDNEY,
    ).values();
    expect(entry).toEqual({
      phase: "due",
      kind: "login",
      dueBy: "2026-10-19",
      early: false,
      leadWeekdays: 1,
    });
  });

  it("chains a one-year token on its own, reminded ten weekdays ahead", () => {
    const token: HubLoginRecord = {
      fingerprint: "token",
      expiresAt: "2027-10-19T04:53:00.000Z",
      lifetimeDays: 365,
      leadWeekdays: 10,
    };
    const schedule = reloginSchedule(
      Object.entries({ ...seed, "carl4@unseen.id": token }),
      at("2026-10-19T15:00:00+11:00"),
      SYDNEY,
    );
    expect(schedule.get("carl4@unseen.id")).toMatchObject({
      kind: "token",
      phase: "later",
      dueBy: "2027-10-18",
      early: false,
      leadWeekdays: 10,
    });
    // The four monthly logins now spread over five-day gaps without it.
    expect(schedule.get("carl@unseen.id")?.dueBy).toBe("2026-11-13");
    expect(schedule.get("carl3@unseen.id")?.dueBy).toBe("2026-11-06");
  });
});

describe("detectLogin", () => {
  const now = at("2026-10-19T15:00:00+11:00");
  const oauth = (deviceId: string, lastRefresh: string) => ({
    deviceId,
    tokenHash: "hash",
    lastRefresh,
    expired: iso(at(lastRefresh) + 8 * 3_600_000),
    refreshable: true,
    setupToken: false,
  });
  const known = seed["carl4@unseen.id"];

  it("keeps the record when the device id is unchanged, updating only the clocks", () => {
    expect(
      detectLogin(
        known,
        { modtime: "m2" },
        oauth(known.fingerprint, "2026-10-19T14:35:02+11:00"),
        now,
        polled,
      ),
    ).toEqual({ ...known, modtime: "m2", lastRefresh: "2026-10-19T14:35:02+11:00" });
  });

  // The previous poll saw the old device id five minutes ago.
  const polled = at("2026-10-19T14:55:00+11:00");

  it("times a new device id by a last_refresh under four hours after the old one was seen", () => {
    expect(
      detectLogin(known, {}, oauth("new-device", "2026-10-19T14:59:30+11:00"), now, polled),
    ).toMatchObject({
      fingerprint: "new-device",
      loggedInAt: "2026-10-19T03:59:30.000Z",
      expiresAt: "2026-11-15T03:59:30.000Z",
    });
  });

  it("leaves a login Loom missed undated, though a refresh since keeps the clock fresh", () => {
    // Logged in at 09:00 while Loom was down; the hub refreshed at 13:00; Loom polls at 15:00.
    const missed = oauth("new-device", "2026-10-19T13:00:00+11:00");
    const last = at("2026-10-19T08:30:00+11:00");
    for (const seen of [last, undefined]) {
      const next = detectLogin(known, {}, missed, now, seen);
      expect(next?.fingerprint).toBe("new-device");
      expect(next?.loggedInAt).toBeUndefined();
    }
  });

  it("on first sight, takes a fresh last_refresh as the login only when the file was registered then", () => {
    const fresh = oauth("device", "2026-10-19T13:33:11+11:00");
    expect(
      detectLogin(undefined, { created_at: "2026-10-19T13:33:11.95+11:00" }, fresh, now, undefined)
        ?.loggedInAt,
    ).toBe("2026-10-19T02:33:11.000Z");
    // jacob@ today: refreshed at 13:19, but its file dates from the 6 Oct login.
    expect(
      detectLogin(undefined, { created_at: "2026-10-06T13:19:46+11:00" }, fresh, now, undefined)
        ?.loggedInAt,
    ).toBeUndefined();
  });

  it("takes a setup token (no refresh token, a year to run) as a token, never a login", () => {
    const token = {
      deviceId: known.fingerprint, // add-token copies the login's device ids
      tokenHash: "hash",
      expired: "2027-10-19T15:53:00+11:00",
      refreshable: false,
      setupToken: true,
    };
    expect(detectLogin(known, { modtime: "m" }, token, now, polled)).toEqual({
      fingerprint: known.fingerprint,
      modtime: "m",
      expiresAt: "2027-10-19T04:53:00.000Z",
      lifetimeDays: 365,
      leadWeekdays: 10,
    });
    // Recognised by its shape too, without the flag.
    expect(
      detectLogin(undefined, {}, { ...token, setupToken: false }, now, undefined)?.lifetimeDays,
    ).toBe(365);
    // Undoing it restores the old login (same device id, last refreshed now): not a new login.
    const restored = detectLogin(
      detectLogin(known, {}, token, now, polled),
      {},
      oauth(known.fingerprint, "2026-10-19T14:59:00+11:00"),
      now,
      polled,
    );
    expect(restored).toMatchObject({ fingerprint: known.fingerprint, lifetimeDays: 27 });
    expect(restored?.loggedInAt).toBeUndefined();
  });
});
