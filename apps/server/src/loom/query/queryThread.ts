/**
 * What a query thread shares across its two subjects, a document and code (plans/code-query/plan.mdx
 * §4): the fork of the author as a goal-less `document-query` root that carries its brief, each
 * question as the human's message with one `review-comment` record, the brief a deferred fork is
 * launched from, and the settling of live query threads a fresher one supersedes.
 */
import {
  CommandId,
  DOCUMENT_QUERY_ROLE,
  type LoomThreadWorkstream,
  MessageId,
  type OrchestrationV2ServerCommand,
  type ReviewCommentContextRecord,
  type ThreadId,
} from "@t3tools/contracts";
import {
  formatComposerContextReference,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";
import {
  documentQueryQuestionId as questionId,
  joinDocumentQueryKickoff,
} from "@t3tools/shared/documentQuery.loom";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { OrchestratorV2 } from "../../orchestration-v2/Orchestrator.ts";
import { buildDraftSpawn, curatedTitle, launchDraftFork } from "../handoff/handoffDraft.ts";
import { writeWorkstreamBrief } from "../workstream/brief.ts";

/** A query thread forked from `authorThreadId` that is still open: not finished, archived or deleted. */
export const isLiveQueryOf = (row: LoomThreadWorkstream, authorThreadId: ThreadId) =>
  row.role === DOCUMENT_QUERY_ROLE &&
  row.forkFromThreadId === authorThreadId &&
  row.archivedAt === null &&
  row.deletedAt === null &&
  row.outcome === null;

/**
 * The `n`th question as the human's own message: one `review-comment` record, referenced by the
 * text `text` builds around its chip so the agent reads it once. The first carries the overlay.
 */
export const buildQuestionDispatch = (input: {
  readonly threadId: ThreadId;
  readonly n: number;
  readonly record: Omit<ReviewCommentContextRecord, "version" | "contextId" | "kind" | "label">;
  readonly text: (reference: string) => string;
  readonly overlay?: string;
}) => {
  const id = questionId(input.threadId, input.n);
  const contextId = toKindScopedComposerContextId("review-comment", id);
  const label = sanitizeComposerContextLabel(
    `${input.record.filePath.split("/").pop()} ${input.record.rangeLabel}`,
    "review-comment",
  );
  const text = input.text(
    formatComposerContextReference({ kind: "review-comment", contextId, label }),
  );
  return {
    type: "message.dispatch",
    commandId: CommandId.make(id),
    threadId: input.threadId,
    messageId: MessageId.make(`message:${id}`),
    text: input.overlay === undefined ? text : joinDocumentQueryKickoff(input.overlay, text),
    context: {
      version: 1,
      records: [{ version: 1, contextId, kind: "review-comment", label, ...input.record }],
    },
    attachments: [],
    // The human typed it (the Query card); the server sequences it behind the fork.
    createdBy: "user",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
  } satisfies OrchestrationV2ServerCommand;
};

/**
 * A deferred fork's brief: the overlay, the first question as the human reads it, and the launch
 * as JSON in a trailing comment (`>` escaped so the JSON never closes it), which the reactor reads.
 */
export const buildQueryBrief = (input: {
  readonly marker: string;
  readonly overlay: string;
  readonly firstQuestion: string;
  readonly json: string;
}) =>
  `${input.overlay}\n\n---\n\n${input.firstQuestion}\n\n<!-- ${input.marker} ${input.json.replace(/>/g, "\\u003e")} -->\n`;

/** The JSON a brief built with `marker` carries, or none. */
export const queryBriefJson = (marker: string, brief: string) =>
  Option.fromNullishOr(new RegExp(`<!-- ${marker} (.*) -->\\s*$`, "s").exec(brief)?.[1]);

/**
 * Writes the brief and forks the author into a query thread `queryThreadId`, titled
 * `Query: <subject>`; `launch` is the fork transfer and the overlay-led first question.
 */
export const launchQueryFork = Effect.fn("queryThread.launchQueryFork")(function* (input: {
  readonly method: string;
  readonly authorThreadId: ThreadId;
  readonly queryThreadId: ThreadId;
  readonly subject: string;
  readonly purpose: string;
  readonly brief: string;
  readonly launch: (createdAt: string) => ReadonlyArray<OrchestrationV2ServerCommand>;
}) {
  const kickoffBriefPath = yield* writeWorkstreamBrief(input.queryThreadId, input.brief);
  yield* launchDraftFork({
    method: input.method,
    verb: "queried",
    sourceThreadId: input.authorThreadId,
    drafterThreadId: input.queryThreadId,
    build: (fork) => [
      {
        ...buildDraftSpawn({
          ...fork,
          sourceGoalId: null,
          role: DOCUMENT_QUERY_ROLE,
          title: curatedTitle("Query", input.subject),
          purpose: input.purpose,
        }),
        kickoffBriefPath,
      },
      ...input.launch(fork.createdAt),
    ],
  });
});

/** Settles live query threads a fresher one replaces: done, then archived. */
export const supersedeQueryThreads = Effect.fn("queryThread.supersedeQueryThreads")(function* (
  stale: ReadonlyArray<LoomThreadWorkstream>,
  createdAt: string,
) {
  const orchestrator = yield* OrchestratorV2;
  for (const row of stale) {
    const id = (step: string) =>
      CommandId.make(`server:loom:query-supersede:${row.threadId}:${step}`);
    yield* orchestrator.dispatch({
      type: "thread.outcome.set",
      commandId: id("done"),
      threadId: row.threadId,
      createdAt,
      outcome: "done",
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: id("archive"),
      threadId: row.threadId,
    });
  }
});
