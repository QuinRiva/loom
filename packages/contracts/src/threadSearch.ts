import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

// loom: every text unit loom's thread-content index holds; clients label the excerpt by source.
export const OrchestrationThreadSearchSource = Schema.Literals([
  "user",
  "assistant",
  "title",
  "purpose",
  "brief",
  "goal",
  "task",
  "report",
]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

// loom: how much of a workstream tree a search reads (ThreadSearch.loom.ts).
export const OrchestrationThreadSearchScope = Schema.Literals(["roots", "all"]);
export type OrchestrationThreadSearchScope = typeof OrchestrationThreadSearchScope.Type;

/** Longer queries are cut to this before they are sent. */
export const THREAD_SEARCH_QUERY_MAX_LENGTH = 200;

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(
    Schema.isMinLength(2),
    Schema.isMaxLength(THREAD_SEARCH_QUERY_MAX_LENGTH),
  ),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  // loom: archived roots are searched unless this is false (default true).
  includeArchived: Schema.optionalKey(Schema.Boolean),
  // loom: one project's roots only; omitted, every project.
  projectId: Schema.optional(ProjectId),
  // loom: `roots` (default): each root's own title, purpose, goal and messages plus every
  // report in its tree; `all` adds sub-threads' messages, titles, purposes and briefs, and tasks.
  scope: Schema.optionalKey(OrchestrationThreadSearchScope),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId, // loom: always the ROOT thread
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  // loom: enough to draw a result row without a shell (archived roots have none)
  title: Schema.String,
  archivedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  // loom: the sub-thread that produced the hit; null when the root itself did
  matchedThreadId: Schema.NullOr(ThreadId),
  matchedThreadTitle: Schema.NullOr(Schema.String),
  /**
   * How well the message matches: 1 for whole words, 0.8 when a word only
   * starts one, 0.3 when one only appears inside words, 0.25 more when the
   * words are written together as typed, else 0.1 more when they are near.
   * Older servers omit it.
   */
  quality: Schema.optionalKey(Schema.Finite),
  /** How many of the thread's newest messages match. Older servers omit it. */
  hits: Schema.optionalKey(Schema.Int),
  /** The message the snippet is from. Older servers omit it. */
  messageId: Schema.optionalKey(MessageId),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
