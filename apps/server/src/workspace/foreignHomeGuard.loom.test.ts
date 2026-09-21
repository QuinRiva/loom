// @effect-diagnostics nodeBuiltinImport:off
// loom: the guard that stops a server booted on a COPY of another home's
// database from mutating that home's live checkouts. See
// `foreignHomeGuard.loom.ts` and the DB-copy recipe in docs/dev-site-testing.md.
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodePath from "node:path";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ServerConfig } from "../config.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { layer as WorktreeMutationLockLive } from "../git/WorktreeMutationLock.ts";
import { performWorktreeRemoval } from "../orchestration/worktreeRemoval.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { layer as WorkspaceLeaseLive } from "./WorkspaceOccupancyLease.ts";
import {
  detectForeignDatabase,
  isForeignDatabase,
  setForeignDatabaseForTest,
} from "./foreignHomeGuard.loom.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-foreign-home-guard-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provideMerge(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const initRepoWithCommit = (cwd: string) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const fileSystem = yield* FileSystem.FileSystem;
    const run = (args: ReadonlyArray<string>) =>
      driver.execute({ operation: "foreign-home-guard.test", cwd, args, timeoutMs: 10_000 });
    yield* driver.initRepo({ cwd });
    yield* run(["config", "user.email", "test@test.com"]);
    yield* run(["config", "user.name", "Test"]);
    yield* fileSystem.writeFileString(NodePath.join(cwd, "README.md"), "# test\n");
    yield* run(["add", "."]);
    yield* run(["commit", "-m", "initial commit"]);
    return (yield* run(["branch", "--show-current"])).stdout.trim();
  });

describe("foreign-home guard", () => {
  it.effect("treats a database whose worktree paths are all elsewhere as foreign", () =>
    Effect.gen(function* () {
      yield* detectForeignDatabase({
        worktreesDir: "/home/me/.t3/dev/worktrees",
        recordedWorktreePaths: ["/home/someone/.t3/cockpit/worktrees/repo/ws-coder-1"],
      });
      assert.isTrue(isForeignDatabase());

      // One recorded path inside our own worktrees dir is proof of ownership.
      yield* detectForeignDatabase({
        worktreesDir: "/home/me/.t3/dev/worktrees",
        recordedWorktreePaths: [
          "/home/someone/.t3/cockpit/worktrees/repo/ws-coder-1",
          "/home/me/.t3/dev/worktrees/repo/ws-coder-2",
        ],
      });
      assert.isFalse(isForeignDatabase());

      // A database with no worktrees at all has no foreign checkout to damage.
      yield* detectForeignDatabase({
        worktreesDir: "/home/me/.t3/dev/worktrees",
        recordedWorktreePaths: [],
      });
      assert.isFalse(isForeignDatabase());
    }),
  );

  // The location rule, on the remover that acts on RECORDED paths (the reaper and
  // the maintenance panel both go through it).
  it.layer(
    Layer.mergeAll(WorktreeMutationLockLive, WorkspaceLeaseLive, ServerConfigLayer).pipe(
      Layer.provideMerge(NodeServices.layer),
    ),
  )("performWorktreeRemoval", (it) => {
    it.effect("removes a recorded path this home owns and refuses one it does not", () =>
      Effect.gen(function* () {
        setForeignDatabaseForTest(null);
        const config = yield* ServerConfig;
        const path = yield* Path.Path;
        const removals: Array<string> = [];
        const branches: Array<string> = [];
        const gitLayer = Layer.succeed(GitWorkflowService, {
          removeWorktree: (input: { readonly path: string }) =>
            Effect.sync(() => void removals.push(input.path)),
          deleteBranch: (input: { readonly branch: string }) =>
            Effect.sync(() => void branches.push(input.branch)),
        } as never);
        const remove = (worktreePath: string) =>
          performWorktreeRemoval({
            cwd: "/repo",
            path: worktreePath,
            branch: "ws/main/coder-1",
            forceWorktree: false,
            deleteBranchWhenMerged: true,
          }).pipe(Effect.provide(gitLayer));

        const owned = path.join(config.worktreesDir, "repo", "ws-coder-1");
        assert.isTrue((yield* remove(owned))._tag === "Some");
        assert.deepStrictEqual(removals, [owned]);
        assert.deepStrictEqual(branches, ["ws/main/coder-1"]);

        // A path this home never created: another home's live checkout, as a
        // copied database records it. Neither the checkout nor its branch is touched.
        assert.isTrue(
          (yield* remove("/home/someone/.t3/cockpit/worktrees/repo/ws-coder-2"))._tag === "None",
        );
        assert.deepStrictEqual(removals, [owned]);
        assert.deepStrictEqual(branches, ["ws/main/coder-1"]);
      }),
    );
  });

  it.layer(TestLayer)("git worktree and branch mutations", (it) => {
    it.effect("refuses every worktree and branch mutation on a foreign database", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const repo = yield* fileSystem.makeTempDirectoryScoped({ prefix: "foreign-home-repo-" });
        const branch = yield* initRepoWithCommit(repo);
        const owned = yield* driver.createWorktree({
          cwd: repo,
          refName: branch,
          newRefName: "doomed-branch",
          path: null,
        });

        setForeignDatabaseForTest({
          worktreesDir: "/home/me/.t3/dev/worktrees",
          recordedExample: owned.worktree.path,
        });
        const removal = yield* driver
          .removeWorktree({ cwd: repo, path: owned.worktree.path })
          .pipe(Effect.flip);
        assert.include(removal.detail ?? "", "foreign-home guard");
        yield* driver.deleteBranch({ cwd: repo, branch: "doomed-branch", force: false });
        yield* driver.pruneWorktrees({ cwd: repo });
        setForeignDatabaseForTest(null);

        // Nothing moved: the checkout is still registered and the branch still exists.
        assert.isTrue(yield* fileSystem.exists(owned.worktree.path));
        const branches = yield* driver.execute({
          operation: "foreign-home-guard.test",
          cwd: repo,
          args: ["branch", "--list", "doomed-branch"],
          timeoutMs: 10_000,
        });
        assert.include(branches.stdout, "doomed-branch");
      }),
    );
  });
});
