// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// LOOM-ONLY. In-memory rendezvous between the pi ask_user_question HTTP tool
// and PiDriver's canonical runtime-event/answer path. Pending input is
// intentionally no more durable than every other provider's live Deferred.
import * as NodeCrypto from "node:crypto";

import type { ProviderUserInputAnswers, ThreadId, UserInputQuestion } from "@t3tools/contracts";

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
      readonly outcome: "cancelled";
      readonly requestId: string;
    }
  | {
      readonly outcome: "could_not_present";
    };

export type PiAskUserPollResult =
  | { readonly pending: true; readonly requestId: string }
  | ({ readonly pending: false } & PiAskUserOutcome);

type Emit = (event: PiAskUserBrokerEvent) => Promise<void>;

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

export const resolvePiAskUserQuestion = async (
  threadId: ThreadId,
  requestId: string,
  answers: ProviderUserInputAnswers,
): Promise<boolean> => {
  const entry = pending.get(requestId);
  if (!entry || entry.threadId !== threadId) return false;
  // The broker owns this id even when another answer/cancel already claimed
  // settlement; absorb duplicate/racing UI responses instead of falling
  // through to PiDriver's unrelated legacy-dialog path.
  if (entry.settling || entry.outcome) return true;
  const emit = emitters.get(threadId);
  if (!emit) return false;
  entry.settling = true;
  try {
    await emit({ type: "resolved", requestId, answers, cancelled: false });
  } catch (error) {
    entry.settling = false;
    throw error;
  }
  finish(entry, { outcome: "answered", requestId, questions: entry.questions, answers });
  return true;
};

export const cancelPiAskUserQuestions = async (threadId: ThreadId): Promise<void> => {
  const emit = emitters.get(threadId);
  await Promise.all(
    [...pending.entries()].flatMap(([requestId, entry]) => {
      if (entry.threadId !== threadId || entry.settling || entry.outcome) return [];
      // Claim synchronously before the first await so answer and cancellation
      // cannot both emit a terminal event.
      entry.settling = true;
      return [
        (async () => {
          if (emit)
            await emit({ type: "resolved", requestId, answers: {}, cancelled: true }).catch(
              () => undefined,
            );
          finish(entry, { outcome: "cancelled", requestId });
        })(),
      ];
    }),
  );
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
