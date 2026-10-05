import { ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  cancelPiAskUserQuestions,
  openPiAskUserQuestion,
  PI_ASK_USER_SETTLED_RETENTION_MS,
  registerPiAskUserEmitter,
  resolvePiAskUserQuestion,
  waitForPiAskUserQuestion,
  type PiAskUserBrokerEvent,
} from "./askUserBroker.ts";

const questions = (requestId: string) => [
  {
    id: `${requestId}:1`,
    header: "Choice",
    question: "Continue?",
    options: [
      { label: "Yes", description: "Continue" },
      { label: "No", description: "Stop" },
    ],
    multiSelect: false,
  },
];

afterEach(() => vi.useRealTimers());

describe("pi ask-user broker settlement", () => {
  it("atomically lets cancellation win a racing human answer", async () => {
    const threadId = ThreadId.make("broker-race-thread");
    const events: PiAskUserBrokerEvent[] = [];
    let releaseResolved!: () => void;
    const resolvedGate = new Promise<void>((resolve) => {
      releaseResolved = resolve;
    });
    const unregister = registerPiAskUserEmitter(threadId, async (event) => {
      events.push(event);
      if (event.type === "resolved") await resolvedGate;
      return true;
    });

    const opened = await openPiAskUserQuestion(threadId, questions);
    if ("outcome" in opened) throw new Error("Expected a registered emitter.");
    const cancellation = cancelPiAskUserQuestions(threadId);
    // Cancellation claimed the record synchronously before awaiting its event.
    expect(resolvePiAskUserQuestion(threadId, opened.requestId, { answer: "Yes" })).toBe(true);
    releaseResolved();
    await cancellation;

    expect(events.filter((event) => event.type === "resolved")).toHaveLength(1);
    expect(await waitForPiAskUserQuestion(threadId, opened.requestId, 1)).toEqual({
      pending: false,
      outcome: "cancelled",
      requestId: opened.requestId,
    });
    unregister();
  });

  it("removes an uncollected terminal tombstone after bounded retention", async () => {
    vi.useFakeTimers();
    const threadId = ThreadId.make("broker-tombstone-thread");
    const unregister = registerPiAskUserEmitter(threadId, async () => true);
    const opened = await openPiAskUserQuestion(threadId, questions);
    if ("outcome" in opened) throw new Error("Expected a registered emitter.");

    // No poll is waiting when process/session cancellation settles the record.
    await cancelPiAskUserQuestions(threadId);
    await vi.advanceTimersByTimeAsync(PI_ASK_USER_SETTLED_RETENTION_MS);
    expect(await waitForPiAskUserQuestion(threadId, opened.requestId, 1)).toBeUndefined();
    unregister();
  });
});
