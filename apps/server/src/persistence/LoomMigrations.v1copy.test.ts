// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Layers/Sqlite.ts";
import {
  loomMigrationsTable,
  reconcileMigrationLedgers,
  runLoomMigrations,
} from "./LoomMigrations.ts";
import { migrationEntries, runMigrations } from "./Migrations.ts";

const at = "2026-01-01T00:00:00.000Z";

// t-migrate (pull 9 Phase 2 §7): a V1 `state.sqlite` as the live install has it
// (upstream lane at 054, Loom lane at 1045, with 1045's search triggers on the
// goal tables) is copied to `statev2.sqlite` by `initializeV2Database` and
// migrated by the live Sqlite layer: the Loom lane ends at 1048, V1's goal,
// consult and peer-message rows survive the renames, and upstream's ledger is
// exactly upstream's manifest.
it.effect("migrates a copied V1 database to 1048 with the renamed tables' rows intact", () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-loom-v1copy-"));
  const seed = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* reconcileMigrationLedgers();
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* runLoomMigrations({ toMigrationInclusive: 1045 });
    yield* sql`INSERT INTO projection_goals (goal_id, project_id, slug, title, description, created_at, updated_at)
      VALUES ('goal-1', 'project-1', 'goal-one', 'Goal one', 'Why', ${at}, ${at})`;
    yield* sql`INSERT INTO projection_goal_tasks (task_id, goal_id, parent_task_id, position, text, done, created_at, updated_at)
      VALUES ('task-1', 'goal-1', NULL, 0, 'First task', 0, ${at}, ${at}),
             ('task-2', 'goal-1', 'task-1', 0, 'Nested task', 1, ${at}, ${at})`;
    yield* sql`INSERT INTO projection_thread_consults (event_id, asker_thread_id, target_thread_id, target_title, question_preview, created_at)
      VALUES ('event-1', 'thread-a', 'thread-b', 'B', 'What?', ${at})`;
    yield* sql`INSERT INTO projection_thread_peer_messages (record_id, sender_thread_id, target_thread_id, target_title, message, framed_message, message_preview, status, seq, created_at)
      VALUES ('record-1', 'thread-a', 'thread-b', 'B', 'hi', '[a] hi', 'hi', 'pending', 1, ${at})`;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: NodePath.join(directory, "state.sqlite") })),
  );

  return Effect.gen(function* () {
    yield* seed;
    const config = yield* ServerConfig.ServerConfig;
    const databaseLayer = SqlitePersistence.layerConfig.pipe(
      Layer.provide(
        ServerConfig.layer({ ...config, dbPath: NodePath.join(directory, "statev2.sqlite") }),
      ),
    );
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const loomLedger = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name FROM ${sql(loomMigrationsTable)} ORDER BY migration_id`;
      assert.deepEqual(loomLedger.slice(-4), [
        { id: 1045, name: "ThreadSearchIndex" },
        { id: 1046, name: "LoomThreadWorkstream" },
        { id: 1047, name: "LoomGoalTables" },
        { id: 1048, name: "LoomConsultAndPeerMessageTables" },
      ]);
      const upstreamLedger = yield* sql<{ readonly id: number; readonly name: string }>`
        SELECT migration_id AS id, name FROM effect_sql_migrations ORDER BY migration_id`;
      assert.deepEqual(
        upstreamLedger,
        migrationEntries.map(([id, name]) => ({ id, name })),
      );

      assert.deepEqual(yield* sql`SELECT goal_id, title FROM loom_goals`, [
        { goal_id: "goal-1", title: "Goal one" },
      ]);
      assert.deepEqual(
        yield* sql`SELECT task_id, parent_task_id, done FROM loom_goal_tasks ORDER BY task_id`,
        [
          { task_id: "task-1", parent_task_id: null, done: 0 },
          { task_id: "task-2", parent_task_id: "task-1", done: 1 },
        ],
      );
      assert.deepEqual(yield* sql`SELECT event_id FROM loom_thread_consults`, [
        { event_id: "event-1" },
      ]);
      assert.deepEqual(yield* sql`SELECT record_id, status FROM loom_thread_peer_messages`, [
        { record_id: "record-1", status: "pending" },
      ]);
      const tables = (yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table'`).map((row) => row.name);
      for (const gone of [
        "projection_goals",
        "projection_goal_tasks",
        "projection_thread_consults",
        "projection_thread_peer_messages",
      ]) {
        assert.notInclude(tables, gone);
      }
      assert.include(tables, "loom_thread_workstream");
      // The goal FK and 1045's search triggers followed the rename.
      const fk = yield* sql<{ readonly table: string }>`
        SELECT "table" FROM pragma_foreign_key_list('loom_goal_tasks')`;
      assert.deepEqual(
        fk.map((row) => row.table),
        ["loom_goals"],
      );
      const goalTriggers = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'loom_goals'`;
      assert.lengthOf(goalTriggers, 3);
      yield* sql`UPDATE loom_goals SET title = 'Renamed' WHERE goal_id = 'goal-1'`;
    }).pipe(Effect.provide(databaseLayer));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(directory, directory).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true }))),
  );
});
