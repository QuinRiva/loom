// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

import type {
  ProjectListAbsoluteDirectoryInput,
  ProjectListAbsoluteDirectoryResult,
  ProjectReadAbsoluteFileInput,
  FilesystemEntryMetadata,
  FilesystemGetMetadataInput,
  FilesystemGetMetadataResult,
  ProjectReadFileInput,
  ProjectReadFileResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as KnownWorkspaces from "./KnownWorkspaces.ts";
import * as WorkspaceEntries from "./WorkspaceEntries.ts";
import * as WorkspacePaths from "./WorkspacePaths.ts";
import { fileHeaderMimeType } from "./fileHeaderMimeType.ts";

const PROJECT_READ_FILE_MAX_BYTES = 1024 * 1024;
// loom: out-of-workspace reads/listings and the larger .mdx plan budget.
/**
 * Upper bound a per-request `maxBytes` can raise the read cap to (8 MiB). Only
 * the `.mdx` plan preview opts in; the ceiling keeps an oversized/hostile
 * request from reading unbounded bytes into memory. Deliberately above any
 * plausible decision document (largest observed artefact ~1.25 MB) yet far
 * below a runaway read.
 */
const PROJECT_READ_FILE_PLAN_MAX_BYTES = 8 * 1024 * 1024;

/** Resolve a request's read cap: the default 1 MiB, or an opted-in budget clamped
 * to the plan ceiling. Shared by the workspace-relative and absolute reads so an
 * `.mdx` plan gets the same budget whichever path opened it. */
const resolveReadMaxBytes = (requested: number | undefined): number =>
  requested ? Math.min(requested, PROJECT_READ_FILE_PLAN_MAX_BYTES) : PROJECT_READ_FILE_MAX_BYTES;

// Windows also reaches `.git` through trailing dots or spaces, a `:` stream
// suffix, or the 8.3 short name `GIT~1`. Names compare upcased, as NTFS does.
const isGitMetadataName = (segment: string) => {
  const name = (segment.split(":")[0] ?? "").replace(/[. ]+$/, "").toUpperCase();
  return name === ".GIT" || name === "GIT~1";
};

export class WorkspaceFileSystemOperationError extends Schema.TaggedError<WorkspaceFileSystemOperationError>()(
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

export class WorkspaceFilePathEscapeError extends Schema.TaggedError<WorkspaceFilePathEscapeError>()(
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

export class WorkspacePathNotFileError extends Schema.TaggedError<WorkspacePathNotFileError>()(
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
export class WorkspaceAbsoluteReadError extends Schema.TaggedError<WorkspaceAbsoluteReadError>()(
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
export class WorkspaceAbsoluteListError extends Schema.TaggedError<WorkspaceAbsoluteListError>()(
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

export class WorkspaceBinaryFileError extends Schema.TaggedError<WorkspaceBinaryFileError>()(
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

export class WorkspaceFileSystem extends Context.Service<
  WorkspaceFileSystem,
  {
    readonly getMetadata: (
      input: FilesystemGetMetadataInput,
    ) => Effect.Effect<FilesystemGetMetadataResult>;

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
    /** Writes inside a known workspace only. */
    readonly writeFile: (
      input: ProjectWriteFileInput,
    ) => Effect.Effect<
      ProjectWriteFileResult,
      | WorkspaceFileSystemError
      | WorkspacePaths.WorkspacePathOutsideRootError
      | KnownWorkspaces.UnknownWorkspaceError
    >;
  }
>()("t3/workspace/WorkspaceFileSystem") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;
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
        // Non-blocking so a FIFO cannot hang the open; the stat below rejects
        // it. Regular files ignore the flag. Windows lacks it.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
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

  const metadataForPath = Effect.fnUntraced(function* (requestedPath: string) {
    const expandedPath = expandHomePath(requestedPath, yield* HostProcess.HomeDirectory);
    if (!path.isAbsolute(expandedPath)) return null;
    const stat = yield* fileSystem.stat(expandedPath).pipe(Effect.option);
    if (stat._tag === "None") return null;
    if (stat.value.type === "Directory") return { kind: "directory" } as const;
    if (stat.value.type !== "File") return { kind: "other" } as const;
    // loom: an unreadable regular file is null, as the result contract says, so
    // a chat file chip never turns into a link that clicks into a read error.
    if (!(yield* fileSystem.access(expandedPath, { readable: true }).pipe(Effect.isSuccess)))
      return null;
    let mimeType: string | undefined;
    if (path.extname(expandedPath) === "" && stat.value.size > 0) {
      mimeType = yield* Effect.tryPromise({
        try: async () => {
          const handle = await NodeFSP.open(
            expandedPath,
            NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK,
          );
          try {
            if (!(await handle.stat()).isFile()) return undefined;
            const buffer = Buffer.alloc(512);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            return fileHeaderMimeType(buffer.subarray(0, bytesRead));
          } finally {
            await handle.close();
          }
        },
        catch: () => undefined,
      }).pipe(Effect.catch(() => Effect.succeed(undefined)));
    }
    return {
      kind: "file",
      byteLength: Number(stat.value.size),
      ...(mimeType === undefined ? {} : { mimeType }),
    } satisfies FilesystemEntryMetadata;
  });

  const getMetadata: WorkspaceFileSystem["Service"]["getMetadata"] = Effect.fn(
    "WorkspaceFileSystem.getMetadata",
  )(function* (input) {
    const paths = [...new Set(input.paths)];
    const entries = yield* Effect.forEach(paths, metadataForPath, { concurrency: 8 });
    const byPath = new Map(paths.map((value, index) => [value, entries[index] ?? null]));
    return { entries: input.paths.map((value) => byPath.get(value) ?? null) };
  });

  /** Both paths must already be real paths. */
  const isInsideRealRoot = (realWorkspaceRoot: string, realPath: string) => {
    const relative = path.relative(realWorkspaceRoot, realPath);
    return !(
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    );
  };

  /**
   * Git runs config and hooks from its own folders, so a write never lands in one:
   * a `.git` entry, or a repository folder under another name such as `.bare`.
   * Folders are checked upward to a linked worktree's top, which holds a `.git`
   * file, since worktrees can sit inside a bare repository. `absolutePath` must
   * be normalized.
   */
  const isInGitFolder = async (absolutePath: string) => {
    if (absolutePath.split(path.sep).some(isGitMetadataName)) return true;
    for (let folder = path.dirname(absolutePath); ; folder = path.dirname(folder)) {
      const [head, commondir, objects, refs, dotGit] = await Promise.all(
        ["HEAD", "commondir", "objects", "refs", ".git"].map((name) =>
          NodeFSP.lstat(path.join(folder, name)).catch((error: NodeJS.ErrnoException) => {
            // Any other failure leaves the folder unknown, so the write is refused.
            if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
            throw error;
          }),
        ),
      );
      // What git reads as a repository: HEAD, plus objects and refs here or in
      // the folder a `commondir` file names, as in a linked worktree's git folder.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute path reads a host file in place, such as a report an agent wrote to a
   * temp directory; it gets no root check.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    if (path.isAbsolute(requestedPath)) {
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(requestedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: requestedPath,
            operationPath: requestedPath,
            operation: "realpath-target",
            cause,
          }),
      });
      return { relativePath: requestedPath, realTargetPath };
    }

    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });

    const realWorkspaceRoot = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
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
    if (!isInsideRealRoot(realWorkspaceRoot, realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const realTargetPath = target.realTargetPath;

    // A caller may request a larger budget (only the `.mdx` plan preview does),
    // clamped to the plan ceiling; absent it, the default 1 MiB cap applies.
    const maxBytes = resolveReadMaxBytes(input.maxBytes);

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
      resolveReadMaxBytes(input.maxBytes),
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

  /**
   * Resolves the file a write targets. The deepest existing ancestor resolves to
   * its real path before the root check, so neither the file nor the directories
   * created for it can follow a symlink out of the root. A dangling symlink is
   * rejected rather than written through.
   */
  const resolveWriteTarget = Effect.fn("WorkspaceFileSystem.resolveWriteTarget")(function* (
    input: ProjectWriteFileInput,
  ) {
    const target = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    const realWorkspaceRoot = yield* Effect.tryPromise({
      // Resolve `..` in cwd the way the relative path was resolved, before following links.
      try: () => NodeFSP.realpath(path.resolve(input.cwd)),
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

    // Split the host path, not the display relativePath: on POSIX `\` is a file name character.
    const segments = path.relative(input.cwd, target.absolutePath).split(path.sep);
    const realTargetPath = yield* Effect.tryPromise({
      try: async () => {
        for (let depth = segments.length; depth > 0; depth--) {
          const candidate = path.join(realWorkspaceRoot, ...segments.slice(0, depth));
          try {
            return path.join(await NodeFSP.realpath(candidate), ...segments.slice(depth));
          } catch (error) {
            // Only a missing entry is skipped; one that exists but cannot resolve is a dangling link.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              () => false,
            );
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" || exists) throw error;
          }
        }
        return path.join(realWorkspaceRoot, ...segments);
      },
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
    // The path as named is checked too: a `.git/config` symlink resolves away the `.git`.
    const namedTargetPath = path.join(realWorkspaceRoot, ...segments);
    const inGitFolder = Effect.fn("WorkspaceFileSystem.inGitFolder")((checkedPath: string) =>
      Effect.tryPromise({
        try: () => isInGitFolder(checkedPath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: checkedPath,
            operation: "stat",
            cause,
          }),
      }),
    );
    if (
      !isInsideRealRoot(realWorkspaceRoot, realTargetPath) ||
      (yield* inGitFolder(realTargetPath)) ||
      (yield* inGitFolder(namedTargetPath))
    ) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: realTargetPath,
      });
    }
    return { relativePath: target.relativePath, realTargetPath };
  });

  const writeFile: WorkspaceFileSystem["Service"]["writeFile"] = Effect.fn(
    "WorkspaceFileSystem.writeFile",
  )(function* (input) {
    yield* knownWorkspaces.assertContains(input.cwd);
    const target = yield* resolveWriteTarget(input);
    const realTargetPath = target.realTargetPath;

    yield* fileSystem.makeDirectory(path.dirname(realTargetPath), { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: path.dirname(realTargetPath),
            operation: "make-directory",
            cause,
          }),
      ),
    );
    yield* Effect.tryPromise({
      // A symlink swapped in after the check is not followed. Windows lacks O_NOFOLLOW.
      try: () =>
        NodeFSP.writeFile(realTargetPath, input.contents, {
          flag:
            NodeFS.constants.O_WRONLY |
            NodeFS.constants.O_CREAT |
            NodeFS.constants.O_TRUNC |
            (NodeFS.constants.O_NOFOLLOW ?? 0),
        }),
      catch: (cause) =>
        new WorkspaceFileSystemOperationError({
          workspaceRoot: input.cwd,
          relativePath: input.relativePath,
          resolvedPath: realTargetPath,
          operationPath: realTargetPath,
          operation: "write-file",
          cause,
        }),
    });
    yield* workspaceEntries.refresh(input.cwd);
    return { relativePath: target.relativePath };
  });

  return WorkspaceFileSystem.of({
    getMetadata,
    readFile,
    readAbsoluteFile, // loom:
    listAbsoluteDirectory, // loom:
    writeFile,
  });
});

export const layer = Layer.effect(WorkspaceFileSystem, make);
