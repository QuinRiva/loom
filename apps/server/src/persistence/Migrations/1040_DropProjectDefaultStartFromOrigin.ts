import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Retires the per-project start-from-origin column (1031): upstream's project-scoped
 * `newWorktreesStartFromOrigin` override owns it. No backfill; it only seeded loom's own checkout.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  if (new Set(columns.map((column) => column.name)).has("default_start_from_origin")) {
    yield* sql`ALTER TABLE projection_projects DROP COLUMN default_start_from_origin`;
  }
});
