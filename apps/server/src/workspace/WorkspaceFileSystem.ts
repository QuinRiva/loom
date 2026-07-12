// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectReadAbsoluteFileInput,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;

export class WorkspaceFileSystemOperationError extends Schema.TaggedErrorClass<WorkspaceFileSystemOperationError>()(
  "WorkspaceFileSystemOperationError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
    operationPath: Schema.String,
    operation: Schema.Literals([
      "realpath-workspace-root",
      "realpath-target",
      "open",
      "stat",
      "read",
      "close",
      "make-directory",
      "write-file",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace file operation '${this.operation}' failed at '${this.operationPath}' for resolved path '${this.resolvedPath}' (requested as '${this.relativePath}' in '${this.workspaceRoot}').`;
  }
}

export class WorkspaceFilePathEscapeError extends Schema.TaggedErrorClass<WorkspaceFilePathEscapeError>()(
  "WorkspaceFilePathEscapeError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedWorkspaceRoot: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' resolves outside workspace root '${this.workspaceRoot}': ${this.resolvedPath}`;
  }
}

export class WorkspacePathNotFileError extends Schema.TaggedErrorClass<WorkspacePathNotFileError>()(
  "WorkspacePathNotFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace path '${this.relativePath}' in '${this.workspaceRoot}' is not a file: ${this.resolvedPath}`;
  }
}

/**
 * Failure of an out-of-workspace absolute read. Distinct from the workspace
 * errors because there is no workspace root to report against; the failure
 * kind is carried so the RPC boundary can classify it without re-parsing.
 */
export class WorkspaceAbsoluteReadError extends Schema.TaggedErrorClass<WorkspaceAbsoluteReadError>()(
  "WorkspaceAbsoluteReadError",
  {
    absolutePath: Schema.String,
    resolvedPath: Schema.String,
    failure: Schema.Literals([
      "path_not_absolute",
      "path_not_file",
      "binary_file",
      "operation_failed",
    ]),
    operation: Schema.optional(
      Schema.Literals(["realpath-target", "open", "stat", "read", "close"]),
    ),
    operationPath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Absolute file read '${this.failure}' failed for '${this.absolutePath}' (resolved '${this.resolvedPath}').`;
  }
}

export class WorkspaceBinaryFileError extends Schema.TaggedErrorClass<WorkspaceBinaryFileError>()(
  "WorkspaceBinaryFileError",
  {
    workspaceRoot: Schema.String,
    relativePath: Schema.String,
    resolvedPath: Schema.String,
  },
) {
  override get message(): string {
    return `Workspace file '${this.relativePath}' in '${this.workspaceRoot}' is binary and cannot be previewed as text.`;
  }
}

export const WorkspaceFileSystemError = Schema.Union([
  WorkspaceFileSystemOperationError,
  WorkspaceFilePathEscapeError,
  WorkspacePathNotFileError,
  WorkspaceBinaryFileError,
]);
export type WorkspaceFileSystemError = typeof WorkspaceFileSystemError.Type;

/** Service tag for workspace file operations. */
export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    /** Read a UTF-8 text file relative to the workspace root. */
    readonly readFile: (
      input: ProjectReadFileInput,
    ) => Effect.Effect<
      ProjectReadFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
    /**
     * Read a UTF-8 text file addressed by absolute path, NOT constrained to a
     * workspace root. Read-only by design — there is no absolute write.
     */
    readonly readAbsoluteFile: (
      input: ProjectReadAbsoluteFileInput,
    ) => Effect.Effect<ProjectReadFileResult, WorkspaceAbsoluteReadError>;
    /**
     * Write a file relative to the workspace root.
     *
     * Creates parent directories as needed and rejects paths that escape the
     * workspace root.
     */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      WorkspaceFileSystemError | WorkspacePaths.WorkspacePathOutsideRootError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

  type ReadOperation = "open" | "stat" | "read" | "close";

  /**
   * Open a real (symlink-resolved) path, enforce the file/size/binary invariants
   * shared by workspace-relative and absolute reads, and decode it as UTF-8.
   * Callers own resolving/authorising the path and constructing their own error
   * shapes via the `errors` factories.
   */
  const readTextFromRealPath = <E>(
    realTargetPath: string,
    resultRelativePath: string,
    errors: {
      readonly operation: (operation: ReadOperation, cause: unknown) => E;
      readonly notFile: () => E;
      readonly binary: () => E;
    },
  ): Effect.Effect<ProjectReadFileResult, E> =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(realTargetPath, "r"),
        catch: (cause) => errors.operation("open", cause),
      }),
      (handle) =>
        Effect.gen(function* () {
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) => errors.operation("stat", cause),
          });
          if (!stat.isFile()) {
            return yield* Effect.fail(errors.notFile());
          }

          const bytesToRead = Math.min(stat.size, PROJECT_READ_FILE_MAX_BYTES);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) => errors.operation("read", cause),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* Effect.fail(errors.binary());
          }

          return {
            relativePath: resultRelativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > PROJECT_READ_FILE_MAX_BYTES,
          };
        }),
      (handle) =>
        Effect.tryPromise({
          try: () => handle.close(),
          catch: (cause) => errors.operation("close", cause),
        }),
    );

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.cwd),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: input.cwd,
          operation: "realpath-workspace-root",
          cause,
        }),
    });
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(target.absolutePath),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: target.absolutePath,
          operationPath: target.absolutePath,
          operation: "realpath-target",
          cause,
        }),
    });
    const relativeRealPath = path.relative(realWorkspaceRoot, realTargetPath);
    if (
      relativeRealPath.startsWith(`..${path.sep}`) ||
      relativeRealPath === ".." ||
      path.isAbsolute(relativeRealPath)
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }

    return yield* readTextFromRealPath<
      WorkspaceFileSystemOperationError | WorkspacePathNotFileError | WorkspaceBinaryFileError
    >(realTargetPath, target.relativePath, {
      operation: (operation, cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation,
          cause,
        }),
      notFile: () =>
        new WorkspacePathNotFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
        }),
      binary: () =>
        new WorkspaceBinaryFileError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
        }),
    });
  });

  const readAbsoluteFile: WorkspaceFileSystem["Service"]["readAbsoluteFile"] = Effect.fn(
    "WorkspaceFileSystem.readAbsoluteFile",
  )(function* (input) {
    if (!path.isAbsolute(input.absolutePath)) {
      return yield* new WorkspaceAbsoluteReadError({
        absolutePath: input.absolutePath,
        resolvedPath: input.absolutePath,
        failure: "path_not_absolute",
      });
    }

    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.absolutePath),
      catch: (cause) =>
        new WorkspaceAbsoluteReadError({
          absolutePath: input.absolutePath,
          resolvedPath: input.absolutePath,
          failure: "operation_failed",
          operation: "realpath-target",
          operationPath: input.absolutePath,
          cause,
        }),
    });

    return yield* readTextFromRealPath<WorkspaceAbsoluteReadError>(
      realTargetPath,
      input.absolutePath,
      {
        operation: (operation, cause) =>
          new WorkspaceAbsoluteReadError({
            absolutePath: input.absolutePath,
            resolvedPath: realTargetPath,
            failure: "operation_failed",
            operation,
            operationPath: realTargetPath,
            cause,
          }),
        notFile: () =>
          new WorkspaceAbsoluteReadError({
            absolutePath: input.absolutePath,
            resolvedPath: realTargetPath,
            failure: "path_not_file",
          }),
        binary: () =>
          new WorkspaceAbsoluteReadError({
            absolutePath: input.absolutePath,
            resolvedPath: realTargetPath,
            failure: "binary_file",
          }),
      },
    );
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    yield* fileSystem.makeDirectory(path.dirname(target.absolutePath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: path.dirname(target.absolutePath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* fileSystem.writeFileString(target.absolutePath, input.contents).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: target.absolutePath,
            operationPath: target.absolutePath,
            operation: "write-file",
            cause,
          }),
      ),
    );
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({ readFile, readAbsoluteFile, writeFile });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
