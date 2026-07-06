import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationThreadShell, ProjectId, ThreadId } from "@t3tools/contracts";

import type { GitWorktreeListEntry } from "../vcs/GitVcsDriver.ts";
import {
  classifyWorktree,
  resolveWorktreeOwnership,
  type WorktreeGitFacts,
} from "./worktreeClassification.ts";

const projectId = "p1" as ProjectId;
const projects = [{ id: projectId, workspaceRoot: "/repo" }];

const NOW = Date.parse("2026-07-05T12:00:00.000Z");
// 7 h before NOW — comfortably past the 6 h reap threshold.
const OLD = "2026-07-05T05:00:00.000Z";
const FRESH = "2026-07-05T11:59:00.000Z";

const thread = (
  over: Omit<Partial<OrchestrationThreadShell>, "id"> & { id: string },
): OrchestrationThreadShell =>
  ({
    projectId,
    parentThreadId: null,
    isolation: "isolated",
    fanInState: "completed",
    planLane: "done",
    branch: null,
    worktreePath: null,
    title: "t",
    updatedAt: OLD,
    ...over,
  }) as unknown as OrchestrationThreadShell;

const entry = (over: Partial<GitWorktreeListEntry> = {}): GitWorktreeListEntry => ({
  path: "/wt/child",
  branch: "ws/main/coder-11111111",
  head: "abc",
  isMain: false,
  locked: false,
  prunable: false,
  ...over,
});

// Canonical provably-dead setup: terminal isolated child (id prefix matches the
// branch suffix), fan-in settled, clean, merged, older than the threshold.
const deadOwner = thread({
  id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
  parentThreadId: "parent" as ThreadId,
  worktreePath: "/wt/child",
});
const parent = thread({
  id: "parent",
  planLane: "in_progress",
  branch: "main",
  worktreePath: "/repo",
  isolation: "shared",
});
const cleanFacts: WorktreeGitFacts = { dirty: false, mergedIntoParentBranch: true };

const classify = (over: {
  entry?: Partial<GitWorktreeListEntry>;
  threads?: ReadonlyArray<OrchestrationThreadShell>;
  facts?: Partial<WorktreeGitFacts>;
}) =>
  classifyWorktree({
    entry: entry(over.entry ?? {}),
    projectId,
    threads: over.threads ?? [deadOwner, parent],
    projects,
    facts: { ...cleanFacts, ...over.facts },
    nowMs: NOW,
  });

describe("worktreeClassification", () => {
  it("classifies the provably-dead worktree as reapable", () => {
    const c = classify({});
    expect(c.disposition).toBe("reapable");
    expect(c.threadId).toBe(deadOwner.id);
    expect(c.parentBranch).toBe("main");
  });

  it("never reaps the main worktree", () => {
    expect(classify({ entry: { isMain: true, path: "/repo", branch: "main" } }).disposition).toBe(
      "active",
    );
  });

  it("a live owning thread makes the worktree active", () => {
    const live = thread({ ...deadOwner, planLane: "in_progress" } as never);
    expect(classify({ threads: [live, parent] }).disposition).toBe("active");
  });

  it("a live resident (occupancy) makes the worktree active even with a dead owner", () => {
    const resident = thread({
      id: "resident",
      planLane: "in_progress",
      isolation: "attached",
      worktreePath: "/wt/child",
    });
    expect(classify({ threads: [deadOwner, parent, resident] }).disposition).toBe("active");
  });

  it("no owning thread → stale orphaned", () => {
    const c = classify({ threads: [parent] });
    expect(c).toMatchObject({ disposition: "stale", staleReason: "orphaned", threadId: null });
  });

  it("cancelled owner → stale cancelled (branch kept for recovery)", () => {
    const cancelled = thread({ ...deadOwner, planLane: "cancelled" } as never);
    expect(classify({ threads: [cancelled, parent] }).staleReason).toBe("cancelled");
  });

  it("conflicted fan-in → stale conflicted", () => {
    const conflicted = thread({ ...deadOwner, fanInState: "conflicted" } as never);
    expect(classify({ threads: [conflicted, parent] }).staleReason).toBe("conflicted");
  });

  it("unsettled fan-in → stale fanin-pending (the reactor's job, not GC's)", () => {
    const pending = thread({ ...deadOwner, fanInState: "none" } as never);
    expect(classify({ threads: [pending, parent] }).staleReason).toBe("fanin-pending");
  });

  it("dirty (or unknown-dirty) tree → stale dirty", () => {
    expect(classify({ facts: { dirty: true } }).staleReason).toBe("dirty");
    expect(classify({ facts: { dirty: null } }).staleReason).toBe("dirty");
  });

  it("unmerged (or unknown-merge) branch → stale unmerged", () => {
    expect(classify({ facts: { mergedIntoParentBranch: false } }).staleReason).toBe("unmerged");
    expect(classify({ facts: { mergedIntoParentBranch: null } }).staleReason).toBe("unmerged");
  });

  it("younger than the age threshold → stale recently-finished", () => {
    const fresh = thread({ ...deadOwner, updatedAt: FRESH } as never);
    expect(classify({ threads: [fresh, parent] }).staleReason).toBe("recently-finished");
  });

  it("terminal non-workstream worktree → stale unmanaged", () => {
    const rootLike = thread({
      id: "root",
      worktreePath: "/wt/other",
      isolation: "shared",
      branch: "t3code-something",
    });
    const c = classify({
      entry: { path: "/wt/other", branch: "t3code-something" },
      threads: [rootLike, parent],
    });
    expect(c.staleReason).toBe("unmanaged");
  });

  it("recovers ownership via the ws/ branch suffix after meta was repointed", () => {
    const repointed = thread({
      ...deadOwner,
      worktreePath: "/repo", // fan-in already repointed the meta to the parent tree
    } as never);
    const { owner } = resolveWorktreeOwnership(entry(), [repointed, parent]);
    expect(owner?.id).toBe(deadOwner.id);
    expect(classify({ threads: [repointed, parent] }).disposition).toBe("reapable");
  });
});
