// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "./Sqlite.ts";
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
// migrated by the live Sqlite layer: the Loom lane ends at 1054, V1's goal,
// consult, peer-message and usage-ledger rows survive the renames (1048, 1049),
// and upstream's ledger is exactly upstream's manifest.
it.effect("migrates a copied V1 database to 1054 with the renamed tables' rows intact", () => {
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
    yield* sql`INSERT INTO projection_usage_ledger (event_id, thread_id, turn_id, provider_instance_id, provider_id, requested_model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd, created_at)
      VALUES ('usage-1', 'thread-a', 'turn-1', 'pi', 'anthropic', 'claude-opus-5', 10, 200, 30, 40, 0.5, ${at}),
             ('usage-2', 'thread-a', 'turn-2', 'pi', 'openai-codex', 'gpt-6.1-sol', 5, 0, 0, 7, 0.25, ${at}),
             ('usage-3', 'thread-b', NULL, 'pi', NULL, NULL, 1, 2, 3, 4, 0, ${at})`;
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
      assert.deepEqual(loomLedger.slice(-8), [
        { id: 1047, name: "LoomGoalTables" },
        { id: 1048, name: "LoomConsultAndPeerMessageTables" },
        { id: 1049, name: "LoomUsageLedger" },
        { id: 1050, name: "LoomThreadReroute" },
        { id: 1051, name: "LoomLegacyImports" },
        { id: 1052, name: "LoomControlMessageRows" },
        { id: 1053, name: "LoomCardMetrics" },
        { id: 1054, name: "LoomImportedConsultItems" },
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
        "projection_usage_ledger",
      ]) {
        assert.notInclude(tables, gone);
      }
      assert.include(tables, "loom_thread_workstream");
      // 1049: V1's ledger rows travel with their columns; V2's two new ones start NULL.
      assert.deepEqual(
        yield* sql`SELECT event_id, thread_id, requested_model, cache_read_tokens, cost_usd, run_id, provider_turn_id
          FROM loom_usage_ledger ORDER BY event_id`,
        [
          {
            event_id: "usage-1",
            thread_id: "thread-a",
            requested_model: "claude-opus-5",
            cache_read_tokens: 200,
            cost_usd: 0.5,
            run_id: null,
            provider_turn_id: null,
          },
          {
            event_id: "usage-2",
            thread_id: "thread-a",
            requested_model: "gpt-6.1-sol",
            cache_read_tokens: 0,
            cost_usd: 0.25,
            run_id: null,
            provider_turn_id: null,
          },
          {
            event_id: "usage-3",
            thread_id: "thread-b",
            requested_model: null,
            cache_read_tokens: 2,
            cost_usd: 0,
            run_id: null,
            provider_turn_id: null,
          },
        ],
      );
      const ledgerIndexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'loom_usage_ledger' AND sql IS NOT NULL ORDER BY name`;
      assert.deepEqual(
        ledgerIndexes.map((row) => row.name),
        ["idx_loom_usage_created", "idx_loom_usage_thread_created", "idx_loom_usage_turn"],
      );
      const turnRow = (eventId: string) =>
        sql`INSERT INTO loom_usage_ledger (event_id, thread_id, provider_turn_id, created_at)
          VALUES (${eventId}, 'thread-a', 'provider-turn-1', ${at})`;
      yield* turnRow("usage-4");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(turnRow("usage-5"))));
      // 1050: the reroute record exists and starts empty.
      assert.deepEqual(yield* sql`SELECT * FROM loom_thread_reroute`, []);
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
