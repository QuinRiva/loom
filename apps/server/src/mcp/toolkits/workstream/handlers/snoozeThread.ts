/**
 * `snooze_thread`: the caller snoozes ITSELF. A mid-turn snooze is undone when the run completes,
 * so this only records the request and the dispatcher's snooze rail applies it once the turn ended
 * idle. Upstream's snooze tool needs the `orchestration` capability a Loom credential lacks.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as LoomStore from "../../../../loom/projection/LoomStore.ts";
import type { WorkstreamCaller } from "../authorisation.ts";
import type { LoomToolInput } from "../defs.ts";
import { asToolError, fail } from "./shared.ts";

const MAX_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const snoozeThread = Effect.fn("LoomToolkit.snoozeThread")(function* (
  input: LoomToolInput<"snooze_thread">,
  caller: WorkstreamCaller,
) {
  const requests = (yield* LoomStore.LoomStoreV2).snoozeRequests;
  if (input.cancel === true)
    return (yield* asToolError(requests.clear(caller.threadId)))
      ? "Withdrew this thread's snooze request; it stays in the inbox when this turn ends."
      : "This thread had no snooze request to withdraw.";
  const now = yield* DateTime.now;
  const until = Option.getOrNull(DateTime.make(input.until ?? ""));
  if (
    until === null ||
    DateTime.toEpochMillis(until) <= DateTime.toEpochMillis(now) ||
    DateTime.toEpochMillis(until) > DateTime.toEpochMillis(now) + MAX_DAYS * DAY_MS
  )
    return yield* fail(
      `until must be an ISO-8601 datetime in the future and at most ${MAX_DAYS} days ahead (or pass cancel: true); got "${input.until ?? ""}".`,
    );
  const snoozedUntil = DateTime.formatIso(until);
  yield* asToolError(
    requests.set({
      threadId: caller.threadId,
      snoozedUntil,
      requestedAt: DateTime.formatIso(now),
    }),
  );
  return `Snooze requested: when this turn ends idle, this thread leaves the inbox until ${snoozedUntil}, or until any inbound message wakes it sooner.`;
});
