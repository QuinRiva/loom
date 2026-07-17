// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceFileSystem - Effect service contract for workspace file mutations.
 *
 * Owns workspace-root-relative file read/write operations and their associated
 * safety checks and cache invalidation hooks.
 *
 * @module WorkspaceFileSystem
 */
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectListAbsoluteDirectoryInput,
  ProjectListAbsoluteDirectoryResult,
  ProjectReadAbsoluteFileInput,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectStatPathsInput,
  ProjectStatPathsResult,
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
/**
 * Upper bound a per-request `maxBytes` can raise the read cap to (8 MiB). Only
 * the `.mdx` plan preview opts in; the ceiling keeps an oversized/hostile
 * request from reading unbounded bytes into memory. Deliberately above any
 * plausible decision document (largest observed artefact ~1.25 MB) yet far
 * below a runaway read.
 */
const PROJECT_READ_FILE_PLAN_MAX_BYTES = 8 * 1024 * 1024;

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

/**
 * Failure of an out-of-workspace absolute directory listing. Sibling of
 * {@link WorkspaceAbsoluteReadError}: same read-only, POSIX-oriented,
 * explicit-boundary posture, but for a directory listing rather than a file
 * read.
 */
export class WorkspaceAbsoluteListError extends Schema.TaggedErrorClass<WorkspaceAbsoluteListError>()(
  "WorkspaceAbsoluteListError",
  {
    absolutePath: Schema.String,
    resolvedPath: Schema.String,
    failure: Schema.Literals(["path_not_absolute", "path_not_directory", "operation_failed"]),
    operation: Schema.optional(Schema.Literals(["realpath-target", "stat", "readdir"])),
    operationPath: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Absolute directory list '${this.failure}' failed for '${this.absolutePath}' (resolved '${this.resolvedPath}').`;
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
     * List a directory addressed by absolute path, NOT constrained to a
     * workspace root. Read-only by design — a sibling of {@link readAbsoluteFile}
     * so chat directory chips can browse out-of-workspace output dirs.
     */
    readonly listAbsoluteDirectory: (
      input: ProjectListAbsoluteDirectoryInput,
    ) => Effect.Effect<ProjectListAbsoluteDirectoryResult, WorkspaceAbsoluteListError>;
    /**
     * Batch existence probe: for each (absolute) path report whether it exists
     * and, if so, whether it is a file or directory. Read-only and never
     * fails per-path — a missing/unreadable/relative path is reported as
     * `missing` rather than raising — so chat chips can verify targets cheaply.
     */
    readonly statPaths: (input: ProjectStatPathsInput) => Effect.Effect<ProjectStatPathsResult>;
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
    maxBytes: number,
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

          const bytesToRead = Math.min(stat.size, maxBytes);
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
            truncated: stat.size > maxBytes,
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

    // A caller may request a larger budget (only the `.mdx` plan preview does),
    // clamped to the plan ceiling; absent it, the default 1 MiB cap applies.
    const maxBytes = input.maxBytes
      ? Math.min(input.maxBytes, PROJECT_READ_FILE_PLAN_MAX_BYTES)
      : PROJECT_READ_FILE_MAX_BYTES;

    return yield* readTextFromRealPath<
      WorkspaceFileSystemOperationError | WorkspacePathNotFileError | WorkspaceBinaryFileError
    >(realTargetPath, target.relativePath, maxBytes, {
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
      PROJECT_READ_FILE_MAX_BYTES,
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

  const listAbsoluteDirectory: WorkspaceFileSystem["Service"]["listAbsoluteDirectory"] = Effect.fn(
    "WorkspaceFileSystem.listAbsoluteDirectory",
  )(function* (input) {
    if (!path.isAbsolute(input.absolutePath)) {
      return yield* new WorkspaceAbsoluteListError({
        absolutePath: input.absolutePath,
        resolvedPath: input.absolutePath,
        failure: "path_not_absolute",
      });
    }

    // Resolve symlinks up front so the listed directory — and the child paths
    // the client derives from it — reflect what a click would actually open,
    // matching the absolute-read boundary.
    const realTargetPath = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(input.absolutePath),
      catch: (cause) =>
        new WorkspaceAbsoluteListError({
          absolutePath: input.absolutePath,
          resolvedPath: input.absolutePath,
          failure: "operation_failed",
          operation: "realpath-target",
          operationPath: input.absolutePath,
          cause,
        }),
    });

    const targetStat = yield* Effect.tryPromise({
      try: () => NodeFSP.stat(realTargetPath),
      catch: (cause) =>
        new WorkspaceAbsoluteListError({
          absolutePath: input.absolutePath,
          resolvedPath: realTargetPath,
          failure: "operation_failed",
          operation: "stat",
          operationPath: realTargetPath,
          cause,
        }),
    });
    if (!targetStat.isDirectory()) {
      return yield* new WorkspaceAbsoluteListError({
        absolutePath: input.absolutePath,
        resolvedPath: realTargetPath,
        failure: "path_not_directory",
      });
    }

    const dirents = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(realTargetPath, { withFileTypes: true }),
      catch: (cause) =>
        new WorkspaceAbsoluteListError({
          absolutePath: input.absolutePath,
          resolvedPath: realTargetPath,
          failure: "operation_failed",
          operation: "readdir",
          operationPath: realTargetPath,
          cause,
        }),
    });

    const resolved = yield* Effect.forEach(
      dirents,
      (dirent) =>
        Effect.promise(async () => {
          if (dirent.isDirectory()) {
            return { name: dirent.name, kind: "directory" as const };
          }
          if (dirent.isFile()) {
            return { name: dirent.name, kind: "file" as const };
          }
          if (dirent.isSymbolicLink()) {
            // Resolve the link target's kind so it lists (and later opens) the
            // same way a click would; unresolvable links are dropped.
            try {
              const linkStat = await NodeFSP.stat(path.join(realTargetPath, dirent.name));
              if (linkStat.isDirectory()) return { name: dirent.name, kind: "directory" as const };
              if (linkStat.isFile()) return { name: dirent.name, kind: "file" as const };
            } catch {
              return null;
            }
          }
          // FIFOs/sockets/devices are not browsable/openable — omit them.
          return null;
        }),
      { concurrency: 16 },
    );

    const entries = resolved
      .filter((entry): entry is { name: string; kind: "file" | "directory" } => entry !== null)
      .toSorted((left, right) => {
        if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
        return left.name.localeCompare(right.name);
      });

    return { absolutePath: realTargetPath, entries };
  });

  const statPaths: WorkspaceFileSystem["Service"]["statPaths"] = Effect.fn(
    "WorkspaceFileSystem.statPaths",
  )(function* (input) {
    const entries = yield* Effect.forEach(
      input.paths,
      (requestedPath) =>
        Effect.promise(async () => {
          if (!path.isAbsolute(requestedPath)) {
            return { path: requestedPath, kind: "missing" as const };
          }
          try {
            // Follow symlinks (matching the read paths) so a chip's target kind
            // reflects what a click would actually open.
            const stat = await NodeFSP.stat(requestedPath);
            if (stat.isDirectory()) {
              return { path: requestedPath, kind: "directory" as const };
            }
            if (!stat.isFile()) {
              // FIFOs/sockets/devices are not openable as files — not a chip.
              return { path: requestedPath, kind: "other" as const };
            }
            // A regular file that stat can see but the read path cannot open
            // (e.g. no read permission) must not become a clickable chip either.
            try {
              await NodeFSP.access(requestedPath, NodeFS.constants.R_OK);
            } catch {
              return { path: requestedPath, kind: "other" as const };
            }
            return { path: requestedPath, kind: "file" as const };
          } catch {
            return { path: requestedPath, kind: "missing" as const };
          }
        }),
      { concurrency: 16 },
    );
    return { entries };
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

  return WorkspaceFileSystem.of({
    readFile,
    readAbsoluteFile,
    listAbsoluteDirectory,
    statPaths,
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
