import { EnvironmentId, ProviderDriverKind, UsageLimitSourceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { unlinkedUsageSourceNotices, usageSourceAccounts } from "./usageLimits.ts";

const hub = (id: string, email?: string) => ({ id, ...(email ? { email } : {}) });
const accounts = [
  hub("claude-a42236a2-carl@unseen.id.json", "carl@unseen.id"),
  hub("claude-a42236a2-caaarl@unseen.id.json", "caaarl@unseen.id"),
  hub("claude-a42236a2-x-carl@unseen.id.json", "x-carl@unseen.id"),
  hub("codex-nomail.json"),
];

describe("usageSourceAccounts", () => {
  it("follows an auth file cliproxy renamed on re-login, by its email", () => {
    expect(usageSourceAccounts("~/cli-proxy/auths/claude-carl@unseen.id.json", accounts)).toEqual([
      accounts[0],
    ]);
    // and again, should a later login hash it differently
    expect(
      usageSourceAccounts("~/cli-proxy/auths/claude-0badf00d-caaarl@unseen.id.json", accounts),
    ).toEqual([accounts[1]]);
  });

  it("prefers the account whose file it is, then the longest email", () => {
    expect(usageSourceAccounts("/a/codex-nomail.json", accounts)).toEqual([accounts[3]]);
    expect(usageSourceAccounts("/a/claude-x-carl@unseen.id.json", accounts)).toEqual([accounts[2]]);
  });

  it("matches nothing for an account the hub does not pool", () => {
    expect(usageSourceAccounts("/a/claude-carl3@unseen.id.json", accounts)).toEqual([]);
    expect(usageSourceAccounts("/a/claude-arl@unseen.id.json", accounts)).toEqual([]);
  });
});

describe("unlinkedUsageSourceNotices", () => {
  const presentations = (error?: string) =>
    new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Cockpit" } },
          serverConfig: {
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "CLI Proxy",
                checkedAt: "2026-10-19T03:00:00.000Z",
                accounts: [
                  {
                    id: "claude-a42236a2-carl@unseen.id.json",
                    email: "carl@unseen.id",
                    driver: ProviderDriverKind.make("claudeAgent"),
                    usageLimits: { checkedAt: "2026-10-19T03:00:00.000Z", windows: [] },
                  },
                ],
                ...(error ? { error } : {}),
              },
            ],
            settings: {
              providerInstances: {
                pi: {
                  driver: ProviderDriverKind.make("pi"),
                  usageSources: [
                    {
                      kind: "anthropic-oauth" as const,
                      tokenFile: "~/a/claude-carl@unseen.id.json",
                    },
                    {
                      kind: "anthropic-oauth" as const,
                      tokenFile: "~/a/claude-gone@unseen.id.json",
                      label: "gone@",
                    },
                  ],
                },
              },
            },
          },
        },
      ],
    ]);

  it("names each source no hub account matches", () => {
    expect(unlinkedUsageSourceNotices(presentations())).toEqual([
      "gone@: usage source ~/a/claude-gone@unseen.id.json matches no account the hub pools, so failover cannot see this account.",
    ]);
  });

  it("stays quiet while a hub read failed", () => {
    expect(unlinkedUsageSourceNotices(presentations("The hub could not list accounts."))).toEqual(
      [],
    );
  });
});
