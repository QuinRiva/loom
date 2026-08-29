/**
 * Shared dev-fixture config resolution — builds a `ServerConfig` for a scratch
 * `T3CODE_HOME`, so the seeder and the verifier read/write exactly the sqlite a
 * dev server started with the same `T3CODE_HOME` serves (state under
 * `<home>/userdata`).
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
  // Mirror a dev-runner-launched server exactly: it sets both `VITE_DEV_SERVER_URL`
  // (devUrl) and an explicit `T3CODE_HOME`. `deriveServerPaths` keys the state dir
  // off `devUrl !== undefined && !baseDirIsExplicit`, so an explicit home resolves
  // `<baseDir>/userdata/state.sqlite` regardless of devUrl — the exact path the
  // server serves. The seed is always given an explicit T3CODE_HOME, so pass
  // `baseDirIsExplicit: true` or the seed would write to a `dev/` dir nothing reads.
  const devUrl = new URL("http://localhost:5733");
  const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl, {
    baseDirIsExplicit: true,
  });
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
    devAllowedOrigins: [],
  };
  return config;
});
