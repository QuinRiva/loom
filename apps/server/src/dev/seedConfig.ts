/**
 * Builds a `ServerConfig` for a scratch home so the seeder and verifier use the sqlite a dev server
 * on that home serves. The home is `--home-dir` or the worktree's `.t3`, never an ambient
 * `T3CODE_HOME` (inside T3 Code that is the live install). A home a live server holds is refused.
 */
// Dev-only fixture tooling (not shipped); see seedWorkstream.ts.
// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off
import * as NodeUtil from "node:util";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import { DEFAULT_SIGNAL_EXPORT } from "@t3tools/shared/observability";
import * as OtelEnvironment from "@t3tools/shared/otelEnvironment";

import * as ServerConfig from "../config.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../serverRuntimeState.ts";

/** Resolve the scratch dev-mode ServerConfig service value from `--home-dir` or the worktree's `.t3`. */
export const buildSeedConfig = Effect.gen(function* () {
  const path = yield* Path.Path;
  const t3Home =
    NodeUtil.parseArgs({ options: { "home-dir": { type: "string" } } }).values[
      "home-dir"
    ]?.trim() || (yield* resolveWorktreeT3Home(process.cwd()));
  if (t3Home === undefined) {
    return yield* Effect.fail(
      new Error("Outside a git worktree, pass --home-dir <scratch home> (T3CODE_HOME is ignored)."),
    );
  }
  const baseDir = path.resolve(t3Home);
  // Mirror a dev-runner-launched server: `deriveServerPaths` only uses a `dev/` state dir when the
  // base dir is not explicit, and the seed's home always is, so pass `baseDirIsExplicit: true` or the
  // seed would write to a `dev/` dir nothing reads.
  const devUrl = new URL("http://localhost:5733");
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
  const runtime = yield* readPersistedServerRuntimeState(derivedPaths.serverRuntimeStatePath);
  if (Option.isSome(runtime) && isProcessAlive(runtime.value.pid)) {
    return yield* Effect.fail(
      new Error(
        `${baseDir} is held by a live server (pid ${runtime.value.pid}, ${derivedPaths.serverRuntimeStatePath}); seed a scratch home instead.`,
      ),
    );
  }
  yield* ServerConfig.ensureServerDirectories(derivedPaths);
  const config: ServerConfig.ServerConfig["Service"] = {
    logLevel: "Error",
    traceMinLevel: "Error",
    traceTimingEnabled: false,
    traceBatchWindowMs: 200,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpLogsUrl: undefined,
    otlpTracesExport: DEFAULT_SIGNAL_EXPORT,
    otlpMetricsExport: DEFAULT_SIGNAL_EXPORT,
    otlpLogsExport: DEFAULT_SIGNAL_EXPORT,
    otelEnvironment: OtelEnvironment.none,
    mode: "web",
    port: 0,
    host: undefined,
    cwd: baseDir,
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    devAllowedOrigins: [],
  };
  return config;
});
