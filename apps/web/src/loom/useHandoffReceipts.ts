import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useThreadShells } from "~/state/entities";

import {
  deriveHandoffReceiptViews,
  handoffReceiptIsPending,
  type HandoffDrafterShell,
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
 * Pass `sourceThreadKey` to scope to one thread's timeline; omit it for the
 * app-root coordinator, which needs every receipt.
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

  const drafterShellsById = useMemo(() => {
    const wanted = new Set(
      receipts
        .map((receipt) => receipt.intake?.drafterThreadId ?? null)
        .filter((id): id is NonNullable<typeof id> => id !== null),
    );
    const byId = new Map<string, HandoffDrafterShell>();
    if (wanted.size === 0) {
      return byId;
    }
    for (const shell of shells) {
      if (wanted.has(shell.id)) {
        byId.set(shell.id, {
          id: shell.id,
          archivedAt: shell.archivedAt,
          attention: shell.attention,
        });
      }
    }
    return byId;
  }, [receipts, shells]);

  const views = useMemo(
    () =>
      receipts.length === 0
        ? NO_RECEIPTS
        : deriveHandoffReceiptViews({ receipts, drafterShellsById, nowMs }),
    [drafterShellsById, nowMs, receipts],
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
