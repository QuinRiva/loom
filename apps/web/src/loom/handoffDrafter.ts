import type { SidebarThreadSummary } from "../types";

/**
 * Whether a thread is surfaced in the sidebar, command palette and `@` thread
 * mentions — the single authority so the three never disagree. A `/handoff`
 * drafter (role `handoff-drafter`) is a throwaway fork the server archives once
 * it has drafted its brief, so while alive it stays hidden UNLESS it carries
 * attention: the server flags a broken drafter (zero handoffs, failed turn
 * start, hung) for a human, and hiding it would strand that failure. Every
 * other thread is always visible.
 */
export const isVisibleHandoffDrafter = ({
  source: { workstream },
}: Pick<SidebarThreadSummary, "source">) =>
  workstream?.role !== "handoff-drafter" || workstream.attention.length > 0;
