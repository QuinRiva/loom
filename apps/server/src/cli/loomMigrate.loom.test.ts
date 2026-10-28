/**
 * `t3 loom-migrate` end to end through the real CLI: a seeded workstream with one thread on its own
 * dirty worktree and a pi session file is exported, imported into a fresh home with its own clone,
 * and verified; the uncommitted work arrives as the branch's WIP commit. Export refuses a tree with
 * a running run, and import refuses ids that are already present.
 */
// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary homes, git and node:sqlite.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";

import { cli } from "../binCli.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NetService.layer)),
  );

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

const sqlite = (file: string, statement: string, ...params: ReadonlyArray<string>) => {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    return db.prepare(statement).all(...params) as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
};

const failureMessage = (effect: ReturnType<typeof runCli>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => String((error as { message?: unknown }).message ?? error)),
  );

const CODER = "seed-thread-coder-done";

it.live(
  "t3 loom-migrate carries a tree with its uncommitted work and pi session, and refuses live runs and present ids",
  () => {
    const tmp = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-loom-migrate-"));
    return Effect.gen(function* () {
      const carl = NodePath.join(tmp, "carl");
      const jacob = NodePath.join(tmp, "jacob");
      const carlDb = NodePath.join(carl, "userdata", "statev2.sqlite");
      const jacobDb = NodePath.join(jacob, "userdata", "statev2.sqlite");
      NodeChildProcess.execFileSync(
        process.execPath,
        [NodePath.join(import.meta.dirname, "../dev/seedWorkstream.ts"), "--home-dir", carl],
        { stdio: "pipe" },
      );
      const carlRoot = NodePath.join(carl, "worktrees", "seed-workspace");

      // The done coder gets its own worktree and branch, one tracked edit, one untracked file and a session.
      const worktree = NodePath.join(carl, "worktrees", "coder-done");
      git(carlRoot, "worktree", "add", "-q", "-b", "t3/coder-done", worktree);
      NodeFS.writeFileSync(
        NodePath.join(worktree, "README.md"),
        "# Seed Fixture Project\n\nEdited.\n",
      );
      NodeFS.writeFileSync(NodePath.join(worktree, "untracked.txt"), "not yet added\n");
      const session = NodePath.join(tmp, "carl-sessions", "--carl--", "coder.jsonl");
      NodeFS.mkdirSync(NodePath.dirname(session), { recursive: true });
      NodeFS.writeFileSync(
        session,
        `${JSON.stringify({ type: "session", cwd: worktree })}\n{"type":"message"}\n`,
      );
      sqlite(
        carlDb,
        `UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.worktreePath', ?, '$.branch', 't3/coder-done')
        WHERE thread_id = ?`,
        worktree,
        CODER,
      );
      sqlite(
        carlDb,
        `UPDATE orchestration_v2_projection_provider_threads
        SET payload_json = json_set(payload_json, '$.nativeThreadRef', json(?)) WHERE thread_id = ?`,
        JSON.stringify({ driver: "pi", nativeId: session, strength: "strong" }),
        CODER,
      );

      // Refusal: a running run keeps the tree from exporting, and nothing is committed.
      const [latest] = sqlite(
        carlDb,
        "SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1",
        CODER,
      );
      const setRunStatus = (status: string) =>
        sqlite(
          carlDb,
          "UPDATE orchestration_v2_projection_runs SET status = ? WHERE run_id = ?",
          status,
          String(latest!.run_id),
        );
      setRunStatus("running");
      const export1 = NodePath.join(tmp, "batch-1");
      const exportArgs = (out: string) =>
        [
          "loom-migrate",
          "export",
          "--root",
          "seed-thread-orchestrator",
          "--out",
          out,
          "--yes",
        ].concat(["--base-dir", carl]);
      const refused = yield* failureMessage(runCli(exportArgs(export1)));
      assert.include(refused, `${CODER}: a running run`);
      assert.notEqual(git(worktree, "status", "--porcelain"), "");
      setRunStatus("completed");

      yield* runCli(exportArgs(export1));
      const manifest = JSON.parse(
        NodeFS.readFileSync(NodePath.join(export1, "manifest.json"), "utf8"),
      );
      // The goal-continue chain moves with its root; the consulted tree outside it does not.
      assert.property(manifest.threads, "seed-thread-staged-root");
      assert.notProperty(manifest.threads, "seed-thread-needs-guidance-root");
      // That tree shares the goal, which the export names.
      assert.deepEqual(manifest.sharedGoals, [
        { goalId: "seed-goal-0000", outsideRoots: ["seed-thread-needs-guidance-root"] },
      ]);
      // The seed's turns left notes in the shared project root: captured, never committed there.
      const rootEntry = manifest.worktrees.find(
        (entry: { path: string }) => entry.path === carlRoot,
      );
      assert.include(rootEntry.statusBeforeExport, "seed-notes/");
      assert.isTrue(
        NodeFS.existsSync(
          NodePath.join(export1, rootEntry.rootCapture.untracked, "seed-notes", `${CODER}.md`),
        ),
      );
      assert.include(git(carlRoot, "status", "--porcelain"), "seed-notes/");

      // Jacob: a fresh home with its own clone registered as a project.
      const jacobRoot = NodePath.join(tmp, "jacob-code", "seed");
      NodeChildProcess.execFileSync("git", ["clone", "-q", carlRoot, jacobRoot]);
      yield* runCli(["project", "add", jacobRoot, "--base-dir", jacob]);
      const jacobSessions = NodePath.join(tmp, "jacob-sessions");
      const importArgs = (batch: string) =>
        [
          "loom-migrate",
          "import",
          "--batch",
          batch,
          "--project",
          `${carlRoot}=${jacobRoot}`,
        ].concat(["--sessions-dir", jacobSessions, "--base-dir", jacob]);
      yield* runCli(importArgs(export1));
      yield* runCli(["loom-migrate", "verify", "--batch", export1, "--base-dir", jacob]);

      // The branch tip is the WIP commit holding both changes.
      assert.match(
        git(jacobRoot, "log", "-1", "--format=%s", "t3/coder-done"),
        /^loom-migrate WIP: /,
      );
      assert.deepEqual(
        git(jacobRoot, "show", "--name-only", "--format=", "t3/coder-done").split("\n").toSorted(),
        ["README.md", "untracked.txt"],
      );
      assert.equal(git(jacobRoot, "show", "t3/coder-done:untracked.txt"), "not yet added");
      // Checkpoint refs came along.
      assert.isAbove(
        git(jacobRoot, "for-each-ref", "refs/t3/orchestration-v2").split("\n").length,
        1,
      );

      // The thread opens on his side, under his project and paths, and resumes from the copied session.
      const [jacobProject] = sqlite(
        jacobDb,
        "SELECT project_id FROM projection_projects WHERE workspace_root = ?",
        jacobRoot,
      );
      const projection = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) =>
        store.getThreadProjection(ThreadId.make(CODER)),
      ).pipe(
        Effect.provide(
          ProjectionStore.layer.pipe(Layer.provide(NodeSqliteClient.layer({ filename: jacobDb }))),
        ),
      );
      assert.equal(projection.thread.projectId, jacobProject!.project_id);
      assert.equal(projection.thread.worktreePath, NodePath.join(jacob, "worktrees", "coder-done"));
      const jacobSession = NodePath.join(
        jacobSessions,
        `--${NodePath.join(jacob, "worktrees", "coder-done").slice(1).replaceAll("/", "-")}--`,
        "coder.jsonl",
      );
      assert.equal(NodeFS.readFileSync(jacobSession, "utf8"), NodeFS.readFileSync(session, "utf8"));
      const [providerThread] = sqlite(
        jacobDb,
        "SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS nativeId FROM orchestration_v2_projection_provider_threads WHERE thread_id = ?",
        CODER,
      );
      assert.equal(providerThread!.nativeId, jacobSession);

      // Refusal: the same tree exported again cannot land where it already is.
      const export2 = NodePath.join(tmp, "batch-2");
      yield* runCli(exportArgs(export2));
      const collision = yield* failureMessage(runCli(importArgs(export2)));
      assert.include(collision, "Already present here");
      assert.include(collision, "seed-thread-orchestrator");
      assert.isFalse(NodeFS.existsSync(NodePath.join(export2, "import-manifest.json")));

      // A later tree that shares an edge (the done coder consulted it) imports on its own, and
      // rolling it back keeps the edge for the tree already here. Given its own goal first.
      sqlite(
        carlDb,
        "UPDATE loom_thread_workstream SET goal_id = NULL WHERE thread_id = 'seed-thread-needs-guidance-root'",
      );
      const export3 = NodePath.join(tmp, "batch-3");
      yield* runCli(
        [
          "loom-migrate",
          "export",
          "--root",
          "seed-thread-needs-guidance-root",
          "--out",
          export3,
        ].concat(["--yes", "--base-dir", carl]),
      );
      const consults = () =>
        sqlite(
          jacobDb,
          "SELECT count(*) AS n FROM loom_thread_consults WHERE target_thread_id = 'seed-thread-needs-guidance-root'",
        )[0]!.n;
      assert.equal(consults(), 1);
      yield* runCli(importArgs(export3));
      yield* runCli(["loom-migrate", "verify", "--batch", export3, "--base-dir", jacob]);
      yield* runCli([
        "loom-migrate",
        "import",
        "--rollback",
        "--batch",
        export3,
        "--base-dir",
        jacob,
      ]);
      assert.equal(consults(), 1);
      yield* runCli(["loom-migrate", "verify", "--batch", export1, "--base-dir", jacob]);
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tmp, { recursive: true, force: true }))),
      Effect.provide(NodeServices.layer),
    );
  },
);
