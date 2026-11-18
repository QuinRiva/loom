// @effect-diagnostics nodeBuiltinImport:off
/**
 * Query threads (plan-query-threads §2): a read-only, visible fork of the document's author per
 * revision; a question after a rewrite supersedes it and forks afresh. The fork is
 * `launchDraftFork`'s, its first turn ONE message (overlay then question); a mid-turn author
 * defers it, and `HandoffDrafterReactor` sends both from the spawn's brief when the run ends.
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
  ThreadId,
} from "@t3tools/contracts";
import {
  documentQueryPromoteId,
  documentQueryQuestionId as questionId,
} from "@t3tools/shared/documentQuery.loom";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { forkPrepareCommand } from "../handoff/handoffDraft.ts";
import { LoomStoreV2 } from "../projection/LoomStore.ts";
import { resolveDocumentAuthor } from "./documentAuthor.ts";
import { buildDocumentQueryOverlay, buildQueryPromoteTurn } from "./documentQueryOverlay.ts";
import {
  buildQueryBrief,
  buildQuestionDispatch,
  isLiveQueryOf,
  launchQueryFork,
  queryBriefJson,
  supersedeQueryThreads,
} from "./queryThread.ts";

const method = LOOM_WS_METHODS.documentQuery;
const fail = (message: string) => new LoomWsMethodError({ method, message });

const QUOTED_TEXT_MAX = 16_000;

type QueryKey = {
  readonly authorThreadId: ThreadId;
  readonly filePath: string;
  readonly revision: string;
};

const isLiveQueryOn = (row: LoomThreadWorkstream, input: QueryKey) =>
  isLiveQueryOf(row, input.authorThreadId) && row.documentQuery?.filePath === input.filePath;

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

/** What a question needs beyond the thread: the RPC input minus the author. */
export type DocumentQueryQuestionInput = Omit<DocumentQueryInput, "sourceThreadId">;

/**
 * The question as the human's own message: its record carries the passage (`mdxAnchor`) with empty
 * comment text, and the question follows the record's chip.
 */
const buildDocumentQuestionDispatch = (input: {
  readonly threadId: ThreadId;
  readonly n: number;
  readonly question: DocumentQueryQuestionInput;
  readonly overlay?: string;
}) => {
  const { question } = input;
  return buildQuestionDispatch({
    threadId: input.threadId,
    n: input.n,
    record: {
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
    },
    text: (reference) => `${reference} ${question.question}`,
    ...(input.overlay === undefined ? {} : { overlay: input.overlay }),
  });
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
  buildQueryBrief({
    marker: BRIEF_MARKER,
    overlay,
    firstQuestion: `First question, on \`${input.filePath}\` (${input.sectionTitle}):\n\n${input.question}`,
    json: encodeQuestion(input),
  });

/** The first question a brief carries, or none. */
export const parseDocumentQueryBrief = (brief: string) =>
  Option.flatMap(queryBriefJson(BRIEF_MARKER, brief), decodeQuestion);

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
    buildDocumentQuestionDispatch({
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
 * `loom.documentQuery`: resolve the author (`resolveDocumentAuthor`), hash the document, reuse
 * the live query thread for this (author, file, revision) or
 * fork the author afresh, supersede stale live ones, send the question and record it on the
 * query thread's sidecar. Fails with `LoomWsMethodError`.
 */
export const askDocumentQuery = Effect.fn("documentQuery.askDocumentQuery")(
  function* (input: DocumentQueryInput) {
    const orchestrator = yield* OrchestratorV2;
    const store = yield* LoomStoreV2;
    const { author, authorSource, contents, filePath } = yield* resolveDocumentAuthor({
      method,
      ...input,
    });
    const authorThreadId = author.id;
    const revision = NodeCrypto.createHash("sha256").update(contents).digest("hex").slice(0, 12);
    const question = { ...input, filePath, sourceThreadId: authorThreadId };
    const key = { authorThreadId, filePath, revision };
    const candidates = yield* store.listActiveWorkstreams({ roles: [DOCUMENT_QUERY_ROLE] });
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
        filePath,
        revision,
        authorSource,
        question: {
          messageId: MessageId.make(`message:${questionId(threadId, n)}`),
          askedAt: createdAt,
          anchor: input.anchor,
          quotedText: input.quotedText.slice(0, QUOTED_TEXT_MAX),
          sectionTitle: input.sectionTitle,
        },
      });
    const queryThreadId =
      reuse?.threadId ?? ThreadId.make(yield* (yield* SecureRandom.SecureRandom).uuidV4());
    if (reuse === null) {
      yield* launchQueryFork({
        method,
        authorThreadId,
        queryThreadId,
        subject: filePath.split("/").pop() ?? filePath,
        purpose: `Query thread on ${filePath} @ ${revision}`,
        brief: buildDocumentQueryBrief(
          buildDocumentQueryOverlay({ filePath, authorThreadId }),
          question,
        ),
        launch: (forkedAt) =>
          buildQueryForkLaunch({
            threadId: queryThreadId,
            authorThreadId,
            question,
            createdAt: forkedAt,
          }),
      });
      // A thread whose first ask never recorded is never reused (it names no file), so no id clashes.
      yield* recordAsk(queryThreadId, 1);
    } else {
      const n = (reuse.documentQuery?.questions.length ?? 0) + 1;
      // Recorded first: `n` counts recorded asks, so a message that landed unrecorded would
      // hand the next question its id, and the receipt would drop that question silently.
      yield* recordAsk(queryThreadId, n);
      yield* orchestrator.dispatch(
        buildDocumentQuestionDispatch({ threadId: queryThreadId, n, question }),
      );
    }
    yield* supersedeQueryThreads(supersededQueryThreads(candidates, key), createdAt);
    return {
      queryThreadId,
      created: reuse === null,
      askedAt: createdAt,
      authorThreadId,
      authorSource,
    };
  },
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
export const promoteDocumentQuery = Effect.fn("documentQuery.promoteDocumentQuery")(
  function* (input: DocumentQueryPromoteInput) {
    const promoteMethod = LOOM_WS_METHODS.documentQueryPromote;
    const row = yield* (yield* LoomStoreV2).getWorkstream(input.queryThreadId);
    if (row?.role !== DOCUMENT_QUERY_ROLE || row.deletedAt !== null)
      return yield* new LoomWsMethodError({
        method: promoteMethod,
        message: "Only a query thread's exchanges can be promoted.",
      });
    if (
      ![...(row.documentQuery?.questions ?? []), ...(row.codeQuery?.questions ?? [])].some(
        (question) => question.askedAt === input.exchangeAt,
      )
    )
      return yield* new LoomWsMethodError({
        method: promoteMethod,
        message: "That exchange is not a question asked in this query thread.",
      });
    const id = documentQueryPromoteId(
      input.queryThreadId,
      yield* (yield* SecureRandom.SecureRandom).uuidV4(),
    );
    yield* (yield* OrchestratorV2).dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId: input.queryThreadId,
      messageId: MessageId.make(`message:${id}`),
      text: buildQueryPromoteTurn(input.exchangeAt),
      attachments: [],
      // The human pressed Promote; the server words the turn.
      createdBy: "user",
      creationSource: "server",
      dispatchMode: { type: "queue_after_active" },
    });
    return { dispatched: true as const };
  },
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
