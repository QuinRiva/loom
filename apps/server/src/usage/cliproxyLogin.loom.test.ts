import { describe, expect, it } from "@effect/vitest";

import { cliproxyLogin } from "./cliproxyLogin.loom.ts";

const HOUR = 3_600_000;
const refreshed = Date.parse("2026-10-19T06:27:34+11:00");
const claude = (fields: { status?: string; status_message?: string } = {}) => ({
  provider: "claude",
  status: "active",
  status_message: "",
  last_refresh: "2026-10-19T06:27:34+11:00",
  ...fields,
});
const expiresAt = "2026-10-19T03:27:34.000Z"; // last_refresh + 8h

describe("cliproxyLogin", () => {
  it("is healthy until the refresh is overdue", () => {
    expect(cliproxyLogin(claude(), refreshed + 4 * HOUR + 5 * 60_000)).toEqual({
      status: "healthy",
    });
  });

  // carl3@ on 19 Oct: still `active` at 13:08 though every refresh since 10:27 failed.
  it("warns while the hub still says active once the refresh is overdue", () => {
    expect(cliproxyLogin(claude(), Date.parse("2026-10-19T13:08:00+11:00"))).toEqual({
      status: "refreshFailing",
      expiresAt,
    });
  });

  // A re-login over an existing auth file keeps the hub's old `last_refresh`
  // until its next refresh, ~4h on: the hub serving it outranks the clock.
  it("trusts the hub over a stale clock once the old token's expiry has passed", () => {
    expect(cliproxyLogin(claude(), refreshed + 9 * HOUR)).toEqual({ status: "healthy" });
  });

  it("is dead with the hub's reason when the hub has signed the account out", () => {
    expect(
      cliproxyLogin(
        claude({ status: "error", status_message: "token expired" }),
        refreshed + 9 * HOUR,
      ),
    ).toEqual({ status: "dead", expiresAt, reason: "token expired" });
    expect(
      cliproxyLogin(
        { provider: "codex", status: "error", status_message: "unauthorized" },
        refreshed,
      ),
    ).toEqual({ status: "dead", reason: "unauthorized" });
  });

  it("does not read a quota cooldown as a dead login", () => {
    expect(
      cliproxyLogin(
        claude({ status: "error", status_message: "quota exhausted" }),
        refreshed + HOUR,
      ),
    ).toEqual({ status: "healthy" });
  });

  it("has no clock for providers whose token lifetime is unknown", () => {
    expect(
      cliproxyLogin(
        { provider: "codex", status: "active", last_refresh: "2026-10-01T00:00:00Z" },
        refreshed,
      ),
    ).toEqual({ status: "healthy" });
  });
});
