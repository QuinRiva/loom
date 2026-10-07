// loom: 3d-3 — Loom's sidebar helpers, split out of the upstream-owned
// Sidebar.logic.ts so upstream edits there never collide with the fork's
// additions. Pure; consumed by Sidebar.tsx's marked hunks.
import {
  attentionReasonsOf,
  type WorkstreamAttentionReason,
} from "@t3tools/client-runtime/state/loom/rollup";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

import { attentionLabel } from "../loom/loomAttention";

/** The reasons upstream's own status already shows (its Approval / Input pills). */
const UPSTREAM_SHOWN: ReadonlySet<WorkstreamAttentionReason> = new Set([
  "awaiting_approval",
  "awaiting_input",
]);

/**
 * The Loom attention a row shows instead of its upstream state, or null.
 * Attention outranks state: the highest reason by `attentionReasonsOf`'s
 * priority (error > approval > input > acceptance > guidance > orchestrator >
 * brief-needed) wins; when that is a request upstream already renders
 * (approval / input) upstream's own pill stays.
 */
export function loomAttentionOf(
  thread: Pick<OrchestrationV2ThreadShell, "workstream" | "pendingRuntimeRequest">,
): WorkstreamAttentionReason | null {
  const top = attentionReasonsOf(thread)[0];
  return top === undefined || UPSTREAM_SHOWN.has(top) ? null : top;
}

/** The row's top-status override for a Loom attention reason (theme tokens only). */
export function loomTopStatus(reason: WorkstreamAttentionReason) {
  return {
    label: attentionLabel(reason),
    icon: null,
    className: reason === "error" ? "text-error" : "text-warning-foreground",
  };
}
