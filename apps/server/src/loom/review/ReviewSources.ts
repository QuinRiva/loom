/**
 * A review snapshot covers the worktree repo, nested repos (found via git, never a disk walk) and the
 * declared artefact folders in `.t3code/review.json` (default `.artifacts/`); ignored dirs also hold
 * logs and `.env`, so nothing undeclared. Every root must resolve inside the worktree.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

export type ReviewSourceKind = "repo" | "nested_repo" | "artifact_path";

export interface ReviewSource {
  /** `repo` · `nested:<relpath>` · `artifacts:<relpath>` */
  readonly id: string;
  readonly kind: ReviewSourceKind;
  /** Worktree-relative, `/`-separated; empty for the repo. */
  readonly relativePath: string;
  /** Absolute; the cwd a capture runs in (an artefact folder captures from the worktree). */
  readonly root: string;
}

const ReviewConfig = Schema.Struct({
  sources: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      kind: Schema.Literals(["nested_repo", "artifact_path"]),
    }),
  ),
});
const decodeReviewConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ReviewConfig));

const DEFAULT_ARTIFACT_PATH = ".artifacts";
// Skipped before the stat: a dependency or state tree is never a source of authored work.
const HEAVY_NAMES = new Set(["node_modules", ".venv", "venv", "__pycache__", ".t3", ".git"]);
const LISTING_MAX_BYTES = 4 * 1024 * 1024;

/** The worktree's review sources, repo first, then nested repos, then artefact folders. */
export const enumerateReviewSources = Effect.fn("loom.review.enumerateSources")(function* (
  worktree: string,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realWorktree = yield* fs.realPath(worktree);
  const insideWorktree = (target: string) =>
    fs.realPath(target).pipe(
      Effect.map((real) => {
        const relative = path.relative(realWorktree, real);
        return (
          relative !== "" &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        );
      }),
      Effect.orElseSucceed(() => false),
    );
  const normalise = (relative: string) =>
    relative
      .split(/[\\/]+/)
      .filter((segment) => segment !== "" && segment !== ".")
      .join("/");
  const isRepo = (directory: string) =>
    fs.exists(path.join(worktree, directory, ".git")).pipe(Effect.orElseSucceed(() => false));
  const isDirectory = (directory: string) =>
    fs.stat(path.join(worktree, directory)).pipe(
      Effect.map((stat) => stat.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );

  const listDirectories = (extra: ReadonlyArray<string>) =>
    git
      .execute({
        operation: "loom.review.listCandidateDirectories",
        cwd: worktree,
        args: ["ls-files", "--others", "--exclude-standard", "--directory", "-z", ...extra],
        maxOutputBytes: LISTING_MAX_BYTES,
      })
      .pipe(
        Effect.map((result) => result.stdout.split("\0").filter((entry) => entry.endsWith("/"))),
      );
  const [untracked, ignored] = yield* Effect.all(
    [listDirectories([]), listDirectories(["--ignored"])],
    { concurrency: 2 },
  );
  const submodules = (yield* git.execute({
    operation: "loom.review.listSubmodules",
    cwd: worktree,
    args: ["config", "-f", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"],
    allowNonZeroExit: true,
  })).stdout
    .split("\n")
    .flatMap((line) => {
      const space = line.indexOf(" ");
      return space === -1 ? [] : [line.slice(space + 1)];
    });

  // An absent file means the default; an invalid one declares nothing (and says so).
  const configPath = path.join(worktree, ".t3code", "review.json");
  const declaredSources = (yield* fs.exists(configPath))
    ? yield* fs.readFileString(configPath).pipe(
        Effect.flatMap(decodeReviewConfig),
        Effect.map((config) => config.sources),
        Effect.tapError((cause) =>
          Effect.logWarning("loom.review.config-invalid", { worktree, cause }),
        ),
        Effect.orElseSucceed(() => []),
      )
    : [{ path: DEFAULT_ARTIFACT_PATH, kind: "artifact_path" as const }];

  const nested = new Set<string>();
  for (const candidate of [
    ...untracked,
    ...ignored,
    ...submodules,
    ...declaredSources.filter((source) => source.kind === "nested_repo").map((s) => s.path),
  ]) {
    const relative = normalise(candidate);
    if (relative === "" || relative.split("/").some((segment) => HEAVY_NAMES.has(segment)))
      continue;
    if (nested.has(relative)) continue;
    if ((yield* isRepo(relative)) && (yield* insideWorktree(path.join(worktree, relative))))
      nested.add(relative);
  }
  const artifacts = new Set<string>();
  for (const source of declaredSources) {
    const relative = normalise(source.path);
    if (source.kind !== "artifact_path" || relative === "" || artifacts.has(relative)) continue;
    if ((yield* isDirectory(relative)) && (yield* insideWorktree(path.join(worktree, relative))))
      artifacts.add(relative);
  }

  return [
    { id: "repo", kind: "repo", relativePath: "", root: worktree },
    ...[...nested].toSorted().map((relative): ReviewSource => ({
      id: `nested:${relative}`,
      kind: "nested_repo",
      relativePath: relative,
      root: path.join(worktree, relative),
    })),
    ...[...artifacts].toSorted().map((relative): ReviewSource => ({
      id: `artifacts:${relative}`,
      kind: "artifact_path",
      relativePath: relative,
      root: worktree,
    })),
  ] satisfies ReadonlyArray<ReviewSource>;
});
