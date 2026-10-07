import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ServerSettings);
const encode = Schema.encodeSync(ServerSettings);

describe("providerFailover (3c-2: one fallbackTarget, the chain editor gone)", () => {
  it("defaults to enabled with no fallback", () => {
    expect(decode({}).providerFailover).toEqual({ enabled: true, fallbackTarget: null });
    expect(decode({ providerFailover: {} }).providerFailover).toEqual({
      enabled: true,
      fallbackTarget: null,
    });
  });

  it("folds a stored V1 chains map into its first concrete cross-vendor target", () => {
    // The live cockpit settings.json at the time of pull 9, verbatim.
    const stored = {
      providerFailover: {
        resumeOnReset: false,
        pausedAccounts: ["claudeAgent"],
        chains: {
          "openai-codex/*": ["cliproxy/claude-opus-5-5"],
          "anthropic/*": ["cliproxy"],
          "google-vertex-claude/*": ["cliproxy"],
          "cliproxy/*": [],
          "openai-codex/gpt-6-luna": ["cliproxy/claude-sonnet-5-5"],
          "cliproxy/claude-fable-5-1": [],
        },
      },
    };
    const settings = decode(stored);
    expect(settings.providerFailover).toEqual({
      enabled: true,
      fallbackTarget: "cliproxy/claude-opus-5-5",
    });
    // Written back, only the new shape survives.
    expect(encode(settings).providerFailover).toEqual({
      enabled: true,
      fallbackTarget: "cliproxy/claude-opus-5-5",
    });
  });

  it("skips entries a setting cannot resolve without a model id, and same-vendor entries", () => {
    expect(
      decode({
        providerFailover: {
          enabled: false,
          chains: {
            "anthropic/*": ["google-vertex-claude", "anthropic/claude-opus-4-8", "openai/<m>"],
            "openai-codex/*": ["google-vertex-claude/*", "anthropic/claude-opus-4-8"],
          },
        },
      }).providerFailover,
    ).toEqual({ enabled: false, fallbackTarget: "anthropic/claude-opus-4-8" });
    expect(decode({ providerFailover: { chains: {} } }).providerFailover.fallbackTarget).toBeNull();
    expect(
      decode({ providerFailover: { chains: { "anthropic/*": ["google-vertex-claude"] } } })
        .providerFailover.fallbackTarget,
    ).toBeNull();
  });

  it("an explicit fallbackTarget wins over stored chains", () => {
    expect(
      decode({
        providerFailover: {
          fallbackTarget: null,
          chains: { "openai-codex/*": ["cliproxy/claude-opus-5-5"] },
        },
      }).providerFailover.fallbackTarget,
    ).toBeNull();
  });

  it("patches enabled and fallbackTarget only", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(
      decodePatch({ providerFailover: { fallbackTarget: "cliproxy/claude-opus-5-5" } })
        .providerFailover,
    ).toEqual({ fallbackTarget: "cliproxy/claude-opus-5-5" });
  });
});
