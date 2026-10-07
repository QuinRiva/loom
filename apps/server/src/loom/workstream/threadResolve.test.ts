import type { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUnambiguousMatch,
  rankThreadsByName,
  type ThreadNameCandidate,
} from "./threadResolve.ts";

const candidate = (
  id: string,
  title: string,
  extra: Partial<ThreadNameCandidate> = {},
): ThreadNameCandidate => ({
  id: id as ThreadId,
  title,
  updatedAt: "2026-06-26T00:00:00.000Z",
  ...extra,
});

describe("rankThreadsByName", () => {
  it("ranks exact > prefix > word-prefix > substring > subsequence and drops non-matches", () => {
    const threads = [
      candidate("sub", "the liveness detection harness"), // substring
      candidate("exact", "liveness detection"), // exact
      candidate("none", "completely unrelated"), // no match
      candidate("prefix", "liveness detection loop fixer"), // prefix
      candidate("seq", "lonely vines etch"), // subsequence of "liveness"-ish
    ];
    const ranked = rankThreadsByName("liveness detection", threads);
    expect(ranked.map((r) => r.thread.id)).toEqual(["exact", "prefix", "sub"]);
    expect(ranked.some((r) => r.thread.id === "none")).toBe(false);
  });

  it("is case-insensitive and trims the query", () => {
    const ranked = rankThreadsByName("  LiVeNeSs  ", [candidate("a", "Liveness Detection")]);
    expect(ranked[0]?.thread.id).toBe("a");
  });

  it("breaks score ties toward the shorter (tighter) title", () => {
    const ranked = rankThreadsByName("auth", [
      candidate("long", "auth token refresh and rotation pipeline"),
      candidate("short", "auth bug"),
    ]);
    // Both are word-prefix matches; the shorter title wins the tie.
    expect(ranked[0]?.thread.id).toBe("short");
  });

  it("returns nothing for an empty query", () => {
    expect(rankThreadsByName("   ", [candidate("a", "anything")])).toEqual([]);
  });
});

describe("isUnambiguousMatch", () => {
  it("auto-runs a single clear match", () => {
    expect(isUnambiguousMatch(rankThreadsByName("liveness", [candidate("a", "liveness")]))).toBe(
      true,
    );
  });

  it("refuses to auto-run when two threads share the matched title", () => {
    const ranked = rankThreadsByName("liveness detection", [
      candidate("a", "liveness detection"),
      candidate("b", "liveness detection"),
    ]);
    expect(isUnambiguousMatch(ranked)).toBe(false);
  });

  it("refuses when the top match is only a weak (subsequence) hit", () => {
    const ranked = rankThreadsByName("abc", [candidate("a", "a big cat")]);
    expect(isUnambiguousMatch(ranked)).toBe(false);
  });
});
