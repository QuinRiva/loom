/**
 * Every live project's `.t3code/links.json` rules for `ServerConfig.referenceLinks`.
 *
 * The rules are derived from disk, not event-sourced, so they must not ride the
 * project shell: clients cache that and resume it by event replay, which never
 * carries a rule change. The config snapshot is rebuilt for each connection, so
 * re-reading here lands a `links.json` edit on a client's next reload or
 * reconnect.
 *
 * @module loom/referenceLinks
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
