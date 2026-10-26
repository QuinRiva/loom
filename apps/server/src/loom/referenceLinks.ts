/**
 * Every live project's `.t3code/links.json` rules. Derived from disk, not event-sourced, so they
 * must not ride the cached project shell; the per-connection config snapshot picks up an edit on reload.
 */
import type { ProjectId, ServerConfig } from "@t3tools/contracts";
import { resolveReferenceLinks } from "@t3tools/shared/t3codeConfig";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const loadProjectReferenceLinks = (sql: SqlClient.SqlClient) =>
  sql<{ readonly projectId: ProjectId; readonly workspaceRoot: string }>`
    SELECT project_id AS "projectId", workspace_root AS "workspaceRoot"
    FROM projection_projects
    WHERE deleted_at IS NULL
  `.pipe(
    Effect.map((rows): NonNullable<ServerConfig["referenceLinks"]> =>
      Object.fromEntries(
        rows.flatMap(({ projectId, workspaceRoot }) => {
          const links = resolveReferenceLinks(workspaceRoot);
          return links?.length ? [[projectId, links]] : [];
        }),
      ),
    ),
    // Links are decoration: a failed read must not fail the config snapshot.
    Effect.orElseSucceed(() => ({})),
  );
