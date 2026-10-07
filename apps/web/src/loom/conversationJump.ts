/**
 * "Show me where this happened" (W3, V1's scroll-to-dispatch): a Workstream
 * surface parks a one-shot anchor — a thread and an instant — and opens that
 * thread; its timeline consumes the anchor on arrival. It pages back until the
 * anchored moment is loaded, unfolds the turn that holds it, scrolls the row
 * at or before that instant into view and flashes it once. The anchor of a
 * dispatch is the child's creation, inside the parent's spawn call.
 *
 * @module loom/conversationJump
 */
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LegendListRef } from "@legendapp/list/react";
import type { RunId } from "@t3tools/contracts";
import { type RefObject, useEffect, useMemo, useRef } from "react";
import { create } from "zustand";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";
import type { MessagesTimelineHistoryControls } from "../components/chat/MessagesTimeline";
import type { ConversationAnchor } from "../lib/workstreamPresentation";
import type { TimelineEntry } from "../session-logic";

/** Matches the citation navigator's bound on how far back a jump pages. */
const MAX_HISTORY_PAGES = 20;

export const useConversationJumpStore = create<{
  readonly request: ConversationAnchor | null;
  readonly setRequest: (request: ConversationAnchor | null) => void;
}>((set) => ({ request: null, setRequest: (request) => set({ request }) }));

const entryRunId = (entry: TimelineEntry): RunId | null =>
  (entry.kind === "message"
    ? entry.message.runId
    : entry.kind === "work"
      ? entry.entry.runId
      : entry.kind === "event"
        ? entry.projectedItem.item.runId
        : entry.kind === "html-render"
          ? entry.runId
          : null) ?? null;

/**
 * Consume a parked anchor for the timeline of `routeThreadKey`. True while one
 * is pending here, so the timeline skips restoring its remembered position.
 */
export function useConversationJump({
  rows,
  entries,
  listRef,
  routeThreadKey,
  history,
  onExpandRun,
  onManualNavigation,
}: {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly entries: ReadonlyArray<TimelineEntry>;
  readonly listRef: RefObject<LegendListRef | null>;
  readonly routeThreadKey: string;
  readonly history: MessagesTimelineHistoryControls | undefined;
  readonly onExpandRun: (runId: RunId) => void;
  readonly onManualNavigation: () => void;
}): boolean {
  const request = useConversationJumpStore((store) => store.request);
  const threadId = useMemo(
    () => parseScopedThreadKey(routeThreadKey)?.threadId ?? null,
    [routeThreadKey],
  );
  // Per request: the history cursors already paged and the turns already unfolded.
  const tried = useRef({ request, pages: new Set<string>(), runs: new Set<RunId>() });
  const pending = request !== null && request.threadId === threadId;

  useEffect(() => {
    if (request === null || request.threadId !== threadId || rows.length === 0) return;
    if (tried.current.request !== request)
      tried.current = { request, pages: new Set(), runs: new Set() };
    const { at } = request;
    const target = entries.findLast((entry) => entry.createdAt <= at);
    if (target === undefined && history?.hasMoreHistory) {
      if (history.loading) return;
      const cursor = entries[0]?.id ?? "";
      if (!tried.current.pages.has(cursor) && tried.current.pages.size < MAX_HISTORY_PAGES) {
        tried.current.pages.add(cursor);
        history.onLoadEarlier();
        return;
      }
    }
    const runId = target === undefined ? null : entryRunId(target);
    if (
      runId !== null &&
      !tried.current.runs.has(runId) &&
      rows.some((row) => row.kind === "turn-fold" && row.runId === runId && !row.expanded)
    ) {
      tried.current.runs.add(runId);
      onExpandRun(runId);
      return;
    }
    const index = Math.max(
      0,
      rows.findLastIndex((row) => row.createdAt !== null && row.createdAt <= at),
    );
    const row = rows[index]!;
    // Stop live-follow first, then scroll two frames later: the timeline must
    // have re-rendered without pinning to the end, or it snaps straight back.
    onManualNavigation();
    let frame = window.requestAnimationFrame(() => {
      frame = window.requestAnimationFrame(() => {
        useConversationJumpStore.getState().setRequest(null);
        void Promise.resolve(
          listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.3 }),
        ).then(() => {
          // One-shot fade, not a looping animation: the row the jump landed on
          // has to stand out in a wall of transcript.
          listRef.current
            ?.getScrollableNode()
            ?.querySelector(`[data-timeline-row-id="${CSS.escape(row.id)}"]`)
            ?.animate(
              [
                { backgroundColor: "color-mix(in srgb, var(--color-info) 22%, transparent)" },
                { backgroundColor: "transparent" },
              ],
              { duration: 1400, easing: "ease-out" },
            );
        });
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [entries, history, listRef, onExpandRun, onManualNavigation, request, rows, threadId]);

  return pending;
}
