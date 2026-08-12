import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitCommandError,
  type OrchestrationCommand,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import { WorktreeProvisioner, layer as WorktreeProvisionerLive } from "./WorktreeProvisioner.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { WorktreeMutationLock } from "../git/WorktreeMutationLock.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectSetupScriptRunner } from "./ProjectSetupScriptRunner.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { layer as WorkspaceLeaseLive } from "../workspace/WorkspaceLease.ts";

// ensureIsolatedChildProvisioned is the shared turn-start guard (item 4): it
// (re)provisions an isolated child's worktree and, on failure, parks the child
// (needs_guidance) so it never fails to the caller — the invariant that keeps a
// turn from starting against an unprovisioned isolated child.
describe("ensureIsolatedChildProvisioned", () => {
  const threadId = ThreadId.make("child-iso-1");
  const projectId = ProjectId.make("project-1");

  const harness = (opts: { readonly commitFails: boolean }) => {
    const dispatched: Array<OrchestrationCommand> = [];
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
      createWorktree: () =>
        Effect.succeed({
          worktree: { path: "/tmp/child-worktree", refName: "ws/main/coder-child-is" },
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
      Layer.provide(WorkspaceLeaseLive),
      Layer.provide(NodeServices.layer),
    );
    return { dispatched, layer };
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
      }),
  );

  it.effect("provisions and clears the failure marker on success", () =>
    Effect.gen(function* () {
      const { dispatched, layer } = harness({ commitFails: false });
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
        dispatched.some(
          (c) => c.type === "thread.meta.update" && c.branch === "ws/main/coder-child-is",
        ),
      ).toBe(true);
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
          branch: "ws/main/coder-child-is",
          worktreePath: "/tmp/child-worktree",
        });
      }).pipe(Effect.provide(layer));

      expect(provisioned).toBe(true);
      // No git op ran and no command was dispatched — a pure no-op.
      expect(dispatched).toHaveLength(0);
    }),
  );
});
