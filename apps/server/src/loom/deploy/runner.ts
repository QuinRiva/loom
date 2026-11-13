// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// @effect-diagnostics globalDate:off
// @effect-diagnostics globalFetch:off
// The release runner (plans/loom-deploy-redesign §3.1). Upstream's launcher starts it as this
// release; it starts the server as its child, holds the launcher's "started" until the watch has
// passed, keeps the launcher's database copy, and never exits while its server is alive.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  decodeServiceLauncherChildMessage,
  decodeServiceLauncherContext,
  decodeServiceLauncherParentMessage,
  SERVICE_LAUNCHER_CONTEXT_ENV,
  type ServiceUpdateRecord,
} from "../../cloud/serviceProtocol.ts";
import {
  answers,
  appendHistory,
  atomicLink,
  bridgeHealthy,
  homePaths,
  keptDir,
  type KeptCopy,
  type LoomDeployStatus,
  isoAt,
  nowIso,
  readConfig,
  readHistory,
  readJson,
  readManifest,
  readRecord,
  readStatus,
  realpathOr,
  releaseOfVersion,
  releasePaths,
  releaseSha,
  storeOfRelease,
  storePaths,
  systemctl,
  withRelease,
  writeJsonAtomic,
  writeNotice,
  writeStatus,
} from "./store.ts";

// Upstream's launcher kills its child 5 s after asking it to stop; the server must be gone first.
const STOP_GRACE_MS = 4_500;
const PROBE_FAILURES = 3;
const BRIDGE_ALLOWANCE_MS = 90_000;

const [releaseArg = "", ...serverArgs] = process.argv.slice(2);
const releaseDir = NodePath.resolve(releaseArg);
const releaseId = NodePath.basename(releaseDir);
const log = (line: string) => process.stderr.write(`[loom-runner ${releaseId}] ${line}\n`);

const send = process.send?.bind(process);
const context = decodeServiceLauncherContext(process.env[SERVICE_LAUNCHER_CONTEXT_ENV] ?? "");
if (context === undefined || send === undefined) {
  log("refusing: no launcher context this release can read (it speaks launcher protocol 3)");
  process.exit(1);
}
const store = storeOfRelease(releaseDir);
const config = readConfig(store);
if (realpathOr(config.home) !== realpathOr(process.env.T3CODE_HOME ?? "")) {
  log(`refusing: the store's home ${config.home} is not this launcher's T3CODE_HOME`);
  process.exit(1);
}

const version = context.childVersion;
const update = context.update;
const pending =
  update?.status === "pending" && update.targetVersion === version ? update : undefined;
const record = readRecord(releaseDir);
const noReturn = pending !== undefined && record?.noReturn === true;
const sha = record?.sha ?? releaseSha(store, releaseDir);
const startStatus = readStatus(config);

let status: LoomDeployStatus = {
  id: releaseId,
  sha,
  version,
  phase: "switching",
  origin: record?.origin ?? "cli",
  who: record?.who ?? null,
  noReturn,
  startedAt: record?.startedAt ?? nowIso(),
  stopAt: null,
  watchUntil: null,
  reason: null,
  bridge: null,
  at: nowIso(),
  ...(startStatus?.id === releaseId ? startStatus : {}),
};
const report = (patch: Partial<LoomDeployStatus>) => {
  status = writeStatus(config, { ...status, ...patch });
};

/** Plain words for upstream's return reasons, when the release that failed left none. */
const launcherReason = (reason: string | undefined) =>
  reason === "manual-return"
    ? "Put back with loom-deploy back."
    : reason?.startsWith("candidate-exited")
      ? `The new release exited while starting (${reason.slice("candidate-exited:".length)}).`
      : `The launcher put the previous release back (${reason ?? "no reason given"}).`;

/** Hard links survive the launcher deleting its own copy at acceptance, at no copy cost. */
function keepBackup(update: Extract<ServiceUpdateRecord, { status: "pending" }>): boolean {
  const backup = NodePath.join(homePaths(config).backups, update.id);
  if (!NodeFS.existsSync(NodePath.join(backup, "database"))) return false;
  const kept = NodePath.join(keptDir(config), update.id);
  if (NodeFS.existsSync(kept)) return true;
  const partial = `${kept}.partial`;
  NodeFS.rmSync(partial, { recursive: true, force: true });
  NodeFS.mkdirSync(partial, { recursive: true });
  for (const name of NodeFS.readdirSync(backup).filter((file) => file.startsWith("database"))) {
    NodeFS.linkSync(NodePath.join(backup, name), NodePath.join(partial, name));
  }
  const fromRelease = releaseOfVersion(config, update.fromVersion);
  const meta: KeptCopy = {
    updateId: update.id,
    fromVersion: update.fromVersion,
    targetVersion: update.targetVersion,
    fromRelease: fromRelease === undefined ? null : NodePath.basename(fromRelease),
    toRelease: releaseId,
    at: nowIso(),
  };
  writeJsonAtomic(NodePath.join(partial, "meta.json"), meta);
  NodeFS.renameSync(partial, kept);
  return true;
}

/** This release started because the launcher or `back` returned to it: say so, once. */
function reportReturn(outcome: ServiceUpdateRecord) {
  if (readHistory(store).some((line) => line.updateId === outcome.id)) return;
  const left = releaseOfVersion(config, outcome.targetVersion);
  const leftId = left === undefined ? outcome.targetVersion : NodePath.basename(left);
  const leftRecord = left === undefined ? undefined : readRecord(left);
  const manual = "reason" in outcome && outcome.reason === "manual-return";
  const reason =
    !manual && startStatus?.version === outcome.targetVersion && startStatus.reason !== null
      ? startStatus.reason
      : launcherReason("reason" in outcome ? outcome.reason : undefined);
  const copy = readJson<KeptCopy>(NodePath.join(keptDir(config), outcome.id, "meta.json"));
  writeNotice(config, {
    kind: "rolled-back",
    reason: manual ? "manual" : "health-check",
    release: { id: leftId, sha: leftRecord?.sha ?? "" },
    restored: { id: releaseId, sha },
    lostSince: copy?.at ?? null,
    headline: null,
    changes: leftRecord?.changes ?? [],
  });
  const base = startStatus?.version === outcome.targetVersion ? startStatus : undefined;
  status = writeStatus(config, {
    ...(base ?? {
      ...status,
      id: leftId,
      sha: leftRecord?.sha ?? "",
      version: outcome.targetVersion,
      origin: leftRecord?.origin ?? status.origin,
      who: leftRecord?.who ?? null,
      noReturn: leftRecord?.noReturn ?? false,
      startedAt: leftRecord?.startedAt ?? status.startedAt,
    }),
    phase: "put-back",
    reason,
  });
  appendHistory(store, status, {
    installedAt: leftRecord?.installedAt ?? null,
    switchedAt: leftRecord?.switchedAt ?? null,
    outcome: manual ? "back" : "put-back",
    reason,
    updateId: outcome.id,
  });
  const manifest = readManifest(storePaths(store).manifest);
  const failed = manifest.releases[leftId];
  if (!manual && failed !== undefined && failed.status === "ready") {
    writeJsonAtomic(
      storePaths(store).manifest,
      withRelease(manifest, { ...failed, status: "failed" }),
    );
  }
  // The copy from before the left release is what was just restored: it can never be used again.
  NodeFS.rmSync(NodePath.join(keptDir(config), outcome.id), { recursive: true, force: true });
}

let told = pending === undefined;
if (pending !== undefined) {
  if (!keepBackup(pending)) {
    report({
      reason:
        "The launcher's database copy was not where Loom expects it, so the release was not started.",
    });
    log("refusing: no launcher backup to keep, so no way back");
    process.exit(1);
  }
  if (noReturn) {
    send({ type: "prepared", updateId: pending.id });
    told = true;
  }
}

const { current } = storePaths(store);
const moved = realpathOr(current) !== realpathOr(releaseDir);
if (moved) atomicLink(current, releaseDir);

if (pending !== undefined) {
  writeNotice(config, {
    kind: "updated",
    reason: null,
    release: { id: releaseId, sha },
    restored: null,
    lostSince: null,
    headline: record?.headline ?? null,
    changes: record?.changes ?? [],
  });
} else if (
  (update?.status === "rolled-back" || update?.status === "failed") &&
  update.fromVersion === version
) {
  reportReturn(update);
}

if (config.reapBeforeStart !== null) systemctl("stop", config.reapBeforeStart);

let server: NodeChildProcess.ChildProcess | undefined;
let stopping = false;
let watching = false;
let awaitingCommit = false;
let isLive = false;
let timer: NodeJS.Timeout | undefined;
let startTimer: NodeJS.Timeout | undefined;
let bridgeMoved = moved;

const serverEnv = { ...process.env };
for (const name of [
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "LOOM_DEPLOY_SERVER_NODE_FLAGS",
]) {
  delete serverEnv[name];
}
const nodeFlags = (process.env.LOOM_DEPLOY_SERVER_NODE_FLAGS ?? "").split(/\s+/).filter(Boolean);

const alive = (child: NodeChildProcess.ChildProcess) =>
  child.exitCode === null && child.signalCode === null;

/** SIGTERM, SIGKILL 4.5 s later, and exit only once the server is gone. */
function stopAndExit(code: number, signal: NodeJS.Signals = "SIGTERM") {
  stopping = true;
  clearTimeout(timer);
  clearTimeout(startTimer);
  const child = server;
  if (child === undefined || !alive(child)) process.exit(code);
  child.once("exit", () => process.exit(code));
  child.kill(signal);
  setTimeout(() => child.kill("SIGKILL"), STOP_GRACE_MS).unref();
}

function fail(reason: string) {
  if (stopping) return;
  watching = false;
  clearTimeout(timer);
  log(`watch failed: ${reason}`);
  if (noReturn) {
    report({ reason, watchUntil: nowIso() });
    return;
  }
  report({ reason });
  stopAndExit(1);
}

function goLive() {
  awaitingCommit = false;
  isLive = true;
  report({ phase: "live", reason: null });
  log("live");
  const env = { ...serverEnv };
  delete env[SERVICE_LAUNCHER_CONTEXT_ENV];
  NodeChildProcess.spawn(
    process.execPath,
    [releasePaths(releaseDir).cli, releaseDir, "after-accept"],
    {
      cwd: releaseDir,
      detached: true,
      env,
      stdio: "inherit",
    },
  ).unref();
}

function startWatch() {
  const started = Date.now();
  const watchMs = config.watchSeconds * 1000;
  let red = 0;
  let bridgeRed = 0;
  watching = true;
  report({
    phase: "watching",
    watchUntil: isoAt(started + watchMs),
    reason: null,
  });
  const tick = async () => {
    red = (await answers(config.port)) ? 0 : red + 1;
    if (!watching) return;
    if (config.bridge !== null && Date.now() - started >= BRIDGE_ALLOWANCE_MS) {
      bridgeRed = (await bridgeHealthy(config.bridge.healthUrl)) ? 0 : bridgeRed + 1;
      const bridge =
        bridgeRed === 0 ? "connected" : bridgeRed >= PROBE_FAILURES ? "fault" : status.bridge;
      if (bridge !== status.bridge) report({ bridge });
      if (bridge === "fault" && status.origin === "slack") {
        return fail(
          "The Slack bridge did not reconnect after the update, and this deploy came from Slack.",
        );
      }
    }
    if (red >= PROBE_FAILURES) return fail("Loom stopped answering during the watch.");
    if (Date.now() - started >= watchMs && red === 0) {
      watching = false;
      if (told) return goLive();
      awaitingCommit = true;
      told = true;
      send?.({ type: "prepared", updateId: pending!.id });
      return;
    }
    timer = setTimeout(tick, config.probeSeconds * 1000);
  };
  timer = setTimeout(tick, config.probeSeconds * 1000);
}

/** The server reported it has started: it may open at once; the launcher hears after the watch. */
function onStarted() {
  clearTimeout(startTimer);
  if (bridgeMoved && config.bridge !== null) systemctl("restart", "--no-block", config.bridge.unit);
  bridgeMoved = false;
  startWatch();
}

function runServer() {
  const child = NodeChildProcess.spawn(
    "setpriv",
    [
      "--pdeathsig",
      "KILL",
      "--",
      process.execPath,
      ...nodeFlags,
      releasePaths(releaseDir).bin,
      ...serverArgs,
    ],
    { cwd: releaseDir, env: serverEnv, stdio: ["inherit", "inherit", "inherit", "ipc"] },
  );
  server = child;
  log(`server started (pid ${child.pid})`);
  if (pending !== undefined && !noReturn) {
    startTimer = setTimeout(
      () => fail(`Loom did not finish starting within ${config.startTimeoutSeconds} s.`),
      config.startTimeoutSeconds * 1000,
    );
  }
  child.on("message", (raw) => {
    const message = decodeServiceLauncherChildMessage(raw);
    if (message?.type === "request-update") send?.(message);
    // A second "started" is fatal to the launcher, so the runner answers the server itself.
    if (message?.type === "prepared" && message.updateId === pending?.id) {
      child.send({ type: "committed", updateId: message.updateId });
      onStarted();
    }
  });
  child.on("exit", (code, signal) => {
    if (server !== child || stopping) return;
    server = undefined;
    const how = String(code ?? signal);
    log(`server exited (${how})`);
    if (noReturn && !isLive) {
      watching = false;
      clearTimeout(timer);
      report({
        phase: "held",
        reason: `Loom exited (${how}) and is held for a fix: loom-deploy retry, or loom-deploy back.`,
      });
      return;
    }
    if (pending !== undefined && !told) {
      report({
        reason: watching
          ? `Loom exited during the watch (${how}).`
          : `Loom exited while starting (${how}).`,
      });
    }
    // The launcher reads 78 as "another server owns this home", so pass the code on unchanged.
    process.exit(code ?? 1);
  });
}

process.on("message", (raw) => {
  const message = decodeServiceLauncherParentMessage(raw);
  if (message?.type === "committed") {
    if (awaitingCommit) goLive();
  } else if (message !== undefined && server?.connected) {
    server.send(message);
  }
});
process.on("SIGTERM", () => stopAndExit(0, "SIGTERM"));
process.on("SIGINT", () => stopAndExit(0, "SIGINT"));
process.on("disconnect", () => stopAndExit(0));
process.on("SIGHUP", () => {
  if (server !== undefined || stopping || status.phase !== "held") {
    return log("SIGHUP ignored: nothing is held");
  }
  log("SIGHUP: running the held release again");
  report({ phase: "switching", reason: null });
  runServer();
});
// While held, nothing else keeps the event loop alive.
setInterval(() => {}, 2 ** 30);
runServer();
