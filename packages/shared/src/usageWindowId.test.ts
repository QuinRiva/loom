import { describe, expect, it } from "vite-plus/test";

import { decodeUsageWindowId, encodeUsageWindowId } from "./usageWindowId.ts";

describe("usage window ids", () => {
  it("keeps pooled accounts of one instance apart and round-trips every part", () => {
    const pooled = [
      { accountKey: "pi", accountLabel: "carl@", kind: "primary" as const },
      { accountKey: "pi", accountLabel: "jacob@", kind: "primary" as const },
      { accountKey: "pi", accountLabel: "jacob@", kind: "secondary" as const, scope: "Opus" },
      { accountKey: "codex", kind: "secondary" as const },
    ];
    const ids = pooled.map(encodeUsageWindowId);
    expect(new Set(ids).size).toBe(pooled.length);
    expect(ids.map(decodeUsageWindowId)).toEqual(pooled);
  });

  it("does not turn an adapter-native window into an account row", () => {
    expect(decodeUsageWindowId("five_hour")).toBeNull();
    expect(decodeUsageWindowId("primary")).toBeNull();
    expect(decodeUsageWindowId(":carl@:primary")).toBeNull();
  });
});
