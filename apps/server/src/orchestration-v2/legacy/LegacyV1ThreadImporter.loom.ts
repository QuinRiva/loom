/**
 * loom: V1's `origin` (absent means human) and `control_payload_json` become `message.loom` and
 * `createdBy: "agent"`, as the dispatcher writes, so imports render, settle and count as human the
 * same way. An undecodable payload is dropped and the card falls back to raw text.
 */
import {
  ControlPayload,
  LoomMessageOrigin,
  type LoomMessageFields,
  type OrchestrationV2TurnItem,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface LegacyLoomMessageColumns {
  readonly role: "user" | "assistant";
  readonly origin?: string | null;
  readonly control_payload_json?: string | null;
}

const decodeOrigin = Schema.decodeUnknownOption(LoomMessageOrigin);
const decodePayload = Schema.decodeUnknownOption(Schema.fromJsonString(ControlPayload));

export function importedLoomFields(row: LegacyLoomMessageColumns): {
  readonly createdBy: "user" | "agent";
  readonly loom?: LoomMessageFields;
} {
  const origin = Option.getOrUndefined(decodeOrigin(row.origin));
  if (row.role !== "user") return { createdBy: "agent" };
  if (origin === undefined) return { createdBy: "user" };
  const controlPayload =
    row.control_payload_json == null
      ? undefined
      : Option.getOrUndefined(decodePayload(row.control_payload_json));
  return {
    createdBy: "agent",
    loom: {
      origin,
      humanAuthored: false,
      ...(controlPayload === undefined ? {} : { controlPayload }),
    },
  };
}

/**
 * loom: each V1 `thread.consult-recorded` event becomes the completed `consult_thread` turn item V2's
 * card renders, placed among the thread's runless items by time (here and in migration 1054).
 */
export interface LegacyConsultRow {
  readonly event_id: string;
  readonly thread_id: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}

const decodeConsultPayload = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      targetThreadId: Schema.String,
      question: Schema.String,
      answer: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
);

const legacyConsultTurnItemId = (eventId: string) =>
  TurnItemId.make(`migration:v1:turn-item:consult:${eventId}`);

export function importedConsultTurnItem(
  row: LegacyConsultRow,
  ordinal: number,
): OrchestrationV2TurnItem {
  const { targetThreadId, question, answer } = decodeConsultPayload(row.payload_json);
  const at = DateTime.makeUnsafe(row.occurred_at);
  return {
    id: legacyConsultTurnItemId(row.event_id),
    threadId: ThreadId.make(row.thread_id),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName: "mcp__t3-code__consult_thread",
    input: { threadId: targetThreadId, question },
    output: answer ?? "",
  };
}

/**
 * A thread's runless items (in order) with its V1 consults (time-ordered)
 * merged in: a consult goes before the first item strictly later than it, so
 * the importer and migration 1054 place every consult identically.
 */
export function interleaveConsults<I>(
  items: ReadonlyArray<I>,
  at: (item: I) => string,
  consults: ReadonlyArray<LegacyConsultRow>,
): ReadonlyArray<{ readonly item: I } | { readonly consult: LegacyConsultRow }> {
  const merged: Array<{ readonly item: I } | { readonly consult: LegacyConsultRow }> = [];
  let next = 0;
  for (const item of items) {
    while (next < consults.length && consults[next]!.occurred_at < at(item))
      merged.push({ consult: consults[next++]! });
    merged.push({ item });
  }
  return [...merged, ...consults.slice(next).map((consult) => ({ consult }))];
}
