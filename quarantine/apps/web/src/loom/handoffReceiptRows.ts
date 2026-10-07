import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { type HandoffReceiptView } from "./handoffReceipts.logic";

/**
 * loom: chronological insertion of `/handoff` receipt rows, so a handoff stays
 * where it happened rather than sliding below later conversation. Insertion
 * rather than a re-sort: the derived rows carry their own deliberate ordering
 * (a turn fold shares its anchor entry's timestamp, the working indicator has
 * none), and re-sorting could perturb it. Each receipt lands before the first
 * row that is strictly later, which puts it last — above the working indicator —
 * when nothing later exists yet.
 *
 * Applied to the derived rows rather than inside `deriveMessagesTimelineRows`,
 * so receipts stay out of the projection input upstream's streaming row reuse
 * compares shallowly (a fresh receipt array per render would defeat it).
 */
export function insertHandoffReceiptRows(
  rows: MessagesTimelineRow[],
  receipts: ReadonlyArray<HandoffReceiptView>,
): MessagesTimelineRow[] {
  if (receipts.length === 0) {
    return rows;
  }
  const result = [...rows];
  for (const receipt of receipts) {
    const row: MessagesTimelineRow = {
      kind: "handoff-receipt",
      id: `handoff-receipt:${receipt.id}`,
      createdAt: receipt.createdAt,
      receipt,
    };
    const index = result.findIndex(
      (candidate) => candidate.createdAt !== null && candidate.createdAt > receipt.createdAt,
    );
    if (index === -1) {
      const workingIndex = result.findIndex((candidate) => candidate.kind === "working");
      result.splice(workingIndex === -1 ? result.length : workingIndex, 0, row);
    } else {
      result.splice(index, 0, row);
    }
  }
  return result;
}
