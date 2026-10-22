/**
 * Review snapshots on a real temp worktree (a nested repo and an ignored artefact folder) and
 * the real orchestrator: a human message snapshots every source once, an agent or scheduled-task
 * message and a stale event none; the nested ref lands in the nested store; the cap drops the
 * oldest; archive and the quiet sweep (after the worktree is gone) delete every ref and row.
 */
// @effect-diagnostics nodeBuiltinImport:off -- the fixture repo is built with plain git and fs
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  dispatch,
  LoomOrchestratorTestLayer,
  testModelSelection,
} from "../testkit/loomOrchestratorLayer.ts";
import { reactToReviewEvent } from "./ReviewSnapshotReactor.ts";
import * as ReviewSnapshotService from "./ReviewSnapshotService.ts";

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commitAll = (cwd: string) => {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "c");
};
const reviewRefs = (cwd: string) =>
  git(cwd, "for-each-ref", "--format=%(refname)", ReviewSnapshotService.REVIEW_REFS_PREFIX)
    .split("\n")
    .filter((ref) => ref !== "");

/** worktree/ (repo) · worktree/workbench (nested, ignored) · worktree/.artifacts (ignored) */
const makeWorktree = () => {
  const worktree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-snapshot-"));
  git(worktree, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(worktree, ".gitignore"), "workbench/\n.artifacts/\n");
  NodeFS.writeFileSync(NodePath.join(worktree, "app.ts"), "export const a = 1;\n");
  commitAll(worktree);
  const workbench = NodePath.join(worktree, "workbench");
  NodeFS.mkdirSync(workbench);
  git(workbench, "init", "-q", "-b", "main");
  NodeFS.writeFileSync(NodePath.join(workbench, "notes.md"), "# notes\n");
  commitAll(workbench);
  NodeFS.mkdirSync(NodePath.join(worktree, ".artifacts"));
  NodeFS.writeFileSync(NodePath.join(worktree, ".artifacts", "report.html"), "<p>1</p>\n");
  return { worktree, workbench };
};

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-snapshot-" });
const VcsProcessLayer = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const GitLayers = Layer.mergeAll(
  CheckpointStore.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcessLayer))),
  ),
  GitVcsDriver.layer,
).pipe(Layer.provide(ServerConfigLayer), Layer.provideMerge(NodeServices.layer));
const TestLayer = ReviewSnapshotService.layer.pipe(
  Layer.provideMerge(ProjectStore.layer),
  Layer.provideMerge(LoomOrchestratorTestLayer),
  Layer.provideMerge(GitLayers),
);

let counter = 0;
const createThread = Effect.fn("test.createThread")(function* (
  worktree: string,
  threadWorktreePath: string | null = worktree,
) {
  const id = ++counter;
  const projectId = ProjectId.make(`project:review-${id}`);
  const threadId = ThreadId.make(`thread:review-${id}`);
  yield* (yield* ProjectService.ProjectService).create({
    commandId: CommandId.make(`command:review-project-${id}`),
    projectId,
    title: "Review test project",
    workspaceRoot: worktree,
  });
  yield* dispatch({
    type: "thread.create",
    createdBy: "user",
    creationSource: "web",
    commandId: CommandId.make(`command:review-thread-${id}`),
    threadId,
    projectId,
    title: "Review test thread",
    modelSelection: testModelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: threadWorktreePath,
  });
  return threadId;
});

/** Dispatches a message and returns the `message.updated` event the reactor would see. */
const send = Effect.fn("test.send")(function* (
  threadId: ThreadId,
  name: string,
  author: { readonly createdBy: "user" | "agent"; readonly scheduledTaskId?: ScheduledTaskId } = {
    createdBy: "user",
  },
) {
  const messageId = MessageId.make(`message:${threadId}:${name}`);
  const { storedEvents } = yield* dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:${threadId}:${name}`),
    threadId,
    messageId,
    text: `[Slack reply from Pele] ${name}`,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
    creationSource: "web",
    ...author,
  });
  const event = storedEvents
    .map((stored) => stored.event)
    .find(
      (candidate): candidate is Extract<OrchestrationV2DomainEvent, { type: "message.updated" }> =>
        candidate.type === "message.updated" && candidate.payload.id === messageId,
    );
  assert.isDefined(event);
  return event!;
});

const react = (event: OrchestrationV2DomainEvent) => reactToReviewEvent(event);

it.layer(TestLayer)("Loom review snapshots", (it) => {
  it.effect("a human message snapshots each source once, into the source's own store", () =>
    Effect.gen(function* () {
      const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
      const { worktree, workbench } = makeWorktree();
      const threadId = yield* createThread(worktree);

      const first = yield* send(threadId, "first");
      yield* react(first);
      const rows = yield* snapshots.listForThread(threadId);
      assert.deepEqual(rows.map((row) => [row.sourceId, row.status]).toSorted(), [
        ["artifacts:.artifacts", "ready"],
        ["nested:workbench", "ready"],
        ["repo", "ready"],
      ]);
      assert.isTrue(rows.every((row) => row.closesFilesChanged === null));
      const nested = rows.find((row) => row.sourceKind === "nested_repo")!;
      // The nested ref is in the nested repo's store, not the outer one.
      assert.deepEqual(reviewRefs(workbench), [nested.ref]);
      assert.equal(git(workbench, "rev-parse", nested.ref), nested.commitOid);
      assert.equal(nested.gitCommonDir, NodeFS.realpathSync(NodePath.join(workbench, ".git")));
      assert.sameMembers(
        reviewRefs(worktree),
        rows.filter((row) => row.sourceKind !== "nested_repo").map((row) => row.ref),
      );
      const artifacts = rows.find((row) => row.sourceKind === "artifact_path")!;
      assert.equal(git(worktree, "show", `${artifacts.ref}:.artifacts/report.html`), "<p>1</p>");
      assert.isNull(artifacts.headOid);
      assert.equal(
        rows.find((row) => row.sourceKind === "repo")!.headOid,
        git(worktree, "rev-parse", "HEAD"),
      );

      // Idempotent on a repeated event.
      yield* react(first);
      assert.lengthOf(yield* snapshots.listForThread(threadId), 3);

      // An agent message and a scheduled-task fire are not human: no snapshot.
      yield* react(yield* send(threadId, "agent", { createdBy: "agent" }));
      yield* react(
        yield* send(threadId, "scheduled", {
          createdBy: "user",
          scheduledTaskId: ScheduledTaskId.make("task:review"),
        }),
      );
      assert.lengthOf(yield* snapshots.listForThread(threadId), 3);

      // A stale event (a re-emission, or one replayed after a restart) is never captured late.
      const late = yield* send(threadId, "late");
      yield* TestClock.adjust("1 minute");
      yield* react(late);
      assert.lengthOf(yield* snapshots.listForThread(threadId), 3);

      // Edits in every source: the next snapshot records what each one changed.
      NodeFS.writeFileSync(NodePath.join(worktree, "app.ts"), "export const a = 2;\n");
      NodeFS.writeFileSync(NodePath.join(workbench, "notes.md"), "# notes, edited\n");
      NodeFS.writeFileSync(NodePath.join(worktree, ".artifacts", "chart.svg"), "<svg/>\n");
      NodeFS.rmSync(NodePath.join(worktree, ".artifacts", "report.html"));
      yield* react(yield* send(threadId, "second"));
      const second = (yield* snapshots.listForThread(threadId)).filter(
        (row) => row.messageId === `message:${threadId}:second`,
      );
      assert.deepEqual(second.map((row) => [row.sourceId, row.closesFilesChanged]).toSorted(), [
        ["artifacts:.artifacts", 2],
        ["nested:workbench", 1],
        ["repo", 1],
      ]);

      // The live refs: one per source, overwritten in place.
      const live = yield* snapshots.captureLive(threadId);
      assert.lengthOf(live, 3);
      assert.equal(
        git(workbench, "rev-parse", live.find((entry) => entry.source.kind === "nested_repo")!.ref),
        live.find((entry) => entry.source.kind === "nested_repo")!.commitOid,
      );

      // Archive deletes every ref (live ones too) and row, in both stores.
      yield* dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`command:${threadId}:archive`),
        threadId,
      }).pipe(
        Effect.flatMap(({ storedEvents }) => Effect.forEach(storedEvents, (s) => react(s.event))),
      );
      assert.lengthOf(yield* snapshots.listForThread(threadId), 0);
      assert.deepEqual(reviewRefs(worktree), []);
      assert.deepEqual(reviewRefs(workbench), []);
    }),
  );

  it.effect("a new-worktree launch snapshots its first message in the worktree, at release", () =>
    Effect.gen(function* () {
      const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
      // The project's main checkout, and the worktree the launch creates after the message.
      const { worktree: main } = makeWorktree();
      const threadId = yield* createThread(main, null);
      const messageId = MessageId.make(`message:${threadId}:kickoff`);
      const { storedEvents } = yield* dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:${threadId}:kickoff`),
        threadId,
        messageId,
        text: "Kick off the workstream.",
        attachments: [],
        dispatchMode: {
          type: "defer_start",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        },
        createdBy: "user",
        creationSource: "web",
      });
      yield* Effect.forEach(storedEvents, (stored) => react(stored.event));
      // Never the main checkout while the worktree is being prepared.
      assert.lengthOf(yield* snapshots.listForThread(threadId), 0);

      const linked = `${main}-worktree`;
      git(main, "worktree", "add", "-q", "-b", "feature", linked);
      NodeFS.mkdirSync(NodePath.join(linked, ".artifacts"));
      NodeFS.writeFileSync(NodePath.join(linked, ".artifacts", "setup.log"), "ready\n");
      yield* dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make(`command:${threadId}:workspace`),
        threadId,
        branch: "feature",
        worktreePath: linked,
      });
      const run = storedEvents
        .map((stored) => stored.event)
        .find((event) => event.type === "run.created")!;
      const released = yield* dispatch({
        type: "prepared-run.release",
        commandId: CommandId.make(`command:${threadId}:release`),
        threadId,
        runId: run.runId!,
      });
      yield* Effect.forEach(released.storedEvents, (stored) => react(stored.event));
      const rows = yield* snapshots.listForThread(threadId);
      assert.deepEqual(rows.map((row) => row.sourceId).toSorted(), [
        "artifacts:.artifacts",
        "repo",
      ]);
      assert.isTrue(rows.every((row) => row.messageId === messageId));
      assert.isTrue(rows.every((row) => row.worktreePath === NodeFS.realpathSync(linked)));
      const artifacts = rows.find((row) => row.sourceKind === "artifact_path")!;
      assert.equal(git(main, "show", `${artifacts.ref}:.artifacts/setup.log`), "ready");
    }),
  );

  it.effect("intervals, their diffs and file contents span every source between messages", () =>
    Effect.gen(function* () {
      const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
      const { worktree, workbench } = makeWorktree();
      const threadId = yield* createThread(worktree);
      const allKinds = ["repo", "nested_repo", "artifact_path"] as const;

      // No snapshot yet: no interval, and no live ref is written.
      assert.deepEqual(yield* snapshots.listIntervals(threadId), { intervals: [], sources: [] });
      assert.deepEqual(yield* snapshots.captureLive(threadId), []);
      assert.deepEqual(reviewRefs(worktree), []);

      yield* react(yield* send(threadId, "first"));
      NodeFS.writeFileSync(NodePath.join(worktree, "app.ts"), "export const a = 2;\n");
      NodeFS.writeFileSync(NodePath.join(workbench, "notes.md"), "# notes, edited\n");
      commitAll(workbench);
      NodeFS.writeFileSync(NodePath.join(worktree, ".artifacts", "chart.svg"), "<svg/>\n");

      // The live interval: everything since the message, nested paths under their prefix.
      const live = yield* snapshots.diff({
        threadId,
        intervalId: "live",
        sourceKinds: allKinds,
        ignoreWhitespace: false,
      });
      assert.deepEqual(
        live.sources.flatMap((source) =>
          source.files.map((file) => [source.id, file.path, file.status]),
        ),
        [
          ["repo", "app.ts", "modified"],
          ["nested:workbench", "workbench/notes.md", "modified"],
          ["artifacts:.artifacts", ".artifacts/chart.svg", "added"],
        ],
      );
      const nested = live.sources.find((source) => source.kind === "nested_repo")!;
      assert.include(nested.diff, "+++ b/workbench/notes.md");
      assert.deepEqual(nested.files[0]!.oldBytes, "# notes\n".length);
      assert.deepEqual(
        yield* snapshots.fileContents({
          threadId,
          sourceId: nested.id,
          fromCommit: nested.fromCommit,
          toCommit: nested.toCommit,
          changeType: "change",
          oldPath: "workbench/notes.md",
          newPath: "workbench/notes.md",
        }),
        { oldContents: "# notes\n", newContents: "# notes, edited\n" },
      );
      // "Repo code" leaves the nested repo and the artefact folder out.
      const repoOnly = yield* snapshots.diff({
        threadId,
        intervalId: "live",
        sourceKinds: ["repo"],
        ignoreWhitespace: false,
      });
      assert.deepEqual(
        repoOnly.sources.map((source) => source.id),
        ["repo"],
      );

      // A second message closes the first interval; a third after no change closes an empty one.
      yield* react(yield* send(threadId, "second"));
      yield* react(yield* send(threadId, "third"));
      const { intervals, sources } = yield* snapshots.listIntervals(threadId);
      assert.deepEqual(
        sources.map((source) => [source.id, source.title, source.prefix]),
        [
          ["repo", "Repo", ""],
          ["nested:workbench", "workbench/", "workbench/"],
          ["artifacts:.artifacts", ".artifacts/", ""],
        ],
      );
      assert.deepEqual(
        intervals.map((interval) => [
          interval.id,
          interval.from.firstLine,
          interval.from.sender,
          interval.changedBySource,
        ]),
        [
          ["live", "third", "Pele", null],
          [
            `message:${threadId}:third`,
            "second",
            "Pele",
            { repo: 0, nested_repo: 0, artifact_path: 0 },
          ],
          [
            `message:${threadId}:second`,
            "first",
            "Pele",
            { repo: 1, nested_repo: 1, artifact_path: 1 },
          ],
        ],
      );

      // A closed interval narrowed to one file reads only the source that owns it.
      const closed = yield* snapshots.diff({
        threadId,
        intervalId: `message:${threadId}:second`,
        sourceKinds: allKinds,
        ignoreWhitespace: false,
        file: { path: "workbench/notes.md", previousPath: null },
      });
      assert.deepEqual(
        closed.sources.map((source) => [source.id, source.files.map((file) => file.path)]),
        [["nested:workbench", ["workbench/notes.md"]]],
      );
    }),
  );

  it.effect("the cap keeps the newest snapshots per source", () =>
    Effect.gen(function* () {
      const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
      const { worktree } = makeWorktree();
      NodeFS.rmSync(NodePath.join(worktree, "workbench"), { recursive: true });
      NodeFS.rmSync(NodePath.join(worktree, ".artifacts"), { recursive: true });
      const threadId = yield* createThread(worktree);
      const base = DateTime.makeUnsafe(Date.UTC(2026, 0, 1));
      for (let index = 0; index <= ReviewSnapshotService.SNAPSHOTS_PER_SOURCE; index++)
        yield* snapshots.captureForMessage({
          threadId,
          messageId: MessageId.make(`message:cap:${index}`),
          messageCreatedAt: DateTime.add(base, { minutes: index }),
        });
      const rows = yield* snapshots.listForThread(threadId);
      assert.lengthOf(rows, ReviewSnapshotService.SNAPSHOTS_PER_SOURCE);
      assert.notInclude(
        rows.map((row) => row.messageId),
        "message:cap:0",
      );
      assert.lengthOf(reviewRefs(worktree), ReviewSnapshotService.SNAPSHOTS_PER_SOURCE);
    }),
  );

  it.effect("the quiet sweep deletes a thread's snapshots after its worktree is gone", () =>
    Effect.gen(function* () {
      const snapshots = yield* ReviewSnapshotService.ReviewSnapshotService;
      // Both the worktree and its nested repo are linked worktrees whose stores live elsewhere
      // (fathom's workbench/ is a checkout of a shared workbench.git), so the stores outlive them.
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-sweep-"));
      const store = (name: string) => {
        const directory = NodePath.join(root, name);
        NodeFS.mkdirSync(directory);
        git(directory, "init", "-q", "-b", "main");
        NodeFS.writeFileSync(NodePath.join(directory, "file.txt"), `${name}\n`);
        commitAll(directory);
        return directory;
      };
      const outer = store("outer");
      const nested = store("nested");
      const worktree = NodePath.join(root, "worktree");
      git(outer, "worktree", "add", "-q", "-b", "feature", worktree);
      git(nested, "worktree", "add", "-q", "-b", "feature", NodePath.join(worktree, "workbench"));
      NodeFS.writeFileSync(NodePath.join(worktree, ".gitignore"), "workbench/\n");

      const threadId = yield* createThread(worktree);
      yield* react(yield* send(threadId, "quiet"));
      assert.lengthOf(yield* snapshots.listForThread(threadId), 2);
      assert.lengthOf(reviewRefs(outer), 1);
      assert.lengthOf(reviewRefs(nested), 1);

      // Still active: the sweep keeps it.
      yield* snapshots.sweepQuiet;
      assert.lengthOf(yield* snapshots.listForThread(threadId), 2);

      NodeFS.rmSync(worktree, { recursive: true });
      yield* TestClock.adjust(`${ReviewSnapshotService.QUIET_DAYS + 1} days`);
      yield* snapshots.sweepQuiet;
      assert.lengthOf(yield* snapshots.listForThread(threadId), 0);
      assert.deepEqual(reviewRefs(outer), []);
      assert.deepEqual(reviewRefs(nested), []);
    }),
  );
});
