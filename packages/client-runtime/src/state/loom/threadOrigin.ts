import type {
  LoomThreadShellFields,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * Whose words opened a root the human did not write, for the sidebar's rail:
 * - `agent`: an orchestrator's own `goal_handoff`, or a root an agent-made
 *   scheduled task launched (`createdBy: "agent"`, no handoff origin);
 * - `requested`: the human's `/handoff` (its hidden drafter wrote the brief);
 * - `continued`: a `goal_continue` successor, held or launched with the
 *   predecessor's brief unedited (`kickoffOrigin: "kickoff"`) — the human
 *   pressed Send, but the brief is the agent's;
 * - `null`: the human's own threads, a continuation whose brief they edited
 *   before launching (or launched before that was recorded), forks, imports,
 *   and workstream children (never listed).
 * A pure function of the shell, so web and mobile share it.
 */
export type ThreadStart = "agent" | "requested" | "continued";

type StartWorkstream = Pick<
  LoomThreadShellFields,
  "handoffOrigin" | "continuesThreadId" | "kickoffAt" | "kickoffOrigin"
>;

/**
 * The thread a handed-off or continued root came from (the handoff's origin,
 * the predecessor) with its start kind; null for any other thread.
 */
export const threadStartOriginOf = (
  workstream: StartWorkstream | undefined,
): { readonly start: ThreadStart; readonly threadId: ThreadId } | null => {
  if (workstream?.handoffOrigin) {
    const { initiatedBy, threadId } = workstream.handoffOrigin;
    return { start: initiatedBy === "human" ? "requested" : "agent", threadId };
  }
  return workstream?.continuesThreadId &&
    (workstream.kickoffAt === null || workstream.kickoffOrigin === "kickoff")
    ? { start: "continued", threadId: workstream.continuesThreadId }
    : null;
};

export const threadStartOf = (
  shell: Pick<OrchestrationV2ThreadShell, "createdBy" | "lineage" | "workstream">,
): ThreadStart | null =>
  threadStartOriginOf(shell.workstream)?.start ??
  (shell.createdBy === "agent" &&
  shell.lineage.relationshipToParent === null &&
  !shell.workstream?.continuesThreadId
    ? "agent"
    : null);
