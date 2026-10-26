// loom: Loom's sidebar helpers, kept apart from upstream's Sidebar.logic.ts.
import {
  ownAttentionOf,
  type WorkstreamAttentionReason,
} from "@t3tools/client-runtime/state/loom/rollup";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { attentionLabel } from "../loom/loomAttention";

/**
 * The Loom attention a row shows instead of its upstream state, or null. A pending approval
 * or question (the row's or a subagent's; pull 12 §7.1 row 1) outranks every Loom reason but
 * `error`. A row is never a workstream child, so never brief-needed.
 */
export function loomAttentionOf(
  thread: Pick<
    EnvironmentThreadShell,
    "source" | "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest"
  >,
): WorkstreamAttentionReason | null {
  const top = ownAttentionOf(thread.source)[0];
  const upstreamShows =
    thread.hasPendingApprovals || thread.hasPendingUserInput || thread.pendingSubagentRequest;
  return top === undefined || (upstreamShows && top !== "error") ? null : top;
}

/** The row's top-status override for a Loom attention reason (theme tokens only). */
export function loomTopStatus(reason: WorkstreamAttentionReason) {
  return {
    label: attentionLabel(reason),
    icon: null,
    className: reason === "error" ? "text-error" : "text-warning-foreground",
  };
}
