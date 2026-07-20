import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("063_ProjectionProjectsDefaultStartFromOrigin", (it) => {
  it.effect("adds the column and seeds the loom project to start-from-origin by default", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      // Setup base state: projection rows created before this migration lack
      // the new column entirely.
      {
        yield* runMigrations({ toMigrationInclusive: 62 });

        yield* sql`
            INSERT INTO projection_projects (
              project_id,
              title,
              workspace_root,
              default_model_selection_json,
              scripts_json,
              created_at,
              updated_at,
              deleted_at
            )
            VALUES
              ('project-loom', 'Loom', '/home/agent/loom', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
              ('project-other', 'Other', '/home/agent/other', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL),
              ('project-loom-deleted', 'Loom (old)', '/home/agent/old/loom', NULL, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')
          `;
      }

      // Execute migration under test.
      yield* runMigrations({ toMigrationInclusive: 63 });

      // Assert expected state: loom (active) is seeded true; unrelated and
      // soft-deleted rows stay unset (null).
      {
        const rows = yield* sql<{
          readonly projectId: string;
          readonly defaultStartFromOrigin: string | null;
        }>`
            SELECT
              project_id AS "projectId",
              default_start_from_origin AS "defaultStartFromOrigin"
            FROM projection_projects
            ORDER BY project_id
          `;
        assert.deepStrictEqual(rows, [
          { projectId: "project-loom", defaultStartFromOrigin: "true" },
          { projectId: "project-loom-deleted", defaultStartFromOrigin: null },
          { projectId: "project-other", defaultStartFromOrigin: null },
        ]);
      }
    }),
  );
});
