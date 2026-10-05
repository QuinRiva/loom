// `/handoff` fork-drafter visibility (plan `2026-07-19-handoff-fork-drafter.md`
// D6). A `handoff-drafter` root is a throwaway native fork of a source thread:
// it drafts a `goal_handoff` brief in a single turn and is then auto-archived
// by the server. The one shared predicate below is the SINGLE authority for
// whether a still-alive drafter is shown, so the sidebar, command palette and
// thread-mention candidates can never disagree about it.
export const HANDOFF_DRAFTER_ROLE = "handoff-drafter";

export interface HandoffDrafterVisibility {
  readonly role: string | null;
  readonly attention: ReadonlyArray<string>;
}

/**
 * Whether a non-archived thread should be surfaced in the UI.
 *
 * A healthy drafter archives within one turn (already filtered out by
 * `archivedAt`), so while alive it stays invisible EXCEPT when it is broken —
 * i.e. when the server has raised an attention flag that only a human can
 * clear (`needs_guidance` from the settlement reactor's zero-handoff /
 * turn-start-failed / hung legs, plan D5/D6). Suppressing a flagged drafter
 * would strand a failure with no surface at all, so ANY attention keeps it
 * visible — strictly safer than matching a single reason. Every non-drafter
 * thread is always visible.
 *
 * `now` is accepted for call-site symmetry but intentionally unused: plan D6
 * pins failure surfacing to server-side timer-driven reconciliation (which
 * raises attention), never a render-time age comparison in the client.
 */
export function isVisibleHandoffDrafter(thread: HandoffDrafterVisibility, _now?: number): boolean {
  if (thread.role !== HANDOFF_DRAFTER_ROLE) return true;
  return thread.attention.length > 0;
}
