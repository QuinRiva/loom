import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);

  // Collapse pre-existing duplicate ACTIVE rows per workspace_root so the unique
  // index below can be built on real databases (duplicates exist in the wild —
  // that is the bug this migration backstops). Keep the earliest active row per
  // path (by created_at, project_id) and soft-delete the rest.
  yield* sql`
    UPDATE projection_projects
    SET deleted_at = ${now}, updated_at = ${now}
    WHERE deleted_at IS NULL
      AND EXISTS (
        SELECT 1
        FROM projection_projects AS earlier
        WHERE earlier.workspace_root = projection_projects.workspace_root
          AND earlier.deleted_at IS NULL
          AND (
            earlier.created_at < projection_projects.created_at
            OR (
              earlier.created_at = projection_projects.created_at
              AND earlier.project_id < projection_projects.project_id
            )
          )
      )
  `;

  // Structural backstop: at most one active project per workspace_root, enforced
  // regardless of cross-process command races. A duplicate project.created lands
  // in the same transaction as its projection upsert, so a conflict here rolls
  // the whole create back — the duplicate event never persists.
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_projection_projects_active_workspace_root
    ON projection_projects(workspace_root)
    WHERE deleted_at IS NULL
  `;
});
