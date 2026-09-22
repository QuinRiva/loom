import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import type { HandoffDestination } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadShells } from "~/state/entities";

import {
  deriveHandoffReceiptViews,
  handoffReceiptIsPending,
  type HandoffDrafterShell,
  type HandoffReceiptDestination,
  type HandoffReceiptView,
} from "./handoffReceipts.logic";
import { useHandoffReceiptStore } from "./handoffReceiptStore";

const NO_RECEIPTS: ReadonlyArray<HandoffReceiptView> = Object.freeze([]);

/** Re-derive once a second while anything is pending, so the drafter-appearance grace can expire. */
const HANDOFF_RECEIPT_TICK_MS = 1_000;

/**
 * loom: live `/handoff` receipt views.
 *
 * Settlement is read from `useThreadShells()` — role, attention and `archivedAt`
 * are already in the shell snapshot, so no new RPC or subscription is needed.
 * The staged destinations come from the same place: `goal_handoff` stamps its
 * marker on the drafter's fork SOURCE as well as the drafter, and the source is
 * never archived, so the ids survive the drafter's disappearance without a
 * second fetch. Pass `sourceThreadKey` to scope to one thread's timeline; omit
 * it for the app-root coordinator, which needs every receipt.
 */
export function useHandoffReceipts(
  sourceThreadKey?: string | null,
): ReadonlyArray<HandoffReceiptView> {
  const receipts = useHandoffReceiptStore(
    useShallow((store) =>
      sourceThreadKey === undefined
        ? store.receipts
        : store.receipts.filter((receipt) => receipt.sourceThreadKey === sourceThreadKey),
    ),
  );
  const shells = useThreadShells();
  const [nowMs, setNowMs] = useState(() => Date.now());

  // One walk of the shells resolves both halves: the drafter shells settlement
  // is derived from, and the source markers naming what each receipt staged.
  const { drafterShellsById, destinationsByReceiptId } = useMemo(() => {
    const drafterShellsById = new Map<string, HandoffDrafterShell>();
    const destinationsByReceiptId = new Map<string, ReadonlyArray<HandoffReceiptDestination>>();
    const acknowledged = receipts.flatMap((receipt) =>
      receipt.intake === null
        ? []
        : [
            {
              receiptId: receipt.id,
              drafterThreadId: receipt.intake.drafterThreadId,
              sourceThreadId: parseScopedThreadKey(receipt.sourceThreadKey)?.threadId ?? null,
            },
          ],
    );
    if (acknowledged.length === 0) {
      return { drafterShellsById, destinationsByReceiptId };
    }

    const wantedDrafters = new Set(acknowledged.map((entry) => entry.drafterThreadId));
    const wantedSources = new Set(
      acknowledged.flatMap((entry) =>
        entry.sourceThreadId === null ? [] : [entry.sourceThreadId],
      ),
    );
    const markersBySourceId = new Map<string, ReadonlyArray<HandoffDestination>>();
    for (const shell of shells) {
      if (wantedDrafters.has(shell.id)) {
        drafterShellsById.set(shell.id, {
          id: shell.id,
          archivedAt: shell.archivedAt,
          attention: shell.attention,
        });
      }
      if (wantedSources.has(shell.id)) {
        markersBySourceId.set(shell.id, shell.handoffDestinations);
      }
    }

    for (const entry of acknowledged) {
      const markers =
        entry.sourceThreadId === null ? [] : (markersBySourceId.get(entry.sourceThreadId) ?? []);
      const destinations = markers
        .filter((marker) => marker.drafterThreadId === entry.drafterThreadId)
        // A receipt has a handful of destinations at most, so scanning for each
        // title beats indexing every shell in the app on every frame.
        .map((marker) => ({
          threadId: marker.threadId,
          title: shells.find((shell) => shell.id === marker.threadId)?.title ?? null,
        }));
      if (destinations.length > 0) destinationsByReceiptId.set(entry.receiptId, destinations);
    }
    return { drafterShellsById, destinationsByReceiptId };
  }, [receipts, shells]);

  const views = useMemo(
    () =>
      receipts.length === 0
        ? NO_RECEIPTS
        : deriveHandoffReceiptViews({
            receipts,
            drafterShellsById,
            destinationsByReceiptId,
            nowMs,
          }),
    [destinationsByReceiptId, drafterShellsById, nowMs, receipts],
  );

  const anyPending = views.some((view) => handoffReceiptIsPending(view.state));
  useEffect(() => {
    if (!anyPending) {
      return;
    }
    const interval = setInterval(() => setNowMs(Date.now()), HANDOFF_RECEIPT_TICK_MS);
    return () => clearInterval(interval);
  }, [anyPending]);

  return views;
}
