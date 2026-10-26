import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { Command, GlobalFlag } from "effect/cli";

import * as ServerConfig from "../config.ts";
import * as ToolOutputImageStore from "../orchestration-v2/ToolOutputImageStore.loom.ts";
import { DatabaseMissingError } from "../persistence/DatabaseMaintenance.ts";
import { formatMiB, reclaimToolOutputImages } from "../persistence/ToolOutputImageReclaim.loom.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import { projectLocationFlags, resolveCliAuthConfig } from "./config.ts";

export const reclaimToolImagesCommand = Command.make("reclaim-tool-images", {
  ...projectLocationFlags,
}).pipe(
  Command.withDescription(
    "Move tool-result images stored inline in the database (screenshots, image reads) to attachment files. Run with the server stopped; resumes if interrupted.",
  ),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      const config = yield* resolveCliAuthConfig(flags, yield* GlobalFlag.LogLevel);
      const { dbPath } = config;
      if (!(yield* (yield* FileSystem.FileSystem).exists(dbPath))) {
        return yield* new DatabaseMissingError({ path: dbPath });
      }
      // Refuses while a server owns this home, and keeps one from starting until the run ends.
      yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
        Effect.provide(ProcessRunner.layer),
      );
      yield* Console.log(`Database: ${dbPath}\nImages go to: ${config.attachmentsDir}`);
      const totals = yield* Effect.gen(function* () {
        const totals = yield* reclaimToolOutputImages();
        yield* (yield* SqlClient.SqlClient)`PRAGMA wal_checkpoint(TRUNCATE)`;
        return totals;
      }).pipe(
        Effect.provide(
          Layer.merge(
            ToolOutputImageStore.layer.pipe(Layer.provide(ServerConfig.layer(config))),
            NodeSqliteClient.layer({ filename: dbPath }),
          ),
        ),
      );
      yield* Console.log(
        `\nDone: ${totals.rewrittenRows} rows rewritten, ${formatMiB(totals.bytesFreed)} freed inside the database.` +
          "\nThe file does not shrink until it is vacuumed: with the server still stopped, run `t3 doctor --fix`.",
      );
    }).pipe(Effect.scoped),
  ),
);
