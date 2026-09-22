import { parseScopedThreadKey, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, HandoffDestination, ThreadId } from "@t3tools/contracts";

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

/**
 * A shell as the resolution below reads it.
 *
 * `environmentId` is not decoration: `useThreadShells()` spans every connected
 * environment, and thread ids are only unique WITHIN one — two environments
 * backed by copies of the same database legitimately share them. Every lookup
 * here is therefore by scoped ref, never by bare id, or a handoff in one
 * environment could resolve against a same-id thread in another.
 */
export interface HandoffThreadShell extends HandoffDrafterShell {
  readonly environmentId: EnvironmentId;
  readonly title: string;
  readonly handoffDestinations: ReadonlyArray<HandoffDestination>;
}

export type HandoffReceiptState = "dispatching" | "drafting" | "settled" | "failed";

/**
 * A goal this handoff staged, as the receipt can offer it: somewhere to go.
 *
 * It is read off the SOURCE thread's shell (`handoffDestinations`, filtered to
 * this receipt's drafter), not the drafter's — a settled drafter is archived and
 * gone from the snapshot, so its own copy is unreachable exactly when the row
 * wants to link. `title` is the staged thread's, which is in the snapshot
 * because a staged root is `planned` rather than archived; null when it is not
 * (yet) there, and then the affordance falls back to a generic label rather than
 * disappearing.
 */
export interface HandoffReceiptDestination {
  readonly threadId: ThreadId;
  readonly title: string | null;
}

export interface HandoffReceiptView {
  readonly id: string;
  readonly sourceThreadKey: string;
  readonly state: HandoffReceiptState;
  /** The human's explanation, verbatim and never truncated. */
  readonly explanation: string;
  readonly createdAt: string;
  /** Present once intake acknowledged; where a FAILED handoff sends the human. */
  readonly drafterThreadId: ThreadId | null;
  /** The goals this handoff staged — one per `goal_handoff` the drafter placed. */
  readonly destinations: ReadonlyArray<HandoffReceiptDestination>;
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
 *
 * It is measured from `intake.acknowledgedAt`, NOT from when the human pressed
 * Enter. The window exists to cover the gap between the drafter being created
 * and its shell replaying, and that gap only opens once intake returns. Anchoring
 * it to submission would let a slow intake consume the entire window before the
 * drafter could possibly appear, so the very first render after acknowledgement
 * would report a live drafter as settled.
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
  const intake = input.receipt.intake;
  if (intake === null) {
    return "dispatching";
  }
  if (input.drafterShell !== null) {
    if (input.drafterShell.attention.length > 0) {
      return "failed";
    }
    return input.drafterShell.archivedAt === null ? "drafting" : "settled";
  }
  // Absent shell: only call it settled once the post-acknowledgement grace has
  // actually elapsed. An unparseable timestamp would make `elapsedMs` NaN, and
  // every comparison on NaN is false — so treat that as still-drafting rather
  // than letting it fall through to a false success.
  const elapsedMs = input.nowMs - Date.parse(intake.acknowledgedAt);
  return !Number.isFinite(elapsedMs) || elapsedMs < HANDOFF_DRAFTER_APPEARANCE_GRACE_MS
    ? "drafting"
    : "settled";
}

const DRAFTER_FAILURE_REASON =
  "The drafter stopped without placing a handoff, so no goal was created.";

const NO_DESTINATIONS: ReadonlyArray<HandoffReceiptDestination> = Object.freeze([]);

/**
 * Resolve, per receipt, the two things the views need out of live shell state:
 * the drafter whose fate IS the receipt's state, and the goals the handoff
 * staged.
 *
 * The destinations come from the receipt's SOURCE thread, not its drafter:
 * `goal_handoff` stamps each marker on both, and only the source is still in
 * the snapshot once the drafter settles and is archived. Markers are filtered
 * to this receipt's drafter, so a source that has had several handoffs gives
 * each receipt exactly its own.
 *
 * Everything is keyed by scoped ref. A receipt whose `sourceThreadKey` does not
 * parse resolves to nothing at all rather than falling back to a bare-id match
 * that could cross environments — the key is always written by
 * `scopedThreadKey`, so that is unreachable rather than merely unlikely.
 */
export function resolveHandoffReceiptShells(input: {
  readonly receipts: ReadonlyArray<HandoffReceipt>;
  readonly shells: ReadonlyArray<HandoffThreadShell>;
}): {
  readonly drafterShellsByReceiptId: ReadonlyMap<string, HandoffDrafterShell>;
  readonly destinationsByReceiptId: ReadonlyMap<string, ReadonlyArray<HandoffReceiptDestination>>;
} {
  const drafterShellsByReceiptId = new Map<string, HandoffDrafterShell>();
  const destinationsByReceiptId = new Map<string, ReadonlyArray<HandoffReceiptDestination>>();

  const acknowledged = input.receipts.flatMap((receipt) => {
    const source = parseScopedThreadKey(receipt.sourceThreadKey);
    return receipt.intake === null || source === null
      ? []
      : [
          {
            receiptId: receipt.id,
            environmentId: source.environmentId,
            sourceKey: receipt.sourceThreadKey,
            drafterKey: scopedThreadKey({
              environmentId: source.environmentId,
              threadId: receipt.intake.drafterThreadId,
            }),
            drafterThreadId: receipt.intake.drafterThreadId,
          },
        ];
  });
  if (acknowledged.length === 0) {
    return { drafterShellsByReceiptId, destinationsByReceiptId };
  }

  const wanted = new Set(acknowledged.flatMap((entry) => [entry.sourceKey, entry.drafterKey]));
  const shellsByKey = new Map<string, HandoffThreadShell>();
  for (const shell of input.shells) {
    const key = scopedThreadKey({ environmentId: shell.environmentId, threadId: shell.id });
    if (wanted.has(key)) shellsByKey.set(key, shell);
  }

  for (const entry of acknowledged) {
    const drafterShell = shellsByKey.get(entry.drafterKey);
    if (drafterShell !== undefined) drafterShellsByReceiptId.set(entry.receiptId, drafterShell);

    const destinations = (shellsByKey.get(entry.sourceKey)?.handoffDestinations ?? [])
      .filter((marker) => marker.drafterThreadId === entry.drafterThreadId)
      // A receipt has a handful of destinations at most, so scanning for each
      // title beats indexing every shell in the app on every frame.
      .map((marker) => ({
        threadId: marker.threadId,
        title:
          input.shells.find(
            (shell) => shell.id === marker.threadId && shell.environmentId === entry.environmentId,
          )?.title ?? null,
      }));
    if (destinations.length > 0) destinationsByReceiptId.set(entry.receiptId, destinations);
  }
  return { drafterShellsByReceiptId, destinationsByReceiptId };
}

export function deriveHandoffReceiptViews(input: {
  readonly receipts: ReadonlyArray<HandoffReceipt>;
  /** Keyed by RECEIPT id, not thread id: thread ids are only unique per environment. */
  readonly drafterShellsByReceiptId: ReadonlyMap<string, HandoffDrafterShell>;
  readonly destinationsByReceiptId: ReadonlyMap<string, ReadonlyArray<HandoffReceiptDestination>>;
  readonly nowMs: number;
}): HandoffReceiptView[] {
  return input.receipts.map((receipt) => {
    const drafterThreadId = receipt.intake?.drafterThreadId ?? null;
    const drafterShell = input.drafterShellsByReceiptId.get(receipt.id) ?? null;
    const state = deriveHandoffReceiptState({ receipt, drafterShell, nowMs: input.nowMs });
    return {
      id: receipt.id,
      sourceThreadKey: receipt.sourceThreadKey,
      state,
      explanation: receipt.explanation,
      createdAt: receipt.createdAt,
      drafterThreadId,
      destinations: input.destinationsByReceiptId.get(receipt.id) ?? NO_DESTINATIONS,
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
  readonly destinations: ReadonlyArray<HandoffReceiptDestination>;
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
        destinations: view.destinations,
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
        destinations: view.destinations,
        failureReason: null,
      });
    }
  }
  return pushes;
}
