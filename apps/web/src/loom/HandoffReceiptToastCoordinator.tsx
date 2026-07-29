import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { buildThreadRouteParams, resolveThreadRouteRef } from "~/threadRoutes";

import { deriveHandoffReceiptToastPushes, type HandoffReceiptState } from "./handoffReceipts.logic";
import { useHandoffReceipts } from "./useHandoffReceipts";

/**
 * loom: away-from-source surfacing for `/handoff`.
 *
 * The receipt row in the source thread is the primary feedback surface, but it
 * unmounts the moment the human navigates elsewhere. This root-level coordinator
 * is the backstop for exactly that case, and it deliberately does NOT mirror the
 * row:
 *
 * - **failure always** — a broken handoff must reach the human wherever they
 *   are. The durable failure artefact (an unarchived drafter root flagged
 *   "Needs Attention" in the sidebar) can easily be off-screen.
 * - **success only when the source thread is not on screen** — otherwise the row
 *   has already settled in front of them and a toast is pure noise.
 *
 * Unlike `TurnFailureToastCoordinator` it needs no baseline-suppression pass:
 * that coordinator reads server state, where the first snapshot can be full of
 * pre-existing failures, whereas the receipt store is browser-local and empty at
 * mount, so every receipt seen here was submitted in this session.
 */
export function HandoffReceiptToastCoordinator() {
  const views = useHandoffReceipts();
  const navigate = useNavigate();
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadKey = routeThreadRef === null ? null : scopedThreadKey(routeThreadRef);
  const previousStatesRef = useRef<Map<string, HandoffReceiptState>>(new Map());

  useEffect(() => {
    const pushes = deriveHandoffReceiptToastPushes({
      previousStates: previousStatesRef.current,
      views,
      activeThreadKey,
    });
    previousStatesRef.current = new Map(views.map((view) => [view.id, view.state]));

    for (const push of pushes) {
      const drafterThreadId = push.drafterThreadId;
      // The drafter lives in the same environment as the source thread it forked.
      const sourceEnvironmentId = parseScopedThreadKey(push.sourceThreadKey)?.environmentId ?? null;
      toastManager.add(
        stackedThreadToast(
          push.kind === "failure"
            ? {
                type: "error",
                title: "Handoff needs you",
                // A STRING, deliberately: the toast only renders its "Copy"
                // affordance for string descriptions, and once the source thread
                // is unmounted this toast is the last on-screen copy of the
                // explanation. Copyability beats richer formatting here.
                description: `${push.failureReason ?? "The handoff did not complete."} — ${push.explanation}`,
                timeout: 0,
                ...(drafterThreadId !== null && sourceEnvironmentId !== null
                  ? {
                      actionProps: {
                        children: "Open drafter",
                        onClick: () => {
                          void navigate({
                            to: "/$environmentId/$threadId",
                            params: buildThreadRouteParams(
                              scopeThreadRef(sourceEnvironmentId, drafterThreadId),
                            ),
                          });
                        },
                      },
                    }
                  : {}),
              }
            : {
                type: "success",
                title: "Handed off",
                description: `Staged as its own goal — ${push.explanation}`,
              },
        ),
      );
    }
  }, [activeThreadKey, navigate, views]);

  return null;
}
