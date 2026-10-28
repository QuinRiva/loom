import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LoomDeployNotice } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { layer, LoomDeployNotices, readDeployNotice } from "./LoomDeployNotices.ts";

const notice: LoomDeployNotice = {
  id: "r1@2026-10-27T22:15:42Z",
  kind: "updated",
  reason: null,
  at: "2026-10-27T22:15:42Z",
  release: { id: "r1", sha: "e5bc19c" },
  restored: null,
  lostSince: null,
  headline: null,
  changes: [
    {
      pr: 499,
      title: "fix(web): chat tables no longer crop",
      summary: null,
      kind: null,
      threadId: null,
      url: "https://github.com/QuinRiva/loom/pull/499",
    },
  ],
};

const inTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-loom-deploy-" });
  const file = (yield* Path.Path).join(dir, "deploy-notice.json");
  return { fs, dir, file };
});

it.layer(NodeServices.layer)("deploy notice", (it) => {
  it.effect("reads a valid file and keeps null for an absent, malformed or misshapen one", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* inTempDir;
      assert.isNull(yield* readDeployNotice(file));
      yield* fs.writeFileString(file, "{ not json");
      assert.isNull(yield* readDeployNotice(file));
      yield* fs.writeFileString(file, JSON.stringify({ ...notice, kind: "promoted" }));
      assert.isNull(yield* readDeployNotice(file));
      yield* fs.writeFileString(file, JSON.stringify(notice));
      assert.deepStrictEqual(yield* readDeployNotice(file), notice);
    }),
  );

  it.effect("each subscription starts with the startup notice", () =>
    Effect.gen(function* () {
      const { fs, dir, file } = yield* inTempDir;
      yield* fs.writeFileString(file, JSON.stringify(notice));
      const first = yield* Effect.gen(function* () {
        return yield* Stream.runHead((yield* LoomDeployNotices).events);
      }).pipe(
        Effect.provide(
          layer.pipe(Layer.provide(Layer.succeed(ServerConfig, { stateDir: dir } as never))),
        ),
      );
      assert.deepStrictEqual(Option.getOrThrow(first), { type: "notice", notice });
    }),
  );
});
