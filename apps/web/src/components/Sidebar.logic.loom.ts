// loom: Loom's sidebar helpers, kept apart from upstream's Sidebar.logic.ts.
import {
  attentionLabel,
  type WorkstreamAttentionReason,
} from "@t3tools/client-runtime/state/loom/rollup";

/** The row's top-status override for a Loom attention reason (theme tokens only). */
export function loomTopStatus(reason: WorkstreamAttentionReason) {
  return {
    label: attentionLabel(reason),
    icon: null,
    className: reason === "error" ? "text-error" : "text-warning-foreground",
  };
}
