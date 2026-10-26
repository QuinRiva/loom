import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Latest context-window snapshot per thread, folded from the newest `context-window.updated`
// activity so it is deterministic on replay. NULL (unlike cost's SUM default 0) for non-pi threads
// and before the first activity, so the UI suppresses the chip rather than show a misleading 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("tool_uses")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN tool_uses INTEGER`;
  }
  if (!existing.has("used_tokens")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN used_tokens INTEGER`;
  }
  if (!existing.has("max_tokens")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN max_tokens INTEGER`;
  }
});
