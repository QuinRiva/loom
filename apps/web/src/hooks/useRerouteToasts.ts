import { useEffect, useRef } from "react";
import type { OrchestrationThreadActivity, ScopedThreadRef } from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";

const readMessage = (payload: unknown): string | undefined =>
  typeof payload === "object" && payload !== null && "message" in payload
    ? String((payload as { message: unknown }).message)
    : undefined;

/**
 * Raise a toast when a `model.rerouted` activity newly arrives for the visible
 * thread — both directions (onto a fallback and back to the intended model), per
 * user decision D1. The event's reason string names the exhausted window and
 * reset time. Historical reroutes present when a thread is first opened are
 * seeded silently; only reroutes that land while the thread is open toast.
 */
export function useRerouteToasts(
  threadRef: ScopedThreadRef | null,
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): void {
  const seenRef = useRef<{ key: string; ids: Set<string> } | null>(null);
  const key = threadRef ? `${threadRef.environmentId}:${threadRef.threadId}` : "";

  useEffect(() => {
    if (!threadRef) return;
    const reroutes = activities.filter((activity) => activity.kind === "model.rerouted");
    // Reseed silently on first pass or when switching threads.
    if (seenRef.current?.key !== key) {
      seenRef.current = { key, ids: new Set(reroutes.map((activity) => activity.id)) };
      return;
    }
    const seen = seenRef.current.ids;
    for (const activity of reroutes) {
      if (seen.has(activity.id)) continue;
      seen.add(activity.id);
      toastManager.add(
        stackedThreadToast({
          type: "info",
          title: activity.summary,
          ...(readMessage(activity.payload) !== undefined
            ? { description: readMessage(activity.payload) }
            : {}),
          data: { threadRef },
        }),
      );
    }
  }, [activities, key, threadRef]);
}
