import type { ThreadId } from "@t3tools/contracts";

/**
 * The per-thread spend slot on the workstream board card, quick facts and
 * active strip. Empty until track 3d-4 lands the `loom.threadSpend` batched
 * lookup (seam 11): cost is not a shell field, so nothing here reads one. 3d-4
 * replaces this body; the call sites stay.
 */
export function WorkstreamSpendSlot(_props: { readonly threadId: ThreadId }) {
  return null;
}
