import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runAllMigrations } from "../LoomMigrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

// loom: §4 title-provenance backfill. "New thread" is the placeholder that never
// carried a real subject → `default` (freely replaceable by automation); every
// other existing title is the conservative `curated` (never clobberable). Goals
// always carry a real subject → `curated`.
layer("057_ProjectionTitleProvenance", (it) => {
  it.effect("backfills thread + goal title provenance", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runAllMigrations({ toLoomMigrationInclusive: 1024 });

      const insertThread = (id: string, title: string) => sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json,
          runtime_mode, interaction_mode, created_at, updated_at
        )
        VALUES (
          ${id}, 'project-1', ${title}, '{"provider":"codex","model":"gpt-5-codex"}',
          'approval-required', 'default',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z'
        )
      `;
      yield* insertThread("thread-placeholder", "New thread");
      yield* insertThread("thread-real", "Fix the reconnect bug");

      yield* sql`
        INSERT INTO projection_goals (
          goal_id, project_id, slug, title, description, created_at, updated_at
        )
        VALUES (
          'goal-1', 'project-1', 'fix-reconnect', 'Fix reconnect', '',
          '2026-02-24T00:00:00.000Z', '2026-02-24T00:00:00.000Z'
        )
      `;

      yield* runAllMigrations({ toLoomMigrationInclusive: 1025 });

      const threadRows = yield* sql<{
        thread_id: string;
        title_provenance: string;
      }>`SELECT thread_id, title_provenance FROM projection_threads ORDER BY thread_id`;
      const byId = new Map(threadRows.map((row) => [row.thread_id, row.title_provenance]));
      assert.strictEqual(byId.get("thread-placeholder"), "default");
      assert.strictEqual(byId.get("thread-real"), "curated");

      const goalRows = yield* sql<{
        title_provenance: string;
      }>`SELECT title_provenance FROM projection_goals WHERE goal_id = 'goal-1'`;
      assert.strictEqual(goalRows[0]?.title_provenance, "curated");
    }),
  );
});
