// @effect-diagnostics nodeBuiltinImport:off - drives real launcher, runner and stub processes.
// The seam with upstream's launcher (plans/loom-deploy-redesign §2, §9.1, §12.1): upstream's real
// `Launcher` in a temporary home, against Loom's real runner and shell files, with a stub server.
// A failure here at a weekly pull means upstream moved something Loom's deploy relies on.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { prunePinnedRuntimes } from "../../cloud/pinnedRuntime.ts";
import {
  decodeServiceState,
  SERVICE_LAUNCHER_PROTOCOL,
  type ServiceState,
} from "../../cloud/serviceProtocol.ts";
import * as ProcessRunner from "../../processRunner.ts";
import { Launcher, readServiceState, writeServiceState } from "../../serviceLauncher.ts";
import { back, FOREIGN_HOME_LINE, SETTINGS_WARNING } from "./cli.ts";
import {
  homePaths,
  keptDir,
  type LoomDeployStatus,
  readConfig,
  readJson,
  storePaths,
  writeJsonAtomic,
} from "./store.ts";

/** Each process the launcher spawns, so a test can see exactly when a runner exits. */
const launcherSpawns = vi.hoisted(() => ({
  hook: undefined as undefined | ((child: NodeChildProcess.ChildProcess) => void),
}));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeChildProcess>();
  const spawn = (...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    launcherSpawns.hook?.(child);
    return child;
  };
  return { ...actual, spawn: spawn as typeof actual.spawn };
});

const REPO = NodePath.resolve(import.meta.dirname, "../../../../..");
const BASE = { id: "20261111-000000-base000", version: "0.1.7" };
const NEXT = { id: "20261112-000000-next000", version: "100.20261112.1" };

/** The server the runner starts: reports to the test over a socket whose close marks its death. */
const STUB_SERVER = `
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
if (process.argv[2] !== "serve") process.exit(1);
const stub = JSON.parse(fs.readFileSync(new URL("./stub.json", import.meta.url), "utf8"));
const context = JSON.parse(process.env.T3_SERVICE_LAUNCHER_CONTEXT ?? "null");
const pending = context?.update?.status === "pending";
let prevAlive = false;
try { process.kill(Number(fs.readFileSync(stub.pidFile, "utf8")), 0); prevAlive = true; } catch {}
fs.writeFileSync(stub.pidFile, String(process.pid));
const events = net.createConnection(stub.events);
const emit = (event) => events.write(JSON.stringify({ release: stub.name, pid: process.pid, ppid: process.ppid, ...event }) + "\\n");
emit({ type: "start", update: context?.update?.status ?? null, prevAlive, db: fs.readFileSync(stub.db, "utf8") });
if (pending && stub.writeDb) fs.writeFileSync(stub.db, stub.writeDb);
// Exits 300 ms after SIGTERM, so a runner that waits for its server exits after that.
process.on("SIGTERM", () => {
  emit({ type: stub.ignoreTerm ? "term-ignored" : "term" });
  if (!stub.ignoreTerm) setTimeout(() => { emit({ type: "term-done" }); events.end(() => process.exit(0)); }, 300);
});
if (stub.exitUnless && !fs.existsSync(stub.exitUnless)) events.end(() => process.exit(3));
else if (!stub.neverStart) {
  const server = http.createServer((_request, response) => response.end("{}"));
  server.listen(stub.port, "127.0.0.1", () => {
    emit({ type: "listening" });
    if (pending) process.send({ type: "prepared", updateId: context.update.id });
    if (stub.dieAfterMs) setTimeout(() => process.exit(4), stub.dieAfterMs);
    if (stub.stopAnsweringAfterMs) setTimeout(() => { server.close(); server.closeAllConnections(); }, stub.stopAnsweringAfterMs);
  });
}
setInterval(() => {}, 1 << 30);
`;

interface StubEvent {
  readonly type:
    | "start"
    | "listening"
    | "term"
    | "term-done"
    | "term-ignored"
    | "gone"
    | "runner-exit";
  readonly release: string;
  readonly pid: number;
  readonly ppid: number;
  readonly update?: string | null;
  readonly prevAlive?: boolean;
  readonly db?: string;
}

interface Stub {
  readonly writeDb?: string;
  readonly ignoreTerm?: boolean;
  readonly neverStart?: boolean;
  readonly dieAfterMs?: number;
  readonly stopAnsweringAfterMs?: number;
  readonly exitUnless?: string;
}

/** Resolve once `check` yields, re-checked on every change in `dir`; never a timer. */
function whenChanged<T>(dir: string, check: () => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    const watcher = NodeFS.watch(dir, () => {
      const value = check();
      if (value !== undefined) {
        watcher.close();
        resolve(value);
      }
    });
    const first = check();
    if (first !== undefined) {
      watcher.close();
      resolve(first);
    }
  });
}

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = NodeNet.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as NodeNet.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

async function makeScene(options: { watchSeconds?: number; startTimeoutSeconds?: number } = {}) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-seam-")),
  );
  const store = NodePath.join(root, "store");
  const home = NodePath.join(root, "home");
  const stateDir = NodePath.join(home, "userdata");
  NodeFS.mkdirSync(NodePath.join(store, "releases"), { recursive: true });
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const port = await freePort();
  writeJsonAtomic(NodePath.join(store, "deploy.json"), {
    home,
    stateDir,
    unit: "loom-seam-test",
    engineUnit: "loom-seam-test-deploy",
    port,
    repoUrl: "https://example.invalid/loom.git",
    watchSeconds: options.watchSeconds ?? 1,
    probeSeconds: 0.2,
    startTimeoutSeconds: options.startTimeoutSeconds ?? 60,
    backupDir: NodePath.join(root, "fast"),
  });
  const config = readConfig(store);
  const database = homePaths(config).database;
  NodeFS.writeFileSync(database, "before");

  const events: Array<StubEvent> = [];
  const waiters = new Set<() => void>();
  const socket = NodePath.join(root, "events.sock");
  const push = (event: StubEvent) => {
    events.push(event);
    for (const wake of waiters) wake();
  };
  launcherSpawns.hook = (child) => {
    if (child.spawnargs[1] !== "serve") return;
    const release = child.spawnargs[0]?.includes(NEXT.version) ? NEXT.id : BASE.id;
    child.once("exit", () =>
      push({ type: "runner-exit", release, pid: child.pid ?? 0, ppid: process.pid }),
    );
  };
  const listener = NodeNet.createServer((connection) => {
    let buffered = "";
    let first: StubEvent | undefined;
    connection.on("data", (chunk) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        const event = JSON.parse(line) as StubEvent;
        first ??= event;
        push(event);
      }
    });
    connection.on("close", () => first && push({ ...first, type: "gone" }));
  });
  await new Promise<void>((resolve) => listener.listen(socket, resolve));
  const event = (match: (event: StubEvent) => boolean) =>
    new Promise<StubEvent>((resolve) => {
      const check = () => {
        const found = events.find(match);
        if (found === undefined) return;
        waiters.delete(check);
        resolve(found);
      };
      waiters.add(check);
      check();
    });

  const env = {
    HOME: NodeOS.homedir(),
    PATH: `${NodePath.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    T3CODE_HOME: home,
  };
  const release = (name: { id: string; version: string }, stub: Stub = {}) => {
    const dir = NodePath.join(store, "releases", name.id);
    NodeFS.mkdirSync(NodePath.join(dir, "deploy", "runtime"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(dir, "apps", "server", "dist"), { recursive: true });
    NodeFS.copyFileSync(
      NodePath.join(REPO, "deploy", "runtime", "t3"),
      NodePath.join(dir, "deploy", "runtime", "t3"),
    );
    NodeFS.copyFileSync(
      NodePath.join(REPO, "deploy", "loom-deploy"),
      NodePath.join(dir, "deploy", "loom-deploy"),
    );
    NodeFS.chmodSync(NodePath.join(dir, "deploy", "runtime", "t3"), 0o755);
    NodeFS.chmodSync(NodePath.join(dir, "deploy", "loom-deploy"), 0o755);
    NodeFS.symlinkSync(
      NodePath.join(REPO, "apps", "server", "src"),
      NodePath.join(dir, "apps", "server", "src"),
    );
    NodeFS.writeFileSync(
      NodePath.join(dir, "deploy", "runtime", ".install-complete"),
      `${name.version}\n`,
    );
    writeJsonAtomic(NodePath.join(dir, "apps", "server", "package.json"), {
      type: "module",
      version: name.version,
    });
    NodeFS.writeFileSync(NodePath.join(dir, "apps", "server", "dist", "bin.mjs"), STUB_SERVER);
    writeJsonAtomic(NodePath.join(dir, "apps", "server", "dist", "stub.json"), {
      ...stub,
      name: name.id,
      port,
      events: socket,
      db: database,
      pidFile: NodePath.join(root, "server.pid"),
    });
    const manifest = readJson<{ releases: Record<string, unknown> }>(storePaths(store).manifest);
    writeJsonAtomic(storePaths(store).manifest, {
      releases: {
        ...manifest?.releases,
        [name.id]: {
          id: name.id,
          ref: "main",
          sha: `${name.id.slice(-7)}0`,
          builtAt: name.id,
          status: "ready",
        },
      },
    });
    return dir;
  };

  const adopt = (dir: string, ...args: ReadonlyArray<string>) => {
    const result = NodeChildProcess.spawnSync(
      NodePath.join(dir, "deploy", "loom-deploy"),
      ["adopt", ...args],
      {
        env,
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr);
  };

  /** The engine's step 6 and the "Loom is down" switch: stage, record, write the pending state. */
  const switchTo = async (dir: string, version: string, noReturn = false) => {
    writeJsonAtomic(NodePath.join(dir, "deploy", "runtime", "deploy.json"), {
      id: NodePath.basename(dir),
      sha: "",
      version,
      origin: "cli",
      who: "seam test",
      noReturn,
      fromRelease: BASE.id,
      startedAt: "2026-11-12T00:00:00Z",
      installedAt: null,
      switchedAt: "2026-11-12T00:02:00Z",
      headline: null,
      changes: [],
    });
    NodeFS.symlinkSync(
      NodePath.join(dir, "deploy", "runtime"),
      NodePath.join(homePaths(config).versions, version),
    );
    const state = await readServiceState(homePaths(config).state);
    const next = decodeServiceState({
      ...state,
      update: {
        id: `update-${version}`,
        fromVersion: state.activeVersion,
        targetVersion: version,
        dbPath: database,
        status: "pending",
      },
    });
    assert.isDefined(next);
    await writeServiceState(homePaths(config).state, next!);
    return `update-${version}`;
  };

  const launchers: Array<Launcher> = [];
  const launch = async () => {
    const launcher = new Launcher(home, await readServiceState(homePaths(config).state), {
      environment: env,
    });
    launchers.push(launcher);
    const outcome = { settled: false };
    const running = launcher.run().finally(() => {
      outcome.settled = true;
    });
    running.catch(() => undefined);
    return { launcher, running, outcome };
  };

  const statusWhen = (check: (status: LoomDeployStatus) => boolean) =>
    whenChanged(stateDir, () => {
      const status = readJson<LoomDeployStatus>(homePaths(config).status);
      return status !== undefined && check(status) ? status : undefined;
    });
  const stateWhen = (check: (state: ServiceState) => boolean) =>
    whenChanged(NodePath.dirname(homePaths(config).state), () => {
      const state = readJson<ServiceState>(homePaths(config).state);
      return state !== undefined && check(state) ? state : undefined;
    });
  const historyWhen = (outcome: string) =>
    whenChanged(store, () => {
      const text = NodeFS.existsSync(storePaths(store).history)
        ? NodeFS.readFileSync(storePaths(store).history, "utf8")
        : "";
      return text.includes(`"outcome":"${outcome}"`) ? text : undefined;
    });

  const base = release(BASE);
  adopt(base);
  return {
    root,
    store,
    home,
    config,
    database,
    env,
    base,
    release,
    adopt,
    switchTo,
    launch,
    event,
    events,
    statusWhen,
    stateWhen,
    historyWhen,
    [Symbol.asyncDispose]: async () => {
      for (const launcher of launchers) await launcher.stop("SIGTERM");
      listener.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The new release's server finished its shutdown before its runner exited. */
const assertRunnerWaited = (events: ReadonlyArray<StubEvent>) => {
  const index = (type: StubEvent["type"]) =>
    events.findIndex((event) => event.release === NEXT.id && event.type === type);
  assert.isAtLeast(index("term-done"), 0);
  assert.isBelow(index("term-done"), index("runner-exit"));
};

const seam = (name: string, body: () => Promise<void>) => it.live(name, () => Effect.promise(body));

seam(
  "a release that passes a shortened watch is accepted, and the kept copy outlives the launcher's",
  async () => {
    await using scene = await makeScene();
    const next = scene.release(NEXT);
    const updateId = await scene.switchTo(next, NEXT.version);
    await scene.launch();

    const live = await scene.statusWhen((status) => status.phase === "live");
    assert.equal(live.id, NEXT.id);
    const state = await scene.stateWhen((state) => state.update?.status === "committed");
    assert.equal(state.activeVersion, NEXT.version);
    assert.isFalse(NodeFS.existsSync(NodePath.join(homePaths(scene.config).backups, updateId)));
    assert.isTrue(NodeFS.lstatSync(homePaths(scene.config).backups).isSymbolicLink());
    assert.equal(
      NodeFS.readFileSync(NodePath.join(keptDir(scene.config), updateId, "database"), "utf8"),
      "before",
    );
    assert.equal(NodeFS.realpathSync(storePaths(scene.store).current), next);
    assert.equal(readJson<{ kind: string }>(homePaths(scene.config).notice)?.kind, "updated");

    await scene.historyWhen("live");
    const manifest = readJson<{ releases: Record<string, { status: string }> }>(
      storePaths(scene.store).manifest,
    );
    assert.equal(manifest?.releases[NEXT.id]?.status, "current");
    assert.deepEqual(
      Object.values(manifest?.releases ?? {}).filter((record) => record.status === "current")
        .length,
      1,
    );
  },
);

seam(
  "a server that dies during the watch is put back with the database, and back refuses that copy",
  async () => {
    await using scene = await makeScene({ watchSeconds: 30 });
    const next = scene.release(NEXT, { writeDb: "after", dieAfterMs: 200 });
    const updateId = await scene.switchTo(next, NEXT.version);
    const { launcher } = await scene.launch();

    const returned = await scene.event(
      (event) => event.release === BASE.id && event.update === "rolled-back",
    );
    assert.equal(returned.db, "before");
    assert.isFalse(returned.prevAlive);
    const putBack = await scene.statusWhen((status) => status.phase === "put-back");
    assert.equal(putBack.reason, "Loom exited during the watch (4).");
    assert.equal(readJson<{ kind: string }>(homePaths(scene.config).notice)?.kind, "rolled-back");
    assert.equal(NodeFS.realpathSync(storePaths(scene.store).current), scene.base);
    const manifest = readJson<{ releases: Record<string, { status: string }> }>(
      storePaths(scene.store).manifest,
    );
    assert.equal(manifest?.releases[NEXT.id]?.status, "failed");
    // The copy from before the failed release is the one the launcher just restored.
    assert.isFalse(NodeFS.existsSync(NodePath.join(keptDir(scene.config), updateId)));

    const refusal = await back(scene.config).then(
      () => "went back",
      (error: Error) => error.message,
    );
    assert.include(refusal, `No kept database copy belongs to the running release ${BASE.id}`);

    // A later restart on the same launcher state does not report the return again.
    const notice = readJson<{ id: string }>(homePaths(scene.config).notice)?.id;
    await launcher.stop("SIGTERM");
    await scene.launch();
    await scene.event(
      (event) =>
        event.release === BASE.id && event.type === "listening" && event.pid !== returned.pid,
    );
    assert.equal(readJson<{ id: string }>(homePaths(scene.config).notice)?.id, notice);
    const putBacks = NodeFS.readFileSync(storePaths(scene.store).history, "utf8").match(
      /"put-back"/g,
    );
    assert.equal(putBacks?.length, 1);
  },
);

seam("a server that stops answering is killed and gone before the runner exits", async () => {
  await using scene = await makeScene({ watchSeconds: 30 });
  const next = scene.release(NEXT, { stopAnsweringAfterMs: 100 });
  await scene.switchTo(next, NEXT.version);
  await scene.launch();

  const returned = await scene.event(
    (event) => event.release === BASE.id && event.update === "rolled-back",
  );
  assert.isFalse(returned.prevAlive);
  assertRunnerWaited(scene.events);
  const putBack = await scene.statusWhen((status) => status.phase === "put-back");
  assert.equal(putBack.reason, "Loom stopped answering during the watch.");
});

seam(
  "a server still starting at the start limit is killed and gone before the runner exits",
  async () => {
    await using scene = await makeScene({ startTimeoutSeconds: 1 });
    const next = scene.release(NEXT, { neverStart: true });
    await scene.switchTo(next, NEXT.version);
    await scene.launch();

    const returned = await scene.event(
      (event) => event.release === BASE.id && event.update === "rolled-back",
    );
    assert.isFalse(returned.prevAlive);
    assertRunnerWaited(scene.events);
    const putBack = await scene.statusWhen((status) => status.phase === "put-back");
    assert.equal(putBack.reason, "Loom did not finish starting within 1 s.");
  },
);

seam(
  "a server that ignores the stop signal is killed before the launcher's allowance ends",
  async () => {
    await using scene = await makeScene({ watchSeconds: 30 });
    const next = scene.release(NEXT, { ignoreTerm: true, stopAnsweringAfterMs: 100 });
    await scene.switchTo(next, NEXT.version);
    await scene.launch();

    await scene.event((event) => event.release === NEXT.id && event.type === "term-ignored");
    const returned = await scene.event(
      (event) => event.release === BASE.id && event.update === "rolled-back",
    );
    assert.isFalse(returned.prevAlive);
  },
);

seam("a runner killed with SIGKILL takes its server with it", async () => {
  await using scene = await makeScene();
  const { running } = await scene.launch();
  const listening = await scene.event(
    (event) => event.release === BASE.id && event.type === "listening",
  );

  process.kill(listening.ppid, "SIGKILL");
  await scene.event((event) => event.pid === listening.pid && event.type === "gone");
  const failure = await running.then(
    () => "completed",
    (error: Error) => error.message,
  );
  assert.include(failure, "Active child exited unexpectedly");
});

seam(
  "with --no-return a release that cannot start is accepted and held, and SIGHUP runs it again",
  async () => {
    await using scene = await makeScene();
    const fixed = NodePath.join(scene.root, "fixed");
    const next = scene.release(NEXT, { exitUnless: fixed });
    await scene.switchTo(next, NEXT.version, true);
    const { outcome } = await scene.launch();

    const held = await scene.statusWhen((status) => status.phase === "held");
    assert.include(held.reason ?? "", "held for a fix");
    const state = await readServiceState(homePaths(scene.config).state);
    assert.equal(state.activeVersion, NEXT.version);
    assert.equal(state.update?.status, "committed");

    const first = await scene.event((event) => event.release === NEXT.id && event.type === "start");
    NodeFS.writeFileSync(fixed, "");
    process.kill(first.ppid, "SIGHUP");
    await scene.statusWhen((status) => status.phase === "live");
    await scene.historyWhen("live");
    // A second "started" would have been fatal to the launcher.
    assert.isFalse(outcome.settled);
    assert.equal(
      (await readServiceState(homePaths(scene.config).state)).activeVersion,
      NEXT.version,
    );
  },
);

seam(
  "back during the watch restores the kept copy and the launcher accepts the state it writes",
  async () => {
    await using scene = await makeScene({ watchSeconds: 60 });
    const next = scene.release(NEXT, { writeDb: "after" });
    const updateId = await scene.switchTo(next, NEXT.version);
    const first = await scene.launch();
    await scene.statusWhen((status) => status.phase === "watching");
    assert.equal(NodeFS.readFileSync(scene.database, "utf8"), "after");

    let leftover = false;
    const code = await back(scene.config, {
      stop: async () => {
        await first.launcher.stop("SIGTERM");
      },
      start: async () => {
        leftover = NodeFS.existsSync(NodePath.join(homePaths(scene.config).backups, updateId));
        await scene.launch();
      },
    });
    assert.equal(code, 0);
    const returned = await scene.event(
      (event) => event.release === BASE.id && event.update === "rolled-back",
    );
    assert.equal(returned.db, "before");
    assert.isTrue(leftover);
    assert.isFalse(NodeFS.existsSync(NodePath.join(homePaths(scene.config).backups, updateId)));
    const state = await readServiceState(homePaths(scene.config).state);
    assert.equal(state.activeVersion, BASE.version);
    assert.equal(
      state.update?.status === "rolled-back" ? state.update.reason : undefined,
      "manual-return",
    );
    const putBack = await scene.statusWhen((status) => status.phase === "put-back");
    assert.equal(putBack.reason, "Put back with loom-deploy back.");
    assert.equal(readJson<{ reason: string }>(homePaths(scene.config).notice)?.reason, "manual");
    const manifest = readJson<{ releases: Record<string, { status: string }> }>(
      storePaths(scene.store).manifest,
    );
    assert.equal(manifest?.releases[BASE.id]?.status, "current");
  },
);

seam("a runner whose launcher backup is missing refuses to start the release", async () => {
  await using scene = await makeScene();
  const next = scene.release(NEXT);
  const context = {
    protocol: SERVICE_LAUNCHER_PROTOCOL,
    childVersion: NEXT.version,
    update: {
      id: "update-without-backup",
      fromVersion: BASE.version,
      targetVersion: NEXT.version,
      dbPath: scene.database,
      status: "pending",
    },
  };
  const runner = NodeChildProcess.spawn(NodePath.join(next, "deploy", "runtime", "t3"), ["serve"], {
    env: { ...scene.env, T3_SERVICE_LAUNCHER_CONTEXT: JSON.stringify(context) },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  const code = await new Promise<number | null>((resolve) => runner.once("exit", resolve));
  assert.equal(code, 1);
  const status = readJson<LoomDeployStatus>(homePaths(scene.config).status);
  assert.include(status?.reason ?? "", "database copy was not where Loom expects it");
});

it.layer(NodeServices.layer)("upstream's runtime prune", (it) => {
  it.effect("leaves a symlinked version folder alone", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "loom-seam-prune-"));
      const versions = NodePath.join(root, "runtime", "versions");
      const release = NodePath.join(root, "releases", NEXT.id, "deploy", "runtime");
      for (const [dir, version] of [
        [NodePath.join(versions, "0.1.7"), "0.1.7"],
        [release, NEXT.version],
      ]) {
        NodeFS.mkdirSync(dir!, { recursive: true });
        NodeFS.writeFileSync(NodePath.join(dir!, "t3"), "");
        NodeFS.writeFileSync(NodePath.join(dir!, ".install-complete"), `${version}\n`);
        NodeFS.utimesSync(NodePath.join(dir!, ".install-complete"), 0, 0);
      }
      NodeFS.symlinkSync(release, NodePath.join(versions, NEXT.version));
      yield* TestClock.setTime(Duration.toMillis(Duration.days(1)));
      const removed = yield* prunePinnedRuntimes({ baseDir: root, keep: [] }).pipe(
        Effect.provideService(
          ProcessRunner.ProcessRunner,
          ProcessRunner.ProcessRunner.of({
            run: () =>
              Effect.succeed({
                stdout: "p1\nftxt\nn/bin/sh\n",
                stderr: "",
                code: ChildProcessSpawner.ExitCode(0),
                timedOut: false,
                stdoutTruncated: false,
                stderrTruncated: false,
                stdoutInvalidUtf8: false,
                stderrInvalidUtf8: false,
              }),
          }),
        ),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(HostProcess.HomeDirectory, root),
      );
      assert.deepEqual([...removed], ["0.1.7"]);
      assert.isTrue(NodeFS.lstatSync(NodePath.join(versions, NEXT.version)).isSymbolicLink());
      NodeFS.rmSync(root, { recursive: true, force: true });
    }),
  );
});

it("the launcher protocol is the one Loom's runner and adopt were written for", () => {
  // A new number means a deploy across it needs deploy/README.md's protocol-change procedure.
  assert.equal(SERVICE_LAUNCHER_PROTOCOL, 3);
});

it("the trial start's log lines are still in their source files as written", () => {
  const source = (file: string) =>
    NodeFS.readFileSync(NodePath.join(REPO, "apps", "server", "src", file), "utf8");
  assert.include(source("serverSettings.ts"), `"${SETTINGS_WARNING}"`);
  assert.include(source("workspace/foreignHomeGuard.loom.ts"), `"${FOREIGN_HOME_LINE};`);
});
