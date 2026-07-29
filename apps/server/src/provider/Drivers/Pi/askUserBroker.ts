// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// LOOM-ONLY. In-memory rendezvous between the pi ask_user_question HTTP tool
// and PiDriver's canonical runtime-event/answer path. Pending input is
// intentionally no more durable than every other provider's live Deferred — but
// its SETTLEMENT is durable regardless: every cancellation here that cannot ride
// the per-session event queue is persisted through the command path instead
// (`orchestration/userInputSettlement.ts`). A cancellation emitted into a
// shut-down queue is logged and never persisted, which is precisely how a
// production thread stayed wedged for 22 hours.
import * as NodeCrypto from "node:crypto";

import type {
  ProviderUserInputAnswers,
  ThreadId,
  UserInputQuestion,
  UserInputResolvedOutcome,
} from "@t3tools/contracts";

import { settleUserInputRequestsDurably } from "../../../orchestration/userInputSettlement.ts";

export type PiAskUserBrokerEvent =
  | {
      readonly type: "requested";
      readonly requestId: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
    }
  | {
      readonly type: "resolved";
      readonly requestId: string;
      readonly answers: ProviderUserInputAnswers;
      readonly cancelled: boolean;
    };

export type PiAskUserOutcome =
  | {
      readonly outcome: "answered";
      readonly requestId: string;
      readonly questions: ReadonlyArray<UserInputQuestion>;
      readonly answers: ProviderUserInputAnswers;
    }
  | {
      readonly outcome: "superseded";
      readonly requestId: string;
      readonly message: string;
    }
  | {
      readonly outcome: "dismissed" | "cancelled";
      readonly requestId: string;
    }
  | {
      readonly outcome: "could_not_present";
    };

export type PiAskUserPollResult =
  | { readonly pending: true; readonly requestId: string }
  | ({ readonly pending: false } & PiAskUserOutcome);

/**
 * Publishes a broker event onto the owning session's runtime event queue.
 * Resolves `false` when the event could not be delivered (the queue has been
 * shut down mid-teardown) so the caller can fall back to the durable path
 * rather than losing a terminal event with no trace.
 */
type Emit = (event: PiAskUserBrokerEvent) => Promise<boolean>;

interface PendingQuestion {
  readonly requestId: string;
  readonly threadId: ThreadId;
  readonly questions: ReadonlyArray<UserInputQuestion>;
  readonly listeners: Set<(outcome: PiAskUserOutcome) => void>;
  settling?: boolean;
  outcome?: PiAskUserOutcome;
}

const emitters = new Map<ThreadId, Emit>();
const pending = new Map<string, PendingQuestion>();
export const PI_ASK_USER_SETTLED_RETENTION_MS = 60_000;

export const registerPiAskUserEmitter = (threadId: ThreadId, emit: Emit): (() => void) => {
  emitters.set(threadId, emit);
  return () => {
    if (emitters.get(threadId) === emit) emitters.delete(threadId);
  };
};

export const openPiAskUserQuestion = async (
  threadId: ThreadId,
  buildQuestions: (requestId: string) => ReadonlyArray<UserInputQuestion>,
): Promise<PiAskUserOutcome | { readonly requestId: string }> => {
  const emit = emitters.get(threadId);
  if (!emit) return { outcome: "could_not_present" };

  const requestId = NodeCrypto.randomUUID();
  const questions = buildQuestions(requestId);
  pending.set(requestId, { requestId, threadId, questions, listeners: new Set() });
  try {
    await emit({ type: "requested", requestId, questions });
    return { requestId };
  } catch (error) {
    pending.delete(requestId);
    throw error;
  }
};

const finish = (entry: PendingQuestion, outcome: PiAskUserOutcome) => {
  entry.outcome = outcome;
  for (const listener of entry.listeners) listener(outcome);
  entry.listeners.clear();
  // Keep a short tombstone so a poll whose previous connection dropped can
  // still collect the terminal outcome. It is never an unanswered-question
  // timeout: only already-settled entries are bounded here.
  setTimeout(() => {
    if (pending.get(entry.requestId) === entry && entry.outcome) pending.delete(entry.requestId);
  }, PI_ASK_USER_SETTLED_RETENTION_MS).unref();
};

export const resolvePiAskUserQuestion = (
  threadId: ThreadId,
  requestId: string,
  answers: ProviderUserInputAnswers,
  settlement: {
    readonly outcome: UserInputResolvedOutcome;
    readonly message?: string;
  } = { outcome: "answered" },
): boolean => {
  const entry = pending.get(requestId);
  if (!entry || entry.threadId !== threadId) return false;
  // The broker owns this id in EVERY state it can be in — duplicate/racing UI
  // responses, and (D11) a missing emitter. Returning false on a missing emitter
  // used to fall through to PiDriver's unrelated legacy-dialog path, which threw
  // "Unknown Pi user-input request" and left the entry alive and unclaimed with
  // its poll still waiting forever.
  if (entry.settling || entry.outcome) return true;
  entry.settling = true;
  // This is DELIVERY, not settlement. The server persisted the resolution before
  // dispatching here (settle-first), so this function emits nothing: emitting
  // would append a second `user-input.resolved` row for a request the durable log
  // already records as settled. The blocked tool call is released by `finish`,
  // and that release can no longer fail — there is no emit left to lose.
  finish(
    entry,
    settlement.outcome === "answered"
      ? { outcome: "answered", requestId, questions: entry.questions, answers }
      : settlement.outcome === "superseded"
        ? { outcome: "superseded", requestId, message: settlement.message ?? "" }
        : { outcome: settlement.outcome, requestId },
  );
  return true;
};

export const cancelPiAskUserQuestions = async (threadId: ThreadId): Promise<void> => {
  const emit = emitters.get(threadId);
  // D1, both mechanisms. The emitter can be absent (unregistered before the
  // cancel ran) and, when present, its queue can already be shut down — an offer
  // to a shut-down queue resolves without delivering. Either way the terminal
  // event never reaches ingestion, so the resolution is written through the
  // command path instead. The distinguishing log line is deliberate: the audit
  // could not tell the two mechanisms apart from the canonical log alone.
  const undelivered: Array<string> = [];
  await Promise.all(
    [...pending.entries()].flatMap(([requestId, entry]) => {
      if (entry.threadId !== threadId || entry.settling || entry.outcome) return [];
      // Claim synchronously before the first await so answer and cancellation
      // cannot both emit a terminal event.
      entry.settling = true;
      return [
        (async () => {
          const delivered = emit
            ? await emit({ type: "resolved", requestId, answers: {}, cancelled: true }).catch(
                () => false,
              )
            : false;
          if (!delivered) undelivered.push(requestId);
          finish(entry, { outcome: "cancelled", requestId });
        })(),
      ];
    }),
  );
  if (undelivered.length > 0) {
    await settleUserInputRequestsDurably({
      threadId,
      resolutions: undelivered.map((requestId) => ({
        requestId,
        outcome: "cancelled" as const,
      })),
      tag: emit ? "pi-queue-shutdown-cancel" : "pi-emitter-absent-cancel",
    });
  }
};

export const waitForPiAskUserQuestion = (
  threadId: ThreadId,
  requestId: string,
  timeoutMs: number,
): Promise<PiAskUserPollResult | undefined> => {
  const entry = pending.get(requestId);
  if (!entry || entry.threadId !== threadId) return Promise.resolve(undefined);
  if (entry.outcome) {
    pending.delete(requestId);
    return Promise.resolve({ pending: false, ...entry.outcome });
  }
  return new Promise((resolve) => {
    const onOutcome = (outcome: PiAskUserOutcome) => {
      clearTimeout(timer);
      pending.delete(requestId);
      resolve({ pending: false, ...outcome });
    };
    const timer = setTimeout(() => {
      entry.listeners.delete(onOutcome);
      resolve({ pending: true, requestId });
    }, timeoutMs);
    entry.listeners.add(onOutcome);
  });
};
