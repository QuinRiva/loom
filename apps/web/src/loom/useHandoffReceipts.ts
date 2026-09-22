import type { ScopedThreadRef } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadShells } from "~/state/entities";

import {
  deriveAgentHandoffViews,
  deriveHandoffReceiptViews,
  handoffReceiptIsPending,
  resolveHandoffReceiptShells,
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

  const { drafterShellsByReceiptId, destinationsByReceiptId } = useMemo(
    () => resolveHandoffReceiptShells({ receipts, shells }),
    [receipts, shells],
  );

  const views = useMemo(
    () =>
      receipts.length === 0
        ? NO_RECEIPTS
        : deriveHandoffReceiptViews({
            receipts,
            drafterShellsByReceiptId,
            destinationsByReceiptId,
            nowMs,
          }),
    [destinationsByReceiptId, drafterShellsByReceiptId, nowMs, receipts],
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

/**
 * loom: the durable companion — rows for handoffs THIS thread's own agent
 * placed with `goal_handoff`. Entirely shell-derived, so it survives a reload
 * and needs no receipt store, no grace window and no clock: the marker only
 * exists once the destination does.
 */
export function useAgentHandoffViews(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<HandoffReceiptView> {
  const shells = useThreadShells();
  return useMemo(() => deriveAgentHandoffViews({ threadRef, shells }), [shells, threadRef]);
}
