import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Retire loom's per-project start-from-origin default (migration 1031).
 * Upstream's project-scoped `newWorktreesStartFromOrigin` override owns the
 * concern now, so nothing read or wrote this column any more. No backfill:
 * the override lives in the settings aggregate, and the fork column only ever
 * carried a seed for the loom checkout itself.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  if (new Set(columns.map((column) => column.name)).has("default_start_from_origin")) {
    yield* sql`ALTER TABLE projection_projects DROP COLUMN default_start_from_origin`;
  }
});
