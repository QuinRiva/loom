import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Post-completion sub-thread engagement (plan §8 item 3): the child's tip commit
// recorded on the thread shell when fan-in merges its branch (or, at cancel, the
// kept branch tip).
// - final_commit_sha: nullable text. Null for rows never disposed by fan-in /
//   cancel (the default for every pre-engagement row). A historical marker only
//   — nothing reads it for control flow; the relocation preamble surfaces
//   it so a re-engaged thread knows where its merged work landed.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("final_commit_sha")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN final_commit_sha TEXT`;
  }
});
