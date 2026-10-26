/**
 * Age-based pruning for Loom's write-only side directories under the state dir: `prompt-debug/`
 * (a capture per thread, rewritten each agent start) and `workstream-consults/` (one retained fork
 * transcript per consult). Nothing else deletes them, and on the cockpit they grow ~90 MB a day.
 */
import * as Duration from "effect/Duration";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import { loomPaths } from "./loomPaths.ts";

// Outlives every reader: the Prompt menu opens a recent thread's capture, and the consult card
// offers its transcript only while the consult is live.
export const RETENTION = Duration.days(30);
// An unlink is cheap; the bound keeps one pass from monopolising the disk on a first catch-up.
export const BATCH_LIMIT = 2_000;
const INTERVAL = Duration.hours(6);

export interface RetentionEntry {
  readonly name: string;
  readonly mtimeMs: number;
}

/**
 * The names to delete, oldest first and at most `limit`: every entry whose group's newest member is
 * older than `cutoffMs`. Grouping keeps a live thread's write-once `.first.md` while its `.md` is
 * still being rewritten.
 */
export const expiredNames = (
  entries: ReadonlyArray<RetentionEntry>,
  cutoffMs: number,
  limit: number,
  groupOf: (name: string) => string = (name) => name,
) => {
  const newest = new Map<string, number>();
  for (const { name, mtimeMs } of entries) {
    newest.set(groupOf(name), Math.max(newest.get(groupOf(name)) ?? -Infinity, mtimeMs));
  }
  return entries
    .filter(({ name }) => (newest.get(groupOf(name)) ?? Infinity) < cutoffMs)
    .toSorted((left, right) => left.mtimeMs - right.mtimeMs)
    .slice(0, limit)
    .map(({ name }) => name);
};

const isInside = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * Deletes the expired regular files directly in `directory`. Refuses outright unless the
 * directory's real path is inside `root`'s, so a dev home whose directory is a symlink into the
 * live install never prunes it.
 */
export const pruneExpired = Effect.fn("loom.stateDirRetention.prune")(function* (input: {
  readonly root: string;
  readonly directory: string;
  readonly nowMs: number;
  readonly groupOf?: (name: string) => string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* fs.exists(input.directory))) return 0;
  const [root, directory] = yield* Effect.all([
    fs.realPath(input.root),
    fs.realPath(input.directory),
  ]);
  if (!isInside(path, root, directory)) {
    yield* Effect.logWarning("loom.stateDirRetention.outside-root", { root, directory });
    return 0;
  }
  const entries = yield* Effect.forEach(
    yield* fs.readDirectory(directory),
    (name) =>
      fs.stat(path.join(directory, name)).pipe(
        Effect.map((info) =>
          info.type === "File"
            ? [
                {
                  name,
                  mtimeMs: Option.match(info.mtime, {
                    onNone: () => input.nowMs,
                    onSome: (mtime) => mtime.getTime(),
                  }),
                },
              ]
            : [],
        ),
        // Deleted between listing and stat, or unreadable: not this pass's to delete.
        Effect.orElseSucceed(() => []),
      ),
    { concurrency: 8 },
  );
  const expired = expiredNames(
    entries.flat(),
    input.nowMs - Duration.toMillis(RETENTION),
    BATCH_LIMIT,
    input.groupOf,
  );
  yield* Effect.forEach(
    expired,
    (name) => fs.remove(path.join(directory, name)).pipe(Effect.ignore),
    { discard: true },
  );
  return expired.length;
});

/** A startup pass a minute after activation, then every six hours. */
export const LoomStateDirRetentionLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const context = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const { workstreamPromptDebugDir, workstreamConsultsDir } = loomPaths(config);
    const pass = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const promptDebug = yield* pruneExpired({
        root: config.stateDir,
        directory: workstreamPromptDebugDir,
        nowMs,
        groupOf: (name) => name.replace(/\.first\.md$/, ".md"),
      });
      const consults = yield* pruneExpired({
        root: config.stateDir,
        directory: workstreamConsultsDir,
        nowMs,
      });
      if (promptDebug + consults > 0) {
        yield* Effect.logInfo("loom.stateDirRetention.pruned", { promptDebug, consults });
      }
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("loom.stateDirRetention.failed", { cause })),
      Effect.provide(context),
    );
    yield* forkParked(
      Effect.sleep("1 minute").pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(INTERVAL)))),
      ),
    );
  }),
);
