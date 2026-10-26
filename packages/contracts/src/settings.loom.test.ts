import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings.ts";

const decode = Schema.decodeUnknownSync(ServerSettings);

describe("providerFailover (3c-2: one fallbackTarget, the chain editor gone)", () => {
  it("defaults to enabled with no fallback", () => {
    expect(decode({}).providerFailover).toEqual({ enabled: true, fallbackTarget: null });
    expect(decode({ providerFailover: {} }).providerFailover).toEqual({
      enabled: true,
      fallbackTarget: null,
    });
  });

  it("patches enabled and fallbackTarget only", () => {
    const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
    expect(
      decodePatch({ providerFailover: { fallbackTarget: "cliproxy/claude-opus-5-5" } })
        .providerFailover,
    ).toEqual({ fallbackTarget: "cliproxy/claude-opus-5-5" });
  });
});
