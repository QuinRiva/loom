import type { SidebarThreadSummary } from "../types";

/**
 * Whether a thread is surfaced in the sidebar, command palette and `@` thread
 * mentions — the single authority so the three never disagree. A `/handoff`
 * drafter (role `handoff-drafter`) is a throwaway fork the server archives once
 * it has drafted its brief, so while alive it stays hidden UNLESS it carries
 * attention. A broken drafter (zero handoffs, hung) raises `needs_guidance` on
 * its live source thread, where the drafter stays reachable from the source's
 * Workstream graph; only when the source is gone is the drafter itself
 * flagged, and then it must surface here. Every other thread is always visible.
 */
export const isVisibleHandoffDrafter = ({
  source: { workstream },
}: Pick<SidebarThreadSummary, "source">) =>
  workstream?.role !== "handoff-drafter" || workstream.attention.length > 0;
