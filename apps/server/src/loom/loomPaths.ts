// @effect-diagnostics nodeBuiltinImport:off - a pure path derivation, no service needed.
/**
 * Loom's durable directories under the server's state dir. V1 carried these on
 * `ServerConfig`; pull 9 keeps upstream's `config.ts` untouched and derives
 * them here instead (DL-357). The names are V1's exactly, so Phase 4's importer
 * finds existing reports, briefs and launch identities where V1 left them.
 *
 * @module loom/loomPaths
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as NodePath from "node:path";

import type { ServerDerivedPaths } from "../config.ts";

export const loomPaths = (config: Pick<ServerDerivedPaths, "stateDir">) => ({
  workstreamReportsDir: NodePath.join(config.stateDir, "workstream-reports"),
  workstreamBriefsDir: NodePath.join(config.stateDir, "workstream-briefs"),
  workstreamLaunchIdentityDir: NodePath.join(config.stateDir, "workstream-launch-identity"),
  workstreamPromptDebugDir: NodePath.join(config.stateDir, "prompt-debug"),
  workstreamConsultsDir: NodePath.join(config.stateDir, "workstream-consults"),
});

export type LoomPaths = ReturnType<typeof loomPaths>;

/** Creates every Loom directory (idempotent); later sessions call it from their layers. */
export const ensureLoomDirectories = (config: Pick<ServerDerivedPaths, "stateDir">) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      Object.values(loomPaths(config)),
      (directory) => fileSystem.makeDirectory(directory, { recursive: true }),
      { discard: true },
    );
    return loomPaths(config);
  });
