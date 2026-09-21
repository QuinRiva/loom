import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as Effect from "effect/Effect";

/**
 * Retire loom's title-provenance ladder (migration 1025) in favour of
 * upstream's `ThreadTitleState`, which now owns thread titles end to end
 * (first-turn generation, refine, compare-and-set).
 *
 * Backfill before dropping: a `curated` thread title was a deliberate one — a
 * workstream child's brief title, a `/handoff` or `/retro` fork label, a manual
 * rename — and upstream expresses exactly that as `titleState.source =
 * "manual"`, the state its generator refuses to overwrite. Without this, an
 * existing never-started child would have its brief title regenerated on its
 * first turn. `default`/`seed`/`derived` titles stay NULL (generatable), which
 * is what upstream's `canReplaceThreadTitle` seed check already expects. Rows
 * that already carry a title state keep it. Goal titles have no upstream
 * counterpart; the column simply goes.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = new Set(
    (yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`).map(
      (column) => column.name,
    ),
  );
  if (threadColumns.has("title_provenance")) {
    // `title_state_json` belongs to the UPSTREAM lane (migration 052). Both
    // lanes run in one startup pass with upstream first, so it is present on
    // every real database that reaches this point; the guard keeps the fork
    // lane runnable against a held-back upstream lane (LoomMigrations.test.ts).
    if (threadColumns.has("title_state_json")) {
      yield* sql`
        UPDATE projection_threads
        SET title_state_json = '{"source":"manual","version":"loom-migration-1039","needsRefinement":false}'
        WHERE title_provenance = 'curated' AND title_state_json IS NULL
      `;
    }
    yield* sql`ALTER TABLE projection_threads DROP COLUMN title_provenance`;
  }

  const goalColumns = yield* sql<{ name: string }>`PRAGMA table_info(projection_goals)`;
  if (new Set(goalColumns.map((column) => column.name)).has("title_provenance")) {
    yield* sql`ALTER TABLE projection_goals DROP COLUMN title_provenance`;
  }
});
