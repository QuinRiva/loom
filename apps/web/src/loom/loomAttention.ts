/**
 * loom: the human labels for Loom's attention reasons (3d-3), shared by the
 * sidebar's attention override, its rollup badge and the goal panel's thread
 * chips. Priority lives in `ownAttentionOf` (client-runtime), not here.
 */
import type { WorkstreamAttentionReason } from "@t3tools/client-runtime/state/loom/rollup";

const LABELS: Record<WorkstreamAttentionReason, string> = {
  error: "Error",
  awaiting_approval: "Approval",
  awaiting_input: "Input",
  awaiting_acceptance: "Accept?",
  needs_guidance: "Needs you",
  awaiting_orchestrator: "Yielded",
  "brief-needed": "Brief needed",
};

export const attentionLabel = (reason: WorkstreamAttentionReason): string => LABELS[reason];
