import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Lines-of-diff meter: per-thread cumulative added/deleted line counts, folded
// from the durable per-turn checkpoint file summaries (SUM of every checkpoint
// turn's `files[].additions`/`deletions`). Worktree isolation (plan
// workstream-worktree-isolation) makes this attribution honest — an isolated
// child's turn diffs contain exactly its own edits. Like the context-window
// metrics these are INTEGER with a NULL default: genuinely unknown for threads
// with no checkpoint yet, so the UI suppresses the chip rather than showing a
// misleading 0.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("diff_additions")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN diff_additions INTEGER`;
  }
  if (!existing.has("diff_deletions")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN diff_deletions INTEGER`;
  }
});
