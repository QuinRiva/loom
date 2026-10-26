import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import { BATCH_LIMIT, RETENTION, expiredNames, pruneExpired } from "./stateDirRetention.ts";

const DAY = Duration.toMillis(Duration.days(1));
const NOW = Date.UTC(2026, 9, 27);
const cutoff = NOW - Duration.toMillis(RETENTION);
const promptGroup = (name: string) => name.replace(/\.first\.md$/, ".md");

describe("expiredNames", () => {
  it("deletes only past the cutoff, oldest first, at most the limit", () => {
    const entries = [
      { name: "young", mtimeMs: cutoff + DAY },
      { name: "older", mtimeMs: cutoff - 2 * DAY },
      { name: "oldest", mtimeMs: cutoff - 5 * DAY },
      { name: "old", mtimeMs: cutoff - DAY },
      { name: "edge", mtimeMs: cutoff },
    ];
    assert.deepStrictEqual(expiredNames(entries, cutoff, 10), ["oldest", "older", "old"]);
    assert.deepStrictEqual(expiredNames(entries, cutoff, 2), ["oldest", "older"]);
  });

  it("keeps a live thread's kickoff capture while its latest capture is fresh", () => {
    const entries = [
      { name: "live.first.md", mtimeMs: cutoff - 40 * DAY },
      { name: "live.md", mtimeMs: cutoff + DAY },
      { name: "gone.first.md", mtimeMs: cutoff - 40 * DAY },
      { name: "gone.md", mtimeMs: cutoff - DAY },
    ];
    assert.deepStrictEqual(expiredNames(entries, cutoff, 10, promptGroup), [
      "gone.first.md",
      "gone.md",
    ]);
  });
});

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-loom-retention-" });
  // Node reads a numeric time as seconds.
  const touch = (file: string, mtimeMs: number) =>
    fs
      .writeFileString(file, "x")
      .pipe(Effect.andThen(fs.utimes(file, mtimeMs / 1000, mtimeMs / 1000)));
  return { fs, path, root, touch };
});

describe("pruneExpired", () => {
  it.effect("removes expired files in bounded batches and leaves fresh ones and directories", () =>
    Effect.gen(function* () {
      const { fs, path, root, touch } = yield* setup;
      const directory = path.join(root, "prompt-debug");
      yield* fs.makeDirectory(path.join(directory, "nested"), { recursive: true });
      yield* fs.utimes(path.join(directory, "nested"), 0, 0);
      yield* Effect.forEach(
        Array.from({ length: BATCH_LIMIT + 3 }, (_, index) => index),
        (index) => touch(path.join(directory, `old-${index}.md`), cutoff - DAY - index),
      );
      yield* touch(path.join(directory, "fresh.md"), NOW);

      const prune = pruneExpired({ root, directory, nowMs: NOW });
      assert.strictEqual(yield* prune, BATCH_LIMIT);
      assert.strictEqual(yield* prune, 3);
      assert.strictEqual(yield* prune, 0);
      assert.deepStrictEqual((yield* fs.readDirectory(directory)).toSorted(), [
        "fresh.md",
        "nested",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.skipIf(!symlinksSupported)("refuses a directory whose real path leaves the root", () =>
    Effect.gen(function* () {
      const { fs, path, root, touch } = yield* setup;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-loom-retention-live-" });
      yield* touch(path.join(outside, "live.md"), cutoff - 10 * DAY);
      const home = path.join(root, "home");
      yield* fs.makeDirectory(home);
      yield* fs.symlink(outside, path.join(home, "prompt-debug"));

      for (const directory of [path.join(home, "prompt-debug"), outside, home]) {
        assert.strictEqual(yield* pruneExpired({ root: home, directory, nowMs: NOW }), 0);
      }
      assert.deepStrictEqual(yield* fs.readDirectory(outside), ["live.md"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
