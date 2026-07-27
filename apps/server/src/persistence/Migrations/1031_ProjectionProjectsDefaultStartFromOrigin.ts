import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Per-project default for branching new top-level worktrees from a freshly
// fetched origin/main (docs/keep-loom-fresh-on-deploy.md §C). Mirrors
// default_model_selection_json: a nullable JSON column (`true`/`false`/null)
// read through Schema.fromJsonString(Schema.Boolean). NULL means "unset" and
// resolves to the client-side false default.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_projects)`;
  const existing = new Set(columns.map((column) => column.name));

  if (!existing.has("default_start_from_origin")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN default_start_from_origin TEXT`;
  }

  // Seed the loom project itself to true so new top-level threads there branch
  // from origin/main by default (the motivating case). Keyed on the loom
  // checkout path; a no-op in environments (dev/test) without such a project.
  yield* sql`
    UPDATE projection_projects
    SET default_start_from_origin = 'true'
    WHERE deleted_at IS NULL
      AND default_start_from_origin IS NULL
      AND workspace_root LIKE '%/loom'
  `;
});
