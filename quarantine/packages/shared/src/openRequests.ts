/**
 * Terminal-wins fold over the durable activity log for blocked-on-a-human
 * requests (approvals and agent questions).
 *
 * The rule is deliberately order-independent: a requestId is open iff it was
 * requested and **never** resolved. Once a resolution exists for an id, no
 * `requested` row can reopen it — not a duplicate, not one with a later
 * timestamp, not one that arrives after the resolution during replay. The
 * previous ordered add/delete set could resurrect a settled request, which is
 * the open-forever failure this whole seam exists to make impossible.
 *
 * Resolution is the ONLY clearing signal. `provider.*.respond.failed` details
 * are delivery diagnostics and clear nothing: the server now guarantees a
 * resolution always eventually lands, so prose matching is neither needed nor
 * trustworthy (four hand-maintained allowlists had already diverged, and none
 * of them matched the details the real incident produced).
 *
 * @module openRequests
 */

/** The minimum an activity row must expose to participate in the fold. */
export interface OpenRequestActivity {
  readonly kind: string;
  readonly payload: unknown;
}

const requestIdOf = (payload: unknown): string | null => {
  if (typeof payload !== "object" || payload === null) return null;
  const requestId = (payload as { readonly requestId?: unknown }).requestId;
  return typeof requestId === "string" && requestId.length > 0 ? requestId : null;
};

/**
 * The set of requestIds still open across the given activities, for the given
 * request-kind pairs (e.g. `user-input`, or `user-input` + `approval`).
 */
export const openRequestIds = (
  activities: Iterable<OpenRequestActivity>,
  kinds: ReadonlyArray<string>,
): ReadonlySet<string> => {
  const requested = new Set<string>();
  const resolved = new Set<string>();
  for (const activity of activities) {
    const requestId = requestIdOf(activity.payload);
    if (requestId === null) continue;
    for (const kind of kinds) {
      if (activity.kind === `${kind}.requested`) requested.add(requestId);
      else if (activity.kind === `${kind}.resolved`) resolved.add(requestId);
    }
  }
  for (const requestId of resolved) requested.delete(requestId);
  return requested;
};

/** Open agent-question requests only — the shell's `pendingUserInputCount`. */
export const openUserInputRequestIds = (
  activities: Iterable<OpenRequestActivity>,
): ReadonlySet<string> => openRequestIds(activities, ["user-input"]);
