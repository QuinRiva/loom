// @effect-diagnostics nodeBuiltinImport:off
// loom: two boot-time answers to "which database may this server open".
//
// The incident (22 Sep 2026): an agent ran `node apps/server/src/bin.ts serve`
// from a cockpit worktree without `--base-dir`. `serve` resolved its home from
// the ambient `T3CODE_HOME`, which on this host is the developer's LIVE
// install, so a second server opened the live `state.sqlite`, ran a migration
// against it, marked in-flight tool calls interrupted and reaped a session.
//
//   1. `selectServerBaseDir` picks the home. A checkout that an install itself
//      provisioned under `<home>/worktrees/` is development material for that
//      install and gets its own gitignored `.t3` — outranking the ambient
//      `T3CODE_HOME` it inherited, exactly as the dev runner does (see
//      `@t3tools/shared/devHome`). `--base-dir` still wins over everything.
//
//      The containment test is deliberate, not decoration. The deployed
//      cockpit runs from `~/loom-releases/current`, which IS a linked git
//      worktree (`gitdir: …/loom-releases/repo.git/worktrees/<id>`), as is
//      deployctl's smoke boot. A bare "in a worktree ⇒ use its `.t3`" rule
//      would flip production off `/home/Carl/.t3/cockpit` onto an empty
//      database on the next deploy. Provenance — did THIS home provision that
//      checkout — separates the two cases; it is the same discriminator the
//      foreign-home guard uses.
//
//      The trade it makes: a worktree a user made by hand keeps the ambient
//      home, while `t3` run from a T3-provisioned one gets a fresh, empty
//      home. That second half is the point, not an oversight — those
//      checkouts are throwaway feature work and must not share the live
//      database. Guard 2 covers the hand-made case that guard 1 lets through.
//
//   2. `ensureHomeNotLive` refuses to boot when another live server already
//      holds the home, reading the runtime-state file the server already
//      writes (`<stateDir>/server-runtime.json`) rather than inventing a
//      second lock. `claimServerHome` writes that file early — before the
//      database is opened — so the refusal covers the migration window, which
//      is where the incident did its damage. The normal post-activation write
//      overwrites it with the real bound port, and shutdown clears it.
//
// There is no `--force`: an operator who really means it deletes the file.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as ServerConfig from "../config.ts";
import {
  isProcessAlive,
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import { isInsideDirectory } from "./foreignHomeGuard.loom.ts";

/** Which rule chose the home. Reported verbatim in the startup log line. */
export type BaseDirRule = "flag" | "worktree" | "env" | "bootstrap" | "default";

export interface BaseDirSelection {
  readonly baseDir: string;
  readonly rule: BaseDirRule;
  /** The home the worktree rule displaced, for the log line. */
  readonly displacedHome?: string;
}

/**
 * Precedence: `--base-dir` > a worktree this install provisioned > the ambient
 * `T3CODE_HOME` > the desktop bootstrap envelope > `~/.t3`. All inputs must
 * already be absolute (`resolveBaseDir`), because the worktree rule compares
 * paths.
 */
export const selectServerBaseDir = (input: {
  readonly flagBaseDir?: string | undefined;
  readonly envHome?: string | undefined;
  readonly bootstrapHome?: string | undefined;
  readonly defaultHome: string;
  readonly worktreePath?: string | undefined;
}): BaseDirSelection => {
  if (input.flagBaseDir !== undefined) {
    return { baseDir: input.flagBaseDir, rule: "flag" };
  }
  const ambient: { readonly home: string; readonly rule: BaseDirRule } =
    input.envHome !== undefined
      ? { home: input.envHome, rule: "env" }
      : input.bootstrapHome !== undefined
        ? { home: input.bootstrapHome, rule: "bootstrap" }
        : { home: input.defaultHome, rule: "default" };
  // `worktreesDir` is `<home>/worktrees` (see `deriveServerPaths`): a checkout
  // below it was provisioned by that install, so it is never that install's
  // own home.
  return input.worktreePath !== undefined &&
    isInsideDirectory(NodePath.join(ambient.home, "worktrees"), input.worktreePath)
    ? {
        baseDir: NodePath.join(input.worktreePath, ".t3"),
        rule: "worktree",
        displacedHome: ambient.home,
      }
    : { baseDir: ambient.home, rule: ambient.rule };
};

/** The one INFO line an operator reads to see which home this server took. */
export const describeBaseDirSelection = (selection: BaseDirSelection): string => {
  switch (selection.rule) {
    case "flag":
      return `T3 home ${selection.baseDir} — chosen by --base-dir.`;
    case "worktree":
      return `T3 home ${selection.baseDir} — chosen by the worktree rule: this checkout was provisioned under ${selection.displacedHome}/worktrees, so it runs on its own .t3 instead of that install's live state. Pass --base-dir to override.`;
    case "env":
      return `T3 home ${selection.baseDir} — chosen by T3CODE_HOME.`;
    case "bootstrap":
      return `T3 home ${selection.baseDir} — chosen by the desktop bootstrap envelope.`;
    case "default":
      return `T3 home ${selection.baseDir} — chosen by default; no --base-dir and no T3CODE_HOME.`;
  }
};

export class ServerHomeBusyError extends Schema.TaggedError<ServerHomeBusyError>()(
  "ServerHomeBusyError",
  {
    baseDir: Schema.String,
    statePath: Schema.String,
    holderPid: Schema.Int,
    holderStartedAt: Schema.String,
    holderOrigin: Schema.String,
  },
) {
  override get message(): string {
    return [
      `Refusing to start: T3 home ${this.baseDir} is already held by a live T3 Code server`,
      `(pid ${this.holderPid}, started ${this.holderStartedAt}, ${this.holderOrigin}).`,
      "Two servers on one database corrupt live state.",
      "Give this server its own home with --base-dir,",
      `or delete ${this.statePath} if that process is not a T3 Code server.`,
    ].join(" ");
  }
}

/** A process entrypoint that means "this pid is a T3 Code server". */
const SERVER_ENTRYPOINT = /(\bbin\.(mjs|ts|js)\b)|((^|\/)t3(\s|$))/;

/**
 * `undefined` when the command line cannot be read — no `/proc` (macOS,
 * Windows), or a process we may not inspect.
 */
export const readProcessCmdline = (pid: number): string | undefined => {
  try {
    return NodeFS.readFileSync(`/proc/${pid}/cmdline`, "utf8").replaceAll("\0", " ").trim();
  } catch {
    return undefined;
  }
};

/**
 * Whether the recorded pid still holds the home. An unreadable command line
 * counts as held: proceeding costs a corrupted live database, refusing costs
 * one deleted file.
 */
export const classifyRuntimeHolder = (input: {
  readonly holderPid: number;
  readonly selfPid: number;
  readonly alive: boolean;
  readonly cmdline: string | undefined;
}): "free" | "held" =>
  input.holderPid === input.selfPid || !input.alive
    ? "free"
    : input.cmdline === undefined || SERVER_ENTRYPOINT.test(input.cmdline)
      ? "held"
      : "free";

/** Refuse the boot when another live server already holds this home. */
export const ensureHomeNotLive = Effect.fn("loom.ensureHomeNotLive")(function* (
  config: Pick<ServerConfig.ServerConfig["Service"], "baseDir" | "serverRuntimeStatePath">,
) {
  const holder = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(holder)) {
    return;
  }
  const verdict = classifyRuntimeHolder({
    holderPid: holder.value.pid,
    selfPid: process.pid,
    alive: isProcessAlive(holder.value.pid),
    cmdline: readProcessCmdline(holder.value.pid),
  });
  if (verdict === "free") {
    return;
  }
  return yield* new ServerHomeBusyError({
    baseDir: config.baseDir,
    statePath: config.serverRuntimeStatePath,
    holderPid: holder.value.pid,
    holderStartedAt: holder.value.startedAt,
    holderOrigin: holder.value.origin,
  });
});

/**
 * Take the home before the database is opened. A stale file (dead pid) is
 * overwritten here; `runServer` rewrites this with the real bound port once it
 * is listening, and clears it on shutdown.
 */
export const claimServerHome = Effect.fn("loom.claimServerHome")(function* (
  config: Pick<
    ServerConfig.ServerConfig["Service"],
    "host" | "devUrl" | "port" | "serverRuntimeStatePath"
  >,
) {
  const state = yield* makePersistedServerRuntimeState({ config, port: config.port });
  yield* persistServerRuntimeState({ path: config.serverRuntimeStatePath, state }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to claim the T3 home at boot", { cause }),
    ),
  );
});
