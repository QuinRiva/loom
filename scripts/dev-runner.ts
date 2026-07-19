#!/usr/bin/env node

import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { ChildProcess } from "effect/unstable/process";

import { loadRepoEnv } from "./lib/public-config.ts";

Object.assign(process.env, loadRepoEnv());

const BASE_SERVER_PORT = 13773;
const BASE_WEB_PORT = 5733;
const MAX_HASH_OFFSET = 3000;
const MAX_PORT = 65535;
const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "0.0.0.0", "::1", "::"] as const;

export const DEFAULT_T3_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), ".t3"),
);

const MODE_ARGS = {
  dev: [
    "run",
    "--filter=@t3tools/contracts",
    "--filter=@t3tools/web",
    "--filter=t3",
    "--parallel",
    "dev",
  ],
  "dev:server": ["run", "--filter=t3", "dev"],
  "dev:web": ["run", "--filter=@t3tools/web", "dev"],
  "dev:desktop": ["run", "--filter=@t3tools/desktop", "--filter=@t3tools/web", "dev"],
} as const satisfies Record<string, ReadonlyArray<string>>;

type DevMode = keyof typeof MODE_ARGS;
type PortAvailabilityCheck<R = never> = (port: number) => Effect.Effect<boolean, never, R>;

const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export function getDevRunnerModeArgs(mode: DevMode): ReadonlyArray<string> {
  return MODE_ARGS[mode];
}

export class DevRunnerConfigurationError extends Schema.TaggedErrorClass<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedErrorClass<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("T3CODE_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export class DevRunnerPortExhaustedError extends Schema.TaggedErrorClass<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedErrorClass<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedErrorClass<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

export const DevRunnerError = Schema.Union([
  DevRunnerConfigurationError,
  DevRunnerInvalidPortOffsetError,
  DevRunnerPortExhaustedError,
  DevRunnerProcessError,
  DevRunnerProcessExitError,
]);
export type DevRunnerError = typeof DevRunnerError.Type;
export const isDevRunnerError = Schema.is(DevRunnerError);

const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );
const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("T3CODE_PORT_OFFSET"),
  devInstance: optionalStringConfig("T3CODE_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      return Effect.fail(
        new DevRunnerInvalidPortOffsetError({
          configKey: "T3CODE_PORT_OFFSET",
          portOffset: config.portOffset,
          minimum: 0,
        }),
      );
    }
    return Effect.succeed({
      offset: config.portOffset,
      source: `T3CODE_PORT_OFFSET=${config.portOffset}`,
    });
  }

  const seed = config.devInstance?.trim();
  if (!seed) {
    return Effect.succeed({ offset: 0, source: "default ports" });
  }

  if (/^\d+$/.test(seed)) {
    return Effect.succeed({
      offset: Number(seed),
      source: `numeric T3CODE_DEV_INSTANCE=${seed}`,
    });
  }

  const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
  return Effect.succeed({ offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` });
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_T3_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  t3Home,
  browser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    const configuredBaseDir = t3Home?.trim() || baseEnv.T3CODE_HOME?.trim() || undefined;
    const resolvedBaseDir = yield* resolveBaseDir(configuredBaseDir);
    const isDesktopMode = mode === "dev:desktop";

    // Give each web-dev instance its own T3CODE_HOME keyed by server port.
    // The server writes dev state to `<home>/dev`, so multiple concurrent
    // worktree instances that inherit the same ambient T3CODE_HOME (e.g. the
    // live cockpit's) would otherwise share one sqlite and clobber each other.
    // Port-scoping keeps them isolated and away from the ambient home. Desktop
    // dev keeps the shared home (its backend port is stable and single-instance).
    const resolvedHome = isDesktopMode
      ? resolvedBaseDir
      : path.join(resolvedBaseDir, "dev-instances", String(serverPort));

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
      T3CODE_HOME: resolvedHome,
    };

    if (!isDesktopMode) {
      output.T3CODE_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
      output.VITE_WS_URL = `ws://localhost:${serverPort}`;
    } else {
      output.T3CODE_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      delete output.T3CODE_MODE;
      delete output.T3CODE_NO_BROWSER;
      delete output.T3CODE_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.T3CODE_HOST = host;
    }

    // Bind the web dev server (Vite reads process.env.HOST) to IPv4 loopback by
    // default. Vite resolves "localhost" to ::1 only, which VS Code Remote SSH
    // port-forwarding (IPv4 127.0.0.1) cannot reach. The server uses T3CODE_HOST
    // instead, so this does not change its bind. An explicit HOST still wins.
    if (!isDesktopMode && output.HOST === undefined) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
    }

    if (!isDesktopMode) {
      output.T3CODE_NO_BROWSER = browser === true ? "0" : "1";
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.T3CODE_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.T3CODE_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    return output;
  });
}

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

const defaultCheckPortAvailability: PortAvailabilityCheck<NetService.NetService> = (port) =>
  Effect.gen(function* () {
    const net = yield* NetService.NetService;
    return yield* checkPortAvailabilityOnHosts(port, DEV_PORT_PROBE_HOSTS, (candidatePort, host) =>
      net.canListenOnHost(candidatePort, host),
    );
  });

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService.NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerPortExhaustedError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];
      if (requireServerPort) {
        checks.push(checkPort(serverPort));
      }
      if (requireWebPort) {
        checks.push(checkPort(webPort));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);
      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerPortExhaustedError({
      startOffset,
      requireServerPort,
      requireWebPort,
      baseServerPort: BASE_SERVER_PORT,
      baseWebPort: BASE_WEB_PORT,
      maximumPort: MAX_PORT,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService.NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });
      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });
      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface ResolveRequestedPortInput<R = NetService.NetService> {
  readonly port: number | undefined;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

/**
 * Decide whether a requested server port should be honoured. `--port` falls
 * back to the ambient `T3CODE_PORT`, so the value may be a genuine CLI request
 * OR the live cockpit's own port leaking into an agent shell. Honour it only
 * when it is actually free; otherwise discard it (`effectivePort: undefined`)
 * so the caller falls back to offset scanning and never knowingly binds a busy
 * port. An explicitly free port is returned unchanged.
 */
export function resolveRequestedPort<R = NetService.NetService>({
  port,
  checkPortAvailability,
}: ResolveRequestedPortInput<R>): Effect.Effect<
  { readonly effectivePort: number | undefined; readonly requestedPortBusy: boolean },
  never,
  R
> {
  return Effect.gen(function* () {
    if (port === undefined) {
      return { effectivePort: undefined, requestedPortBusy: false };
    }
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;
    const available = yield* checkPort(port);
    return available
      ? { effectivePort: port, requestedPortBusy: false }
      : { effectivePort: undefined, requestedPortBusy: true };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly runArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerConfigurationError({
            configKeys: ["T3CODE_PORT_OFFSET", "T3CODE_DEV_INSTANCE"],
            cause,
          }),
      ),
    );

    const { offset, source } = yield* resolveOffset({ portOffset, devInstance });

    const { effectivePort, requestedPortBusy } = yield* resolveRequestedPort({
      port: input.port,
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: effectivePort !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
    });

    const hostEnvironment = yield* HostProcessEnvironment;
    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: hostEnvironment,
      serverOffset,
      webOffset,
      t3Home: input.t3Home,
      browser: input.browser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: effectivePort,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";
    const busySuffix = requestedPortBusy
      ? ` requestedPort=${String(input.port)}(busy, scanned instead)`
      : "";
    const baseDir = env.T3CODE_HOME ?? (yield* DEFAULT_T3_HOME);

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix}${busySuffix} serverPort=${String(env.T3CODE_PORT)} webPort=${String(env.PORT)} baseDir=${baseDir}`,
    );

    yield* Effect.logInfo(
      `[dev-runner] web:    http://localhost:${String(env.PORT)}  |  server: http://localhost:${String(env.T3CODE_PORT)}  |  pairing URL is printed below by the server once it starts.`,
    );

    if (input.dryRun) {
      return;
    }

    const spawnCommand = yield* resolveSpawnCommand(
      "vp",
      [...MODE_ARGS[input.mode], ...input.runArgs],
      { env },
    );
    const processContext = {
      mode: input.mode,
      executable: "vp" as const,
      argumentCount: spawnCommand.args.length,
      shell: spawnCommand.shell,
    } as const;
    const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      shell: spawnCommand.shell,
      // Keep Vite+ in the same process group so terminal signals (Ctrl+C)
      // reach it directly. Effect defaults to detached: true on non-Windows,
      // which would put the runner in a new group and require manual forwarding.
      detached: false,
      forceKillAfter: "1500 millis",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "spawn",
            cause,
          }),
      ),
    );

    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "wait-for-exit",
            cause,
          }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new DevRunnerProcessExitError({
        ...processContext,
        exitCode,
      });
    }
  });
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  t3Home: Flag.string("home-dir").pipe(
    Flag.withDescription(
      "Explicit T3 Code data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME).",
    ),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOME")),
  ),
  browser: Flag.boolean("browser").pipe(
    Flag.withDescription("Open a browser automatically (disabled by default for web dev)."),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to T3CODE_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("T3CODE_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn Vite+."),
    Flag.withDefault(false),
  ),
  runArgs: Argument.string("run-arg").pipe(
    Argument.withDescription("Additional Vite+ run args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
