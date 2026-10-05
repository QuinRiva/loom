// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { ProjectId, ThreadId, ThreadPlanLane } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUnambiguousMatch,
  rankThreadsByName,
  resolveSessionFilePath,
  type ThreadNameCandidate,
} from "./threadResolve.ts";

const candidate = (
  id: string,
  title: string,
  extra: Partial<ThreadNameCandidate> = {},
): ThreadNameCandidate => ({
  id: id as ThreadId,
  title,
  role: "coder",
  planLane: "in_progress" as ThreadPlanLane,
  projectId: "proj" as ProjectId,
  worktreePath: null,
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

describe("resolveSessionFilePath (cross-worktree)", () => {
  // The sharp edge: the target session lives under a DIFFERENT project-slug dir
  // than the caller. Resolving the id-suffixed filename to an absolute path must
  // find it regardless of slug, sidestepping pi's id-scoping trap.
  it("finds a session file by id under any project-slug dir", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sessions-root-"));
    const sessionId = "207f5c53-4700-4751-a475-d0c7c9062db1";
    const callerSlug = NodePath.join(root, "--home-caller--");
    const otherSlug = NodePath.join(root, "--home-some-other-worktree--");
    NodeFS.mkdirSync(callerSlug, { recursive: true });
    NodeFS.mkdirSync(otherSlug, { recursive: true });
    // Decoys that must NOT match.
    NodeFS.writeFileSync(
      NodePath.join(callerSlug, `2026-06-26T00-00-00-000Z_other-id.jsonl`),
      "{}",
    );
    NodeFS.writeFileSync(NodePath.join(otherSlug, `not-a-session.txt`), "x");
    const target = NodePath.join(otherSlug, `2026-06-26T03-54-09-026Z_${sessionId}.jsonl`);
    NodeFS.writeFileSync(target, "{}");

    expect(resolveSessionFilePath(sessionId, root)).toBe(target);
  });

  it("returns the newest match when an id appears in multiple slugs", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sessions-root-"));
    const sessionId = "dup-id-1234";
    const slugA = NodePath.join(root, "--a--");
    const slugB = NodePath.join(root, "--b--");
    NodeFS.mkdirSync(slugA, { recursive: true });
    NodeFS.mkdirSync(slugB, { recursive: true });
    const older = NodePath.join(slugA, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`);
    const newer = NodePath.join(slugB, `2026-06-26T00-00-00-000Z_${sessionId}.jsonl`);
    NodeFS.writeFileSync(older, "{}");
    NodeFS.writeFileSync(newer, "{}");
    NodeFS.utimesSync(older, new Date("2026-01-01"), new Date("2026-01-01"));
    NodeFS.utimesSync(newer, new Date("2026-06-26"), new Date("2026-06-26"));

    expect(resolveSessionFilePath(sessionId, root)).toBe(newer);
  });

  it("returns undefined when no session file matches (caller falls back to bare id)", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sessions-root-"));
    NodeFS.mkdirSync(NodePath.join(root, "--a--"), { recursive: true });
    expect(resolveSessionFilePath("missing-id", root)).toBeUndefined();
    expect(
      resolveSessionFilePath("missing-id", NodePath.join(root, "does-not-exist")),
    ).toBeUndefined();
  });
});
