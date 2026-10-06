/**
 * Loom's on-disk directories under the server's state dir, kept out of
 * upstream's `ServerDerivedPaths` (DL-357 / DL-360: no `config.ts` hunk). The
 * names are V1's, so Phase 4's importer finds the same paths on disk.
 *
 * @module loom/loomPaths
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import type { ServerDerivedPaths } from "../config.ts";

/** Loom's directories for a server's state dir; every Loom file writer resolves its directory here. */
export const loomPaths = Effect.fn("loom.loomPaths")(function* (
  config: Pick<ServerDerivedPaths, "stateDir">,
) {
  const { join } = yield* Path.Path;
  return {
    workstreamReportsDir: join(config.stateDir, "workstream-reports"),
    workstreamBriefsDir: join(config.stateDir, "workstream-briefs"),
    workstreamLaunchIdentityDir: join(config.stateDir, "workstream-launch-identity"),
    workstreamPromptDebugDir: join(config.stateDir, "prompt-debug"),
    workstreamConsultsDir: join(config.stateDir, "workstream-consults"),
  };
});

/** Creates every Loom directory (recursive, idempotent). */
export const ensureLoomDirectories = Effect.fn("loom.ensureLoomDirectories")(function* (
  config: Pick<ServerDerivedPaths, "stateDir">,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.forEach(
    Object.values(yield* loomPaths(config)),
    (dir) => fs.makeDirectory(dir, { recursive: true }),
    { concurrency: "unbounded", discard: true },
  );
});
