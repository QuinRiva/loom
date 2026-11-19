/**
 * Code query threads (plans/code-query/plan.mdx §4): Query author on the diff's author card asks the
 * thread that committed the selected lines, in a read-only fork of it. The server re-derives the
 * author from the commit (`ReviewAuthorship.commitAuthor`, then `authorOf`); one live query thread
 * per author run, superseded once the author has run again. The author thread is never written.
 */
import {
  COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS,
  CodeQueryInput,
  CommandId,
  DOCUMENT_QUERY_ROLE,
  LOOM_CODE_QUERY_EXCERPT_MAX,
  LOOM_WS_METHODS,
  LoomReviewAuthorshipCommit,
  type LoomThreadWorkstream,
  LoomWsMethodError,
  MessageId,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";
import { documentQueryQuestionId as questionId } from "@t3tools/shared/documentQuery.loom";
import { authorOf } from "@t3tools/shared/reviewAuthorship.loom";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkPrepareCommand, latestForkRun } from "../handoff/handoffDraft.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { ReviewAuthorship } from "../review/ReviewAuthorship.ts";
import { buildCodeQueryOverlay, buildCodeQueryQuestion } from "./codeQueryOverlay.ts";
import {
  buildQueryBrief,
  buildQuestionDispatch,
  isLiveQueryOf,
  launchQueryFork,
  queryBriefJson,
  supersedeQueryThreads,
} from "./queryThread.ts";

const method = LOOM_WS_METHODS.codeQuery;
const fail = (message: string) => new LoomWsMethodError({ method, message });

/** A commit as the question's sentence names it (`CodeQueryCommit`). */
const NamedCommit = LoomReviewAuthorshipCommit.mapFields(
  Struct.pick(["sha", "subject", "threadIds"]),
);

/**
 * A question as the server sends it: the human's input and the commits its sentence names, as
 * `buildCodeQueryQuestion` takes them. A `file` question names the lines' writers in full.
 */
export const CodeQueryLaunch = Schema.Union([
  Schema.Struct({
    question: CodeQueryInput,
    commitChanged: Schema.optionalKey(Schema.Literal("lines")),
    commit: NamedCommit,
    owners: Schema.Array(NamedCommit),
  }),
  Schema.Struct({
    question: CodeQueryInput,
    commitChanged: Schema.Literal("file"),
    commit: NamedCommit,
    owners: Schema.Array(LoomReviewAuthorshipCommit),
  }),
]);
export type CodeQueryLaunch = typeof CodeQueryLaunch.Type;

/** The `n`th question: the lines' hunk as a line comment, then the sentence naming its commits. */
const buildCodeQuestionDispatch = (input: {
  readonly threadId: ThreadId;
  readonly n: number;
  readonly launch: CodeQueryLaunch;
  readonly overlay?: string;
}) => {
  const { question } = input.launch;
  return buildQuestionDispatch({
    threadId: input.threadId,
    n: input.n,
    record: {
      sectionId: question.sectionId,
      sectionTitle: question.sectionTitle,
      filePath: question.filePath,
      startIndex: question.startIndex,
      endIndex: question.endIndex,
      rangeLabel: question.rangeLabel,
      text: "",
      diff: question.diff.slice(0, COMPOSER_CONTEXT_REVIEW_DIFF_MAX_CHARS),
      fenceLanguage: "diff",
    },
    text: (reference) =>
      buildCodeQueryQuestion({ ...input.launch, reference, question: question.question }),
    ...(input.overlay === undefined ? {} : { overlay: input.overlay }),
  });
};

/** The fork transfer from the author, then the overlay and first question as one message. */
export const buildCodeQueryForkLaunch = (input: {
  readonly threadId: ThreadId;
  readonly authorThreadId: ThreadId;
  readonly launch: CodeQueryLaunch;
  readonly createdAt: string;
}) =>
  [
    forkPrepareCommand({
      drafterThreadId: input.threadId,
      sourceThreadId: input.authorThreadId,
      createdAt: input.createdAt,
    }),
    buildCodeQuestionDispatch({
      threadId: input.threadId,
      n: 1,
      launch: input.launch,
      overlay: buildCodeQueryOverlay({ authorThreadId: input.authorThreadId }),
    }),
  ] as const;

const BRIEF_MARKER = "loom:code-query-question";
const LaunchJson = Schema.fromJsonString(CodeQueryLaunch);
const encodeLaunch = Schema.encodeSync(LaunchJson);
const decodeLaunch = Schema.decodeUnknownOption(LaunchJson);

const buildCodeQueryBrief = (overlay: string, launch: CodeQueryLaunch) =>
  buildQueryBrief({
    marker: BRIEF_MARKER,
    overlay,
    firstQuestion: `First question, on \`${launch.question.filePath}\` (${launch.question.rangeLabel}):\n\n${launch.question.question}`,
    json: encodeLaunch(launch),
  });

/** The first question a code query's brief carries, or none. */
export const parseCodeQueryBrief = (brief: string) =>
  Option.flatMap(queryBriefJson(BRIEF_MARKER, brief), decodeLaunch);

/** The author's live code query threads: the one forked at `runId` to reuse, and the rest. */
const liveCodeQueries = (
  candidates: ReadonlyArray<LoomThreadWorkstream>,
  authorThreadId: ThreadId,
  runId: RunId | null,
) => {
  const live = candidates.filter(
    (row) => isLiveQueryOf(row, authorThreadId) && row.codeQuery !== null,
  );
  const reuse = live.find((row) => row.codeQuery?.forkedAtRunId === runId) ?? null;
  return { reuse, stale: live.filter((row) => row !== reuse) };
};

const short = (sha: string) => sha.slice(0, 12);

/**
 * `loom.codeQuery`: confirm the commit is on the branch and names one held thread, reuse or fork
 * that author's query thread, supersede older ones, send and record the question. No `ownerShas`:
 * lines the branch left unchanged, whose file the commit must have changed and whose writers are
 * read here from an unbounded blame, never taken from the client.
 */
export const askCodeQuery = Effect.fn("codeQuery.askCodeQuery")(
  function* (input: CodeQueryInput) {
    const orchestrator = yield* OrchestratorV2;
    const store = yield* LoomStoreV2;
    const authorship = yield* ReviewAuthorship;
    const unchanged = input.ownerShas.length === 0;
    const writers = unchanged
      ? (yield* authorship.lineBlame({
          threadId: input.reviewThreadId,
          path: input.filePath,
          startLine: input.startLine,
          endLine: input.endLine,
        })).commits
      : [];
    const { commit, owners, threads, changedFile } = yield* authorship.commitAuthor({
      threadId: input.reviewThreadId,
      baseRef: input.baseRef,
      commitSha: input.commitSha,
      ownerShas: unchanged ? writers.map((writer) => writer.sha) : input.ownerShas,
      filePath: input.filePath,
    });
    if (commit === null)
      return yield* fail(
        `Commit ${short(input.commitSha)} is not on this branch's diff; reopen the diff and select the lines again.`,
      );
    const resolvedOwners = owners.filter((owner) => owner !== null);
    // Changed lines' owners are all on the branch; unchanged lines' writers all predate it.
    if (unchanged ? resolvedOwners.length > 0 : resolvedOwners.length !== owners.length)
      return yield* fail(
        "The branch has changed since these lines' authors were drawn; reopen the diff and select the lines again.",
      );
    const author = authorOf(commit, threads);
    if (author.kind !== "thread")
      return yield* fail(
        author.kind === "threads"
          ? `Commit ${short(commit.sha)} names ${author.threadIds.length} threads (one amended the other's commit), so there is no single author to ask.`
          : commit.threadIds.length === 0
            ? `Commit ${short(commit.sha)} carries no Loom-Thread trailer (git author ${commit.gitAuthor}), so no thread can be asked.`
            : `Commit ${short(commit.sha)} names thread ${commit.threadIds[0]}, which this server does not hold.`,
      );
    if (unchanged && !changedFile)
      return yield* fail(
        `Commit ${short(commit.sha)} did not change ${input.filePath} on this branch, so its thread is not one to ask about these lines.`,
      );
    const authorThreadId = author.thread.threadId;
    const forkedAtRunId =
      latestForkRun((yield* orchestrator.getThreadRecords(authorThreadId, ["runs"])).runs)?.id ??
      null;
    const { reuse, stale } = liveCodeQueries(
      yield* store.listActiveWorkstreams({ roles: [DOCUMENT_QUERY_ROLE] }),
      authorThreadId,
      forkedAtRunId,
    );
    // A thread still waiting on a mid-turn author has no session to take a second question yet.
    if (reuse !== null && reuse.kickoffAt === null)
      return yield* fail(
        "The query thread on this author is still waiting for the author's turn to end; ask again once it has started.",
      );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    // An unchanged line its own thread wrote before the branch is the thread's: named as its own.
    const own = writers.find(
      (writer) => writer.threadIds.length === 1 && writer.threadIds[0] === authorThreadId,
    );
    const launch: CodeQueryLaunch = !unchanged
      ? { question: input, commit, owners: resolvedOwners }
      : own === undefined
        ? { question: input, commitChanged: "file", commit, owners: writers }
        : { question: input, commit: own, owners: writers };
    const recordAsk = (threadId: ThreadId, n: number) =>
      orchestrator.dispatch({
        type: "thread.code-query.ask",
        commandId: CommandId.make(`${questionId(threadId, n)}:ask`),
        threadId,
        createdAt,
        forkedAtRunId,
        question: {
          messageId: MessageId.make(`message:${questionId(threadId, n)}`),
          askedAt: createdAt,
          commitSha: input.commitSha,
          ownerShas: input.ownerShas,
          commitChanged: unchanged ? "file" : "lines",
          writerShas: writers.map((writer) => writer.sha),
          filePath: input.filePath,
          startLine: input.startLine,
          endLine: input.endLine,
          selection: input.selection,
          startIndex: input.startIndex,
          endIndex: input.endIndex,
          rangeLabel: input.rangeLabel,
          sectionId: input.sectionId,
          sectionTitle: input.sectionTitle,
          excerpt: input.diff.slice(0, LOOM_CODE_QUERY_EXCERPT_MAX),
        },
      });
    const queryThreadId =
      reuse?.threadId ?? ThreadId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4());
    if (reuse === null) {
      yield* launchQueryFork({
        method,
        authorThreadId,
        queryThreadId,
        subject: author.thread.title,
        purpose: `Code query thread on ${author.thread.title} @ ${forkedAtRunId ?? "its import"}`,
        brief: buildCodeQueryBrief(buildCodeQueryOverlay({ authorThreadId }), launch),
        launch: (forkedAt) =>
          buildCodeQueryForkLaunch({
            threadId: queryThreadId,
            authorThreadId,
            launch,
            createdAt: forkedAt,
          }),
      });
      // A thread whose first ask never recorded is never reused (it has no subject), so no id clashes.
      yield* recordAsk(queryThreadId, 1);
    } else {
      const n = (reuse.codeQuery?.questions.length ?? 0) + 1;
      // Recorded first, as for a document: `n` counts recorded asks.
      yield* recordAsk(queryThreadId, n);
      yield* orchestrator.dispatch(
        buildCodeQuestionDispatch({ threadId: queryThreadId, n, launch }),
      );
    }
    yield* supersedeQueryThreads(stale, createdAt);
    return { queryThreadId, created: reuse === null, askedAt: createdAt, authorThreadId };
  },
  Effect.catchIf(
    (error) => error._tag !== "LoomWsMethodError",
    (cause) =>
      Effect.fail(
        new LoomWsMethodError({ method, message: `${method} failed to ask the query.`, cause }),
      ),
  ),
);
