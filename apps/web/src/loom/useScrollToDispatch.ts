import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useEffect, useMemo } from "react";
import { type LegendListRef } from "@legendapp/list/react";
import { type MessagesTimelineRow } from "~/components/chat/MessagesTimeline.logic";
import { useLoomScrollStore } from "~/loom/loomScrollStore";

/**
 * One-shot scroll-to-dispatch: a Workstream graph click (bridge node or
 * consult edge) parks a request in the store; on arrival we scroll to the row
 * dispatched at-or-before the anchor, then clear it. The consult edge also
 * parks a `consultReveal` that the matching ConsultCard consumes to expand.
 */
export function useScrollToDispatch(
  rows: ReadonlyArray<MessagesTimelineRow>,
  listRef: React.RefObject<LegendListRef | null>,
  routeThreadKey: string,
) {
  const scrollRequest = useLoomScrollStore((store) => store.scrollRequest);
  const clearScrollRequest = useLoomScrollStore((store) => store.clearScrollRequest);
  const activeThreadId = useMemo(
    () => parseScopedThreadKey(routeThreadKey)?.threadId ?? null,
    [routeThreadKey],
  );
  useEffect(() => {
    if (!scrollRequest || scrollRequest.threadId !== activeThreadId || rows.length === 0) {
      return;
    }
    let index = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const createdAt = rows[i]!.createdAt;
      if (createdAt && createdAt <= scrollRequest.anchorAtIso) index = i;
    }
    const frameId = window.requestAnimationFrame(() => {
      void listRef.current?.scrollToIndex?.({ index, viewPosition: 0, animated: true });
      clearScrollRequest();
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [scrollRequest, activeThreadId, rows, clearScrollRequest, listRef]);
}
