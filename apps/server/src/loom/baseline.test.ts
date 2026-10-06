// @effect-diagnostics nodeBuiltinImport:off
/**
 * The Loom turn baseline (Phase 3 plan P3-17, smoke step 23) on a real git repo:
 * two Loom threads share one checkout; B edits a file between A's run 1 and run 2.
 * A's run-2 baseline is its own start-of-run snapshot, so A's file summary and turn
 * diff exclude B's edit; a thread without a sidecar keeps upstream's previous-checkpoint
 * base. Rollback in a shared checkout is upstream's `isCheckpointRestoreIsolated`.
 */
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointScopeId,
  CommandId,
  NodeId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2CheckpointScope,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";

import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import { isCheckpointRestoreIsolated } from "../orchestration-v2/CheckpointRestoreSafety.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  seedThread,
  testModelSelection,
} from "./testkit/loomOrchestratorLayer.ts";

const VcsProcessLive = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const CheckpointStoreLive = CheckpointStore.layer.pipe(
  Layer.provideMerge(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessLive))),
  Layer.provide(ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-loom-baseline-" })),
  Layer.provide(NodeServices.layer),
);
const TestLayer = Layer.mergeAll(
  CheckpointService.layer.pipe(Layer.provide(IdAllocator.layer)),
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(
  Layer.provideMerge(Layer.mergeAll(CheckpointStoreLive, VcsProcessLive)),
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

const projectId = ProjectId.make("project:loom-test");
const at = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.flatMap(VcsProcess.VcsProcess, (process) =>
    process.run({ operation: "loom.baseline.test.git", command: "git", cwd, args, timeoutMs: 10_000 }),
  );

const write = (cwd: string, file: string, text: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) =>
    fs.writeFileString(NodePath.join(cwd, file), text),
  );

/** A Loom child (sidecar row via the arm); it inherits its parent's worktree. */
const spawnInCheckout = (threadId: ThreadId, parentThreadId: ThreadId, cwd: string) =>
  Effect.gen(function* () {
    yield* dispatch({
      type: "thread.spawn",
      commandId: CommandId.make(`server:test-spawn:${threadId}`),
      threadId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
      createdBy: "agent",
      creationSource: "mcp",
      parentThreadId,
      projectId,
      title: `Child ${threadId}`,
      modelSelection: testModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      role: "coder",
      purpose: "Loom baseline test child",
      goalId: null,
    });
  });

const rootScope = (threadId: ThreadId, cwd: string): OrchestrationV2CheckpointScope => ({
  id: CheckpointScopeId.make(`checkpoint-scope:thread:${threadId}:name:root`),
  threadId,
  runId: RunId.make(`run:${threadId}:1`),
  nodeId: NodeId.make(`node:${threadId}:1`),
  parentScopeId: null,
  providerThreadId: ProviderThreadId.make(`provider-thread:${threadId}`),
  kind: "root_run",
  ordinalWithinParent: 0,
  advancesAppRunCount: true,
  cwd,
  createdAt: at,
});

/** One run as RunExecutionService + CheckpointCaptureService drive it: baseline, edit, capture. */
const runTurn = (
  scope: OrchestrationV2CheckpointScope,
  ordinal: number,
  edit: Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: ordinal - 1 });
    yield* edit;
    return yield* checkpoints.capture({
      scope,
      runId: RunId.make(`run:${scope.threadId}:${ordinal}`),
      nodeId: NodeId.make(`node:${scope.threadId}:${ordinal}`),
      ordinalWithinScope: ordinal,
      appRunOrdinal: ordinal,
      capturedAt: at,
    });
  });

const turnDiff = (
  scope: OrchestrationV2CheckpointScope,
  captured: ReadonlyArray<OrchestrationV2Checkpoint>,
  toTurnCount: number,
) =>
  Effect.gen(function* () {
    const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
    return yield* query.getTurnDiff({
      threadId: scope.threadId,
      fromTurnCount: toTurnCount - 1,
      toTurnCount,
    });
  }).pipe(
    Effect.provide(
      CheckpointDiffQuery.layer.pipe(
        Layer.provide(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getCheckpointContext: () =>
              Effect.succeed({
                runs: captured.map((checkpoint) => ({
                  id: checkpoint.runId!,
                  ordinal: checkpoint.appRunOrdinal!,
                  status: "completed" as const,
                })),
                checkpointScopes: [
                  { id: scope.id, runId: scope.runId, kind: "root_run" as const, cwd: scope.cwd },
                ],
                checkpoints: captured,
              }),
          }),
        ),
      ),
    ),
  );

it.layer(TestLayer)("Loom turn baseline in a shared checkout", (it) => {
  it.effect("A's run-2 diff excludes B's between-run edit; a plain thread keeps upstream's base", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const store = yield* CheckpointStore.CheckpointStore;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "loom-baseline-" });
      yield* git(cwd, ["init"]);
      yield* git(cwd, ["config", "user.email", "test@test.com"]);
      yield* git(cwd, ["config", "user.name", "Test"]);
      yield* write(cwd, "README.md", "# shared\n");
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "initial"]);

      const root = ThreadId.make("baseline-root");
      const a = ThreadId.make("baseline-a");
      const b = ThreadId.make("baseline-b");
      const plain = ThreadId.make("baseline-plain");
      yield* seedThread({ threadId: root });
      yield* spawnInCheckout(a, root, cwd);
      yield* spawnInCheckout(b, root, cwd);
      yield* seedThread({ threadId: plain });
      const scopeA = rootScope(a, cwd);
      const scopePlain = rootScope(plain, cwd);

      const a1 = yield* runTurn(scopeA, 1, write(cwd, "a1.txt", "a1\n"));
      const plain1 = yield* runTurn(scopePlain, 1, write(cwd, "plain1.txt", "p1\n"));
      // B works in the shared tree between A's (and the plain thread's) runs.
      yield* write(cwd, "b.txt", "b\n");
      const a2 = yield* runTurn(scopeA, 2, write(cwd, "a2.txt", "a2\n"));
      const plain2 = yield* runTurn(scopePlain, 2, write(cwd, "plain2.txt", "p2\n"));

      const hasRef = (scope: OrchestrationV2CheckpointScope, ordinalWithinScope: number) =>
        store.hasCheckpointRef({
          cwd,
          checkpointRef: CheckpointService.loomBaselineRef({ scopeId: scope.id, ordinalWithinScope }),
        });
      assert.match(
        CheckpointService.loomBaselineRef({ scopeId: scopeA.id, ordinalWithinScope: 1 }),
        /^refs\/t3\/loom-baseline\/[A-Za-z0-9_-]+\/1$/,
      );
      assert.isTrue(yield* hasRef(scopeA, 1));
      assert.isFalse(yield* hasRef(scopePlain, 1));

      // The file summary: A's run 2 is only A's work; the plain thread's still carries B's edit.
      assert.deepEqual(
        a2.files.map((file) => file.path),
        ["a2.txt"],
      );
      assert.deepEqual(
        plain2.files.map((file) => file.path).toSorted(),
        ["a2.txt", "b.txt", "plain2.txt"],
      );

      // The Diff panel's one-run diff.
      const diffA = (yield* turnDiff(scopeA, [a1, a2], 2)).diff;
      assert.include(diffA, "a2.txt");
      assert.notInclude(diffA, "b.txt");
      const diffPlain = (yield* turnDiff(scopePlain, [plain1, plain2], 2)).diff;
      assert.include(diffPlain, "b.txt");
    }).pipe(Effect.scoped),
  );

  it.effect("file restore is refused while another thread occupies the checkout (upstream's rule)", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dependencies = {
        fileSystem: fs,
        projections: yield* ProjectionStore.ProjectionStoreV2,
        projects: yield* ProjectStore.ProjectStoreV2,
        path: yield* Path.Path,
      };
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "loom-rollback-" });
      const root = ThreadId.make("rollback-root");
      const child = ThreadId.make("rollback-child");
      yield* seedThread({ threadId: ThreadId.make("rollback-project-seed") });
      // A root working in its own checkout; its children inherit the worktree (shared checkout).
      yield* dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make(`command:seed-thread:${root}`),
        threadId: root,
        projectId,
        title: "Rollback root",
        modelSelection: testModelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: cwd,
      });
      const isolated = isCheckpointRestoreIsolated({ id: root, worktreePath: cwd }, { cwd }, dependencies);
      assert.isTrue(yield* isolated);

      yield* spawnInCheckout(child, root, cwd);
      assert.isFalse(yield* isolated);
      // A finished occupant still left its edits in the tree: restoring the root's snapshot
      // would revert them, so upstream keeps refusing.
      yield* dispatch({
        type: "thread.outcome.set",
        commandId: CommandId.make("rollback-child-done"),
        threadId: child,
        createdAt: DateTime.formatIso(yield* DateTime.now),
        outcome: "done",
      });
      assert.isFalse(yield* isolated);
    }).pipe(Effect.scoped),
  );
});
