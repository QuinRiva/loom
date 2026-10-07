import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { ProjectionRepositoryError } from "../../persistence/Errors.ts";
import type { ClassifiedWorktree } from "../worktreeClassification.ts";

/**
 * WorktreeReaper — conservative periodic GC for workstream worktrees (phase 3).
 * Enumerates every project's linked worktrees, classifies them via
 * `worktreeClassification.ts`, and removes ONLY the `reapable` ones: owning
 * thread terminal, fan-in settled, branch fully merged into the parent branch,
 * clean tree, and older than the age threshold. Everything merely stale
 * (conflicted, cancelled, orphaned, dirty, unmerged, recent) is left for the
 * human-confirmed visibility surface — never auto-deleted.
 */
export interface WorktreeReaperShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /**
   * Classify every linked worktree across all projects without mutating
   * anything — the read the stale-worktrees visibility surface consumes.
   */
  readonly classifyWorktrees: () => Effect.Effect<
    ReadonlyArray<ClassifiedWorktree>,
    ProjectionRepositoryError
  >;
  /** Resolves when the internal sweep queue is empty and idle (tests). */
  readonly drain: Effect.Effect<void>;
}

export class WorktreeReaper extends Context.Service<WorktreeReaper, WorktreeReaperShape>()(
  "t3/orchestration/Services/WorktreeReaper",
) {}
