// @effect-diagnostics nodeBuiltinImport:off - builds a real origin and mirror with git.
import * as NodeChildProcess from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthEnvironmentMaintainScope,
  LOOM_WS_METHODS,
  type LoomDeployNotice,
  type LoomDeployStatus,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { AssetSigner } from "../../assets/AssetSigner.ts";
import { EnvironmentAuth } from "../../auth/EnvironmentAuth.ts";
import { requiredScopeForRpcMethod } from "../../auth/RpcAuthorization.ts";
import { ServerSelfUpdate } from "../../cloud/selfUpdate.ts";
import { ServerConfig } from "../../config.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  countPrsBehind,
  layer,
  LoomDeploy,
  readDeployNotice,
  readDeployStatus,
} from "./LoomDeploy.ts";

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

const status: LoomDeployStatus = {
  id: "20261112-031502-ab12cd3",
  sha: "ab12cd3",
  version: "100.20261112.1",
  phase: "watching",
  origin: "loom",
  who: "Carl's laptop",
  noReturn: false,
  startedAt: "2026-11-12T03:15:02Z",
  stopAt: "2026-11-12T03:17:32Z",
  watchUntil: "2026-11-12T03:23:10Z",
  reason: null,
  bridge: null,
  at: "2026-11-12T03:18:10Z",
};

const inTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-loom-deploy-" });
  const path = yield* Path.Path;
  return { fs, dir, file: (name: string) => path.join(dir, name) };
});

it.layer(NodeServices.layer)("deploy files and events", (it) => {
  it.effect("reads a valid notice and keeps null for an absent, malformed or misshapen one", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* inTempDir;
      const path = file("deploy-notice.json");
      assert.isNull(yield* readDeployNotice(path));
      yield* fs.writeFileString(path, "{ not json");
      assert.isNull(yield* readDeployNotice(path));
      yield* fs.writeFileString(path, JSON.stringify({ ...notice, kind: "promoted" }));
      assert.isNull(yield* readDeployNotice(path));
      yield* fs.writeFileString(path, JSON.stringify(notice));
      assert.deepStrictEqual(yield* readDeployNotice(path), notice);
    }),
  );

  it.effect("ignores a status file that does not decode, as it does the notice", () =>
    Effect.gen(function* () {
      const { fs, file } = yield* inTempDir;
      const path = file("deploy-status.json");
      assert.isNull(yield* readDeployStatus(path));
      yield* fs.writeFileString(path, '{"phase": "building"');
      assert.isNull(yield* readDeployStatus(path));
      yield* fs.writeFileString(path, JSON.stringify({ ...status, phase: "promoted" }));
      assert.isNull(yield* readDeployStatus(path));
      yield* fs.writeFileString(path, JSON.stringify(status));
      assert.deepStrictEqual(yield* readDeployStatus(path), status);
    }),
  );

  it.effect("a server the launcher did not start opens with the notice, not the control", () =>
    Effect.gen(function* () {
      const { fs, dir, file } = yield* inTempDir;
      yield* fs.writeFileString(file("deploy-notice.json"), JSON.stringify(notice));
      yield* fs.writeFileString(file("deploy-status.json"), JSON.stringify(status));
      const first = yield* Effect.gen(function* () {
        return yield* Stream.runHead((yield* LoomDeploy).events);
      }).pipe(
        Effect.provide(
          layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ServerConfig, { stateDir: dir, baseDir: dir } as never),
                Layer.mock(ServerSelfUpdate)({}),
                Layer.mock(EnvironmentAuth)({}),
                Layer.mock(AssetSigner)({}),
              ),
            ),
          ),
        ),
      );
      assert.deepStrictEqual(Option.getOrThrow(first), { type: "notice", notice });
    }),
  );
});

it.live("counts PRs merged to main since the release from a fresh fetch, and none on failure", () =>
  Effect.gen(function* () {
    const { fs, file } = yield* inTempDir;
    const origin = file("origin");
    const mirror = file("mirror.git");
    const git = (cwd: string, ...args: Array<string>) =>
      NodeChildProcess.execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], {
        cwd,
        encoding: "utf8",
      }).trim();
    const landPr = (n: number) => {
      git(origin, "checkout", "-q", "-b", `pr${n}`, "main");
      git(origin, "commit", "-q", "--allow-empty", "-m", `change ${n}`);
      git(origin, "checkout", "-q", "main");
      git(
        origin,
        "merge",
        "-q",
        "--no-ff",
        "-m",
        `Merge pull request #${n} from x/pr${n}`,
        `pr${n}`,
      );
    };
    yield* fs.makeDirectory(origin);
    git(origin, "init", "-q", "-b", "main");
    git(origin, "commit", "-q", "--allow-empty", "-m", "released");
    const released = git(origin, "rev-parse", "HEAD");
    git(file("."), "clone", "-q", "--bare", origin, mirror);
    landPr(1);
    git(origin, "commit", "-q", "--allow-empty", "-m", "a direct commit is not a PR");
    const count = countPrsBehind(mirror, "main", released);
    assert.equal(yield* count, 1);
    landPr(2);
    assert.equal(yield* count, 2);
    // The mirror's own branches are `loom-deploy`'s and stay where its last fetch left them.
    assert.equal(git(mirror, "rev-parse", "main"), released);
    yield* fs.remove(origin, { recursive: true });
    assert.isNull(yield* count);
  }).pipe(Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))),
);

it("the server requires environment:maintain to start or cancel a deploy", () => {
  for (const method of [LOOM_WS_METHODS.startDeploy, LOOM_WS_METHODS.cancelDeploy]) {
    assert.equal(requiredScopeForRpcMethod(method), AuthEnvironmentMaintainScope);
  }
});
