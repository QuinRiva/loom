// notify_thread (cross-thread push) shared constants + pure loop-safety helpers.
// LOOM-ONLY. Kept dependency-free so BOTH the decider (authoritative cap
// enforcement against the sender read model) and the HTTP handler (message-size
// guard) import the same numbers — one source of truth, no drift.

/**
 * Message size cap (D8). ~4k tokens. Deliberately far below the transport
 * ceiling (`PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000`): a peer message is an
 * unsolicited injection into another agent's context window, so it must fit a
 * completion notice with a results summary and artefact paths while making
 * "paste the whole report inline" impossible. Bulk content travels as paths.
 */
export const NOTIFY_MESSAGE_MAX_CHARS = 16_000;

/**
 * Ordered-pair (sender -> target) rate cap per rolling window (D7). Legitimate
 * uses are sparse; a runaway A<->B loop is turn-paced and hits the cap within
 * the window, telling both directions to stop. A recorded-but-expired or
 * recorded-but-undelivered message still counts (the cap meters send pressure,
 * not delivery success), so a busy target grants no free retries.
 */
export const NOTIFY_PAIR_HOURLY_CAP = 10;

/** The D7 cap's rolling window: one hour, in milliseconds. */
export const NOTIFY_PAIR_WINDOW_MS = 60 * 60 * 1000;

// Deterministic command ids for the delivery lifecycle, derived from the
// handler-generated `recordId`. Shared so the handler's immediate delivery
// attempt and the dispatcher's deferred-delivery rail compute byte-identical
// ids: the engine receipt store then makes redelivery at-most-once, and the
// crash-window reconciliation leg (`wasDelivered`) can look the receipt up.
export const notifyRecordCommandId = (recordId: string): string =>
  `server:notify-record:${recordId}`;
export const notifyDeliverCommandId = (recordId: string): string =>
  `server:notify-deliver:${recordId}`;
export const notifyMarkCommandId = (recordId: string): string => `server:notify-mark:${recordId}`;
export const notifyExpireCommandId = (recordId: string): string =>
  `server:notify-expire:${recordId}`;

/** One pruned send-log entry (mirrors the `NotifySendLogEntry` contract shape). */
export interface NotifySendLogEntryLike {
  readonly targetThreadId: string;
  readonly at: string;
}

/**
 * Count the sender's in-window notifications to ONE target. `nowMs`/entry times
 * are epoch millis; a non-parseable `at` is treated as out of window (dropped).
 * The decider compares this against {@link NOTIFY_PAIR_HOURLY_CAP} to decide
 * whether one more send is admissible.
 */
export const notifyPairWindowCount = (
  log: ReadonlyArray<NotifySendLogEntryLike>,
  targetThreadId: string,
  nowMs: number,
  windowMs: number = NOTIFY_PAIR_WINDOW_MS,
): number => {
  const cutoff = nowMs - windowMs;
  let count = 0;
  for (const entry of log) {
    if (entry.targetThreadId !== targetThreadId) continue;
    const at = Date.parse(entry.at);
    if (Number.isNaN(at) || at < cutoff) continue;
    count += 1;
  }
  return count;
};

/**
 * Would recording one more send from the sender to `targetThreadId` breach the
 * ordered-pair cap? Pure; the decider calls it inside the serial command
 * boundary so check-then-append is atomic.
 */
export const notifyPairCapExceeded = (
  log: ReadonlyArray<NotifySendLogEntryLike>,
  targetThreadId: string,
  nowMs: number,
  cap: number = NOTIFY_PAIR_HOURLY_CAP,
  windowMs: number = NOTIFY_PAIR_WINDOW_MS,
): boolean => notifyPairWindowCount(log, targetThreadId, nowMs, windowMs) >= cap;

/**
 * Append one entry to the send log and prune to the rolling window, so the log
 * stays bounded regardless of a thread's lifetime. Used by the projector on each
 * `thread.peer-message-recorded`.
 */
export const appendPrunedNotifySendLog = <T extends NotifySendLogEntryLike>(
  log: ReadonlyArray<T>,
  entry: T,
  nowMs: number,
  windowMs: number = NOTIFY_PAIR_WINDOW_MS,
): ReadonlyArray<T> => {
  const cutoff = nowMs - windowMs;
  const pruned = log.filter((existing) => {
    const at = Date.parse(existing.at);
    return !Number.isNaN(at) && at >= cutoff;
  });
  return [...pruned, entry];
};
