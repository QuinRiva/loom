import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Migrate usage-ledger provider attribution from driver kind to real backend.
// `provider_name` recorded the emitting driver KIND (always "pi" here), which
// loses the model's real vendor, so Anthropic-vs-Vertex-vs-OpenAI usage can't
// be separated and the Codex scope (which expects OpenAI usage) matches nothing.
// Replace it with `provider_id`: the real backend as the `providerID` half of
// pi/OpenCode's `providerID/modelID` slug (e.g. "google-vertex-claude",
// "anthropic", "openai-codex"), populated in ingestion from the token-usage
// event. Nullable: historical rows have no stored slug and cannot be
// back-filled, and an adapter that can't resolve a real backend leaves it NULL
// rather than fabricating one. The legacy `provider_name` column is dropped
// outright (prototype — no compat shim); the driver kind is not attribution.
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
