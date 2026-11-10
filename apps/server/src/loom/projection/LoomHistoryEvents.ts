import {
  EventId,
  IsoDateTime,
  LoomCancelReason,
  LoomGateWarningKind,
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

/**
 * The `loom_thread_history` rows `LoomStore.history` folds, copied from the event log by the Loom
 * projector at commit time (and once by migration 1070). V1 rows carry extra payload fields and V1 reasons.
 */
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
  historyRow("thread.outcome-set", {
    outcome: Schema.NullOr(LoomOutcome),
    reason: Schema.optional(LoomCancelReason), // loom: cancel reason
  }),
  // V1's lane axis: a yield was the `yielded` lane, done/cancelled were lanes.
  historyRow("thread.plan-lane-set", { planLane: Schema.String }),
  // Stored for later reads; the timeline shows nothing for it.
  historyRow("thread.gate-warning", {
    kind: LoomGateWarningKind,
    detail: Schema.String,
    threadIds: Schema.Array(ThreadId),
  }),
]);
