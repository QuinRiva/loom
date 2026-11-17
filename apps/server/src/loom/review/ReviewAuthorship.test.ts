/**
 * Authorship on a real temp repository and the real orchestrator, one case per row of the plan's
 * naming table (plans/diff-author-query/plan.mdx §3): each changed line is given the commit and
 * thread that wrote it, or none.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the fixture repo is built with plain git and fs
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  type LoomReviewAuthorshipResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { authorOf } from "@t3tools/shared/reviewAuthorship.loom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  testModelSelection,
} from "../testkit/loomOrchestratorLayer.ts";
import * as ReviewAuthorship from "./ReviewAuthorship.ts";

// The agent git shim adds this session's own trailer when LOOM_THREAD_ID is set; clear it.
const GIT_ENV = { ...process.env, LOOM_THREAD_ID: "", GIT_COMMITTER_NAME: "t" };
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV }).trim();
const write = (cwd: string, file: string, lines: ReadonlyArray<string>) =>
  NodeFS.writeFileSync(NodePath.join(cwd, file), `${lines.join("\n")}\n`);
const commit = (
  cwd: string,
  subject: string,
  author: string,
  trailers: ReadonlyArray<string> = [],
) => {
  git(cwd, "add", "-A");
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      subject,
      ...trailers.flatMap((thread) => ["--trailer", `Loom-Thread: ${thread}`]),
    ],
    { cwd, env: { ...GIT_ENV, GIT_AUTHOR_NAME: author } },
  );
  return git(cwd, "rev-parse", "HEAD");
};

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-authors-" });
const TestLayer = ReviewAuthorship.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(
    GitVcsDriver.layer.pipe(
      Layer.provide(ServerConfigLayer),
      Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
  ),
);

let counter = 0;
const createThread = Effect.fn("test.createThread")(function* (
  worktree: string,
  title: string,
  projectId: ProjectId | null = null,
) {
  const id = ++counter;
  const project = projectId ?? ProjectId.make(`project:authors-${id}`);
  if (projectId === null)
    yield* (yield* ProjectService.ProjectService).create({
      commandId: CommandId.make(`command:authors-project-${id}`),
      projectId: project,
      title: "Authorship test project",
      workspaceRoot: worktree,
    });
  const threadId = ThreadId.make(`thread:authors-${id}`);
  yield* dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:authors-thread-${id}`),
    threadId,
    projectId: project,
    title,
    modelSelection: testModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: worktree,
  });
  return { threadId, projectId: project };
});

/** The commit and author each new-side line of `path` is given, or null. */
const linesOf = (result: LoomReviewAuthorshipResult, path: string) => {
  const file = result.files.find((candidate) => candidate.path === path);
  return (line: number) => {
    if (file?.untracked) return "uncommitted";
    const run = file?.runs.find(([start, end]) => start <= line && line <= end);
    if (run === undefined) return null;
    if (run[2] === -1) return "uncommitted";
    const owner = result.commits[run[2]]!;
    const author = authorOf(owner, result.threads);
    return {
      sha: owner.sha,
      author:
        author.kind === "thread"
          ? `thread ${author.thread.title}`
          : author.kind === "threads"
            ? `threads ${author.threadIds.length}`
            : `git ${author.name}`,
    };
  };
};

it.layer(TestLayer)("Loom review authorship", (it) => {
  it.effect("names each changed line's commit and thread, or none, per the naming rule", () =>
    Effect.gen(function* () {
      const authorship = yield* ReviewAuthorship.ReviewAuthorship;
      const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-authors-"));
      git(worktree, "init", "-q", "-b", "main");
      write(worktree, "app.ts", ["a", "b", "c", "d", "e"]);
      write(worktree, "gone.ts", ["x", "y"]);
      commit(worktree, "base", "Owner");
      git(worktree, "checkout", "-q", "-b", "feature");

      const reviewer = yield* createThread(worktree, "Reviewer");
      const coder = yield* createThread(worktree, "Coder", reviewer.projectId);
      const archived = yield* createThread(worktree, "Archived coder", reviewer.projectId);
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`command:${archived.threadId}:archive`),
        threadId: archived.threadId,
      });
      const unknown = "thread:not-on-this-server";

      // One trailer naming a held thread; then one naming an archived thread.
      write(worktree, "app.ts", ["a", "B1", "c", "d", "e"]);
      const byCoder = commit(worktree, "coder writes B1", "Loom agent", [coder.threadId]);
      write(worktree, "app.ts", ["a", "B1", "c", "D1", "e"]);
      const byArchived = commit(worktree, "archived writes D1", "Loom agent", [archived.threadId]);
      // Two trailers (an amend by a second thread); no trailer; an unknown thread.
      write(worktree, "app.ts", ["a", "B1", "c", "D1", "e", "f"]);
      const amended = commit(worktree, "amended", "Loom agent", [
        coder.threadId,
        archived.threadId,
      ]);
      write(worktree, "app.ts", ["a", "B1", "c", "D1", "e", "f", "g"]);
      const byOwner = commit(worktree, "owner adds g", "Owner");
      write(worktree, "app.ts", ["a", "B1", "c", "D1", "e", "f", "g", "h"]);
      const byUnknown = commit(worktree, "unknown adds h", "Loom agent", [unknown]);
      // A file whose branch change only removes lines; one not yet committed; one not yet added.
      write(worktree, "gone.ts", ["x"]);
      commit(worktree, "drop y", "Loom agent", [coder.threadId]);
      write(worktree, "app.ts", ["a", "B1", "c", "D1", "e", "f", "g", "h", "dirty"]);
      write(worktree, "fresh.ts", ["new"]);

      const result = yield* authorship.authorship({ threadId: reviewer.threadId, baseRef: null });
      assert.equal(result.mergeBase, git(worktree, "merge-base", "main", "HEAD"));
      assert.equal(result.headSha, git(worktree, "rev-parse", "HEAD"));
      assert.isFalse(result.incomplete);
      const line = linesOf(result, "app.ts");
      // Lines older than the merge base have no author.
      assert.isNull(line(1));
      assert.isNull(line(3));
      assert.deepEqual(line(2), { sha: byCoder, author: "thread Coder" });
      assert.deepEqual(line(4), { sha: byArchived, author: "thread Archived coder" });
      assert.deepEqual(line(6), { sha: amended, author: "threads 2" });
      assert.deepEqual(line(7), { sha: byOwner, author: "git Owner" });
      assert.deepEqual(line(8), { sha: byUnknown, author: "git Loom agent" });
      assert.equal(line(9), "uncommitted");
      assert.equal(linesOf(result, "fresh.ts")(1), "uncommitted");
      // Only-removed lines leave no line to attribute.
      assert.isUndefined(result.files.find((file) => file.path === "gone.ts"));

      assert.deepEqual(
        result.threads.map((thread) => [thread.title, thread.archived]),
        [
          ["Coder", false],
          ["Archived coder", true],
        ],
      );
      // Only commits that own a surviving line; oldest first.
      assert.deepEqual(
        result.commits.map((entry) => entry.sha),
        [byCoder, byArchived, amended, byOwner, byUnknown],
      );

      // Line history: newest first; nothing for a file that differs from HEAD.
      const history = yield* authorship.lineHistory({
        threadId: reviewer.threadId,
        baseRef: "main",
        path: "app.ts",
        startLine: 2,
        endLine: 4,
      });
      assert.deepEqual(history, { commits: [], threads: [] });
      git(worktree, "checkout", "--", "app.ts");
      write(worktree, "app.ts", ["a", "B2", "c", "D1", "e", "f", "g", "h"]);
      const rewrite = commit(worktree, "reviewer rewrites B", "Loom agent", [reviewer.threadId]);
      const rewritten = yield* authorship.lineHistory({
        threadId: reviewer.threadId,
        baseRef: "main",
        path: "app.ts",
        startLine: 2,
        endLine: 2,
      });
      assert.deepEqual(
        rewritten.commits.map((entry) => entry.sha),
        [rewrite, byCoder],
      );
      assert.deepEqual(
        rewritten.threads.map((thread) => thread.title),
        ["Reviewer", "Coder"],
      );
    }),
  );

  it.effect("a thread outside a repository has no authors", () =>
    Effect.gen(function* () {
      const authorship = yield* ReviewAuthorship.ReviewAuthorship;
      const folder = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-authors-"));
      const { threadId } = yield* createThread(folder, "Plain folder");
      const result = yield* authorship.authorship({ threadId, baseRef: null });
      assert.deepEqual(result.files, []);
      assert.isNull(result.mergeBase);
    }),
  );
});
