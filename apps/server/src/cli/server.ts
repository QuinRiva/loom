import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Command, GlobalFlag } from "effect/unstable/cli";
import * as CliError from "effect/unstable/cli/CliError";

import * as ServerConfig from "../config.ts";
import { claimServerHome } from "../workspace/serverHomeGuard.loom.ts"; // loom:
import { runServer } from "../server.ts";
import { type CliServerFlags, resolveServerConfig, sharedServerCommandFlags } from "./config.ts";

const encodeCommand = Schema.encodeEffect(Schema.fromJsonString(Schema.String));

const runServerCommand = (
  flags: CliServerFlags,
  options?: {
    readonly startupPresentation?: ServerConfig.StartupPresentation;
    readonly forceAutoBootstrapProjectFromCwd?: boolean;
    readonly rejectRunningServer?: boolean;
  },
) =>
  Effect.gen(function* () {
    const logLevel = yield* GlobalFlag.LogLevel;
    // loom: two servers on one database corrupt live state. `resolveServerConfig`
    // refuses before it touches the home; claiming it here, before `runServer`
    // opens the database, extends that refusal over our own migration window.
    // Kept beside upstream's `rejectRunningServer` preflight, which skips `serve`
    // and the migration window (DL-87).
    const config = yield* resolveServerConfig(flags, logLevel, {
      ...options,
      refuseWhenHomeIsLive: true,
    });
    yield* claimServerHome(config);
    return yield* runServer.pipe(Effect.provideService(ServerConfig.ServerConfig, config));
  });

/** Bare words can name existing directories, but must not create typo projects. */
export const runDefaultServerCommand = (flags: CliServerFlags) =>
  Effect.gen(function* () {
    if (Option.isSome(flags.cwd)) {
      const cwd = flags.cwd.value.trim();
      const fs = yield* FileSystem.FileSystem;
      const platform = yield* HostProcessPlatform;
      const explicitPath =
        cwd === "." ||
        cwd === ".." ||
        cwd === "~" ||
        /[/\\]/.test(cwd) ||
        (platform === "win32" && /^[a-z]:/i.test(cwd));
      if (
        !explicitPath &&
        (!(yield* fs.exists(cwd)) || (yield* fs.stat(cwd)).type !== "Directory")
      ) {
        return yield* new CliError.UserError({
          cause: cwd,
          userMessage: `Unknown command ${yield* encodeCommand(cwd)}. Use "t3 --help" for commands or an explicit path such as "t3 ./my-project" for a new directory.`,
        });
      }
    }
    return yield* runServerCommand(flags, { rejectRunningServer: true });
  });

export const startCommand = Command.make("start", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription("Run the T3 Code server."),
  Command.withHandler((flags) => runServerCommand(flags, { rejectRunningServer: true })),
);

export const serveCommand = Command.make("serve", { ...sharedServerCommandFlags }).pipe(
  Command.withDescription(
    "Run the T3 Code server without opening a browser and print headless pairing details.",
  ),
  Command.withHandler((flags) =>
    runServerCommand(flags, {
      startupPresentation: "headless",
      forceAutoBootstrapProjectFromCwd: false,
    }),
  ),
);
