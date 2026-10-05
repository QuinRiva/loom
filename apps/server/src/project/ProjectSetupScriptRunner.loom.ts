/**
 * loom: the worktree-readiness breadcrumb and setup-command tweaks that ride on
 * upstream's `ProjectSetupScriptRunner`.
 *
 * Every worktree agent's system prompt tells it to poll
 * `$(git rev-parse --git-dir)/t3code-setup-state.json` before running anything
 * that needs the project environment: `pending` → keep reading/editing,
 * `ready` → proceed, `failed` → inspect `detail`. The runner writes it at three
 * points: `pending` before the command is typed, `failed` if it cannot be
 * typed, and the settled outcome once the completion sentinel (or a terminal
 * exit) arrives — or after `SETUP_STATE_TIMEOUT`, because nothing upstream
 * settles a script that hangs, and an agent polling `pending` would wait
 * forever.
 */
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Lives in the worktree's private git dir so it never shows up as a source change. */
export const WORKTREE_SETUP_STATE_FILE = "t3code-setup-state.json";

export const WorktreeSetupState = Schema.Struct({
  status: Schema.Literals(["pending", "ready", "failed"]),
  scriptId: Schema.String,
  scriptName: Schema.String,
  updatedAt: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  detail: Schema.optional(Schema.String),
});
export type WorktreeSetupState = typeof WorktreeSetupState.Type;

const encodeWorktreeSetupState = Schema.encodeEffect(fromJsonStringPretty(WorktreeSetupState));

/** How long the breadcrumb waits for a setup run before declaring it `failed`. */
export const SETUP_STATE_TIMEOUT = Duration.minutes(30);

const worktreeSetupStatePath = Effect.fn("worktreeSetupStatePath")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  worktreePath: string,
) {
  const dotGit = path.join(worktreePath, ".git");
  if ((yield* fs.stat(dotGit)).type === "Directory") {
    return path.join(dotGit, WORKTREE_SETUP_STATE_FILE);
  }
  const gitDir = (yield* fs.readFileString(dotGit)).match(/^gitdir:\s*(.+?)\s*$/m)?.[1];
  if (!gitDir) {
    return yield* Effect.die(new Error(`Unrecognised .git file at '${dotGit}'.`));
  }
  return path.join(
    path.isAbsolute(gitDir) ? gitDir : path.resolve(worktreePath, gitDir),
    WORKTREE_SETUP_STATE_FILE,
  );
});

/** Best effort: a breadcrumb that cannot be written is logged, never fatal. */
export const writeWorktreeSetupState = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  worktreePath: string,
  state: Omit<WorktreeSetupState, "updatedAt">,
) =>
  Effect.gen(function* () {
    const statePath = yield* worktreeSetupStatePath(fs, path, worktreePath);
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* fs.writeFileString(
      statePath,
      `${yield* encodeWorktreeSetupState({ ...state, updatedAt })}\n`,
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("ProjectSetupScriptRunner failed to write worktree setup state", {
        worktreePath,
        status: state.status,
        cause: Cause.pretty(cause),
      }),
    ),
  );

/** The breadcrumb for a settled run, or `None` when `SETUP_STATE_TIMEOUT` elapsed first. */
export const settledWorktreeSetupState = (
  result: Option.Option<{ readonly exitCode: number | null }>,
): Pick<WorktreeSetupState, "status" | "exitCode" | "detail"> =>
  Option.match(result, {
    onNone: () => ({ status: "failed", detail: "Setup script timed out after 30 minutes." }),
    onSome: ({ exitCode }) =>
      exitCode === 0
        ? { status: "ready", exitCode }
        : exitCode === null
          ? {
              status: "failed",
              detail: "Setup terminal exited before the setup command completed.",
            }
          : { status: "failed", exitCode, detail: `Setup script exited with code ${exitCode}.` },
  });

/** A `bun install` setup script in a pnpm checkout runs pnpm's frozen install instead. */
export const setupInstallCommand = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  command: string,
) =>
  Effect.gen(function* () {
    return command.trim() === "bun install" &&
      (yield* fs.exists(path.join(cwd, "pnpm-lock.yaml")).pipe(Effect.orElseSucceed(() => false)))
      ? "pnpm install --frozen-lockfile"
      : command;
  });
