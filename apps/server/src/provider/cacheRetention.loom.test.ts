import { describe, expect, it } from "vite-plus/test";

import { cacheRetentionForThread } from "./cacheRetention.loom.ts";

// A silent failure here costs a week of A/B data, so pin the arm function to the
// readout's recomputation: python3 -c "import hashlib; print(hashlib.sha256(b'<id>').digest()[0])"
describe("cacheRetentionForThread", () => {
  const BYTE = {
    0: "thread-522",
    127: "thread-15",
    128: "thread-208",
    204: "thread-173",
    205: "thread-411",
    255: "thread-619",
  } as const;
  const arms = (share: number) =>
    Object.fromEntries(
      Object.entries(BYTE).map(([byte, id]) => [byte, cacheRetentionForThread(id, true, share)]),
    );

  it("puts no root on the 1-hour cache at share 0", () => {
    expect(new Set(Object.values(arms(0)))).toEqual(new Set(["short"]));
  });

  it("splits at byte 128 at share 0.5, as the 50/50 A/B did", () => {
    expect(arms(0.5)).toEqual({
      0: "long",
      127: "long",
      128: "short",
      204: "short",
      205: "short",
      255: "short",
    });
  });

  it("splits below 256 × share otherwise (0.8 → bytes 0..204)", () => {
    expect(arms(0.8)).toMatchObject({ 128: "long", 204: "long", 205: "short", 255: "short" });
  });

  it("puts every root on the 1-hour cache at share 1", () => {
    expect(new Set(Object.values(arms(1)))).toEqual(new Set(["long"]));
  });

  it("allocates about the share", () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `thread-${i}`);
    const long = ids.filter((id) => cacheRetentionForThread(id, true, 0.8) === "long").length;
    expect(long / ids.length).toBeGreaterThan(0.77);
    expect(long / ids.length).toBeLessThan(0.83);
  });

  it("keeps every child short at every share", () => {
    for (const share of [0, 0.5, 1]) {
      expect(cacheRetentionForThread(BYTE[0], false, share)).toBe("short");
    }
  });
});
