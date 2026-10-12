import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

/**
 * Who started a root without the human pressing Send, for the sidebar's rail:
 * - `agent`: an orchestrator's own `goal_handoff`, or a root an agent-made
 *   scheduled task launched (`createdBy: "agent"`, no handoff origin);
 * - `requested`: the human's `/handoff` (its hidden drafter wrote the brief);
 * - `null`: the human's own threads, `goal_continue` held siblings, forks,
 *   imports, and workstream children (never listed).
 * A pure function of the shell, so web and mobile share it.
 */
export type ThreadStart = "agent" | "requested";

export const threadStartOf = (
  shell: Pick<OrchestrationV2ThreadShell, "createdBy" | "lineage" | "workstream">,
): ThreadStart | null => {
  const origin = shell.workstream?.handoffOrigin;
  if (origin) return origin.initiatedBy === "human" ? "requested" : "agent";
  return shell.createdBy === "agent" &&
    shell.lineage.relationshipToParent === null &&
    !shell.workstream?.continuesThreadId
    ? "agent"
    : null;
};
