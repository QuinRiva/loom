import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitCommandError,
  WORKTREE_SETUP_ACTIVITY_KIND,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

import { WorktreeProvisioner, layer as WorktreeProvisionerLive } from "./WorktreeProvisioner.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectSetupScriptRunner } from "./ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import {
  WorkspaceLease,
  layer as WorkspaceLeaseLive,
} from "../workspace/WorkspaceOccupancyLease.ts";
import { WorktreeSetupTracker, layer as WorktreeSetupTrackerLive } from "./WorktreeSetupTracker.ts";

const CHILD_WORKTREE = "/tmp/child-worktree";
const CHILD_BRANCH = "ws/main/coder-child-is";

const setupSnapshots = (commands: ReadonlyArray<OrchestrationCommand>) =>
  commands.flatMap((command) =>
    command.type === "thread.activity.append" &&
    command.activity.kind === WORKTREE_SETUP_ACTIVITY_KIND
      ? [command.activity.payload as WorktreeSetupSnapshot]
      : [],
  );

// ensureIsolatedChildProvisioned is the shared turn-start guard (item 4): it
// (re)provisions an isolated child's worktree and, on failure, parks the child
// (needs_guidance) so it never fails to the caller — the invariant that keeps a
// turn from starting against an unprovisioned isolated child. Provisioning runs
// as a fibre registered with `WorktreeSetupTracker`, so the child gets the
// setup card, a durable record of it, and a working cancel.
describe("ensureIsolatedChildProvisioned", () => {
  const threadId = ThreadId.make("child-iso-1");
  const projectId = ProjectId.make("project-1");

  const harness = (opts: {
    readonly commitFails?: boolean;
    /** Resolve to release a checkout that is otherwise parked mid-provision. */
    readonly blockCheckout?: Deferred.Deferred<void>;
    /** Completed once `createWorktree` has claimed the directory. */
    readonly checkoutStarted?: Deferred.Deferred<void>;
  }) => {
    const dispatched: Array<OrchestrationCommand> = [];
    const removed: Array<string> = [];
    const deletedBranches: Array<string> = [];
    const engineStub = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.sync(() => {
          dispatched.push(command);
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as never);
    const gitStub = Layer.succeed(GitWorkflowService, {
      commitAll: () =>
        opts.commitFails
          ? Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.commit.commit",
                command: "git commit",
                cwd: "/tmp/parent-worktree",
                detail: "index.lock: File exists",
              }),
            )
          : Effect.succeed({ committed: true }),
      createWorktree: (_input: unknown, options?: GitVcsDriver.CreateWorktreeOptions) =>
        Effect.gen(function* () {
          yield* options?.progress?.onWorktreeClaimed?.(CHILD_WORKTREE) ?? Effect.void;
          if (opts.checkoutStarted) yield* Deferred.succeed(opts.checkoutStarted, undefined);
          if (opts.blockCheckout) yield* Deferred.await(opts.blockCheckout);
          return { worktree: { path: CHILD_WORKTREE, refName: CHILD_BRANCH } };
        }),
      removeWorktree: (input: { readonly path: string }) =>
        Effect.sync(() => {
          removed.push(input.path);
        }),
      pruneWorktrees: () => Effect.void,
      deleteBranch: (input: { readonly branch: string }) =>
        Effect.sync(() => {
          deletedBranches.push(input.branch);
        }),
    } as never);
    const lockStub = Layer.succeed(WorktreeMutationLock, {
      withLock: <A, E, R>(_path: string, effect: Effect.Effect<A, E, R>) => effect,
    } as never);
    const setupStub = Layer.succeed(ProjectSetupScriptRunner, {
      runForThread: () => Effect.succeed({ status: "no-script" as const }),
    } as never);
    const vcsStub = Layer.succeed(VcsStatusBroadcaster, {
      refreshStatus: () => Effect.succeed(undefined),
    } as never);
    const layer = WorktreeProvisionerLive.pipe(
      Layer.provide(engineStub),
      Layer.provide(gitStub),
      Layer.provide(lockStub),
      Layer.provide(setupStub),
      Layer.provide(vcsStub),
      // Merged rather than provided: the assertions drive the very tracker and
      // lease the provisioner registers its fibre and its hold with.
      Layer.provideMerge(Layer.mergeAll(WorkspaceLeaseLive, WorktreeSetupTrackerLive)),
      Layer.provide(NodeServices.layer),
    );
    return { dispatched, removed, deletedBranches, layer };
  };

  it.effect(
    "parks the child (needs_guidance) and remembers the failure when provisioning fails",
    () =>
      Effect.gen(function* () {
        const { dispatched, layer } = harness({ commitFails: true });
        // The snapshot commit retries on a spaced schedule against the test clock,
        // so fork the provisioning and flush the retry window before joining.
        const fiber = yield* Effect.gen(function* () {
          const provisioner = yield* WorktreeProvisioner;
          const provisioned = yield* provisioner.ensureIsolatedChildProvisioned({
            threadId,
            role: "coder",
            projectId,
            branch: "main",
            worktreePath: "/tmp/parent-worktree",
          });
          return { provisioned, pending: provisioner.hasPendingProvisionFailure(threadId) };
        }).pipe(Effect.provide(layer), Effect.forkScoped);
        yield* Effect.yieldNow;
        yield* TestClock.adjust(Duration.seconds(1));
        const outcome = yield* Fiber.join(fiber);

        expect(outcome.provisioned).toBe(false);
        expect(outcome.pending).toBe(true);
        expect(
          dispatched.some(
            (c) => c.type === "thread.attention.raise" && c.reason === "needs_guidance",
          ),
        ).toBe(true);
        expect(
          dispatched.some(
            (c) =>
              c.type === "thread.activity.append" &&
              c.activity.kind === "workstream.provision.failed",
          ),
        ).toBe(true);
        // The card settles too, so a client watching the child sees why.
        expect(setupSnapshots(dispatched).map((snapshot) => snapshot.phase)).toEqual([
          "running",
          "failed",
        ]);
      }),
  );

  it.effect("provisions and clears the failure marker on success", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = harness({});
      const outcome = yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        const provisioned = yield* provisioner.ensureIsolatedChildProvisioned({
          threadId,
          role: "coder",
          projectId,
          branch: "main",
          worktreePath: "/tmp/parent-worktree",
        });
        return { provisioned, pending: provisioner.hasPendingProvisionFailure(threadId) };
      }).pipe(Effect.provide(layer));

      expect(outcome.provisioned).toBe(true);
      expect(outcome.pending).toBe(false);
      // The child was repointed to its own worktree/branch.
      expect(
        dispatched.some((c) => c.type === "thread.meta.update" && c.branch === CHILD_BRANCH),
      ).toBe(true);
      // Running then settled, upserted under the one activity id the setup card
      // reads after a reload.
      const snapshots = setupSnapshots(dispatched);
      expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["running", "done"]);
      expect(snapshots.at(-1)?.worktreePath).toBe(CHILD_WORKTREE);
      expect(
        new Set(
          dispatched.flatMap((c) =>
            c.type === "thread.activity.append" && c.activity.kind === WORKTREE_SETUP_ACTIVITY_KIND
              ? [c.activity.id]
              : [],
          ),
        ).size,
      ).toBe(1);
    }),
  );

  it.effect("is an idempotent no-op for an already-provisioned child", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = harness({ commitFails: true });
      const provisioned = yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        return yield* provisioner.ensureIsolatedChildProvisioned({
          threadId,
          role: "coder",
          projectId,
          // Already on its own `ws/…-<first8(threadId)>` branch.
          branch: CHILD_BRANCH,
          worktreePath: CHILD_WORKTREE,
        });
      }).pipe(Effect.provide(layer));

      expect(provisioned).toBe(true);
      // No git op ran and no command was dispatched — a pure no-op.
      expect(dispatched).toHaveLength(0);
    }),
  );

  // The point of running provisioning through the tracker: a human can stop a
  // stuck setup from the child's own card, and the abandoned tree is unwound
  // so the next attempt can cut the branch again.
  it.effect("cancel mid-provision records the terminal state and releases the hold", () =>
    Effect.gen(function* () {
      const checkoutStarted = yield* Deferred.make<void>();
      const blockCheckout = yield* Deferred.make<void>();
      const { dispatched, removed, deletedBranches, layer } = harness({
        checkoutStarted,
        blockCheckout,
      });

      const outcome = yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        const tracker = yield* WorktreeSetupTracker;
        const lease = yield* WorkspaceLease;
        const fiber = yield* Effect.forkScoped(
          Effect.gen(function* () {
            const provisioned = yield* provisioner.ensureIsolatedChildProvisioned({
              threadId,
              role: "coder",
              projectId,
              branch: "main",
              worktreePath: "/tmp/parent-worktree",
            });
            return { provisioned, pending: provisioner.hasPendingProvisionFailure(threadId) };
          }),
        );
        // The claimed directory is the receipt that provisioning is live and
        // holding the tree.
        yield* Deferred.await(checkoutStarted);
        expect(yield* lease.holdersOf(CHILD_WORKTREE)).toEqual([`worktree-provision:${threadId}`]);
        // `cancel` waits for the interrupted fibre to unwind, so everything
        // below observes the settled state.
        const cancelled = yield* tracker.cancel(threadId);
        const result = yield* Fiber.join(fiber);
        return { cancelled, ...result, holders: yield* lease.holdersOf(CHILD_WORKTREE) };
      }).pipe(Effect.provide(layer), Effect.scoped);

      expect(outcome.cancelled).toBe(true);
      expect(outcome.provisioned).toBe(false);
      // Remembered, so the promote loop does not immediately re-provision what
      // a human just stopped.
      expect(outcome.pending).toBe(true);
      expect(outcome.holders).toEqual([]);
      expect(setupSnapshots(dispatched).map((snapshot) => snapshot.phase)).toEqual([
        "running",
        "cancelled",
      ]);
      // A cancel is not a defect: no needs_guidance flag, and the child never
      // gets repointed at the tree that no longer exists.
      expect(dispatched.some((c) => c.type === "thread.attention.raise")).toBe(false);
      expect(dispatched.some((c) => c.type === "thread.meta.update")).toBe(false);
      expect(removed).toEqual([CHILD_WORKTREE]);
      expect(deletedBranches).toEqual([CHILD_BRANCH]);
    }),
  );
});
