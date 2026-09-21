import { ProjectId } from "@t3tools/contracts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as NodeCrypto from "node:crypto";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptCompletion {
  readonly exitCode: number;
}

/**
 * Environment-readiness breadcrumb written into the worktree's private git
 * directory (`$(git rev-parse --git-dir)/t3code-setup-state.json`) so agents
 * can check setup state without the file showing up as a source change.
 */
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

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly scriptCommand: string;
  readonly terminalId: string;
  readonly cwd: string;
  /** False when the script's `async` flag asks the agent to wait for it. */
  readonly async: boolean;
  readonly completion: Effect.Effect<ProjectSetupScriptCompletion, ProjectSetupScriptRunnerError>;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  /**
   * Wrap the command so the shell reports its exit code back through the
   * terminal stream, and forward cleaned output lines while it runs. The
   * bootstrap flow uses this to drive the worktree setup card.
   */
  readonly observeCompletion?: {
    readonly onOutputLine?: (line: string) => Effect.Effect<void>;
  };
}

export class ProjectSetupScriptOperationError extends Schema.TaggedError<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals([
      "resolveProject",
      "readSettings",
      "openTerminal",
      "writeCommand",
      "waitForCommand",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedError<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

const SETUP_COMMAND_TIMEOUT = Duration.minutes(30);

const OUTPUT_LINE_MAX_LENGTH = 400;
/** A partial line longer than this is a byte stream, not a line. Keep only the tail. */
const PARTIAL_LINE_MAX_LENGTH = 4_096;

/** Removes ANSI escape sequences and cursor controls so lines can be shown as plain text. */
function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

function setupCompletionCommand(platform: NodeJS.Platform, marker: string): string {
  if (platform === "win32") {
    return [
      `if ($global:LASTEXITCODE -eq $null) { if ($?) { Write-Output "${marker}0" } else { Write-Output "${marker}1" } } else { Write-Output "${marker}$global:LASTEXITCODE" }`,
      `echo ${marker}%ERRORLEVEL%`,
    ].join("\r");
  }
  return `printf '\\n${marker}%s\\n' "$?"`;
}

const setupFailureDetail = (error: ProjectSetupScriptRunnerError) =>
  error._tag === "ProjectSetupScriptOperationError" && error.cause instanceof Error
    ? error.cause.message
    : error.message;

const worktreeSetupStatePath = Effect.fn("ProjectSetupScriptRunner.worktreeSetupStatePath")(
  function* (fs: FileSystem.FileSystem, path: Path.Path, worktreePath: string) {
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
  },
);

const writeWorktreeSetupState = (
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

const setupInstallCommand = Effect.fn("ProjectSetupScriptRunner.setupInstallCommand")(function* (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  cwd: string,
  command: string,
) {
  return command.trim() === "bun install" &&
    (yield* fs.exists(path.join(cwd, "pnpm-lock.yaml")).pipe(Effect.orElseSucceed(() => false)))
    ? "pnpm install --frozen-lockfile"
    : command;
});

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const platform = yield* HostProcessPlatform;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readSettings",
            cause,
          }),
      ),
    );
    const script = setupProjectScript(resolveProjectScripts(settings, project));
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });
    const marker = `__T3CODE_SETUP_DONE_${NodeCrypto.randomBytes(8).toString("hex")}__:`;
    const completion = yield* Deferred.make<
      ProjectSetupScriptCompletion,
      ProjectSetupScriptRunnerError
    >();
    let outputTail = "";
    // Upstream's live setup-output forwarding: the worktree setup card renders
    // these lines while the script runs. Terminal output is a byte stream, so
    // partial lines are buffered until a newline; a bare carriage return is how
    // installers redraw a progress line in place, so each redraw becomes its own
    // line rather than being glued into one long one.
    const onOutputLine = input.observeCompletion?.onOutputLine;
    let lineBuffer = "";
    const forwardOutputLines = (data: string) => {
      if (!onOutputLine) return Effect.void;
      lineBuffer += data;
      const lines = lineBuffer.split(/\r\n|\r|\n/);
      // A script that never prints a newline must not grow this forever.
      lineBuffer = (lines.pop() ?? "").slice(-PARTIAL_LINE_MAX_LENGTH);
      return Effect.forEach(
        lines
          .map((line) => stripTerminalControl(line).trimEnd())
          .filter((line) => line.length > 0 && !line.includes(marker)),
        (line) => onOutputLine(line.slice(0, OUTPUT_LINE_MAX_LENGTH)),
        { discard: true },
      );
    };
    let unsubscribe: (() => void) | null = null;
    const failCompletion = (cause: unknown) =>
      Deferred.fail(
        completion,
        new ProjectSetupScriptOperationError({
          ...errorContext,
          operation: "waitForCommand",
          cause,
        }),
      ).pipe(Effect.asVoid);

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        // Setup may run before a terminal client attaches to answer color probes.
        env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );
    unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.threadId !== input.threadId || event.terminalId !== terminalId) {
        return Effect.void;
      }
      if (event.type === "output") {
        outputTail = (outputTail + event.data).slice(-4096);
        const match = outputTail.match(new RegExp(`${marker}(-?\\d+)`));
        if (!match) return forwardOutputLines(event.data);
        const exitCode = Number(match[1]);
        return forwardOutputLines(event.data).pipe(
          Effect.flatMap(() =>
            exitCode === 0
              ? Deferred.succeed(completion, { exitCode }).pipe(Effect.asVoid)
              : failCompletion(new Error(`Setup script exited with code ${exitCode}.`)),
          ),
        );
      }
      if (event.type === "exited" || event.type === "closed") {
        return failCompletion(
          new Error("Setup terminal exited before the setup command completed."),
        );
      }
      if (event.type === "error") {
        return failCompletion(new Error(event.message));
      }
      return Effect.void;
    });
    const setupStateBase = { scriptId: script.id, scriptName: script.name };
    yield* writeWorktreeSetupState(fs, path, cwd, { ...setupStateBase, status: "pending" });
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${(yield* setupInstallCommand(fs, path, cwd, script.command)).trimEnd()}\r${setupCompletionCommand(platform, marker)}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => unsubscribe?.()).pipe(
            Effect.flatMap(() =>
              writeWorktreeSetupState(fs, path, cwd, {
                ...setupStateBase,
                status: "failed",
                detail: setupFailureDetail(error),
              }),
            ),
          ),
        ),
      );

    const awaitCompletion = Deferred.await(completion).pipe(
      Effect.timeoutOption(SETUP_COMMAND_TIMEOUT),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.succeed(result.value)
          : failCompletion(new Error("Setup script timed out after 30 minutes.")).pipe(
              Effect.flatMap(() => Deferred.await(completion)),
            ),
      ),
      Effect.ensuring(Effect.sync(() => unsubscribe?.())),
    );

    // Observe completion in a detached fiber so callers never have to block on
    // it: the breadcrumb flips to ready/failed asynchronously.
    yield* awaitCompletion.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.logWarning("ProjectSetupScriptRunner setup script failed", {
            threadId: input.threadId,
            worktreePath: input.worktreePath,
            detail: setupFailureDetail(error),
          }).pipe(
            Effect.flatMap(() =>
              writeWorktreeSetupState(fs, path, cwd, {
                ...setupStateBase,
                status: "failed",
                detail: setupFailureDetail(error),
              }),
            ),
          ),
        onSuccess: ({ exitCode }) =>
          writeWorktreeSetupState(fs, path, cwd, { ...setupStateBase, status: "ready", exitCode }),
      }),
      Effect.forkDetach,
    );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      scriptCommand: script.command,
      terminalId,
      cwd,
      async: script.async !== false,
      completion: awaitCompletion,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
