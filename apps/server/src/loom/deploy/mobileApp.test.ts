import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { LoomMobileAppFile } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { AssetSigner } from "../../assets/AssetSigner.ts";
import * as PayloadSigner from "../../auth/PayloadSigner.ts";
import { BUILD_GIVE_UP_MS, makeMobileApp, MOBILE_APK_ROUTE, mobileAppState } from "./mobileApp.ts";

const SHA = "9f8e7d6c5b4a39281706f5e4d3c2b1a098765432";

const stateFile = (apkPath: string): LoomMobileAppFile => ({
  apks: [
    {
      sha: SHA,
      committedAt: "2026-11-19T02:00:00Z",
      builtAt: "2026-11-19T02:30:00Z",
      bytes: 3,
      file: apkPath,
    },
  ],
  current: SHA,
  build: null,
});

const TestLayer = Layer.effect(
  AssetSigner,
  PayloadSigner.fromSecret(new Uint8Array(32).fill(7)),
).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-loom-mobile-app-" });
  const apk = path.join(dir, "loom-9f8e7d6.apk");
  yield* fs.writeFileString(apk, "apk");
  const statePath = path.join(dir, "mobile-app.json");
  yield* fs.writeFileString(statePath, JSON.stringify(stateFile(apk)));
  return { apk, mobileApp: yield* makeMobileApp(statePath) };
});

const tokenOf = (relativeUrl: string) => relativeUrl.split("/").at(-2)!;

it.layer(TestLayer)("the phone app's APK link", (it) => {
  it.effect("round-trips to the stored file and names it by its short sha", () =>
    Effect.gen(function* () {
      const { apk, mobileApp } = yield* setup;
      const url = Option.getOrThrow(yield* mobileApp.apkUrl(SHA));
      assert.isTrue(url.relativeUrl.startsWith(`${MOBILE_APK_ROUTE}/`));
      assert.isTrue(url.relativeUrl.endsWith("/loom-9f8e7d6.apk"));
      assert.deepStrictEqual(yield* mobileApp.apkFile(tokenOf(url.relativeUrl)), Option.some(apk));
    }),
  );

  it.effect("refuses an unknown sha, a tampered token and an expired one", () =>
    Effect.gen(function* () {
      const { mobileApp } = yield* setup;
      assert.isTrue(Option.isNone(yield* mobileApp.apkUrl("0".repeat(40))));
      const token = tokenOf(Option.getOrThrow(yield* mobileApp.apkUrl(SHA)).relativeUrl);
      const [payload, signature] = token.split(".");
      const forged = Buffer.from(
        JSON.stringify({ kind: "loom-mobile-apk", sha: SHA, expiresAt: Number.MAX_SAFE_INTEGER }),
      ).toString("base64url");
      assert.isTrue(Option.isNone(yield* mobileApp.apkFile(`${forged}.${signature}`)));
      assert.isTrue(Option.isNone(yield* mobileApp.apkFile(`${payload}.x${signature}`)));
      assert.isTrue(Option.isNone(yield* mobileApp.apkFile("")));
      yield* TestClock.adjust("15 minutes");
      assert.isTrue(Option.isNone(yield* mobileApp.apkFile(token)));
    }),
  );
});

it("streams the file without its paths, and reads a build running past 90 minutes as failed", () => {
  const startedAt = "2026-11-19T02:00:00Z";
  const file = {
    ...stateFile("/x/loom-9f8e7d6.apk"),
    build: { sha: SHA, startedAt, failed: null },
  };
  const at = (ms: number) => mobileAppState(file, Date.parse(startedAt) + ms);
  assert.notProperty(at(0).apks[0], "file");
  assert.isNull(at(BUILD_GIVE_UP_MS).build?.failed);
  assert.equal(at(BUILD_GIVE_UP_MS + 1).build?.failed, "The build did not finish.");
  assert.deepStrictEqual(mobileAppState(null, 0), { apks: [], current: null, build: null });
});
