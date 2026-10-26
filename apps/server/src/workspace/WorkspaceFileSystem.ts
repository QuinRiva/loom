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
import { isNetworkPath } from "@t3tools/shared/path";
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
 * The ceiling a per-request `maxBytes` (only the `.mdx` plan preview) can raise the read cap to: well
 * above any plausible decision document (~1.25 MB observed), well below a runaway read.
 */
const PROJECT_READ_FILE_PLAN_MAX_BYTES = 8 * 1024 * 1024;

/** Resolve a request's read cap: the default 1 MiB, or an opted-in budget clamped
 * to the plan ceiling. Shared by the workspace-relative and absolute reads so an
 * `.mdx` plan gets the same budget whichever path opened it. */
const resolveReadMaxBytes = (requested: number | undefined): number =>
  requested ? Math.min(requested, PROJECT_READ_FILE_PLAN_MAX_BYTES) : PROJECT_READ_FILE_MAX_BYTES;

// NTFS reaches .git through trailing dots/spaces, stream suffixes and GIT~1; compare uppercased names.
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

/** @public */
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
    // Chips ask as soon as an agent's message renders, and touching a network
    // path makes Windows sign in to its host with the user's NTLM credentials.
    if (!path.isAbsolute(expandedPath) || isNetworkPath(expandedPath)) return null;
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

  // Reject Git folders, including renamed bare repos whose config/hooks can execute; paths must be normalized.
  // Stop at linked worktrees' .git files since worktrees can sit inside bare repos.
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
      // Git recognizes HEAD with commondir or objects/refs as a repository.
      if (head && (commondir || (objects && refs))) return true;
      if (dotGit?.isFile() || path.dirname(folder) === folder) return false;
    }
  };

  /**
   * Workspace-relative paths must stay inside the root, symlinks included. An
   * absolute or `~/` path reads a host file in place, such as a report an agent
   * wrote to a temp directory; it gets no root check. A network path does, since
   * Windows signs in to its host with the user's NTLM credentials.
   */
  const resolveReadTarget = Effect.fn("WorkspaceFileSystem.resolveReadTarget")(function* (
    input: ProjectReadFileInput,
  ) {
    const requestedPath = input.relativePath.trim();
    const hostPath = requestedPath.startsWith("~/")
      ? expandHomePath(requestedPath, yield* HostProcess.HomeDirectory)
      : requestedPath;
    if (
      isNetworkPath(hostPath) &&
      !KnownWorkspaces.isWithinRoot(path, path.resolve(hostPath), path.resolve(input.cwd))
    ) {
      return yield* new WorkspacePaths.WorkspacePathOutsideRootError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
      });
    }
    if (path.isAbsolute(hostPath)) {
      // Native realpath hands Windows a `\\?\` path as written, `..` included,
      // so a network path must be the resolved one the check above approved.
      // Others keep POSIX `link/..` semantics, which resolving first would change.
      const absolutePath = isNetworkPath(hostPath) ? path.resolve(hostPath) : hostPath;
      const realTargetPath = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(absolutePath),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: absolutePath,
            operationPath: absolutePath,
            operation: "realpath-target",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      );
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
    const resolved = yield* Effect.tryPromise({
      try: async () => {
        let candidate = target.absolutePath;
        for (;;) {
          try {
            return {
              realTargetPath: path.join(
                await NodeFSP.realpath(candidate),
                path.relative(candidate, target.absolutePath),
              ),
              exists: candidate === target.absolutePath,
            };
          } catch (error) {
            if (!input.allowMissing || (error as NodeJS.ErrnoException).code !== "ENOENT") {
              throw error;
            }
            // Like writes, missing reads must check the nearest existing ancestor.
            // An existing entry that cannot resolve is a dangling link, not absence.
            const exists = await NodeFSP.lstat(candidate).then(
              () => true,
              (cause: NodeJS.ErrnoException) => {
                if (cause.code !== "ENOENT") throw cause;
                return false;
              },
            );
            if (exists || path.dirname(candidate) === candidate) throw error;
            candidate = path.dirname(candidate);
          }
        }
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
    if (!isInsideRealRoot(realWorkspaceRoot, resolved.realTargetPath)) {
      return yield* new WorkspaceFilePathEscapeError({
        workspaceRoot: input.cwd,
        relativePath: input.relativePath,
        resolvedWorkspaceRoot: realWorkspaceRoot,
        resolvedPath: resolved.realTargetPath,
      });
    }
    return {
      relativePath: target.relativePath,
      realTargetPath: resolved.exists ? resolved.realTargetPath : null,
    };
  });

  const readFile: WorkspaceFileSystem["Service"]["readFile"] = Effect.fn(
    "WorkspaceFileSystem.readFile",
  )(function* (input) {
    const target = yield* resolveReadTarget(input);
    const absentResult = {
      relativePath: target.relativePath,
      contents: "",
      byteLength: 0,
      truncated: false,
      exists: false,
    };
    const realTargetPath = target.realTargetPath;
    if (realTargetPath === null) return absentResult;

    // loom: a caller may request a larger budget (only the `.mdx` plan preview does),
    // clamped to the plan ceiling; absent it, the default 1 MiB cap applies.
    const maxBytes = resolveReadMaxBytes(input.maxBytes);

    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        // Non-blocking opens prevent FIFO hangs before stat rejects them; Windows lacks the flag.
        try: () =>
          NodeFSP.open(
            realTargetPath,
            NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NONBLOCK ?? 0),
          ),
        catch: (cause) =>
          new WorkspaceFileSystemOperationError({
            workspaceRoot: input.cwd,
            relativePath: input.relativePath,
            resolvedPath: realTargetPath,
            operationPath: realTargetPath,
            operation: "open",
            cause,
          }),
      }).pipe(
        Effect.catchIf(
          (error) =>
            input.allowMissing === true && (error.cause as NodeJS.ErrnoException).code === "ENOENT",
          () => Effect.succeed(null),
        ),
      ),
      (handle) =>
        Effect.gen(function* () {
          if (handle === null) return absentResult;
          const stat = yield* Effect.tryPromise({
            try: () => handle.stat(),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "stat",
                cause,
              }),
          });
          if (!stat.isFile()) {
            return yield* new WorkspacePathNotFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          const bytesToRead = Math.min(stat.size, maxBytes);
          const buffer = Buffer.alloc(bytesToRead);
          const { bytesRead } = yield* Effect.tryPromise({
            try: () => handle.read(buffer, 0, bytesToRead, 0),
            catch: (cause) =>
              new WorkspaceFileSystemOperationError({
                workspaceRoot: input.cwd,
                relativePath: input.relativePath,
                resolvedPath: realTargetPath,
                operationPath: realTargetPath,
                operation: "read",
                cause,
              }),
          });
          const fileBytes = buffer.subarray(0, bytesRead);
          if (fileBytes.includes(0)) {
            return yield* new WorkspaceBinaryFileError({
              workspaceRoot: input.cwd,
              relativePath: input.relativePath,
              resolvedPath: realTargetPath,
            });
          }

          return {
            relativePath: target.relativePath,
            contents: new TextDecoder("utf-8").decode(fileBytes),
            byteLength: stat.size,
            truncated: stat.size > maxBytes,
          };
        }),
      (handle) =>
        handle === null
          ? Effect.void
          : Effect.tryPromise({
              try: () => handle.close(),
              catch: (cause) =>
                new WorkspaceFileSystemOperationError({
                  workspaceRoot: input.cwd,
                  relativePath: input.relativePath,
                  resolvedPath: realTargetPath,
                  operationPath: realTargetPath,
                  operation: "close",
                  cause,
                }),
            }),
    );
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

  // Resolve existing ancestors and reject dangling links so creation cannot follow symlinks outside root.
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
