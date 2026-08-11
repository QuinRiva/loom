// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { TestClock } from "effect/testing";

import type {
  OrchestrationCommand,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfigModule from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { layer as WorktreeMutationLockLive } from "../../git/WorktreeMutationLock.ts";
import { makeWorkspaceLease, WorkspaceLease } from "../../workspace/WorkspaceLease.ts";
import type { GitWorktreeListEntry } from "../../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { WorktreeReaper } from "../Services/WorktreeReaper.ts";
import { WORKTREE_REAP_AGE_MS } from "../worktreeClassification.ts";
import { WORKTREE_REAP_INTERVAL_MS, WorktreeReaperLive } from "./WorktreeReaper.ts";

// `it.effect` runs on the TestClock (now = epoch 0), so "older than the reap
// threshold" means a timestamp before 1970 minus the threshold.
const OLD = new Date(-WORKTREE_REAP_AGE_MS - 60_000).toISOString();

const thread = (
  over: Omit<Partial<OrchestrationThreadShell>, "id"> & { id: string },
): OrchestrationThreadShell =>
  ({
    projectId: "p1",
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

describe("WorktreeReaper", () => {
  it.effect("reaps only the provably-dead worktree; stale ones survive", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
      const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
      const entriesRef = yield* Ref.make<ReadonlyArray<GitWorktreeListEntry>>([]);
      // Dirty state per worktree path (the dead one is clean, the stale one dirty).
      const dirtyByPath = new Map<string, boolean>();

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        dispatch: (command: OrchestrationCommand) =>
          Ref.update(dispatched, (xs) => [...xs, command]).pipe(Effect.as({ sequence: 0 })),
      } as never);
      const gitLayer = Layer.succeed(GitWorkflowService, {
        // Only consulted when a project classifies to ZERO entries (a failed
        // listing); non-null means "inside a git repo", which vetoes the orphan sweep.
        resolveRemoteStatusRepository: () => Effect.succeed(null),
        listWorktrees: () => Ref.get(entriesRef),
        // Recorded so the reap pass's spawn gate is observable: an entry whose
        // disposition never reads the git facts must not pay for them.
        hasWorkingTreeChanges: (cwd: string) =>
          record(`status:${cwd}`).pipe(Effect.as(dirtyByPath.get(NodePath.resolve(cwd)) ?? false)),
        isAncestor: () => Effect.succeed(true),
        removeWorktree: (input: { path: string }) => record(`removeWorktree:${input.path}`),
        deleteBranch: (input: { branch: string }) => record(`deleteBranch:${input.branch}`),
      } as never);

      yield* Effect.gen(function* () {
        const config = yield* ServerConfigModule.ServerConfig;
        const dead = NodePath.join(config.worktreesDir, "repo", "ws-main-coder-11111111");
        const dirty = NodePath.join(config.worktreesDir, "repo", "ws-main-coder-22222222");
        // Owned by a CANCELLED thread, so its verdict (`stale("cancelled")`) is
        // reached before the classifier ever reads the git facts. It is also dirty,
        // which is the combination that exposes whether the facts are real.
        const cancelled = NodePath.join(config.worktreesDir, "repo", "ws-main-coder-33333333");
        dirtyByPath.set(NodePath.resolve(dirty), true);
        dirtyByPath.set(NodePath.resolve(cancelled), true);
        yield* Ref.set(entriesRef, [
          {
            path: "/repo",
            branch: "main",
            head: "abc",
            isMain: true,
            locked: false,
            prunable: false,
          },
          {
            path: dead,
            branch: "ws/main/coder-11111111",
            head: "abc",
            isMain: false,
            locked: false,
            prunable: false,
          },
          {
            path: dirty,
            branch: "ws/main/coder-22222222",
            head: "abc",
            isMain: false,
            locked: false,
            prunable: false,
          },
          {
            path: cancelled,
            branch: "ws/main/coder-33333333",
            head: "abc",
            isMain: false,
            locked: false,
            prunable: false,
          },
        ]);

        const project = {
          id: "p1",
          title: "p",
          workspaceRoot: "/repo",
        } as unknown as OrchestrationProjectShell;
        const parent = thread({
          id: "parent",
          planLane: "in_progress",
          isolation: "shared",
          branch: "main",
          worktreePath: "/repo",
        });
        const threads = [
          parent,
          thread({
            id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
            parentThreadId: "parent" as ThreadId,
            worktreePath: dead,
          }),
          thread({
            id: "22222222-aaaa-bbbb-cccc-dddddddddddd",
            parentThreadId: "parent" as ThreadId,
            worktreePath: dirty,
          }),
          thread({
            id: "33333333-aaaa-bbbb-cccc-dddddddddddd",
            parentThreadId: "parent" as ThreadId,
            planLane: "cancelled",
            worktreePath: cancelled,
          }),
        ];
        const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
          getReferencedWorktreePaths: () => Effect.succeed(new Set<string>()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [project],
              goals: [],
              threads,
              updatedAt: OLD,
            }),
        } as never);

        const layer = WorktreeReaperLive.pipe(
          Layer.provide(engineLayer),
          Layer.provide(projectionLayer),
          Layer.provide(gitLayer),
          Layer.provide(WorktreeMutationLockLive),
          Layer.provide(Layer.effect(WorkspaceLease, makeWorkspaceLease)),
          Layer.provide(Layer.succeed(ServerConfigModule.ServerConfig, config)),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const reaper = yield* WorktreeReaper;
          yield* reaper.start();
          yield* reaper.drain;

          const calls = yield* Ref.get(gitCalls);
          expect(calls).toContain(`removeWorktree:${dead}`);
          expect(calls).toContain("deleteBranch:ws/main/coder-11111111");
          // The dirty/cancelled siblings and the main worktree are untouched. (The
          // pass is idempotent and may run more than once at startup, so only the
          // dead worktree may ever be MUTATED.)
          expect(
            calls
              .filter((c) => c.startsWith("removeWorktree:") || c.startsWith("deleteBranch:"))
              .every((c) => c.includes("11111111")),
          ).toBe(true);
          // The reap pass's spawn gate: `cancelled` is decided before the dirty
          // check, so the pass never asks git about it. This is the whole saving
          // that took the loom repo's sweep from ~393 spawns to ~10-19.
          expect(calls).not.toContain(`status:${cancelled}`);

          // The owning thread got a reaped activity.
          const activity = (yield* Ref.get(dispatched)).find(
            (c) =>
              c.type === "thread.activity.append" &&
              c.activity.kind === "workstream.worktree.reaped",
          );
          expect(activity).toBeDefined();

          // The classification read (visibility-surface contract) sees all three.
          const classified = yield* reaper.classifyWorktrees();
          expect(classified).toHaveLength(4);
          expect(classified.find((c) => c.path === dead)?.disposition).toBe("reapable");
          expect(classified.find((c) => c.path === dirty)).toMatchObject({
            disposition: "stale",
            staleReason: "dirty",
          });
          // The visibility surface PUBLISHES `dirty`/`mergedIntoParentBranch` and
          // gates a destructive control on them (`WorkstreamWorktreeStatus` maps
          // `dirty: entry.dirty !== false` and passes `forceWorktree: dirty`), so
          // this read must carry real facts even for an entry the reap pass itself
          // decides without them. Leaving them `null` here made the panel assert
          // "uncommitted changes" about every such tree and force-remove it,
          // discarding git's own refusal-on-dirty.
          expect(classified.find((c) => c.path === cancelled)).toMatchObject({
            disposition: "stale",
            staleReason: "cancelled",
            dirty: true,
            mergedIntoParentBranch: true,
          });
        }).pipe(Effect.scoped, Effect.provide(layer));
      }).pipe(
        Effect.provide(
          ServerConfigModule.layerTest(process.cwd(), { prefix: "worktree-reaper-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      );
    }),
  );

  // Capability: a worktree is never removed under a live process — with the
  // REAPER as the remover (plan §9 test 5, guarding Defect A′). The reaper
  // carried its own independent copy of the terminal-lane occupancy proxy, so a
  // fix confined to the fan-in reactor would have left the identical
  // destructive race here, just on a six-hour timer.
  it.effect("never reaps a worktree a live process holds, and reaps it once released", () =>
    Effect.gen(function* () {
      const gitCalls = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (tag: string) => Ref.update(gitCalls, (xs) => [...xs, tag]);
      const entriesRef = yield* Ref.make<ReadonlyArray<GitWorktreeListEntry>>([]);
      const lease = yield* makeWorkspaceLease;

      const engineLayer = Layer.succeed(OrchestrationEngineService, {
        dispatch: () => Effect.succeed({ sequence: 0 }),
      } as never);
      const gitLayer = Layer.succeed(GitWorkflowService, {
        // Only consulted when a project classifies to ZERO entries (a failed
        // listing); non-null means "inside a git repo", which vetoes the orphan sweep.
        resolveRemoteStatusRepository: () => Effect.succeed(null),
        listWorktrees: () => Ref.get(entriesRef),
        hasWorkingTreeChanges: () => Effect.succeed(false),
        isAncestor: () => Effect.succeed(true),
        removeWorktree: (input: { path: string }) => record(`removeWorktree:${input.path}`),
        deleteBranch: (input: { branch: string }) => record(`deleteBranch:${input.branch}`),
      } as never);

      yield* Effect.gen(function* () {
        const config = yield* ServerConfigModule.ServerConfig;
        // Provably dead by every classification predicate — terminal, fanned in,
        // clean, merged, old. The ONLY thing standing between it and deletion is
        // the process a human resumed in it.
        const dead = NodePath.join(config.worktreesDir, "repo", "ws-main-coder-11111111");
        yield* Ref.set(entriesRef, [
          {
            path: "/repo",
            branch: "main",
            head: "abc",
            isMain: true,
            locked: false,
            prunable: false,
          },
          {
            path: dead,
            branch: "ws/main/coder-11111111",
            head: "abc",
            isMain: false,
            locked: false,
            prunable: false,
          },
        ]);

        const project = {
          id: "p1",
          title: "p",
          workspaceRoot: "/repo",
        } as unknown as OrchestrationProjectShell;
        const threads = [
          thread({
            id: "parent",
            planLane: "in_progress",
            isolation: "shared",
            branch: "main",
            worktreePath: "/repo",
          }),
          thread({
            id: "11111111-aaaa-bbbb-cccc-dddddddddddd",
            parentThreadId: "parent" as ThreadId,
            worktreePath: dead,
          }),
        ];
        const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
          getReferencedWorktreePaths: () => Effect.succeed(new Set<string>()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [project],
              goals: [],
              threads,
              updatedAt: OLD,
            }),
        } as never);

        const layer = WorktreeReaperLive.pipe(
          Layer.provide(engineLayer),
          Layer.provide(projectionLayer),
          Layer.provide(gitLayer),
          Layer.provide(WorktreeMutationLockLive),
          Layer.provide(Layer.succeed(WorkspaceLease, lease)),
          Layer.provide(Layer.succeed(ServerConfigModule.ServerConfig, config)),
          Layer.provideMerge(NodeServices.layer),
        );

        yield* Effect.gen(function* () {
          const reaper = yield* WorktreeReaper;
          const held = yield* lease.hold(dead, "resumed-session");

          yield* reaper.start();
          yield* reaper.drain;
          expect(yield* Ref.get(gitCalls)).toEqual([]);
          // The chip is honest about why it survived, not silently "reapable".
          expect(
            (yield* reaper.classifyWorktrees()).find((c) => c.path === dead)?.disposition,
          ).toBe("active");

          // The process exits (its lease releases) and the next periodic sweep
          // collects the tree — a skip costs one tick, never the worktree.
          yield* held.release;
          yield* TestClock.adjust(`${WORKTREE_REAP_INTERVAL_MS} millis`);
          yield* reaper.drain;
          expect(yield* Ref.get(gitCalls)).toContain(`removeWorktree:${dead}`);
        }).pipe(Effect.scoped, Effect.provide(layer));
      }).pipe(
        Effect.provide(
          ServerConfigModule.layerTest(process.cwd(), {
            prefix: "worktree-reaper-lease-test-",
          }).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.scoped,
      );
    }),
  );

  // The path-based orphan sweep is a DRY RUN unless explicitly opted into. Its
  // input is the filesystem rather than a record of intent, and the measured
  // inventory on the live cockpit was ~14 GB of a human's disk — so "reports but
  // never deletes by default" is the property that has to hold, not the log text.
  it.effect("reports unreachable ws-* directories without deleting them", () =>
    Effect.gen(function* () {
      const gitLayer = Layer.succeed(GitWorkflowService, {
        // One healthy project with only its main worktree: the orphan directory is
        // registered nowhere.
        // Only consulted when a project classifies to ZERO entries (a failed
        // listing); non-null means "inside a git repo", which vetoes the orphan sweep.
        resolveRemoteStatusRepository: () => Effect.succeed(null),
        listWorktrees: () =>
          Effect.succeed([
            {
              path: "/repo",
              branch: "main",
              head: "abc",
              isMain: true,
              locked: false,
              prunable: false,
            },
          ] satisfies ReadonlyArray<GitWorktreeListEntry>),
        hasWorkingTreeChanges: () => Effect.succeed(false),
        isAncestor: () => Effect.succeed(true),
        removeWorktree: () => Effect.void,
        deleteBranch: () => Effect.void,
      } as never);

      yield* Effect.gen(function* () {
        const config = yield* ServerConfigModule.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const orphan = NodePath.join(config.worktreesDir, "repo", "ws-main-coder-99999999");
        yield* fs.makeDirectory(orphan, { recursive: true });

        const projectionLayer = Layer.succeed(ProjectionSnapshotQuery, {
          getReferencedWorktreePaths: () => Effect.succeed(new Set<string>()),
          getShellSnapshot: () =>
            Effect.succeed({
              snapshotSequence: 0,
              projects: [
                {
                  id: "p1",
                  title: "p",
                  workspaceRoot: "/repo",
                } as unknown as OrchestrationProjectShell,
              ],
              goals: [],
              threads: [],
              updatedAt: OLD,
            }),
        } as never);

        yield* Effect.gen(function* () {
          const reaper = yield* WorktreeReaper;
          yield* reaper.start();
          yield* reaper.drain;
          expect(yield* fs.exists(orphan)).toBe(true);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            WorktreeReaperLive.pipe(
              Layer.provide(
                Layer.succeed(OrchestrationEngineService, {
                  dispatch: () => Effect.succeed({ sequence: 0 }),
                } as never),
              ),
              Layer.provide(projectionLayer),
              Layer.provide(gitLayer),
              Layer.provide(WorktreeMutationLockLive),
              Layer.provide(Layer.effect(WorkspaceLease, makeWorkspaceLease)),
              Layer.provide(Layer.succeed(ServerConfigModule.ServerConfig, config)),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      }).pipe(
        Effect.provide(
          ServerConfigModule.layerTest(process.cwd(), {
            prefix: "worktree-reaper-orphan-test-",
          }).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
        Effect.scoped,
      );
    }),
  );
});
