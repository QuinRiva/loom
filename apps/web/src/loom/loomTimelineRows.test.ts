import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";

import { insertLoomTimelineRows, promotionReceiptRows } from "./loomTimelineRows";

const at = (minute: number) => `2026-11-04T12:${String(minute).padStart(2, "0")}:00.000Z`;
const message = (id: string, role: "user" | "assistant", minute: number) =>
  ({ kind: "message", id, createdAt: at(minute), message: { role } }) as MessagesTimelineRow;

describe("promotion receipts", () => {
  it("land under the promote turn's reply, before the next human message", () => {
    const query = {
      id: "query" as ThreadId,
      workstream: {
        forkFromThreadId: "author" as ThreadId,
        documentQuery: {
          promotions: [{ promotionId: "promotion:1", promotedAt: at(4), exchangeAt: at(1) }],
        },
      },
    } as unknown as OrchestrationV2ThreadShell;
    const timeline = [
      message("question", "user", 1),
      message("promote", "user", 3),
      message("reply", "assistant", 5),
    ];
    const ids = (rows: MessagesTimelineRow[]) => rows.map((row) => row.id);
    const receipts = promotionReceiptRows(query);
    expect(ids(insertLoomTimelineRows(timeline, receipts))).toEqual([
      "question",
      "promote",
      "reply",
      "loom-promotion:promotion:1",
    ]);
    expect(
      ids(insertLoomTimelineRows([...timeline, message("next", "user", 7)], receipts)),
    ).toEqual(["question", "promote", "reply", "loom-promotion:promotion:1", "next"]);
  });
});
