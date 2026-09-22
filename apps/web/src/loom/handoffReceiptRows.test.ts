import { describe, expect, it } from "vite-plus/test";

import {
  computeStableMessagesTimelineRows,
  deriveMessagesTimelineRows,
} from "~/components/chat/MessagesTimeline.logic";
import type { HandoffReceiptView } from "./handoffReceipts.logic";
import { insertHandoffReceiptRows } from "./handoffReceiptRows";

const userMessage = {
  id: "u1" as never,
  role: "user" as const,
  text: "hello",
  turnId: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  streaming: false,
};

const receipt: HandoffReceiptView = {
  id: "handoff_1",
  sourceThreadKey: "env:thread-1",
  state: "drafting" as const,
  explanation: "the retry logic in FooService is broken",
  createdAt: "2026-01-01T00:00:30Z",
  drafterThreadId: "drafter-1" as never,
  destinations: [],
  failureReason: null,
};

const baseInput = {
  isWorking: false,
  activeTurnStartedAt: null,
  turnDiffSummaries: [],
  supportsConversationRollback: false,
};

const messageEntry = (id: string, createdAt: string) => ({
  id,
  kind: "message" as const,
  createdAt,
  message: { ...userMessage, id: id as never, createdAt, updatedAt: createdAt },
});

describe("handoff receipt rows", () => {
  it("emits a presentation-only receipt row that carries no message", () => {
    const rows = insertHandoffReceiptRows(
      deriveMessagesTimelineRows({ ...baseInput, timelineEntries: [] }),
      [receipt],
    );

    expect(rows).toEqual([
      {
        kind: "handoff-receipt",
        id: "handoff-receipt:handoff_1",
        createdAt: receipt.createdAt,
        receipt,
      },
    ]);
    // The row family it joins has no `ChatMessage`, which is the whole safety
    // property: the provider is only ever sent messages, so a receipt cannot
    // become a turn.
    expect(rows[0]).not.toHaveProperty("message");
  });

  it("places the receipt in submission order relative to messages", () => {
    const rows = insertHandoffReceiptRows(
      deriveMessagesTimelineRows({
        ...baseInput,
        timelineEntries: [
          messageEntry("e1", "2026-01-01T00:00:00Z"),
          messageEntry("e2", "2026-01-01T00:01:00Z"),
        ],
      }),
      [receipt],
    );

    expect(rows.map((row) => row.id)).toEqual(["e1", "handoff-receipt:handoff_1", "e2"]);
  });

  it("keeps the live tail last when a receipt is the newest row", () => {
    const rows = insertHandoffReceiptRows(
      deriveMessagesTimelineRows({
        ...baseInput,
        isWorking: true,
        activeTurnStartedAt: "2026-01-01T00:00:10Z",
        timelineEntries: [messageEntry("e1", "2026-01-01T00:00:00Z")],
      }),
      [receipt],
    );

    expect(rows.map((row) => row.kind)).toEqual([
      "message",
      "handoff-receipt",
      "working",
      "thinking",
    ]);
  });

  it("reuses the previous row object while the receipt is unchanged", () => {
    const derive = (receipts: ReadonlyArray<HandoffReceiptView>) =>
      insertHandoffReceiptRows(
        deriveMessagesTimelineRows({ ...baseInput, timelineEntries: [] }),
        receipts,
      );
    const initial = computeStableMessagesTimelineRows(derive([receipt]), {
      byId: new Map(),
      result: [],
    });

    expect(computeStableMessagesTimelineRows(derive([{ ...receipt }]), initial)).toBe(initial);
    expect(
      computeStableMessagesTimelineRows(derive([{ ...receipt, state: "settled" }]), initial),
    ).not.toBe(initial);
  });
});
