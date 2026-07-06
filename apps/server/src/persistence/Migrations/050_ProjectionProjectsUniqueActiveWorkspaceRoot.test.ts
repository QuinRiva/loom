import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("050_ProjectionProjectsUniqueActiveWorkspaceRoot", (it) => {
  it.effect("collapses duplicate active rows per workspace_root, keeping the earliest", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = (input: {
        readonly id: string;
        readonly workspaceRoot: string;
        readonly createdAt: string;
        readonly deletedAt: string | null;
      }) =>
        sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            ${input.id}, ${input.id}, ${input.workspaceRoot}, NULL,
            '[]', ${input.createdAt}, ${input.createdAt}, ${input.deletedAt}
          )
        `;

      yield* runMigrations({ toMigrationInclusive: 48 });

      // Three active rows for one path (the duplication bug) + one for another.
      yield* insert({
        id: "proj-b",
        workspaceRoot: "/home/carl/dup",
        createdAt: "2026-01-01T00:00:02.000Z",
        deletedAt: null,
      });
      yield* insert({
        id: "proj-a",
        workspaceRoot: "/home/carl/dup",
        createdAt: "2026-01-01T00:00:01.000Z",
        deletedAt: null,
      });
      yield* insert({
        id: "proj-c",
        workspaceRoot: "/home/carl/dup",
        createdAt: "2026-01-01T00:00:03.000Z",
        deletedAt: null,
      });
      yield* insert({
        id: "proj-other",
        workspaceRoot: "/home/carl/other",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      });

      yield* runMigrations({ toMigrationInclusive: 50 });

      const activeForDup = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM projection_projects
        WHERE workspace_root = '/home/carl/dup' AND deleted_at IS NULL
      `;
      assert.deepStrictEqual(
        activeForDup.map((row) => row.project_id),
        ["proj-a"],
      );

      const activeForOther = yield* sql<{ readonly project_id: string }>`
        SELECT project_id FROM projection_projects
        WHERE workspace_root = '/home/carl/other' AND deleted_at IS NULL
      `;
      assert.deepStrictEqual(
        activeForOther.map((row) => row.project_id),
        ["proj-other"],
      );
    }),
  );

  it.effect("rejects a new duplicate active row for a workspace_root", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = (input: {
        readonly id: string;
        readonly workspaceRoot: string;
        readonly createdAt: string;
        readonly deletedAt: string | null;
      }) =>
        sql`
          INSERT INTO projection_projects (
            project_id, title, workspace_root, default_model_selection_json,
            scripts_json, created_at, updated_at, deleted_at
          )
          VALUES (
            ${input.id}, ${input.id}, ${input.workspaceRoot}, NULL,
            '[]', ${input.createdAt}, ${input.createdAt}, ${input.deletedAt}
          )
        `;

      yield* runMigrations({ toMigrationInclusive: 50 });

      yield* insert({
        id: "proj-1",
        workspaceRoot: "/home/carl/one",
        createdAt: "2026-01-01T00:00:00.000Z",
        deletedAt: null,
      });

      // A second ACTIVE row for the same path violates the partial unique index.
      const conflict = yield* Effect.result(
        insert({
          id: "proj-2",
          workspaceRoot: "/home/carl/one",
          createdAt: "2026-01-01T00:00:01.000Z",
          deletedAt: null,
        }),
      );
      assert.strictEqual(conflict._tag, "Failure");

      // A soft-deleted row for the same path is allowed (uniqueness is active-only).
      const softDeleted = yield* Effect.result(
        insert({
          id: "proj-3",
          workspaceRoot: "/home/carl/one",
          createdAt: "2026-01-01T00:00:02.000Z",
          deletedAt: "2026-01-01T00:00:03.000Z",
        }),
      );
      assert.strictEqual(softDeleted._tag, "Success");
    }),
  );
});
