// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalFetch:off
// @effect-diagnostics extendsNativeError:off
// @effect-diagnostics globalDate:off
// `loom-deploy` (plans/loom-deploy-redesign §3.2): its verbs, and the engine that builds a release,
// trial-starts it and asks for the switch. Run from source by deploy/loom-deploy, which passes the
// release folder it sits in first.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  decodeServiceState,
  parseServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
} from "../../cloud/serviceProtocol.ts";
import { writeServiceState } from "../../serviceLauncher.ts";
import { listChanges } from "./changes.ts";
import {
  answers,
  appendHistory,
  atomicLink,
  type DeployConfig,
  type DeployOrigin,
  type DeployRecord,
  ENDED_PHASES,
  estimateStopAt,
  homePaths,
  installPiSkills,
  keptDir,
  listKeptCopies,
  type LoomDeployStatus,
  markCurrent,
  nextVersion,
  nowIso,
  planRetention,
  readConfig,
  readHistory,
  readJson,
  readManifest,
  readRecord,
  readStatus,
  realpathOr,
  refreshCheckouts,
  releaseOfVersion,
  releasePaths,
  releaseSha,
  releaseVersion,
  run,
  storeOfRelease,
  storePaths,
  systemctl,
  withoutReleases,
  withRelease,
  writeJsonAtomic,
  writeStatus,
} from "./store.ts";

const USAGE = `usage: loom-deploy <verb>
  deploy [ref] [--no-return] [--release <id>] [--wait] [--origin cli|slack|loom] [--who <name>]
  status [--wait] [--json]     what is running and what the last deploy did; writes nothing
  back                         return to the release before this one, with its database copy
  retry                        run a held release again after a fix
  cancel                       stop a deploy that has not asked for the switch yet
  adopt                        make this release the launcher's active version (cut-over, back)
See deploy/README.md.`;

const say = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Refusal extends Error {}

function parseFlags(args: ReadonlyArray<string>, valued: ReadonlyArray<string>) {
  const flags = new Map<string, string | true>();
  const positional: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) positional.push(arg);
    else if (valued.includes(arg)) {
      const value = args[++index];
      if (value === undefined) throw new Refusal(`${arg} needs a value.`);
      flags.set(arg, value);
    } else flags.set(arg, true);
  }
  const text = (name: string) =>
    typeof flags.get(name) === "string" ? (flags.get(name) as string) : undefined;
  return { flags, positional, text, has: (name: string) => flags.has(name) };
}

function readState(config: DeployConfig) {
  const text = NodeFS.existsSync(homePaths(config).state)
    ? NodeFS.readFileSync(homePaths(config).state, "utf8")
    : undefined;
  return text === undefined ? undefined : parseServiceState(text);
}

const serviceActive = (config: DeployConfig) =>
  systemctl("is-active", config.unit).stdout.trim() === "active";

/** Stop and start the Loom service by its unit; the seam test swaps in the launcher itself. */
export interface ServiceControl {
  readonly stop: () => Promise<void>;
  readonly start: () => Promise<void>;
}

const systemdService = (config: DeployConfig): ServiceControl => ({
  stop: async () => void systemctl("stop", config.unit),
  start: async () => void systemctl("start", config.unit),
});

/** A short-lived bearer from this release's own `t3`, never stored. */
function mintSession(config: DeployConfig, releaseDir: string): string | undefined {
  const issued = run(process.execPath, [
    releasePaths(releaseDir).bin,
    "auth",
    "session",
    "issue",
    "--base-dir",
    config.home,
    "--ttl",
    "5m",
    "--label",
    "loom-deploy",
    "--token-only",
  ]);
  return issued.code === 0 ? issued.stdout.trim().split("\n").at(-1) : undefined;
}

async function postToLoom(config: DeployConfig, token: string, route: string, body: unknown) {
  return fetch(`http://127.0.0.1:${config.port}${route}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

const tcpAccepts = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

/** Up, down (nothing accepts a connection across three tries 5 s apart), or neither. */
async function loomState(config: DeployConfig): Promise<"answering" | "down" | "unresponsive"> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(5_000);
    if (await tcpAccepts(config.port))
      return (await answers(config.port)) ? "answering" : "unresponsive";
  }
  return "down";
}

async function waitAnswering(config: DeployConfig, seconds: number): Promise<boolean> {
  for (let elapsed = 0; elapsed < seconds; elapsed += 2) {
    if (await answers(config.port)) return true;
    await sleep(2_000);
  }
  return false;
}

/** Copy a kept copy over the live database files in place, as the launcher restores its own. */
function restoreCopy(copyDir: string, database: string) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const source = NodePath.join(copyDir, `database${suffix}`);
    const live = `${database}${suffix}`;
    if (!NodeFS.existsSync(source)) {
      NodeFS.rmSync(live, { force: true });
      continue;
    }
    const target = realpathOr(live);
    NodeFS.copyFileSync(source, target, NodeFS.constants.COPYFILE_FICLONE);
    const handle = NodeFS.openSync(target, "r+");
    NodeFS.fsyncSync(handle);
    NodeFS.closeSync(handle);
  }
}

function removeRelease(config: DeployConfig, id: string) {
  const dir = NodePath.join(storePaths(config.root).releases, id);
  run("git", ["-C", storePaths(config.root).mirror, "worktree", "remove", "--force", dir]);
  NodeFS.rmSync(dir, { recursive: true, force: true });
}

function refuseIfBusy(config: DeployConfig) {
  if (systemctl("is-active", config.engineUnit).stdout.trim() === "active") {
    throw new Refusal("A deploy is already running (loom-deploy status).");
  }
  if (readState(config)?.update?.status === "pending") {
    throw new Refusal("The last deploy is still being watched (loom-deploy status).");
  }
}

async function deploy(config: DeployConfig, releaseDir: string, args: ReadonlyArray<string>) {
  const { positional, text, has } = parseFlags(args, ["--release", "--origin", "--who"]);
  if (positional.length > 1) throw new Refusal(`Unexpected argument: ${positional[1]}`);
  const origin = text("--origin") ?? "cli";
  if (!["cli", "slack", "loom"].includes(origin)) throw new Refusal(`Unknown --origin ${origin}.`);
  refuseIfBusy(config);
  const thread = process.env.LOOM_THREAD_ID;
  const who =
    text("--who") ?? `${NodeOS.userInfo().username}${thread ? ` in thread ${thread}` : ""}`;
  const engineArgs = [
    ...positional,
    ...(has("--no-return") ? ["--no-return"] : []),
    ...(text("--release") ? ["--release", text("--release")!] : []),
    "--origin",
    origin,
    "--who",
    who,
  ];
  const startedAt = nowIso();
  const started = run("systemd-run", [
    "--user",
    `--unit=${config.engineUnit}`,
    "--collect",
    "--quiet",
    `--working-directory=${config.root}`,
    process.execPath,
    releasePaths(releaseDir).cli,
    releaseDir,
    "engine",
    ...engineArgs,
  ]);
  if (started.code !== 0) throw new Refusal(`Could not start the deploy: ${started.stderr.trim()}`);
  say(`Deploy started in ${config.engineUnit}.service. Follow it with: loom-deploy status --wait`);
  return has("--wait") ? follow(config, startedAt) : 0;
}

/** Print each stage of the deploy started at or after `since` until it ends; 0 when live. */
async function follow(config: DeployConfig, since: string): Promise<number> {
  let last = "";
  for (;;) {
    const status = readStatus(config);
    const ours = status !== undefined && status.startedAt >= since.slice(0, 19);
    const line = ours ? describe(status) : "";
    if (ours && line !== last) say(line);
    last = line;
    const engineGone = systemctl("is-active", config.engineUnit).stdout.trim() !== "active";
    if (ours && ENDED_PHASES.includes(status.phase)) return status.phase === "live" ? 0 : 1;
    if (ours && status.noReturn && status.phase === "watching" && status.reason !== null) return 1;
    if (!ours && engineGone && Date.parse(nowIso()) - Date.parse(since) > 30_000) {
      say("The deploy ended without writing a status (journalctl --user -u loom-deploy).");
      return 1;
    }
    await sleep(2_000);
  }
}

const describe = (status: LoomDeployStatus) =>
  [
    `${status.phase}: ${status.id}${status.version ? ` (${status.version})` : ""}`,
    status.noReturn ? "no-return" : "",
    status.stopAt && ["building", "checking"].includes(status.phase)
      ? `down at about ${status.stopAt}`
      : "",
    status.watchUntil && status.phase === "watching" ? `watched until ${status.watchUntil}` : "",
    status.reason ? `reason: ${status.reason}` : "",
  ]
    .filter(Boolean)
    .join("; ");

async function engine(config: DeployConfig, releaseDir: string, args: ReadonlyArray<string>) {
  const { positional, text, has } = parseFlags(args, ["--release", "--origin", "--who"]);
  const noReturn = has("--no-return");
  const paths = storePaths(config.root);
  const home = homePaths(config);
  const buildEnv = { HOME: NodeOS.homedir(), PATH: config.path };
  const startedAt = nowIso();
  let installedAt: string | null = null;
  let status: LoomDeployStatus | undefined;
  let built: string | undefined;
  let child: NodeChildProcess.ChildProcess | undefined;
  const report = (patch: Partial<LoomDeployStatus>) => {
    if (status !== undefined) status = writeStatus(config, { ...status, ...patch });
  };
  const callOff = (reason: string, releaseFault: boolean): number => {
    say(`called off: ${reason}`);
    report({ phase: "called-off", reason });
    if (releaseFault && built !== undefined && !noReturn) {
      const manifest = readManifest(paths.manifest);
      const record = manifest.releases[NodePath.basename(built)];
      if (record !== undefined) {
        writeJsonAtomic(paths.manifest, withRelease(manifest, { ...record, status: "failed" }));
      }
    }
    if (status !== undefined) {
      appendHistory(config.root, {
        id: status.id,
        version: status.version,
        origin: status.origin,
        who: status.who,
        noReturn,
        startedAt,
        installedAt,
        switchedAt: null,
        endedAt: nowIso(),
        outcome: "called-off",
        reason,
      });
    }
    return 1;
  };
  process.on("SIGTERM", () => {
    child?.kill("SIGTERM");
    process.exit(callOff("Cancelled with loom-deploy cancel.", true));
  });
  const step = (command: string, stepArgs: ReadonlyArray<string>, cwd: string, env = buildEnv) =>
    new Promise<number>((resolve) => {
      child = NodeChildProcess.spawn(command, stepArgs, { cwd, env, stdio: "inherit" });
      child.once("error", () => resolve(127));
      child.once("exit", (code) => resolve(code ?? 1));
    });

  // The newest failed release was kept for inspection until this deploy.
  const failed = Object.values(readManifest(paths.manifest).releases).filter(
    (r) => r.status === "failed",
  );
  for (const record of failed) removeRelease(config, record.id);
  writeJsonAtomic(
    paths.manifest,
    withoutReleases(
      readManifest(paths.manifest),
      failed.map((r) => r.id),
    ),
  );

  const state = readState(config);
  if (state === undefined)
    return callOff("The launcher has no state to deploy from; run loom-deploy adopt first.", false);
  const running = releaseOfVersion(config, state.activeVersion);
  const history = readHistory(config.root);
  let dir: string;
  let sha: string;
  const release = text("--release");
  if (release !== undefined) {
    dir = NodePath.join(paths.releases, release);
    if (!NodeFS.existsSync(releasePaths(dir).bin))
      return callOff(`No built release ${release} in the store.`, false);
    sha = releaseSha(config.root, dir);
  } else {
    if (!NodeFS.existsSync(NodePath.join(paths.mirror, "HEAD"))) {
      const cloned = run("git", ["clone", "--bare", config.repoUrl, paths.mirror]);
      if (cloned.code !== 0)
        return callOff(`Could not clone ${config.repoUrl}: ${cloned.stderr.trim()}`, false);
    }
    const fetched = run("git", [
      "-C",
      paths.mirror,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/heads/*",
    ]);
    if (fetched.code !== 0) return callOff(`Could not fetch: ${fetched.stderr.trim()}`, false);
    const ref = positional[0] ?? config.defaultRef;
    const resolved = run("git", [
      "-C",
      paths.mirror,
      "rev-parse",
      `${ref.replace(/^origin\//, "")}^{commit}`,
    ]);
    if (resolved.code !== 0) return callOff(`${ref} does not name a commit.`, false);
    sha = resolved.stdout.trim();
    const stamp = startedAt.replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
    dir = NodePath.join(paths.releases, `${stamp}-${sha.slice(0, 7)}`);
  }
  const id = NodePath.basename(dir);
  status = writeStatus(config, {
    id,
    sha,
    version: release === undefined ? null : (releaseVersion(dir) ?? null),
    phase: "building",
    origin: (text("--origin") ?? "cli") as DeployOrigin,
    who: text("--who") ?? null,
    noReturn,
    startedAt,
    stopAt: estimateStopAt(history, startedAt),
    watchUntil: null,
    reason: null,
    bridge: null,
    at: startedAt,
  });

  let version = status.version ?? "";
  if (release === undefined) {
    const added = run("git", ["-C", paths.mirror, "worktree", "add", "--detach", dir, sha]);
    if (added.code !== 0)
      return callOff(`Could not check out ${sha.slice(0, 7)}: ${added.stderr.trim()}`, false);
    built = dir;
    const staged = NodeFS.existsSync(home.versions) ? NodeFS.readdirSync(home.versions) : [];
    version = nextVersion(startedAt.slice(0, 10).replaceAll("-", ""), [
      state.activeVersion,
      ...staged,
    ]);
    const ref = positional[0] ?? config.defaultRef;
    const recordBuilt = () =>
      writeJsonAtomic(
        paths.manifest,
        withRelease(readManifest(paths.manifest), {
          id,
          ref,
          sha,
          builtAt: nowIso(),
          status: "ready",
          version,
        }),
      );
    recordBuilt();
    const pkg = readJson<Record<string, unknown>>(releasePaths(dir).packageJson) ?? {};
    NodeFS.writeFileSync(
      releasePaths(dir).packageJson,
      `${JSON.stringify({ ...pkg, version }, null, 2)}\n`,
    );
    NodeFS.writeFileSync(releasePaths(dir).sentinel, `${version}\n`);
    report({ version });
    const installed = await step("pnpm", ["install", "--frozen-lockfile"], dir);
    if (installed !== 0)
      return callOff(`The install failed (pnpm install exited ${installed}).`, true);
    installedAt = nowIso();
    report({ stopAt: estimateStopAt(history, startedAt, installedAt) });
    const compiled = await step("pnpm", ["build"], dir);
    if (compiled !== 0) return callOff(`The build failed (pnpm build exited ${compiled}).`, true);
    if (!NodeFS.existsSync(releasePaths(dir).bin))
      return callOff("The build left no server bundle.", true);
    recordBuilt();
  } else if (!NodeFS.existsSync(releasePaths(dir).sentinel)) {
    NodeFS.writeFileSync(releasePaths(dir).sentinel, `${version}\n`);
  }

  report({ phase: "checking" });
  const nodePath = `${NodePath.dirname(process.execPath)}:${config.path}`;
  const checked = await step(process.execPath, [releasePaths(dir).cli, dir, "trial-start"], dir, {
    ...buildEnv,
    PATH: nodePath,
  });
  if (checked !== 0) {
    const reason = readJson<{ reason?: string }>(
      NodePath.join(paths.trial, `${id}.result.json`),
    )?.reason;
    return callOff(reason ?? `The trial start failed (exit ${checked}).`, true);
  }

  const fromSha = running === undefined ? undefined : releaseSha(config.root, running);
  const record: DeployRecord = {
    id,
    sha,
    version,
    origin: status.origin,
    who: status.who,
    noReturn,
    fromRelease: running === undefined ? null : NodePath.basename(running),
    startedAt,
    installedAt,
    switchedAt: nowIso(),
    ...listChanges(config.repoUrl, paths.mirror, fromSha, sha),
  };
  writeJsonAtomic(releasePaths(dir).record, record);
  NodeFS.mkdirSync(home.versions, { recursive: true });
  atomicLink(NodePath.join(home.versions, version), releasePaths(dir).runtime);
  // Read the live database once so the launcher's copy runs from the page cache.
  for (const file of [home.database, `${home.database}-wal`].filter((f) => NodeFS.existsSync(f))) {
    const handle = NodeFS.openSync(file, "r");
    const buffer = Buffer.allocUnsafe(4 << 20);
    for (let read = 1; read > 0;) read = NodeFS.readSync(handle, buffer, 0, buffer.length, null);
    NodeFS.closeSync(handle);
  }

  report({ phase: "switching" });
  const loom = await loomState(config);
  if (loom === "answering") {
    const token = mintSession(config, releaseDir);
    if (token === undefined)
      return callOff("Could not mint a session to ask Loom for the switch.", false);
    const response = await postToLoom(config, token, "/loom/deploy/switch", { version }).catch(
      () => undefined,
    );
    if (response?.status === 200) return (say(`Loom accepted the switch to ${version}.`), 0);
    const body = (await response?.json().catch(() => undefined)) as { reason?: string } | undefined;
    return callOff(
      body?.reason ?? `Loom did not take the switch (HTTP ${response?.status ?? "no answer"}).`,
      false,
    );
  }
  if (loom === "unresponsive") {
    return callOff(
      "Loom accepts connections but does not answer, so the switch was not asked for.",
      false,
    );
  }
  const next = decodeServiceState({
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: state.activeVersion,
    update: {
      id: NodeCrypto.randomUUID(),
      fromVersion: state.activeVersion,
      targetVersion: version,
      dbPath: home.database,
      status: "pending",
    },
  });
  if (next === undefined)
    return callOff(`${version} is not newer than the running ${state.activeVersion}.`, false);
  say("Loom is down: switching through the launcher's state file.");
  systemctl("stop", config.unit);
  await writeServiceState(home.state, next);
  const startedUnit = systemctl("start", config.unit);
  say(
    startedUnit.code === 0
      ? `Started ${config.unit} on ${version}.`
      : `Could not start ${config.unit}: ${startedUnit.stderr.trim()}`,
  );
  return startedUnit.code === 0 ? 0 : 1;
}

export const SETTINGS_WARNING = "failed to parse settings.json, using defaults";
export const FOREIGN_HOME_LINE =
  "foreign-home guard: this database was copied from another T3 home";

async function trialStart(config: DeployConfig, releaseDir: string): Promise<number> {
  const id = NodePath.basename(releaseDir);
  const scratch = NodePath.join(storePaths(config.root).trial, id);
  const resultFile = `${scratch}.result.json`;
  const finish = (reason: string | null) => {
    writeJsonAtomic(resultFile, { reason });
    say(reason === null ? "trial start passed" : `trial start failed: ${reason}`);
    return reason === null ? 0 : 1;
  };
  NodeFS.rmSync(scratch, { recursive: true, force: true });
  NodeFS.mkdirSync(NodePath.join(scratch, "userdata"), { recursive: true });
  const env = {
    HOME: NodeOS.homedir(),
    PATH: process.env.PATH ?? config.path,
    T3CODE_NO_BROWSER: "1",
    T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "false",
  };
  try {
    const sliced = NodeChildProcess.spawnSync(
      process.execPath,
      [
        NodePath.join(releaseDir, "apps", "server", "scripts", "migrate-dev-db.ts"),
        "--base-dir",
        scratch,
        "--source",
        homePaths(config).database,
      ],
      { cwd: releaseDir, env, stdio: "inherit" },
    );
    if (sliced.status !== 0)
      return finish("Could not build a slice of the live database for the trial start.");
    for (const name of ["settings.json", "keybindings.json"]) {
      const source = NodePath.join(config.stateDir, name);
      if (NodeFS.existsSync(source))
        NodeFS.copyFileSync(source, NodePath.join(scratch, "userdata", name));
    }
    const logFile = NodePath.join(scratch, "server.log");
    const out = NodeFS.openSync(logFile, "w");
    const server = NodeChildProcess.spawn(
      process.execPath,
      [
        releasePaths(releaseDir).bin,
        "serve",
        "--base-dir",
        scratch,
        "--port",
        String(config.trialPort),
        "--host",
        "127.0.0.1",
      ],
      { cwd: scratch, env, detached: true, stdio: ["ignore", out, out] },
    );
    const exited = new Promise<void>((resolve) => server.once("exit", () => resolve()));
    const ended = () => server.exitCode !== null || server.signalCode !== null;
    const logText = () => NodeFS.readFileSync(logFile, "utf8");
    try {
      let up = false;
      for (let waited = 0; waited < 120 && !ended(); waited++) {
        up ||= await answers(config.trialPort);
        if (up && logText().includes(FOREIGN_HOME_LINE)) break;
        await sleep(1_000);
      }
      // Settings load in the same start-up sequence as the guard; give it a moment to finish.
      if (up && !ended()) await sleep(5_000);
      const text = logText();
      if (text.includes(SETTINGS_WARNING)) {
        return finish("The new release could not read settings.json.");
      }
      if (ended()) return finish("The new release exited during the trial start.");
      if (!up)
        return finish(
          "The new release did not answer within 120 s of starting on a slice of real data.",
        );
      if (!text.includes(FOREIGN_HOME_LINE)) {
        return finish("The trial server did not engage the foreign-home guard on copied data.");
      }
      return finish(null);
    } finally {
      if (!ended() && server.pid !== undefined) {
        process.kill(-server.pid, "SIGTERM");
        const killed = await Promise.race([
          exited.then(() => true),
          sleep(10_000).then(() => false),
        ]);
        if (!killed) process.kill(-server.pid, "SIGKILL");
      }
      NodeFS.closeSync(out);
    }
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

async function statusVerb(config: DeployConfig, args: ReadonlyArray<string>) {
  const { has } = parseFlags(args, []);
  if (has("--wait")) {
    const status = readStatus(config);
    return status === undefined ? 0 : follow(config, status.startedAt);
  }
  const state = readState(config);
  const runningVersion =
    state?.update?.status === "pending" ? state.update.targetVersion : state?.activeVersion;
  const running =
    runningVersion === undefined ? undefined : releaseOfVersion(config, runningVersion);
  const copies = listKeptCopies(config);
  const status = readStatus(config);
  const service = systemctl("is-active", config.unit).stdout.trim() || "unknown";
  if (has("--json")) {
    say(
      JSON.stringify(
        {
          service,
          running: running && NodePath.basename(running),
          version: runningVersion,
          launcher: state ?? null,
          status: status ?? null,
          keptCopies: copies,
        },
        null,
        2,
      ),
    );
    return 0;
  }
  say(
    `service      ${config.unit}: ${service}${(await answers(config.port)) ? ", answering" : ", not answering"}`,
  );
  say(
    `running      ${running ? NodePath.basename(running) : "unknown"} (${runningVersion ?? "no launcher state"})`,
  );
  if (state?.update !== undefined) {
    const update = state.update;
    say(
      `launcher     ${update.status} ${update.fromVersion} -> ${update.targetVersion}${"reason" in update && update.reason ? ` (${update.reason})` : ""}`,
    );
  }
  say(`last deploy  ${status ? describe(status) : "none recorded"}`);
  if (status)
    say(
      `             started ${status.startedAt} from ${status.origin}${status.who ? ` by ${status.who}` : ""}`,
    );
  say(`kept copies  ${copies.length === 0 ? "none" : ""}`);
  for (const copy of copies)
    say(`  ${copy.at}  ${copy.toRelease}, returns to ${copy.fromRelease ?? "unknown"}`);
  return 0;
}

export async function back(config: DeployConfig, service: ServiceControl = systemdService(config)) {
  const state = readState(config);
  if (state === undefined)
    throw new Refusal("The launcher has no readable state; nothing to go back from.");
  const runningVersion =
    state.update?.status === "pending" ? state.update.targetVersion : state.activeVersion;
  const running = releaseOfVersion(config, runningVersion);
  const runningId = running === undefined ? runningVersion : NodePath.basename(running);
  const copy = listKeptCopies(config).find((entry) => entry.toRelease === runningId);
  if (copy === undefined || copy.fromRelease === null) {
    const newest = listKeptCopies(config)[0];
    throw new Refusal(
      `No kept database copy belongs to the running release ${runningId}` +
        (newest ? `; the newest belongs to ${newest.toRelease}, which is not running.` : "."),
    );
  }
  const previous = NodePath.join(storePaths(config.root).releases, copy.fromRelease);
  if (!NodeFS.existsSync(releasePaths(previous).command)) {
    throw new Refusal(
      `The release before this one, ${copy.fromRelease}, is no longer in the store.`,
    );
  }
  say(
    `Going back from ${runningId} to ${copy.fromRelease}. Work done in Loom since ${copy.at} is lost.`,
  );
  const token = (await answers(config.port)) ? mintSession(config, previous) : undefined;
  if (token !== undefined) {
    await postToLoom(config, token, "/loom/deploy/restarting", {
      releaseId: copy.fromRelease,
      reason: "rollback",
    }).catch(() => undefined);
  }
  await service.stop();
  restoreCopy(NodePath.join(keptDir(config), copy.updateId), homePaths(config).database);
  // The release returned to records the return itself, so its own launcher code takes over.
  const adopted = NodeChildProcess.spawnSync(
    releasePaths(previous).command,
    ["adopt", "--undo", `${copy.updateId}:${runningVersion}`],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        PATH: `${NodePath.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      },
    },
  );
  if (adopted.status !== 0)
    throw new Refusal(`adopt in ${copy.fromRelease} failed; Loom is stopped.`);
  await service.start();
  if (!(await waitAnswering(config, 300))) {
    say(`${config.unit} did not answer within 5 minutes; manifest.json was left as it was.`);
    return 1;
  }
  const paths = storePaths(config.root);
  writeJsonAtomic(paths.manifest, markCurrent(readManifest(paths.manifest), copy.fromRelease));
  if (running !== undefined) atomicLink(paths.previous, running);
  if (config.bridge !== null) systemctl("restart", "--no-block", config.bridge.unit);
  say(`Back on ${copy.fromRelease}.`);
  return 0;
}

function retry(config: DeployConfig) {
  if (readStatus(config)?.phase !== "held")
    throw new Refusal("Nothing is held (loom-deploy status).");
  const launcher = systemctl("show", config.unit, "--property=MainPID", "--value").stdout.trim();
  const children = NodeFS.readFileSync(`/proc/${launcher}/task/${launcher}/children`, "utf8")
    .trim()
    .split(/\s+/);
  const runner = children.find((pid) =>
    NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("loom/deploy/runner.ts"),
  );
  if (runner === undefined)
    throw new Refusal(`No release runner under ${config.unit} (pid ${launcher}).`);
  process.kill(Number(runner), "SIGHUP");
  say(
    `Asked the held release to run again (runner pid ${runner}). Follow it with: loom-deploy status --wait`,
  );
  return 0;
}

function cancel(config: DeployConfig) {
  const status = readStatus(config);
  if (status === undefined || !["building", "checking"].includes(status.phase)) {
    throw new Refusal("Only a deploy that is still building or checking can be cancelled.");
  }
  systemctl("stop", config.engineUnit);
  const after = readStatus(config);
  if (after?.phase !== "called-off")
    writeStatus(config, {
      ...status,
      phase: "called-off",
      reason: "Cancelled with loom-deploy cancel.",
    });
  say(`Cancelled ${status.id}; Loom was not stopped.`);
  return 0;
}

async function adopt(config: DeployConfig, releaseDir: string, args: ReadonlyArray<string>) {
  const { text } = parseFlags(args, ["--undo"]);
  const home = homePaths(config);
  const version = releaseVersion(releaseDir);
  if (version === undefined)
    throw new Refusal(`${releaseDir} has no apps/server/package.json version.`);
  if (NodeFS.existsSync(home.state) && serviceActive(config)) {
    throw new Refusal(`${config.unit} is running under the launcher; stop it before adopt.`);
  }
  const [undoId, leftVersion] = (text("--undo") ?? "").split(":");
  const next = decodeServiceState({
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    activeVersion: version,
    ...(undoId && leftVersion
      ? {
          update: {
            id: undoId,
            fromVersion: version,
            targetVersion: leftVersion,
            status: "rolled-back",
            reason: "manual-return",
          },
        }
      : {}),
  });
  if (next === undefined)
    throw new Refusal(`The launcher would not accept ${version} as its active version.`);
  NodeFS.writeFileSync(releasePaths(releaseDir).sentinel, `${version}\n`);
  NodeFS.mkdirSync(home.versions, { recursive: true });
  atomicLink(NodePath.join(home.versions, version), releasePaths(releaseDir).runtime);
  atomicLink(storePaths(config.root).current, releaseDir);
  const linked =
    NodeFS.lstatSync(home.backups, { throwIfNoEntry: false })?.isSymbolicLink() === true;
  if (config.backupDir !== null && !linked) {
    const target = NodePath.join(config.backupDir, "db-backup");
    NodeFS.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (NodeFS.existsSync(home.backups)) NodeFS.rmdirSync(home.backups);
    NodeFS.symlinkSync(target, home.backups);
  }
  await writeServiceState(home.state, next);
  say(`${NodePath.basename(releaseDir)} (${version}) is the launcher's active version.`);
  return 0;
}

function afterAccept(config: DeployConfig, releaseDir: string) {
  const log = (line: string) => say(`[after-accept] ${line}`);
  const paths = storePaths(config.root);
  const id = NodePath.basename(releaseDir);
  const record = readRecord(releaseDir);
  let manifest = readManifest(paths.manifest);
  if (manifest.releases[id] === undefined) {
    const sha = releaseSha(config.root, releaseDir);
    manifest = withRelease(manifest, { id, ref: "", sha, builtAt: nowIso(), status: "ready" });
  }
  manifest = markCurrent(manifest, id);
  const before = record?.fromRelease
    ? NodePath.join(paths.releases, record.fromRelease)
    : undefined;
  if (before !== undefined && NodeFS.existsSync(before)) atomicLink(paths.previous, before);
  const plan = planRetention({
    manifest,
    keepReleases: config.keepReleases,
    keepCopies: config.keepCopies,
    copies: listKeptCopies(config),
  });
  for (const gone of plan.releases) removeRelease(config, gone);
  for (const gone of plan.copies)
    NodeFS.rmSync(NodePath.join(keptDir(config), gone), { recursive: true, force: true });
  writeJsonAtomic(paths.manifest, withoutReleases(manifest, plan.releases));
  run("git", ["-C", paths.mirror, "worktree", "prune"]);
  const state = readState(config);
  const versions = homePaths(config).versions;
  for (const name of NodeFS.existsSync(versions) ? NodeFS.readdirSync(versions) : []) {
    const inUse = [state?.activeVersion, state?.update?.fromVersion, state?.update?.targetVersion];
    const link = NodePath.join(versions, name);
    if (
      !inUse.includes(name) &&
      !NodeFS.existsSync(link) &&
      NodeFS.lstatSync(link).isSymbolicLink()
    ) {
      NodeFS.unlinkSync(link);
    }
  }
  log(
    `current ${id}; removed ${plan.releases.length} releases and ${plan.copies.length} kept copies`,
  );
  installPiSkills(config, log);
  refreshCheckouts(config, record?.sha ?? releaseSha(config.root, releaseDir), log);
  const status = readStatus(config);
  appendHistory(config.root, {
    id,
    version: record?.version ?? releaseVersion(releaseDir) ?? null,
    origin: record?.origin ?? "cli",
    who: record?.who ?? null,
    noReturn: record?.noReturn ?? false,
    startedAt: record?.startedAt ?? status?.startedAt ?? nowIso(),
    installedAt: record?.installedAt ?? null,
    switchedAt: record?.switchedAt ?? null,
    endedAt: nowIso(),
    outcome: "live",
    reason: null,
  });
  return 0;
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [releaseArg, verb, ...args] = argv;
  if (releaseArg === undefined || verb === undefined) return (say(USAGE), 2);
  const releaseDir = NodePath.resolve(releaseArg);
  const config = readConfig(storeOfRelease(releaseDir));
  switch (verb) {
    case "deploy":
      return deploy(config, releaseDir, args);
    case "status":
      return statusVerb(config, args);
    case "back":
      return back(config);
    case "retry":
      return retry(config);
    case "cancel":
      return cancel(config);
    case "adopt":
      return adopt(config, releaseDir, args);
    case "engine":
      return engine(config, releaseDir, args);
    case "trial-start":
      return trialStart(config, releaseDir);
    case "after-accept":
      return afterAccept(config, releaseDir);
    default:
      say(`Unknown verb "${verb}".\n${USAGE}`);
      return 2;
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      process.stderr.write(
        `loom-deploy: ${error instanceof Refusal ? error.message : String(error instanceof Error ? error.stack : error)}\n`,
      );
      process.exit(error instanceof Refusal ? 2 : 1);
    },
  );
}
