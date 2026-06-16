/**
 * GoalsService — the server-side, in-memory index of goal packages.
 *
 * Architecture v3 (file-centric): a goal IS its `goals/<slug>/goal.md` file;
 * there is no DB goal aggregate. This service keeps a lightweight derived
 * cache built by scanning each project's worktrees with
 * `GoalPackage.discoverGoals`. The cache is never authoritative — a re-scan
 * always re-reads the files, which win on any conflict. At personal scale
 * (a handful of goals) an in-memory snapshot refreshed on demand is enough;
 * `/api/goals` triggers a re-scan so file edits surface immediately.
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Array from "effect/Array";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { discoverGoals, taskProgress, type GoalTaskNode } from "./GoalPackage.ts";

export interface GoalTaskProgress {
  readonly done: number;
  readonly total: number;
}

export interface GoalIndexEntry {
  readonly projectId: ProjectId;
  readonly slug: string;
  readonly title: string;
  readonly goalParagraph: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly packagePath: string;
  readonly tasks: ReadonlyArray<GoalTaskNode>;
  readonly progress: GoalTaskProgress;
}

export interface GoalsServiceShape {
  /** Current cached index (no scan). */
  readonly list: () => Effect.Effect<ReadonlyArray<GoalIndexEntry>>;
  /** Re-scan every project's worktrees, refresh the cache, return the index. */
  readonly rescan: () => Effect.Effect<ReadonlyArray<GoalIndexEntry>>;
}

export class GoalsService extends Context.Service<GoalsService, GoalsServiceShape>()(
  "t3/goal/GoalsService",
) {}

class GoalDiscoveryError extends Data.TaggedError("GoalDiscoveryError")<{
  readonly workspaceRoot: string;
  readonly cause: unknown;
}> {}

const makeGoalsService = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const cache = yield* Ref.make<ReadonlyArray<GoalIndexEntry>>([]);

  const scanProject = (project: { readonly id: ProjectId; readonly workspaceRoot: string }) =>
    Effect.try({
      try: () => discoverGoals(project.workspaceRoot),
      catch: (cause) => new GoalDiscoveryError({ workspaceRoot: project.workspaceRoot, cause }),
    }).pipe(
      Effect.map((goals): ReadonlyArray<GoalIndexEntry> =>
        goals.map((goal) => ({
          projectId: project.id,
          slug: goal.slug,
          title: goal.title,
          goalParagraph: goal.goalParagraph,
          worktreePath: goal.worktreePath,
          branch: goal.branch,
          packagePath: goal.packagePath,
          tasks: goal.tasks,
          progress: taskProgress(goal.tasks),
        })),
      ),
      Effect.tapError((cause) =>
        Effect.logWarning("goal discovery failed for project", {
          workspaceRoot: project.workspaceRoot,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<GoalIndexEntry>),
    );

  const rescan: GoalsServiceShape["rescan"] = () =>
    projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) => Effect.forEach(snapshot.projects, scanProject)),
      Effect.map(Array.flatten),
      Effect.tap((entries) => Ref.set(cache, entries)),
      Effect.tapError((cause) => Effect.logWarning("goal index rescan failed", { cause })),
      Effect.orElseSucceed(() => [] as ReadonlyArray<GoalIndexEntry>),
    );

  // Warm the cache on startup (best-effort; the route re-scans on every read).
  yield* rescan();

  return {
    list: () => Ref.get(cache),
    rescan,
  } satisfies GoalsServiceShape;
});

export const GoalsServiceLive = Layer.effect(GoalsService, makeGoalsService);
