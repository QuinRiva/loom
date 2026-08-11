// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  CommandId,
  EventId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { makeCoalescingWorker } from "@t3tools/shared/DrainableWorker";

import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { WorkspaceLease } from "../../workspace/WorkspaceLease.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorktreeReaper, type WorktreeReaperShape } from "../Services/WorktreeReaper.ts";
import { classifyWorktree, type ClassifiedWorktree } from "../worktreeClassification.ts";
import { performWorktreeRemoval } from "../worktreeRemoval.ts";

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Sweep cadence. GC of leftovers only — the fan-in reactor already removes
 * worktrees promptly on the happy path, so a slow tick is plenty and keeps the
 * git churn negligible. Fires once at startup, then every interval.
 */
export const WORKTREE_REAP_INTERVAL_MS = 30 * 60_000;

/**
 * Bound on concurrent per-worktree git facts (`status --porcelain`,
 * `merge-base --is-ancestor`) within one project's classification pass. These
 * are read-only ops safe to run in parallel against the repo; the bound keeps a
 * 40-worktree host from spawning 40 git processes at once while removing the
 * serial round-trip stall (~40s → low single digits). The classifier is pure
 * and `Effect.forEach` preserves input order, so dispositions are identical to
 * the sequential version.
 */
export const WORKTREE_CLASSIFY_CONCURRENCY = 12;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig;
  const gitWorkflow = yield* GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const workspaceLease = yield* WorkspaceLease;

  const worktreesRoot = NodePath.resolve(config.worktreesDir) + NodePath.sep;

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => CommandId.make(`server:worktree-reaper:${tag}:${uuid}`)),
    );

  const appendReapedActivity = (threadId: ThreadId, entry: ClassifiedWorktree) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* orchestrationEngine.dispatch({
        type: "thread.activity.append",
        commandId: yield* serverCommandId("activity"),
        threadId,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4),
          tone: "info",
          kind: "workstream.worktree.reaped",
          summary: `Reaped merged worktree ${NodePath.basename(entry.path)} (branch ${entry.branch ?? "?"} fully merged into ${entry.parentBranch ?? "?"}).`,
          payload: { path: entry.path, branch: entry.branch, parentBranch: entry.parentBranch },
          turnId: null,
          createdAt,
        },
        createdAt,
      } satisfies OrchestrationCommand);
    }).pipe(Effect.ignoreCause({ log: true }));

  // Classify one project's linked worktrees: enumerate, gather git facts for
  // the non-main entries, and run the pure classifier over each.
  const classifyProject = Effect.fn("classifyProject")(function* (
    project: OrchestrationProjectShell,
    snapshot: {
      readonly threads: ReadonlyArray<OrchestrationThreadShell>;
      readonly projects: ReadonlyArray<OrchestrationProjectShell>;
    },
    nowMs: number,
  ) {
    const entries = yield* gitWorkflow
      .listWorktrees(project.workspaceRoot)
      .pipe(Effect.orElseSucceed(() => []));
    const threads = snapshot.threads.filter((t) => t.projectId === project.id);
    // Advisory only (plan §7.3): a held workspace is displayed as `active` so
    // the maintenance panel and the reaper's own log tell the truth about why a
    // tree survives. The protection itself is the lease taken at removal time —
    // this snapshot can go stale the instant after it is read.
    const occupiedPaths = yield* workspaceLease.occupiedPaths;
    return yield* Effect.forEach(
      entries,
      (entry) =>
        Effect.gen(function* () {
          const facts = entry.isMain
            ? { dirty: null, mergedIntoParentBranch: null }
            : yield* Effect.gen(function* () {
                const dirty = yield* gitWorkflow
                  .hasWorkingTreeChanges(entry.path)
                  .pipe(Effect.orElseSucceed(() => null));
                // The parent branch only resolves through ownership; classify
                // once without facts to discover it, then compute containment.
                const probe = classifyWorktree({
                  entry,
                  projectId: project.id,
                  threads,
                  projects: snapshot.projects,
                  facts: { dirty: null, mergedIntoParentBranch: null },
                  nowMs,
                  occupiedPaths,
                });
                const merged =
                  entry.branch !== null && probe.parentBranch !== null
                    ? yield* gitWorkflow
                        .isAncestor({
                          cwd: project.workspaceRoot,
                          ancestor: entry.branch,
                          descendant: probe.parentBranch,
                        })
                        .pipe(Effect.orElseSucceed(() => null))
                    : null;
                return { dirty, mergedIntoParentBranch: merged };
              });
          return classifyWorktree({
            entry,
            projectId: project.id,
            threads,
            projects: snapshot.projects,
            facts,
            nowMs,
            occupiedPaths,
          });
        }),
      { concurrency: WORKTREE_CLASSIFY_CONCURRENCY },
    );
  });

  const classifyAll = Effect.fn("classifyAll")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
    const out: ClassifiedWorktree[] = [];
    for (const project of snapshot.projects) {
      out.push(...(yield* classifyProject(project, snapshot, nowMs)));
    }
    return out;
  });

  // Remove one provably-dead worktree + its branch. Both git steps stay
  // NON-forced: `worktree remove` refuses a dirty/locked tree and `branch -d`
  // refuses an unmerged branch, so even a stale classification (state moved
  // between classify and reap) cannot destroy work. Ops run from the parent
  // thread's cwd (like the fan-in reactor): `branch -d` judges merged-ness
  // against the checked-out HEAD, which is the parent branch there — running
  // it from the project root would wrongly compare against the root's branch.
  // Failures are logged and left for the visibility surface — GC is
  // best-effort by design.
  //
  // `performWorktreeRemoval` runs the git steps inside
  // `WorkspaceLease.withExclusive` (plan §7.3), so a worktree with a live
  // process in it is skipped rather than deleted. That matters here in its own
  // right: the reaper carried an INDEPENDENT copy of the terminal-lane occupancy
  // proxy, so a fix confined to the fan-in reactor would have left the identical
  // destructive race on a six-hour timer. One authority, two removers. A skip
  // costs one tick, never the worktree.
  const reapOne = Effect.fn("reapOne")(function* (
    workspaceRoot: string,
    entry: ClassifiedWorktree,
  ) {
    const removed = yield* performWorktreeRemoval({
      cwd: entry.parentCwd ?? workspaceRoot,
      path: entry.path,
      branch: entry.branch,
      forceWorktree: false,
      deleteBranchWhenMerged: true,
    });
    if (Option.isNone(removed)) {
      return yield* Effect.logInfo("worktree reaper: skipped occupied worktree", {
        path: entry.path,
      });
    }
    if (entry.threadId !== null) {
      yield* appendReapedActivity(entry.threadId, entry);
    }
    yield* Effect.logInfo("worktree reaper: removed dead worktree", {
      path: entry.path,
      branch: entry.branch,
    });
  });

  const runPass = Effect.fn("runPass")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
    for (const project of snapshot.projects) {
      const classified = yield* classifyProject(project, snapshot, nowMs);
      for (const entry of classified) {
        // Extra belt on top of the classification predicates: only ever reap
        // inside the server-managed worktrees directory, never a user-created
        // worktree elsewhere on disk.
        if (
          entry.disposition !== "reapable" ||
          !NodePath.resolve(entry.path).startsWith(worktreesRoot)
        ) {
          continue;
        }
        yield* reapOne(project.workspaceRoot, entry).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
            return Effect.logWarning(
              "worktree reaper: removal failed; leaving for visibility surface",
              {
                path: entry.path,
                cause: Cause.pretty(cause),
              },
            );
          }),
        );
      }
    }
  });

  const runPassSafely = runPass().pipe(
    Effect.catchCause((cause) => {
      if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
      return Effect.logWarning("worktree reaper pass failed", { cause: Cause.pretty(cause) });
    }),
  );

  // COALESCING worker (not the queueing default): a payload-free trigger running
  // an idempotent full sweep. Timer-armed today, so bursts are rare — but a
  // reap pass shells out per worktree, so a startup pass overlapping the tick
  // must collapse rather than queue. See `makeCoalescingWorker`.
  const worker = yield* makeCoalescingWorker(runPassSafely);

  const start: WorktreeReaperShape["start"] = Effect.fn("start")(function* () {
    // Purely periodic — the fan-in reactor owns the prompt event-driven path;
    // this sweep only collects leftovers (missed removals, crash residue that
    // later became provably dead), so a startup pass + slow tick suffices.
    yield* worker.enqueue();
    yield* Effect.forkScoped(
      worker
        .enqueue()
        .pipe(Effect.repeat(Schedule.spaced(Duration.millis(WORKTREE_REAP_INTERVAL_MS)))),
    );
  });

  return {
    start,
    classifyWorktrees: classifyAll,
    drain: worker.drain,
  } satisfies WorktreeReaperShape;
});

export const WorktreeReaperLive = Layer.effect(WorktreeReaper, make);
