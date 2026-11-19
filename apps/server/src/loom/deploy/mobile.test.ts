import { describe, expect, it } from "vite-plus/test";

import { appChanged, chooseMobile, inputsFromSourceMap, mobileLockSection } from "./mobile.ts";

// A slice of the 19 Nov build's source map, in Metro's own form.
const inputs = inputsFromSourceMap([
  "\u0000polyfill:external-require",
  "/apps/mobile/index.ts",
  "/packages/provider-pi/src/client.ts",
  "/packages/provider-pi/src/settings.ts",
  "/packages/contracts/src/index.ts",
  "/apps/mobile/node_modules/expo/internal/async-require-module.js",
  "/node_modules/.pnpm/expo@58.0.14_ecd3689b2bda1172f8915f190f5c7383/node_modules/expo/virtual/streams.js",
  "/node_modules/.pnpm/expo@58.0.14_ecd3689b2bda1172f8915f190f5c7383/node_modules/expo/src/Expo.ts",
]);

const changedBy = (changed: ReadonlyArray<string> | null) =>
  appChanged({ changed, inputs, lockSectionChanged: false, missingFolder: undefined });

describe("inputsFromSourceMap", () => {
  it("keeps repository files and the dependency folders the bundle read", () => {
    expect(inputs).toEqual({
      repoFiles: [
        "apps/mobile/index.ts",
        "packages/contracts/src/index.ts",
        "packages/provider-pi/src/client.ts",
        "packages/provider-pi/src/settings.ts",
      ],
      depFolders: ["expo@58.0.14_ecd3689b2bda1172f8915f190f5c7383"],
    });
  });
});

describe("appChanged", () => {
  // The real file lists of three past deploys; none changed anything the phone runs.
  it.each([
    [
      "pi bump of 19 Oct (9ddde83460)",
      [
        "docs/operations/platform-update.md",
        "infra/pi-patches/0001-pi-cwd-override-rpc-resume.patch",
        "infra/pi-patches/0002-pi-auth-storage-atomic-write.patch",
        "infra/pi-patches/README.md",
        "patches/@earendil-works__pi-coding-agent@1.1.0.patch",
        "patches/@earendil-works__pi-coding-agent@1.3.0.patch",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "third-party-licenses.config.json",
      ],
    ],
    [
      "pi bump of 10 Nov (58d6ddc4e2)",
      [
        "docs/operations/platform-update.md",
        "infra/pi-patches/0003-pi-cache-warming-idle-horizon.patch",
        "infra/pi-patches/patch-bundle.mjs",
        "patches/@earendil-works__pi-coding-agent@1.3.0.patch",
        "patches/@earendil-works__pi-coding-agent@1.5.1.patch",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "third-party-licenses.config.json",
      ],
    ],
    [
      "server-only provider-pi change of 20 Oct (eb3f98ef40)",
      [
        "packages/provider-pi/src/server/mcpBridge.testkit.ts",
        "packages/provider-pi/src/server/mcpExtensionSource.loom.test.ts",
        "packages/provider-pi/src/server/mcpExtensionSource.test.ts",
        "packages/provider-pi/src/server/mcpExtensionSource.ts",
      ],
    ],
    ["a mobile test and a mobile doc", ["apps/mobile/src/a.test.ts", "apps/mobile/README.md"]],
  ])("builds nothing for the %s", (_name, changed) => {
    expect(changedBy(changed)).toBeNull();
  });

  it.each([
    ["a bundled file", ["packages/provider-pi/src/client.ts"], "is in the APK's bundle"],
    ["a new file under apps/mobile", ["apps/mobile/src/New.tsx"], "is in the app's folder"],
    ["the app config", ["apps/mobile/app.config.ts"], "is in the app's folder"],
    ["a test helper that is not a test", ["apps/mobile/src/fixtures.ts"], "is in the app's folder"],
    ["a brand asset", ["assets/nightly/icon.png"], "configuration or bundler"],
    ["a config helper", ["scripts/lib/brand-assets.ts"], "configuration or bundler"],
    ["a workspace manifest", ["packages/shared/package.json"], "configuration or bundler"],
    ["a native twin", ["packages/shared/src/Net.native.ts"], "configuration or bundler"],
    ["a dependency patch", ["patches/expo-network@58.0.3.patch"], "patches a dependency"],
  ])("builds for %s", (_name, changed, why) => {
    expect(changedBy(changed)).toContain(why);
  });

  it("builds when it cannot decide, or when a dependency moved", () => {
    expect(changedBy(null)).toContain("git could not compare");
    expect(
      appChanged({
        changed: [],
        inputs: null,
        lockSectionChanged: false,
        missingFolder: undefined,
      }),
    ).toContain("saved file list");
    expect(
      appChanged({ changed: [], inputs, lockSectionChanged: true, missingFolder: undefined }),
    ).toContain("pnpm-lock.yaml");
    expect(
      appChanged({ changed: [], inputs, lockSectionChanged: false, missingFolder: "expo@59" }),
    ).toContain("expo@59");
  });
});

describe("mobileLockSection", () => {
  it("is the apps/mobile importer alone", () => {
    const lock = [
      "importers:",
      "  apps/marketing:",
      "    dependencies: {}",
      "  apps/mobile:",
      "    dependencies:",
      "      expo:",
      "        version: 58.0.14",
      "  apps/server:",
      "    dependencies: {}",
    ].join("\n");
    expect(mobileLockSection(lock)).toBe(
      "  apps/mobile:\n    dependencies:\n      expo:\n        version: 58.0.14",
    );
    expect(mobileLockSection("importers:\n")).toBeUndefined();
  });
});

describe("chooseMobile", () => {
  const apks = [{ sha: "c" }, { sha: "b" }];
  const running = { sha: "x", startedAt: "2026-11-19T00:00:00Z", failed: null };
  it.each([
    [
      "a deploy that changed nothing the phone runs",
      { sha: "y", match: "c", build: null, unitActive: false },
      { kind: "match", sha: "c", drop: [], stopBuild: false },
    ],
    [
      "going back: the earlier APK matches and the later goes",
      { sha: "b", match: "b", build: null, unitActive: false },
      { kind: "match", sha: "b", drop: ["c"], stopBuild: false },
    ],
    [
      "going back during a build of the left release",
      { sha: "b", match: "b", build: running, unitActive: true },
      { kind: "match", sha: "b", drop: ["c"], stopBuild: true },
    ],
    [
      "a second trigger for the commit already building",
      { sha: "x", match: null, build: running, unitActive: true },
      { kind: "leave" },
    ],
    [
      "a new release during a build of another commit",
      { sha: "z", match: null, build: running, unitActive: true },
      { kind: "build", stopBuild: true },
    ],
    [
      "a build on record whose unit died",
      { sha: "x", match: null, build: running, unitActive: false },
      { kind: "build", stopBuild: false },
    ],
    [
      "a retry after a failed build",
      { sha: "x", match: null, build: { ...running, failed: "Gradle" }, unitActive: false },
      { kind: "build", stopBuild: false },
    ],
  ] as const)("%s", (_name, input, action) => {
    expect(chooseMobile({ apks, ...input })).toEqual(action);
  });
});
