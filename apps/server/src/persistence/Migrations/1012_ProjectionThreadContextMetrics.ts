import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Effort/health meter: per-thread latest context-window snapshot, folded from
// the durable activity log (the newest `context-window.updated` activity's
// `toolUses`/`usedTokens`/`maxTokens`) so it is deterministic on replay. Unlike
// cost (a SUM, REAL NOT NULL DEFAULT 0), these are a LATEST-SNAPSHOT and are
// genuinely unknown for non-pi threads / before the first activity — so they are
// INTEGER with a NULL default, letting the UI suppress the chip rather than show
// a misleading 0.
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
