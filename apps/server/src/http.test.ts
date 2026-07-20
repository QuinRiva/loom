import { describe, expect, it } from "vite-plus/test";

import { assetCacheControl, isLoopbackHostname, resolveDevRedirectUrl } from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("asset cache control", () => {
  it("forces revalidation for mutable workspace-backed assets", () => {
    // Guarantees an artefact-viewer reload refetches changed subresources
    // instead of serving a stale cached copy.
    expect(assetCacheControl(true)).toBe("private, no-cache");
  });

  it("keeps a long cache for immutable content-addressed assets", () => {
    expect(assetCacheControl(false)).toBe("private, max-age=3600");
  });
});
