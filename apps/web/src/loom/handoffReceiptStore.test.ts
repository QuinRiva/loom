import { describe, expect, it } from "vite-plus/test";
import type { ThreadId } from "@t3tools/contracts";

import {
  HANDOFF_RECEIPT_CAP,
  recordHandoffDispatch,
  recordHandoffDrafter,
  recordHandoffFailure,
  useHandoffReceiptStore,
} from "./handoffReceiptStore";

const reset = () => useHandoffReceiptStore.setState({ receipts: [] });

describe("handoffReceiptStore", () => {
  it("records a dispatch with the explanation verbatim", () => {
    reset();
    const id = recordHandoffDispatch({
      sourceThreadKey: "env:thread-1",
      explanation: "  the retry logic in FooService is broken  ",
    });

    const [receipt] = useHandoffReceiptStore.getState().receipts;
    expect(receipt?.id).toBe(id);
    // Verbatim: the receipt is the recoverable second copy of what was typed.
    expect(receipt?.explanation).toBe("  the retry logic in FooService is broken  ");
    expect(receipt?.intake).toBeNull();
    expect(receipt?.failure).toBeNull();
  });

  it("attaches the drafter intake returned and records a dispatch failure", () => {
    reset();
    const settledId = recordHandoffDispatch({ sourceThreadKey: "env:t1", explanation: "a" });
    const failedId = recordHandoffDispatch({ sourceThreadKey: "env:t1", explanation: "b" });

    const beforeAckMs = Date.now();
    recordHandoffDrafter(settledId, "drafter-1" as ThreadId);
    recordHandoffFailure(failedId, "Source thread is busy.");

    const receipts = useHandoffReceiptStore.getState().receipts;
    const acknowledged = receipts.find((entry) => entry.id === settledId);
    expect(acknowledged?.intake?.drafterThreadId).toBe("drafter-1");
    // The acknowledgement is stamped when intake returns, so the shell-replay
    // grace starts when the drafter began to exist rather than at submission.
    expect(Date.parse(acknowledged?.intake?.acknowledgedAt ?? "")).toBeGreaterThanOrEqual(
      beforeAckMs,
    );
    expect(receipts.find((entry) => entry.id === failedId)?.failure).toBe("Source thread is busy.");
  });

  it("keeps ids distinct and drops the oldest past the cap", () => {
    reset();
    const ids = Array.from({ length: HANDOFF_RECEIPT_CAP + 3 }, (_unused, index) =>
      recordHandoffDispatch({ sourceThreadKey: "env:t1", explanation: `issue ${index}` }),
    );

    const receipts = useHandoffReceiptStore.getState().receipts;
    expect(new Set(ids).size).toBe(ids.length);
    expect(receipts).toHaveLength(HANDOFF_RECEIPT_CAP);
    expect(receipts.map((receipt) => receipt.id)).toEqual(ids.slice(3));
  });
});
