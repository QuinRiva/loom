// loom: 3d-3 — the timeline mount of the Loom rows (the view is context-free).
import { memo, use } from "react";

import { TimelineRowCtx } from "~/components/chat/MessagesTimeline";

import type { LoomTimelineRow as LoomTimelineRowData } from "./loomTimelineRows";
import { LoomTimelineRowView } from "./LoomTimelineRowView";

export const LoomTimelineRow = memo(function LoomTimelineRow({ row }: { row: LoomTimelineRowData }) {
  return <LoomTimelineRowView row={row} environmentId={use(TimelineRowCtx).activeThreadEnvironmentId} />;
});
