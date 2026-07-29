/**
 * Durable settlement of agent questions — the guarantee that a
 * `user-input.requested` activity always eventually gets a matching
 * `user-input.resolved` activity, from three independent layers:
 *
 *  1. the runtime cancel paths (the pi broker, the other adapters' in-process
 *     deferreds) — with the queue-shutdown/emitter-absent fallback below;
 *  2. the session-exit rule in `ProviderRuntimeIngestion` (durable, needs no
 *     in-memory state, survives a restart);
 *  3. the startup scan in `loom/startup.ts`.
 *
 * All three write the SAME activity through the ordinary command path
 * (`thread.activity.append`), never through a per-session runtime event queue —
 * a queue can already be shut down when a cancellation is emitted into it,
 * which is exactly how a production thread was wedged for 22 hours with its
 * cancellation present in the canonical log and absent from the database.
 *
 * The out-of-Effect fallback (`settleUserInputRequestsDurably`) exists because
 * the pi process-exit handler runs from a Node `exit` listener, outside the
 * Effect runtime that owns the session's event queue. It dispatches through a
 * sink registered at startup, whose closure already holds the resolved
 * `OrchestrationEngineService`, so no Effect context is needed at call time and
 * the engine's own serialised command queue does the durable write.
 *
 * @module userInputSettlement
 */
import {
  CommandId,
  EventId,
  type OrchestrationThreadActivity,
  type ProviderUserInputAnswers,
  type ThreadId,
  type UserInputResolvedOutcome,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Schedule from "effect/Schedule";

import type { OrchestrationDispatchError } from "./Errors.ts";

/**
 * What a settlement dispatch can fail with: the engine's own dispatch union, plus
 * the `PlatformError` a crypto-backed `newId` can raise. Deliberately the REAL
 * union rather than a narrow convenience shape — `isAlreadySettledRejection` must
 * be able to see an actual `OrchestrationCommandInvariantError`, which a shape
 * like `{ message: string }` would erase.
 */
type SettlementDispatchFailure = OrchestrationDispatchError | PlatformError.PlatformError;

/**
 * Marker in the decider's first-terminal-wins rejection detail. Exported so the
 * decider that PRODUCES it and the two callers that must recognise it share one
 * constant instead of copies of a substring — a copy that drifted would silently
 * turn "this write is unnecessary" into "this write failed" or, far worse,
 * vice versa.
 */
export const ALREADY_SETTLED_REJECTION_MARKER =
  "is already settled; a later resolution would contradict the recorded outcome";

/**
 * True for the decider's first-terminal-wins rejection: the request already
 * carries a durable terminal outcome, so this write is unnecessary rather than
 * failed. NOTHING else may match — a transient engine/event-store failure that
 * were treated as "already settled" would drop a genuine first resolution and
 * reproduce incident 1 (present in the log, absent from the database), which is
 * the exact failure this workstream exists to eliminate.
 */
export const isAlreadySettledRejection = <E>(
  error: E,
): error is E & {
  readonly _tag: "OrchestrationCommandInvariantError";
  readonly detail: string;
} => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly _tag?: unknown; readonly detail?: unknown };
  return (
    candidate._tag === "OrchestrationCommandInvariantError" &&
    typeof candidate.detail === "string" &&
    candidate.detail.includes(ALREADY_SETTLED_REJECTION_MARKER)
  );
};

/**
 * Total attempts per resolution before it is reported unpersisted. Bounded and
 * short: the point is to ride out a transient command-path failure, not to hold a
 * process-exit handler open — and the startup scan is the durable backstop for
 * anything that still does not land.
 */
const SETTLEMENT_DISPATCH_ATTEMPTS = 4;
const SETTLEMENT_RETRY_BASE = Duration.millis(50);

/**
 * What a settlement attempt actually achieved. `persisted` counts CONFIRMED
 * durable writes — callers must report that number, not the number attempted, or
 * a startup log claims success over a thread that is still wedged.
 */
export interface UserInputSettlementReport {
  readonly persisted: number;
  readonly failed: number;
}

const SUMMARY_BY_OUTCOME: Record<UserInputResolvedOutcome, string> = {
  answered: "User input submitted",
  dismissed: "User input dismissed",
  superseded: "User input superseded by a message",
  cancelled: "User input cancelled",
};

export interface UserInputResolution {
  // Absent only for a legacy adapter event that carried no requestId; the fold
  // ignores such a row, exactly as it did before.
  readonly requestId: string | undefined;
  readonly outcome: UserInputResolvedOutcome;
  readonly answers?: ProviderUserInputAnswers;
  /** The plain message that superseded the question, when `outcome` is `superseded`. */
  readonly message?: string;
}

/**
 * The durable `user-input.resolved` row. Every settlement path builds it here,
 * so the payload shape (and therefore what the fold and every client sees) has
 * exactly one definition.
 */
export const userInputResolvedActivity = (input: {
  readonly activityId: EventId;
  readonly resolution: UserInputResolution;
  readonly turnId: OrchestrationThreadActivity["turnId"];
  readonly createdAt: string;
}): OrchestrationThreadActivity => ({
  id: input.activityId,
  tone: "info",
  kind: "user-input.resolved",
  // Defensive against an in-process emitter that skipped the schema (a runtime
  // event constructed in code rather than decoded off the wire): `summary` is a
  // non-empty-string contract, so a missing entry would fail the append and lose
  // the settlement — the exact class of silent loss this module exists to prevent.
  summary: SUMMARY_BY_OUTCOME[input.resolution.outcome] ?? SUMMARY_BY_OUTCOME.answered,
  payload: {
    ...(input.resolution.requestId !== undefined ? { requestId: input.resolution.requestId } : {}),
    answers: input.resolution.answers ?? {},
    outcome: input.resolution.outcome,
    ...(input.resolution.message !== undefined ? { message: input.resolution.message } : {}),
  },
  turnId: input.turnId,
  createdAt: input.createdAt,
});

/**
 * Persist resolutions through the command path. `tag` distinguishes the calling
 * layer in both the command id (so two settlement layers racing on one request
 * cannot collide on a receipt — both landing is harmless anyway, the fold is
 * terminal-wins) and the log line. That log line is load-bearing observability,
 * not decoration: D1's two mechanisms (`pi-emitter-absent-*` vs
 * `pi-queue-shutdown-*`) were indistinguishable in the forensic log, and this
 * tells them apart.
 */
export const dispatchUserInputResolutions = (input: {
  readonly dispatch: (command: {
    readonly type: "thread.activity.append";
    readonly commandId: CommandId;
    readonly threadId: ThreadId;
    readonly activity: OrchestrationThreadActivity;
    readonly createdAt: string;
    // Errors stay UNCONSTRAINED (`never` in, any out): this helper is shared by
    // callers whose dispatch error unions differ, and `isAlreadySettledRejection`
    // reads the value structurally. Pinning a narrower shape here would silently
    // stop the already-settled refinement from matching the real
    // `OrchestrationCommandInvariantError` the decider raises.
  }) => Effect.Effect<unknown, SettlementDispatchFailure>;
  readonly newId: Effect.Effect<string, SettlementDispatchFailure>;
  readonly threadId: ThreadId;
  readonly resolutions: ReadonlyArray<UserInputResolution>;
  readonly turnId?: OrchestrationThreadActivity["turnId"];
  readonly createdAt: string;
  readonly tag: string;
}): Effect.Effect<UserInputSettlementReport> =>
  Effect.logInfo("user-input.settlement", {
    threadId: input.threadId,
    tag: input.tag,
    resolutions: input.resolutions.map(({ requestId, outcome }) => ({ requestId, outcome })),
  }).pipe(
    Effect.andThen(
      Effect.forEach(
        input.resolutions,
        (resolution) =>
          Effect.gen(function* () {
            // Allocated ONCE, OUTSIDE the retry below. Generating it inside would
            // give every attempt a fresh command id, so an ambiguous
            // commit-then-error (the write landed, the ack did not) would be
            // retried as a NEW command and write a second terminal row. Hoisted,
            // the retry reuses the same id and the engine's command receipt makes
            // it a durable no-op.
            const uuid = yield* input.newId;
            yield* Effect.gen(function* () {
              yield* input.dispatch({
                type: "thread.activity.append",
                commandId: CommandId.make(`server:user-input-settle:${input.tag}:${uuid}`),
                threadId: input.threadId,
                activity: userInputResolvedActivity({
                  activityId: EventId.make(uuid),
                  resolution,
                  turnId: input.turnId ?? null,
                  createdAt: input.createdAt,
                }),
                createdAt: input.createdAt,
              });
            }).pipe(
              // A transient command-path failure must not silently reproduce
              // incident 1 (canonical cancellation, no durable resolution). Retry
              // with backoff before giving up, and REPORT the give-up rather than
              // swallowing it — the caller's success count must mean "confirmed
              // persisted", or a startup log claiming success is worse than no log.
              Effect.retry({
                schedule: Schedule.exponential(SETTLEMENT_RETRY_BASE).pipe(
                  Schedule.take(SETTLEMENT_DISPATCH_ATTEMPTS - 1),
                ),
                // Retry only what a retry can fix. The decider rejects a second
                // resolution for an already-settled request (first-terminal-wins),
                // which is TERMINAL and, importantly, means the durable resolution
                // exists — retrying it would just burn the backoff and then report
                // a false failure for a request that is in fact settled.
                while: (error) => !isAlreadySettledRejection(error),
              }),
            );
            return true;
          }).pipe(
            // An already-settled rejection means the goal is met by someone else's
            // write, so it is a success from this caller's point of view.
            Effect.catchIf(isAlreadySettledRejection, () => Effect.succeed(true)),
            Effect.catchCause((cause) =>
              Effect.logError("user-input.settlement.unpersisted", {
                threadId: input.threadId,
                requestId: resolution.requestId,
                outcome: resolution.outcome,
                tag: input.tag,
                attempts: SETTLEMENT_DISPATCH_ATTEMPTS,
                cause,
              }).pipe(Effect.as(false)),
            ),
          ),
        { concurrency: 1 },
      ).pipe(
        Effect.map((results) => ({
          persisted: results.filter(Boolean).length,
          failed: results.filter((ok) => !ok).length,
        })),
      ),
    ),
  );

type SettlementSink = (input: {
  readonly threadId: ThreadId;
  readonly resolutions: ReadonlyArray<UserInputResolution>;
  readonly tag: string;
}) => Promise<UserInputSettlementReport>;

let settlementSink: SettlementSink | null = null;

/** Registered once at startup by the layer that owns command dispatch. */
export const registerUserInputSettlementSink = (sink: SettlementSink): (() => void) => {
  settlementSink = sink;
  return () => {
    if (settlementSink === sink) settlementSink = null;
  };
};

/**
 * How an unpersisted settlement is surfaced from outside the Effect runtime.
 * Installed alongside the sink so the message reaches the real logger; the
 * fallback exists because the caller is a process `exit` listener that may run
 * after the runtime is gone, and silence there is exactly the failure mode the
 * forensic audit could not distinguish from success.
 */
type UnpersistedReporter = (message: string) => void;

let unpersistedReporter: UnpersistedReporter | null = null;

export const registerUserInputSettlementReporter = (report: UnpersistedReporter): (() => void) => {
  unpersistedReporter = report;
  return () => {
    if (unpersistedReporter === report) unpersistedReporter = null;
  };
};

const reportUnpersisted = (
  input: {
    readonly threadId: ThreadId;
    readonly resolutions: ReadonlyArray<UserInputResolution>;
    readonly tag: string;
  },
  reason: string,
): void => {
  const message = `[user-input.settlement] NOT persisted (${reason}): ${input.resolutions.length} resolution(s) for thread ${input.threadId} [${input.tag}] — requests ${input.resolutions
    .map((resolution) => `${resolution.requestId}:${resolution.outcome}`)
    .join(", ")}. The question stays open until the startup scan settles it.`;
  if (unpersistedReporter) {
    unpersistedReporter(message);
    return;
  }
  globalThis.process?.emitWarning?.(message);
};

/**
 * Persist resolutions from outside the Effect runtime (the pi process-exit
 * handler). Never throws — a backstop that can fail its caller is not one — but
 * never lies either: the report says how many resolutions were CONFIRMED
 * persisted, and every shortfall is logged at error level.
 *
 * The no-sink case is the one the audit could not distinguish, so it is loud:
 * settlement machinery that is not wired up must never look like success.
 */
export const settleUserInputRequestsDurably = async (input: {
  readonly threadId: ThreadId;
  readonly resolutions: ReadonlyArray<UserInputResolution>;
  readonly tag: string;
}): Promise<UserInputSettlementReport> => {
  if (input.resolutions.length === 0) return { persisted: 0, failed: 0 };
  const sink = settlementSink;
  if (!sink) {
    reportUnpersisted(input, "no settlement sink is registered");
    return { persisted: 0, failed: input.resolutions.length };
  }
  const report = await sink(input).catch((cause: unknown) => {
    reportUnpersisted(input, `the settlement sink rejected: ${String(cause)}`);
    return { persisted: 0, failed: input.resolutions.length } satisfies UserInputSettlementReport;
  });
  if (report.failed > 0) reportUnpersisted(input, "the command path did not confirm the write");
  return report;
};
