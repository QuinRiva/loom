import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Handoff chain as data (sidebar-v2 re-home plan, "Common base" item 3).
//
// - continues_thread_id: nullable thread id, mirroring `fork_from_thread_id`
//   (Migration 1023). Stamped by `goal_continue` with the PREDECESSOR thread on
//   the same goal, so a goal's serial handoff order is queryable instead of
//   living only as English prose inside the successor's brief.
// - handoff_destinations: the `thread.handoff-recorded` destination ids
//   (`[{goalId, threadId}, …]`), REPLACING `handoff_count`. The count was a
//   lossy projection of exactly this list — every consumer wants either the
//   length (the drafter settlement gate) or the ids (chain rendering), so the
//   list is the one canonical shape. Historical counts are not reconstructible
//   (the ids were discarded at projection time) and are dropped with the column.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("continues_thread_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN continues_thread_id TEXT`;
  }
  if (!existing.has("handoff_destinations")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN handoff_destinations TEXT NOT NULL DEFAULT '[]'`;
  }
  if (existing.has("handoff_count")) {
    yield* sql`ALTER TABLE projection_threads DROP COLUMN handoff_count`;
  }
});
