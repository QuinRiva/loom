/**
 * Shared dev-fixture config resolution — builds a `ServerConfig` for a scratch
 * `T3CODE_HOME` in dev mode (state under `<home>/dev`), so the seeder and the
 * verifier read/write exactly the sqlite a dev server started with the same
 * `T3CODE_HOME` serves.
 *
 * @module dev/seedConfig
 */
// Dev-only fixture tooling (not shipped); see seedWorkstream.ts.
// @effect-diagnostics globalErrorInEffectFailure:off
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/** Resolve the scratch dev-mode ServerConfig service value from `T3CODE_HOME`. */
export const buildSeedConfig = Effect.gen(function* () {
  const path = yield* Path.Path;
  const t3Home = process.env.T3CODE_HOME;
  if (t3Home === undefined || t3Home.trim().length === 0) {
    return yield* Effect.fail(new Error("T3CODE_HOME must be set to the scratch home."));
  }
  const baseDir = path.resolve(t3Home.trim());
  // Dev mode: `deriveServerPaths` keys the `dev` state dir off a non-undefined
  // devUrl, so state lands in `<baseDir>/dev/state.sqlite` — the exact path a
  // dev server started with the same T3CODE_HOME resolves.
  const devUrl = new URL("http://localhost:5733");
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);
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
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "t3-seed",
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
  };
  return config;
});
