import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useThreadShells } from "../state/entities";
import { buildThreadRouteParams } from "../threadRoutes";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Global cross-thread failure surfacing: the in-thread error banner and
 * sidebar error state only help when that thread is open, so raise a toast
 * whenever ANY thread's session transitions into `error` (a failed turn,
 * runtime error, or dead provider process), naming the thread and offering a
 * jump to it. Transitions only — the first observed snapshot is a baseline so
 * a reload/reconnect never re-toasts pre-existing failures, and retries or
 * warnings (which never set session `error`) never toast.
 */
export function TurnFailureToastCoordinator() {
  const threads = useThreadShells();
  const navigate = useNavigate();
  const previousStatusesRef = useRef<ReadonlyMap<string, string> | null>(null);

  useEffect(() => {
    const previous = previousStatusesRef.current;
    const next = new Map<string, string>();
    for (const thread of threads) {
      const key = `${thread.environmentId}:${thread.id}`;
      const status = thread.session?.status ?? "none";
      next.set(key, status);
      const before = previous?.get(key);
      if (previous === null || before === undefined || before === "error" || status !== "error") {
        continue;
      }
      const threadRef = scopeThreadRef(thread.environmentId, thread.id);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Thread failed: ${thread.title}`,
          description: thread.session?.lastError ?? "Provider turn failed.",
          timeout: 0,
          actionProps: {
            children: "Open thread",
            onClick: () => {
              void navigate({
                to: "/$environmentId/$threadId",
                params: buildThreadRouteParams(threadRef),
              });
            },
          },
        }),
      );
    }
    previousStatusesRef.current = next;
  }, [threads, navigate]);

  return null;
}
