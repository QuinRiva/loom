/**
 * Review snapshots (plans/change-review/plan.mdx §2): a whole-source snapshot of a thread's
 * worktree taken when a human message lands, one per review source (`ReviewSources.ts`), so
 * "what changed since your message" is exact whoever edited the worktree in between.
 *
 * Repo and nested-repo sources reuse the isolated checkpoint primitive
 * (`CheckpointStore.captureCheckpoint`: a private index, `commit-tree -p HEAD`), run with the
 * source root as cwd, so a nested repo's ref and objects land in that repo's own store. An
 * artefact folder is gitignored, so it is `git add -f -A`'d into a persistent per-source index
 * under the worktree's private git dir (21 ms after the first build instead of seconds), with
 * files over 5 MB left out. Refs live under `refs/t3/loom-review/<thread>/<source>/<message>`
 * (plus one `…/live` per thread and source); Restore and the turn checkpoints never look there.
 *
 * Lifecycle: at most {@link SNAPSHOTS_PER_SOURCE} per (thread, source), oldest deleted first;
 * everything for a thread goes on archive, deletion, or {@link QUIET_DAYS} days without a human
 * message or a run. Deletion runs against the stored `git_common_dir`, so it works after the
 * worktree directory is gone. A `…/live` ref is written only for a source the thread's latest
 * message captured, so every store holding one also holds a row and the deletion finds it.
 *
 * Reads (§5): consecutive messages' snapshots bound a closed interval, the latest one and a fresh
 * live capture the live interval; a diff is `git diff` between the two commits per source, with
 * the source's prefix in the patch paths so nested files land on worktree-relative paths.
 *
 * @module loom/review/ReviewSnapshotService
 */
import {
  CheckpointRef,
  type LoomReviewChangeCounts,
  type LoomReviewDiffInput,
  type LoomReviewDiffResult,
  type LoomReviewFileContentsInput,
  type LoomReviewIntervalsResult,
  type LoomReviewSource,
  MessageId,
  type ReviewDiffFileContentsResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import { isGitImport, parseTurnDiffFilesFromNumstat } from "../../checkpointing/Diffs.ts";
import { GIT_LOCK_RETRY } from "../../git/gitLockRetry.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import { storageCleanupActivityAt } from "../../storageCleanup.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { refuseForeignHomeSideEffect } from "../../workspace/foreignHomeGuard.loom.ts";
import { enumerateReviewSources, type ReviewSource } from "./ReviewSources.ts";

export const REVIEW_REFS_PREFIX = "refs/t3/loom-review";
export const SNAPSHOTS_PER_SOURCE = 50;
export const QUIET_DAYS = 14;
const MAX_ARTIFACT_FILE_BYTES = 5 * 1024 * 1024;
const LIVE_COALESCE = Duration.seconds(2);
const LISTING_MAX_BYTES = 64 * 1024 * 1024;
// The bounds `review.getDiffPreview` puts on a whole patch and on one file's.
const PATCH_MAX_BYTES = 120_000;
const FILE_MAX_BYTES = 1024 * 1024;
const OBJECT_ID = /^[0-9a-f]{40,64}$/;
const SLACK_REPLY = /^\[Slack reply from ([^\]\n]+)\]\s*/;

export class ReviewSnapshotError extends Schema.TaggedError<ReviewSnapshotError>()(
  "ReviewSnapshotError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Review snapshot ${this.operation} failed for thread ${this.threadId}.`;
  }
}

/** One `loom_review_snapshots` row. */
const ReviewSnapshotRow = Schema.Struct({
  messageId: Schema.String,
  sourceId: Schema.String,
  threadId: Schema.String,
  messageCreatedAt: Schema.String,
  capturedAt: Schema.String,
  worktreePath: Schema.String,
  sourceKind: Schema.Literals(["repo", "nested_repo", "artifact_path"]),
  sourceRoot: Schema.String,
  gitCommonDir: Schema.String,
  ref: Schema.String,
  commitOid: Schema.NullOr(Schema.String),
  treeOid: Schema.NullOr(Schema.String),
  headOid: Schema.NullOr(Schema.String),
  /** Files differing from this source's previous snapshot, git imports excluded; null on the first. */
  closesFilesChanged: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["ready", "error"]),
  /** Why an `error` row failed, or the artefact files a `ready` row left out for size. */
  error: Schema.NullOr(Schema.String),
});
export type ReviewSnapshotRow = typeof ReviewSnapshotRow.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(ReviewSnapshotRow));

export interface LiveReviewSnapshot {
  readonly source: ReviewSource;
  readonly ref: string;
  readonly commitOid: string;
}

/** The wire shape of the source a row captured. */
const reviewSourceOf = (row: ReviewSnapshotRow): LoomReviewSource => {
  const relative =
    row.sourceKind === "repo" ? "" : row.sourceId.slice(row.sourceId.indexOf(":") + 1);
  return {
    id: row.sourceId,
    kind: row.sourceKind,
    title: relative === "" ? "Repo" : `${relative}/`,
    prefix: row.sourceKind === "nested_repo" ? `${relative}/` : "",
  };
};

const SOURCE_ORDER = { repo: 0, nested_repo: 1, artifact_path: 2 } as const;

/** Rows newest message first, each message with its rows (consecutive messages bound an interval). */
const messagesOf = (rows: ReadonlyArray<ReviewSnapshotRow>) =>
  [...Map.groupBy(rows, (row) => row.messageId)].map(([messageId, messageRows]) => ({
    messageId,
    at: messageRows[0]!.messageCreatedAt,
    ready: messageRows
      .filter(
        (row): row is ReviewSnapshotRow & { readonly commitOid: string } =>
          row.status === "ready" && row.commitOid !== null,
      )
      .toSorted(
        (left, right) =>
          SOURCE_ORDER[left.sourceKind] - SOURCE_ORDER[right.sourceKind] ||
          left.sourceId.localeCompare(right.sourceId),
      ),
  }));

/** The selector's label: the first line, without a relayed Slack reply's prefix, which names the sender. */
const describeMessage = (text: string) => {
  const trimmed = text.trimStart();
  const relayed = SLACK_REPLY.exec(trimmed);
  const firstLine =
    (relayed ? trimmed.slice(relayed[0].length) : trimmed)
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  return { firstLine: firstLine.slice(0, 200), sender: relayed?.[1]?.trim() ?? null };
};

const key = (value: string) => Base64Url.encode(value);
const reviewThreadRefPrefix = (threadId: ThreadId) => `${REVIEW_REFS_PREFIX}/${key(threadId)}/`;
const reviewSnapshotRef = (threadId: ThreadId, sourceId: string, messageId: string) =>
  `${reviewThreadRefPrefix(threadId)}${key(sourceId)}/${key(messageId)}`;
const reviewLiveRef = (threadId: ThreadId, sourceId: string) =>
  `${reviewThreadRefPrefix(threadId)}${key(sourceId)}/live`;

// The checkpoint primitive's guards for any index git writes (GitVcsDriver.captureCheckpoint).
const INDEX_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.splitIndex=false",
  "-c",
  "splitIndex.sharedIndexExpire=never",
];
const DURABLE_WRITE = ["-c", "core.fsync=objects,reference", "-c", "core.fsyncMethod=fsync"];
const COMMIT_IDENTITY = {
  GIT_AUTHOR_NAME: "T3 Code",
  GIT_AUTHOR_EMAIL: "t3code@users.noreply.github.com",
  GIT_COMMITTER_NAME: "T3 Code",
  GIT_COMMITTER_EMAIL: "t3code@users.noreply.github.com",
};

export class ReviewSnapshotService extends Context.Service<
  ReviewSnapshotService,
  {
    /** Snapshots every source of the thread's worktree for this message, repo first; a message already captured is skipped. */
    readonly captureForMessage: (input: {
      readonly threadId: ThreadId;
      readonly messageId: MessageId;
      readonly messageCreatedAt: DateTime.Utc;
    }) => Effect.Effect<void, ReviewSnapshotError>;
    /**
     * Overwrites the `…/live` ref of each source the latest message captured with the worktree as
     * it is now (none before the thread has a snapshot); single-flight, and a capture under two
     * seconds old is reused.
     */
    readonly captureLive: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<LiveReviewSnapshot>, ReviewSnapshotError>;
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ReviewSnapshotRow>, ReviewSnapshotError>;
    /** Deletes every ref and row the thread has (archive, deletion, the quiet sweep). */
    readonly deleteForThread: (threadId: ThreadId) => Effect.Effect<void, ReviewSnapshotError>;
    /** Deletes the snapshots of threads gone, archived, or quiet for {@link QUIET_DAYS} days. */
    readonly sweepQuiet: Effect.Effect<void, ReviewSnapshotError>;
    readonly listIntervals: (
      threadId: ThreadId,
    ) => Effect.Effect<LoomReviewIntervalsResult, ReviewSnapshotError>;
    readonly diff: (
      input: LoomReviewDiffInput,
    ) => Effect.Effect<LoomReviewDiffResult, ReviewSnapshotError>;
    readonly fileContents: (
      input: LoomReviewFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewSnapshotError>;
  }
>()("t3/loom/review/ReviewSnapshotService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<
    GitVcsDriver.GitVcsDriver | FileSystem.FileSystem | Path.Path
  >();
  // Captures in one worktree run one at a time: the artefact index is shared by its threads.
  const worktreeLocks = yield* KeyedLock.make<string>();

  const run = (
    cwd: string,
    args: ReadonlyArray<string>,
    options: { readonly env?: NodeJS.ProcessEnv; readonly stdin?: string } = {},
  ) =>
    git
      .execute({
        operation: "loom.review.git",
        cwd,
        args,
        maxOutputBytes: LISTING_MAX_BYTES,
        ...options,
      })
      .pipe(Effect.map((result) => result.stdout));

  /**
   * The thread's worktree (resolved through symlinks) when it is a live git checkout this home
   * owns, else null. Null too while a "new worktree" launch is still preparing it: the project
   * root is then another checkout, and the reactor captures that message at the run's release.
   */
  const resolveWorktree = Effect.fn("loom.review.resolveWorktree")(function* (threadId: ThreadId) {
    const shell = yield* orchestrator.getThreadShell(threadId);
    if (shell === null || shell.archivedAt !== null) return null;
    if (shell.worktreePath === null && shell.latestRunId !== null) {
      const { runs } = yield* orchestrator.getThreadRecords(threadId, ["runs"], {
        runIds: [shell.latestRunId],
      });
      if (
        runs.some(
          (run) => run.status === "preparing" && run.workspacePreparation?.type === "worktree",
        )
      )
        return null;
    }
    const cwd =
      shell.worktreePath ??
      Option.getOrNull(
        Option.map(yield* projects.get(shell.projectId), (project) => project.workspaceRoot),
      );
    if (cwd === null || !(yield* fs.exists(cwd))) return null;
    if (!(yield* checkpoints.isGitRepository(cwd))) return null;
    if (yield* refuseForeignHomeSideEffect("loom.review.capture", cwd)) return null;
    return yield* fs.realPath(cwd);
  });

  const commonDirOf = (cwd: string) =>
    run(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]).pipe(
      Effect.map((out) => out.trim()),
    );

  const captureArtifacts = Effect.fn("loom.review.captureArtifacts")(function* (
    source: ReviewSource,
    ref: string,
  ) {
    const worktree = source.root;
    const indexPath = (yield* run(worktree, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      `loom-review-${key(source.id)}.index`,
    ])).trim();
    // Only this service writes the index, under the worktree lock: a lock left by a crash is stale.
    yield* fs.remove(`${indexPath}.lock`, { force: true });
    const env = { GIT_INDEX_FILE: indexPath, ...COMMIT_IDENTITY };
    const untracked = (yield* run(worktree, [
      "ls-files",
      "-z",
      "--others",
      "--",
      source.relativePath,
    ]))
      .split("\0")
      .filter((file) => file !== "");
    const oversized = (yield* Effect.forEach(
      untracked,
      (file) =>
        fs.stat(path.join(worktree, file)).pipe(
          Effect.map((stat) => (Number(stat.size) > MAX_ARTIFACT_FILE_BYTES ? [file] : [])),
          Effect.orElseSucceed(() => []),
        ),
      { concurrency: 32 },
    )).flat();
    if (oversized.length > 0)
      yield* run(
        worktree,
        [
          ...INDEX_CONFIG,
          "rm",
          "--cached",
          "-q",
          "--ignore-unmatch",
          "--",
          ...oversized.map((file) => `:(literal)${file}`),
        ],
        { env },
      );
    yield* run(
      worktree,
      [
        ...INDEX_CONFIG,
        ...DURABLE_WRITE,
        "add",
        "-f",
        "-A",
        "--",
        source.relativePath,
        ...oversized.map((file) => `:(exclude,literal)${file}`),
      ],
      { env },
    );
    const treeOid = (yield* run(worktree, [...INDEX_CONFIG, ...DURABLE_WRITE, "write-tree"], {
      env,
    })).trim();
    const commitOid = (yield* run(
      worktree,
      [...DURABLE_WRITE, "commit-tree", treeOid, "-m", `t3 review snapshot ref=${ref}`],
      { env },
    )).trim();
    yield* run(worktree, [...DURABLE_WRITE, "update-ref", ref, commitOid]);
    return { commitOid, treeOid, headOid: null, oversized };
  });

  /** Writes `ref` for the source as it is on disk now. */
  const captureSource = Effect.fn("loom.review.captureSource")(function* (
    source: ReviewSource,
    ref: string,
  ) {
    if (source.kind === "artifact_path") return yield* captureArtifacts(source, ref);
    yield* checkpoints.captureCheckpoint({
      cwd: source.root,
      checkpointRef: CheckpointRef.make(ref),
    });
    const [commitOid = "", treeOid = "", headOid = ""] = (yield* run(source.root, [
      "show",
      "-s",
      "--format=%H %T %P",
      ref,
    ]))
      .trim()
      .split(" ");
    return { commitOid, treeOid, headOid: headOid || null, oversized: [] as ReadonlyArray<string> };
  });

  /** Files differing between two snapshots of one source, dropping what a pull or rebase brought in. */
  const countChanged = Effect.fn("loom.review.countChanged")(function* (
    source: ReviewSource,
    from: string,
    to: string,
  ) {
    const changed = (yield* run(source.root, [
      "diff",
      "--name-only",
      "-z",
      "--no-renames",
      "--no-ext-diff",
      from,
      to,
    ]))
      .split("\0")
      .filter((file) => file !== "");
    if (source.kind === "artifact_path") return changed.length;
    const authored = yield* checkpoints.listAuthoredPaths({
      cwd: source.root,
      fromCheckpointRef: CheckpointRef.make(from),
      toCheckpointRef: CheckpointRef.make(to),
    });
    return authored === null ? changed.length : changed.filter((file) => authored.has(file)).length;
  });

  const selectRows = (where: ReturnType<typeof sql.and>) =>
    sql`SELECT message_id AS "messageId", source_id AS "sourceId", thread_id AS "threadId",
          message_created_at AS "messageCreatedAt", captured_at AS "capturedAt",
          worktree_path AS "worktreePath", source_kind AS "sourceKind", source_root AS "sourceRoot",
          git_common_dir AS "gitCommonDir", ref, commit_oid AS "commitOid", tree_oid AS "treeOid",
          head_oid AS "headOid", closes_files_changed AS "closesFilesChanged", status, error
        FROM loom_review_snapshots WHERE ${where}
        ORDER BY message_created_at DESC, captured_at DESC`.pipe(Effect.flatMap(decodeRows));

  /** Deletes the refs (one `update-ref --stdin` transaction per store), then the rows. */
  const deleteSnapshots = Effect.fn("loom.review.deleteSnapshots")(function* (
    rows: ReadonlyArray<ReviewSnapshotRow>,
    /** Also every other ref under this prefix in each store (a thread's `…/live` refs). */
    refPrefix: string | null,
  ) {
    for (const [gitCommonDir, group] of Map.groupBy(rows, (row) => row.gitCommonDir)) {
      // A store that is gone took its refs with it.
      if (gitCommonDir !== "" && (yield* fs.exists(gitCommonDir))) {
        const listed =
          refPrefix === null
            ? ""
            : yield* run(gitCommonDir, [
                `--git-dir=${gitCommonDir}`,
                "for-each-ref",
                "--format=%(refname)",
                refPrefix,
              ]);
        const refs = new Set([
          ...group.map((row) => row.ref),
          ...listed.split("\n").filter((ref) => ref !== ""),
        ]);
        yield* run(gitCommonDir, [`--git-dir=${gitCommonDir}`, "update-ref", "--stdin"], {
          stdin: [...refs].map((ref) => `delete ${ref}\n`).join(""),
        }).pipe(Effect.retry(GIT_LOCK_RETRY));
      }
      for (const row of group)
        yield* sql`DELETE FROM loom_review_snapshots
          WHERE message_id = ${row.messageId} AND source_id = ${row.sourceId}`;
    }
  });

  const applyCap = (threadId: ThreadId, sourceId: string) =>
    selectRows(sql.and([sql`thread_id = ${threadId}`, sql`source_id = ${sourceId}`])).pipe(
      Effect.flatMap((rows) => deleteSnapshots(rows.slice(SNAPSHOTS_PER_SOURCE), null)),
    );

  const captureForMessage: ReviewSnapshotService["Service"]["captureForMessage"] = Effect.fn(
    "ReviewSnapshotService.captureForMessage",
  )(
    function* (input) {
      const worktree = yield* resolveWorktree(input.threadId);
      if (worktree === null) return;
      yield* worktreeLocks.withLock(
        worktree,
        Effect.gen(function* () {
          // Captured already (a re-emission, or a release after an immediate capture).
          if ((yield* selectRows(sql.and([sql`message_id = ${input.messageId}`]))).length > 0)
            return;
          for (const source of yield* enumerateReviewSources(worktree)) {
            const ref = reviewSnapshotRef(input.threadId, source.id, input.messageId);
            const gitCommonDir = yield* commonDirOf(source.root).pipe(
              Effect.orElseSucceed(() => ""),
            );
            const [elapsed, captured] = yield* captureSource(source, ref).pipe(
              Effect.exit,
              Effect.timed,
            );
            const [previous] = yield* selectRows(
              sql.and([
                sql`thread_id = ${input.threadId}`,
                sql`source_id = ${source.id}`,
                sql`status = 'ready'`,
              ]),
            );
            const snapshot = Exit.isSuccess(captured) ? captured.value : null;
            const closesFilesChanged =
              snapshot === null || previous?.commitOid == null
                ? null
                : yield* countChanged(source, previous.commitOid, snapshot.commitOid).pipe(
                    Effect.orElseSucceed(() => null),
                  );
            yield* sql`INSERT INTO loom_review_snapshots ${sql.insert({
              message_id: input.messageId,
              source_id: source.id,
              thread_id: input.threadId,
              message_created_at: DateTime.formatIso(input.messageCreatedAt),
              captured_at: DateTime.formatIso(yield* DateTime.now),
              worktree_path: worktree,
              source_kind: source.kind,
              source_root: source.root,
              git_common_dir: gitCommonDir,
              ref,
              commit_oid: snapshot?.commitOid ?? null,
              tree_oid: snapshot?.treeOid ?? null,
              head_oid: snapshot?.headOid ?? null,
              closes_files_changed: closesFilesChanged,
              status: snapshot === null ? "error" : "ready",
              error:
                snapshot === null
                  ? "capture failed"
                  : snapshot.oversized.length > 0
                    ? `skipped over 5 MB: ${snapshot.oversized.join(", ")}`.slice(0, 2_000)
                    : null,
            })} ON CONFLICT (message_id, source_id) DO NOTHING`;
            if (Exit.isFailure(captured))
              yield* Effect.logWarning("loom.review.capture-failed", {
                threadId: input.threadId,
                sourceId: source.id,
                cause: captured.cause,
              });
            else
              yield* Effect.logInfo("loom.review.captured", {
                threadId: input.threadId,
                sourceId: source.id,
                durationMs: Duration.toMillis(elapsed),
                closesFilesChanged,
              });
            yield* applyCap(input.threadId, source.id);
          }
        }),
      );
    },
    (effect, input) =>
      effect.pipe(
        Effect.provideContext(platform),
        Effect.mapError(
          (cause) =>
            new ReviewSnapshotError({ operation: "capture", threadId: input.threadId, cause }),
        ),
        Effect.withSpan("loom.review.captureForMessage"),
      ),
  );

  const liveCaptures = yield* Cache.makeWith<
    ThreadId,
    ReadonlyArray<LiveReviewSnapshot>,
    ReviewSnapshotError
  >(
    (threadId) =>
      Effect.gen(function* () {
        const worktree = yield* resolveWorktree(threadId);
        if (worktree === null) return [];
        const captured = new Set(
          messagesOf(yield* selectRows(sql.and([sql`thread_id = ${threadId}`])))[0]?.ready.map(
            (row) => row.sourceId,
          ),
        );
        return yield* worktreeLocks.withLock(
          worktree,
          Effect.gen(function* () {
            const live: Array<LiveReviewSnapshot> = [];
            for (const source of yield* enumerateReviewSources(worktree)) {
              if (!captured.has(source.id)) continue;
              const ref = reviewLiveRef(threadId, source.id);
              live.push({ source, ref, commitOid: (yield* captureSource(source, ref)).commitOid });
            }
            return live;
          }),
        );
      }).pipe(
        Effect.provideContext(platform),
        Effect.mapError((cause) => new ReviewSnapshotError({ operation: "live", threadId, cause })),
      ),
    {
      capacity: 256,
      // Nothing captured (no snapshot yet) is not reused: the first message may land any moment.
      timeToLive: Exit.match({
        onSuccess: (live) => (live.length > 0 ? LIVE_COALESCE : Duration.zero),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const listForThread: ReviewSnapshotService["Service"]["listForThread"] = (threadId) =>
    selectRows(sql.and([sql`thread_id = ${threadId}`])).pipe(
      Effect.mapError((cause) => new ReviewSnapshotError({ operation: "list", threadId, cause })),
    );

  const deleteForThread: ReviewSnapshotService["Service"]["deleteForThread"] = (threadId) =>
    selectRows(sql.and([sql`thread_id = ${threadId}`])).pipe(
      Effect.flatMap((rows) => deleteSnapshots(rows, reviewThreadRefPrefix(threadId))),
      Effect.tap(() => Cache.invalidate(liveCaptures, threadId)),
      Effect.provideContext(platform),
      Effect.mapError((cause) => new ReviewSnapshotError({ operation: "delete", threadId, cause })),
    );

  const sweepQuiet: ReviewSnapshotService["Service"]["sweepQuiet"] = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const threadIds = yield* sql<{ readonly threadId: ThreadId }>`
      SELECT DISTINCT thread_id AS "threadId" FROM loom_review_snapshots`.pipe(
      Effect.mapError(
        (cause) => new ReviewSnapshotError({ operation: "sweep", threadId: "*", cause }),
      ),
    );
    for (const { threadId } of threadIds) {
      const shell = yield* orchestrator
        .getThreadShell(threadId)
        .pipe(
          Effect.mapError(
            (cause) => new ReviewSnapshotError({ operation: "sweep", threadId, cause }),
          ),
        );
      if (
        shell === null ||
        shell.archivedAt !== null ||
        storageCleanupActivityAt(shell) < now - QUIET_DAYS * Duration.toMillis(Duration.days(1))
      )
        yield* deleteForThread(threadId).pipe(
          Effect.catch((error) => Effect.logWarning("loom.review.sweep-failed", { error })),
        );
    }
  });

  const listIntervals: ReviewSnapshotService["Service"]["listIntervals"] = Effect.fn(
    "ReviewSnapshotService.listIntervals",
  )(
    function* (threadId) {
      const messages = messagesOf(yield* selectRows(sql.and([sql`thread_id = ${threadId}`])));
      const [latest] = messages;
      if (latest === undefined) return { intervals: [], sources: [] };
      const { messages: records } = yield* orchestrator.getThreadRecords(threadId, ["messages"], {
        messageIds: messages.map((message) => MessageId.make(message.messageId)),
      });
      const textOf = new Map(records.map((record) => [record.id as string, record.text]));
      const from = (message: (typeof messages)[number]) => ({
        messageId: MessageId.make(message.messageId),
        at: message.at,
        ...describeMessage(textOf.get(message.messageId) ?? ""),
      });
      const counts = (message: (typeof messages)[number]) => {
        const changed: { -readonly [K in keyof LoomReviewChangeCounts]: number } = {
          repo: 0,
          nested_repo: 0,
          artifact_path: 0,
        };
        for (const row of message.ready) changed[row.sourceKind] += row.closesFilesChanged ?? 0;
        return changed;
      };
      return {
        intervals: [
          { id: "live", from: from(latest), to: null, changedBySource: null },
          ...messages.slice(0, -1).map((closing, index) => ({
            id: closing.messageId,
            from: from(messages[index + 1]!),
            to: { messageId: MessageId.make(closing.messageId), at: closing.at },
            changedBySource: counts(closing),
          })),
        ],
        sources: latest.ready.map(reviewSourceOf),
      };
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.mapError(
          (cause) => new ReviewSnapshotError({ operation: "intervals", threadId, cause }),
        ),
      ),
  );

  const diffSource = Effect.fn("loom.review.diffSource")(function* (
    row: ReviewSnapshotRow & { readonly commitOid: string },
    toCommit: string,
    input: Pick<LoomReviewDiffInput, "ignoreWhitespace" | "file">,
    /** Nested repos shown as their own sources: their gitlinks leave the repo's patch. */
    nestedPaths: ReadonlyArray<string>,
  ) {
    const source = reviewSourceOf(row);
    const literal = (file: string) => `:(top,literal)${file}`;
    const pathspecs = input.file
      ? [input.file.path, ...(input.file.previousPath ? [input.file.previousPath] : [])].map(
          (file) => literal(file.slice(source.prefix.length)),
        )
      : row.sourceKind === "repo"
        ? nestedPaths.map((nested) => `:(top,exclude,literal)${nested}`)
        : [];
    const args = [
      "diff",
      "--find-renames",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--minimal",
      `--src-prefix=a/${source.prefix}`,
      `--dst-prefix=b/${source.prefix}`,
      ...(input.ignoreWhitespace ? ["--ignore-all-space"] : []),
      row.commitOid,
      toCommit,
    ];
    const files = parseTurnDiffFilesFromNumstat(
      yield* run(row.sourceRoot, [...args, "--numstat", "-z", "--", ...pathspecs]),
    );
    const authored =
      row.sourceKind === "artifact_path"
        ? null
        : yield* checkpoints
            .listAuthoredPaths({
              cwd: row.sourceRoot,
              fromCheckpointRef: CheckpointRef.make(row.commitOid),
              toCheckpointRef: CheckpointRef.make(toCommit),
            })
            .pipe(Effect.orElseSucceed(() => null));
    const retained = files.filter((file) => !isGitImport(file, authored));
    // Retained paths are selected before the patch, so imported bulk cannot exhaust its limit.
    const patch =
      retained.length === 0
        ? { stdout: "", stdoutTruncated: false }
        : yield* git.execute({
            operation: "loom.review.diff",
            cwd: row.sourceRoot,
            args: [
              ...args,
              "--patch",
              "--",
              ...(retained.length === files.length
                ? pathspecs
                : retained
                    .flatMap((file) => [
                      file.path,
                      ...(file.previousPath ? [file.previousPath] : []),
                    ])
                    .map(literal)),
            ],
            maxOutputBytes: input.file ? FILE_MAX_BYTES : PATCH_MAX_BYTES,
            appendTruncationMarker: true,
          });
    const sizes =
      retained.length === 0
        ? []
        : (yield* run(row.sourceRoot, ["cat-file", "--batch-check=%(objectsize)"], {
            stdin: retained
              .flatMap((file) => [
                `${row.commitOid}:${file.previousPath ?? file.path}`,
                `${toCommit}:${file.path}`,
              ])
              .map((line) => `${line}\n`)
              .join(""),
          }))
            .split("\n")
            .map((line) => (/^\d+$/.test(line) ? Number(line) : null));
    return {
      ...source,
      fromCommit: row.commitOid,
      toCommit,
      diff: patch.stdout,
      diffHash: [row.commitOid, toCommit, input.ignoreWhitespace, input.file?.path ?? ""].join(":"),
      truncated: patch.stdoutTruncated,
      files: retained.map((file, index) => {
        const oldBytes = sizes[index * 2] ?? null;
        const newBytes = sizes[index * 2 + 1] ?? null;
        return {
          path: `${source.prefix}${file.path}`,
          previousPath: file.previousPath ? `${source.prefix}${file.previousPath}` : null,
          additions: file.additions,
          deletions: file.deletions,
          status: file.previousPath
            ? "renamed"
            : oldBytes === null
              ? "added"
              : newBytes === null
                ? "deleted"
                : "modified",
          oldBytes,
          newBytes,
        } as const;
      }),
    };
  });

  const diff: ReviewSnapshotService["Service"]["diff"] = Effect.fn("ReviewSnapshotService.diff")(
    function* (input) {
      const messages = messagesOf(yield* selectRows(sql.and([sql`thread_id = ${input.threadId}`])));
      const closing = messages.findIndex((message) => message.messageId === input.intervalId);
      const [fromRows, toCommits] =
        input.intervalId === "live"
          ? [
              messages[0]?.ready ?? [],
              new Map(
                (yield* Cache.get(liveCaptures, input.threadId)).map(
                  (live) => [live.source.id, live.commitOid] as const,
                ),
              ),
            ]
          : closing >= 0 && closing < messages.length - 1
            ? [
                messages[closing + 1]!.ready,
                new Map(messages[closing]!.ready.map((row) => [row.sourceId, row.commitOid])),
              ]
            : yield* Effect.fail(`No interval ${input.intervalId} on this thread.`);
      const kinds = new Set(input.sourceKinds);
      const shown = fromRows.filter(
        (row) => kinds.has(row.sourceKind) && toCommits.has(row.sourceId),
      );
      const nestedPaths = shown.flatMap((row) =>
        row.sourceKind === "nested_repo" ? [reviewSourceOf(row).prefix.slice(0, -1)] : [],
      );
      // A one-file request goes to the source that owns the path: the deepest nested repo, an
      // artefact folder, or the repo.
      const owner = (file: string) =>
        shown
          .map((row) => ({ row, root: row.sourceKind === "repo" ? "" : reviewSourceOf(row).title }))
          .filter(({ root }) => file.startsWith(root))
          .toSorted((left, right) => right.root.length - left.root.length)[0]?.row;
      const selected = input.file ? shown.filter((row) => row === owner(input.file!.path)) : shown;
      return {
        generatedAt: yield* DateTime.now,
        sources: yield* Effect.forEach(
          selected,
          (row) => diffSource(row, toCommits.get(row.sourceId)!, input, nestedPaths),
          { concurrency: 4 },
        ),
      };
    },
    (effect, input) =>
      effect.pipe(
        Effect.provideContext(platform),
        Effect.mapError(
          (cause) =>
            new ReviewSnapshotError({ operation: "diff", threadId: input.threadId, cause }),
        ),
      ),
  );

  const fileContents: ReviewSnapshotService["Service"]["fileContents"] = Effect.fn(
    "ReviewSnapshotService.fileContents",
  )(
    function* (input) {
      if (!OBJECT_ID.test(input.fromCommit) || !OBJECT_ID.test(input.toCommit))
        return yield* Effect.fail("Not a snapshot commit.");
      const [row] = yield* selectRows(
        sql.and([sql`thread_id = ${input.threadId}`, sql`source_id = ${input.sourceId}`]),
      );
      if (row === undefined) return yield* Effect.fail(`No source ${input.sourceId}.`);
      const { prefix } = reviewSourceOf(row);
      const read = (commit: string, file: string) =>
        file.startsWith(prefix)
          ? git
              .execute({
                operation: "loom.review.fileContents",
                cwd: row.sourceRoot,
                args: ["show", "--end-of-options", `${commit}:${file.slice(prefix.length)}`],
                maxOutputBytes: FILE_MAX_BYTES,
                appendTruncationMarker: true,
              })
              .pipe(
                Effect.flatMap((result) =>
                  result.stdoutTruncated
                    ? Effect.fail(`'${file}' exceeds the 1 MB expansion limit.`)
                    : result.stdout.includes("\0")
                      ? Effect.fail(`Cannot expand binary file '${file}'.`)
                      : Effect.succeed(result.stdout),
                ),
              )
          : Effect.fail(`'${file}' is not in ${input.sourceId}.`);
      const [oldContents, newContents] = yield* Effect.all(
        [
          input.changeType === "new" ? Effect.succeed("") : read(input.fromCommit, input.oldPath),
          input.changeType === "deleted" ? Effect.succeed("") : read(input.toCommit, input.newPath),
        ],
        { concurrency: 2 },
      );
      return { oldContents, newContents };
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ReviewSnapshotError({ operation: "fileContents", threadId: input.threadId, cause }),
        ),
      ),
  );

  return ReviewSnapshotService.of({
    captureForMessage,
    captureLive: (threadId) => Cache.get(liveCaptures, threadId),
    listForThread,
    deleteForThread,
    sweepQuiet,
    listIntervals,
    diff,
    fileContents,
  });
});

export const layer = Layer.effect(ReviewSnapshotService, make);
