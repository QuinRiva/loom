// loom: 3d-3 — the timeline mount of the Loom rows (the view is context-free).
import { memo, use } from "react";

import { TimelineRowCtx } from "~/components/chat/timelineRowContext";

import type { LoomPromotionRow, LoomTimelineRow as LoomTimelineRowData } from "./loomTimelineRows";
import { LoomPromotionRowView, LoomTimelineRowView } from "./LoomTimelineRowView";

export const LoomTimelineRow = memo(function LoomTimelineRow({
  row,
}: {
  row: LoomTimelineRowData | LoomPromotionRow;
}) {
  const environmentId = use(TimelineRowCtx).activeThreadEnvironmentId;
  return row.kind === "loom-promotion" ? (
    <LoomPromotionRowView row={row} environmentId={environmentId} />
  ) : (
    <LoomTimelineRowView row={row} environmentId={environmentId} />
  );
});
