import * as Schema from "effect/Schema";
import { NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_READ_ABSOLUTE_FILE_PATH_MAX_LENGTH = 4096;
const PROJECT_STAT_PATHS_MAX_COUNT = 200;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectListEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
});
export type ProjectListEntriesInput = typeof ProjectListEntriesInput.Type;

export const ProjectListEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectListEntriesResult = typeof ProjectListEntriesResult.Type;

export const ProjectEntriesFailure = Schema.Literals([
  "workspace_root_not_found",
  "workspace_root_create_failed",
  "workspace_root_stat_failed",
  "workspace_root_not_directory",
  "search_index_create_failed",
  "search_index_scan_timed_out",
  "search_index_search_failed",
]);
export type ProjectEntriesFailure = typeof ProjectEntriesFailure.Type;

type ProjectEntriesFailureContext = {
  readonly failure: ProjectEntriesFailure;
  readonly normalizedCwd?: string;
  readonly timeout?: string;
  readonly detail?: string;
  readonly cause?: unknown;
};

function decodedProjectErrorMessage(props: object): string | undefined {
  if (!("message" in props)) return undefined;
  return typeof props.message === "string" ? props.message : undefined;
}

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    queryLength: Schema.optional(NonNegativeInt),
    limit: Schema.optional(PositiveInt),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // The structured fields are optional on the wire so newer peers can decode legacy message-only
  // failures. New application code must provide them through this constructor.
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(
    props: ProjectEntriesFailureContext & {
      readonly cwd: string;
      readonly queryLength: number;
      readonly limit: number;
    },
  ) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to search workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export class ProjectListEntriesError extends Schema.TaggedErrorClass<ProjectListEntriesError>()(
  "ProjectListEntriesError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectEntriesFailure),
    normalizedCwd: Schema.optional(TrimmedNonEmptyString),
    timeout: Schema.optional(TrimmedNonEmptyString),
    detail: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectEntriesFailureContext & { readonly cwd: string }) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list workspace entries in '${props.cwd}'.`,
    } as any);
  }
}

export const ProjectReadFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_FILE_PATH_MAX_LENGTH)),
});
export type ProjectReadFileInput = typeof ProjectReadFileInput.Type;

export const ProjectReadFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
  contents: Schema.String,
  byteLength: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type ProjectReadFileResult = typeof ProjectReadFileResult.Type;

export const ProjectFileFailure = Schema.Literals([
  "workspace_path_outside_root",
  "resolved_path_outside_root",
  "path_not_absolute",
  "path_not_file",
  "path_not_directory",
  "binary_file",
  "operation_failed",
]);
export type ProjectFileFailure = typeof ProjectFileFailure.Type;

export const ProjectFileOperation = Schema.Literals([
  "realpath-workspace-root",
  "realpath-target",
  "open",
  "stat",
  "read",
  "readdir",
  "close",
  "make-directory",
  "write-file",
]);
export type ProjectFileOperation = typeof ProjectFileOperation.Type;

type ProjectFileFailureContext = {
  readonly cwd: string;
  readonly relativePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly resolvedWorkspaceRoot?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadFileError extends Schema.TaggedErrorClass<ProjectReadFileError>()(
  "ProjectReadFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to read workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}

/**
 * Read-only preview of a file addressed by absolute path, deliberately NOT
 * constrained to a workspace root. This exists so chat file chips can open
 * files the control plane embeds outside any workspace (e.g. workstream report
 * paths under the durable state dir). There is intentionally no absolute WRITE
 * counterpart — out-of-workspace files are previewable but never editable.
 */
export const ProjectReadAbsoluteFileInput = Schema.Struct({
  absolutePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_READ_ABSOLUTE_FILE_PATH_MAX_LENGTH),
  ),
});
export type ProjectReadAbsoluteFileInput = typeof ProjectReadAbsoluteFileInput.Type;

type ProjectAbsoluteFileFailureContext = {
  readonly absolutePath: string;
  readonly failure: ProjectFileFailure;
  readonly resolvedPath?: string;
  readonly operation?: ProjectFileOperation;
  readonly operationPath?: string;
  readonly cause?: unknown;
};

export class ProjectReadAbsoluteFileError extends Schema.TaggedErrorClass<ProjectReadAbsoluteFileError>()(
  "ProjectReadAbsoluteFileError",
  {
    absolutePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectAbsoluteFileFailureContext) {
    super({
      ...props,
      message: decodedProjectErrorMessage(props) ?? `Failed to read file '${props.absolutePath}'.`,
    } as any);
  }
}

/**
 * Batch existence check for chat file chips. Given a set of absolute paths,
 * report whether each exists and — when it does — whether it is a file or a
 * directory. This lets the renderer verify a chip's resolved target before
 * turning it into a clickable link (avoiding dead clicks on plausible-looking
 * paths that don't exist) and route directory targets sensibly. It is a cheap,
 * read-only probe: paths are neither read nor constrained to a workspace root,
 * mirroring the out-of-workspace absolute read.
 */
export const ProjectStatPathsInput = Schema.Struct({
  paths: Schema.Array(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_READ_ABSOLUTE_FILE_PATH_MAX_LENGTH)),
  ).check(Schema.isMaxLength(PROJECT_STAT_PATHS_MAX_COUNT)),
});
export type ProjectStatPathsInput = typeof ProjectStatPathsInput.Type;

export const ProjectPathKind = Schema.Literals(["file", "directory", "other", "missing"]);
export type ProjectPathKind = typeof ProjectPathKind.Type;

export const ProjectPathStat = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectPathKind,
});
export type ProjectPathStat = typeof ProjectPathStat.Type;

export const ProjectStatPathsResult = Schema.Struct({
  entries: Schema.Array(ProjectPathStat),
});
export type ProjectStatPathsResult = typeof ProjectStatPathsResult.Type;

export class ProjectStatPathsError extends Schema.TaggedErrorClass<ProjectStatPathsError>()(
  "ProjectStatPathsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: { readonly cause?: unknown; readonly message?: string }) {
    super({
      ...props,
      message: typeof props.message === "string" ? props.message : "Failed to stat paths.",
    } as any);
  }
}

/**
 * Read-only listing of a directory addressed by absolute path, deliberately
 * NOT constrained to a workspace root. Sibling of the absolute-file read: it
 * lets chat directory chips open a browsable listing for out-of-workspace
 * output dirs (e.g. data-analysis deliverables under a home directory). Like
 * the absolute read it is POSIX-oriented, symlink-resolved, and read-only —
 * there is intentionally no write counterpart.
 */
export const ProjectListAbsoluteDirectoryInput = Schema.Struct({
  absolutePath: TrimmedNonEmptyString.check(
    Schema.isMaxLength(PROJECT_READ_ABSOLUTE_FILE_PATH_MAX_LENGTH),
  ),
});
export type ProjectListAbsoluteDirectoryInput = typeof ProjectListAbsoluteDirectoryInput.Type;

export const ProjectAbsoluteDirectoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  kind: Schema.Literals(["file", "directory"]),
});
export type ProjectAbsoluteDirectoryEntry = typeof ProjectAbsoluteDirectoryEntry.Type;

export const ProjectListAbsoluteDirectoryResult = Schema.Struct({
  /** The symlink-resolved absolute directory that was listed. */
  absolutePath: TrimmedNonEmptyString,
  entries: Schema.Array(ProjectAbsoluteDirectoryEntry),
});
export type ProjectListAbsoluteDirectoryResult = typeof ProjectListAbsoluteDirectoryResult.Type;

export class ProjectListAbsoluteDirectoryError extends Schema.TaggedErrorClass<ProjectListAbsoluteDirectoryError>()(
  "ProjectListAbsoluteDirectoryError",
  {
    absolutePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectAbsoluteFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ?? `Failed to list directory '${props.absolutePath}'.`,
    } as any);
  }
}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    cwd: Schema.optional(TrimmedNonEmptyString),
    relativePath: Schema.optional(TrimmedNonEmptyString),
    failure: Schema.optional(ProjectFileFailure),
    resolvedPath: Schema.optional(TrimmedNonEmptyString),
    resolvedWorkspaceRoot: Schema.optional(TrimmedNonEmptyString),
    operation: Schema.optional(ProjectFileOperation),
    operationPath: Schema.optional(TrimmedNonEmptyString),
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  // @effect-diagnostics-next-line overriddenSchemaConstructor:off
  constructor(props: ProjectFileFailureContext) {
    super({
      ...props,
      message:
        decodedProjectErrorMessage(props) ??
        `Failed to write workspace file '${props.relativePath}' in '${props.cwd}'.`,
    } as any);
  }
}
