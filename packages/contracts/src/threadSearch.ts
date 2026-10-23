import * as Schema from "effect/Schema";

import {
  IsoDateTime,
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

// The server's SQLite client is synchronous and single-connection. Bound both
// scan input and response size so a search cannot monopolize that connection.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  // loom: archived roots are searched unless this is false (default true).
  includeArchived: Schema.optionalKey(Schema.Boolean),
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
