import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Option from "effect/Option";
import {
  GitCommandError,
  WORKTREE_SETUP_ACTIVITY_KIND,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
  type VcsCreateWorktreeInput,
  type WorktreeSetupSnapshot,
} from "@t3tools/contracts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

import { WorktreeProvisioner, layer as WorktreeProvisionerLive } from "./WorktreeProvisioner.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectSetupScriptRunner } from "./ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import {
  WorkspaceLease,
  layer as WorkspaceLeaseLive,
} from "../workspace/WorkspaceOccupancyLease.ts";
import { WorktreeSetupTracker, layer as WorktreeSetupTrackerLive } from "./WorktreeSetupTracker.ts";

const CHILD_WORKTREE = "/tmp/child-worktree";
const CHILD_BRANCH = "ws/main/coder-child-is";

/** The shape `describeSetupFailure` reads off a setup-script completion failure. */
interface SetupError {
  readonly _tag: string;
  readonly cause: Error;
}

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
    /** The project record the provisioner falls back to when the parent has no worktree. */
    readonly projectWorkspaceRoot?: string;
    /** `localStatus` of the project checkout: absent means "not a repo". */
    readonly checkoutBranch?: string | null;
    /** Resolve to release a checkout that is otherwise parked mid-provision. */
    readonly blockCheckout?: Deferred.Deferred<void>;
    /** Completed once `createWorktree` has claimed the directory. */
    readonly checkoutStarted?: Deferred.Deferred<void>;
    /** Keeps a started setup script running until this settles. */
    readonly scriptCompletion?: Deferred.Deferred<{ readonly exitCode: number | null }, SetupError>;
    /** Completed once the setup card's record settles (the detached fibre's receipt). */
    readonly settled?: Deferred.Deferred<void>;
  }) => {
    const dispatched: Array<OrchestrationCommand> = [];
    const removed: Array<string> = [];
    const deletedBranches: Array<string> = [];
    const worktreeRequests: Array<VcsCreateWorktreeInput> = [];
    const commitedCwds: Array<string> = [];
    const engineStub = Layer.succeed(OrchestrationEngineService, {
      readEvents: () => Stream.empty,
      dispatch: (command: OrchestrationCommand) =>
        Effect.gen(function* () {
          dispatched.push(command);
          if (
            opts.settled &&
            command.type === "thread.activity.append" &&
            command.activity.kind === WORKTREE_SETUP_ACTIVITY_KIND &&
            (command.activity.payload as WorktreeSetupSnapshot).phase !== "running"
          ) {
            yield* Deferred.succeed(opts.settled, undefined);
          }
          return { sequence: dispatched.length };
        }),
      streamDomainEvents: Stream.empty,
      subscribeDomainEvents: Effect.succeed(Stream.empty),
    } as never);
    const gitStub = Layer.succeed(GitWorkflowService, {
      localStatus: () =>
        Effect.succeed({
          isRepo: opts.checkoutBranch !== undefined,
          refName: opts.checkoutBranch ?? null,
        }),
      commitAll: (cwd: string) =>
        opts.commitFails
          ? Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.commit.commit",
                command: "git commit",
                cwd: "/tmp/parent-worktree",
                detail: "index.lock: File exists",
              }),
            )
          : Effect.sync(() => {
              commitedCwds.push(cwd);
              return { committed: true };
            }),
      createWorktree: (
        input: VcsCreateWorktreeInput,
        options?: GitVcsDriver.CreateWorktreeOptions,
      ) =>
        Effect.gen(function* () {
          worktreeRequests.push(input);
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
      runForThread: () =>
        Effect.succeed(
          opts.scriptCompletion
            ? {
                status: "started" as const,
                scriptId: "setup",
                scriptName: "Setup Worktree",
                scriptCommand: "vp i",
                terminalId: "terminal-1",
                cwd: CHILD_WORKTREE,
                async: true,
                completion: Deferred.await(opts.scriptCompletion),
              }
            : { status: "no-script" as const },
        ),
    } as never);
    const vcsStub = Layer.succeed(VcsStatusBroadcaster, {
      refreshStatus: () => Effect.succeed(undefined),
    } as never);
    const projectionStub = Layer.succeed(ProjectionSnapshotQuery, {
      getProjectShellById: () =>
        Effect.succeed(
          opts.projectWorkspaceRoot === undefined
            ? Option.none()
            : Option.some({ id: projectId, workspaceRoot: opts.projectWorkspaceRoot }),
        ),
    } as never);
    const layer = WorktreeProvisionerLive.pipe(
      Layer.provide(engineStub),
      Layer.provide(gitStub),
      Layer.provide(projectionStub),
      Layer.provide(lockStub),
      Layer.provide(setupStub),
      Layer.provide(vcsStub),
      // Merged rather than provided: the assertions drive the very tracker and
      // lease the provisioner registers its fibre and its hold with.
      Layer.provideMerge(Layer.mergeAll(WorkspaceLeaseLive, WorktreeSetupTrackerLive)),
      Layer.provide(NodeServices.layer),
    );
    return { dispatched, removed, deletedBranches, worktreeRequests, commitedCwds, layer };
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

  // loom: a root on a plain local checkout (project rooted at the repo itself)
  // carries no worktree meta. Its isolated children used to fall back silently
  // to sharing the human's checkout; they now get a real worktree cut from the
  // checkout's CURRENT branch, with the same setup card and fan-in contract.
  it.effect("provisions a checkout-rooted parent's isolated child off the checkout branch", () =>
    Effect.gen(function* () {
      const { dispatched, worktreeRequests, commitedCwds, layer } = harness({
        projectWorkspaceRoot: "/tmp/plain-checkout",
        checkoutBranch: "trunk",
      });
      const provisioned = yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        return yield* provisioner.ensureIsolatedChildProvisioned({
          threadId,
          role: "coder",
          projectId,
          branch: null,
          worktreePath: null,
        });
      }).pipe(Effect.provide(layer));

      expect(provisioned).toBe(true);
      // Branched from the checkout's live branch, not the thread's (absent) meta.
      expect(worktreeRequests).toEqual([
        {
          cwd: "/tmp/plain-checkout",
          refName: "trunk",
          newRefName: `ws/trunk/coder-${threadId.slice(0, 8)}`,
          baseRefName: "trunk",
          path: null,
        },
      ]);
      // Same base-commit snapshot as a worktree parent, so the child branches
      // from an exact HEAD and the fan-in merge-base is clean.
      expect(commitedCwds).toEqual(["/tmp/plain-checkout"]);
      expect(
        dispatched.some((c) => c.type === "thread.meta.update" && c.branch === CHILD_BRANCH),
      ).toBe(true);
      // The setup card runs on the identical path (PR #228).
      expect(setupSnapshots(dispatched).map((snapshot) => snapshot.phase)).toEqual([
        "running",
        "done",
      ]);
    }),
  );

  // No branch to cut from and none to fan back into: the shared fallback stands
  // rather than parking the child.
  it.effect("leaves the child shared when the project root is not a git checkout", () =>
    Effect.gen(function* () {
      const { dispatched, worktreeRequests, layer } = harness({
        projectWorkspaceRoot: "/tmp/not-a-repo",
      });
      const provisioned = yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        return yield* provisioner.ensureIsolatedChildProvisioned({
          threadId,
          role: "coder",
          projectId,
          branch: null,
          worktreePath: null,
        });
      }).pipe(Effect.provide(layer));

      expect(provisioned).toBe(true);
      expect(worktreeRequests).toEqual([]);
      expect(setupSnapshots(dispatched)).toEqual([]);
    }),
  );

  it.effect("provisions and clears the failure marker on success", () =>
    Effect.gen(function* () {
      const { dispatched, worktreeRequests, layer } = harness({});
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
      // A worktree-backed parent still branches off its own meta, not a git read.
      expect(worktreeRequests.map((request) => [request.cwd, request.refName])).toEqual([
        ["/tmp/parent-worktree", "main"],
      ]);
      // The child was repointed to its own worktree/branch.
      expect(
        dispatched.some((c) => c.type === "thread.meta.update" && c.branch === CHILD_BRANCH),
      ).toBe(true);
      // Running then settled, upserted under the one activity id the setup card
      // reads after a reload.
      const snapshots = setupSnapshots(dispatched);
      expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["running", "done"]);
      expect(snapshots.at(-1)?.worktreePath).toBe(CHILD_WORKTREE);
      // `agent: done` is the shared "the agent has taken over" signal
      // (`worktreeSetupAgentStarted`). Without it a child whose async setup
      // script is still installing reads as "still preparing" everywhere, and
      // the startup reconciler would settle a healthy child as failed.
      expect(snapshots.at(-1)?.stages.find((stage) => stage.id === "agent")?.status).toBe("done");
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

  // The child's kickoff turn starts the moment provisioning returns, so from
  // then on a client renders the card from the projection alone (the live
  // stream is only attached while the thread has no turn). The record must
  // therefore carry the handed-off state, or the card shows four pending
  // stages and a Cancel button whose cancel has already been refused.
  it.effect("publishes the handed-off record while an async setup script still runs", () =>
    Effect.gen(function* () {
      const scriptCompletion = yield* Deferred.make<
        { readonly exitCode: number | null },
        SetupError
      >();
      const { dispatched, layer } = harness({ scriptCompletion });

      const cancelled = yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        yield* provisioner.ensureIsolatedChildProvisioned({
          threadId,
          role: "coder",
          projectId,
          branch: "main",
          worktreePath: "/tmp/parent-worktree",
        });
        // The script is still running, so the setup has not settled: this is
        // exactly the window the live tester saw a dead Cancel in.
        return yield* (yield* WorktreeSetupTracker).cancel(threadId);
      }).pipe(Effect.provide(layer));

      expect(cancelled).toBe(false);
      const snapshots = setupSnapshots(dispatched);
      expect(snapshots.map((snapshot) => snapshot.phase)).toEqual(["running", "running"]);
      const handedOff = snapshots.at(-1)!;
      // `agent: done` is what tells every client the cancel window is over.
      expect(handedOff.stages.find((stage) => stage.id === "agent")?.status).toBe("done");
      expect(handedOff.stages.find((stage) => stage.id === "checkout")?.status).toBe("done");
      expect(handedOff.stages.find((stage) => stage.id === "setup-script")?.status).toBe("running");
      expect(handedOff.worktreePath).toBe(CHILD_WORKTREE);
      expect(handedOff.setupScript?.terminalId).toBe("terminal-1");
    }),
  );

  // A child that finishes before its setup script does has its terminals torn
  // down with it; the runner then reports the vanished terminal as a failure,
  // which used to end the card on "setup script failed" for a perfectly
  // healthy child.
  it.effect("records a torn-down setup terminal as a warning, not a failed script", () =>
    Effect.gen(function* () {
      const scriptCompletion = yield* Deferred.make<
        { readonly exitCode: number | null },
        SetupError
      >();
      const settled = yield* Deferred.make<void>();
      const { dispatched, layer } = harness({ scriptCompletion, settled });

      yield* Effect.gen(function* () {
        const provisioner = yield* WorktreeProvisioner;
        yield* provisioner.ensureIsolatedChildProvisioned({
          threadId,
          role: "coder",
          projectId,
          branch: "main",
          worktreePath: "/tmp/parent-worktree",
        });
        yield* Deferred.fail(scriptCompletion, {
          _tag: "ProjectSetupScriptOperationError",
          cause: new Error("Setup terminal exited before the setup command completed."),
        });
        yield* Deferred.await(settled);
      }).pipe(Effect.provide(layer));

      const final = setupSnapshots(dispatched).at(-1)!;
      expect(final.phase).toBe("done");
      expect(final.stages.find((stage) => stage.id === "setup-script")?.status).toBe("warning");
      // Tone follows the stages, so the thread's activity is not an error either.
      expect(
        dispatched.findLast(
          (c) =>
            c.type === "thread.activity.append" && c.activity.kind === WORKTREE_SETUP_ACTIVITY_KIND,
        ),
      ).toMatchObject({ activity: { tone: "info" } });
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
