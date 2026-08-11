// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import type { OrchestrationThreadLeanShell, ProjectId, ThreadId } from "@t3tools/contracts";

import type { GitWorktreeListEntry } from "../vcs/GitVcsDriver.ts";
import { resolveThreadWorkspaceCwd } from "../checkpointing/Utils.ts";

/**
 * Worktree classification (phase 3) — the shared brain for the conservative
 * auto-reaper and the (separately planned) stale-worktrees visibility surface.
 * Given one `git worktree list` entry plus projection data and per-worktree git
 * facts, it decides exactly one disposition:
 *
 * - `reapable`: provably dead — safe for the reaper to remove automatically.
 *   ALL of: owning thread terminal (`done`), fan-in settled (`completed`),
 *   branch fully merged into the parent branch, working tree clean, and older
 *   than {@link WORKTREE_REAP_AGE_MS}.
 * - `active`: the main worktree, or a live thread works here — never touch.
 * - `stale`: everything else, with a reason. Stale worktrees are valid work a
 *   human is not currently focused on (Carl's design rule: NEVER auto-delete
 *   merely-stale worktrees); the visibility surface lists them for
 *   human-confirmed removal.
 */

/**
 * Minimum age (since the owning thread's last update) before a provably-dead
 * worktree is auto-reaped. Hours-scale on purpose: the merge already preserves
 * the work, so the threshold only guards against reaping under a human who is
 * poking at a freshly finished child's tree.
 */
export const WORKTREE_REAP_AGE_MS = 6 * 60 * 60 * 1000;

export type WorktreeDisposition = "active" | "reapable" | "stale";

export type WorktreeStaleReason =
  /** No live thread owns this worktree (crash orphan or deleted thread). */
  | "orphaned"
  /** Owned by a terminal thread that is not a workstream-managed (`ws/`) isolated child. */
  | "unmanaged"
  /** Cancelled child — its `wip: cancelled` branch is kept for recovery. */
  | "cancelled"
  /** Fan-in merge conflicted — needs human resolution in this worktree. */
  | "conflicted"
  /** Fan-in gave up after an unexpected error — terminal, needs a human. */
  | "fanin-failed"
  /** Done but fan-in not settled yet — the fan-in reactor's job, not GC's. */
  | "fanin-pending"
  /** Uncommitted changes (or dirty state unknown) — not provably dead. */
  | "dirty"
  /** Branch not provably contained in the parent branch (or unknown). */
  | "unmerged"
  /** Provably dead but younger than the reap age threshold. */
  | "recently-finished";

export interface WorktreeGitFacts {
  /** `git status --porcelain` non-empty; null when the check failed/was skipped. */
  readonly dirty: boolean | null;
  /** `merge-base --is-ancestor <branch> <parentBranch>`; null when unknowable. */
  readonly mergedIntoParentBranch: boolean | null;
}

export interface ClassifiedWorktree {
  readonly projectId: ProjectId;
  readonly path: string;
  readonly branch: string | null;
  readonly isMain: boolean;
  /** Owning thread (meta path match, else `ws/…-<id8>` branch-suffix match). */
  readonly threadId: ThreadId | null;
  readonly threadTitle: string | null;
  readonly planLane: string | null;
  readonly fanInState: string | null;
  readonly parentBranch: string | null;
  /**
   * Resolved cwd of the owner's parent thread (its worktree, else the project
   * root). Reap git ops must run here: `git branch -d` judges merged-ness
   * against the checked-out HEAD, which is the parent branch in the parent's
   * worktree — not the project root's branch.
   */
  readonly parentCwd: string | null;
  readonly dirty: boolean | null;
  readonly mergedIntoParentBranch: boolean | null;
  /** ms since the owning thread's `updatedAt`; null when there is no owner. */
  readonly ageMs: number | null;
  readonly disposition: WorktreeDisposition;
  readonly staleReason: WorktreeStaleReason | null;
}

export interface WorktreeOwnership {
  readonly owner: OrchestrationThreadLeanShell | undefined;
  readonly parent: OrchestrationThreadLeanShell | undefined;
}

const isTerminal = (planLane: string): boolean => planLane === "done" || planLane === "cancelled";

/**
 * Resolve the thread that owns a worktree. Meta (`worktreePath`) match wins,
 * preferring an isolated thread over attached residents; a fanned-in child
 * whose meta was already repointed to the parent is recovered via the
 * `ws/…-<first8(threadId)>` branch-suffix convention (see
 * `workstreamChildBranchName` in WorktreeProvisioner).
 */
export const resolveWorktreeOwnership = (
  entry: GitWorktreeListEntry,
  threads: ReadonlyArray<OrchestrationThreadLeanShell>,
): WorktreeOwnership => {
  const resolvedPath = NodePath.resolve(entry.path);
  const byPath = threads.filter(
    (t) => t.worktreePath !== null && NodePath.resolve(t.worktreePath) === resolvedPath,
  );
  const owner =
    byPath.find((t) => t.isolation === "isolated") ??
    (entry.branch !== null && entry.branch.startsWith("ws/")
      ? threads.find((t) => entry.branch!.endsWith(`-${t.id.slice(0, 8)}`))
      : undefined) ??
    byPath[0];
  const parent =
    owner?.parentThreadId != null ? threads.find((t) => t.id === owner.parentThreadId) : undefined;
  return { owner, parent };
};

export interface ClassifyWorktreeInput {
  readonly entry: GitWorktreeListEntry;
  readonly projectId: ProjectId;
  readonly threads: ReadonlyArray<OrchestrationThreadLeanShell>;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
  readonly facts: WorktreeGitFacts;
  readonly nowMs: number;
  readonly reapAgeMs?: number;
  /**
   * Resolved workspace paths a live process currently holds, from
   * `WorkspaceLease`. Advisory: it makes the chip honest about why a tree
   * survives, but it is a snapshot and can go stale immediately — the lease
   * taken at removal time is what actually protects the worktree.
   */
  readonly occupiedPaths?: ReadonlySet<string>;
}

export const classifyWorktree = (input: ClassifyWorktreeInput): ClassifiedWorktree => {
  const { entry, threads, projects, facts, nowMs } = input;
  const reapAgeMs = input.reapAgeMs ?? WORKTREE_REAP_AGE_MS;
  const { owner, parent } = resolveWorktreeOwnership(entry, threads);
  const ageMs =
    owner === undefined ? null : Math.max(0, nowMs - (Date.parse(owner.updatedAt) || nowMs));

  const base = {
    projectId: input.projectId,
    path: entry.path,
    branch: entry.branch,
    isMain: entry.isMain,
    threadId: owner?.id ?? null,
    threadTitle: owner?.title ?? null,
    planLane: owner?.planLane ?? null,
    fanInState: owner?.fanInState ?? null,
    parentBranch: parent?.branch ?? null,
    parentCwd:
      parent === undefined
        ? null
        : (resolveThreadWorkspaceCwd({ thread: parent, projects }) ?? null),
    dirty: facts.dirty,
    mergedIntoParentBranch: facts.mergedIntoParentBranch,
    ageMs,
  };
  const active = { ...base, disposition: "active" as const, staleReason: null };
  const stale = (staleReason: WorktreeStaleReason) => ({
    ...base,
    disposition: "stale" as const,
    staleReason,
  });

  if (entry.isMain) return active;
  const resolvedPath = NodePath.resolve(entry.path);
  // A process is live in this tree right now (lease truth), so it is in use
  // whatever the plan lanes say — including the case this input exists for: a
  // human conversing with a thread whose lane is terminal.
  if (input.occupiedPaths?.has(resolvedPath) === true) return active;
  // Structural occupancy: a non-terminal thread's workspace resolves here, so
  // this checkout is its work in progress. Mirrors the fan-in reactor's
  // `hasDependentResident`.
  const occupied = threads.some((t) => {
    if (isTerminal(t.planLane)) return false;
    const cwd = resolveThreadWorkspaceCwd({ thread: t, projects });
    return cwd !== undefined && NodePath.resolve(cwd) === resolvedPath;
  });
  if (occupied) return active;

  if (owner === undefined) return stale("orphaned");
  if (!isTerminal(owner.planLane)) return active;
  if (owner.planLane === "cancelled") return stale("cancelled");
  // done:
  if (owner.isolation !== "isolated" || entry.branch === null || !entry.branch.startsWith("ws/")) {
    return stale("unmanaged");
  }
  if (owner.fanInState === "conflicted") return stale("conflicted");
  if (owner.fanInState === "failed") return stale("fanin-failed");
  if (owner.fanInState !== "completed") return stale("fanin-pending");
  if (facts.dirty !== false) return stale("dirty");
  if (facts.mergedIntoParentBranch !== true) return stale("unmerged");
  if (ageMs === null || ageMs < reapAgeMs) return stale("recently-finished");
  return { ...base, disposition: "reapable", staleReason: null };
};
