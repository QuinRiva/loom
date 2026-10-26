import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Replaces `provider_name` (the driver kind, always "pi") with `provider_id`, the real backend from
// the `providerID/modelID` slug (e.g. "google-vertex-claude", "openai-codex"), so vendors separate.
// Nullable: historical rows cannot be backfilled, and an unresolvable backend stays NULL rather
// than fabricated.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql`PRAGMA table_info(projection_usage_ledger)`;
  if (!columns.some((column) => column.name === "provider_id")) {
    yield* sql`ALTER TABLE projection_usage_ledger ADD COLUMN provider_id TEXT`;
  }
  if (columns.some((column) => column.name === "provider_name")) {
    yield* sql`ALTER TABLE projection_usage_ledger DROP COLUMN provider_name`;
  }
});
