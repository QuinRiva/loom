import {
  EnvironmentId,
  ProviderDriverKind,
  type UsageLimitSourceLogin,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { loginAlerts, reloginText } from "./usageLimits.ts";

const now = Date.parse("2026-10-21T10:00:00+11:00");
const relogin = (overrides: Partial<NonNullable<UsageLimitSourceLogin["relogin"]>> = {}) => ({
  status: "healthy" as const,
  relogin: {
    phase: "due" as const,
    kind: "login" as const,
    // Noon UTC: Sun 15 Nov in every time zone the suite runs in.
    mayExpireAt: "2026-11-15T12:00:00.000Z",
    dueBy: "2026-10-30",
    early: true,
    leadWeekdays: 1,
    ...overrides,
  },
});

describe("reloginText", () => {
  it("names the day, says why it is early, and when the login could die", () => {
    expect(reloginText(relogin(), "caaarl@", now)).toBe(
      "Re-log caaarl@ by Fri 30 Oct (early, to keep the accounts spread out). It could expire from Sun 15 Nov.",
    );
    expect(reloginText(relogin({ early: false }), "carl@", now)).toBe(
      "Re-log carl@ by Fri 30 Oct. It could expire from Sun 15 Nov.",
    );
  });

  it("asks the owner of an account someone else logs in", () => {
    expect(reloginText(relogin({ leadWeekdays: 3, dueBy: "2026-10-26" }), "jacob@", now)).toMatch(
      /^Ask Jacob to re-log jacob@ by Mon 26 Oct/,
    );
    expect(reloginText(relogin({ leadWeekdays: 3, phase: "overdue" }), "jacob@", now)).toBe(
      "Ask Jacob to re-log jacob@ now; it is overdue. It could expire from Sun 15 Nov.",
    );
  });

  it("covers overdue, no date on record, a one-year token, and nothing yet", () => {
    expect(reloginText(relogin({ phase: "overdue" }), "carl3@", now)).toBe(
      "carl3@ is overdue; re-log it now. It could expire from Sun 15 Nov.",
    );
    const { mayExpireAt: _none, ...undated } = relogin().relogin;
    expect(reloginText({ status: "healthy", relogin: undated }, "carl5@", now)).toBe(
      "carl5@: no login date on record. Log in to start its clock.",
    );
    expect(
      reloginText(
        relogin({ kind: "token", dueBy: "2027-10-18", mayExpireAt: "2027-10-19T04:53:07.000Z" }),
        "carl4@",
        now,
      ),
    ).toMatch(
      /^Re-mint carl4@'s one-year token by Mon 18 Oct 2027: claude setup-token, then ~\/cli-proxy\/account add-token carl4@\. /,
    );
    expect(reloginText(relogin({ phase: "later" }), "carl@", now)).toBeNull();
  });
});

describe("loginAlerts", () => {
  const account = (email: string, login: UsageLimitSourceLogin) => ({
    id: `claude-a42236a2-${email}.json`,
    email,
    driver: ProviderDriverKind.make("claudeAgent"),
    usageLimits: { checkedAt: "2026-10-21T00:00:00.000Z", windows: [] },
    login,
  });
  const presentations = new Map([
    [
      EnvironmentId.make("env"),
      {
        entry: { target: { label: "Cockpit" } },
        serverConfig: {
          providers: [], // loom: required since pull 12
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("hub"),
              kind: "cliproxy" as const,
              label: "CLI Proxy",
              checkedAt: "2026-10-21T00:00:00.000Z",
              accounts: [
                account("caaarl@unseen.id", relogin()),
                account("carl@unseen.id", relogin({ phase: "later" })),
                account("carl4@unseen.id", {
                  ...relogin({ phase: "later" }),
                  status: "dead",
                  reason: "token expired",
                }),
              ],
            },
          ],
        },
      },
    ],
  ]);

  it("lists only accounts that need the user, the dead before the due, with where to log in", () => {
    expect(
      loginAlerts(presentations, now).map(({ email, attention, sourceId }) => ({
        email,
        attention,
        sourceId,
      })),
    ).toEqual([
      { email: "carl4@unseen.id", attention: "dead", sourceId: "hub" },
      { email: "caaarl@unseen.id", attention: "due", sourceId: "hub" },
    ]);
  });
});
