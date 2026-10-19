import {
  EventId,
  IsoDateTime,
  LoomOutcome,
  LoomRouteKind,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
  WorkOutcomeRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

const historyRow = <const Type extends string, Payload extends Schema.Struct.Fields>(
  type: Type,
  payload: Payload,
) =>
  Schema.Struct({
    type: Schema.Literal(type),
    eventId: EventId,
    at: IsoDateTime,
    payload: Schema.fromJsonString(Schema.Struct(payload)),
  });

/** The event-log rows `LoomStore.history` folds. V1 rows carry extra payload fields and V1 reasons. */
export const HistoryEventRow = Schema.Union([
  historyRow("thread.report-set", { reportPath: TrimmedNonEmptyString }),
  historyRow("thread.outcome-recorded", Struct.omit(WorkOutcomeRecord.fields, ["eventId", "at"])),
  historyRow("thread.attention-raised", { reason: TrimmedNonEmptyString }),
  historyRow("thread.attention-cleared", { reason: Schema.optional(TrimmedNonEmptyString) }),
  // V1's route-taken had no kind: every V1 route was a loop.
  historyRow("thread.route-taken", {
    to: ThreadId,
    round: NonNegativeInt,
    kind: Schema.optional(LoomRouteKind),
  }),
  historyRow("thread.gate-rework-accepted", { sourceThreadId: ThreadId, round: NonNegativeInt }),
  historyRow("thread.outcome-set", { outcome: Schema.NullOr(LoomOutcome) }),
  // V1's lane axis: a yield was the `yielded` lane, done/cancelled were lanes.
  historyRow("thread.plan-lane-set", { planLane: Schema.String }),
]);

/**
 * The timeline's only copy of pre-V2 workstream history is these V1 event rows,
 * so the event-store compaction (`ProjectionMaintenance.compactEventStore`)
 * must keep them even after the thread's transcript is imported.
 */
export const HISTORY_EVENT_TYPES = HistoryEventRow.members.map(
  (member) => member.fields.type.literal,
);
