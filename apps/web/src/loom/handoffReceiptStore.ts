import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * loom: `/handoff` receipts — the immediate, source-local acknowledgement that
 * a handoff is under way (recap `recaps/handoff-feedback-comparison/recap.mdx`,
 * decision 1).
 *
 * `/handoff` deliberately writes NOTHING to the source thread: no message, no
 * turn, no provider context. Without a receipt the keystroke is therefore
 * indistinguishable from a no-op until (and unless) a staged destination thread
 * appears somewhere else in the sidebar. This store holds the facts a receipt
 * needs — the verbatim explanation, when it was submitted, which drafter the
 * server created, and any dispatch failure — and nothing derived: the receipt's
 * *state* is derived from live thread shells in `handoffReceipts.logic.ts`, so
 * there is no second copy of settlement truth to drift.
 *
 * **Lifetime: this browser session only.** Deliberately NOT persisted:
 *
 * - server-durable handoff history was explicitly deferred to its own funded
 *   decision, and a persisted client row would quietly become that feature's
 *   unversioned data model;
 * - the mockup's worst defect was a reloaded row stuck on "forking" forever.
 *   An in-memory receipt makes that state unreachable: after a reload there is
 *   no row to be stuck, and the durable surfaces take over — a healthy handoff
 *   leaves a staged destination thread, a broken one leaves an unarchived
 *   drafter root flagged `needs_guidance` (which the sidebar already ranks as
 *   "Needs Attention").
 *
 * Tier 4-adjacent under `docs/architecture/loom-ui-state-tiers.md`: transient
 * state that outlives one component (the coordinator at the app root and the
 * timeline row both read it) but must not outlive the page.
 */
/**
 * What intake returned, and WHEN it returned it — one nullable object rather
 * than two independently-nullable fields.
 *
 * That shape is deliberate: the drafter id and the acknowledgement time must
 * never disagree about whether intake has happened. The appearance grace in
 * `handoffReceipts.logic.ts` is measured from `acknowledgedAt`, so an id present
 * without its timestamp would silently fall back to the wrong clock. Making them
 * one value makes that state unrepresentable instead of merely unlikely.
 */
export interface HandoffReceiptIntake {
  readonly drafterThreadId: ThreadId;
  /** When the server acknowledged intake — NOT when the human pressed Enter. */
  readonly acknowledgedAt: string;
}

export interface HandoffReceipt {
  readonly id: string;
  /** `scopedThreadKey` of the thread the human typed `/handoff` in. */
  readonly sourceThreadKey: string;
  /** The human's explanation, verbatim — never truncated in the store. */
  readonly explanation: string;
  /** When the human submitted. Drives row ordering, never settlement timing. */
  readonly createdAt: string;
  /** Set once intake acknowledges; null while the RPC is still in flight. */
  readonly intake: HandoffReceiptIntake | null;
  /** Terminal dispatch failure (intake rejected/failed); null otherwise. */
  readonly failure: string | null;
}

/**
 * A long session should not accumulate receipts without bound. Older entries
 * are dropped oldest-first; the durable destination/drafter surfaces are the
 * real history.
 */
export const HANDOFF_RECEIPT_CAP = 20;

interface HandoffReceiptStoreState {
  readonly receipts: ReadonlyArray<HandoffReceipt>;
  /** Records a submitted `/handoff` and returns the new receipt's id. */
  readonly recordDispatch: (input: {
    readonly sourceThreadKey: string;
    readonly explanation: string;
  }) => string;
  /** Intake acknowledged: the server created this drafter. */
  readonly recordDrafter: (receiptId: string, drafterThreadId: ThreadId) => void;
  /** Intake failed: the handoff never reached a drafter. */
  readonly recordFailure: (receiptId: string, message: string) => void;
}

// Receipt ids only have to be unique within one page's lifetime (the store is
// never persisted), so a monotonic sequence is enough — same convention as
// `newElementContextId`.
let nextHandoffReceiptSequence = 0;

export const useHandoffReceiptStore = create<HandoffReceiptStoreState>((set) => ({
  receipts: [],

  recordDispatch: ({ sourceThreadKey, explanation }) => {
    nextHandoffReceiptSequence += 1;
    const receipt: HandoffReceipt = {
      id: `handoff_${nextHandoffReceiptSequence.toString(36)}`,
      sourceThreadKey,
      explanation,
      createdAt: new Date().toISOString(),
      intake: null,
      failure: null,
    };
    set((state) => ({
      receipts: [...state.receipts, receipt].slice(-HANDOFF_RECEIPT_CAP),
    }));
    return receipt.id;
  },

  recordDrafter: (receiptId, drafterThreadId) =>
    set((state) => ({
      receipts: state.receipts.map((receipt) =>
        receipt.id === receiptId
          ? {
              ...receipt,
              // Stamped HERE, not at dispatch: the shell-replay grace must start
              // when the drafter began to exist, otherwise a slow intake burns
              // the whole window before the drafter could possibly appear.
              intake: { drafterThreadId, acknowledgedAt: new Date().toISOString() },
            }
          : receipt,
      ),
    })),

  recordFailure: (receiptId, message) =>
    set((state) => ({
      receipts: state.receipts.map((receipt) =>
        receipt.id === receiptId ? { ...receipt, failure: message } : receipt,
      ),
    })),
}));

export function recordHandoffDispatch(input: {
  readonly sourceThreadKey: string;
  readonly explanation: string;
}): string {
  return useHandoffReceiptStore.getState().recordDispatch(input);
}

export function recordHandoffDrafter(receiptId: string, drafterThreadId: ThreadId): void {
  useHandoffReceiptStore.getState().recordDrafter(receiptId, drafterThreadId);
}

export function recordHandoffFailure(receiptId: string, message: string): void {
  useHandoffReceiptStore.getState().recordFailure(receiptId, message);
}
