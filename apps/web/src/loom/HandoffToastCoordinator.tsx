import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { useEnvironmentIds } from "~/state/environments";
import { environmentSnapshotAtom } from "~/state/shell";
import { buildThreadRouteParams } from "~/threadRoutes";

import { handoffReceiptRows, type LoomTimelineRow } from "./loomTimelineRows";
import { HANDOFF_FAILURE_REASON } from "./LoomTimelineRowView";

/**
 * loom: the away-from-thread backstop for `/handoff`. The receipt row in the
 * source thread is the primary surface; this toasts a drafter's settlement
 * observed in this session — a failure always (it must reach the human
 * wherever they are), a success only when the source thread is not on screen.
 * The first snapshot only seeds, so a reload never replays old handoffs.
 */
export function HandoffToastCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <EnvironmentHandoffToasts key={environmentId} environmentId={environmentId} />
  ));
}

function EnvironmentHandoffToasts({ environmentId }: { environmentId: EnvironmentId }) {
  const threads = useAtomValue(environmentSnapshotAtom(environmentId))?.threads;
  const activeThreadId = useParams({ strict: false }).threadId;
  const navigate = useNavigate();
  const previous = useRef<ReadonlyMap<string, LoomTimelineRow> | null>(null);

  useEffect(() => {
    if (!threads) return;
    const prior = previous.current ?? new Map<string, LoomTimelineRow>();
    const sources = new Set([
      ...threads.flatMap((thread) =>
        thread.workstream?.role === "handoff-drafter" && thread.workstream.forkFromThreadId
          ? [thread.workstream.forkFromThreadId]
          : [],
      ),
      ...[...prior.values()].map((row) => row.sourceThreadId),
    ]);
    const rows = [...sources].flatMap((source) =>
      handoffReceiptRows(threads, source).filter((row) => row.drafterThreadId !== null),
    );
    previous.current = new Map(rows.map((row) => [row.id, row]));
    const open = (threadId: ThreadId) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
      });
    for (const row of rows) {
      const before = prior.get(row.id);
      if (before?.state !== "drafting" || row.state === "drafting") continue;
      const explanation = row.explanation ?? before.explanation;
      if (row.state === "failed") {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Handoff needs you",
            // A string, so the toast offers Copy: the explanation's last on-screen copy.
            description: `${HANDOFF_FAILURE_REASON}${explanation ? ` — ${explanation}` : ""}`,
            timeout: 0,
            actionProps: { children: "Open drafter", onClick: () => open(row.drafterThreadId!) },
          }),
        );
      } else if (row.sourceThreadId !== activeThreadId) {
        const [first] = row.destinations;
        toastManager.add(
          stackedThreadToast({
            type: "success",
            title: "Handed off",
            description: row.destinations
              .map((destination) => destination.title ?? "a new goal")
              .join(", "),
            ...(first
              ? { actionProps: { children: "Open", onClick: () => open(first.threadId) } }
              : {}),
          }),
        );
      }
    }
  }, [activeThreadId, environmentId, navigate, threads]);

  return null;
}
