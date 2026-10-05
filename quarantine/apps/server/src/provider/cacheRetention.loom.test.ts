import { describe, expect, it } from "vite-plus/test";

import { cacheRetentionForThread, hashedCacheRetention } from "./cacheRetention.loom.ts";

// A silent failure here costs a week of A/B data, so pin the arm function.
describe("cacheRetentionForThread", () => {
  const ROOT_LONG = "aa5a71ee-6d0d-4478-bcaa-e3395dc97b31";
  const ROOT_SHORT = "00000000-0000-4000-8000-000000000000";

  it("pins the hash to the Python recomputation the readout uses", () => {
    // python3 -c "import hashlib; print(hashlib.sha256(b'<id>').digest()[0] < 128)"
    expect(hashedCacheRetention(ROOT_LONG)).toBe("long");
    expect(hashedCacheRetention(ROOT_SHORT)).toBe("short");
  });

  it("splits roots about 50/50", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `thread-${i}`);
    const long = ids.filter((id) => hashedCacheRetention(id) === "long").length;
    expect(long / ids.length).toBeGreaterThan(0.45);
    expect(long / ids.length).toBeLessThan(0.55);
  });

  it("assigns roots by mode", () => {
    expect(cacheRetentionForThread(ROOT_LONG, true, "ab")).toBe("long");
    expect(cacheRetentionForThread(ROOT_SHORT, true, "ab")).toBe("short");
    expect(cacheRetentionForThread(ROOT_SHORT, true, "long")).toBe("long");
    expect(cacheRetentionForThread(ROOT_LONG, true, "short")).toBe("short");
  });

  it("keeps every child short in every mode", () => {
    for (const mode of ["ab", "long", "short"] as const) {
      expect(cacheRetentionForThread(ROOT_LONG, false, mode)).toBe("short");
    }
  });
});
