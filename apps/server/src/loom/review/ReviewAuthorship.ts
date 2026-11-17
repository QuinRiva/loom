/**
 * Who wrote each changed line of a thread's whole-branch diff (plans/diff-author-query/plan.mdx §3).
 * Blame runs on the working-tree copy down to the merge base, so lines older than the branch come
 * back as `boundary` and are dropped, uncommitted ones carry the zero id, and every other line names
 * a branch commit whose `Loom-Thread` trailer names its thread. Nothing is recorded: git is the store.
 */
import type {
  LoomReviewAuthorshipCommit,
  LoomReviewAuthorshipFile,
  LoomReviewAuthorshipInput,
  LoomReviewAuthorshipResult,
  LoomReviewAuthorshipThread,
  LoomReviewLineHistoryInput,
  LoomReviewLineHistoryResult,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

const MAX_FILES = 400;
const FILE_TIMEOUT_MS = 5_000;
const TOTAL_BUDGET_MS = 8_000;
const BLAME_CONCURRENCY = 4;
const OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const SUBJECT_MAX = 300;
const ZERO_SHA = /^0+$/;
const BLAME_HEADER = /^([0-9a-f]{40,64}) \d+ (\d+) (\d+)$/;
// %x1f between fields, %x1e between trailer values, NUL (-z) between commits.
const COMMIT_FORMAT =
  "--format=%H%x1f%s%x1f%an%x1f%aI%x1f%(trailers:key=Loom-Thread,valueonly,separator=%x1e)";

export class ReviewAuthorshipError extends Schema.TaggedError<ReviewAuthorshipError>()(
  "ReviewAuthorshipError",
  { threadId: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Authorship of thread ${this.threadId}'s diff could not be read: ${this.detail}`;
  }
}

const EMPTY: LoomReviewAuthorshipResult = {
  mergeBase: null,
  headSha: null,
  commits: [],
  threads: [],
  files: [],
  incomplete: false,
};

/** `git blame --incremental` → `[start, end, sha]` runs, boundary (pre-branch) lines dropped. */
const parseIncrementalBlame = (stdout: string) => {
  const boundary = new Set<string>();
  const entries: Array<[number, number, string]> = [];
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    const header = BLAME_HEADER.exec(line);
    if (header) {
      const start = Number(header[2]);
      current = header[1]!;
      entries.push([start, start + Number(header[3]) - 1, current]);
    } else if (line === "boundary" && current !== null) boundary.add(current);
  }
  const runs: Array<[number, number, string]> = [];
  for (const [start, end, sha] of entries
    .filter(([, , sha]) => !boundary.has(sha))
    .toSorted((left, right) => left[0] - right[0])) {
    const last = runs.at(-1);
    if (last && last[2] === sha && last[1] + 1 === start) last[1] = end;
    else runs.push([start, end, sha]);
  }
  return runs;
};

const parseCommits = (stdout: string): Array<LoomReviewAuthorshipCommit> =>
  stdout
    .split("\0")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha = "", subject = "", gitAuthor = "", authoredAt = "", trailers = ""] =
        record.split("\x1f");
      return {
        sha,
        subject: subject.slice(0, SUBJECT_MAX),
        gitAuthor,
        authoredAt,
        threadIds: [
          ...new Set(
            trailers
              .split("\x1e")
              .map((value) => value.trim())
              .filter((value) => value !== ""),
          ),
        ].map((value) => ThreadId.make(value)),
      };
    });

export class ReviewAuthorship extends Context.Service<
  ReviewAuthorship,
  {
    readonly authorship: (
      input: LoomReviewAuthorshipInput,
    ) => Effect.Effect<LoomReviewAuthorshipResult, ReviewAuthorshipError>;
    readonly lineHistory: (
      input: LoomReviewLineHistoryInput,
    ) => Effect.Effect<LoomReviewLineHistoryResult, ReviewAuthorshipError>;
  }
>()("t3/loom/review/ReviewAuthorship") {}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;

  const run = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly stdin?: string; readonly timeoutMs?: number } = {},
  ) =>
    git.execute({
      operation: "loom.review.authorship",
      cwd,
      args,
      allowNonZeroExit: true,
      maxOutputBytes: OUTPUT_MAX_BYTES,
      ...options,
    });

  /** The repository root of the checkout the Diff panel reads for this thread, or null. */
  const rootOf = Effect.fn("ReviewAuthorship.rootOf")(function* (threadId: ThreadId) {
    const shell = yield* orchestrator.getThreadShell(threadId);
    if (shell === null) return null;
    const cwd =
      shell.worktreePath ??
      Option.getOrNull(
        Option.map(yield* projects.get(shell.projectId), (project) => project.workspaceRoot),
      );
    if (cwd === null || !(yield* fs.exists(cwd))) return null;
    const top = yield* run(cwd, ["rev-parse", "--show-toplevel"]);
    return top.exitCode === 0 ? top.stdout.trim() : null;
  });

  /**
   * HEAD and the merge base of the diff the panel shows, resolved by the driver the diff itself
   * uses (`file` narrows its numstat to one path). Null when HEAD is unborn.
   */
  const branchOf = Effect.fn("ReviewAuthorship.branchOf")(function* (
    root: string,
    baseRef: string | null,
    file?: string,
  ) {
    const head = yield* run(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.exitCode !== 0) return null;
    const headSha = head.stdout.trim();
    const preview = yield* git.getReviewDiffPreview({
      cwd: root,
      sourceKind: "branch-range",
      metadataOnly: true,
      trackedOnly: true,
      ...(baseRef === null ? {} : { baseRef }),
      ...(file === undefined
        ? {}
        : { file: { path: file, previousPath: null, sourceKind: "branch-range" as const } }),
    });
    const source = preview.sources[0];
    const resolvedBase = source?.baseRef ?? null;
    if (resolvedBase === null) return { headSha, mergeBase: headSha, files: source?.files ?? [] };
    // The driver's comparison-ref rule: a remote-looking name is a remote-tracking ref first.
    const candidates = resolvedBase.startsWith("refs/")
      ? [resolvedBase]
      : [
          resolvedBase.includes("/")
            ? `refs/remotes/${resolvedBase}`
            : `refs/heads/${resolvedBase}`,
          resolvedBase,
        ];
    for (const candidate of candidates) {
      const mergeBase = yield* run(root, ["merge-base", "--end-of-options", candidate, "HEAD"]);
      if (mergeBase.exitCode === 0)
        return { headSha, mergeBase: mergeBase.stdout.trim(), files: source?.files ?? [] };
    }
    return yield* Effect.fail(`No common commit between ${resolvedBase} and HEAD.`);
  });

  const readCommits = (root: string, shas: ReadonlyArray<string>) =>
    shas.length === 0
      ? Effect.succeed([])
      : run(root, ["log", "--no-walk=unsorted", "--stdin", "-z", COMMIT_FORMAT], {
          stdin: `${shas.join("\n")}\n`,
        }).pipe(Effect.map((result) => parseCommits(result.stdout)));

  /** The threads the commits name that exist here and are not deleted, in first-commit order. */
  const readThreads = (commits: ReadonlyArray<LoomReviewAuthorshipCommit>) =>
    Effect.forEach(
      [...new Set(commits.flatMap((commit) => commit.threadIds))],
      (threadId) =>
        orchestrator.getThreadShell(threadId).pipe(
          Effect.map((shell): ReadonlyArray<LoomReviewAuthorshipThread> =>
            shell === null || shell.deletedAt !== null
              ? []
              : [
                  {
                    threadId,
                    title: shell.title,
                    role: shell.workstream?.role ?? null,
                    archived: shell.archivedAt !== null,
                    lastRunAt: shell.latestRunCompletedAt
                      ? DateTime.formatIso(shell.latestRunCompletedAt)
                      : null,
                  },
                ],
          ),
        ),
      { concurrency: 8 },
    ).pipe(Effect.map((threads) => threads.flat()));

  /**
   * One file's runs; `untracked` when it is not in HEAD; `skip` when git cannot blame it (a
   * submodule); null when it ran out of time, which makes the answer incomplete.
   */
  const blameFile = (root: string, mergeBase: string, path: string) =>
    run(root, ["blame", "--incremental", `^${mergeBase}`, "--", path], {
      timeoutMs: FILE_TIMEOUT_MS,
    }).pipe(
      Effect.map((result) =>
        result.exitCode === 0
          ? { path, runs: parseIncrementalBlame(result.stdout) }
          : /no such path/.test(result.stderr)
            ? { path, runs: [], untracked: true as const }
            : ("skip" as const),
      ),
      Effect.orElseSucceed(() => null),
    );

  const authorship = Effect.fn("ReviewAuthorship.authorship")(
    function* (input: LoomReviewAuthorshipInput) {
      const root = yield* rootOf(input.threadId);
      if (root === null) return EMPTY;
      const branch = yield* branchOf(root, input.baseRef);
      if (branch === null) return EMPTY;
      const untracked = (yield* run(root, [
        "ls-files",
        "-z",
        "--others",
        "--exclude-standard",
      ])).stdout
        .split("\0")
        .filter((path) => path !== "");
      // Only files that gained lines have a line to attribute; deletions and binaries have none.
      const changed = branch.files.filter((file) => file.additions > 0).map((file) => file.path);
      const capped = changed.slice(0, MAX_FILES);
      const blamed: Array<{
        readonly path: string;
        readonly runs: ReadonlyArray<[number, number, string]>;
        readonly untracked?: true;
      }> = [];
      let failed = false;
      const finished = yield* Effect.forEach(
        capped,
        (path) =>
          blameFile(root, branch.mergeBase, path).pipe(
            Effect.map((file) => {
              if (file === null) failed = true;
              else if (file !== "skip") blamed.push(file);
            }),
          ),
        { concurrency: BLAME_CONCURRENCY, discard: true },
      ).pipe(Effect.timeoutOption(TOTAL_BUDGET_MS));

      const shas = [
        ...new Set(
          blamed.flatMap((file) =>
            file.runs.map(([, , sha]) => sha).filter((sha) => !ZERO_SHA.test(sha)),
          ),
        ),
      ];
      const commits = (yield* readCommits(root, shas)).toSorted((left, right) =>
        left.authoredAt.localeCompare(right.authoredAt),
      );
      const indexOf = new Map(commits.map((commit, index) => [commit.sha, index]));
      const files: Array<LoomReviewAuthorshipFile> = [
        ...blamed.map((file) =>
          file.untracked
            ? { path: file.path, runs: [], untracked: true as const }
            : {
                path: file.path,
                // A commit git log did not return is left unattributed, never called uncommitted.
                runs: file.runs.flatMap(([start, end, sha]): Array<[number, number, number]> => {
                  const index = ZERO_SHA.test(sha) ? -1 : indexOf.get(sha);
                  return index === undefined ? [] : [[start, end, index]];
                }),
              },
        ),
        ...untracked
          .slice(0, Math.max(0, MAX_FILES - capped.length))
          .map((path) => ({ path, runs: [], untracked: true as const })),
      ];
      return {
        mergeBase: branch.mergeBase,
        headSha: branch.headSha,
        commits,
        threads: yield* readThreads(commits),
        files,
        incomplete:
          failed || Option.isNone(finished) || changed.length + untracked.length > MAX_FILES,
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ReviewAuthorshipError({
              threadId: input.threadId,
              detail: typeof cause === "string" ? cause : "git failed",
              ...(typeof cause === "string" ? {} : { cause }),
            }),
        ),
      ),
  );

  const lineHistory = Effect.fn("ReviewAuthorship.lineHistory")(
    function* (input: LoomReviewLineHistoryInput) {
      const none = { commits: [], threads: [] };
      const root = yield* rootOf(input.threadId);
      if (root === null) return none;
      const branch = yield* branchOf(root, input.baseRef, input.path);
      if (branch === null) return none;
      // Line numbers are the working tree's; on a file that differs from HEAD they would not match.
      const dirty = yield* run(root, ["diff", "--quiet", "HEAD", "--", input.path]);
      if (dirty.exitCode !== 0) return none;
      const log = yield* run(root, [
        "log",
        "-z",
        "-s",
        COMMIT_FORMAT,
        `-L${input.startLine},${input.endLine}:${input.path}`,
        `${branch.mergeBase}..HEAD`,
      ]);
      if (log.exitCode !== 0) return none;
      const commits = parseCommits(log.stdout);
      return { commits, threads: yield* readThreads(commits) };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ReviewAuthorshipError({
              threadId: input.threadId,
              detail: typeof cause === "string" ? cause : "git failed",
              ...(typeof cause === "string" ? {} : { cause }),
            }),
        ),
      ),
  );

  return ReviewAuthorship.of({ authorship, lineHistory });
});

export const layer = Layer.effect(ReviewAuthorship, make);
