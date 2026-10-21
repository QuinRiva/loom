// @effect-diagnostics nodeBuiltinImport:off
/**
 * Query threads (plans/plan-query-threads/plan.mdx §2): the MDX viewer's Query asks about a
 * passage in a read-only, visible fork of the document's author (the viewing thread). One
 * query thread serves one revision (the file's content hash) of one document: a question on
 * that revision lands in the live thread as a new human turn; a question after a rewrite
 * supersedes it (outcome done, archived) and forks afresh.
 *
 * The fork is the `/handoff` drafter's (`launchDraftFork`): spawn, `thread.fork.prepare`, then
 * ONE human message carrying the overlay and the first question, so the question is the
 * thread's first turn (a separate kickoff turn drew a reply of its own). A mid-turn author
 * defers the fork; the spawn's `kickoffBriefPath` brief carries the first question so
 * `HandoffDrafterReactor` can send the fork and that message once the author's run ends.
 *
 * @module loom/query/documentQuery
 */
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DOCUMENT_QUERY_ROLE,
  DocumentQueryInput,
  type DocumentQueryPromoteInput,
  LOOM_WS_METHODS,
  type LoomThreadWorkstream,
  LoomWsMethodError,
  MessageId,
  type OrchestrationV2ServerCommand,
  type ReviewCommentContextRecord,
  ThreadId,
} from "@t3tools/contracts";
import {
  documentQueryPromoteId,
  documentQueryQuestionId as questionId,
  joinDocumentQueryKickoff,
} from "@t3tools/shared/documentQuery.loom";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { ProjectStoreV2 } from "../../orchestration-v2/ProjectStore.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import {
  buildDraftSpawn,
  curatedTitle,
  forkPrepareCommand,
  launchDraftFork,
} from "../handoff/handoffDraft.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { writeWorkstreamBrief } from "../workstream/brief.ts";
import { buildDocumentQueryOverlay } from "./documentQueryOverlay.ts";

const method = LOOM_WS_METHODS.documentQuery;
const fail = (message: string) => new LoomWsMethodError({ method, message });

/** The `.mdx` preview's read budget: a plan larger than the default 1 MiB still hashes whole. */
const DOCUMENT_READ_MAX_BYTES = 8 * 1024 * 1024;
const QUOTED_TEXT_MAX = 16_000;

type QueryKey = {
  readonly authorThreadId: ThreadId;
  readonly filePath: string;
  readonly revision: string;
};

const isLiveQueryOn = (row: LoomThreadWorkstream, input: QueryKey) =>
  row.role === DOCUMENT_QUERY_ROLE &&
  row.forkFromThreadId === input.authorThreadId &&
  row.documentQuery?.filePath === input.filePath &&
  row.archivedAt === null &&
  row.deletedAt === null &&
  row.outcome === null;

/** The live query thread to reuse for (author, file, revision), else null: fork afresh. */
export const reusableQueryThread = (
  candidates: ReadonlyArray<LoomThreadWorkstream>,
  input: QueryKey,
) =>
  candidates.find(
    (row) => isLiveQueryOn(row, input) && row.documentQuery?.revision === input.revision,
  ) ?? null;

/** Live query threads on the same document whose revision is stale: superseded by this ask. */
export const supersededQueryThreads = (
  candidates: ReadonlyArray<LoomThreadWorkstream>,
  input: QueryKey,
) =>
  candidates.filter(
    (row) => isLiveQueryOn(row, input) && row.documentQuery?.revision !== input.revision,
  );

/** SHA-256 of the document as the server reads it now, 12 hex characters. */
export const hashDocumentRevision = (input: { readonly cwd: string; readonly filePath: string }) =>
  Effect.flatMap(WorkspaceFileSystem, (workspace) =>
    workspace.readFile({
      cwd: input.cwd,
      relativePath: input.filePath,
      maxBytes: DOCUMENT_READ_MAX_BYTES,
    }),
  ).pipe(
    Effect.map((file) =>
      NodeCrypto.createHash("sha256").update(file.contents).digest("hex").slice(0, 12),
    ),
  );

/** What a question needs beyond the thread: the RPC input minus the author. */
export type DocumentQueryQuestionInput = Omit<DocumentQueryInput, "sourceThreadId">;

/**
 * The question as the human's own message: one `review-comment` record carrying the passage
 * (`mdxAnchor`), referenced inline ahead of the question text, as the composer's
 * `buildMessageContext` builds an annotation. The record's comment text is empty: the question
 * is the message body, so the agent reads it once. The first question carries the overlay ahead
 * of it (`joinDocumentQueryKickoff`).
 */
export const buildQuestionDispatch = (input: {
  readonly threadId: ThreadId;
  readonly n: number;
  readonly question: DocumentQueryQuestionInput;
  readonly overlay?: string;
}) => {
  const { question } = input;
  const id = questionId(input.threadId, input.n);
  const contextId = toKindScopedComposerContextId("review-comment", id);
  const label = sanitizeComposerContextLabel(
    `${question.filePath.split("/").pop()} ${question.rangeLabel}`,
    "review-comment",
  );
  const record: ReviewCommentContextRecord = {
    version: 1,
    contextId,
    kind: "review-comment",
    label,
    sectionId: question.sectionId.trim() || "document",
    sectionTitle: question.sectionTitle,
    filePath: question.filePath,
    startIndex: 0,
    endIndex: 0,
    rangeLabel: question.rangeLabel,
    text: "",
    diff: "",
    mdxAnchor: {
      anchor: question.anchor,
      quotedText: question.quotedText.slice(0, QUOTED_TEXT_MAX),
    },
  };
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId: input.threadId,
    messageId: MessageId.make(`message:${id}`),
    text: ((text) =>
      input.overlay === undefined ? text : joinDocumentQueryKickoff(input.overlay, text))(
      `${formatComposerContextReference({ kind: "review-comment", contextId, label })} ${question.question}`,
    ),
    context: { version: 1, records: [record] },
    attachments: [],
    // The human typed it (the Query card); the server sequences it behind the fork.
    createdBy: "user",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
  } satisfies OrchestrationV2ServerCommand;
};

const BRIEF_MARKER = "loom:document-query-question";
const QuestionJson = Schema.fromJsonString(DocumentQueryInput);
const encodeQuestion = Schema.encodeSync(QuestionJson);
const decodeQuestion = Schema.decodeUnknownOption(QuestionJson);

/**
 * The spawn's brief: the overlay, the first question as the human reads it, and that question
 * machine-readable in a trailing comment (`>` escaped so the JSON never closes it), which the
 * reactor's deferred leg decodes.
 */
export const buildDocumentQueryBrief = (overlay: string, input: DocumentQueryInput) =>
  `${overlay}\n\n---\n\nFirst question, on \`${input.filePath}\` (${input.sectionTitle}):\n\n${input.question}\n\n<!-- ${BRIEF_MARKER} ${encodeQuestion(input).replace(/>/g, "\\u003e")} -->\n`;

/** The first question a brief carries, or none. */
export const parseDocumentQueryBrief = (brief: string) =>
  Option.flatMap(
    Option.fromNullishOr(new RegExp(`<!-- ${BRIEF_MARKER} (.*) -->\\s*$`, "s").exec(brief)?.[1]),
    decodeQuestion,
  );

/** The fork transfer from the author, then the overlay and first question as one message. */
export const buildQueryForkLaunch = (input: {
  readonly threadId: ThreadId;
  readonly authorThreadId: ThreadId;
  readonly question: DocumentQueryInput;
  readonly createdAt: string;
}) =>
  [
    forkPrepareCommand({
      drafterThreadId: input.threadId,
      sourceThreadId: input.authorThreadId,
      createdAt: input.createdAt,
    }),
    buildQuestionDispatch({
      threadId: input.threadId,
      n: 1,
      question: input.question,
      overlay: buildDocumentQueryOverlay({
        filePath: input.question.filePath,
        authorThreadId: input.authorThreadId,
      }),
    }),
  ] as const;

/**
 * The `launchDraftFork` build: the drafter fork's spawn as a goal-less `document-query` root
 * carrying the brief, then `buildQueryForkLaunch` (no separate kickoff message).
 */
export const buildDocumentQueryCommands = (
  fork: Parameters<Parameters<typeof launchDraftFork>[0]["build"]>[0],
  input: {
    readonly question: DocumentQueryInput;
    readonly revision: string;
    readonly kickoffBriefPath: string;
  },
) => {
  const spawn = buildDraftSpawn({
    ...fork,
    sourceGoalId: null,
    role: DOCUMENT_QUERY_ROLE,
    title: curatedTitle(
      "Query",
      input.question.filePath.split("/").pop() ?? input.question.filePath,
    ),
    purpose: `Query thread on ${input.question.filePath} @ ${input.revision}`,
  });
  return [
    { ...spawn, kickoffBriefPath: input.kickoffBriefPath },
    ...buildQueryForkLaunch({
      threadId: fork.drafterThreadId,
      authorThreadId: fork.source.id,
      question: input.question,
      createdAt: fork.createdAt,
    }),
  ];
};

/**
 * `loom.documentQuery`: hash the document, reuse the live query thread for this revision or
 * fork the author afresh, supersede stale live ones, send the question and record it on the
 * query thread's sidecar. Fails with `LoomWsMethodError`.
 */
export const askDocumentQuery = (input: DocumentQueryInput) =>
  Effect.gen(function* () {
    const orchestrator = yield* OrchestratorV2;
    const store = yield* LoomStoreV2;
    const viewing = yield* orchestrator.getThreadShell(input.sourceThreadId);
    if (viewing === null || viewing.deletedAt != null)
      return yield* fail("The source thread was not found.");
    // Query asked from inside a query thread's panel still forks the author, never the fork.
    const viewingRow = yield* store.getWorkstream(viewing.id);
    const authorThreadId =
      viewingRow?.role === DOCUMENT_QUERY_ROLE && viewingRow.forkFromThreadId !== null
        ? viewingRow.forkFromThreadId
        : viewing.id;
    const author =
      authorThreadId === viewing.id ? viewing : yield* orchestrator.getThreadShell(authorThreadId);
    if (author === null) return yield* fail("The document's author thread was not found.");
    const cwd =
      author.worktreePath ??
      Option.getOrNull(
        Option.map(yield* (yield* ProjectStoreV2).get(author.projectId), (p) => p.workspaceRoot),
      );
    if (cwd === null) return yield* fail("The author thread has no workspace to read from.");
    const revision = yield* hashDocumentRevision({ cwd, filePath: input.filePath }).pipe(
      Effect.mapError(
        (cause) =>
          new LoomWsMethodError({ method, message: `${input.filePath} could not be read.`, cause }),
      ),
    );
    const question = { ...input, sourceThreadId: authorThreadId };
    const key = { authorThreadId, filePath: input.filePath, revision };
    const candidates = yield* store.listActiveWorkstreams();
    const reuse = reusableQueryThread(candidates, key);
    // A thread still waiting on a mid-turn author has no session to take a second question yet.
    if (reuse !== null && reuse.kickoffAt === null)
      return yield* fail(
        "The query thread on this document is still waiting for the author's turn to end; ask again once it has started.",
      );
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const recordAsk = (threadId: ThreadId, n: number) =>
      orchestrator.dispatch({
        type: "thread.document-query.ask",
        commandId: CommandId.make(`${questionId(threadId, n)}:ask`),
        threadId,
        createdAt,
        filePath: input.filePath,
        revision,
        question: {
          messageId: MessageId.make(`message:${questionId(threadId, n)}`),
          askedAt: createdAt,
          anchor: input.anchor,
          quotedText: input.quotedText.slice(0, QUOTED_TEXT_MAX),
          sectionTitle: input.sectionTitle,
        },
      });
    let queryThreadId: ThreadId;
    if (reuse === null) {
      queryThreadId = ThreadId.make(yield* (yield* Crypto.Crypto).randomUUIDv4());
      const kickoffBriefPath = yield* writeWorkstreamBrief(
        queryThreadId,
        buildDocumentQueryBrief(
          buildDocumentQueryOverlay({ filePath: input.filePath, authorThreadId }),
          question,
        ),
      );
      yield* launchDraftFork({
        method,
        verb: "queried",
        sourceThreadId: authorThreadId,
        drafterThreadId: queryThreadId,
        build: (fork) => buildDocumentQueryCommands(fork, { question, revision, kickoffBriefPath }),
      });
      // A thread whose first ask never recorded is never reused (it names no file), so no id clashes.
      yield* recordAsk(queryThreadId, 1);
    } else {
      queryThreadId = reuse.threadId;
      const n = (reuse.documentQuery?.questions.length ?? 0) + 1;
      // Recorded first: `n` counts recorded asks, so a message that landed unrecorded would
      // hand the next question its id, and the receipt would drop that question silently.
      yield* recordAsk(queryThreadId, n);
      yield* orchestrator.dispatch(buildQuestionDispatch({ threadId: queryThreadId, n, question }));
    }
    for (const stale of supersededQueryThreads(candidates, key)) {
      const id = (step: string) =>
        CommandId.make(`server:loom:query-supersede:${stale.threadId}:${step}`);
      yield* orchestrator.dispatch({
        type: "thread.outcome.set",
        commandId: id("done"),
        threadId: stale.threadId,
        createdAt,
        outcome: "done",
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: id("archive"),
        threadId: stale.threadId,
      });
    }
    return { queryThreadId, created: reuse === null, askedAt: createdAt };
  }).pipe(
    Effect.catchIf(
      (error) => error._tag !== "LoomWsMethodError",
      (cause) =>
        Effect.fail(
          new LoomWsMethodError({ method, message: `${method} failed to ask the query.`, cause }),
        ),
    ),
  );

/**
 * `loom.documentQueryPromote`: a human turn on the query thread asking the fork to distil the
 * exchange at `exchangeAt` into one comment with `mcp__t3-code__document_query_promote`. The tool
 * call records the promotion; this only queues the turn. The thread stays open: one review pass
 * may promote several exchanges.
 */
export const promoteDocumentQuery = (input: DocumentQueryPromoteInput) =>
  Effect.gen(function* () {
    const promoteMethod = LOOM_WS_METHODS.documentQueryPromote;
    const row = yield* (yield* LoomStoreV2).getWorkstream(input.queryThreadId);
    if (row?.role !== DOCUMENT_QUERY_ROLE || row.deletedAt !== null)
      return yield* new LoomWsMethodError({
        method: promoteMethod,
        message: "Only a query thread's exchanges can be promoted.",
      });
    if (!row.documentQuery?.questions.some((question) => question.askedAt === input.exchangeAt))
      return yield* new LoomWsMethodError({
        method: promoteMethod,
        message: "That exchange is not a question asked in this query thread.",
      });
    const id = documentQueryPromoteId(
      input.queryThreadId,
      yield* (yield* Crypto.Crypto).randomUUIDv4(),
    );
    yield* (yield* OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId: input.queryThreadId,
      messageId: MessageId.make(`message:${id}`),
      text: `Promote the exchange above (my question at exchangeAt ${input.exchangeAt} and your answer): write one anchored comment for the author with \`mcp__t3-code__document_query_promote\`; nothing else reaches the author.`,
      attachments: [],
      // The human pressed Promote; the server words the turn.
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
    return { dispatched: true as const };
  }).pipe(
    Effect.catchIf(
      (error) => error._tag !== "LoomWsMethodError",
      (cause) =>
        Effect.fail(
          new LoomWsMethodError({
            method: LOOM_WS_METHODS.documentQueryPromote,
            message: "Could not send the promote turn.",
            cause,
          }),
        ),
    ),
  );
