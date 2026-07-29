import type { ThreadId } from "@t3tools/contracts";

import type { HandoffReceipt } from "./handoffReceiptStore";

/**
 * loom: `/handoff` receipt presentation — the derivation layer between the
 * browser-local receipt facts (`handoffReceiptStore.ts`) and the two surfaces
 * that render them: the source thread's timeline row and the app-root toast
 * coordinator. Pure, so both surfaces agree by construction.
 */

/** Minimum of a thread shell this derivation needs. No new RPC: `useThreadShells()` already carries all of it. */
export interface HandoffDrafterShell {
  readonly id: ThreadId;
  readonly archivedAt: string | null;
  readonly attention: ReadonlyArray<string>;
}

export type HandoffReceiptState = "dispatching" | "drafting" | "settled" | "failed";

export interface HandoffReceiptView {
  readonly id: string;
  readonly sourceThreadKey: string;
  readonly state: HandoffReceiptState;
  /** The human's explanation, verbatim and never truncated. */
  readonly explanation: string;
  readonly createdAt: string;
  /** Present once intake acknowledged; the only navigable artefact this increment exposes. */
  readonly drafterThreadId: ThreadId | null;
  /** Why it failed — a dispatch error, or the drafter placing no handoff at all. */
  readonly failureReason: string | null;
}

/**
 * How long a just-acknowledged drafter may be missing from the shell snapshot
 * before absence is read as success.
 *
 * Absence is genuinely ambiguous: a settled drafter is archived and archived
 * threads are filtered out of the snapshot (`archived_at IS NULL`), so "gone"
 * normally means "handed off" — but a drafter the server has only just created
 * is also briefly absent until its shell event replays. Reading that initial gap
 * as success would flash a false "handed off" (and, when the human has navigated
 * away, push a false success toast) on every handoff.
 *
 * A short grace resolves both directions without a latch, and — unlike the
 * mockup, whose reloaded row stayed on "forking" forever — it makes a stuck
 * in-flight row unreachable: replay is milliseconds, a drafter turn is seconds
 * to minutes, so the grace only ever expires on a drafter that really has gone.
 */
export const HANDOFF_DRAFTER_APPEARANCE_GRACE_MS = 5_000;

/**
 * The receipt's live state, derived rather than stored — settlement truth stays
 * in the thread shells, so there is no second copy of it to go stale.
 *
 * A failed *dispatch* (intake rejected the handoff) is terminal on the receipt
 * itself. Everything else is read off the drafter: any attention flag means the
 * server's settlement reactor raised `needs_guidance` (zero handoffs placed, a
 * failed turn start, or a hung turn), and disappearance means the reactor
 * archived it after recording at least one handoff.
 */
export function deriveHandoffReceiptState(input: {
  readonly receipt: HandoffReceipt;
  readonly drafterShell: HandoffDrafterShell | null;
  readonly nowMs: number;
}): HandoffReceiptState {
  if (input.receipt.failure !== null) {
    return "failed";
  }
  if (input.receipt.drafterThreadId === null) {
    return "dispatching";
  }
  if (input.drafterShell !== null) {
    if (input.drafterShell.attention.length > 0) {
      return "failed";
    }
    return input.drafterShell.archivedAt === null ? "drafting" : "settled";
  }
  const elapsedMs = input.nowMs - Date.parse(input.receipt.createdAt);
  return Number.isFinite(elapsedMs) && elapsedMs < HANDOFF_DRAFTER_APPEARANCE_GRACE_MS
    ? "drafting"
    : "settled";
}

const DRAFTER_FAILURE_REASON =
  "The drafter stopped without placing a handoff, so no goal was created.";

export function deriveHandoffReceiptViews(input: {
  readonly receipts: ReadonlyArray<HandoffReceipt>;
  readonly drafterShellsById: ReadonlyMap<string, HandoffDrafterShell>;
  readonly nowMs: number;
}): HandoffReceiptView[] {
  return input.receipts.map((receipt) => {
    const drafterShell =
      receipt.drafterThreadId === null
        ? null
        : (input.drafterShellsById.get(receipt.drafterThreadId) ?? null);
    const state = deriveHandoffReceiptState({ receipt, drafterShell, nowMs: input.nowMs });
    return {
      id: receipt.id,
      sourceThreadKey: receipt.sourceThreadKey,
      state,
      explanation: receipt.explanation,
      createdAt: receipt.createdAt,
      drafterThreadId: receipt.drafterThreadId,
      failureReason: state === "failed" ? (receipt.failure ?? DRAFTER_FAILURE_REASON) : null,
    };
  });
}

/** True while the receipt is still moving — the only condition worth a repeating clock. */
export function handoffReceiptIsPending(state: HandoffReceiptState): boolean {
  return state === "dispatching" || state === "drafting";
}

export interface HandoffReceiptToastPush {
  readonly receiptId: string;
  readonly kind: "failure" | "success";
  /** `scopedThreadKey` of the source — also how the toast resolves the drafter's environment. */
  readonly sourceThreadKey: string;
  readonly explanation: string;
  readonly drafterThreadId: ThreadId | null;
  readonly failureReason: string | null;
}

/**
 * What the app-root coordinator must push, given the previous states it saw.
 *
 * The receipt row is the primary surface, so a toast is strictly the away-from-
 * source backstop:
 *
 * - **failure always.** A broken handoff must reach the human wherever they are;
 *   the durable backstop (a surfaced drafter row flagged "Needs Attention") can
 *   easily be off-screen.
 * - **success only when the receipt is not on screen.** If the human is still
 *   looking at the source thread, the row already settled in front of them and a
 *   toast would be pure double-notification.
 *
 * Each is announced once, on the observation that first sees the receipt in that
 * state. No reload guard is needed: the receipt store is browser-local and empty
 * at mount, so every receipt this ever sees was submitted in this session.
 *
 * Failure is announced even on a FIRST observation, because a dispatch that
 * rejects immediately can settle within the same commit as the submission — the
 * in-flight state need never be observed at all, and a failed handoff must never
 * be swallowed. Success is stricter: it requires a genuine transition, since the
 * row is its primary surface and an unobserved success is not a lost signal.
 */
export function deriveHandoffReceiptToastPushes(input: {
  readonly previousStates: ReadonlyMap<string, HandoffReceiptState>;
  readonly views: ReadonlyArray<HandoffReceiptView>;
  /** `scopedThreadKey` of the thread currently on screen, or null when none is. */
  readonly activeThreadKey: string | null;
}): HandoffReceiptToastPush[] {
  const pushes: HandoffReceiptToastPush[] = [];
  for (const view of input.views) {
    const previous = input.previousStates.get(view.id);
    if (previous === view.state) {
      continue;
    }
    if (view.state === "failed") {
      pushes.push({
        receiptId: view.id,
        kind: "failure",
        sourceThreadKey: view.sourceThreadKey,
        explanation: view.explanation,
        drafterThreadId: view.drafterThreadId,
        failureReason: view.failureReason,
      });
      continue;
    }
    if (
      view.state === "settled" &&
      previous !== undefined &&
      input.activeThreadKey !== view.sourceThreadKey
    ) {
      pushes.push({
        receiptId: view.id,
        kind: "success",
        sourceThreadKey: view.sourceThreadKey,
        explanation: view.explanation,
        drafterThreadId: view.drafterThreadId,
        failureReason: null,
      });
    }
  }
  return pushes;
}
