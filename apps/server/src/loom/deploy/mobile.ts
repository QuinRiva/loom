// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
// The phone app's APK (plans/mobile-self-hosted-updates/plan.mdx §2, §4): when a release's app code
// differs from every stored APK's, build one in its own unit, check it and publish it. Node
// built-ins only, like the rest of loom-deploy, which runs from source.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { LoomMobileAppFile } from "@t3tools/contracts";

import {
  type DeployConfig,
  homePaths,
  isoAt,
  nowIso,
  readJson,
  releaseSha,
  run,
  storePaths,
  systemctl,
  writeJsonAtomic,
} from "./store.ts";

type MobileConfig = NonNullable<DeployConfig["mobile"]>;
type StoredApk = LoomMobileAppFile["apks"][number];

/** What a published APK's JavaScript bundle was built from, saved beside it. */
export interface AppInputs {
  readonly repoFiles: ReadonlyArray<string>;
  readonly depFolders: ReadonlyArray<string>;
}

const PACKAGE = "com.t3tools.t3code.preview";
const CERT_SHA256 = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c";
const MIN_FREE_BYTES = 30 * 1024 ** 3;
const BUILD_MAX_SECONDS = 90 * 60;
const SOURCE_MAP =
  "apps/mobile/android/app/build/generated/sourcemaps/react/release/index.android.bundle.map";
const BUILT_APK = "apps/mobile/android/app/build/outputs/apk/release/app-release.apk";

/** A source map's sources, as Metro writes them: `/<repo path>` and `/node_modules/.pnpm/<folder>/…`. */
export function inputsFromSourceMap(sources: ReadonlyArray<string>): AppInputs {
  const repoFiles = sources.filter((s) => s.startsWith("/") && !s.includes("/node_modules/"));
  const depFolders = sources.flatMap((s) => /\/node_modules\/\.pnpm\/([^/]+)\//.exec(s)?.[1] ?? []);
  return {
    repoFiles: [...new Set(repoFiles.map((s) => s.slice(1)))].toSorted(),
    depFolders: [...new Set(depFolders)].toSorted(),
  };
}

/** The `apps/mobile` importer of pnpm-lock.yaml: every direct dependency's resolved version and patch. */
export function mobileLockSection(lockfile: string): string | undefined {
  const lines = lockfile.split("\n");
  const start = lines.indexOf("  apps/mobile:");
  if (start === -1) return undefined;
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join("\n");
}

const isTest = (path: string) => /(^|\/)__tests__\//.test(path) || /\.test\.[^/]+$/.test(path);

/**
 * Why the app's code at a release differs from a stored APK's, or null when it does not (§2). The
 * cost of a wrong null is a phone silently behind, so whatever cannot be decided is a difference.
 */
export function appChanged(input: {
  /** `git diff --name-only --no-renames` between the two commits; null when git could not. */
  readonly changed: ReadonlyArray<string> | null;
  readonly inputs: AppInputs | null;
  readonly lockSectionChanged: boolean;
  /** A folder the bundle read that the release's `node_modules/.pnpm` lacks. */
  readonly missingFolder: string | undefined;
}): string | null {
  if (input.changed === null) return "git could not compare the two commits";
  if (input.inputs === null) return "the APK's saved file list is missing or unreadable";
  const bundled = new Set(input.inputs.repoFiles);
  const rules: ReadonlyArray<readonly [string, (path: string) => boolean]> = [
    ["is in the APK's bundle", (path) => bundled.has(path)],
    [
      "is in the app's folder",
      (path) => path.startsWith("apps/mobile/") && !isTest(path) && !path.endsWith(".md"),
    ],
    [
      "is read by the app's configuration or bundler",
      (path) =>
        path.startsWith("assets/") ||
        path.startsWith("scripts/lib/") ||
        /^packages\/[^/]+\/package\.json$/.test(path) ||
        (path.startsWith("packages/") && /\.(android|native)\./.test(NodePath.basename(path))),
    ],
    [
      "patches a dependency",
      (path) =>
        path.startsWith("patches/") &&
        !path.startsWith("patches/@earendil-works__pi-coding-agent@"),
    ],
  ];
  for (const [why, test] of rules) {
    const path = input.changed.find(test);
    if (path !== undefined) return `${path} ${why}`;
  }
  if (input.lockSectionChanged) return "the app's dependencies in pnpm-lock.yaml changed";
  if (input.missingFolder !== undefined)
    return `the bundled dependency ${input.missingFolder} is not installed in the release`;
  return null;
}

export type MobileAction =
  | {
      readonly kind: "match";
      readonly sha: string;
      readonly drop: ReadonlyArray<string>;
      readonly stopBuild: boolean;
    }
  | { readonly kind: "leave" }
  | { readonly kind: "build"; readonly stopBuild: boolean };

/** The reconcile decision (§4) from the stored APKs (newest first), the match and the build on record. */
export function chooseMobile(input: {
  readonly sha: string;
  readonly apks: ReadonlyArray<{ readonly sha: string }>;
  readonly match: string | null;
  readonly build: LoomMobileAppFile["build"];
  readonly unitActive: boolean;
}): MobileAction {
  if (input.match !== null) {
    const index = input.apks.findIndex((apk) => apk.sha === input.match);
    return {
      kind: "match",
      sha: input.match,
      drop: input.apks.slice(0, Math.max(0, index)).map((apk) => apk.sha),
      stopBuild: input.unitActive,
    };
  }
  if (input.unitActive && input.build?.sha === input.sha && input.build.failed === null)
    return { kind: "leave" };
  return { kind: "build", stopBuild: input.unitActive };
}

const EMPTY: LoomMobileAppFile = { apks: [], current: null, build: null };
export const readMobileFile = (config: DeployConfig): LoomMobileAppFile =>
  readJson<LoomMobileAppFile>(homePaths(config).mobileApp) ?? EMPTY;
const writeMobileFile = (config: DeployConfig, file: LoomMobileAppFile) => {
  NodeFS.mkdirSync(config.stateDir, { recursive: true });
  writeJsonAtomic(homePaths(config).mobileApp, file);
};
const inputsFile = (apk: string) => apk.replace(/\.apk$/, ".inputs.json");
const removeApk = (apk: StoredApk) => {
  NodeFS.rmSync(apk.file, { force: true });
  NodeFS.rmSync(inputsFile(apk.file), { force: true });
};
const unitActive = (mobile: MobileConfig) =>
  systemctl("is-active", mobile.unit).stdout.trim() === "active";

function readInputs(apk: StoredApk): AppInputs | null {
  const inputs = readJson<Partial<AppInputs>>(inputsFile(apk.file));
  return Array.isArray(inputs?.repoFiles) && Array.isArray(inputs.depFolders)
    ? { repoFiles: inputs.repoFiles, depFolders: inputs.depFolders }
    : null;
}

/** §2's rule between a stored APK and a release, read from the store's mirror and the release's install. */
function differsFrom(config: DeployConfig, releaseDir: string, sha: string, apk: StoredApk) {
  if (apk.sha === sha) return null;
  const mirror = storePaths(config.root).mirror;
  const diff = run("git", ["-C", mirror, "diff", "--name-only", "--no-renames", apk.sha, sha]);
  const lock = (at: string) => {
    const shown = run("git", ["-C", mirror, "show", `${at}:pnpm-lock.yaml`]);
    return shown.code === 0 ? mobileLockSection(shown.stdout) : undefined;
  };
  const [before, after] = [lock(apk.sha), lock(sha)];
  const inputs = readInputs(apk);
  const pnpmDir = NodePath.join(releaseDir, "node_modules", ".pnpm");
  return appChanged({
    changed: diff.code === 0 ? diff.stdout.split("\n").filter(Boolean) : null,
    inputs,
    lockSectionChanged: before === undefined || before !== after,
    missingFolder: inputs?.depFolders.find(
      (folder) => !NodeFS.existsSync(NodePath.join(pnpmDir, folder)),
    ),
  });
}

/**
 * The one rule (§1): offer the stored APK whose app code equals the release's, or build one. Run by
 * after-accept, back and `loom-deploy apk`. Never throws: a deploy must not fail for the app.
 */
export function reconcileMobile(
  config: DeployConfig,
  releaseDir: string,
  log: (line: string) => void,
): void {
  const mobile = config.mobile;
  if (mobile === null) return;
  try {
    const sha = releaseSha(config.root, releaseDir);
    const file = readMobileFile(config);
    const stored = file.apks.filter((apk) => NodeFS.existsSync(apk.file));
    let match: string | null = null;
    for (const apk of stored) {
      const why = differsFrom(config, releaseDir, sha, apk);
      log(`phone app: ${apk.sha.slice(0, 7)} ${why === null ? "matches" : `differs: ${why}`}`);
      if (why === null) {
        match = apk.sha;
        break;
      }
    }
    const action = chooseMobile({
      sha,
      apks: stored,
      match,
      build: file.build,
      unitActive: unitActive(mobile),
    });
    if (action.kind !== "leave" && action.stopBuild) systemctl("stop", mobile.unit);
    if (action.kind === "leave") {
      log(`phone app: a build of ${sha.slice(0, 7)} is already running`);
    } else if (action.kind === "match") {
      writeMobileFile(config, {
        apks: stored.filter((apk) => !action.drop.includes(apk.sha)),
        current: action.sha,
        build: null,
      });
      for (const apk of stored.filter((apk) => action.drop.includes(apk.sha))) removeApk(apk);
      log(
        `phone app: offering ${action.sha.slice(0, 7)}${action.drop.length > 0 ? `; removed ${action.drop.map((s) => s.slice(0, 7)).join(", ")}` : ""}`,
      );
    } else {
      startBuild(config, mobile, releaseDir, sha, stored, log);
    }
  } catch (error) {
    log(`phone app: reconcile failed (ignored): ${String(error)}`);
  }
}

function startBuild(
  config: DeployConfig,
  mobile: MobileConfig,
  releaseDir: string,
  sha: string,
  stored: ReadonlyArray<StoredApk>,
  log: (line: string) => void,
) {
  const build = { sha, startedAt: nowIso(), failed: null };
  writeMobileFile(config, { apks: stored, current: null, build });
  // The job runs from the code deciding, so a release from before this feature can still be built.
  const started = run("systemd-run", [
    "--user",
    `--unit=${mobile.unit}`,
    "--collect",
    "--quiet",
    "--property=Nice=10",
    "--property=CPUWeight=20",
    "--property=IOWeight=20",
    // The first process the kernel kills under memory pressure, before any agent's.
    "--property=OOMScoreAdjust=1000",
    `--property=RuntimeMaxSec=${BUILD_MAX_SECONDS}`,
    `--working-directory=${config.root}`,
    process.execPath,
    NodePath.join(import.meta.dirname, "cli.ts"),
    releaseDir,
    "apk-build",
  ]);
  if (started.code !== 0) {
    const failed = `Could not start the build: ${started.stderr.trim()}`;
    writeMobileFile(config, { apks: stored, current: null, build: { ...build, failed } });
    log(`phone app: ${failed}`);
    return;
  }
  log(`phone app: building ${sha.slice(0, 7)} in ${mobile.unit}.service`);
}

/** The `status` line: what the phone is offered and what is building. */
export function describeMobile(config: DeployConfig): string {
  if (config.mobile === null) return "not built here (no mobile key in deploy.json)";
  const file = readMobileFile(config);
  const current = file.apks.find((apk) => apk.sha === file.current);
  return [
    current ? `offering ${current.sha.slice(0, 7)}` : "no APK matches the running release",
    `${file.apks.length} stored`,
    file.build === null
      ? ""
      : file.build.failed !== null
        ? `build of ${file.build.sha.slice(0, 7)} failed: ${file.build.failed}`
        : `building ${file.build.sha.slice(0, 7)} since ${file.build.startedAt}${unitActive(config.mobile) ? "" : ` (but ${config.mobile.unit} is not running)`}`,
  ]
    .filter(Boolean)
    .join("; ");
}

const newestBuildTools = (androidHome: string) => {
  const root = NodePath.join(androidHome, "build-tools");
  const newest = (NodeFS.existsSync(root) ? NodeFS.readdirSync(root) : [])
    .toSorted((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .at(-1);
  return newest === undefined ? undefined : NodePath.join(root, newest);
};

/** §4's six checks on a built APK; each line says what was found. */
function checkApk(
  mobile: MobileConfig,
  apk: string,
  sha: string,
): ReadonlyArray<{ readonly check: string; readonly ok: boolean; readonly found: string }> {
  const tools = newestBuildTools(mobile.androidHome);
  if (tools === undefined)
    return [{ check: "build tools", ok: false, found: `none under ${mobile.androidHome}` }];
  const env = {
    ...process.env,
    JAVA_HOME: mobile.javaHome,
    PATH: `${mobile.javaHome}/bin:${process.env.PATH ?? ""}`,
  };
  const tool = (name: string, args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync(NodePath.join(tools, name), args, {
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout : "";
  };
  const badging = tool("aapt2", ["dump", "badging", apk]);
  const name = /^package: name='([^']*)'/m.exec(badging)?.[1] ?? "unreadable";
  const versionCode = /versionCode='([^']*)'/.exec(badging)?.[1] ?? "unreadable";
  const certs = [
    ...tool("apksigner", ["verify", "--print-certs", apk]).matchAll(
      /certificate SHA-256 digest: ([0-9a-f]+)/g,
    ),
  ].map((match) => match[1]!);
  const manifest = tool("aapt2", ["dump", "xmltree", "--file", "AndroidManifest.xml", apk]).split(
    "\n",
  );
  const updatesAt = manifest.findIndex((line) => line.includes('"expo.modules.updates.ENABLED"'));
  const updates =
    updatesAt === -1
      ? "absent"
      : (/:value\(0x[0-9a-f]+\)="?([^"\s]+)/.exec(manifest[updatesAt + 1] ?? "")?.[1] ??
        "unreadable");
  const permission = tool("aapt2", ["dump", "permissions", apk]).includes(
    "name='android.permission.REQUEST_INSTALL_PACKAGES'",
  );
  const config = NodeChildProcess.spawnSync("unzip", ["-p", apk, "assets/app.config"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  }).stdout;
  let stamp = "absent";
  try {
    const loomBuild = (JSON.parse(config) as { extra?: { loomBuild?: { sha?: unknown } } }).extra
      ?.loomBuild;
    stamp = typeof loomBuild?.sha === "string" ? loomBuild.sha : "absent";
  } catch {
    stamp = "unreadable";
  }
  return [
    { check: "package", ok: name === PACKAGE, found: name },
    { check: "version code", ok: versionCode === "1", found: versionCode },
    {
      check: "signing certificate",
      ok: certs.length > 0 && certs.every((cert) => cert === CERT_SHA256),
      found: certs.join(", ") || "unreadable",
    },
    { check: "updates through Expo", ok: updates === "false", found: updates },
    { check: "install permission", ok: permission, found: permission ? "declared" : "absent" },
    { check: "build stamp", ok: stamp === sha, found: stamp },
  ];
}

/**
 * `apk-build`, run inside the build unit (§4): a fresh checkout of the release's commit, install,
 * prebuild, Gradle, the six checks, publish. It decides nothing; any failure is recorded and
 * nothing is published.
 */
export async function apkBuild(config: DeployConfig, releaseDir: string): Promise<number> {
  const mobile = config.mobile;
  if (mobile === null) return 2;
  const mirror = storePaths(config.root).mirror;
  const sha = releaseSha(config.root, releaseDir);
  const dirs = {
    build: NodePath.join(mobile.dir, "build"),
    tmp: NodePath.join(mobile.dir, "tmp"),
    cache: NodePath.join(mobile.dir, "cache"),
    apks: NodePath.join(mobile.dir, "apks"),
  };
  NodeFS.mkdirSync(mobile.dir, { recursive: true });
  const logFd = NodeFS.openSync(NodePath.join(mobile.dir, "build.log"), "w");
  const say = (line: string) => {
    const stamped = `[apk-build ${nowIso()}] ${line}\n`;
    process.stdout.write(stamped);
    NodeFS.writeSync(logFd, stamped);
  };
  const onRecord = readMobileFile(config).build;
  const startedAt = onRecord?.sha === sha ? onRecord.startedAt : nowIso();
  const ours = (build: LoomMobileAppFile["build"]) =>
    build === null || (build.sha === sha && build.startedAt === startedAt);
  const clean = () => {
    NodeFS.rmSync(dirs.build, { recursive: true, force: true });
    NodeFS.rmSync(dirs.tmp, { recursive: true, force: true });
    run("git", ["-C", mirror, "worktree", "prune"]);
  };
  const fail = (reason: string) => {
    say(`failed: ${reason}`);
    const file = readMobileFile(config);
    if (ours(file.build))
      writeMobileFile(config, { ...file, build: { sha, startedAt, failed: reason } });
    clean();
    return 1;
  };
  let child: NodeChildProcess.ChildProcess | undefined;
  process.on("SIGTERM", () => {
    child?.kill("SIGTERM");
    process.exit(fail("The build was stopped: by a newer deploy, by hand, or after 90 minutes."));
  });
  const committed = run("git", ["-C", mirror, "log", "-1", "--format=%cI", sha]).stdout.trim();
  const committedAt = committed === "" ? startedAt : isoAt(Date.parse(committed));
  // A unit started by systemd-run gets the user manager's environment, so every variable is set here.
  const env = {
    HOME: process.env.HOME ?? "",
    PATH: `${NodePath.dirname(process.execPath)}:${config.path}`,
    TMPDIR: dirs.tmp,
    // Everything a tool caches outside the mobile directory would land on the root disk.
    XDG_CACHE_HOME: dirs.cache,
    GRADLE_USER_HOME: NodePath.join(mobile.dir, "gradle"),
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    CI: "1",
    APP_VARIANT: "preview",
    T3CODE_MOBILE_UPDATES_ENABLED: "0",
    EXPO_NO_GIT_STATUS: "1",
    LOOM_BUILD_SHA: sha,
    LOOM_BUILD_COMMITTED_AT: committedAt,
    ANDROID_HOME: mobile.androidHome,
    ANDROID_SDK_ROOT: mobile.androidHome,
    JAVA_HOME: mobile.javaHome,
  };
  const step = (what: string, command: string, args: ReadonlyArray<string>, cwd: string) =>
    new Promise<number>((resolve) => {
      say(`${what}: ${command} ${args.join(" ")}`);
      child = NodeChildProcess.spawn(command, args, {
        cwd,
        env: what === "gradle" ? { ...env, NODE_ENV: "production" } : env,
        stdio: ["ignore", logFd, logFd],
      });
      child.once("error", () => resolve(127));
      child.once("exit", (code) => resolve(code ?? 1));
    });

  const steps = async (): Promise<number> => {
    say(`building ${sha} (committed ${committedAt}) from ${releaseDir}`);
    const free = NodeFS.statfsSync(mobile.dir);
    const freeGb = (free.bavail * free.bsize) / 1024 ** 3;
    if (free.bavail * free.bsize < MIN_FREE_BYTES)
      return fail(
        `Only ${freeGb.toFixed(0)} GB free on the disk of ${mobile.dir}; a build needs 30 GB.`,
      );
    say(`${freeGb.toFixed(0)} GB free`);
    clean();
    NodeFS.mkdirSync(dirs.tmp, { recursive: true });
    const added = run("git", ["-C", mirror, "worktree", "add", "--detach", dirs.build, sha]);
    if (added.code !== 0)
      return fail(`Could not check out ${sha.slice(0, 7)}: ${added.stderr.trim()}`);
    const app = NodePath.join(dirs.build, "apps", "mobile");
    const steps: ReadonlyArray<readonly [string, string, ReadonlyArray<string>, string]> = [
      [
        "install",
        "pnpm",
        ["install", "--frozen-lockfile", "--store-dir", NodePath.join(mobile.dir, "pnpm-store")],
        dirs.build,
      ],
      ["prebuild", "npx", ["expo", "prebuild", "--clean", "--platform", "android"], app],
      [
        "gradle",
        "./gradlew",
        [
          "assembleRelease",
          "--no-daemon",
          "-PreactNativeArchitectures=arm64-v8a",
          "-Dorg.gradle.jvmargs=-Xmx8g -XX:MaxMetaspaceSize=2g",
          // A missing NDK or platform fails the build instead of downloading onto the SDK's disk.
          "-Pandroid.builder.sdkDownload=false",
        ],
        NodePath.join(app, "android"),
      ],
    ];
    for (const [what, command, args, cwd] of steps) {
      const code = await step(what, command, args, cwd);
      if (code !== 0)
        return fail(`The ${what} step failed (exit ${code}); see ${mobile.dir}/build.log.`);
    }

    const built = NodePath.join(dirs.build, BUILT_APK);
    if (!NodeFS.existsSync(built)) return fail("Gradle finished but left no APK.");
    const checks = checkApk(mobile, built, sha);
    for (const { check, ok, found } of checks)
      say(`check ${ok ? "ok  " : "FAIL"} ${check}: ${found}`);
    const failed = checks.filter((check) => !check.ok);
    if (failed.length > 0)
      return fail(
        `The APK failed its checks: ${failed.map(({ check, found }) => `${check} is ${found}`).join("; ")}.`,
      );
    const sources = readJson<{ sources?: unknown }>(NodePath.join(dirs.build, SOURCE_MAP))?.sources;
    if (!Array.isArray(sources)) return fail("Gradle left no readable source map for the bundle.");
    const inputs = inputsFromSourceMap(sources.filter((s): s is string => typeof s === "string"));

    // Publish: the file through a temporary name, its inputs, then the state that names it.
    NodeFS.mkdirSync(dirs.apks, { recursive: true });
    const target = NodePath.join(dirs.apks, `loom-${sha.slice(0, 7)}.apk`);
    NodeFS.copyFileSync(built, `${target}.tmp`);
    NodeFS.renameSync(`${target}.tmp`, target);
    writeJsonAtomic(inputsFile(target), inputs);
    const file = readMobileFile(config);
    const others = file.apks.filter((apk) => apk.sha !== sha);
    const apk: StoredApk = {
      sha,
      committedAt,
      builtAt: nowIso(),
      bytes: NodeFS.statSync(target).size,
      file: target,
    };
    writeMobileFile(config, { apks: [apk, ...others.slice(0, 1)], current: sha, build: null });
    for (const old of others.slice(1)) removeApk(old);
    say(
      `published ${target} (${apk.bytes} bytes; ${inputs.repoFiles.length} repository files, ${inputs.depFolders.length} dependency folders)`,
    );
    clean();
    NodeFS.closeSync(logFd);
    return 0;
  };
  try {
    return await steps();
  } catch (error) {
    return fail(`The build job failed: ${String(error)}`);
  }
}
