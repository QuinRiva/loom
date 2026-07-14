import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// loom: title provenance (stale/empty-goal fix §4). Adds `title_provenance` to
// both projection_threads and projection_goals so the decider can refuse to let
// automation (seed/LLM) clobber a human/tool-curated title.
//
// Backfill heuristic (conservative): the placeholder "New thread" title has
// never carried a real subject, so it backfills to `default` (freely
// replaceable by automation). EVERY other existing title is backfilled to
// `curated` — the safe choice: it means the migration can never make an
// already-meaningful title clobberable by a late LLM interpretation. New rows
// created after this migration carry a real provenance from their event.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  if (!new Set(threadColumns.map((c) => c.name)).has("title_provenance")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_provenance TEXT NOT NULL DEFAULT 'curated'
    `;
    yield* sql`
      UPDATE projection_threads
      SET title_provenance = 'default'
      WHERE title = 'New thread'
    `;
  }

  const goalColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_goals)`;
  if (!new Set(goalColumns.map((c) => c.name)).has("title_provenance")) {
    yield* sql`
      ALTER TABLE projection_goals
      ADD COLUMN title_provenance TEXT NOT NULL DEFAULT 'curated'
    `;
  }
});
