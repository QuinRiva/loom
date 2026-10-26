import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Upstream's 063 drops the V1 projections nothing reads, and the upstream lane
 * runs before the fork lane, so on a fresh database a fork migration that
 * backfills from one of them finds it gone. There is nothing to backfill then;
 * on an existing database these migrations ran long before 063.
 */
export const whenV1TableExists = Effect.fn("v1Projections.whenV1TableExists")(function* <E, R>(
  table: string,
  migration: Effect.Effect<void, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ${table}`;
  if (rows.length > 0) yield* migration;
});
