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
import * as FileSystem from "effect/FileSystem";
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
import {
  classifyWorktree,
  type ClassifiedWorktree,
  type WorktreeGitFacts,
} from "../worktreeClassification.ts";
import { performWorktreeRemoval } from "../worktreeRemoval.ts";
import { makeRemovalDeferralLog } from "../worktreeRemovalDeferral.ts";
import {
  selectOrphanWorktreeDirs,
  WORKSTREAM_WORKTREE_DIR_PREFIX,
} from "../orphanWorktreeSweep.ts";

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

/**
 * The fact-free probe: classify with both git facts unknown.
 *
 * `classifyWorktree` reads the facts only from its `dirty` check onward, and
 * `dirty: null` fails that check — so a probe verdict other than
 * `stale("dirty")` is provably independent of the facts and is already final.
 * That makes the probe a spawn gate: only the entries that reach the dirty check
 * need `git status`, and only the clean ones need `merge-base --is-ancestor`.
 * (Before this, every non-main worktree paid both unconditionally — ~197
 * worktrees × 2 spawns ≈ 400 git processes per 30-minute sweep on the loom repo,
 * a periodic burst against a steady state of ~8 spawns/s.)
 */
const NO_GIT_FACTS = { dirty: null, mergedIntoParentBranch: null } as const;

/**
 * Opt-in switch for the path-based orphan sweep's destructive branch. Off by
 * default: the sweep reports unreachable directories so a human can approve the
 * one-off reclaim, because its input is the filesystem and the blast radius is
 * gigabytes of someone's disk.
 */
const RECLAIM_ORPHAN_WORKTREE_DIRS = process.env.T3CODE_RECLAIM_ORPHAN_WORKTREES === "1";

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const gitWorkflow = yield* GitWorkflowService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const workspaceLease = yield* WorkspaceLease;

  const worktreesRoot = NodePath.resolve(config.worktreesDir) + NodePath.sep;

  // Per-path deferral episodes (see `makeRemovalDeferralLog`): occupancy is
  // normal and transient, so it is announced once per episode rather than once
  // per 30-minute pass.
  const deferralLog = makeRemovalDeferralLog("worktree reaper");

  // Last reported orphan inventory, so an unchanged one is not re-warned every
  // sweep (see `sweepOrphanDirs`). Process-scoped: a restart re-reports once.
  let lastReportedOrphanSignature: string | null = null;

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
          const classify = (facts: WorktreeGitFacts) =>
            classifyWorktree({
              entry,
              projectId: project.id,
              threads,
              projects: snapshot.projects,
              facts,
              nowMs,
              occupiedPaths,
            });
          // Probe first — it costs nothing, resolves the parent branch that
          // containment needs, and short-circuits every entry whose verdict does
          // not depend on the git facts at all (see `NO_GIT_FACTS`).
          const probe = classify(NO_GIT_FACTS);
          if (probe.staleReason !== "dirty") return probe;
          const dirty = yield* gitWorkflow
            .hasWorkingTreeChanges(entry.path)
            .pipe(Effect.orElseSucceed(() => null));
          // A dirty (or unknowable) tree stops at the dirty check, so its
          // containment is never read: don't spawn for it.
          const mergedIntoParentBranch =
            dirty === false && entry.branch !== null && probe.parentBranch !== null
              ? yield* gitWorkflow
                  .isAncestor({
                    cwd: project.workspaceRoot,
                    ancestor: entry.branch,
                    descendant: probe.parentBranch,
                  })
                  .pipe(Effect.orElseSucceed(() => null))
              : null;
          return classify({ dirty, mergedIntoParentBranch });
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
      return yield* deferralLog.skipped(entry.path);
    }
    yield* deferralLog.removed(entry.path);
    if (entry.threadId !== null) {
      yield* appendReapedActivity(entry.threadId, entry);
    }
    yield* Effect.logInfo("worktree reaper: removed dead worktree", {
      path: entry.path,
      branch: entry.branch,
    });
  });

  // Path-based orphan sweep (see `orphanWorktreeSweep.ts`): `ws-*` directories
  // that no thread row references AND git has not registered, which therefore no
  // index-driven mechanism can ever enumerate again.
  //
  // DRY RUN BY DEFAULT, and deliberately so: this is the one sweep whose input is
  // the filesystem rather than a record of intent, and the measured inventory is
  // ~14 GB of a human's disk. It reports; reclaiming is opt-in via
  // `T3CODE_RECLAIM_ORPHAN_WORKTREES=1`, and even then each removal goes through
  // the workspace lease so a directory with a live process in it is skipped
  // rather than deleted.
  //
  // `gitRegisteredPaths` comes from the classification pass that just ran, so the
  // sweep costs no extra git spawns. A project whose `git worktree list` FAILED
  // classifies to zero entries (`listWorktrees` falls back to `[]`, and a healthy
  // repo always yields at least its main worktree), and an unreadable registry
  // would make every one of that repo's worktrees look unregistered — so such a
  // project VETOES the sweep for the pass. A project row whose workspace root is
  // not a git repository at all is exempt from that veto: its empty listing is the
  // truth, not a failure, and two such stale rows on the measured host would
  // otherwise disable this sweep permanently.
  const sweepOrphanDirs = Effect.fn("sweepOrphanDirs")(function* (
    gitRegisteredPaths: ReadonlySet<string>,
  ) {
    const parents = yield* fs.readDirectory(config.worktreesDir);
    const candidatePaths: string[] = [];
    for (const parent of parents) {
      const parentPath = NodePath.join(config.worktreesDir, parent);
      const children = yield* fs
        .readDirectory(parentPath)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const child of children) {
        if (child.startsWith(WORKSTREAM_WORKTREE_DIR_PREFIX)) {
          candidatePaths.push(NodePath.resolve(parentPath, child));
        }
      }
    }
    if (candidatePaths.length === 0) return;
    const referencedPaths = new Set(
      [...(yield* projectionSnapshotQuery.getReferencedWorktreePaths())].map((path) =>
        NodePath.resolve(path),
      ),
    );
    const orphans = selectOrphanWorktreeDirs({
      candidatePaths,
      referencedPaths,
      gitRegisteredPaths,
    });
    if (orphans.length === 0) return;
    // The inventory is an actionable WARN, but it is also unchanging until a human
    // acts on it — and a 33-path wall repeated every 30 minutes forever is the
    // same defect this change set removes from the fan-in reactor. Report on
    // CHANGE (including the first pass and after a partial reclaim); otherwise
    // leave it at debug.
    const signature = orphans.join("\n");
    const changed = signature !== lastReportedOrphanSignature;
    lastReportedOrphanSignature = signature;
    yield* (changed ? Effect.logWarning : Effect.logDebug)(
      "worktree reaper: unreachable worktree directories found",
      {
        count: orphans.length,
        candidateCount: candidatePaths.length,
        reclaim: RECLAIM_ORPHAN_WORKTREE_DIRS,
        paths: orphans,
      },
    );
    if (!RECLAIM_ORPHAN_WORKTREE_DIRS) return;
    for (const path of orphans) {
      const removed = yield* workspaceLease.withExclusive(
        path,
        fs
          .remove(path, { recursive: true })
          .pipe(
            Effect.tap(() =>
              Effect.logInfo("worktree reaper: reclaimed orphan directory", { path }),
            ),
          ),
      );
      if (Option.isNone(removed)) yield* deferralLog.skipped(path);
    }
  });

  const runPass = Effect.fn("runPass")(function* () {
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const nowMs = yield* Effect.map(DateTime.now, DateTime.toEpochMillis);
    const gitRegisteredPaths = new Set<string>();
    let registryComplete = true;
    for (const project of snapshot.projects) {
      const classified = yield* classifyProject(project, snapshot, nowMs);
      if (
        classified.length === 0 &&
        (yield* fs.exists(NodePath.join(project.workspaceRoot, ".git")))
      ) {
        registryComplete = false;
      }
      for (const entry of classified) {
        gitRegisteredPaths.add(NodePath.resolve(entry.path));
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
    if (registryComplete) yield* sweepOrphanDirs(gitRegisteredPaths);
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
