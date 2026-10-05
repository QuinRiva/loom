import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { LegendListRef } from "@legendapp/list/react";
import { useEffect, useMemo, useRef } from "react";

import type { CitationHistoryPage } from "~/components/chat/useAssistantCitationTarget";
import type { MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { useLoomScrollStore } from "~/loom/loomScrollStore";

/** Matches the citation navigator's bound on how far back a jump will page. */
const MAX_HISTORY_PAGES = 20;

/**
 * Index of the last row that had already happened at the anchor instant — the
 * turn a Workstream surface is pointing at. `-1` when the anchor predates every
 * loaded row, i.e. the target is still beyond the loaded window.
 */
function resolveDispatchRowIndex(
  rows: ReadonlyArray<MessagesTimelineRow>,
  anchorAtIso: string,
): number {
  let index = -1;
  for (let i = 0; i < rows.length; i += 1) {
    const createdAt = rows[i]!.createdAt;
    if (createdAt && createdAt <= anchorAtIso) index = i;
  }
  return index;
}

/**
 * One-shot scroll-to-dispatch: a Workstream click (sub-thread card/node, wave
 * bridge, consult edge, lifecycle row) parks a request in the store; on arrival
 * we page back until the anchored turn is loaded, scroll it to the top of the
 * viewport and flash it, then clear the request. When the anchor is older than
 * anything the server will hand back we land on the first loaded row rather
 * than failing.
 */
export function useScrollToDispatch({
  rows,
  listRef,
  routeThreadKey,
  viewport,
  loadEarlier,
  onManualNavigation,
}: {
  rows: ReadonlyArray<MessagesTimelineRow>;
  listRef: React.RefObject<LegendListRef | null>;
  routeThreadKey: string;
  viewport: HTMLElement | null;
  loadEarlier: CitationHistoryPage | null;
  onManualNavigation: () => void;
}) {
  const scrollRequest = useLoomScrollStore((store) => store.scrollRequest);
  const clearScrollRequest = useLoomScrollStore((store) => store.clearScrollRequest);
  const activeThreadId = useMemo(
    () => parseScopedThreadKey(routeThreadKey)?.threadId ?? null,
    [routeThreadKey],
  );
  const requestedPages = useRef(new Set<string>());
  useEffect(() => {
    requestedPages.current = new Set();
  }, [scrollRequest]);
  useEffect(() => {
    if (!scrollRequest || scrollRequest.threadId !== activeThreadId || rows.length === 0) return;
    const index = resolveDispatchRowIndex(rows, scrollRequest.anchorAtIso);
    if (index < 0 && loadEarlier) {
      // The dispatch predates the loaded window: pull older pages (bounded, and
      // deduped per cursor so a page that yields nothing cannot loop) and let
      // the effect re-run as they arrive.
      if (loadEarlier.loading) return;
      const cursor = loadEarlier.cursor ?? rows[0]!.id;
      if (!requestedPages.current.has(cursor) && requestedPages.current.size < MAX_HISTORY_PAGES) {
        requestedPages.current.add(cursor);
        loadEarlier.onLoadEarlier();
        return;
      }
    }
    const target = rows[Math.max(index, 0)]!;
    onManualNavigation();
    const frame = window.requestAnimationFrame(() => {
      clearScrollRequest();
      void Promise.resolve(
        listRef.current?.scrollToIndex({
          index: Math.max(index, 0),
          animated: true,
          viewOffset: 8,
        }),
      ).then(() => {
        const element = (viewport ?? document).querySelector(
          `[data-loom-row-id="${CSS.escape(target.id)}"]`,
        );
        // One-shot fade, not a looping animation: the row the jump landed on has
        // to be identifiable in a wall of transcript.
        element?.animate(
          [{ backgroundColor: "rgb(139 92 246 / 0.22)" }, { backgroundColor: "transparent" }],
          { duration: 1400, easing: "ease-out" },
        );
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeThreadId,
    clearScrollRequest,
    listRef,
    loadEarlier,
    onManualNavigation,
    rows,
    scrollRequest,
    viewport,
  ]);
}
