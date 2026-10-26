import type { SidebarThreadSummary } from "../types";

/**
 * The single authority on whether a thread shows in the sidebar, command palette and `@` mentions.
 * A live `/handoff` drafter is a throwaway fork, hidden unless it carries attention: a broken one
 * flags its live source thread (reachable via its "Open drafter" chip), and is flagged itself, so
 * surfaces here, only once the source is gone. Every other thread is always visible.
 */
export const isVisibleHandoffDrafter = ({
  source: { workstream },
}: Pick<SidebarThreadSummary, "source">) =>
  workstream?.role !== "handoff-drafter" || workstream.attention.length > 0;
