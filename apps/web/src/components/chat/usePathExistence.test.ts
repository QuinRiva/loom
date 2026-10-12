import type { EnvironmentId, FilesystemEntryMetadata } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  __setMetadataFetcherForTests,
  readPathExistence,
  registerPathInterest,
} from "./usePathExistence";

const ENV = "env-1" as EnvironmentId;

const FILE = { kind: "file" } as const;

function mockFetcher(metadata: Record<string, FilesystemEntryMetadata | null>) {
  const calls: string[][] = [];
  const fetcher = (_environmentId: EnvironmentId, paths: string[]) => {
    calls.push([...paths]);
    return Promise.resolve(new Map(paths.map((path) => [path, metadata[path] ?? null])));
  };
  return { calls, fetcher };
}

describe("usePathExistence store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    __setMetadataFetcherForTests(null);
    vi.useRealTimers();
  });

  it("maps server metadata so only files and directories are clickable", async () => {
    const { fetcher } = mockFetcher({
      "/w/file.md": FILE,
      "/w/dir": { kind: "directory" },
      "/w/fifo": { kind: "other" },
      "/w/gone": null,
    });
    __setMetadataFetcherForTests(fetcher);

    const off = registerPathInterest(ENV, ["/w/file.md", "/w/dir", "/w/fifo", "/w/gone"]);
    await vi.advanceTimersByTimeAsync(100);

    expect(readPathExistence(ENV, "/w/file.md")).toEqual({ exists: true, isDirectory: false });
    expect(readPathExistence(ENV, "/w/dir")).toEqual({ exists: true, isDirectory: true });
    // `other` (FIFO/socket/device) and null (missing/unreadable) must be inert.
    expect(readPathExistence(ENV, "/w/fifo")).toEqual({ exists: false, isDirectory: false });
    expect(readPathExistence(ENV, "/w/gone")).toEqual({ exists: false, isDirectory: false });
    off();
  });

  it("coalesces overlapping consumers of the same key into a single fetch", async () => {
    const { calls, fetcher } = mockFetcher({ "/w/a.md": FILE });
    __setMetadataFetcherForTests(fetcher);

    // Two independent consumers register the same uncached path before the flush.
    const off1 = registerPathInterest(ENV, ["/w/a.md"]);
    const off2 = registerPathInterest(ENV, ["/w/a.md"]);
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(["/w/a.md"]);
    expect(readPathExistence(ENV, "/w/a.md")).toEqual({ exists: true, isDirectory: false });
    off1();
    off2();
  });

  it("batches distinct paths registered within the coalescing window", async () => {
    const { calls, fetcher } = mockFetcher({ "/w/a.md": FILE, "/w/b.md": FILE });
    __setMetadataFetcherForTests(fetcher);

    const off1 = registerPathInterest(ENV, ["/w/a.md"]);
    const off2 = registerPathInterest(ENV, ["/w/b.md"]);
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.toSorted()).toEqual(["/w/a.md", "/w/b.md"]);
    off1();
    off2();
  });

  it("revalidates a mounted path after the TTL with no imperative re-request", async () => {
    const { calls, fetcher } = mockFetcher({ "/w/a.md": FILE });
    __setMetadataFetcherForTests(fetcher);

    // A single registration that stays mounted — no further calls into the store.
    const off = registerPathInterest(ENV, ["/w/a.md"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);

    // Within the TTL (30s): no background refresh.
    await vi.advanceTimersByTimeAsync(29_000);
    expect(calls).toHaveLength(1);

    // Crossing the TTL triggers the scheduler to re-verify on its own.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls).toHaveLength(2);

    // After unmount, revalidation stops.
    off();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(calls).toHaveLength(2);
  });

  it("keeps request volume bounded under persistent failure (backoff, no storm)", async () => {
    const calls: number[] = [];
    // Always-failing fetcher (empty result === no path resolved).
    __setMetadataFetcherForTests((_env, paths) => {
      calls.push(paths.length);
      return Promise.resolve(new Map());
    });

    const off = registerPathInterest(ENV, ["/w/a.md"]);
    await vi.advanceTimersByTimeAsync(20_000);

    // With ~1s,2s,4s,8s,16s backoff a hot 80ms loop (≈250 calls / 20s) is
    // replaced by a handful of attempts.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(readPathExistence(ENV, "/w/a.md")).toBeUndefined();
    off();
  });

  it("recovers after a transient failure once backoff elapses, without a re-request", async () => {
    let shouldFail = true;
    const calls: string[][] = [];
    __setMetadataFetcherForTests((_env, paths) => {
      calls.push([...paths]);
      if (shouldFail) return Promise.resolve(new Map());
      return Promise.resolve(new Map(paths.map((path) => [path, FILE])));
    });

    const off = registerPathInterest(ENV, ["/w/a.md"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toHaveLength(1);
    expect(readPathExistence(ENV, "/w/a.md")).toBeUndefined();

    shouldFail = false;
    // The scheduled backoff retry fires on its own and now succeeds.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(readPathExistence(ENV, "/w/a.md")).toEqual({ exists: true, isDirectory: false });
    off();
  });
});
