import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

// Real-git integration for the fan-in primitives (worktree-isolation plan §3):
// commitAll, mergeWorktreeBranch (clean + conflict), deleteBranch. These are the
// highest-risk pieces of the fan-in reactor, so they are exercised against a
// temp repo + worktree rather than mocks.

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-git-fanin-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.fanin.test.git",
      cwd,
      args,
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const write = (cwd: string, rel: string, contents: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const filePath = path.join(cwd, rel);
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fs.writeFileString(filePath, contents);
  });

const readFile = (cwd: string, rel: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(cwd, rel));
  });

const initRepo = (
  cwd: string,
): Effect.Effect<
  string,
  GitCommandError | import("effect/PlatformError").PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* write(cwd, "README.md", "# base\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial"]);
    return yield* git(cwd, ["branch", "--show-current"]);
  });

const makeTmp = (prefix: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.makeTempDirectoryScoped({ prefix }));

it.layer(TestLayer)("GitVcsDriver fan-in primitives", (it) => {
  it.effect("commitAll reports committed only when the tree is dirty", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmp("fanin-commitall-");
      yield* initRepo(cwd);

      const clean = yield* driver.commitAll(cwd, "wip: nothing", "");
      assert.strictEqual(clean.committed, false);
      assert.strictEqual(clean.commitSha, null);

      yield* write(cwd, "a.txt", "hello\n");
      const dirty = yield* driver.commitAll(cwd, "wip: snapshot", "");
      assert.strictEqual(dirty.committed, true);
      assert.notStrictEqual(dirty.commitSha, null);
      // The new file is now tracked at HEAD.
      const tracked = yield* git(cwd, ["ls-files", "a.txt"]);
      assert.strictEqual(tracked, "a.txt");
    }).pipe(Effect.scoped),
  );

  // Regression: repos with a failing pre-commit hook (this fork installs
  // vite-plus hooks via `core.hooksPath`, and `vp fmt` exits 1 when the staged
  // set has zero formattable files) must not break machine-generated snapshots.
  // commitAll passes `--no-verify`, so the hook never runs.
  it.effect("commitAll bypasses a failing pre-commit hook", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const cwd = yield* makeTmp("fanin-noverify-");
      yield* initRepo(cwd);

      const hooksDir = path.join(cwd, ".githooks");
      yield* fs.makeDirectory(hooksDir, { recursive: true });
      const hookPath = path.join(hooksDir, "pre-commit");
      yield* fs.writeFileString(hookPath, "#!/bin/sh\nexit 1\n");
      yield* fs.chmod(hookPath, 0o755);
      yield* git(cwd, ["config", "core.hooksPath", hooksDir]);

      // Sanity: a plain `git commit` is blocked by the hook.
      yield* write(cwd, "a.txt", "hello\n");
      yield* git(cwd, ["add", "-A"]);
      const blocked = yield* git(cwd, ["commit", "-m", "blocked"]).pipe(Effect.flip);
      assert.instanceOf(blocked, GitCommandError);

      // commitAll snapshots the same tree successfully despite the hook.
      const result = yield* driver.commitAll(cwd, "wip: snapshot", "");
      assert.strictEqual(result.committed, true);
      assert.notStrictEqual(result.commitSha, null);
      const tracked = yield* git(cwd, ["ls-files", "a.txt"]);
      assert.strictEqual(tracked, "a.txt");
    }).pipe(Effect.scoped),
  );

  it.effect("mergeWorktreeBranch merges a child branch back with --no-ff", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const path = yield* Path.Path;
      const parentCwd = yield* makeTmp("fanin-merge-parent-");
      const parentBranch = yield* initRepo(parentCwd);
      // Nest the worktree under a scoped dir so `git worktree remove` deleting it
      // does not race the scope's own recursive cleanup of the scoped dir.
      const childPath = path.join(yield* makeTmp("fanin-merge-child-"), "wt");

      // Provision a child worktree on its own branch off the parent branch.
      yield* driver.createWorktree({
        cwd: parentCwd,
        refName: parentBranch,
        newRefName: "ws/child",
        path: childPath,
      });
      yield* write(childPath, "child.txt", "child work\n");
      yield* driver.commitAll(childPath, "wip(coder): child", "");

      const result = yield* driver.mergeWorktreeBranch({
        cwd: parentCwd,
        branch: "ws/child",
        subject: "merge ws/child",
      });
      assert.strictEqual(result.status, "merged");
      assert.deepStrictEqual([...result.conflictPaths], []);
      // The parent branch now contains the child's file and a merge commit.
      const parentFile = yield* readFile(parentCwd, "child.txt");
      assert.strictEqual(parentFile, "child work\n");
      const parents = yield* git(parentCwd, ["rev-list", "--parents", "-n", "1", "HEAD"]);
      assert.strictEqual(parents.split(" ").length, 3, "HEAD should be a 2-parent merge commit");

      // The fully-merged branch can then be removed + deleted (worktree first,
      // mirroring the reactor: git refuses to delete a checked-out branch).
      yield* driver.removeWorktree({ cwd: parentCwd, path: childPath, force: true });
      yield* driver.deleteBranch({ cwd: parentCwd, branch: "ws/child" });
      const branches = yield* git(parentCwd, ["branch", "--list", "ws/child"]);
      assert.strictEqual(branches, "");
    }).pipe(Effect.scoped),
  );

  it.effect("mergeWorktreeBranch aborts and reports paths on a conflict", () =>
    Effect.gen(function* () {
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const parentCwd = yield* makeTmp("fanin-conflict-parent-");
      const parentBranch = yield* initRepo(parentCwd);
      const childPath = yield* makeTmp("fanin-conflict-child-");

      yield* driver.createWorktree({
        cwd: parentCwd,
        refName: parentBranch,
        newRefName: "ws/child",
        path: childPath,
      });
      // Both sides edit the same file on the same line → conflict.
      yield* write(childPath, "README.md", "# child edit\n");
      yield* driver.commitAll(childPath, "wip(coder): child edit", "");
      yield* write(parentCwd, "README.md", "# parent edit\n");
      yield* driver.commitAll(parentCwd, "wip: parent edit", "");

      const result = yield* driver.mergeWorktreeBranch({
        cwd: parentCwd,
        branch: "ws/child",
        subject: "merge ws/child",
      });
      assert.strictEqual(result.status, "conflict");
      assert.deepStrictEqual([...result.conflictPaths], ["README.md"]);
      // The merge was aborted: the working tree is clean, no MERGE_HEAD.
      const status = yield* git(parentCwd, ["status", "--porcelain"]);
      assert.strictEqual(status, "");
      const parentContent = yield* readFile(parentCwd, "README.md");
      assert.strictEqual(parentContent, "# parent edit\n");
    }).pipe(Effect.scoped),
  );
});
