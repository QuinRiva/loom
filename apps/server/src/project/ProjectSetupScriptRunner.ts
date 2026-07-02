import { ProjectId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
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
  readonly terminalId: string;
  readonly cwd: string;
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
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals([
      "resolveProject",
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

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
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
        cause,
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

    const script = setupProjectScript(project.scripts);
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
        env,
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
        if (!match) return Effect.void;
        const exitCode = Number(match[1]);
        return exitCode === 0
          ? Deferred.succeed(completion, { exitCode }).pipe(Effect.asVoid)
          : failCompletion(new Error(`Setup script exited with code ${exitCode}.`));
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
      terminalId,
      cwd,
      completion: awaitCompletion,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
